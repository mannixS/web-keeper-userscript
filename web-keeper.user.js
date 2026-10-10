// ==UserScript==
// @name         网页保活与定时采集助手
// @namespace    local.web-keeper
// @version      1.0.4
// @description  点选元素、定时点击后返回、录制同站操作并采集多个值，支持每日计划和 CSV 导出。
// @author       mannixS
// @license      MIT
// @homepageURL  https://github.com/mannixS/web-keeper-userscript
// @supportURL   https://github.com/mannixS/web-keeper-userscript/issues
// @updateURL    https://raw.githubusercontent.com/mannixS/web-keeper-userscript/main/web-keeper.user.js
// @downloadURL  https://raw.githubusercontent.com/mannixS/web-keeper-userscript/main/web-keeper.user.js
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @sandbox      DOM
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function () {
  'use strict';

  const Core = (() => {
    const VERSION = '1.0.4';
    const MIN_INTERVAL = 5000;
    const MAX_DELAY = 86400000;
    const normalizeLabel = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const isTransientClass = value => /(?:^|[-_])(active|selected|hover|focus|focused|open|opened|checked|disabled|loading|highlight|highlighted|hidden|visible|expanded)(?:$|[-_])/.test(value);
    const isDynamicId = value => /^(?:rc_select_|rc-select-|rc_unique_|:r)/i.test(value);
    function optionSelector(target) {
      const selector = target && Array.isArray(target.selectors) ? target.selectors.at(-1) || '' : '';
      let base = '';
      if (selector.includes('.ant-select-dropdown-menu-item')) base = '.ant-select-dropdown-menu-item';
      else if (selector.includes('.ant-select-item-option')) base = '.ant-select-item-option';
      else if (selector.includes('.el-select-dropdown__item')) base = '.el-select-dropdown__item';
      else if (/\[role\s*=\s*["']?option["']?\s*\]/.test(selector)) base = '[role="option"]';
      if (!target || !target.option) return base;
      // 用户已有的 active/selected 选择器也不能参与选项身份识别。
      const stateClass = (selector.match(/\.([a-zA-Z_][\w-]*)/g) || []).some(token => isTransientClass(token.slice(1)));
      return base && stateClass ? base : selector;
    }
    const optionText = target => normalizeLabel(target && target.option ? target.option.text : target && target.text);
    function createId(cryptoApi = globalThis.crypto) {
      if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
      if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
        const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return hex.slice(0,8) + '-' + hex.slice(8,12) + '-' + hex.slice(12,16) + '-' + hex.slice(16,20) + '-' + hex.slice(20);
      }
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
    }
    function nextRun(schedule, now = Date.now()) {
      if (schedule.type === 'interval') return now + schedule.everyMs;
      const [h, m] = schedule.time.split(':').map(Number);
      const date = new Date(now);
      date.setHours(h, m, 0, 0);
      if (date.getTime() <= now) date.setDate(date.getDate() + 1);
      return date.getTime();
    }
    function extract(raw, pattern) {
      if (!pattern) return String(raw).trim();
      const match = String(raw).match(new RegExp(pattern));
      if (!match) throw new Error('提取规则没有匹配到值');
      return match[1] === undefined ? match[0] : match[1];
    }
    function csvCell(value) {
      let str = String(value == null ? '' : value);
      if (/^[\s]*[=+\-@\t\r]/.test(str)) str = "'" + str;
      return '"' + str.replace(/"/g, '""') + '"';
    }
    function toCSV(samples) {
      const rows = [['采集时间', '任务', '值名称', '值', '原始内容', '页面地址']];
      for (const sample of samples) rows.push([new Date(sample.time).toISOString(), sample.taskName, sample.name, sample.value, sample.raw, sample.url]);
      return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    }
    function sameOrigin(url, origin) {
      try { const parsed = new URL(url, origin); return /^https?:$/.test(parsed.protocol) && parsed.origin === origin; }
      catch { return false; }
    }
    function sameRoute(left, right, origin) {
      try {
        const a = new URL(left, origin), b = new URL(right, origin);
        return a.origin === b.origin && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '') && a.hash === b.hash;
      } catch { return false; }
    }
    function validateTask(task, origin, validateSelector = () => {}) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id) throw new Error('任务缺少 ID');
      if (typeof task.name !== 'string' || !task.name.trim() || task.name.length > 120) throw new Error('请填写任务名称（最多 120 字）');
      if (!['keep', 'collect'].includes(task.kind)) throw new Error('任务类型无效');
      if (typeof task.enabled !== 'boolean') throw new Error('任务启用状态无效');
      if (!sameOrigin(task.entryUrl, origin)) throw new Error('起始地址必须属于当前网站');
      const schedule = task.schedule;
      if (!schedule || !['interval', 'daily'].includes(schedule.type)) throw new Error('请选择执行计划');
      if (schedule.type === 'interval' && (!Number.isFinite(schedule.everyMs) || schedule.everyMs < MIN_INTERVAL || schedule.everyMs > 365 * MAX_DELAY)) throw new Error('执行间隔应在 5 秒至 365 天之间');
      if (schedule.type === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('每日时间格式应为 HH:mm');
      if (!['history', 'url', 'none'].includes(task.returnMode)) throw new Error('返回方式无效');
      if (!Number.isFinite(task.returnDelayMs) || task.returnDelayMs < 0 || task.returnDelayMs > MAX_DELAY) throw new Error('返回等待应在 0 秒至 24 小时之间');
      if (!Number.isFinite(task.timeoutMs) || task.timeoutMs < 1000 || task.timeoutMs > 300000) throw new Error('元素等待超时应在 1 至 300 秒之间');
      if (!Array.isArray(task.steps) || !task.steps.length || task.steps.length > 200) throw new Error('请添加 1 至 200 个操作步骤');
      if (task.kind === 'collect' && !task.steps.some(s => s.type === 'collect')) throw new Error('采集任务至少需要一个「采集值」步骤');
      for (const step of task.steps) {
        if (!step || !['click', 'input', 'wait', 'collect'].includes(step.type)) throw new Error('操作步骤类型无效');
        if (!Number.isFinite(step.delayMs) || step.delayMs < 0 || step.delayMs > MAX_DELAY) throw new Error('步骤等待时间无效');
        if (step.pageUrl && !sameOrigin(step.pageUrl, origin)) throw new Error('步骤执行页面必须属于当前网站');
        if (step.type === 'wait') continue;
        if (!step.target || !Array.isArray(step.target.selectors) || !step.target.selectors.length || step.target.selectors.length > 16) throw new Error('请为操作步骤选择元素');
        for (const selector of step.target.selectors) {
          if (typeof selector !== 'string' || !selector.trim() || selector.length > 4000) throw new Error('元素选择器无效');
          try { validateSelector(selector); } catch { throw new Error('CSS 选择器语法无效：' + selector); }
        }
        if (step.target.option !== undefined && (!step.target.option || typeof step.target.option !== 'object' || typeof step.target.option.text !== 'string')) throw new Error('下拉选项文字无效');
        if (step.type === 'click' && optionSelector(step.target) && !optionText(step.target)) throw new Error('下拉步骤缺少选项文字，请填写「下拉选项文字」');
        if (step.type === 'input' && !(typeof step.value === 'string' || typeof step.value === 'boolean' || (Array.isArray(step.value) && step.value.every(v => typeof v === 'string')))) throw new Error('输入步骤的值无效');
        if (step.type === 'collect') {
          if (typeof step.name !== 'string' || !step.name.trim()) throw new Error('请填写每个采集值的名称');
          if (!['auto', 'text', 'value', 'attribute'].includes(step.source)) throw new Error('读取方式无效');
          if (step.source === 'attribute' && (typeof step.attribute !== 'string' || !step.attribute.trim())) throw new Error('请填写要读取的属性名称');
          if (step.pattern) { try { new RegExp(step.pattern); } catch { throw new Error('正则提取规则无效'); } }
        }
      }
      return task;
    }
    return { VERSION, MIN_INTERVAL, MAX_DELAY, normalizeLabel, isTransientClass, isDynamicId, optionSelector, optionText, createId, nextRun, extract, csvCell, toCSV, sameOrigin, sameRoute, validateTask };
  })();

  // Node 内置测试可以直接加载算法；在浏览器中继续启动界面。
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') { module.exports = Core; return; }

  const ORIGIN = location.origin;
  const PREFIX = 'web-keeper:v1:';
  const DB_KEY = PREFIX + ORIGIN;
  const OWNER_KEY = DB_KEY + ':owner';
  const SESSION_KEY = PREFIX + 'session';
  const MAX_SAMPLES = 5000;
  const OPTION_SELECTOR = '[role="option"],.ant-select-dropdown-menu-item,.ant-select-item-option,.el-select-dropdown__item';
  const COMBO_SELECTOR = '[role="combobox"],.ant-select,.el-select';
  const uid = () => Core.createId();
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = time => time ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '—';
  const defaults = () => ({ version: 1, enabled: false, tasks: [], samples: [], logs: [] });
  const db = () => GM_getValue(DB_KEY, defaults());
  function updateDB(change) { const state = db(); change(state); GM_setValue(DB_KEY, state); }
  let session;
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}'); } catch { session = {}; }
  let storageOK = true;
  function persist() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
    catch { storageOK = false; throw new Error('网页禁止会话存储，无法保存跨页面执行进度'); }
  }
  function log(message, level = 'info') {
    updateDB(state => { state.logs.unshift({ time: Date.now(), message: String(message), level }); state.logs = state.logs.slice(0, 200); });
  }
  let tabId = '';
  let busy = false;
  let startingRun = false;
  let picking = null;
  let pageLeaving = false;
  let lastOwnerCheck = 0;
  let currentView = 'tasks';
  let noticeTimer;
  let renderPending = false;
  const inspectionResults = new Map();
  const environment = {
    startedAt: Date.now(), lastBeatAt: Date.now(), maxGapMs: 0, delayCount: 0,
    lastDelayAt: 0, lastWarningAt: 0, freezeCount: 0, lastResumeAt: 0,
    wasDiscarded: document.wasDiscarded === true
  };
  function clearInspection(index) {
    const step = session.draft && session.draft.steps[index];
    if (!step) return;
    inspectionResults.delete(session.draft.id + ':' + (step.id || index));
    const field = root.querySelector(`[data-inspection="${index}"]`);
    if (field) field.closest('label').remove();
  }

  const host = document.createElement('div');
  host.id = 'web-keeper-root';
  host.style.cssText = 'all:initial!important;position:fixed!important;right:18px!important;bottom:18px!important;z-index:2147483647!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif!important;color:#182238!important;color-scheme:light!important;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial;font:14px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#182238}
    *{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer;border:1px solid #d6deeb;background:#fff;color:#20314e;border-radius:8px;padding:6px 11px}button:hover{background:#edf3ff}button:disabled{opacity:.45;cursor:default}
    .primary{background:#2563eb;color:white;border-color:#2563eb}.primary:hover{background:#1d4ed8}.danger{color:#c53030}input,select,textarea{border:1px solid #d6deeb;border-radius:7px;padding:7px;background:white;color:#182238;min-width:0;width:100%}input[type=checkbox]{width:auto}input:focus,select:focus,textarea:focus{outline:2px solid #bfdbfe;border-color:#2563eb}textarea{resize:vertical}
    #panel{width:470px;max-width:calc(100vw - 36px);max-height:85vh;overflow:auto;background:#f8faff;border:1px solid #dce4f1;box-shadow:0 12px 44px #1c355533;border-radius:14px}header{padding:15px 16px;background:#fff;border-bottom:1px solid #e0e7f1;position:sticky;top:0;z-index:1;border-radius:14px 14px 0 0}.brand{font-weight:750;font-size:17px}.muted{font-size:12px;color:#66758a}.row{display:flex;gap:8px;align-items:center}.between{justify-content:space-between}.wrap{flex-wrap:wrap}.grow{flex:1}.tabs{display:flex;gap:5px;margin-top:12px}.tabs button{flex:1}.tabs .active{color:#2563eb;background:#eff5ff;border-color:#b9cdfb}main{padding:14px}.card,.step{background:#fff;border:1px solid #dde5f0;border-radius:10px;padding:12px;margin-bottom:10px}.card h3{font-size:14px;margin:0 0 6px;overflow-wrap:anywhere}.card .actions{margin-top:9px}.badge{font-size:11px;padding:2px 6px;border-radius:5px;background:#eaf0fb;color:#49638c}.field{display:block;margin:0 0 11px;font-size:12px;font-weight:600}.field input,.field select,.field textarea{display:block;margin-top:4px;font-weight:400}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.grid>.field{margin-bottom:0}.section{font-weight:700;margin:14px 0 9px}.help{font-size:12px;color:#66758a;margin:7px 0;overflow-wrap:anywhere}.empty{text-align:center;color:#66758a;padding:28px 14px}.step-head{display:flex;gap:6px;align-items:center;margin-bottom:8px}.step-head strong{flex:1;font-size:13px}.step-head button{padding:2px 6px;font-size:12px}.selector{font-family:monospace;font-size:11px}.step .field{margin-bottom:8px}.step:last-child{margin-bottom:0}#launcher{box-shadow:0 5px 18px #20334d33;background:#2563eb;color:#fff;border-color:#2563eb;padding:10px 14px;border-radius:24px}#bar{margin-bottom:8px;background:#122546;color:#fff;padding:10px;border-radius:10px;max-width:470px}#bar button{font-size:12px;padding:4px 7px}#notice{position:fixed;right:18px;bottom:80px;background:#182b49;color:#fff;padding:11px 15px;border-radius:10px;max-width:420px;pointer-events:none;box-shadow:0 6px 24px #0002}#outline{position:fixed;pointer-events:none;outline:2px solid #2563eb;background:#2563eb19;z-index:2147483646;border-radius:3px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:7px;border-bottom:1px solid #e5ebf4;text-align:left;vertical-align:top;overflow-wrap:anywhere}td.value{max-width:150px;white-space:pre-wrap}details{margin-top:5px}.log{font-size:12px;padding:8px 0;border-bottom:1px solid #e3eaf5;overflow-wrap:anywhere}.error{color:#b42323}[hidden]{display:none!important}footer{padding:10px 14px;color:#66758a;font-size:11px;border-top:1px solid #e2e9f3;background:#fff}.status{margin-top:7px;font-size:12px;color:#446189}
    .field input[type=checkbox]{display:inline-block;margin:0 4px 0 0;vertical-align:middle}input:disabled,select:disabled{background:#f0f3f8;color:#8390a2}
    .warning{color:#925500}.environment-warning{margin-top:8px;padding:8px;background:#fff6df;border-radius:7px;font-size:12px}.environment-warning button{font-size:12px;padding:3px 7px;margin-top:5px}.environment-stats{margin:8px 0}.environment-stats dt{font-size:12px;color:#66758a;margin-top:8px}.environment-stats dd{margin:2px 0;font-size:13px;overflow-wrap:anywhere}.guide-steps{padding-left:22px;font-size:13px}.guide-steps li{margin:8px 0}.guide-link{color:#2563eb}.guide-check{font-size:13px;font-weight:400}.tabs button{white-space:nowrap;padding-left:6px;padding-right:6px}
  </style><div id="outline" hidden></div><div id="notice" hidden></div><div id="bar" hidden></div><section id="panel" hidden></section><button id="launcher" title="打开网页保活与采集助手">定时助手</button>`;
  document.documentElement.appendChild(host);
  const $ = selector => root.querySelector(selector);
  function notice(message) { $('#notice').textContent = message; $('#notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 4500); }
  function refreshSoon() { if (renderPending) return; renderPending = true; setTimeout(() => { renderPending = false; if (currentView !== 'editor' && !picking) render(); }, 80); }
  function scheduleDescription(task) { return task.schedule.type === 'daily' ? '每天 ' + task.schedule.time : '每 ' + (task.schedule.everyMs / 1000) + ' 秒'; }
  function statusText() {
    if (session.recording) return '正在录制，当前标签的自动任务已暂缓';
    if (session.run) return '执行中：' + session.run.task.name + ' · ' + ({ entry: '打开起始页', arrival: '等待页面', steps: '步骤 ' + (session.run.index + 1), return: '等待返回', returning: '正在返回' }[session.run.phase] || '准备中');
    if (!db().enabled) return '本站自动任务已暂停';
    return GM_getValue(OWNER_KEY, '') === tabId ? '本站自动任务运行中' : '任务在本站另一标签页运行';
  }
  function environmentValues() {
    return {
      visibility: document.hidden ? '后台：可能是切换标签、最小化或锁屏，无法区分' : '页面可见',
      network: navigator.onLine === false ? '浏览器报告离线' : '浏览器报告在线，未验证网站连接',
      interval: environment.maxGapMs ? (environment.maxGapMs / 1000).toFixed(1) + ' 秒（预期约 0.5 秒）' : '等待首次观测',
      delays: environment.delayCount ? environment.delayCount + ' 次，最近一次：' + fmt(environment.lastDelayAt) : '尚未观测到 ≥5 秒的调度间隔，不代表设置正确',
      lifecycle: environment.freezeCount + ' 次冻结事件；' + (environment.lastResumeAt ? '最近恢复：' + fmt(environment.lastResumeAt) : '尚未收到恢复事件；没有事件不代表不会冻结'),
      discarded: environment.wasDiscarded ? '浏览器报告本页此前被丢弃，现已重新加载' : typeof document.wasDiscarded === 'boolean' ? '本次加载未报告此前被丢弃' : '当前浏览器未提供此状态',
      started: fmt(environment.startedAt)
    };
  }
  function updateEnvironmentUI() {
    const warning = $('#environment-warning');
    const warningText = navigator.onLine === false ? '浏览器报告离线，任务可能无法读取最新数据。' : environment.wasDiscarded ? '本页曾被浏览器丢弃，运行已中断过。' : environment.delayCount ? '本页观测到调度延迟，定时操作可能晚于计划。' : '';
    if (warning) { warning.hidden = !warningText; $('#environment-warning-text').textContent = warningText; }
    if (currentView !== 'environment') return;
    for (const [key, value] of Object.entries(environmentValues())) {
      const field = $(`[data-environment="${key}"]`); if (field) field.textContent = value;
    }
  }
  function observeEnvironment() {
    const now = Date.now();
    const gap = now - environment.lastBeatAt;
    environment.lastBeatAt = now;
    if (Number.isFinite(gap) && gap >= 0) {
      environment.maxGapMs = Math.max(environment.maxGapMs, gap);
      if (gap >= 5000) {
        environment.delayCount++; environment.lastDelayAt = now;
        if (db().enabled && (!environment.lastWarningAt || now - environment.lastWarningAt >= 300000)) {
          environment.lastWarningAt = now;
          log('运行环境：两次调度检查间隔 ' + (gap / 1000).toFixed(1) + ' 秒。可能是后台限速、页面冻结、电脑休眠、页面繁忙或系统时钟变化；请查看「运行环境」指引。', 'warning');
        }
      }
    }
    updateEnvironmentUI();
  }
  function environmentHTML(state) {
    const acknowledged = state.environmentAcknowledged || {};
    const values = environmentValues();
    const stats = [['visibility','页面状态'],['network','网络提示'],['interval','最长调度间隔'],['delays','明显延迟记录'],['lifecycle','冻结 / 恢复记录'],['discarded','页面丢弃记录'],['started','本次观察开始时间']];
    return `<article class="card"><h3>运行状态观察</h3><p class="help">可观察页面前后台、调度间隔和浏览器提供的冻结记录。不能单独识别锁屏，也不能读取或修改浏览器休眠白名单、节能开关和 Windows 电源设置。</p><dl class="environment-stats">${stats.map(([key,label]) => `<dt>${label}</dt><dd data-environment="${key}">${esc(values[key])}</dd>`).join('')}</dl><p class="help">调度间隔变长只说明执行延迟，无法判断是哪项设置导致。暂停期间脚本无法发出提示，恢复后才能记录。上述观察仅覆盖本次页面加载；刷新或跳转后重新观察。</p><button data-action="reset-environment">重新开始观察</button></article>
      <article class="card"><h3>1. 将本站加入 Edge 活动网站列表</h3><p class="help">此设置无法自动检测或代为修改。请复制设置地址到浏览器地址栏；网页不能直接打开内部设置页。</p><label class="field">Edge 设置地址<input id="guide-edge" readonly value="edge://settings/system"></label><button data-action="copy-guide" data-guide="guide-edge">复制 Edge 设置地址</button><ol class="guide-steps"><li>打开「设置 → 系统和性能 → 性能」。</li><li>找到「始终保持这些网站处于活动状态」（旧版可能叫「从不将这些站点置于睡眠状态」），点击添加。</li><li>添加下方的本站地址，使本站排除标签休眠和节能限制。</li></ol><label class="field">本站地址<input id="guide-site" readonly value="${esc(ORIGIN)}"></label><button data-action="copy-guide" data-guide="guide-site">复制本站地址</button><p class="help"><a class="guide-link" href="https://support.microsoft.com/en-us/edge/learn-about-performance-features-in-microsoft-edge" target="_blank" rel="noopener noreferrer">微软 Edge 设置说明</a> · 其他浏览器请查找对应的「内存节省 / 节能」网站例外。</p><label class="field guide-check"><input type="checkbox" data-environment-check="edge" ${acknowledged.edge ? 'checked' : ''}>我已手动将本站加入活动网站列表</label><div class="muted">${acknowledged.edge ? '用户确认：' + esc(fmt(acknowledged.edge)) + '（非自动验证）' : '尚未由用户确认；脚本无法验证此设置'}</div></article>
      <article class="card"><h3>2. 设置电脑保持运行</h3><ol class="guide-steps"><li>Windows 11：打开「设置 → 系统 → 电源和电池 / 电源 → 屏幕、睡眠和休眠超时」。Windows 10：打开「设置 → 系统 → 电源和睡眠」。</li><li>将运行任务期间使用的供电模式下「使设备进入睡眠状态」设为「从不」；如提供自动休眠选项，也需检查。</li><li>保持浏览器和目标标签页打开，保持网络连接。锁屏后也要确保电脑没有进入睡眠；笔记本合盖可能会进入睡眠。</li></ol><p class="help"><a class="guide-link" href="https://support.microsoft.com/en-us/windows/experience/power-battery/power-settings-in-windows-11" target="_blank" rel="noopener noreferrer">微软 Windows 电源设置说明</a></p><label class="field guide-check"><input type="checkbox" data-environment-check="system" ${acknowledged.system ? 'checked' : ''}>我已手动检查自动睡眠和休眠设置</label><div class="muted">${acknowledged.system ? '用户确认：' + esc(fmt(acknowledged.system)) + '（非自动验证）' : '尚未由用户确认；脚本无法验证此设置'}</div><p class="help">勾选只记录你的确认，不能证明电脑会一直保持运行。更改设置后可取消勾选。</p></article>
      <article class="card"><h3>3. 做一次后台实测</h3><p class="help">完成设置后，点击上方「重新开始观察」，将浏览器最小化或锁屏至少 10 分钟，再回到本页检查最长调度间隔和延迟记录。观察不会额外点击网页；已启用的任务仍照常运行。测试期间避免刷新或页面跳转，否则观察重新开始。</p><p class="help">一次测试未出现延迟，也不能保证以后准时执行。浏览器和系统仍可能限制后台运行；恢复后的补执行无法挽回已经过期的登录状态。</p></article>`;
  }
  async function copyGuide(button) {
    const field = ['guide-edge', 'guide-site'].includes(button.dataset.guide) && $('#' + button.dataset.guide);
    if (!field) return;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(field.value); notice('已复制，请粘贴到浏览器地址栏');
    } catch {
      field.focus(); field.select(); notice('自动复制不可用，已选中地址，请按 Ctrl+C 复制');
    }
  }
  function renderBar() {
    const bar = $('#bar');
    bar.hidden = !session.recording && !picking;
    if (picking) bar.innerHTML = `<div>点选${picking.type === 'collect' ? '要读取的值' : '按钮或链接'} · Esc 取消</div><button data-action="cancel-pick">取消选择</button>`;
    else if (session.recording) bar.innerHTML = `<div class="row wrap"><span>● 录制中 · ${session.draft.steps.length} 步</span><button data-action="pick-value">采集值</button><button data-action="add-wait">添加等待</button><button data-action="stop-record">完成录制</button></div>`;
  }
  function render() {
    renderBar();
    const panel = $('#panel');
    panel.hidden = !session.open || !!picking || !!session.recording;
    $('#launcher').hidden = !!session.open && !picking && !session.recording;
    if (panel.hidden) return;
    const state = db();
    panel.innerHTML = `<header><div class="row between"><span class="brand">网页定时助手 <small class="muted">v${Core.VERSION}</small></span><button data-action="close" aria-label="收起">收起</button></div><div class="muted">${esc(ORIGIN)}</div><div class="status" id="status">${esc(statusText())}</div><nav class="tabs">${[['tasks','任务'],['data','采集历史'],['logs','日志'],['environment','运行环境']].map(([id, label]) => `<button data-action="view" data-view="${id}" class="${currentView === id ? 'active' : ''}">${label}</button>`).join('')}</nav><div id="environment-warning" class="environment-warning" hidden><div id="environment-warning-text"></div><button data-action="view" data-view="environment">查看设置指引</button></div></header><main>${currentView === 'editor' ? editorHTML() : currentView === 'data' ? dataHTML(state) : currentView === 'logs' ? logsHTML(state) : currentView === 'environment' ? environmentHTML(state) : tasksHTML(state)}</main><footer>仅在打开的网页中运行 · 计划使用电脑本地时间 · 采集历史最多保留 ${MAX_SAMPLES} 条</footer>`;
    updateEnvironmentUI();
  }
  function openAssistant() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    session.open = true; currentView = session.draft ? 'editor' : 'tasks';
    render();
    try { persist(); } catch (error) { notice(error.message); }
  }
  function tasksHTML(state) {
    return `<div class="row wrap"><button class="primary" data-action="new-keep">＋ 保活任务</button><button data-action="new-collect">＋ 采集任务</button><button data-action="toggle-site">${state.enabled ? '暂停本站' : '启用本站'}</button></div><div class="row wrap" style="margin-top:8px"><button data-action="export-config">导出配置</button><button data-action="import-config">导入配置</button>${session.run ? '<button class="danger" data-action="cancel-run">停止执行</button>' : ''}</div><p class="help">选择元素后设置间隔；采集任务可以录制操作，并在任意步骤添加多个值。</p>${state.tasks.length ? state.tasks.map(task => `<article class="card"><div class="row between"><h3>${esc(task.name)}</h3><span class="badge">${task.kind === 'keep' ? '保活' : '采集'} · ${task.enabled ? '启用' : '暂停'}</span></div><div class="muted">${esc(scheduleDescription(task))} · ${task.steps.length} 步</div><div class="muted">下次：${task.enabled ? esc(fmt(task.nextRun)) : '—'}</div><div class="muted">上次：${esc(task.lastMessage || '尚未执行')} ${task.lastRun ? ' · ' + esc(fmt(task.lastRun)) : ''}</div><div class="row wrap actions"><button data-action="run-task" data-id="${esc(task.id)}">立即执行</button><button data-action="edit-task" data-id="${esc(task.id)}">编辑</button><button data-action="toggle-task" data-id="${esc(task.id)}">${task.enabled ? '暂停' : '启用'}</button><button class="danger" data-action="delete-task" data-id="${esc(task.id)}">删除</button></div></article>`).join('') : '<div class="empty">还没有任务<br>先添加一个保活或采集任务</div>'}`;
  }
  function dataHTML(state) {
    const list = state.samples.slice(-100).reverse();
    return `<div class="row between"><span class="muted">共 ${state.samples.length} 条，显示最近 100 条</span><button data-action="export-csv">导出全部 CSV</button></div>${list.length ? '<table><thead><tr><th>采集值 / 任务</th><th>值</th><th>时间</th></tr></thead><tbody>' + list.map(s => `<tr><td>${esc(s.name)}<div class="muted">${esc(s.taskName)}</div></td><td class="value">${esc(s.value)}<details><summary class="muted">原始内容</summary>${esc(s.raw)}</details></td><td>${esc(fmt(s.time))}</td></tr>`).join('') + '</tbody></table>' : '<div class="empty">采集结果会显示在这里</div>'}`;
  }
  function logsHTML(state) { return `<div class="muted">最近 200 条运行日志</div>${state.logs.length ? state.logs.map(l => `<div class="log ${l.level === 'error' ? 'error' : l.level === 'warning' ? 'warning' : ''}"><div class="muted">${esc(fmt(l.time))}</div>${esc(l.message)}</div>`).join('') : '<div class="empty">暂无日志</div>'}`; }
  function selected(value, option) { return value === option ? 'selected' : ''; }
  function editorHTML() {
    const d = session.draft;
    if (!d) { currentView = 'tasks'; return tasksHTML(db()); }
    return `<div class="row between"><strong>${d.kind === 'keep' ? '保活任务' : '采集任务'}</strong><button data-action="discard-draft">返回任务列表</button></div><p class="help">草稿随同站页面跳转保存，点「保存任务」后才生效。</p>
      <label class="field">任务名称<input data-field="name" value="${esc(d.name)}" maxlength="120"></label>
      <label class="field">任务起始地址<input data-field="entryUrl" value="${esc(d.entryUrl)}"></label>
      <div class="grid"><label class="field">计划<select data-field="scheduleType"><option value="interval" ${selected(d.scheduleType,'interval')}>按间隔</option><option value="daily" ${selected(d.scheduleType,'daily')}>每天固定时间</option></select></label><label class="field">每日时间<input type="time" data-field="dailyTime" value="${esc(d.dailyTime)}" ${d.scheduleType !== 'daily' ? 'disabled' : ''}></label></div>
      <div class="grid" style="margin-top:10px"><label class="field">执行间隔<input type="number" min="0.001" step="any" data-field="interval" value="${esc(d.interval)}" ${d.scheduleType !== 'interval' ? 'disabled' : ''}></label><label class="field">间隔单位<select data-field="unit" ${d.scheduleType !== 'interval' ? 'disabled' : ''}>${[['1000','秒'],['60000','分钟'],['3600000','小时'],['86400000','天']].map(([v,l]) => `<option value="${v}" ${selected(String(d.unit),v)}>${l}</option>`).join('')}</select></label></div>
      <div class="grid" style="margin-top:10px"><label class="field">操作后返回<select data-field="returnMode">${[['history','历史后退（含地址兜底）'],['url','打开执行前地址'],['none','不返回']].map(([v,l]) => `<option value="${v}" ${selected(d.returnMode,v)}>${l}</option>`).join('')}</select></label><label class="field">返回前等待（秒）<input type="number" min="0" step="any" data-field="returnDelay" value="${esc(d.returnDelay)}"></label></div>
      <label class="field" style="margin-top:10px">找不到元素时等待（秒）<input type="number" min="1" max="300" data-field="timeout" value="${esc(d.timeout)}"></label>
      <label class="field"><input type="checkbox" data-field="enabled" ${d.enabled ? 'checked' : ''}> 保存后启用这条任务</label>
      <div class="section">操作步骤</div><div class="row wrap"><button data-action="pick-click">点选点击元素</button>${d.kind === 'collect' ? '<button data-action="pick-value">添加采集值</button><button data-action="start-record">录制操作</button>' : ''}<button data-action="add-wait">添加等待</button></div><p class="help">录制点击和输入，跳转仅限同站。每步可以设置执行前等待；纯等待步骤不需要选元素。</p>
      <div>${d.steps.map((step, i) => stepHTML(step, i)).join('') || '<div class="empty">请点选元素或开始录制</div>'}</div>
      <div class="row wrap" style="margin-top:14px"><button class="primary" data-action="save-task">保存任务</button><button data-action="preview-draft">试运行草稿</button></div>`;
  }
  function stepHTML(step, i) {
    const type = { click: '点击', input: '输入', wait: '等待', collect: '采集值' }[step.type];
    const inspection = inspectionResults.get(session.draft.id + ':' + (step.id || i));
    return `<div class="step" style="margin-top:10px"><div class="step-head"><strong>${i+1}. ${type}${step.target && step.target.text ? ' · ' + esc(step.target.text.slice(0,32)) : ''}</strong><button data-action="step-up" data-index="${i}" title="上移">↑</button><button data-action="step-down" data-index="${i}" title="下移">↓</button><button class="danger" data-action="step-delete" data-index="${i}" title="删除">×</button></div>
      <label class="field">${step.type === 'wait' ? '等待时长' : '执行前等待'}（秒）<input type="number" min="0" step="any" data-step="${i}" data-step-field="delayMs" value="${step.delayMs/1000}"></label>
      ${step.type !== 'wait' ? `<label class="field">元素 CSS 选择器<input class="selector" data-step="${i}" data-step-field="selector" value="${esc(step.target.selectors.join(' >>> '))}"></label><label class="field">执行页面（可选，忽略查询参数）<input class="selector" data-step="${i}" data-step-field="pageUrl" value="${esc(step.pageUrl || '')}"></label><div class="row wrap"><button data-action="repick" data-index="${i}">重新选择元素</button><button data-action="inspect-step" data-index="${i}">检查定位</button></div>${inspection ? `<label class="field" style="margin-top:8px">定位诊断（可复制）<textarea readonly rows="5" data-inspection="${i}">${esc(inspection)}</textarea></label>` : ''}` : ''}
      ${step.type === 'click' && Core.optionSelector(step.target) ? `<label class="field" style="margin-top:8px">下拉选项文字（完整匹配）<input data-step="${i}" data-step-field="optionText" value="${esc(Core.optionText(step.target))}" placeholder="例如 甘肃"></label><p class="help">按已打开菜单中的可见选项文字匹配，不使用 active / selected 状态。前一步须打开对应下拉框。</p>` : ''}
      ${step.type === 'input' ? `<label class="field" style="margin-top:8px">录制的输入值<input data-step="${i}" data-step-field="value" value="${esc(Array.isArray(step.value) ? JSON.stringify(step.value) : step.value)}"></label>` : ''}
      ${step.type === 'collect' ? `<label class="field" style="margin-top:8px">值名称<input data-step="${i}" data-step-field="name" value="${esc(step.name)}"></label><label class="field">读取方式<select data-step="${i}" data-step-field="source">${[['auto','自动（输入框的值 / 其他元素的文本）'],['text','文本内容'],['value','表单值'],['attribute','指定属性']].map(([v,l]) => `<option value="${v}" ${selected(step.source,v)}>${l}</option>`).join('')}</select></label><label class="field">属性名（指定属性时填写）<input data-step="${i}" data-step-field="attribute" value="${esc(step.attribute || '')}" placeholder="例如 data-count、title"></label><label class="field">正则提取规则（可选）<input data-step="${i}" data-step-field="pattern" value="${esc(step.pattern || '')}" placeholder="例如 ([0-9,]+)，留空获取完整值"></label>` : ''}
    </div>`;
  }

  function newDraft(kind) {
    if (session.run) throw new Error('请先停止当前执行，再创建任务');
    session.draft = { id: uid(), kind, name: kind === 'keep' ? '网站保活' : '每日激活量', entryUrl: location.href, scheduleType: kind === 'keep' ? 'interval' : 'daily', interval: 5, unit: 60000, dailyTime: '09:00', returnMode: 'history', returnDelay: kind === 'keep' ? 3 : 0, timeout: 15, enabled: true, steps: [] };
    currentView = 'editor'; session.open = true; persist(); render();
  }
  function draftFromTask(task) {
    return { ...clone(task), scheduleType: task.schedule.type, interval: task.schedule.everyMs ? task.schedule.everyMs / 60000 : 5, unit: 60000, dailyTime: task.schedule.time || '09:00', returnDelay: task.returnDelayMs/1000, timeout: task.timeoutMs/1000 };
  }
  function taskFromDraft() {
    const d = session.draft;
    const task = { id: d.id, name: d.name.trim(), kind: d.kind, enabled: !!d.enabled, entryUrl: new URL(d.entryUrl, ORIGIN).href, schedule: d.scheduleType === 'daily' ? { type: 'daily', time: d.dailyTime } : { type: 'interval', everyMs: Number(d.interval) * Number(d.unit) }, returnMode: d.returnMode, returnDelayMs: Number(d.returnDelay)*1000, timeoutMs: Number(d.timeout)*1000, steps: clone(d.steps) };
    Core.validateTask(task, ORIGIN, selector => document.createDocumentFragment().querySelector(selector));
    task.nextRun = Core.nextRun(task.schedule);
    return task;
  }
  function saveTask() {
    const task = taskFromDraft();
    updateDB(state => { const i = state.tasks.findIndex(t => t.id === task.id); if (i < 0) state.tasks.push(task); else state.tasks[i] = { ...state.tasks[i], ...task }; });
    delete session.draft; session.recording = false; persist(); currentView = 'tasks'; render(); notice(db().enabled ? '任务已保存' : '任务已保存；点击「启用本站」开始自动执行');
  }

  // 对开放的 Shadow DOM 使用逐层选择器，避免页面自己的样式影响面板。
  const normalizeText = element => Core.normalizeLabel(element.textContent);
  const optionLabel = element => normalizeText(element.querySelector('.ant-select-item-option-content') || element);
  function optionPool(element) {
    if (element.matches('.ant-select-dropdown-menu-item')) return '.ant-select-dropdown-menu-item';
    if (element.matches('.ant-select-item-option')) return '.ant-select-item-option';
    if (element.matches('.el-select-dropdown__item')) return '.el-select-dropdown__item';
    return '[role="option"]';
  }
  function selectorFor(element, scope) {
    const tag = element.localName;
    const unique = selector => { try { const matches = scope.querySelectorAll(selector); return matches.length === 1 && matches[0] === element; } catch { return false; } };
    const quote = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, ' ') + '"';
    for (const attr of ['data-testid','data-test','data-qa','name','aria-label']) {
      const value = element.getAttribute(attr);
      if (value) { const selector = tag + '[' + attr + '=' + quote(value) + ']'; if (unique(selector)) return selector; }
    }
    if (element.id && !Core.isDynamicId(element.id) && unique('#' + CSS.escape(element.id))) return '#' + CSS.escape(element.id);
    const classes = Array.from(element.classList).filter(c => !Core.isTransientClass(c) && !/\d{3}|^(css-|is-)/.test(c)).slice(0, 3);
    if (classes.length) { const selector = tag + classes.map(c => '.' + CSS.escape(c)).join(''); if (unique(selector)) return selector; }
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1) {
      let part = current.localName;
      if (current.id && !Core.isDynamicId(current.id)) part = '#' + CSS.escape(current.id);
      else {
        const parent = current.parentElement;
        if (parent) { const peers = Array.from(parent.children).filter(c => c.localName === current.localName); if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(current) + 1) + ')'; }
      }
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (unique(selector)) return selector;
      current = current.parentElement;
    }
    throw new Error('无法生成唯一选择器，请选择其他元素');
  }
  function targetFor(element) {
    const selectors = [];
    const option = element.matches(OPTION_SELECTOR);
    let current = element;
    while (current) {
      const scope = current.getRootNode();
      selectors.unshift(option && current === element ? optionPool(element) : selectorFor(current, scope));
      if (scope instanceof ShadowRoot) current = scope.host; else break;
    }
    const target = { selectors, text: normalizeText(element).slice(0,100), tag: element.localName };
    if (option) target.option = { text: optionLabel(element) };
    return target;
  }
  function visible(element) {
    if (!element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }
  function disabled(element) {
    return !!element && (element.disabled || element.getAttribute('aria-disabled') === 'true' || element.matches('.ant-select-dropdown-menu-item-disabled,.ant-select-item-option-disabled,.el-select-dropdown__item.is-disabled'));
  }
  function inspectTarget(target, type) {
    let scope = document;
    const action = type === 'click' || type === 'input';
    const counts = [];
    const fail = error => ({ element: null, error, counts });
    for (let i = 0; i < target.selectors.length; i++) {
      if (i === target.selectors.length - 1 && type === 'click') {
        const selector = Core.optionSelector(target);
        if (selector) {
          const text = Core.optionText(target);
          if (!text) return fail('下拉步骤没有填写选项文字');
          const all = Array.from(scope.querySelectorAll(selector));
          const displayed = all.filter(visible);
          const options = displayed.filter(element => optionLabel(element) === text);
          counts.push(`选项选择器：${selector}；全部 ${all.length}，可见 ${displayed.length}，文字「${text}」匹配 ${options.length}`);
          if (!options.length) return fail('未找到可见的下拉选项「' + text + '」；请确认前一步已打开正确的下拉框');
          if (options.length > 1) return fail('可见的下拉选项「' + text + '」匹配 ' + options.length + ' 个，不能唯一定位');
          if (disabled(options[0])) return fail('下拉选项「' + text + '」被禁用');
          return { element: options[0], error: '', counts };
        }
      }
      const selector = target.selectors[i];
      const matches = Array.from(scope.querySelectorAll(selector));
      const displayed = matches.filter(visible);
      const leaf = i === target.selectors.length - 1;
      counts.push(`第 ${i+1} 层选择器：${selector}；全部 ${matches.length}，可见 ${displayed.length}`);
      if (!matches.length) return fail('选择器匹配 0 个元素：' + selector);
      // 数据读取仍要求整体唯一；点击和输入排除隐藏副本。
      const candidates = action && (leaf || matches.length > 1) ? displayed : matches;
      if (!candidates.length) return fail('选择器匹配 ' + matches.length + ' 个元素，但全部隐藏：' + selector);
      if (candidates.length > 1) return fail('选择器匹配 ' + candidates.length + (action ? ' 个可见元素' : ' 个元素') + '，不能唯一定位：' + selector);
      const element = candidates[0];
      if (leaf) {
        if (action && disabled(element)) return fail('元素被禁用：' + selector);
        return { element, error: '', counts };
      }
      scope = element.shadowRoot;
      if (!scope) return fail('第 ' + (i+1) + ' 层元素没有开放的 Shadow DOM：' + selector);
    }
    return fail('没有元素选择器');
  }
  function inspectionText(step, inspection) {
    const page = location.origin + location.pathname + location.hash;
    return `脚本版本：${Core.VERSION}\n检查时间：${fmt(Date.now())}\n步骤类型：${step.type}\n当前页面：${page}\n` + inspection.counts.join('\n') + '\n结果：' + (inspection.error || '已定位，可执行') + (step.pageUrl && !Core.sameRoute(step.pageUrl, location.href, ORIGIN) ? '\n当前页面与此步骤的执行页面不同，请先进入对应页面。' : '');
  }
  function pageElement(event) { return event.composedPath().find(item => item instanceof Element); }
  function isOwnEvent(event) { return event.composedPath().includes(host); }
  function clickable(element) {
    return element.closest(OPTION_SELECTOR) || element.closest('button,a,input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"],[role="button"],[role="tab"],summary,label') || element.closest(COMBO_SELECTOR) || element;
  }
  function recordingDelay() { const now = Date.now(); const delay = Math.min(60000, Math.max(250, now - (session.lastRecord || now))); session.lastRecord = now; return delay; }
  function startPick(type, index = null) {
    if (!session.draft) throw new Error('请先创建任务');
    picking = { type, index }; render();
  }
  function cancelPick() { picking = null; $('#outline').hidden = true; render(); }
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
    document.addEventListener(type, event => {
      if (picking && !isOwnEvent(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
  }
  document.addEventListener('pointermove', event => {
    if (!picking || isOwnEvent(event)) { $('#outline').hidden = true; return; }
    let element = pageElement(event);
    if (!element) return;
    if (picking.type === 'click') element = clickable(element);
    const rect = element.getBoundingClientRect();
    const outline = $('#outline'); outline.hidden = false;
    outline.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
  }, true);
  document.addEventListener('keydown', event => { if (picking && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancelPick(); } }, true);
  document.addEventListener('click', event => {
    if (isOwnEvent(event)) return;
    if (!picking && !session.recording) return;
    let element = pageElement(event);
    if (!element) return;
    if (picking) {
      event.preventDefault(); event.stopImmediatePropagation();
      const { type, index } = picking;
      try {
        if (type === 'click') element = clickable(element);
        if (element.matches('input[type="password"],input[type="file"]')) throw new Error('不能选择密码或文件输入框');
        const target = targetFor(element);
        if (index !== null) { clearInspection(index); session.draft.steps[index].target = target; session.draft.steps[index].pageUrl = location.href; }
        else {
          const step = { id: uid(), type, target, pageUrl: location.href, delayMs: session.recording ? recordingDelay() : 500 };
          if (type === 'collect') Object.assign(step, { name: '数值 ' + (session.draft.steps.filter(s => s.type === 'collect').length+1), source: 'auto', attribute: '', pattern: '' });
          session.draft.steps.push(step);
        }
        persist(); cancelPick();
        if (!session.recording) { session.open = true; currentView = 'editor'; persist(); render(); }
        notice(type === 'collect' ? '已添加采集值，可修改名称和读取方式' : '已选择点击元素');
      } catch (error) { notice(error.message); }
      return;
    }
    // 普通表单聚焦点击由输入步骤覆盖；复选框和单选框按最终状态回放。
    element = clickable(element);
    if (element.matches('input,textarea,select,[contenteditable]') && !element.closest(COMBO_SELECTOR)) return;
    try {
      checkClickDestination(element);
      session.draft.steps.push({ id: uid(), type: 'click', target: targetFor(element), pageUrl: location.href, delayMs: recordingDelay() });
      persist(); renderBar();
    } catch (error) { event.preventDefault(); event.stopImmediatePropagation(); notice(error.message); }
  }, true);
  function inputValue(element) {
    if (element.matches('input[type="checkbox"],input[type="radio"]')) return element.checked;
    if (element instanceof HTMLSelectElement && element.multiple) return Array.from(element.selectedOptions, o => o.value);
    return element.isContentEditable ? element.textContent : element.value;
  }
  function recordInput(event) {
    if (!session.recording || picking || isOwnEvent(event)) return;
    const element = pageElement(event);
    if (!element || !element.matches('input,textarea,select,[contenteditable]')) return;
    if (element.matches('input[type="password"],input[type="file"],input[type="hidden"]')) return;
    try {
      const target = targetFor(element);
      const value = inputValue(element);
      if (event.type === 'change') {
        // 部分浏览器在另一个字段已经修改后，才发出旧字段的 blur/change。
        // 已被 input 捕获且值没变的 change 不能再追加一遍。
        const previous = session.draft.steps.findLast(s => s.type === 'input' && JSON.stringify(s.target.selectors) === JSON.stringify(target.selectors));
        if (previous && JSON.stringify(previous.value) === JSON.stringify(value)) return;
      }
      const last = session.draft.steps.at(-1);
      if (last && last.type === 'input' && JSON.stringify(last.target.selectors) === JSON.stringify(target.selectors)) { last.value = value; session.lastRecord = Date.now(); }
      else session.draft.steps.push({ id: uid(), type: 'input', target, value, pageUrl: location.href, delayMs: recordingDelay() });
      persist(); renderBar();
    } catch (error) { notice(error.message); }
  }
  document.addEventListener('input', recordInput, true);
  document.addEventListener('change', recordInput, true);

  function checkClickDestination(element) {
    const link = element.closest('a[href]');
    if (link) {
      if (link.hasAttribute('download')) throw new Error('不支持自动点击下载链接');
      // javascript: 空链接常被页面用作按钮，由页面原有的点击处理器执行。
      if (link.protocol !== 'javascript:' && !Core.sameOrigin(link.href, ORIGIN)) throw new Error('仅支持当前网站内的链接');
    }
    const form = element.closest('form');
    const submits = element.matches('button:not([type="button"]):not([type="reset"]),input[type="submit"],input[type="image"]');
    const action = element.hasAttribute('formaction') ? element.formAction : form && form.action;
    if (form && submits && !Core.sameOrigin(action || location.href, ORIGIN)) throw new Error('不支持跨站表单提交');
  }
  function clickElement(element) {
    checkClickDestination(element);
    const link = element.closest('a[href]');
    const form = element.closest('form');
    const destination = link || form;
    const oldTarget = destination && destination.getAttribute('target');
    const oldFormTarget = element.getAttribute('formtarget');
    if (destination) destination.setAttribute('target', '_self');
    if (oldFormTarget !== null) element.setAttribute('formtarget', '_self');
    try {
      if (element.matches(OPTION_SELECTOR) || element.closest(COMBO_SELECTOR)) {
        // 自定义下拉框可能在 mousedown 打开，不能只调用 click()。
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = element.getBoundingClientRect();
        const common = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 };
        if (typeof PointerEvent === 'function') element.dispatchEvent(new PointerEvent('pointerdown', { ...common, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        const focusAllowed = element.dispatchEvent(new MouseEvent('mousedown', { ...common, buttons: 1 }));
        if (focusAllowed && !element.matches(OPTION_SELECTOR)) {
          const focusTarget = element.matches('input,[tabindex]') ? element : element.querySelector('input,[tabindex]');
          if (focusTarget) focusTarget.focus({ preventScroll: true });
        }
        if (!element.isConnected) return;
        if (typeof PointerEvent === 'function') element.dispatchEvent(new PointerEvent('pointerup', { ...common, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
      }
      element.click();
    }
    finally {
      if (destination) { if (oldTarget === null) destination.removeAttribute('target'); else destination.setAttribute('target', oldTarget); }
      if (oldFormTarget !== null) element.setAttribute('formtarget', oldFormTarget);
    }
  }
  function fillElement(element, value) {
    if (element.matches('input[type="password"],input[type="file"],input[type="hidden"]')) throw new Error('不回放密码、文件或隐藏字段');
    if (element.matches('input[type="checkbox"],input[type="radio"]')) {
      if (typeof value !== 'boolean') throw new Error('复选框或单选框的值应为 true / false');
      if (element.checked !== value) element.click();
      return;
    }
    if (element.isContentEditable) element.textContent = String(value);
    else if (element instanceof HTMLSelectElement && element.multiple && Array.isArray(value)) { for (const option of element.options) option.selected = value.includes(option.value); }
    else {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(element, String(value));
    }
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  function readElement(element, step) {
    if (element.matches('input[type="password"],input[type="file"]')) throw new Error('不能采集密码或文件输入框');
    let raw;
    if (step.source === 'attribute') { raw = element.getAttribute(step.attribute); if (raw === null) throw new Error('元素没有属性：' + step.attribute); }
    else if (step.source === 'text') raw = element.textContent;
    else if (step.source === 'value' || element.matches('input,textarea,select')) {
      if (!('value' in element)) throw new Error('选中的元素没有表单值');
      raw = inputValue(element);
      if (Array.isArray(raw)) raw = raw.join(', ');
    } else raw = element.textContent;
    raw = String(raw == null ? '' : raw).trim();
    return { raw, value: Core.extract(raw, step.pattern) };
  }

  async function claimOwner(force = false) {
    const owner = GM_getValue(OWNER_KEY, '');
    if (owner === tabId) return true;
    if (!force && owner) {
      if (Date.now() - lastOwnerCheck < 10000) return false;
      lastOwnerCheck = Date.now();
      const tabs = await new Promise(resolve => GM_getTabs(resolve));
      if (Object.values(tabs).some(tab => tab.webKeeperId === owner && tab.webKeeperOrigin === ORIGIN)) return false;
    }
    // 随机错开新标签的接管，写入后再核对，后续每一步也核对归属。
    await new Promise(resolve => setTimeout(resolve, 80 + Math.random()*170));
    if (!force && GM_getValue(OWNER_KEY, '') !== owner) return false;
    GM_setValue(OWNER_KEY, tabId);
    await new Promise(resolve => setTimeout(resolve, 160));
    return GM_getValue(OWNER_KEY, '') === tabId;
  }
  async function beginRun(task, manual = false, preview = false) {
    if (startingRun) throw new Error('任务正在启动，请稍候');
    if (session.recording || picking) throw new Error('请先完成录制或元素选择');
    if (session.run) throw new Error('已有任务正在执行，请等待或停止执行');
    if (!storageOK) throw new Error('会话存储不可用，不能执行跨页面任务');
    Core.validateTask(task, ORIGIN, selector => document.createDocumentFragment().querySelector(selector));
    startingRun = true;
    try {
    if (!(await claimOwner(manual))) throw new Error('任务由另一个标签页执行');
    if (session.run || session.recording || picking || (!manual && !db().enabled)) throw new Error('任务启动已取消');
    const now = Date.now();
    const totalWait = task.steps.reduce((sum, step) => sum + step.delayMs + task.timeoutMs, 0);
    session.run = { id: uid(), ownerId: tabId, task: clone(task), taskId: task.id, manual, preview, homeUrl: location.href, homeLength: history.length, started: now, expires: now + totalWait + task.returnDelayMs + 120000, phase: 'entry', index: 0, readyAt: now };
    persist();
    if (!preview) updateDB(state => { const current = state.tasks.find(t => t.id === task.id); if (current) { current.nextRun = Core.nextRun(current.schedule, now); current.lastMessage = '执行中'; } });
    log('开始' + (preview ? '试运行：' : '执行：') + task.name); refreshSoon();
    } finally { startingRun = false; }
  }
  function finishRun(error = '') {
    const run = session.run;
    if (!run) return;
    const message = error || run.error || '';
    if (!run.preview) updateDB(state => {
      const task = state.tasks.find(t => t.id === run.taskId);
      if (task) { task.lastRun = Date.now(); task.lastMessage = message ? '失败：' + message : '成功'; task.nextRun = Core.nextRun(task.schedule); }
    });
    delete session.run; persist();
    log(run.task.name + (message ? ' · 失败：' + message : ' · 执行完成'), message ? 'error' : 'info');
    notice(message ? '执行失败：' + message : run.task.name + '：执行完成'); refreshSoon();
  }
  function failRun(message) {
    if (!session.run) return;
    const run = session.run;
    if (run.phase === 'return' || run.phase === 'returning' || run.task.returnMode === 'none') { finishRun(message); return; }
    run.error = message; run.phase = 'return'; run.readyAt = Date.now(); persist();
  }
  function advance(run) { run.index++; delete run.stepIndex; run.readyAt = Date.now(); persist(); }
  function executeStep(run, now) {
    const step = run.task.steps[run.index];
    if (!step) { run.phase = 'return'; run.readyAt = now + run.task.returnDelayMs; persist(); return; }
    if (run.stepIndex !== run.index) { run.stepIndex = run.index; run.readyAt = now + step.delayMs; run.elementDeadline = run.readyAt + run.task.timeoutMs; persist(); return; }
    if (now < run.readyAt) return;
    if (step.type === 'wait') { advance(run); return; }
    if (step.pageUrl) {
      if (!Core.sameRoute(step.pageUrl, location.href, ORIGIN)) {
        if (now >= run.elementDeadline) throw new Error('第 ' + (run.index+1) + ' 步：尚未进入录制时的页面');
        return;
      }
    }
    const inspection = inspectTarget(step.target, step.type);
    const element = inspection.element;
    if (!element) {
      if (now >= run.elementDeadline) {
        const report = inspectionText(step, inspection);
        log('第 ' + (run.index+1) + ' 步定位诊断\n' + report, 'error');
        throw new Error('第 ' + (run.index+1) + ' 步：' + inspection.error);
      }
      return;
    }
    if (step.type === 'collect') {
      const { raw, value } = readElement(element, step);
      const sample = { id: run.id + ':' + run.index, taskId: run.taskId, taskName: run.task.name, metricId: step.id, name: step.name, time: now, value, raw, url: location.href };
      updateDB(state => { if (!state.samples.some(s => s.id === sample.id)) state.samples.push(sample); state.samples = state.samples.slice(-MAX_SAMPLES); });
      advance(run); refreshSoon();
    } else {
      // 点击可能马上卸载页面，先持久化下一步，防止跳转后再次点击。
      advance(run);
      if (step.type === 'click') clickElement(element); else fillElement(element, step.value);
    }
  }
  function returnHome(run, now) {
    if (now < run.readyAt) return;
    if (run.task.returnMode === 'none') { finishRun(); return; }
    if (run.phase === 'return') {
      const delta = history.length - run.homeLength;
      if (location.href === run.homeUrl && delta <= 0) { finishRun(); return; }
      run.phase = 'returning'; run.returnStarted = now; persist();
      if (run.task.returnMode === 'history' && delta > 0 && delta < 100) history.go(-delta);
      else { run.returnFallback = true; persist(); location.assign(run.homeUrl); }
      return;
    }
    if (location.href === run.homeUrl) { finishRun(); return; }
    if (!run.returnFallback && now - run.returnStarted > 4000) { run.returnFallback = true; run.returnStarted = now; persist(); location.assign(run.homeUrl); }
    else if (now - run.returnStarted > 30000) finishRun('返回原页面超时');
  }
  async function tick() {
    if (!tabId || busy || pageLeaving || session.recording || picking) return;
    busy = true;
    try {
      const state = db();
      const run = session.run;
      if (run) {
        if (GM_getValue(OWNER_KEY, '') !== tabId) { finishRun('执行标签已切换'); return; }
        if (!run.manual && !state.enabled) { finishRun('本站任务已暂停'); return; }
        const now = Date.now();
        if (now > run.expires) { finishRun('任务执行超时（页面可能已休眠）'); return; }
        if (run.phase === 'entry') {
          run.phase = 'arrival'; run.arrivalDeadline = now + 30000; run.readyAt = now + 500; persist();
          if (location.href !== run.task.entryUrl) location.assign(run.task.entryUrl);
        } else if (run.phase === 'arrival') {
          if (!Core.sameRoute(location.href, run.task.entryUrl, ORIGIN)) { if (now > run.arrivalDeadline) throw new Error('起始页地址不匹配，可能已跳转到登录页'); }
          else if (now >= run.readyAt) { run.phase = 'steps'; persist(); }
        } else if (run.phase === 'steps') executeStep(run, now);
        else returnHome(run, now);
      } else if (state.enabled && state.tasks.some(t => t.enabled && t.nextRun <= Date.now())) {
        if (!(await claimOwner())) return;
        const fresh = db();
        if (!fresh.enabled) return;
        const task = fresh.tasks.filter(t => t.enabled && t.nextRun <= Date.now()).sort((a,b) => a.nextRun-b.nextRun)[0];
        if (task) await beginRun(task);
      }
    } catch (error) { if (session.run) failRun(error.message); else log(error.message, 'error'); }
    finally { busy = false; const status = $('#status'); if (status) status.textContent = statusText(); }
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a'); link.href = url; link.download = filename; document.documentElement.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function importConfig() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      try {
        if (!input.files[0]) return;
        if (input.files[0].size > 2000000) throw new Error('配置文件不能超过 2 MB');
        const data = JSON.parse(await input.files[0].text());
        if (data.version !== 1 || data.origin !== ORIGIN || !Array.isArray(data.tasks) || data.tasks.length > 100) throw new Error('配置版本或网站不匹配（最多 100 个任务）');
        for (const task of data.tasks) Core.validateTask(task, ORIGIN, selector => document.createDocumentFragment().querySelector(selector));
        if (new Set(data.tasks.map(t => t.id)).size !== data.tasks.length) throw new Error('配置中存在重复任务 ID');
        updateDB(state => { for (const task of data.tasks) { const clean = clone(task); clean.entryUrl = new URL(clean.entryUrl, ORIGIN).href; clean.nextRun = Core.nextRun(clean.schedule); clean.lastMessage = ''; delete clean.lastRun; const i = state.tasks.findIndex(t => t.id === clean.id); if (i >= 0) state.tasks[i] = clean; else state.tasks.push(clean); } });
        render(); notice('已导入 ' + data.tasks.length + ' 个任务');
      } catch (error) { notice('导入失败：' + error.message); }
    });
    input.click();
  }
  async function action(name, button) {
    const id = button.dataset.id;
    const index = Number(button.dataset.index);
    const task = id && db().tasks.find(t => t.id === id);
    switch (name) {
      case 'close': session.open = false; persist(); render(); break;
      case 'view': currentView = button.dataset.view; render(); break;
      case 'copy-guide': await copyGuide(button); break;
      case 'reset-environment':
        Object.assign(environment, { startedAt: Date.now(), lastBeatAt: Date.now(), maxGapMs: 0, delayCount: 0, lastDelayAt: 0, freezeCount: 0, lastResumeAt: 0 });
        render(); notice('已重新开始观察，请在后台运行一段时间后返回查看'); break;
      case 'new-keep': newDraft('keep'); break;
      case 'new-collect': newDraft('collect'); break;
      case 'toggle-site': {
        const enabled = !db().enabled;
        if (enabled && !session.recording) await claimOwner(true);
        updateDB(state => { state.enabled = enabled; });
        if (!enabled && session.run) finishRun('手动暂停');
        if (enabled && !(db().environmentAcknowledged?.edge && db().environmentAcknowledged?.system)) notice('已启用本站。请到「运行环境」查看并确认后台设置');
        render(); break;
      }
      case 'cancel-run': finishRun('手动停止'); break;
      case 'run-task': if (!task) throw new Error('任务不存在'); await beginRun(task, true); render(); break;
      case 'edit-task': if (session.run) throw new Error('请先停止当前执行'); if (task) { session.draft = draftFromTask(task); currentView = 'editor'; persist(); render(); } break;
      case 'toggle-task': updateDB(state => { const t = state.tasks.find(t => t.id === id); if (t) { t.enabled = !t.enabled; if (t.enabled) t.nextRun = Core.nextRun(t.schedule); } }); render(); break;
      case 'delete-task': if (session.run && session.run.taskId === id) throw new Error('请先停止这条任务'); if (confirm('删除任务「' + task.name + '」？采集历史会保留。')) { updateDB(state => { state.tasks = state.tasks.filter(t => t.id !== id); }); render(); } break;
      case 'save-task': saveTask(); break;
      case 'discard-draft': session.recording = false; currentView = 'tasks'; persist(); render(); break;
      case 'preview-draft': await beginRun(taskFromDraft(), true, true); currentView = 'tasks'; render(); break;
      case 'pick-click': startPick('click'); break;
      case 'pick-value': startPick('collect'); break;
      case 'cancel-pick': cancelPick(); break;
      case 'repick': startPick(session.draft.steps[index].type, index); break;
      case 'inspect-step': {
        const step = session.draft.steps[index];
        const inspection = inspectTarget(step.target, step.type);
        inspectionResults.set(session.draft.id + ':' + (step.id || index), inspectionText(step, inspection));
        render();
        const result = $(`[data-inspection="${index}"]`); if (result) result.scrollIntoView({ block: 'nearest' });
        if (inspection.element && visible(inspection.element)) {
          const rect = inspection.element.getBoundingClientRect(); const outline = $('#outline');
          outline.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`; outline.hidden = false;
          setTimeout(() => { if (!picking) outline.hidden = true; }, 2500);
        }
        break;
      }
      case 'start-record':
        if (session.run) throw new Error('请先停止当前执行');
        if (session.draft.steps.length && session.draft.entryUrl !== location.href) notice('继续录制：请确保当前页面与已有步骤的结束位置一致');
        if (!session.draft.steps.length) session.draft.entryUrl = location.href;
        session.recording = true; session.recordingTabId = tabId; session.lastRecord = Date.now(); persist(); render(); break;
      case 'stop-record': session.recording = false; session.open = true; currentView = 'editor'; persist(); render(); break;
      case 'add-wait': {
        const value = prompt('等待多少秒？', '3'); if (value === null) break;
        const seconds = Number(value);
        if (!value.trim() || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error('请输入 0 至 86400 秒');
        session.draft.steps.push({ id: uid(), type: 'wait', delayMs: seconds*1000 }); session.lastRecord = Date.now(); persist(); render(); break;
      }
      case 'step-delete': session.draft.steps.splice(index,1); persist(); render(); break;
      case 'step-up': if (index > 0) { [session.draft.steps[index-1], session.draft.steps[index]] = [session.draft.steps[index], session.draft.steps[index-1]]; persist(); render(); } break;
      case 'step-down': if (index < session.draft.steps.length-1) { [session.draft.steps[index+1], session.draft.steps[index]] = [session.draft.steps[index], session.draft.steps[index+1]]; persist(); render(); } break;
      case 'export-csv': download('采集历史-' + new Date().toISOString().slice(0,10) + '.csv', Core.toCSV(db().samples), 'text/csv;charset=utf-8'); break;
      case 'export-config': download('定时助手配置.json', JSON.stringify({ version: 1, origin: ORIGIN, tasks: db().tasks }, null, 2), 'application/json;charset=utf-8'); break;
      case 'import-config': importConfig(); break;
    }
  }
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.id === 'launcher') { openAssistant(); return; }
    if (!button.dataset.action) return;
    button.disabled = true;
    try { await action(button.dataset.action, button); } catch (error) { notice(error.message); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  function updateDraftInput(event) {
    const input = event.target;
    if (!session.draft) return;
    if (input.dataset.field) {
      session.draft[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
      persist(); if (input.dataset.field === 'scheduleType') render();
    } else if (input.dataset.stepField) {
      const step = session.draft.steps[Number(input.dataset.step)];
      clearInspection(Number(input.dataset.step));
      const field = input.dataset.stepField;
      if (field === 'selector') step.target.selectors = input.value.split(/\s*>>>\s*/);
      else if (field === 'optionText') {
        const last = step.target.selectors.length - 1;
        step.target.selectors[last] = Core.optionSelector(step.target);
        step.target.option = { text: input.value };
      }
      else if (field === 'delayMs') step.delayMs = Number(input.value)*1000;
      else if (field === 'value') {
        if (typeof step.value === 'boolean') step.value = input.value === 'true';
        else if (Array.isArray(step.value)) { try { const values = JSON.parse(input.value); if (Array.isArray(values)) step.value = values; } catch {} }
        else step.value = input.value;
      } else step[field] = input.value;
      persist();
    }
  }
  root.addEventListener('input', updateDraftInput);
  root.addEventListener('change', updateDraftInput);
  root.addEventListener('change', event => {
    const input = event.target;
    const key = input.dataset.environmentCheck;
    if (!['edge', 'system'].includes(key)) return;
    updateDB(state => { state.environmentAcknowledged = state.environmentAcknowledged || {}; if (input.checked) state.environmentAcknowledged[key] = Date.now(); else delete state.environmentAcknowledged[key]; });
  });
  window.addEventListener('pagehide', () => { pageLeaving = true; });
  window.addEventListener('pageshow', () => {
    pageLeaving = false;
    try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}'); } catch { session = {}; }
    if (session.draft) currentView = 'editor'; render();
    GM_getTab(tab => { tab.webKeeperOrigin = ORIGIN; GM_saveTab(tab); });
  });
  document.addEventListener('visibilitychange', () => { observeEnvironment(); if (!document.hidden) tick(); });
  document.addEventListener('freeze', () => { environment.freezeCount++; updateEnvironmentUI(); });
  document.addEventListener('resume', () => { environment.lastResumeAt = Date.now(); observeEnvironment(); tick(); });
  window.addEventListener('online', updateEnvironmentUI);
  window.addEventListener('offline', updateEnvironmentUI);
  GM_addValueChangeListener(DB_KEY, () => refreshSoon());
  GM_addValueChangeListener(OWNER_KEY, () => { const status = $('#status'); if (status) status.textContent = statusText(); });
  window.addEventListener('web-keeper:open', openAssistant);
  GM_registerMenuCommand('打开网页定时助手', openAssistant);
  GM_registerMenuCommand('运行环境与设置指引', () => { openAssistant(); currentView = 'environment'; render(); });
  GM_registerMenuCommand('暂停本站自动任务', () => { updateDB(state => { state.enabled = false; }); if (session.run) finishRun('手动暂停'); notice('本站任务已暂停'); render(); });
  GM_getTab(tab => {
    if (!tab.webKeeperId) tab.webKeeperId = uid();
    tab.webKeeperOrigin = ORIGIN; GM_saveTab(tab);
    tabId = tab.webKeeperId;
    // 浏览器复制标签页时可能复制 sessionStorage，执行进度不能跟着复制。
    if (session.run && session.run.ownerId !== tabId) delete session.run;
    if (session.recording && session.recordingTabId !== tabId) session.recording = false;
    if (session.draft) currentView = 'editor';
    try { persist(); } catch (error) { notice(error.message); }
    if (environment.wasDiscarded) log('运行环境：浏览器报告本页此前被丢弃，现已重新加载。请检查后台运行设置。', 'warning');
    render(); setInterval(() => { observeEnvironment(); tick(); }, 500); tick();
  });
})();
