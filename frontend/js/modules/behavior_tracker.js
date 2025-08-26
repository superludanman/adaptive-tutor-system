// frontend/js/modules/behavior_tracker.js
/**
 * BehaviorTracker 前端行为追踪模块
 *
 * 目标：
 * - 捕获 TDD-II-07 中规定的关键事件：
 *   code_edit（Monaco 编辑器防抖 2s）、ai_help_request（立即）、test_submission（立即，包含 code）、dom_element_select（立即，iframe 支持）、user_idle（60s）、page_focus_change（visibility）
 * - 组装标准化 payload 并可靠发送到后端 /api/v1/behavior/log
 * - 优先使用 navigator.sendBeacon；在不支持时 fallback 到 fetch(..., { keepalive: true })
 * - 新增代码改动监控功能，用于分析用户编程行为
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
  }

  // -------------------- 核心发送函数 --------------------
  // 优先使用 navigator.sendBeacon，否则使用 fetch keepalive（并在控制台打印错误）
  _sendPayload(payload) {
    const url = '/api/v1/behavior/log';
    try {
      if (navigator && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
      } else {
        // fallback: fetch keepalive（注意：并非所有浏览器都支持 keepalive）
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(err => {
          console.warn('[BehaviorTracker] fetch fallback 发送失败：', err);
        });
      }
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

  // -------------------- 编辑器（Monaco）相关 --------------------
  // editors: { html: monacoEditorInstance, css: ..., js: ... }
  initEditors(editors) {
    if (!editors) return;

    // 防抖上报 code_edit
    const debouncedLog = debounce((name, code) => {
      this.logEvent('code_edit', {
        editorName: name,
        newLength: code ? code.length : 0,
        // TODO: 如果需要可加入 lineCount: editors[name].getModel().getLineCount()
      });
    }, this.debounceMs);

    try {
      if (editors.html && typeof editors.html.onDidChangeModelContent === 'function') {
        editors.html.onDidChangeModelContent(() => debouncedLog('html', editors.html.getValue()));
      }
      if (editors.css && typeof editors.css.onDidChangeModelContent === 'function') {
        editors.css.onDidChangeModelContent(() => debouncedLog('css', editors.css.getValue()));
      }
      if (editors.js && typeof editors.js.onDidChangeModelContent === 'function') {
        editors.js.onDidChangeModelContent(() => debouncedLog('js', editors.js.getValue()));
      }
    } catch (e) {
      console.warn('[BehaviorTracker] initEditors 错误：', e);
    }
  }

  // -------------------- AI 求助（聊天） --------------------
  // sendButtonId: 提问按钮 id；inputSelector: 文本输入选择器
  // mode: 模式 ('learning' 或 'test')；contentId: 内容ID
  initChat(sendButtonId, inputSelector, mode = 'learning', contentId = null) {
    const btn = document.getElementById(sendButtonId);
    const input = document.querySelector(inputSelector);
    if (!btn || !input) return;
    
    const sendMessage = () => {
      const message = input.value || '';
      if (!message.trim()) return;
      this.logEvent('ai_help_request', { 
        message: message.substring(0, 2000),
        mode: mode,
        content_id: contentId
      });
    };
    
    btn.addEventListener('click', sendMessage);
    
    // 支持 Enter 提交
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // -------------------- 测试/提交（包含 code） --------------------
  // runBtnId / submitBtnId: 按钮 id；editors: 同 initEditors；topicIdGetter: 可选函数返回 topic_id
  initTestActions(runBtnId, submitBtnId, editors, topicIdGetter) {
    const gatherCode = () => {
      const code = {};
      if (editors?.html && typeof editors.html.getValue === 'function') code.html = editors.html.getValue();
      if (editors?.css && typeof editors.css.getValue === 'function') code.css = editors.css.getValue();
      if (editors?.js && typeof editors.js.getValue === 'function') code.js = editors.js.getValue();
      return code;
    };

    const runBtn = document.getElementById(runBtnId);
    const subBtn = document.getElementById(submitBtnId);

    if (runBtn) {
      runBtn.addEventListener('click', () => {
        this.logEvent('test_submission', {
          action: 'run',
          topic_id: (typeof topicIdGetter === 'function' ? topicIdGetter() : window.currentTopicId) || null,
          code: gatherCode()
        });
      });
    }

    if (subBtn) {
      subBtn.addEventListener('click', () => {
        this.logEvent('test_submission', {
          action: 'submit',
          topic_id: (typeof topicIdGetter === 'function' ? topicIdGetter() : window.currentTopicId) || null,
          code: gatherCode()
        });
      });
    }
  }

  // -------------------- 元素选择（iframe 支持） --------------------
  // startBtnId / stopBtnId / iframeId
  initDOMSelector(startBtnId, stopBtnId, iframeId) {
    const startBtn = document.getElementById(startBtnId);
    const stopBtn = document.getElementById(stopBtnId);
    const iframe = document.getElementById(iframeId);
    if (!startBtn || !stopBtn || !iframe) return;

    let selecting = false;

    // 点击选择处理器（在 iframe 的 document 上绑定）
    const handler = (e) => {
      const tgt = e.target;
      if (!tgt) return;
      const selector = this._generateCssSelector(tgt);
      this.logEvent('dom_element_select', {
        tagName: tgt.tagName,
        selector,
        position: { x: e.clientX, y: e.clientY }
      });
      // TODO: 可在 iframe 中高亮元素或显示 tooltip，当前只上报事件
    };

    startBtn.addEventListener('click', () => {
      if (selecting) return;
      selecting = true;
      try {
        // 仅在同源 iframe 下可直接访问 contentWindow.document
        iframe.contentWindow.document.addEventListener('click', handler);
      } catch (err) {
        // 跨域 iframe 无法直接访问 -> 需要在 iframe 内实现 postMessage 协作
        console.warn('[BehaviorTracker] 无法访问 iframe document（可能跨域）。若需要选择，请实现 postMessage 协作。');
        // TODO: ceq如果页面存在跨域 iframe，则需要实现 postMessage 协作协议
      }
    });

    stopBtn.addEventListener('click', () => {
      if (!selecting) return;
      selecting = false;
      try {
        iframe.contentWindow.document.removeEventListener('click', handler);
      } catch (err) {
        // ignore
      }
    });
  }

  // -------------------- 闲置与焦点检测 --------------------
  initIdleAndFocus(idleMs) {
    const idleThreshold = typeof idleMs === 'number' ? idleMs : this.idleThreshold;

    const resetIdle = () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.logEvent('user_idle', { duration_ms: idleThreshold });
      }, idleThreshold);
    };

    ['mousemove', 'keydown', 'scroll', 'click'].forEach(evt => {
      document.addEventListener(evt, resetIdle, { passive: true });
    });

    document.addEventListener('visibilitychange', () => {
      const status = document.hidden ? 'blur' : 'focus';
      this.logEvent('page_focus_change', { status });
      if (status === 'focus') resetIdle();
    });

    // 启动初始计时
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

  //TODO：ceq热力图内容的采集，目前决定和行为日志放在一起，产生较大单条日志可能考虑独立迁移。
  /* ============= 热力图（Heatmap）采集模块 =============
   - 支持按 page_id 分页统计（优先 document.body.dataset.pageId -> window.pageId -> location.pathname）
   - 点击（click）采集：记录坐标并聚合到网格单元
   - 停留（dwell）采集：基于定时采样（samplingIntervalMs），统计 samples -> 可转换为 ms
   - 数据持久化：保存在 localStorage（key: heatmap_data_v1），并支持周期性发送为 'heatmap_snapshot' 事件
    ================================================== */
  // 采样鼠标位置以估计停留时间（每次采样把 samples++，可转换为 dwell_ms）
  _sampleMousePosition() { }
  // 处理点击事件，记录到 heatmapData
  _onHeatmapClick(e) { }


  // -------------------- 自动初始化：尝试识别页面并注册监听 --------------------
  // 如果你希望更强控制，请在页面主动调用 tracker.initEditors(...) 等方法
  initAuto() {
    document.addEventListener('DOMContentLoaded', () => {
      // 编辑器页面检测：根据 DOM 中是否存在 id=monaco-editor 来识别
      const monacoContainer = document.getElementById('monaco-editor');
      if (monacoContainer && window.monaco && window.editors) {
        // 如果页面在全局把编辑器实例放到了 window.editors（推荐），直接取用
        try {
          const editors = window.editors || {};
          this.initEditors(editors);
          this.initChat('send-message', '#user-message');
          this.initTestActions('run-button', 'reset-button', editors, () => window.currentTopicId || null);
          this.initIdleAndFocus();
        } catch (e) {
          console.warn('[BehaviorTracker] 编辑器自动初始化失败，请在页面主动调用 tracker.initEditors(...)', e);
        }
        return;
      }

      // 元素选择页面检测
      const iframe = document.getElementById('element-selector-iframe');
      if (iframe) {
        this.initDOMSelector('startSelector', 'stopSelector', 'element-selector-iframe');
        this.initChat('send-message', '#user-message');
        this.initIdleAndFocus();
      }
    });
  }
}

// 导出单例并自动运行 initAuto 以便不改动 HTML 的情况下生效
const tracker = new BehaviorTracker();
export default tracker;
try {
  tracker.initAuto();
} catch (err) {
  console.warn('[BehaviorTracker] initAuto error', err);
}
