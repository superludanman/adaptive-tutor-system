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

    this.hintConfig = {
    hintThreshold: 3, // 触发提示的连续修改次数阈值
    cooldownPeriod: 30000, // 提示冷却时间（30秒）
    lastHintTime: 0 // 上次提示时间
};
    // 智能代码监控配置
    this.codeMonitoringConfig = {
      minChangeThreshold: 10, // 最小触发字符数变化
      meaningfulEditTimeout: 3000, // 有意义编辑的超时时间（ms）：防止过度触发：避免将用户的连续输入（如快速打字）误判为多个独立的有意义编辑
      problemDetectionThreshold: 3, // 问题检测阈值（连续修改次数）：检测反复修改：当用户在短时间内连续修改代码多次（默认3次），认为可能遇到了问题
      maxHistoryLength: 100 // 最大历史记录长度
    };
    // 代码监控状态
    this.codeMonitorStates = {
      html: this._createEditorState(),
      css: this._createEditorState(),
      js: this._createEditorState()
    };
    
    this.problemEvents = []; // 记录用户遇到问题的次数
    this.significantEdits = []; // 有意义的重要编辑记录
  }

  // 创建编辑器状态对象
  _createEditorState() {
    return {
      lastContent: '',
      lastLength: 0,
      lastMeaningfulEdit: 0,
      isDeleting: false,
      deleteStartTime: 0,
      deleteStartLength: 0,
      consecutiveEdits: 0,// 连续修改次数
      editBuffer: []
    };
  }

// 触发问题事件（用于UI监听）
_triggerProblemEvent(problemData) {
    const event = new CustomEvent('codingProblemDetected', {
        detail: problemData
    });
    document.dispatchEvent(event);
}

  // -------------------- 智能代码监控核心功能 --------------------
  /**
   * 初始化智能代码改动监控
   */
  initSmartCodeTracking(editors) {
    if (!editors) {
      console.warn('[BehaviorTracker] 无编辑器实例，无法初始化智能代码监控');
      return;
    }

    try {
      // 为每个编辑器设置智能监控
      Object.keys(editors).forEach(editorType => {
        if (editors[editorType] && typeof editors[editorType].onDidChangeModelContent === 'function') {
          editors[editorType].onDidChangeModelContent(() => {
            this._smartRecordCodeChange(editorType, editors[editorType].getValue());
          });
        }
      });

      console.log('[BehaviorTracker] 智能代码监控已初始化');
      
    } catch (e) {
      console.warn('[BehaviorTracker] 初始化智能代码监控时出错：', e);
    }
  }

/**
   * 智能记录代码改动
   */
  _smartRecordCodeChange(editorType, currentContent) {
    const state = this.codeMonitorStates[editorType];
    const currentLength = currentContent.length;
    const previousLength = state.lastLength;
    const lengthChange = currentLength - previousLength;
    
    // 更新最后内容
    state.lastContent = currentContent;
    state.lastLength = currentLength;
    
    const now = Date.now();
    const timeSinceLastEdit = now - state.lastMeaningfulEdit;
    
    // 判断编辑类型
    if (lengthChange < 0) {
      // 删除操作
      this._handleDeletion(editorType, state, currentLength, now);
    } else if (lengthChange > 0) {
      // 增加操作
      this._handleAddition(editorType, state, lengthChange, currentLength, now, timeSinceLastEdit);
    }
    
    // 缓冲当前编辑信息（用于后续分析）
    state.editBuffer.push({
      timestamp: now,
      length: currentLength,
      change: lengthChange,
      content: currentContent
    });
    
    // 保持缓冲区大小
    if (state.editBuffer.length > 20) {
      state.editBuffer.shift();
    }
  }
  /**
   * 处理删除操作
   */
  _handleDeletion(editorType, state, currentLength, timestamp) {
    if (!state.isDeleting) {
      // 开始删除
      state.isDeleting = true;
      state.deleteStartTime = timestamp;
      state.deleteStartLength = state.lastLength;
      state.consecutiveEdits++;
      
      console.log(`[${editorType}] 开始删除代码`);
    }
  }

  /**
   * 处理增加操作
   */
  _handleAddition(editorType, state, lengthChange, currentLength, timestamp, timeSinceLastEdit) {
    if (state.isDeleting) {
      // 之前是删除状态，现在是增加 → 完成一个修改周期
      this._completeEditCycle(editorType, state, timestamp, currentLength);
    } else if (lengthChange >= this.codeMonitoringConfig.minChangeThreshold && 
               timeSinceLastEdit > this.codeMonitoringConfig.meaningfulEditTimeout) {
      // 有意义的正向编辑（超过阈值且有一定时间间隔）
      this._recordMeaningfulEdit(editorType, 'addition', lengthChange, currentLength, timestamp);
    }
    
    state.consecutiveEdits++;
    state.lastMeaningfulEdit = timestamp;
  }

  /**
   * 完成编辑周期（删除后重新编写）
   */
  _completeEditCycle(editorType, state, timestamp, finalLength) {
    const deleteDuration = timestamp - state.deleteStartTime;// 删除持续时间
    const netChange = finalLength - state.deleteStartLength;
    const absoluteChange = Math.abs(netChange);
    
    // 只有变化超过阈值才记录
    if (absoluteChange >= this.codeMonitoringConfig.minChangeThreshold) {
      const editRecord = {
        type: 'edit_cycle',
        editor: editorType,
        timestamp: timestamp,
        duration: deleteDuration,
        netChange: netChange,
        absoluteChange: absoluteChange,
        startLength: state.deleteStartLength,
        endLength: finalLength,
        consecutiveEdits: state.consecutiveEdits
      };
      
      this.significantEdits.push(editRecord);
      
      // 保持记录数量
      if (this.significantEdits.length > this.codeMonitoringConfig.maxHistoryLength) {
        this.significantEdits.shift();
      }
      
      // 输出到控制台
      this._logSignificantEdit(editRecord);
      
      // 检测是否遇到问题（连续多次修改）
      if (state.consecutiveEdits >= this.codeMonitoringConfig.problemDetectionThreshold) {
        this._recordProblemEvent(editorType, state.consecutiveEdits, timestamp);
      }
      // 批量提交逻辑：每积累5个重要编辑或遇到问题时提交
      if (this.significantEdits.length >= 5 || 
          state.consecutiveEdits >= this.codeMonitoringConfig.problemDetectionThreshold) {
          this._submitSignificantEdits();
      }
    }
    
    // 重置状态
    state.isDeleting = false;
    state.deleteStartTime = 0;// 删除开始时间
    state.deleteStartLength = 0;// 删除开始时的长度
    state.consecutiveEdits = 0;
  }

  // 批量提交重要编辑
  // 触发条件：积累5个重要编辑或遇到问题时
  // 冷却周期：无固定冷却，基于数量阈值
  // 提交策略：批量提交
  _submitSignificantEdits() {
      if (this.significantEdits.length === 0) return;
      
      const editsToSubmit = this.significantEdits.slice(-5); // 提交最近5个
      this.logEvent('significant_edits', {
          count: editsToSubmit.length,
          edits: editsToSubmit,
          timestamp: new Date().toISOString()
      });
      
      console.log(`批量提交 ${editsToSubmit.length} 个重要编辑事件`);
  }
  // 在页面卸载或会话结束时提交所有数据
  // 触发条件：页面关闭/卸载时
  // 冷却周期：仅会话结束时触发一次
  // 提交策略：完整数据提交
  _initSessionEndHandler() {
      window.addEventListener('beforeunload', () => {
          this._submitAllData();
      });
  }

  _submitAllData() {
      if (this.significantEdits.length > 0) {
          this.logEvent('coding_session_summary', {
              total_edits: this.significantEdits.length,
              problem_events: this.problemEvents.length,
              significant_edits: this.significantEdits,
              timestamp: new Date().toISOString()
          });
      }
  }
  /**
   * 记录有意义的编辑
   */
  // 触发条件：单次增加操作 ≥10字符 + 超时3秒
  _recordMeaningfulEdit(editorType, editType, changeAmount, currentLength, timestamp) {
    const editRecord = {
      type: editType,
      editor: editorType,
      timestamp: timestamp,
      changeAmount: changeAmount,// 本次修改的字符数
      currentLength: currentLength//  修改后的代码长度
    };
    
    this.significantEdits.push(editRecord);

    // 添加分级实时上传逻辑
    if (changeAmount >= 50) {  // 大段代码增加
        this.logEvent('large_addition', editRecord);  // 实时上传大段增加
    } else if (this.significantEdits.length % 5 === 0) {  // 每5个批量上传
        this._submitSignificantEdits();
    }
    
    // 保持记录数量
    if (this.significantEdits.length > this.codeMonitoringConfig.maxHistoryLength) {
      this.significantEdits.shift();
    }
    
    console.log(`[${editorType}] 有意义编辑: ${changeAmount}字符`);
  }

  /**
   * 记录问题事件
   */
  _recordProblemEvent(editorType, consecutiveEdits, timestamp) {
      const problemEvent = {
          editor: editorType,
          timestamp: timestamp,
          consecutiveEdits: consecutiveEdits,
          severity: this._calculateProblemSeverity(consecutiveEdits)
      };
      
      this.problemEvents.push(problemEvent);
      
      // 触发问题提示
      if (consecutiveEdits >= this.hintConfig.hintThreshold) {
          this._triggerProblemHint(editorType, consecutiveEdits, timestamp);
      }
      // 立即提交问题事件
      this._submitProblemEvent(problemEvent);
  }
  // 新增问题提示触发方法
  _triggerProblemHint(editorType, editCount, timestamp) {
      // 检查冷却时间
      const now = Date.now();
      if (now - this.hintConfig.lastHintTime < this.hintConfig.cooldownPeriod) {
          return; // 还在冷却中，不触发提示
      }
      
      // 更新最后提示时间
      this.hintConfig.lastHintTime = now;
      
      // 触发自定义事件
      const eventDetail = {
          editor: editorType,
          editCount: editCount,
          timestamp: timestamp,
          message: this._generateHintMessage(editorType, editCount)
      };
      
      const event = new CustomEvent('problemHintNeeded', {
          detail: eventDetail
      });
      document.dispatchEvent(event);
      
      console.log(`触发问题提示: ${editorType} 编辑器, ${editCount} 次修改`);
  }
  // 生成提示消息
  
  _generateHintMessage(editorType, editCount) {
      const editorNames = {
          html: 'HTML',
          css: 'CSS', 
          js: 'JavaScript'
      };
      
      const messages = [
          `我注意到您在${editorNames[editorType]}代码中反复修改了${editCount}次，需要帮助吗？`,
          `检测到${editorNames[editorType]}代码有${editCount}处反复修改，是否需要协助解决？`,
          `看起来您在${editorNames[editorType]}部分遇到了些困难，需要我提供建议吗？`,
          `您在${editorNames[editorType]}编辑器中多次调整代码，有什么我可以帮忙的吗？`
      ];
      
      return messages[Math.floor(Math.random() * messages.length)];
  }
  // 专门的问题事件提交方法
  // 触发条件：连续编辑 ≥3次
  // 冷却周期：无冷却，实时触发
  // 提交策略：立即提交
  _submitProblemEvent(problemEvent) {
      this.logEvent('coding_problem', {
          editor: problemEvent.editor,
          consecutive_edits: problemEvent.consecutiveEdits,
          severity: problemEvent.severity,// 区分严重程度
          timestamp: new Date(problemEvent.timestamp).toISOString()
      });
      
      console.warn(`实时提交问题事件: ${problemEvent.editor} 编辑器, ${problemEvent.consecutiveEdits} 次连续编辑`);
  }

  /**
   * 计算问题严重程度
   */
  _calculateProblemSeverity(consecutiveEdits) {//问题严重程度：低(3-4次)、中(5-7次)、高(≥8次)三个等级
    if (consecutiveEdits >= 10) return 'high';
    if (consecutiveEdits >= 5) return 'medium';
    return 'low';
  }

  /**
   * 输出重要编辑日志
   */
  // 触发条件：完成"删除→重新编写"完整周期 + 净变化≥10字符
  _logSignificantEdit(editRecord) {
    const time = new Date(editRecord.timestamp).toLocaleTimeString();
    const changeType = editRecord.netChange >= 0 ? '增加' : '减少';
    
    console.log(
      `%c重要编辑%c [${time}] %c${editRecord.editor.toUpperCase()}%c: ${changeType} ${Math.abs(editRecord.netChange)}字符, 历时 ${editRecord.duration}ms, 连续 ${editRecord.consecutiveEdits}次编辑`,
      'background: #4dabf7; color: white; padding: 2px 4px; border-radius: 3px;',
      'color: #666;',
      'color: #339af0; font-weight: bold;',
      'color: default;'
    );// 只是日志输出，不上传
  }

  /**
   * 获取代码行为分析
   */
  getCodingBehaviorAnalysis() {
    const now = Date.now();
    const sessionDuration = Math.round((now - (this.significantEdits[0]?.timestamp || now)) / 1000);
    
    // 计算各种统计数据
    const totalSignificantEdits = this.significantEdits.length;
    const problemEventsCount = this.problemEvents.length;
    
    const editsByType = this.significantEdits.reduce((acc, edit) => {
      acc[edit.type] = (acc[edit.type] || 0) + 1;
      return acc;
    }, {});
    
    const editsByEditor = this.significantEdits.reduce((acc, edit) => {
      acc[edit.editor] = (acc[edit.editor] || 0) + 1;
      return acc;
    }, {});
    
    // 计算平均编辑规模
    const editCycles = this.significantEdits.filter(e => e.type === 'edit_cycle');
    const avgEditSize = editCycles.length > 0 ? 
      Math.round(editCycles.reduce((sum, e) => sum + Math.abs(e.netChange), 0) / editCycles.length) : 0;
    
    return {
      sessionDuration,//  会话持续时间
      totalSignificantEdits,//  重要编辑总数
      problemEventsCount,//  问题事件总数
      editsByType,  //  按编辑类型分类的编辑数
      editsByEditor,//  按编辑器分类的编辑数
      avgEditSize,//  平均编辑规模（字符数）
      recentProblems: this.problemEvents.slice(-5),// 最近5个问题事件
      recentEdits: this.significantEdits.slice(-10)// 最近10个重要编辑
    };
  }

  /**
   * 重置监控状态
   */
  resetCodeMonitoring() {
    this.codeMonitorStates = {
      html: this._createEditorState(),
      css: this._createEditorState(),
      js: this._createEditorState()
    };
    this.problemEvents = [];
    this.significantEdits = [];
    console.log('[BehaviorTracker] 代码监控状态已重置');
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
