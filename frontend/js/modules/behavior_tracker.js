// frontend/js/modules/behavior_tracker.js
/**
 * BehaviorTracker 前端行为追踪模块
 *
 * 目标：
 * - 捕获 TDD-II-07 中规定的关键事件：
 *   code_edit（Monaco 编辑器防抖 2s）、ai_help_request（立即）、test_submission（立即，包含 code）、dom_element_select（立即，iframe 支持）、user_idle（60s）、page_focus_change（visibility）
 * - 组装标准化 payload 并可靠发送到后端 /api/v1/behavior/log
 * - 【已改】统一使用 fetch(..., { keepalive: true, credentials: 'omit' })，彻底不带 Cookie
 *
 * 注意：
 * - 本文件不修改现有 HTML。脚本提供自动初始化尝试（initAuto），但更可靠的方式是：在页面创建 Monaco 编辑器后显式调用 tracker.initEditors(...) 与 tracker.initTestActions(...)
 * - TODO中表示需要我们根据实际项目调整或确认的点（Monaco 编辑器实例的暴露方式等）
 */

import debounce from 'https://cdn.jsdelivr.net/npm/lodash-es@4.17.21/debounce.js';
import { getParticipantId } from './session.js';

class BehaviorTracker {
  constructor() {
    // 闲置阈值（ms）
    this.idleThreshold = 60000; // 60s
    // code_edit 防抖时长（ms）
    this.debounceMs = 2000;
    this.idleTimer = null;
    // 代码改动监控相关属性
    this.codeChangeHistory = [];
    this.lastChangeTime = Date.now();
    this.codeStats = {
      totalChanges: 0,
      htmlChanges: 0,
      cssChanges: 0,
      jsChanges: 0,
      startTime: Date.now()
    };


    // ✅ 添加标志位，防止多次绑定焦点与闲置监听器
    this._focusAndIdleBound = false;
    this._enabledEvents = {};
    this._elementClickBound = false;
  }

  init(config = {}) {
    this._enabledEvents = config;
    if (config.user_idle) this.initIdleAndFocus(config.idleThreshold);
    if (config.page_focus_change && !config.user_idle) {
      if (!this._focusAndIdleBound) {
        this._focusAndIdleBound = true;
        document.addEventListener('visibilitychange', () => {
          const status = document.hidden ? 'blur' : 'focus';
          this.logEvent('page_focus_change', {
            status,
            timestamp: new Date().toISOString(),
            page_url: window.location.pathname
          });
        });
      }
    }
    if (config.code_edit && window.editors) this.initEditors(window.editors);
    if (config.ai_help_request) this.initChat('send-message', '#user-message');
    if (config.test_submission && window.editors) this.initTestActions('run-button', 'submit-button', window.editors, () => window.currentTopicId || null);
    if (config.dom_element_select) this.initDOMSelector('startSelector', 'stopSelector', 'element-selector-iframe');
    // if (config.element_clicks) {
    //   this.initElementClickTracking(config.element_click_options || {});
    // }
  }

  // -------------------- 核心发送函数 --------------------
  // 【已改】统一使用 fetch keepalive，并显式禁用 Cookie（credentials:'omit'）
  _sendPayload(payload) {
    const url = 'http://localhost:8000/api/v1/behavior/log';
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
        credentials: 'omit', // 👈 不带 Cookie / 凭证
      }).catch(err => {
        console.warn('[BehaviorTracker] fetch 发送失败：', err);
      });
    } catch (e) {
      console.warn('[BehaviorTracker] 发送日志时异常：', e);
    }
  }

  // 公共上报接口：组装标准 payload 并发送
  logEvent(eventType, eventData = {}) {
    // 获取 participant_id（从 session.js 或 window 取）
    let participant_id = null;
    try {
      if (typeof getParticipantId === 'function') {
        participant_id = getParticipantId();
      }
    } catch (e) {
      // ignore
    }
    // 兜底：如果页面在全局暴露 participantId，也可取之
    if (!participant_id && window && window.participantId) {
      participant_id = window.participantId;
    }
    if (!participant_id) {
      // 如果没有 participant_id，则按 TDD-II-07 的说明不追踪；可选择缓冲但当前选择跳过
      console.warn('[BehaviorTracker] 无 participant_id，跳过事件：', eventType);
      return;
    }

    const payload = {
      participant_id,
      event_type: eventType,
      event_data: eventData,
      timestamp: new Date().toISOString()
    };

    this._sendPayload(payload);
  }

  // -------------------- 代码改动监控功能 --------------------
  /**
   * 初始化代码改动监控
   * @param {Object} editors - 编辑器实例对象 { html: editor, css: editor, js: editor }
   */
  initCodeChangeTracking(editors) {
    if (!editors) {
      console.warn('[BehaviorTracker] 无编辑器实例，无法初始化代码改动监控');
      return;
    }

    try {
      // 为每个编辑器设置内容变化监听
      if (editors.html && typeof editors.html.onDidChangeModelContent === 'function') {
        editors.html.onDidChangeModelContent(() => {
          this._recordCodeChange('html', editors.html.getValue());
        });
      }
      if (editors.css && typeof editors.css.onDidChangeModelContent === 'function') {
        editors.css.onDidChangeModelContent(() => {
          this._recordCodeChange('css', editors.css.getValue());
        });
      }
      if (editors.js && typeof editors.js.onDidChangeModelContent === 'function') {
        editors.js.onDidChangeModelContent(() => {
          this._recordCodeChange('js', editors.js.getValue());
        });
      }

      console.log('[BehaviorTracker] 代码改动监控已初始化');

      // 启动定期报告
      this._startPeriodicReporting();

    } catch (e) {
      console.warn('[BehaviorTracker] 初始化代码改动监控时出错：', e);
    }
  }

  /**
   * 记录代码改动
   * @param {string} editorType - 编辑器类型 ('html', 'css', 'js')
   * @param {string} content - 编辑器内容
   */
  _recordCodeChange(editorType, content) {
    const now = Date.now();
    const timeSinceLastChange = now - this.lastChangeTime;
    this.lastChangeTime = now;

    // 计算代码指标
    const lines = content.split('\n').length;
    const length = content.length;

    // 创建改动记录
    const changeRecord = {
      timestamp: now,
      editor: editorType,
      codeLength: length,
      lineCount: lines,
      timeSinceLastChange: timeSinceLastChange
    };

    // 添加到历史
    this.codeChangeHistory.push(changeRecord);

    // 更新统计
    this.codeStats.totalChanges++;
    this.codeStats[`${editorType}Changes`]++;

    // 输出到控制台
    this._logCodeChangeToConsole(changeRecord);

    // 同时发送标准 code_edit 事件（防抖的）
    this._debouncedCodeEdit(editorType, content);
  }

  // 防抖的 code_edit 事件上报
  _debouncedCodeEdit = debounce((editorType, content) => {
    this.logEvent('code_edit', {
      editorName: editorType,
      newLength: content ? content.length : 0,
      lineCount: content.split('\n').length
    });
  }, this.debounceMs);

  // 输出代码改动的控制台日志
  _logCodeChangeToConsole(changeRecord) {
    const time = new Date(changeRecord.timestamp).toLocaleTimeString();
    console.log(
      `%c代码改动监控%c [${time}] %c${changeRecord.editor.toUpperCase()}%c: ${changeRecord.codeLength}字符, ${changeRecord.lineCount}行, 间隔: ${changeRecord.timeSinceLastChange}ms`,
      'background: #4dabf7; color: white; padding: 2px 4px; border-radius: 3px;',
      'color: #666;',
      'color: #339af0; font-weight: bold;',
      'color: default;'
    );
  }

  // 启动定期报告
  _startPeriodicReporting() {
    // 每30秒报告一次
    setInterval(() => this._reportCodeChangeSummary(), 30000);
  }

  // 报告代码改动摘要
  _reportCodeChangeSummary() {
    if (this.codeChangeHistory.length === 0) return;

    const sessionDuration = Math.round((Date.now() - this.codeStats.startTime) / 1000);
    const changesPerMinute = Math.round((this.codeStats.totalChanges / sessionDuration) * 60);

    console.groupCollapsed(`%c代码改动摘要 - ${new Date().toLocaleTimeString()}`, 'font-weight: bold; color: #1864ab;');
    console.log(`会话时长: ${sessionDuration}秒`);
    console.log(`总改动次数: ${this.codeStats.totalChanges}`);
    console.log(`每分钟改动: ${changesPerMinute}次`);
    console.log(`HTML改动: ${this.codeStats.htmlChanges}`);
    console.log(`CSS改动: ${this.codeStats.cssChanges}`);
    console.log(`JS改动: ${this.codeStats.jsChanges}`);

    // 计算平均编辑间隔
    if (this.codeChangeHistory.length > 1) {
      const intervals = this.codeChangeHistory
        .filter((_, i) => i > 0)
        .map(record => record.timeSinceLastChange);

      const avgInterval = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
      console.log(`平均编辑间隔: ${avgInterval}ms`);
    }

    console.groupEnd();
  }

  /**
   * 获取代码改动分析数据
   * @returns {Object} 代码改动统计数据
   */
  getCodeChangeAnalysis() {
    const sessionDuration = Math.round((Date.now() - this.codeStats.startTime) / 1000);
    const changesPerMinute = this.codeStats.totalChanges > 0 ?
      Math.round((this.codeStats.totalChanges / sessionDuration) * 60) : 0;

    // 计算平均编辑间隔
    let avgInterval = 0;
    if (this.codeChangeHistory.length > 1) {
      const intervals = this.codeChangeHistory
        .filter((_, i) => i > 0)
        .map(record => record.timeSinceLastChange);

      avgInterval = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
    }

    return {
      sessionDuration,
      totalChanges: this.codeStats.totalChanges,
      changesPerMinute,
      htmlChanges: this.codeStats.htmlChanges,
      cssChanges: this.codeStats.cssChanges,
      jsChanges: this.codeStats.jsChanges,
      avgInterval,
      changeHistory: this.codeChangeHistory
    };
  }

  /**
   * 清空代码改动历史（可用于重置或开始新的会话）
   */
  clearCodeChangeHistory() {
    this.codeChangeHistory = [];
    this.codeStats = {
      totalChanges: 0,
      htmlChanges: 0,
      cssChanges: 0,
      jsChanges: 0,
      startTime: Date.now()
    };
    console.log('[BehaviorTracker] 代码改动历史已清空');
  }


  //后端处理
  // // -------------------- AI 求助（聊天） --------------------
  // // sendButtonId: 提问按钮 id；inputSelector: 文本输入选择器
  // // mode: 模式 ('learning' 或 'test')；contentId: 内容ID
  // initChat(sendButtonId, inputSelector, mode = 'learning', contentId = null) {
  //   const btn = document.getElementById(sendButtonId);
  //   const input = document.querySelector(inputSelector);
  //   if (!btn || !input) return;

  //   const sendMessage = () => {
  //     const message = input.value || '';
  //     if (!message.trim()) return;
  //     this.logEvent('ai_help_request', {
  //       message: message.substring(0, 2000),
  //       mode: mode,
  //       content_id: contentId
  //     });
  //   };

  //   btn.addEventListener('click', sendMessage);

  //   // 支持 Enter 提交
  //   input.addEventListener('keydown', (e) => {
  //     if (e.key === 'Enter' && !e.shiftKey) {
  //       e.preventDefault();
  //       sendMessage();
  //     }
  //   });
  // }

  // // -------------------- 测试/提交（包含 code） --------------------
  // // runBtnId / submitBtnId: 按钮 id；editors: 同 initEditors；topicIdGetter: 可选函数返回 topic_id
  // initTestActions(runBtnId, submitBtnId, editors, topicIdGetter) {
  //   const gatherCode = () => {
  //     const code = {};
  //     if (editors?.html && typeof editors.html.getValue === 'function') code.html = editors.html.getValue();
  //     if (editors?.css && typeof editors.css.getValue === 'function') code.css = editors.css.getValue();
  //     if (editors?.js && typeof editors.js.getValue === 'function') code.js = editors.js.getValue();
  //     return code;
  //   };

  //   const runBtn = document.getElementById(runBtnId);
  //   const subBtn = document.getElementById(submitBtnId);

  //   if (runBtn) {
  //     runBtn.addEventListener('click', () => {
  //       this.logEvent('test_submission', {
  //         action: 'run',
  //         topic_id: (typeof topicIdGetter === 'function' ? topicIdGetter() : window.currentTopicId) || null,
  //         code: gatherCode()
  //       });
  //     });
  //   }

  //   if (subBtn) {
  //     subBtn.addEventListener('click', () => {
  //       this.logEvent('test_submission', {
  //         action: 'submit',
  //         topic_id: (typeof topicIdGetter === 'function' ? topicIdGetter() : window.currentTopicId) || null,
  //         code: gatherCode()
  //       });
  //     });
  //   }
  // }

  /**
   * BehaviorTracker 前端行为追踪模块
   *
   * 扩展支持：
   * - user_idle: 增加 timestamp_start, timestamp_end, was_focused, page_url, trigger_source 字段
   * - page_focus_change: 增加 timestamp, page_url 字段
   */
  initIdleAndFocus(idleMs = this.idleThreshold) {
    // ✅ 避免重复绑定监听器
    if (this._focusAndIdleBound) return;
    this._focusAndIdleBound = true;

    const resetIdle = () => {
      clearTimeout(this.idleTimer);
      const startTime = Date.now();
      this.idleTimer = setTimeout(() => {
        const endTime = Date.now();
        this.logEvent('user_idle', {
          duration_ms: idleMs,
          timestamp_start: new Date(startTime).toISOString(),
          timestamp_end: new Date(endTime).toISOString(),
          was_focused: !document.hidden,
          page_url: window.location.pathname,
          trigger_source: 'timeout'
        });
      }, idleMs);
    };

    ['mousemove', 'keydown', 'scroll', 'click'].forEach(evt => {
      document.addEventListener(evt, resetIdle, { passive: true });
    });

    document.addEventListener('visibilitychange', () => {
      const status = document.hidden ? 'blur' : 'focus';
      this.logEvent('page_focus_change', {
        status,
        timestamp: new Date().toISOString(),
        page_url: window.location.pathname
      });
      if (status === 'focus') resetIdle();
    });

    resetIdle();
  }

  // -------------------- 辅助：生成 CSS Selector --------------------
  _generateCssSelector(el) {
    if (!el) return '';
    const parts = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let part = el.nodeName.toLowerCase();
      if (el.id) {
        part += `#${el.id}`;
        parts.unshift(part);
        break;
      } else {
        let i = 1;
        let sib = el;
        while ((sib = sib.previousElementSibling) != null) {
          if (sib.nodeName.toLowerCase() === part) i++;
        }
        if (i > 1) part += `:nth-of-type(${i})`;
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  initAuto() {
    document.addEventListener('DOMContentLoaded', () => {
      const monacoContainer = document.getElementById('monaco-editor');
      if (monacoContainer && window.monaco && window.editors) {
        try {
          const editors = window.editors || {};
          this.initEditors(editors);
        } catch (e) {
          console.warn('[BehaviorTracker] 编辑器自动初始化失败', e);
        }
        return;
      }
    });
  }
}

const tracker = new BehaviorTracker();
export default tracker;

try { tracker.initAuto(); } catch (err) {
  console.warn('[BehaviorTracker] initAuto error', err);
}
