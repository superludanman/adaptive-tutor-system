// frontend/js/modules/behavior_tracker.js
/**
 * BehaviorTracker 前端行为追踪模块
 *
 * 目标：
 * - 捕获 TDD-II-07 中规定的关键事件：
 *   code_edit（Monaco 编辑器防抖 2s）、ai_help_request（立即）、test_submission（立即，包含 code）、dom_element_select（立即，iframe 支持）、user_idle（60s）、page_focus_change（visibility）
 * - 组装标准化 payload 并可靠发送到后端 /api/v1/behavior/log
 * - 优先使用 navigator.sendBeacon；在不支持时 fallback 到 fetch(..., { keepalive: true })
 *
 * 注意：
 * - 本文件不修改现有 HTML。脚本提供自动初始化尝试（initAuto），但更可靠的方式是：在页面创建 Monaco 编辑器后显式调用 tracker.initEditors(...) 与 tracker.initTestActions(...)
 * - TODO中表示需要我们根据实际项目调整或确认的点（Monaco 编辑器实例的暴露方式等）
 */

// frontend/js/modules/behavior_tracker.js
/**
 * BehaviorTracker 前端行为追踪模块
 *
 * 新增：
 * - 页面点击统计（dom_click_stats）：交互区记录【相对坐标+内容】；非交互区只记录【相对坐标】。
 * - 相对坐标：相对于目标元素边界的 [0,1] 归一化坐标（x_norm/y_norm），并附带视口归一化坐标 vp_x_norm/vp_y_norm。
 * - 批量打包：可配置 flushInterval / maxBatchSize；对高频区域（如 .monaco-editor）可使用更短 flush。
 *
 * 仍保持：
 * - 不写死后端地址：init({ endpoint }) 或 window.__API_BASE__ / <meta name="api-base"> / 回落 '/api/v1/behavior/log'
 * - 发送不带凭证：fetch(credentials:'omit')；sendBeacon 优先。
 */

import debounce from 'https://cdn.jsdelivr.net/npm/lodash-es@4.17.21/debounce.js';
import { getParticipantId } from './session.js';

function resolveBehaviorEndpoint(configEndpoint) {
  if (configEndpoint && typeof configEndpoint === 'string') return configEndpoint;
  try { if (window.__API_BASE__) return String(window.__API_BASE__).replace(/\/$/, '') + '/api/v1/behavior/log'; } catch { }
  try {
    const meta = document.querySelector('meta[name="api-base"]');
    if (meta?.content) return String(meta.content).replace(/\/$/, '') + '/api/v1/behavior/log';
  } catch { }
  return '/api/v1/behavior/log';
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

class BehaviorTracker {
  constructor() {
    // —— 基本配置 ——
    this.idleThreshold = 60000; // 60s
    this.debounceMs = 2000;
    this._endpoint = '/api/v1/behavior/log';

    // —— 状态 ——
    this.idleTimer = null;
    this._focusAndIdleBound = false;
    this._enabledEvents = {};

    // —— 点击统计（批量）——
    this._clickCfg = null;
    this._clickBatch = [];
    this._clickBatchTimer = null;
    this._lastFlushAt = 0;
  }

  init(config = {}) {
    this._endpoint = resolveBehaviorEndpoint(config.endpoint);
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
    if (config.test_submission && window.editors) {
      this.initTestActions('run-button', 'submit-button', window.editors, () => window.currentTopicId || null);
    }
    if (config.element_clicks) {
      this.initElementClickTracking(config.element_click_options || {});
    }
  }

  // -------------------- 发送（无 credentials） --------------------
  _sendPayload(payload) {
    const url = this._endpoint;
    try {
      if (navigator && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
          credentials: 'omit', // ✅ 不带凭证
        }).catch(err => console.warn('[BehaviorTracker] fetch 发送失败：', err));
      }
    } catch (e) {
      console.warn('[BehaviorTracker] 发送异常：', e);
    }
  }

  // -------------------- 公共上报 --------------------
  logEvent(eventType, eventData = {}) {
    let participant_id = null;
    try { if (typeof getParticipantId === 'function') participant_id = getParticipantId(); } catch { }
    if (!participant_id && typeof window !== 'undefined' && window.participantId) participant_id = window.participantId;
    if (!participant_id) { console.warn('[BehaviorTracker] 无 participant_id，跳过：', eventType); return; }

    const payload = {
      participant_id,
      event_type: eventType,
      event_data: eventData,          // 按你后端使用的命名保持 event_data
      timestamp: new Date().toISOString()
    };
    this._sendPayload(payload);
  }

  // -------------------- Monaco 编辑器 --------------------
  initEditors(editors) {
    if (!editors) return;
    const debouncedLog = debounce((name, code) => {
      this.logEvent('code_edit', { editorName: name, newLength: code ? code.length : 0 });
    }, this.debounceMs);

    try {
      if (editors.html?.onDidChangeModelContent) editors.html.onDidChangeModelContent(() => debouncedLog('html', editors.html.getValue()));
      if (editors.css?.onDidChangeModelContent) editors.css.onDidChangeModelContent(() => debouncedLog('css', editors.css.getValue()));
      if (editors.js?.onDidChangeModelContent) editors.js.onDidChangeModelContent(() => debouncedLog('js', editors.js.getValue()));
    } catch (e) { console.warn('[BehaviorTracker] initEditors 错误：', e); }
  }

  // -------------------- AI 求助 --------------------
  initChat(sendButtonId, inputSelector, mode = 'learning', contentId = null) {
    const btn = document.getElementById(sendButtonId);
    const input = document.querySelector(inputSelector);
    if (!btn || !input) return;

    const sendMessage = () => {
      const message = input.value || '';
      if (!message.trim()) return;
      this.logEvent('ai_help_request', { message: message.substring(0, 2000), mode, content_id: contentId });
    };

    btn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }

  // -------------------- 测试/提交 --------------------
  initTestActions(runBtnId, submitBtnId, editors, topicIdGetter) {
    const gatherCode = () => {
      const code = {};
      if (editors?.html?.getValue) code.html = editors.html.getValue();
      if (editors?.css?.getValue) code.css = editors.css.getValue();
      if (editors?.js?.getValue) code.js = editors.js.getValue();
      return code;
    };
    const runBtn = document.getElementById(runBtnId);
    const subBtn = document.getElementById(submitBtnId);

    if (runBtn) runBtn.addEventListener('click', () => {
      this.logEvent('test_submission', { action: 'run', topic_id: (typeof topicIdGetter === 'function' ? topicIdGetter() : window.currentTopicId) || null, code: gatherCode() });
    });
    if (subBtn) subBtn.addEventListener('click', () => {
      this.logEvent('test_submission', { action: 'submit', topic_id: (typeof topicIdGetter === 'function' ? topicIdGetter() : window.currentTopicId) || null, code: gatherCode() });
    });
  }

  // -------------------- 页面点击统计（新增） --------------------
  /**
   * options:
   * {
   *   batch: true,
   *   flushInterval: 1500,          // 普通区域打包间隔
   *   maxBatchSize: 40,             // 到达上限立即发送
   *   frequentAreaSelectors: ['.monaco-editor'], // 高频区域选择器
   *   frequentFlushInterval: 500,   // 高频区域更短的打包间隔
   *   includeTextMaxLen: 120        // 交互内容截断
   * }
   */
  initElementClickTracking(options = {}) {
    const defaults = {
      batch: true,
      flushInterval: 1500,
      maxBatchSize: 40,
      frequentAreaSelectors: [],
      frequentFlushInterval: 500,
      includeTextMaxLen: 120,
    };
    this._clickCfg = { ...defaults, ...options };

    const handler = (e) => {
      const t = e.target;
      if (!t || !(t instanceof Element)) return;

      const rec = this._buildClickRecord(t, e, this._clickCfg.includeTextMaxLen);
      const isFrequent = this._matchesAny(t, this._clickCfg.frequentAreaSelectors);

      if (this._clickCfg.batch) {
        this._enqueueClick(rec, isFrequent);
      } else {
        // 单发模式：每次点击直接发一条 dom_click_stats，items 长度为 1
        this._sendClickBatch([rec]);
      }
    };

    // 捕获阶段，避免被框架停止冒泡
    document.addEventListener('click', handler, { capture: true });
  }

  _buildClickRecord(target, e, maxLen) {
    const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    const w = rect?.width || 1, h = rect?.height || 1;
    const x_norm = clamp01((e.clientX - (rect?.left ?? 0)) / w);
    const y_norm = clamp01((e.clientY - (rect?.top ?? 0)) / h);
    const vp_x_norm = clamp01(e.clientX / (window.innerWidth || 1));
    const vp_y_norm = clamp01(e.clientY / (window.innerHeight || 1));
    const tag = (target.tagName || '').toLowerCase();
    const selector = this._generateCssSelector(target);

    const interactive = this._isInteractive(target);
    const content = interactive ? this._getInteractiveContent(target, maxLen) : null;

    return {
      t: new Date().toISOString(),
      tag,
      selector,
      interactive,
      x_norm, y_norm,
      vp_x_norm, vp_y_norm,
      rect_wh: { w: Math.round(w), h: Math.round(h) },
      page: { vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      content,                       // 仅交互元素采集
      content_len: content ? content.length : 0,
    };
  }

  _isInteractive(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (['button', 'input', 'select', 'textarea', 'label'].includes(tag)) return true;
    if (el.hasAttribute('contenteditable')) return true;
    if (el.getAttribute('role') === 'button') return true;
    if (el.matches?.('a[href], [tabindex]:not([tabindex="-1"])')) return true;
    return false;
  }

  _getInteractiveContent(el, maxLen = 120) {
    try {
      const tag = el.tagName?.toLowerCase() || '';
      // 避免敏感信息
      if (tag === 'input' && (el.type === 'password' || el.type === 'file')) return null;

      let text = '';
      if (tag === 'input' || tag === 'textarea') text = el.value ?? '';
      else text = el.textContent ?? '';

      text = text.trim().replace(/\s+/g, ' ');
      if (text.length > maxLen) text = text.slice(0, maxLen);
      return text || null;
    } catch { return null; }
  }

  _matchesAny(el, selectors = []) {
    if (!el?.matches || !selectors?.length) return false;
    return selectors.some(sel => {
      try { return el.matches(sel) || !!el.closest(sel); } catch { return false; }
    });
  }

  _enqueueClick(rec, isFrequent) {
    this._clickBatch.push(rec);
    const now = Date.now();
    const cfg = this._clickCfg;

    // 达到最大批量 -> 立即发送
    if (this._clickBatch.length >= cfg.maxBatchSize) {
      this._flushClickBatch();
      return;
    }

    // 首次或需要调整计时器
    const interval = isFrequent ? cfg.frequentFlushInterval : cfg.flushInterval;

    // 如果已有计时器，但当前区域更“高频”，则缩短下一次触发
    if (this._clickBatchTimer) {
      const nextAt = this._lastFlushAt + interval;
      if (now + interval < nextAt) {
        clearTimeout(this._clickBatchTimer);
        this._clickBatchTimer = setTimeout(() => this._flushClickBatch(), interval);
      }
      return;
    }

    // 启动计时器
    this._clickBatchTimer = setTimeout(() => this._flushClickBatch(), interval);
  }

  _flushClickBatch() {
    if (!this._clickBatch.length) return;
    const items = this._clickBatch.splice(0, this._clickBatch.length);
    clearTimeout(this._clickBatchTimer);
    this._clickBatchTimer = null;
    this._lastFlushAt = Date.now();
    this._sendClickBatch(items);
  }

  _sendClickBatch(items) {
    // 统一事件名：dom_click_stats（数组）
    this.logEvent('dom_click_stats', {
      page_url: window.location.pathname,
      count: items.length,
      items
    });
  }

  // -------------------- 闲置与焦点 --------------------
  initIdleAndFocus(idleMs = this.idleThreshold) {
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

  // -------------------- 生成 CSS Selector --------------------
  _generateCssSelector(el) {
    if (!el) return '';
    const parts = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let part = el.nodeName.toLowerCase();
      if (el.id) { part += `#${el.id}`; parts.unshift(part); break; }
      let i = 1, sib = el;
      while ((sib = sib.previousElementSibling) != null) { if (sib.nodeName.toLowerCase() === part) i++; }
      if (i > 1) part += `:nth-of-type(${i})`;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  // -------------------- 自动尝试 --------------------
  initAuto() {
    document.addEventListener('DOMContentLoaded', () => {
      const monacoContainer = document.getElementById('monaco-editor');
      if (monacoContainer && window.monaco && window.editors) {
        try { this.initEditors(window.editors || {}); } catch (e) { console.warn('[BehaviorTracker] 编辑器自动初始化失败', e); }
      }
    });
  }
}

const tracker = new BehaviorTracker();
export default tracker;

try { tracker.initAuto(); } catch (err) { console.warn('[BehaviorTracker] initAuto error', err); }
