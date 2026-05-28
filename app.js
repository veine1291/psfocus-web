/* =========================================================
   PS Focus Mobile — 完整版(任务/日历/统计/设置)
   ========================================================= */

// ===== 持久化日志系统 =====
// 用户反馈「上去就刷新一下然后崩溃 — Script error.」无法定位根因。
// Safari/Chrome 标签崩溃 → 控制台清空,Wi-Fi 调试又没法每次都接;
// 用 localStorage 写一个环形日志,崩溃后下次打开能看到上次崩前的最后 200 条事件 +
// 一并暴露在"加载失败"卡片里(有「复制」+「查看完整日志」按钮),用户能直接发给我看。
const _PSLOG_KEY = 'psfocus.boot.log.v1';
const _PSLOG_MAX = 300;
let _psLogBuf = [];
try {
  const raw = localStorage.getItem(_PSLOG_KEY);
  if (raw) _psLogBuf = JSON.parse(raw) || [];
  if (!Array.isArray(_psLogBuf)) _psLogBuf = [];
} catch (_) { _psLogBuf = []; }
let _psLogFlushTimer = null;
function _psLogFlush() {
  _psLogFlushTimer = null;
  try { localStorage.setItem(_PSLOG_KEY, JSON.stringify(_psLogBuf.slice(-_PSLOG_MAX))); } catch (_) {}
}
function psLog(level, ...args) {
  const t = new Date();
  const ts = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}.${t.getMilliseconds().toString().padStart(3,'0')}`;
  let msg = '';
  try {
    msg = args.map(a => {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'string') return a;
      if (a instanceof Error) return (a.stack || a.message || String(a));
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
  } catch (_) { msg = '[unstringifiable]'; }
  // 限单条长度,防一条巨长 stack 把环形 buf 撑爆 localStorage
  if (msg.length > 800) msg = msg.slice(0, 800) + '…[truncated]';
  _psLogBuf.push(`[${ts}] ${level} ${msg}`);
  if (_psLogBuf.length > _PSLOG_MAX) _psLogBuf.splice(0, _psLogBuf.length - _PSLOG_MAX);
  // 同步 console
  try {
    const fn = level === 'ERR' ? console.error : level === 'WARN' ? console.warn : console.log;
    fn.apply(console, ['[' + level + ']', ...args]);
  } catch (_) {}
  // 节流写 localStorage — 1s 内合并,避免高频写盘拖慢主线程
  if (!_psLogFlushTimer) _psLogFlushTimer = setTimeout(_psLogFlush, 1000);
  // 把日志快照同步注入 state,任何 pushState 都会顺路带上去,省掉单独的云调用
  // 注意:只是改 state 的字段,不触发 pushState — 这里不能 push,会变成每条日志一次云调用
  // ⚠️ 用 try/catch 包 — `state` 用 let 声明在文件后面(行 282 附近),
  // 但 psLog 在文件最前面就被调用了,会落进 TDZ 触发 ReferenceError 把整个 boot 干掉
  // → setupAuth 没机会绑登录按钮 → "登录键按了没用"。所以这里必须吞掉异常。
  try {
    if (state) {
      state._mobileDebugLog = _psLogBuf.slice(-_PSLOG_MAX);
      state._mobileDebugMeta = {
        build: (typeof _PSFOCUS_BUILD !== 'undefined' ? _PSFOCUS_BUILD : '?'),
        ua: ((navigator && navigator.userAgent) || '').slice(0, 200),
        url: location.href,
        updatedAt: Date.now(),
      };
    }
  } catch (_) {}
  // ERR 级别 → 立刻强推一次到云端,即便 tab 接下来被 kill 我也能看到崩前痕迹
  if (level === 'ERR') {
    try { _pushMobileLogCloud(true); } catch (_) {}
  }
}

// 推日志到云端 — 走云函数 syncState/push(唯一被授权写 user_states 的管道,
// 直接 db.collection.update 在默认权限下被拒)。
// 日志已被 psLog 实时注入 state._mobileDebugLog,所以这里只负责"现在就推一次"。
// 正常 pushState(用户操作触发)会自动捎带最新日志,不需要单独推;
// 仅在 ERR / showFatal / pagehide 时强推,确保崩前痕迹真的飞到云端。
let _logPushInFlight = false;
let _logPushPending = false;
let _lastForcePushAt = 0;
function _pushMobileLogCloud(force) {
  if (!uid) return;
  if (!force) return;   // 不再做 timer-based 推送,等正常 pushState 捎带
  // ERR 风暴节流:同一秒内多条 ERR 只推一次
  const now = Date.now();
  if (now - _lastForcePushAt < 1000) return;
  _lastForcePushAt = now;
  _doPushLogCloud();
}
async function _doPushLogCloud() {
  if (!uid) return;
  if (_logPushInFlight) { _logPushPending = true; return; }
  _logPushInFlight = true;
  try {
    const meta = {
      build: (typeof _PSFOCUS_BUILD !== 'undefined' ? _PSFOCUS_BUILD : '?'),
      ua: ((navigator && navigator.userAgent) || '').slice(0, 200),
      url: location.href,
      updatedAt: Date.now(),
    };
    const lines = (_psLogBuf || []).slice(-_PSLOG_MAX);
    // 走云函数 syncState/push — 这是唯一被授权写 user_states 的管道。
    // 直接 db.collection.update 在 CloudBase 默认权限下会被拒(只有 watch / get 是允许的)。
    // 把 _mobileDebugLog 注入 state 后整份 push 上去,desktop _applyRemoteState 会落盘。
    if (state && _initialPullOk && typeof tcbApp !== 'undefined' && tcbApp.callFunction) {
      state._mobileDebugLog = lines;
      state._mobileDebugMeta = meta;
      // bump ts 防 watcher 回声压回去
      state._cloudUpdatedAt = Date.now();
      const res = await tcbApp.callFunction({
        name: 'syncState',
        data: { action: 'push', docId: uid, state },
      });
      const r = res && res.result;
      if (!r || r.ok !== true) {
        try { console.warn('[mlog push] cloud-fn returned !ok', r && r.error); } catch (_) {}
      }
    } else if (db) {
      // 兜底:state 还没初始化(super-early crash)— 试直接 db update,可能因权限失败
      try {
        await db.collection(COLLECTION).doc(uid).update({
          _mobileDebugLog: lines,
          _mobileDebugMeta: meta,
        });
      } catch (e2) {
        try { console.warn('[mlog push direct fail]', e2 && e2.message || e2); } catch (_) {}
      }
    }
  } catch (e) {
    // 写失败别再 psLog,会引发递归。控制台一笔就够
    try { console.warn('[mlog push fail]', e && e.message || e); } catch (_) {}
  } finally {
    _logPushInFlight = false;
    if (_logPushPending) { _logPushPending = false; setTimeout(_doPushLogCloud, 100); }
  }
}
// 进程任何"该坐下来想想"的点(crash 前)立刻把 buf 同步写盘,
// 否则节流 timer 还没跑就崩了,日志丢
function _psLogFlushNow() {
  if (_psLogFlushTimer) { clearTimeout(_psLogFlushTimer); _psLogFlushTimer = null; }
  _psLogFlush();
}
// 早期标记 — 后面 _PSFOCUS_BUILD 还没定义,先写个 marker
psLog('LOG', '=== boot start === ua=' + (navigator && navigator.userAgent ? navigator.userAgent.slice(0, 120) : '?'));
psLog('LOG', 'href=' + location.href, 'persisted=' + (typeof PerformanceNavigationTiming !== 'undefined'));

// 内存观察(Chrome 才有 performance.memory;Safari 没有)
function _psMemSnapshot(tag) {
  try {
    if (performance && performance.memory) {
      const m = performance.memory;
      psLog('MEM', tag, 'used=' + Math.round(m.usedJSHeapSize/1024/1024) + 'MB',
                       'total=' + Math.round(m.totalJSHeapSize/1024/1024) + 'MB',
                       'limit=' + Math.round(m.jsHeapSizeLimit/1024/1024) + 'MB');
    }
  } catch (_) {}
}
_psMemSnapshot('boot');

// ===== 全局错误捕获 =====
function showFatal(msg, opts) {
  // 把崩前最后 30 行日志拼到 msg 后面 — 同一张卡片直接呈现,用户不用再点
  const tail = (_psLogBuf || []).slice(-30).join('\n');
  const ver = (typeof _PSFOCUS_BUILD !== 'undefined') ? _PSFOCUS_BUILD : 'unknown';
  const body = String(msg || '未知错误').slice(0, 1500);
  const composed = `[v${ver}] ${body}\n\n— 最近日志 (${(_psLogBuf||[]).length} 条) —\n${tail}`;
  psLog('ERR', 'showFatal:', body);
  _psLogFlushNow();
  // 立即把日志推一份到云端 — 即便接下来 tab 被 kill,我从桌面端落盘文件也能看到完整崩前痕迹
  try { _pushMobileLogCloud(true); } catch (_) {}
  const box = document.getElementById('fatal-err');
  const m = document.getElementById('fatal-err-msg');
  if (!box || !m) return;
  m.textContent = composed.slice(0, 4000);
  // 注入复制 + 查看完整日志按钮(若 index.html 老版没有,这里补)
  if (!box.querySelector('[data-action="fatal-copy-log"]')) {
    const card = box.querySelector('.fatal-err-card') || box;
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;';
    bar.innerHTML = `
      <button data-action="fatal-copy-log" style="flex:1;min-width:120px;padding:10px;border:1px solid #999;border-radius:6px;background:#fff;color:#333;font-size:14px;">复制全部日志</button>
      <button data-action="fatal-clear-log" style="padding:10px 14px;border:1px solid #999;border-radius:6px;background:#fff;color:#333;font-size:14px;">清空日志</button>
      <button data-action="fatal-reload" style="padding:10px 14px;border:1px solid #4a90e2;border-radius:6px;background:#4a90e2;color:#fff;font-size:14px;">硬刷新</button>
    `;
    card.appendChild(bar);
    bar.querySelector('[data-action="fatal-copy-log"]').onclick = () => {
      const full = '=== PSFocus mobile fatal log ===\n' +
                   `version: ${ver}\n` +
                   `ua: ${navigator.userAgent}\n` +
                   `error: ${body}\n\n` +
                   _psLogBuf.join('\n');
      const ok = (txt) => alert('已复制 ' + txt.length + ' 字到剪贴板,发给我即可');
      const fail = () => {
        // 失败兜底:把日志渲到一个可选的 textarea 里
        const ta = document.createElement('textarea');
        ta.value = full;
        ta.style.cssText = 'width:100%;height:200px;font-size:11px;font-family:monospace;margin-top:8px;';
        card.appendChild(ta); ta.select();
        alert('自动复制不被允许,日志已展开 — 长按全选复制即可');
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(full).then(() => ok(full)).catch(fail);
        } else { fail(); }
      } catch (_) { fail(); }
    };
    bar.querySelector('[data-action="fatal-clear-log"]').onclick = () => {
      _psLogBuf = []; _psLogFlushNow();
      alert('已清空');
    };
    bar.querySelector('[data-action="fatal-reload"]').onclick = () => {
      try { _psLogFlushNow(); } catch (_) {}
      try { location.reload(); } catch (_) {}
    };
  }
  box.classList.remove('hidden');
  const auth = document.getElementById('auth-screen');
  if (auth) auth.classList.add('hidden');
  const app = document.getElementById('app');
  if (app) app.classList.add('hidden');
}
window.addEventListener('error', (e) => {
  // e.message 跨源时为 "Script error.",没 stack 没 filename(CORS 屏蔽)。
  // 这种几乎总是 cloudbase SDK 内部跨源脚本的暂态异常(WS 抖、call 失败、SDK 内部 promise),
  // SDK 自己会重试。不要把它当致命错挡住 UI — 之前会让 Kayu 看到红卡片以为崩了,
  // 实际 app 还在正常跑。只 log 不 fatal。
  const msg = (e && e.message) || 'JS 错误';
  const stack = e && e.error && e.error.stack;
  const filename = (e && e.filename) || '';
  const isOpaqueCrossOrigin = (msg === 'Script error.' && !stack && !filename);
  if (isOpaqueCrossOrigin) {
    psLog('WARN', 'cross-origin Script error swallowed (likely cloudbase SDK transient)');
    return;
  }
  const fileInfo = (filename || e.lineno != null)
    ? ` @ ${filename || '?'}:${e.lineno || '?'}:${e.colno || '?'}`
    : '';
  const detail = stack || (msg + fileInfo);
  psLog('ERR', 'window.error:', detail);
  _psLogFlushNow();
  showFatal(detail);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e?.reason?.message || e?.reason || '');
  const stack = (e && e.reason && e.reason.stack) || '';
  // 已知暂态错误 — CloudBase SDK 内部 ws 超时会自动重连,iOS Safari 切后台 / 网络抖动会触发
  // 这种全屏报错只会让用户以为"挂了"。日志记一下就好,不要 hijack 整个 app。
  const isTransient =
    /wsclient\.send timedout/i.test(msg) ||
    /Failed to fetch/i.test(msg) ||
    /Network request failed/i.test(msg) ||
    /timeout/i.test(msg) ||
    /WebSocket/i.test(msg) ||
    /AbortError/i.test(msg) ||
    /callFunction/i.test(msg) ||
    /cloudbase|tcb/i.test(msg) ||
    /Load failed/i.test(msg) ||
    msg === '';   // 空消息 = 跨源屏蔽,跟 "Script error." 同理
  if (isTransient) {
    psLog('WARN', 'transient rejection swallowed:', msg);
    e.preventDefault && e.preventDefault();
    return;
  }
  psLog('ERR', 'unhandledrejection:', stack || msg);
  _psLogFlushNow();
  showFatal('未处理的 Promise:' + (stack || msg));
});
// 页面隐藏/卸载前把日志强写一次 — iOS Safari 经常在切到后台时被冷冻,日志可能丢
// 同时强推一份到云端,即便后续被 kill 我也能从云端 + 桌面端落盘文件看到崩前的日志
window.addEventListener('pagehide', () => {
  _psLogFlushNow();
  try { _pushMobileLogCloud(true); } catch (_) {}
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    _psLogFlushNow();
    try { _pushMobileLogCloud(true); } catch (_) {}
  }
});

// ===== TCB 初始化 =====
if (typeof cloudbase === 'undefined') {
  psLog('ERR', 'cloudbase SDK not loaded');
  showFatal('CloudBase SDK 没加载到。检查网络或浏览器是否拦了 static.cloudbase.net。');
  throw new Error('cloudbase undefined');
}
psLog('LOG', 'cloudbase SDK ok, init env');
const ENV_ID = 'psfocus-1921-d1g0x0og7e99d5502';
const REGION = 'ap-shanghai';
const COLLECTION = 'user_states';
let tcbApp, auth, db;
try {
  tcbApp = cloudbase.init({ env: ENV_ID, region: REGION });
  auth = tcbApp.auth({ persistence: 'local' });
  db = tcbApp.database();
  psLog('LOG', 'tcbApp/auth/db ready');
} catch (e) {
  psLog('ERR', 'cloudbase.init failed', e);
  _psLogFlushNow();
  showFatal('CloudBase 初始化失败:' + (e && e.message || e));
  throw e;
}

// ===== 全局状态 =====
let state = null;
let uid = null;
let watcher = null;
let pushTimer = null;
let lastPushAt = 0;
let applyingRemote = false;

const LS_KEY = 'psfocus.mobile.v2';
let ui = loadUI();

// ===== Helpers =====
const $ = (id) => document.getElementById(id);
const elView = () => $('view');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// 自定义 SVG 图标 — 与桌面端 _findIconInLibrary / _renderCustomIconHtml 等价(只读侧)
// project.icon / folder.icon 字段格式为 'lib:<id>',对应 state.settings.iconLib[i]
function findIconInLibrary(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('lib:')) return null;
  const id = ref.slice(4);
  return (state && state.settings && Array.isArray(state.settings.iconLib))
    ? (state.settings.iconLib.find(x => x.id === id) || null)
    : null;
}
function renderCustomIconHtml(ref, extraClass, tintColor) {
  const it = findIconInLibrary(ref);
  if (!it) return null;
  const style = tintColor ? ` style="color:${esc(tintColor)}"` : '';
  return `<span class="nav-icon-svg ${extraClass || ''}"${style}>${it.content}</span>`;
}
function uniq(arr) { return Array.from(new Set(arr)); }
function showToast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function genId(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 10); }

// ===== 时间工具 =====
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d)   { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfWeek(d) {
  // 周一为周首日
  const x = startOfDay(d); const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow); return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return '明天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth()+1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
}
function fmtTime(ts) { if (!ts) return ''; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtTaskTime(t) {
  if (!t) return '';
  // 重复任务 — 显示"下一个未完成 occurrence"的时间(对齐桌面 renderTodoItem 的 dispStart 替换)
  if (typeof _isRecurringTask === 'function' && _isRecurringTask(t)) {
    const pending = (typeof _nextPendingOccurrence === 'function') ? _nextPendingOccurrence(t) : null;
    if (pending != null) {
      const recur = (t.schedules || []).find(s => s && s.repeat && s.repeat !== 'none');
      const dur = (recur && recur.end && recur.start) ? (recur.end - recur.start) : 0;
      const allDay = !!(recur && recur.allDay);
      const a = fmtDate(pending);
      if (allDay) return a;
      if (dur > 0) return `${a} ${fmtTime(pending)}-${fmtTime(pending + dur)}`;
      return `${a} ${fmtTime(pending)}`;
    }
  }
  const start = t.start, end = t.end;
  if (start) {
    const a = fmtDate(start);
    const b = end ? `${fmtTime(start)}-${fmtTime(end)}` : fmtTime(start);
    return t.allDay ? a : `${a} ${b}`;
  }
  if (t.dueAt) return fmtDate(t.dueAt);
  return '';
}
// 时间状态:overdue / today / future / ''(已完成或无时间)
function timeStateClass(t) {
  if (!t || t.done) return '';
  let ts;
  // 重复任务用 nextPendingOccurrence(显示下一个未完成的)
  if (typeof _isRecurringTask === 'function' && _isRecurringTask(t)) {
    ts = (typeof _nextPendingOccurrence === 'function') ? _nextPendingOccurrence(t) : null;
  } else {
    ts = t.dueAt || t.start;
  }
  if (!ts) return '';
  const today0 = startOfDay(new Date()).getTime();
  const today1 = today0 + 86400000;
  if (ts < today0) return 'overdue';
  if (ts < today1) return 'today';
  return 'future';
}
function tsToDateInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function tsToTimeInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function combineDateAndTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  let h = 9, mi = 0;
  if (timeStr) { const [hh, mm] = timeStr.split(':').map(Number); h = hh; mi = mm; }
  return new Date(y, m-1, d, h, mi, 0, 0).getTime();
}

// ===== UI 状态 =====
function loadUI() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) {}
  return {
    tab: saved.tab || 'tasks',
    selectedKind: saved.selectedKind || 'smart',
    selectedId: saved.selectedId || 'all',
    settingsPage: null,
    calMode: saved.calMode || 'month',
    calCursor: saved.calCursor || Date.now(),
    calSelectedDay: saved.calSelectedDay || startOfDay(new Date()).getTime(),
    collapsedFolders: new Set(saved.collapsedFolders || []),
    collapsedSections: new Set(saved.collapsedSections || []),
    calSideOpen: !!saved.calSideOpen,
    calSideExpanded: new Set(saved.calSideExpanded || []),
  };
}
function saveUI() {
  const data = {
    tab: ui.tab,
    selectedKind: ui.selectedKind, selectedId: ui.selectedId,
    calMode: ui.calMode, calCursor: ui.calCursor, calSelectedDay: ui.calSelectedDay,
    collapsedFolders: Array.from(ui.collapsedFolders),
    collapsedSections: Array.from(ui.collapsedSections),
    calSideOpen: !!ui.calSideOpen,
    calSideExpanded: Array.from(ui.calSideExpanded || []),
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (_) {}
}

// ===== 主题 =====
function getThemeMode() {
  return (state && state.settings && state.settings.theme) || 'auto';
}
function applyTheme() {
  const mode = getThemeMode();
  const dark = mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
function applyAccent(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return;
  document.documentElement.style.setProperty('--accent', hex);
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  document.documentElement.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.10)`);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.22)`);
  const dr = (r*0.55)|0, dg = (g*0.55)|0, db = (b*0.55)|0;
  const dark = `#${dr.toString(16).padStart(2,'0')}${dg.toString(16).padStart(2,'0')}${db.toString(16).padStart(2,'0')}`;
  document.documentElement.style.setProperty('--accent-text', dark);
}
function applyContrast(hex) {
  const root = document.documentElement.style;
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) root.setProperty('--accent-contrast', hex);
  else root.removeProperty('--accent-contrast');
}
function applyBgPage(hex) {
  const root = document.documentElement.style;
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) root.setProperty('--bg-page', hex);
  else root.removeProperty('--bg-page');
}
function applyAllAppearance() {
  applyTheme();
  if (state && state.settings) {
    if (state.settings.accentColor) applyAccent(state.settings.accentColor);
    applyContrast(state.settings.contrastColor);
    applyBgPage(state.settings.bgPage);
  }
  applySkin();
}
// 毛玻璃皮肤(跟桌面共用同一份 state.settings.uiSkin / glassBg)
function applySkin() {
  const s = (state && state.settings && state.settings.uiSkin) || 'flat';
  document.body.classList.toggle('skin-glass', s === 'glass');
  const body = document.body;
  body.style.removeProperty('background');
  body.style.removeProperty('background-color');
  body.style.removeProperty('background-image');
  body.style.removeProperty('background-size');
  body.style.removeProperty('background-position');
  body.style.removeProperty('background-repeat');
  body.style.removeProperty('background-attachment');
  if (s !== 'glass') return;
  const g = (state.settings && state.settings.glassBg) || {};
  if (g.type === 'solid' && g.solidColor) {
    body.style.background = g.solidColor;
  } else if (g.type === 'gradient' && g.gradient) {
    const a = g.gradient.angle != null ? +g.gradient.angle : 135;
    const from = g.gradient.from || '#e8eef5';
    const to   = g.gradient.to   || '#d6dde7';
    body.style.background = `linear-gradient(${a}deg, ${from}, ${to})`;
  } else if (g.type === 'image' && g.imageDataUrl) {
    body.style.background = `url("${g.imageDataUrl}") center/cover no-repeat fixed`;
  }
  const blur = (g.blur != null) ? +g.blur : 24;
  document.documentElement.style.setProperty('--glass-blur-px', blur + 'px');
}
async function _downscaleImageToDataUrl(file, maxDim, quality) {
  maxDim = maxDim || 1600; quality = quality || 0.85;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = (e) => rej(e);
      i.src = url;
    });
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > maxDim || h > maxDim) {
      const r = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * r); h = Math.round(h * r);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
}
// 系统配色变化时,如果是 auto 模式,跟随刷新
try {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getThemeMode() === 'auto') applyTheme();
  });
} catch (_) {}

// ===== 鉴权 =====
const CREDS_KEY = 'psfocus.auth.creds';
function _saveCreds(username, password) {
  try { localStorage.setItem(CREDS_KEY, btoa(unescape(encodeURIComponent(JSON.stringify({ u: username, p: password }))))); } catch (_) {}
}
function _loadCreds() {
  try {
    const raw = localStorage.getItem(CREDS_KEY);
    if (!raw) return null;
    const o = JSON.parse(decodeURIComponent(escape(atob(raw))));
    return (o && o.u && o.p) ? o : null;
  } catch (_) { return null; }
}
function _clearCreds() { try { localStorage.removeItem(CREDS_KEY); } catch (_) {} }

// 节流:同一时刻只能有一次 auto-relogin 在飞;失败后短退避内不再触发;成功后 reset。
// 不再用永久 flag(老代码 bug:首次重登后再次掉线就不再重试,用户被甩到登录页要手动输密码)。
let _autoReloginInFlight = false;
let _autoReloginCooldownUntil = 0;
function _scheduleAutoRelogin() {
  if (_autoReloginInFlight) return;
  if (Date.now() < _autoReloginCooldownUntil) return;
  _autoReloginInFlight = true;
  setTimeout(async () => {
    if (uid) { _autoReloginInFlight = false; return; }   // 期间已经登上了
    const creds = _loadCreds();
    if (!creds) { _autoReloginInFlight = false; return; }
    const msg = $('auth-msg');
    if (msg) msg.textContent = '自动重新登录…';
    try {
      await auth.signIn({ username: creds.u, password: creds.p });
      // onLoginStateChanged 会接管(隐藏 auth-screen + bindCloud)
      _autoReloginCooldownUntil = 0;   // 成功 → 不再退避
    } catch (e) {
      // 凭证错(USER_PASSWORD_INVALID / USER_NOT_FOUND)→ 清掉,不再重试
      const code = (e && (e.code || '')) + ''; const m = (e && (e.message || '')) + '';
      if (/USER_PASSWORD_INVALID|USER_NOT_FOUND|password.*incorrect|wrong.*password|user.*not.*exist/i.test(code + m)) {
        _clearCreds();
        if (msg) msg.textContent = '凭证失效,请重新登录';
      } else {
        // 网络/服务暂时不可达 → 30s 后允许再试
        _autoReloginCooldownUntil = Date.now() + 30000;
        if (msg) msg.textContent = '自动登录失败,30 秒后再试';
      }
    } finally {
      _autoReloginInFlight = false;
    }
  }, 1500);
}

function setupAuth() {
  auth.onLoginStateChanged((loginState) => {
    if (loginState && (loginState.user || loginState.uid)) {
      const u = loginState.user || loginState;
      uid = u.username || u.email || u.uid || u.userId || '';
      $('auth-screen').classList.add('hidden');
      $('app').classList.remove('hidden');
      bindCloud();
    } else {
      uid = null;
      stopWatch();
      state = null;
      $('app').classList.add('hidden');
      $('auth-screen').classList.remove('hidden');
      // 没登上 → 试一次自动重登(只在启动期触发一次)
      _scheduleAutoRelogin();
    }
  });
  $('auth-login-btn').addEventListener('click', () => doAuth(false));
  $('auth-signup-btn').addEventListener('click', () => doAuth(true));
  $('auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(false); });
}
async function doAuth(isSignup) {
  const username = $('auth-email').value.trim();
  const password = $('auth-pass').value;
  const remember = $('auth-remember') ? $('auth-remember').checked : true;
  const msg = $('auth-msg');
  msg.textContent = '';
  if (!username || !password) { msg.textContent = '请输入用户名和密码'; return; }
  if (isSignup && password.length < 6) { msg.textContent = '密码至少 6 位'; return; }
  $('auth-login-btn').disabled = true;
  $('auth-signup-btn').disabled = true;
  try {
    if (isSignup) { await auth.signUp({ username, password }); msg.textContent = '注册成功'; }
    else { await auth.signIn({ username, password }); }
    if (remember) _saveCreds(username, password); else _clearCreds();
  } catch (e) { msg.textContent = mapAuthError(e); }
  finally { $('auth-login-btn').disabled = false; $('auth-signup-btn').disabled = false; }
}
function mapAuthError(e) {
  const code = (e?.code || '') + ''; const m = (e?.message || '') + '';
  if (/USER_PASSWORD_INVALID|password.*incorrect|wrong.*password/i.test(code + m)) return '用户名或密码错误';
  if (/USER_NOT_FOUND|user.*not.*exist/i.test(code + m)) return '用户不存在,请先注册';
  if (/USER_ALREADY_EXIST|already.*exist/i.test(code + m)) return '用户名已被注册';
  if (/INVALID_USERNAME|username.*invalid/i.test(code + m)) return '用户名格式不对(5-24 位,字母数字下划线)';
  if (/INVALID_PASSWORD|weak.*password/i.test(code + m)) return '密码格式不对(至少 6 位)';
  if (/network|timeout/i.test(code + m)) return '网络错误,请重试';
  return '失败:' + (m || code || '未知错误');
}

// 客户端构建版本(每次发新代码会改这个,Kayu 能在 sync-bar 看到当前版本号识别是否拿到最新)
const _PSFOCUS_BUILD = '20260527-0802';
console.log('[PSFocus mobile] build', _PSFOCUS_BUILD);
psLog('LOG', 'PSFOCUS_BUILD=' + _PSFOCUS_BUILD);

// 注册 Service Worker — Chrome / Safari 杀掉 tab 重新加载时,直接吃缓存起来,不依赖网络
// 防「无法打开此网页」白屏(iOS 切回 app 时常见)
//
// 升级链路 — 之前的 stale-while-revalidate 让用户必须刷两次才看到新版(第一次仍吃旧缓存,
// 后台静默更新;第二次才拿到新),这次部署用户就反馈"版本号没变"。
// 解法:监听 controllerchange — 新 SW 接管页面那一刻自动 reload 一次,刷一次立马用新版。
// 加 _refreshing 闸防 reload loop;新 SW 首次启动时页面是不带 controller 的,reload 后页面就以新 SW 为 controller,
// 此后不会再触发 controllerchange,所以不会循环。
let _swRefreshing = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swRefreshing) return;
    _swRefreshing = true;
    psLog('LOG', 'SW controllerchange → auto reload to apply new build');
    _psLogFlushNow();
    try { location.reload(); } catch (_) {}
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        psLog('LOG', 'sw registered scope=' + reg.scope);
        // 主动让浏览器检查更新 — 不依赖默认 24h 周期(用户也许整天不关 tab)
        try { reg.update(); } catch (_) {}
        // 1h 周期再检查一次,让长时间挂着的 tab 也能跟上新版
        setInterval(() => { try { reg.update(); } catch (_) {} }, 60 * 60 * 1000);
      })
      .catch(err => psLog('WARN', 'sw register failed:', err && err.message || err));
  });
}

// ===== 同步层 =====
function setSync(kind, msg) {
  const bar = $('sync-bar'); if (!bar) return;
  bar.classList.remove('is-syncing','is-error');
  if (kind === 'syncing') bar.classList.add('is-syncing');
  if (kind === 'error')   bar.classList.add('is-error');
  $('sync-text').textContent = (msg || '') + '  · v' + _PSFOCUS_BUILD;
  if (kind === 'synced') {
    bar.classList.remove('hidden');
    clearTimeout(setSync._t);
    setSync._t = setTimeout(() => bar.classList.add('hidden'), 1500);
  } else { bar.classList.remove('hidden'); }
}
// 安全闸:bindCloud 第一次没成功拉到云端 → 任何 pushState 都会被拒,
// 防"加载失败 → 空 state → 用户操作 → push 空 state → 覆盖云端真实数据"的灾难场景
let _initialPullOk = false;
let _lastKnownGoodTaskCount = -1;  // 最近一次拉到 / push 时的任务数(用作骤降检测)

async function bindCloud() {
  psLog('LOG', 'bindCloud:start uid=' + (uid || '?'));
  setSync('syncing', '加载中…');
  try {
    const t0 = Date.now();
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'pull', docId: uid } });
    psLog('LOG', 'bindCloud:pull done in', (Date.now() - t0) + 'ms');
    const r = res && res.result;
    const remote = (r && r.ok) ? r.state : null;
    if (remote) {
      const _sz = (() => { try { return JSON.stringify(remote).length; } catch (_) { return -1; } })();
      psLog('LOG', 'bindCloud:remote ok size=' + _sz + 'B',
                  'tasks=' + ((remote.tasks||[]).length),
                  'projects=' + ((remote.projects||[]).length),
                  'summaries=' + ((remote.summaries||[]).length),
                  'sessions=' + ((remote.sessions||[]).length));
      state = sanitizeState(remote);
      _initialPullOk = true;
      _lastKnownGoodTaskCount = (state.tasks || []).length;
      setSync('synced', '已同步');
    } else {
      psLog('LOG', 'bindCloud:remote empty — new account?');
      state = emptyState();
      _initialPullOk = true;
      _lastKnownGoodTaskCount = 0;
      setSync('synced', '已同步(空)');
    }
  } catch (e) {
    psLog('ERR', 'bindCloud:pull fail', (e && e.message) || e);
    state = emptyState();
    _initialPullOk = false;
    _lastKnownGoodTaskCount = -1;
    setSync('error', '加载失败,本地暂用空数据 — 已锁定,不会覆盖云端');
    console.error('[bindCloud pull]', e);
  }
  _psMemSnapshot('bindCloud after pull');
  try { psLog('LOG', 'bindCloud:restoreWorksUiPrefs'); restoreWorksUiPrefs(); }
  catch (e) { psLog('ERR', 'restoreWorksUiPrefs throw', e); }
  try { psLog('LOG', 'bindCloud:applyAllAppearance'); applyAllAppearance(); }
  catch (e) { psLog('ERR', 'applyAllAppearance throw', e); }
  try { psLog('LOG', 'bindCloud:renderAll tab=' + (ui && ui.tab)); renderAll(); psLog('LOG', 'bindCloud:renderAll done'); }
  catch (e) { psLog('ERR', 'renderAll throw', e); _psLogFlushNow(); showFatal('首次渲染失败:' + (e && (e.stack || e.message) || e)); return; }
  _psMemSnapshot('bindCloud after render');
  try { startWatch(); psLog('LOG', 'bindCloud:startWatch ok'); }
  catch (e) { psLog('ERR', 'startWatch throw', e); }
  try { startPeriodicPull(); }
  catch (e) { psLog('ERR', 'startPeriodicPull throw', e); }
  // 拉到云端旧数据后,如果 sanitize 补了缺字段,立刻 push 回去让云端自愈
  if (_stateNeedsBackfillPush) {
    _stateNeedsBackfillPush = false;
    setTimeout(() => { try { pushState(); } catch (e) { psLog('ERR', 'backfill push fail', e); } }, 1500);
  }
  // 加载稳定后,后台慢慢把所有项目封面图预缓存到本地 — 之后进项目 tab 不再走网络
  setTimeout(() => { try { prefetchWorksCovers(); } catch (e) { psLog('ERR', 'prefetchWorksCovers throw', e); } }, 6000);
  psLog('LOG', 'bindCloud:done');
  // 兜底:一登入成功立即推一次日志 — 把累在 localStorage 里的(上次崩前 + 本次 boot)
  // 一次性飞到云端。若用户登进来就崩,异步 push 飞不出去,这次会丢;但 *下* 一次再登
  // 时就会把上次崩的日志带过来,desktop 那边就能落到 mobile-debug.log。
  setTimeout(() => { try { _pushMobileLogCloud(true); } catch (_) {} }, 500);
  // 心跳 — 每 5 秒一行 + 每 30 秒强推一次,即便没异常也能持续给云端拍照片
  // 这样下次崩前 / 崩后只丢失最近 30 秒的事件,而不是整段几分钟
  _startAliveHeartbeat();
}

let _aliveTimer = null;
let _aliveCount = 0;
let _lastHeartbeatPushAt = 0;
function _startAliveHeartbeat() {
  if (_aliveTimer) return;
  // 调稀版 — prefetch 修好后心跳改为兜底用途,不再高频
  // ping 30s 一次(每小时 120 行,对 300 行环形 buf 一致;留约 1 小时事件)
  // push 5min 一次(每小时 12 次 ≈ 28MB 上行 + CloudBase 函数调用)
  _aliveTimer = setInterval(() => {
    _aliveCount++;
    const memHint = (() => {
      try {
        if (performance && performance.memory) {
          const m = performance.memory;
          return 'mem=' + Math.round(m.usedJSHeapSize/1024/1024) + '/' + Math.round(m.jsHeapSizeLimit/1024/1024) + 'MB';
        }
      } catch (_) {}
      return '';
    })();
    psLog('PING', 'alive #' + _aliveCount, 'vis=' + document.visibilityState, memHint);
    // 10 次 ping = 5 分钟推一次
    if (_aliveCount % 10 === 0) {
      try { _pushMobileLogCloud(true); } catch (_) {}
    }
  }, 30000);
}
function _stopAliveHeartbeat() {
  if (_aliveTimer) { clearInterval(_aliveTimer); _aliveTimer = null; }
}
function stopWatch() {
  if (watcher) { try { watcher.close(); } catch(_) {} watcher = null; }
  if (_watchHeartbeatId) { clearInterval(_watchHeartbeatId); _watchHeartbeatId = null; }
}
let _watchReconnectTimer = null;
let _watchHeartbeatId = null;
let _lastWatchAt = 0;          // 上次 watcher onChange 触发的时间
let _lastStartWatchAt = 0;     // 上次 startWatch 实际跑的时间;用来节流防止 visibilitychange / online / heartbeat 同时撞
let _lastPullAt = 0;           // 上次 pullStateOnce 完成的时间;节流防止短时间内多次大 payload 拉
// 节流:visibilitychange / online 触发的 watcher 重启,5s 内只能跑一次,避免 iOS 唤醒后短时间内多次连续启停
function startWatchThrottled(reason) {
  const now = Date.now();
  if (now - _lastStartWatchAt < 5000) {
    console.log('[cloud] startWatch skip (', reason, ') — last start', now - _lastStartWatchAt, 'ms ago');
    return;
  }
  _lastStartWatchAt = now;
  try { startWatch(); } catch (_) {}
}
// 节流 pull:3s 内只允许一次,避免 visibilitychange + online + watcher restart 三路并发都各拉一遍
function pullStateOnceThrottled(reason) {
  const now = Date.now();
  if (now - _lastPullAt < 3000) {
    console.log('[cloud] pull skip (', reason, ') — last pull', now - _lastPullAt, 'ms ago');
    return;
  }
  _lastPullAt = now;
  pullStateOnce();
}
function _scheduleWatchReconnect(delay) {
  if (_watchReconnectTimer) return;
  _watchReconnectTimer = setTimeout(() => {
    _watchReconnectTimer = null;
    // 后台时不重连,但要清掉 watcher,visibilitychange 时再重启
    if (!uid) return;
    if (document.visibilityState !== 'visible') return;
    console.log('[cloud] reconnecting watcher…');
    startWatch();
  }, delay != null ? delay : 2500);
}
// ── 输入法保护:正在打字/拼音组合中时,延后应用远端快照 ──────────────
// 根因:云端 watcher / 定时 pull 收到远端 state 后会 renderAll(),
// 整页重建会销毁当前聚焦的 <input>,正在拼音组合的中文输入因此被打断。
// 方案:用户正在输入(IME 组合中 或 焦点在输入框)时,把远端快照暂存,
// 等组合结束 + 失焦后再应用;应用前重新比对 _cloudUpdatedAt 决定用谁。
let _imeComposingM = false;
let _pendingRemoteRaw = null;
function _isTypingNowM() {
  if (_imeComposingM) return true;
  const el = document.activeElement;
  return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
}
function _applyRemoteSnapshot(rawState) {
  if (!rawState || typeof rawState !== 'object') return;
  if (_isTypingNowM()) { _pendingRemoteRaw = rawState; return; }
  _pendingRemoteRaw = null;
  const _sz = (() => { try { return JSON.stringify(rawState).length; } catch (_) { return -1; } })();
  psLog('LOG', 'applyRemote:start size=' + _sz + 'B',
              'tasks=' + ((rawState.tasks||[]).length),
              'projects=' + ((rawState.projects||[]).length),
              'summaries=' + ((rawState.summaries||[]).length));
  _psMemSnapshot('applyRemote before');
  try {
    applyingRemote = true;
    state = sanitizeState(rawState);
    applyingRemote = false;
    _initialPullOk = true;
    _lastKnownGoodTaskCount = (state.tasks || []).length;
    setSync('synced', '已同步');
    applyAllAppearance();
    renderAll();
    _psMemSnapshot('applyRemote after render');
    psLog('LOG', 'applyRemote:done');
  } catch (e) {
    applyingRemote = false;
    psLog('ERR', 'applyRemote throw', e);
    _psLogFlushNow();
    showFatal('应用远端快照失败:' + (e && (e.stack || e.message) || e));
  }
}
function _flushPendingRemoteM() {
  if (!_pendingRemoteRaw || _isTypingNowM()) return;
  const raw = _pendingRemoteRaw; _pendingRemoteRaw = null;
  const rt = (raw && raw._cloudUpdatedAt) || 0;
  const lt = (state && state._cloudUpdatedAt) || 0;
  if (rt >= lt) _applyRemoteSnapshot(raw);
  else { try { pushState(); } catch (_) {} }
}
document.addEventListener('compositionstart', () => { _imeComposingM = true; });
document.addEventListener('compositionend', () => { _imeComposingM = false; setTimeout(_flushPendingRemoteM, 0); });
document.addEventListener('focusout', () => { setTimeout(_flushPendingRemoteM, 0); });

function startWatch() {
  stopWatch();
  _lastWatchAt = Date.now();      // 重置心跳基准
  _lastStartWatchAt = Date.now(); // 让节流闸感知到「刚启动过」
  try {
    watcher = db.collection(COLLECTION).doc(uid).watch({
      onChange: (snapshot) => {
        _lastWatchAt = Date.now();   // 收到任何变更都算心跳
        const docs = snapshot && snapshot.docs ? snapshot.docs : [];
        if (!docs.length) return;
        const data = docs[0];
        if (!data || !data.state) return;
        // 本地有还没推上去的改动(还在防抖窗口里)→ 绝不能用远端覆盖,
        // 否则刚勾的「完成」会被并发的桌面端快照冲掉。立即把本地 flush 上去(占最新 ts)。
        if (pushTimer) {
          console.warn('[watch] 本地有未推送改动 — 跳过远端快照,立即 flush 本地');
          flushPendingPush();
          return;
        }
        const remoteTs = (data.state && data.state._cloudUpdatedAt) || 0;
        const localTs  = (state && state._cloudUpdatedAt) || 0;
        // 精确跳过"自己的回声"(同 _cloudUpdatedAt)。不再用「push 后 2 秒盲窗」——
        // 旧逻辑会把桌面端在这 2 秒内推上来的改动整段丢弃,导致刚同步的状态收不到。
        if (remoteTs && remoteTs === localTs) return;
        // 时间戳防御:云端比本地旧 → 跳过(本地有未同步的改动),并把本地推上去
        if (remoteTs < localTs) {
          console.warn('[watch] skip older snapshot:', remoteTs, '<', localTs, '— 本地更新,主动推一次');
          try { pushState(); } catch (_) {}
          return;
        }
        _applyRemoteSnapshot(data.state);
      },
      onError: (err) => {
        console.warn('[cloud watch error]', err);
        setSync('error', '监听断线,重连中…');
        stopWatch();
        _scheduleWatchReconnect();
      },
    });
    // 心跳:每 120s 检查 watcher 是否还活着。watcher 在某些环境(WS 被中间设备截断 / iOS Safari 后台休眠醒来)
    // 不一定触发 onError,需要主动监测。超过 5 分钟没动静(且当前前台 + 网络在线)→ 重连。
    // 节流走 startWatchThrottled,避免心跳跟 visibilitychange 抢着 stop+start。
    if (_watchHeartbeatId) clearInterval(_watchHeartbeatId);
    _watchHeartbeatId = setInterval(() => {
      if (!uid) return;
      if (document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const idle = Date.now() - _lastWatchAt;
      if (idle > 5 * 60000) {
        console.warn('[cloud] watcher silent for', Math.round(idle / 1000), 's — restart');
        startWatchThrottled('heartbeat');
      }
    }, 120000);
  } catch (e) {
    console.warn('[cloud startWatch fail]', e);
    _scheduleWatchReconnect();
  }
}
// 兜底:每 60 秒主动 pull 一次(只在前台),防 watcher silent 断线导致 Kayu 看不到桌面更新
// 之前是 30s — watcher 活着的时候纯粹是浪费,频繁拉大 payload 在 iOS 上容易让 tab 被回收
let _periodicPullId = null;
function startPeriodicPull() {
  if (_periodicPullId) return;
  _periodicPullId = setInterval(() => {
    if (!uid || !state) return;
    if (document.visibilityState !== 'visible') return;
    pullStateOnceThrottled('periodic');
  }, 60000);
}
function pushState() {
  if (applyingRemote || !uid) return;
  // 安全闸:第一次 pull 没成功 → 严禁 push(否则会用空 state 覆盖云端真实数据)
  if (!_initialPullOk) {
    console.warn('[push blocked] initial pull not ok — refusing to push (data protection)');
    setSync('error', '云端未拉取成功,push 已锁定保护数据');
    return;
  }
  // 骤降检测:任务数从 N 突然降到 < N-5(或一半)→ 拒绝 push,要用户手动确认
  const nowCount = (state && state.tasks ? state.tasks.length : 0);
  if (_lastKnownGoodTaskCount > 5 && nowCount < _lastKnownGoodTaskCount - 5) {
    const ok = confirm(`⚠️ 任务数从 ${_lastKnownGoodTaskCount} 骤降到 ${nowCount},可能误删?\n点确定继续推送(覆盖云端),点取消保护数据。`);
    if (!ok) {
      console.warn('[push blocked by user] task count drop', _lastKnownGoodTaskCount, '->', nowCount);
      setSync('error', '已取消推送(防误删)');
      return;
    }
  }
  // 关键:_cloudUpdatedAt 同步 bump,不要等防抖 — 否则在防抖窗口(0~1s)内 watcher
  // 收到旧云端 snapshot 时,localTs 还是旧值,会被误判为"远端较新"而覆盖本地刚改的字段
  // (如:模块标题改了但还没 push,watcher 把还没同步的旧云端推回来,标题被复原)
  state._cloudUpdatedAt = Date.now();
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(_performPush, 1000);
}
// 真正执行云端写入(pushState 防抖后调,或 flushPendingPush 立即调)
// 失败自动重试,最多 3 次,指数退避 — 防一次网络抖动就把这次改动丢掉
async function _performPush(attempt) {
  attempt = attempt || 0;
  pushTimer = null;
  if (applyingRemote || !uid || !_initialPullOk) return;
  try {
    setSync('syncing', '同步中…');
    lastPushAt = Date.now();
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'push', docId: uid, state } });
    const r = res && res.result;
    if (!r || r.ok !== true) throw new Error((r && r.error) || '云函数返回失败');
    _lastKnownGoodTaskCount = (state.tasks || []).length;  // push 成功后更新基准
    setSync('synced', '已同步');
  } catch (e) {
    const errMsg = (e && (e.message || e.code || String(e))) || '未知';
    console.error('[push error attempt ' + attempt + ']', e);
    if (attempt < 3 && !pushTimer) {
      const delay = 3000 * (attempt + 1);
      setSync('syncing', '同步失败,' + (delay / 1000) + ' 秒后重试…');
      pushTimer = setTimeout(() => _performPush(attempt + 1), delay);
    } else {
      setSync('error', '同步失败:' + errMsg);
    }
  }
}
// 立刻把防抖窗口里待推送的本地改动推上去(watcher 检测到并发远端写入时调)
// 会重新 bump _cloudUpdatedAt,确保本地这次写入的时间戳压过并发远端,避免被覆盖
function flushPendingPush() {
  if (!pushTimer) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  if (applyingRemote || !uid || !_initialPullOk) return;
  state._cloudUpdatedAt = Date.now();
  _performPush();
}
let _pullInflight = false;
async function pullStateOnce() {
  // 本地有还没推上去的改动 → 别拉远端覆盖,先把本地 flush 上去
  if (pushTimer) { flushPendingPush(); return; }
  if (_pullInflight) return;   // 同一时刻只允许一个 pull 在飞,防止并发拉两份大 payload 双倍解析内存
  _pullInflight = true;
  try {
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'pull', docId: uid } });
    const r = res && res.result;
    const remote = (r && r.ok) ? r.state : null;
    if (!remote) return;
    if (pushTimer) { flushPendingPush(); return; }   // await 期间又产生了本地改动
    const local = state && state._cloudUpdatedAt || 0;
    const remoteTs = remote._cloudUpdatedAt || 0;
    if (remoteTs > local) {
      _applyRemoteSnapshot(remote);
    } else if (remote) {
      // 哪怕没更新也算云端可达
      _initialPullOk = true;
    }
  } catch (_) {}
  finally { _pullInflight = false; }
}
// 手动下拉刷新 — 强制从云拉一次,用任务指纹比较判断有无变化
// (不再依赖 _cloudUpdatedAt — 桌面 push 不一定更新这个字段;用户手动触发就是要拉)
function _stateFingerprint(s) {
  if (!s || !Array.isArray(s.tasks)) return '0';
  const parts = [];
  parts.push('t' + s.tasks.length);
  for (const t of s.tasks) {
    const ocs = Array.isArray(t.completedOccurrences) ? t.completedOccurrences.length : 0;
    const reps = (t.schedules || []).map(x => x && x.repeat || '').join(',');
    parts.push(`${t.id}:${t.done?1:0}:${ocs}:${reps}:${t.start||0}:${t.end||0}:${t.title||''}`);
  }
  parts.push('p' + (s.projects||[]).length);
  parts.push('e' + (s.events||[]).length);
  return parts.join('|');
}
let _lastSyncErrorMsg = '';
async function manualPullState() {
  _lastSyncErrorMsg = '';
  if (!tcbApp) { _lastSyncErrorMsg = 'tcbApp 未就绪'; return 'no-cloud'; }
  if (!uid) { _lastSyncErrorMsg = '未登录(uid 为空)'; return 'no-cloud'; }
  // 本地有还没推上去的改动 → 先 flush 上去再说,别让下拉刷新拉回旧数据盖掉
  if (pushTimer) { flushPendingPush(); _lastSyncErrorMsg = ''; return 'no-change'; }
  try {
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'pull', docId: uid } });
    const r = res && res.result;
    if (!r) { _lastSyncErrorMsg = '云函数无返回'; return 'error'; }
    if (r.ok === false) { _lastSyncErrorMsg = r.error || 'fn ok=false'; return 'error'; }
    const remote = r.state || null;
    if (!remote) { _lastSyncErrorMsg = '云端无 state'; return 'no-change'; }
    if (pushTimer) { flushPendingPush(); return 'no-change'; }   // await 期间又产生了本地改动
    const before = _stateFingerprint(state);
    applyingRemote = true;
    state = sanitizeState(remote);
    applyingRemote = false;
    _initialPullOk = true;
    _lastKnownGoodTaskCount = (state.tasks || []).length;
    applyAllAppearance();
    renderAll();
    const after = _stateFingerprint(state);
    return (before !== after) ? 'updated' : 'no-change';
  } catch (e) {
    _lastSyncErrorMsg = (e && (e.message || e.code || String(e))) || 'unknown';
    console.warn('[pull-refresh]', e);
    return 'error';
  }
}

function emptyState() {
  return {
    folders: [], projects: [], taskLists: [], tasks: [],
    events: [], sessions: [], tags: [], smartLists: [], templates: [],
    summaries: [], summaryTags: [], summaryDayModules: {},
    concepts: [],   // Obsidian-style [[xxx]] 双向链接 (2026-05-27)
    settings: {}, currentSession: null,
  };
}
// sanitize 时如果发现需要 backfill 字段,把这个标志置 true,bindCloud 会触发一次 push 让云端自愈
let _stateNeedsBackfillPush = false;

function sanitizeState(s) {
  const e = emptyState();
  const arr = (v) => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
  const settings = (s.settings && typeof s.settings === 'object' && !Array.isArray(s.settings)) ? { ...s.settings } : {};
  if (settings.calShowDone      === undefined) settings.calShowDone      = true;
  if (settings.calShowFocus     === undefined) settings.calShowFocus     = true;
  if (settings.calShowAllRepeat === undefined) settings.calShowAllRepeat = true;
  if (settings.calColorMode     === undefined) settings.calColorMode     = 'project';
  if (settings.calMergeGapMin   === undefined) settings.calMergeGapMin   = 15;
  if (!Array.isArray(settings.mobileTabOrder))  settings.mobileTabOrder  = ['tasks','calendar','stats','timer','settings'];
  if (!Array.isArray(settings.mobileTabHidden)) settings.mobileTabHidden = [];

  // task / event 缺字段 backfill — 让旧版 mobile 创建的 task 也能通过桌面 4576 行的严格 === null 过滤
  const tasks = arr(s.tasks);
  let dirty = false;
  for (const t of tasks) {
    if (t.parentTaskId  === undefined) { t.parentTaskId  = null; dirty = true; }
    if (t.parentEventId === undefined) { t.parentEventId = null; dirty = true; }
    if (!Array.isArray(t.schedules)) {
      // 从 legacy 字段同步生成 schedules[0]
      if (t.start) {
        t.schedules = [{
          id: 'sl-' + Math.random().toString(36).slice(2, 10),
          kind: (t.end && t.end > t.start + 60000) ? 'range' : 'date',
          start: t.start, end: t.end || undefined,
          allDay: !!t.allDay, repeat: 'none', reminderOffset: null,
        }];
      } else {
        t.schedules = [];
      }
      dirty = true;
    }
    if (!Array.isArray(t.completedOccurrences)) { t.completedOccurrences = []; dirty = true; }
    if (t.kanbanColumn === undefined) { t.kanbanColumn = null; dirty = true; }
    if (t.order === undefined) { t.order = null; dirty = true; }
    if (!Array.isArray(t.tags)) { t.tags = []; dirty = true; }
    if (!Array.isArray(t.images)) { t.images = []; dirty = true; }
    // 重复任务:历史 t.done=true 残留 → 转成 occurrence-level 完成,t.done 清回 false
    // (对齐桌面 main.js:1131 的迁移)
    const isRecurring = (t.schedules || []).some(s => s && s.repeat && s.repeat !== 'none');
    if (t.done && isRecurring) {
      const sched = (t.schedules || []).find(s => s && s.start && s.repeat && s.repeat !== 'none');
      if (sched && t.doneAt) {
        // 走 occurrence 序列,找最后一个 ≤ doneAt 的实例
        let occ = new Date(sched.start);
        if (sched.repeat === 'workday' && (occ.getDay() === 0 || occ.getDay() === 6)) {
          do { occ.setDate(occ.getDate() + 1); } while (occ.getDay() === 0 || occ.getDay() === 6);
        }
        let lastOcc = null, safety = 5000;
        while (safety-- > 0 && occ.getTime() <= t.doneAt) {
          lastOcc = occ.getTime();
          const next = new Date(occ);
          if (sched.repeat === 'daily') next.setDate(next.getDate() + 1);
          else if (sched.repeat === 'weekly') next.setDate(next.getDate() + 7);
          else if (sched.repeat === 'monthly') next.setMonth(next.getMonth() + 1);
          else if (sched.repeat === 'workday') {
            do { next.setDate(next.getDate() + 1); } while (next.getDay() === 0 || next.getDay() === 6);
          } else break;
          occ = next;
        }
        if (lastOcc != null && !t.completedOccurrences.includes(lastOcc)) {
          t.completedOccurrences.push(lastOcc);
          t.completedOccurrences.sort((a, b) => a - b);
        }
      }
      t.done = false;
      t.doneAt = null;
      dirty = true;
    }
  }
  const events = arr(s.events);
  for (const ev of events) {
    if (!Array.isArray(ev.schedules)) {
      if (ev.start) {
        ev.schedules = [{
          id: 'sl-' + Math.random().toString(36).slice(2, 10),
          kind: (ev.end && ev.end > ev.start + 60000) ? 'range' : 'date',
          start: ev.start, end: ev.end || undefined,
          allDay: !!ev.allDay, repeat: 'none', reminderOffset: null,
        }];
      } else {
        ev.schedules = [];
      }
      dirty = true;
    }
    if (!Array.isArray(ev.tags)) { ev.tags = []; dirty = true; }
  }
  if (dirty) _stateNeedsBackfillPush = true;

  // 摘要笔记 + 标签库 + 按天的模块(对齐桌面 main.js 的 schema)
  const summaries = arr(s.summaries);
  for (const sum of summaries) {
    if (!Array.isArray(sum.tags))    sum.tags    = [];
    if (!Array.isArray(sum.images))  sum.images  = [];
    if (typeof sum.note !== 'string') sum.note   = '';
    if (typeof sum.title !== 'string') sum.title = '';   // 概要 (2026-05-27)
    if (!sum.createdAt) sum.createdAt = sum.updatedAt || Date.now();
    if (!sum.updatedAt) sum.updatedAt = sum.createdAt;
    if (sum.modules) delete sum.modules;
  }
  const summaryTags = arr(s.summaryTags);
  // 概念库 — Obsidian 风格 [[xxx]] 双向链接 (2026-05-27)
  const concepts = arr(s.concepts);
  for (const c of concepts) {
    if (!Array.isArray(c.aliases)) c.aliases = [];
    if (typeof c.description !== 'string') c.description = '';
  }
  const summaryDayModules = (s.summaryDayModules && typeof s.summaryDayModules === 'object' && !Array.isArray(s.summaryDayModules)) ? s.summaryDayModules : {};
  for (const k of Object.keys(summaryDayModules)) {
    if (!Array.isArray(summaryDayModules[k])) summaryDayModules[k] = [];
    for (const m of summaryDayModules[k]) {
      if (!Array.isArray(m.entries)) m.entries = [];
    }
  }
  // 文件夹补 kind 字段 — 老数据没设的视为 'project' 文件夹
  const _folders = arr(s.folders);
  for (const f of _folders) {
    if (!f.kind) f.kind = 'project';
  }

  return {
    ...e, ...s,
    folders: _folders, projects: arr(s.projects), taskLists: arr(s.taskLists),
    tasks, events, sessions: arr(s.sessions),
    tags: arr(s.tags), smartLists: arr(s.smartLists), templates: arr(s.templates),
    summaries, summaryTags, summaryDayModules,
    concepts,
    settings,
  };
}

// 是否子任务(挂在父任务下,不应该在顶级清单里平铺)
function _isChildTask(t) { return !!(t && (t.parentTaskId || t.parentEventId)); }
function _topLevelTasks(arr) { return (arr || []).filter(t => !_isChildTask(t)); }

// ===== 当前清单解析 =====
function getCurrentList() {
  if (!state) return { title: '任务', tasks: [], project: null };
  const { selectedKind, selectedId } = ui;
  if (selectedKind === 'smart-list') {
    const sl = (state.smartLists || []).find(x => x.id === selectedId);
    if (!sl) return { title: '所有任务', tasks: _topLevelTasks((state.tasks || []).filter(t => !t.archived)), project: null, kind: 'smart-list-fallback' };
    return { title: sl.name || '智能清单', tasks: _topLevelTasks(smartListTasks(sl)), project: null, kind: 'smart-list', smartList: sl };
  }
  if (selectedKind === 'tag') {
    return { title: '#' + selectedId, tasks: _topLevelTasks(state.tasks.filter(t => Array.isArray(t.tags) && t.tags.includes(selectedId))), project: null, kind: 'tag', tag: selectedId };
  }
  if (selectedKind === 'project') {
    const p = state.projects.find(x => x.id === selectedId);
    if (!p) return { title: '任务', tasks: [], project: null };
    return { title: p.name || '未命名', tasks: _topLevelTasks(state.tasks.filter(t => t.projectId === selectedId)), project: p, kind: 'project' };
  }
  if (selectedKind === 'folder') {
    const f = state.folders.find(x => x.id === selectedId);
    if (!f) return { title: '任务', tasks: [], project: null };
    const projIds = state.projects.filter(p => p.folderId === selectedId).map(p => p.id);
    return { title: f.name || '未命名文件夹', tasks: _topLevelTasks(state.tasks.filter(t => projIds.includes(t.projectId))), project: null, folder: f, kind: 'folder' };
  }
  // fallback:显示所有未归档任务
  return { title: '所有任务', tasks: _topLevelTasks((state.tasks || []).filter(t => !t.archived)), project: null, kind: 'smart-list-fallback' };
}
function taskHitDate(t, a, b) {
  if (t.archived) return false;
  if (t.dueAt && t.dueAt >= a && t.dueAt <= b) return true;
  if (t.start) {
    const e = t.end || t.start;
    if (t.start <= b && e >= a) return true;
  }
  return false;
}
function projectOf(t) { if (!t || !t.projectId) return null; return state.projects.find(p => p.id === t.projectId) || null; }

// ===== 智能清单 filter(从桌面端 _sl* 系列简化移植,只关心 task)=====
function _slMatchesSource(item, sources) {
  if (!sources || sources.length === 0) return true;
  for (const src of sources) {
    if (src === 'unsorted') { if (!item.projectId) return true; continue; }
    if (typeof src === 'string' && src.startsWith('folder:')) {
      const fid = src.slice(7);
      const proj = state.projects.find(p => p.id === item.projectId);
      if (proj && proj.folderId === fid) return true;
      continue;
    }
    if (item.projectId === src) return true;
  }
  return false;
}
function _slDateWindow(filter) {
  const today = startOfDay(new Date()).getTime();
  if (filter === 'today')    return [today, endOfDay(new Date(today)).getTime()];
  if (filter === 'tomorrow') return [today + 86400000, today + 86400000*2 - 1];
  if (filter === 'week')     return [startOfWeek(new Date(today)).getTime(), startOfWeek(new Date(today)).getTime() + 7*86400000 - 1];
  if (filter && typeof filter === 'object' && filter.from) return [filter.from, filter.to || (filter.from + 86400000 - 1)];
  return null;
}
function _slMatchesDate(t, filter) {
  if (!filter || filter === 'any') return true;
  const start = t.start || null;
  const end   = t.end   || null;
  if (filter === 'none')    return !start && !end && !t.dueAt;
  if (filter === 'overdue') {
    if (t.done) return false;
    const e = end || start || t.dueAt;
    return e != null && e < Date.now();
  }
  const win = _slDateWindow(filter);
  if (!win) return true;
  return taskHitDate(t, win[0], win[1]);
}
function _slMatchesKeyword(t, keyword) {
  if (!keyword) return true;
  const k = String(keyword).trim().toLowerCase();
  if (!k) return true;
  return String(t.title || '').toLowerCase().includes(k);
}
function _slMatchesType(types) {
  if (!types || types.length === 0 || types.includes('all') || types.includes('task')) return true;
  return false;
}
function smartListTasks(sl) {
  const f = sl.filters || {};
  if (!_slMatchesType(f.types)) return [];
  const tagFilter = Array.isArray(f.tags) ? f.tags : [];
  return (state.tasks || []).filter(t => {
    if (t.archived) return false;
    if (tagFilter.length && !tagFilter.some(tg => (t.tags || []).includes(tg))) return false;
    return _slMatchesSource(t, f.sources)
        && _slMatchesDate(t, f.date)
        && _slMatchesKeyword(t, f.keyword);
  });
}

// 底部 tab 注册表
const TAB_DEFS = {
  tasks:    { label: '任务', icon: 'ico-folder' },
  works:    { label: '项目', icon: 'ico-image' },
  calendar: { label: '日历', icon: 'ico-calendar' },
  summary:  { label: '摘要', icon: 'ico-pencil' },
  ledger:   { label: '账本', icon: 'ico-wallet' },
  stats:    { label: '统计', icon: 'ico-history' },
  timer:    { label: '计时', icon: 'ico-clock' },
  settings: { label: '设置', icon: 'ico-settings' },
};
function getMobileTabOrder() {
  const known = Object.keys(TAB_DEFS);
  const saved = (state && state.settings && state.settings.mobileTabOrder) || [];
  const filtered = saved.filter(id => known.includes(id) && id !== 'settings');
  // 把 known 中没有出现在 saved 的 tab(未来新加的)追加到末尾(settings 前)
  for (const id of known) if (id !== 'settings' && !filtered.includes(id)) filtered.push(id);
  filtered.push('settings'); // settings 永远固定最右
  return filtered;
}
function getMobileTabHiddenSet() {
  const arr = (state && state.settings && state.settings.mobileTabHidden) || [];
  const set = new Set(arr.filter(id => id !== 'settings')); // settings 不可隐藏
  return set;
}
function getVisibleMobileTabs() {
  const hidden = getMobileTabHiddenSet();
  return getMobileTabOrder().filter(id => !hidden.has(id));
}

// 默认标签色板(同桌面端 main.js TAG_COLORS)
const TAG_COLORS = ['#4cc26a','#e8a04a','#5aa6e8','#c66e5c','#8b6d8e','#5a8472','#d9a35a','#3f6b7c'];
function colorOfTag(tag) {
  const meta = (state && state.settings && Array.isArray(state.settings.tags))
    ? state.settings.tags.find(t => t && t.name === tag) : null;
  if (meta && meta.color) return meta.color;
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}
// 日历上某 task/event 显示什么颜色 — 受 state.settings.calColorMode 影响
function colorOfCalItem(item) {
  if (!item) return null;
  const byTag = state && state.settings && state.settings.calColorMode === 'tag';
  if (byTag && Array.isArray(item.tags) && item.tags.length) return colorOfTag(item.tags[0]);
  if (item.color) return item.color;
  const proj = projectOf(item);
  return proj && proj.color || null;
}

// ===== 渲染主入口 =====
function renderAll() {
  if (!state) return;
  const _renderT0 = Date.now();
  // 当前 tab 被隐藏了 → 自动切到第一个可见的
  const visible = getVisibleMobileTabs();
  if (!visible.includes(ui.tab)) ui.tab = visible[0] || 'tasks';
  try { applyTheme(); }   catch (e) { psLog('ERR', 'applyTheme throw', e); }
  try { renderTabBar(); } catch (e) { psLog('ERR', 'renderTabBar throw', e); }
  try { renderTopbar(); } catch (e) { psLog('ERR', 'renderTopbar throw', e); }
  try {
    const _tt0 = Date.now();
    renderTab(ui.tab);
    const _tEl = Date.now() - _tt0;
    if (_tEl > 200) psLog('WARN', 'renderTab slow tab=' + ui.tab, _tEl + 'ms');
  } catch (e) {
    psLog('ERR', 'renderTab throw tab=' + ui.tab, e);
    throw e;   // 让 _applyRemoteSnapshot / bindCloud 的 catch 接住
  }
  if ($('drawer-nav').classList.contains('open')) {
    try { renderDrawerNav(); } catch (e) { psLog('ERR', 'renderDrawerNav throw', e); }
  }
  if ($('drawer-right') && $('drawer-right').classList.contains('open')) {
    try { renderCalendarSidebar(); } catch (e) { psLog('ERR', 'renderCalendarSidebar throw', e); }
  }
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $('fab').classList.toggle('hidden', !(ui.tab === 'tasks' || ui.tab === 'calendar'
    || ui.tab === 'ledger'
    || (ui.tab === 'summary' && summaryState.tab !== 'data')));
  const _renderEl = Date.now() - _renderT0;
  if (_renderEl > 300) psLog('WARN', 'renderAll slow', _renderEl + 'ms tab=' + ui.tab);
}
function renderTabBar() {
  const bar = document.querySelector('.tabbar');
  if (!bar) return;
  bar.innerHTML = getVisibleMobileTabs().map(id => {
    const t = TAB_DEFS[id];
    return `<button class="tab" data-tab="${id}">
      <span class="tab-icon ${t.icon}"></span>
      <span class="tab-label">${esc(t.label)}</span>
    </button>`;
  }).join('');
  bar.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    const newTab = b.dataset.tab;
    // 切到日历 tab(也包括从日历切回日历)→ 重置 cursor 到今天 + 清掉 selected day +
    // 强制 day 模式(用户预期:进日历=看今日的时间轴),不会停在上次浏览的某周某月
    if (newTab === 'calendar') {
      ui.calCursor = Date.now();
      ui.calSelectedDay = null;
      ui.calMode = 'day';
    }
    ui.tab = newTab;
    ui.settingsPage = null;
    saveUI(); renderAll();
    // 切 tab 也顺带拉一次云(防 watcher silent 断线)
    if (typeof pullStateOnce === 'function' && uid) {
      try { pullStateOnce(); } catch (_) {}
    }
  }));
}
function renderTopbar() {
  const leftBtn = $('topbar-left-btn');
  // 离开日历 tab 时移除 cal-nav-row 类(防止 #topbar-title 被定型成 flex row,影响其它 tab 的标题显示)
  $('topbar-title').classList.remove('cal-nav-row');
  // 重置右上按钮的占位态(账本 tab 用它占位以保证标题居中)
  $('topbar-right-btn').classList.remove('topbar-btn-spacer');
  // 第二个右上按钮默认隐藏 — 只有项目 tab 用(视图切换)
  $('topbar-right-btn2').classList.add('hidden');
  if (ui.tab === 'tasks') {
    const cl = getCurrentList();
    const titleEl = $('topbar-title');
    const customIco = (cl.project && cl.project.icon)
      ? renderCustomIconHtml(cl.project.icon, 'topbar-title-ico', cl.project.color || '')
      : (cl.folder && cl.folder.icon)
        ? renderCustomIconHtml(cl.folder.icon, 'topbar-title-ico', '')
        : null;
    titleEl.innerHTML = (customIco || '') + esc(cl.title);
    $('topbar-subtitle').textContent = cl.tasks.length ? `${cl.tasks.filter(t=>!t.done).length} 待办 · ${cl.tasks.filter(t=>t.done).length} 已完成` : '';
    leftBtn.innerHTML = `<span class="ico-list"></span>`;
    leftBtn.setAttribute('aria-label', '清单');
    leftBtn.classList.remove('hidden');
    $('topbar-right-btn').classList.remove('hidden');
  } else if (ui.tab === 'calendar') {
    const c = new Date(ui.calCursor);
    let dateText;
    if (ui.calMode === 'month') dateText = `${c.getFullYear()} 年 ${c.getMonth()+1} 月`;
    else if (ui.calMode === 'week') {
      const ws = startOfWeek(c), we = addDays(ws, 6);
      dateText = `${ws.getMonth()+1}/${ws.getDate()} – ${we.getMonth()+1}/${we.getDate()}`;
    } else dateText = `${c.getMonth()+1} 月 ${c.getDate()} 日`;
    // 顶部标题改成 prev / 中间日期(=回今日按钮) / next 三段式 — 对齐桌面端 < 今天 > UI
    const titleEl = $('topbar-title');
    titleEl.classList.add('cal-nav-row');
    titleEl.innerHTML = `
      <button class="cal-nav-btn" data-action="cal-prev" aria-label="上一${ui.calMode==='month'?'月':ui.calMode==='week'?'周':'日'}"><span class="ico-chevron-left"></span></button>
      <button class="cal-nav-today" data-action="cal-today">${esc(dateText)}</button>
      <button class="cal-nav-btn" data-action="cal-next" aria-label="下一${ui.calMode==='month'?'月':ui.calMode==='week'?'周':'日'}"><span class="ico-chevron-right"></span></button>
    `;
    titleEl.querySelector('[data-action="cal-prev"]').onclick = (ev) => { ev.stopPropagation(); calNavigate(-1); };
    titleEl.querySelector('[data-action="cal-next"]').onclick = (ev) => { ev.stopPropagation(); calNavigate(1); };
    titleEl.querySelector('[data-action="cal-today"]').onclick = (ev) => {
      ev.stopPropagation();
      ui.calCursor = Date.now();
      ui.calSelectedDay = null;
      saveUI(); renderAll();
    };
    $('topbar-subtitle').textContent = ui.calMode === 'month' ? '月' : (ui.calMode === 'week' ? '周' : '日');
    // 日历 tab: 左按钮 = 视图切换(显示当前视图字)
    const label = ui.calMode === 'month' ? '月' : (ui.calMode === 'week' ? '周' : '日');
    leftBtn.innerHTML = `<span class="cal-view-switch-pill"><span class="cal-view-switch-label">${esc(label)}</span><span class="ico-chevron-down"></span></span>`;
    leftBtn.setAttribute('aria-label', '视图切换');
    leftBtn.classList.remove('hidden');
    $('topbar-right-btn').classList.remove('hidden');
  } else if (ui.tab === 'stats') {
    $('topbar-title').textContent = '统计'; $('topbar-subtitle').textContent = '';
    $('topbar-left-btn').classList.add('hidden'); $('topbar-right-btn').classList.add('hidden');
  } else if (ui.tab === 'works') {
    $('topbar-title').textContent = '项目';
    $('topbar-subtitle').textContent = _worksTabSubtitle();
    leftBtn.innerHTML = `<span class="ico-list"></span>`;
    leftBtn.setAttribute('aria-label', '分类');
    leftBtn.classList.remove('hidden');
    // 右上两个按钮:① 视图切换(点击直接在列表/相册间切,无菜单)② 排序(菜单)
    const isGallery = worksState.view === 'gallery';
    const viewBtn = $('topbar-right-btn2');
    viewBtn.innerHTML = `<span class="${isGallery ? 'ico-grid' : 'ico-list'}"></span>`;
    viewBtn.setAttribute('aria-label', isGallery ? '当前相册视图,点击切列表' : '当前列表视图,点击切相册');
    viewBtn.classList.remove('hidden');
    const rightBtn = $('topbar-right-btn');
    rightBtn.innerHTML = `<span class="ico-history"></span>`;
    rightBtn.setAttribute('aria-label', '排序');
    rightBtn.classList.remove('hidden');
  } else if (ui.tab === 'summary') {
    const sumIsData = summaryState.tab === 'data';
    const titleEl = $('topbar-title');
    // 当前筛选的 tag 名 — 在 tag 筛选下显示 #xxx 替代 "摘要" (Kayu 2026-05-27)
    let label = sumIsData ? '数据' : '摘要';
    const f = summaryState.filter || 'all';
    if (!sumIsData && f.startsWith('tag:')) {
      const tg = f.slice(4);
      if (tg) label = '#' + tg;
    }
    // 标题可点 → 切换 摘要 / 数据
    titleEl.innerHTML = `<button class="topbar-title-switch" data-action="summary-toggle-mode">${esc(label)}<span class="ico-chevron-down topbar-title-chev"></span></button>`;
    const tsw = titleEl.querySelector('[data-action="summary-toggle-mode"]');
    if (tsw) tsw.onclick = (ev) => {
      ev.stopPropagation();
      summaryState.tab = sumIsData ? 'summary' : 'data';
      renderAll();
    };
    $('topbar-subtitle').textContent = '';
    if (sumIsData) {
      leftBtn.classList.add('hidden');
      $('topbar-right-btn').classList.add('hidden');
    } else {
      leftBtn.innerHTML = `<span class="ico-list"></span>`;
      leftBtn.setAttribute('aria-label', '标签');
      leftBtn.classList.remove('hidden');
      const rightBtn = $('topbar-right-btn');
      rightBtn.innerHTML = `<span class="ico-search"></span>`;
      rightBtn.setAttribute('aria-label', '搜索');
      rightBtn.classList.remove('hidden');
      rightBtn.classList.toggle('active', !!summaryState.searchOpen);
    }
  } else if (ui.tab === 'ledger') {
    // 顶栏对齐日历:中间 = ‹ 期间日期(点击回本期)›,左上 = 月/季/年 切换 pill
    const lgWord = _ledgerViewWord();
    const titleEl = $('topbar-title');
    titleEl.classList.add('cal-nav-row');
    titleEl.innerHTML = `
      <button class="cal-nav-btn" data-action="lg-prev" aria-label="上一${lgWord}"><span class="ico-chevron-left"></span></button>
      <button class="cal-nav-today" data-action="lg-today">${esc(_ledgerViewLabel())}</button>
      <button class="cal-nav-btn" data-action="lg-next" aria-label="下一${lgWord}"><span class="ico-chevron-right"></span></button>
    `;
    titleEl.querySelector('[data-action="lg-prev"]').onclick = (ev) => { ev.stopPropagation(); _ledgerNav(-1); };
    titleEl.querySelector('[data-action="lg-next"]').onclick = (ev) => { ev.stopPropagation(); _ledgerNav(1); };
    titleEl.querySelector('[data-action="lg-today"]').onclick = (ev) => {
      ev.stopPropagation();
      const d = new Date();
      ledgerMState.monthTs = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      renderAll();
    };
    $('topbar-subtitle').textContent = lgWord;
    const lgViewLabel = ledgerMState.view === 'year' ? '年' : (ledgerMState.view === 'quarter' ? '季' : '月');
    leftBtn.innerHTML = `<span class="cal-view-switch-pill"><span class="cal-view-switch-label">${esc(lgViewLabel)}</span><span class="ico-chevron-down"></span></span>`;
    leftBtn.setAttribute('aria-label', '账本期间切换');
    leftBtn.classList.remove('hidden');
    // 右上无功能,但保留 40px 占位 — 否则中间日期不居中
    const lgRb = $('topbar-right-btn');
    lgRb.classList.remove('hidden');
    lgRb.classList.add('topbar-btn-spacer');
    lgRb.innerHTML = '';
  } else if (ui.tab === 'settings') {
    const subTitles = { appearance: '外观', system: '系统', templates: '模板', account: '账号', about: '关于' };
    if (ui.settingsPage && subTitles[ui.settingsPage]) {
      $('topbar-title').textContent = subTitles[ui.settingsPage];
      $('topbar-subtitle').textContent = '';
      leftBtn.innerHTML = `<span class="ico-chevron-left"></span>`;
      leftBtn.setAttribute('aria-label', '返回');
      leftBtn.classList.remove('hidden');
      $('topbar-right-btn').classList.add('hidden');
    } else {
      $('topbar-title').textContent = '设置';
      $('topbar-subtitle').textContent = '';
      leftBtn.classList.add('hidden');
      $('topbar-right-btn').classList.add('hidden');
    }
  }
}
function renderTab(tab) {
  const view = elView();
  // 切 tab 时清掉 view 上可能残留的 transform / scrollTop(防下拉刷新等手势之后切 tab,影响内部布局)
  if (view) {
    view.style.transform = '';
    view.style.transition = '';
    view.scrollTop = 0;
  }
  // 重置 pull-refresh indicator(防上次切走时还有 transform 残留)
  const _pri = document.getElementById('pull-refresh-indicator');
  if (_pri) {
    _pri.style.transform = '';
    _pri.style.opacity = '';
    _pri.classList.remove('ready', 'refreshing');
  }
  // 日历任务清单按钮 — 仅日历 tab 显示;切走时关掉抽屉
  if (typeof _ensureCalSideToggleBtn === 'function') _ensureCalSideToggleBtn();
  if (tab !== 'calendar' && ui.calSideOpen) closeCalSideDrawer();
  if (tab === 'tasks') return renderTasksTab(view);
  if (tab === 'works') return renderWorksTab(view);
  if (tab === 'calendar') return renderCalendarTab(view);
  if (tab === 'summary') return renderSummaryTab(view);
  if (tab === 'ledger') return renderLedgerTab(view);
  if (tab === 'stats') return renderStatsTab(view);
  if (tab === 'timer') return renderTimerTab(view);
  if (tab === 'settings') return renderSettingsTab(view);
}

// ============================================================
// ===== 摘要 tab(类 flomo)— 移动端完整实现,跟桌面 main.js 同款架构
// ============================================================

// === state ===
let summaryState = {
  tab: 'summary',              // 'summary' | 'data'
  filter: 'all',               // 'all' | 'tag:<name>'
  searchQuery: '',
  searchOpen: false,           // 顶栏搜索按钮控制的搜索框开关
  // 日期折叠状态 — 跨刷新保留(per-device UI 偏好,不走云端)
  collapsedDays: (() => {
    try { return new Set(JSON.parse(localStorage.getItem('psfocus_collapsedDays') || '[]')); }
    catch (_) { return new Set(); }
  })(),
  // 默认只渲染最近 N 天,余下点"加载更早"。iPhone Safari 的 tab 内存预算 ~384MB,
  // 用户有 100+ 个项目 + 大量摘要带云图时,20 天初始 HTML + 几百个 img DOM 节点 + observer
  // 容易把 BFCache 重渲那一瞬挤爆,Safari 直接 kill 标签。默认从 7 天起步,要看更早 tap 一下按钮。
  visibleDaysCount: 7,
  // 单天展开 — 默认每天只渲染最近 40 条,余下 tap 「显示本天更早」拉开
  expandedDays: new Set(),
  pendingImages: [],           // [{ id, cloudFileID, name }]
  pendingModuleValues: {},     // { [modId]: value/valueMs }
  draftNote: '',               // 输入框未发布的笔记草稿 — 防 renderAll 时清空
  draftTitle: '',              // 概要(title)草稿 — 同 draftNote 持久化
  modulePopoverForDay: null,   // sheet 形式打开时的 dayKey
  modulePickerOpenInPopover: false,
  expandedModuleCards: new Set(),
  // 输入框下方"今日 · 待录入"面板的折叠状态 — 跨刷新保留
  inputModsCollapsed: (() => { try { return localStorage.getItem('psfocus_inputModsCollapsed') === '1'; } catch (_) { return false; } })(),
  // tag 侧栏:父 tag 折叠子 tag 状态 — localStorage 持久化
  collapsedTags: (() => {
    try {
      const raw = localStorage.getItem('psfocus_sumCollapsedTags');
      if (raw == null) return new Set();
      return new Set(JSON.parse(raw));
    } catch (_) { return new Set(); }
  })(),
  // 大类折叠状态 — localStorage 跨刷新保留;首次默认「项目标签」折叠
  // (项目 tag 是时间轴自动生成的,通常一大堆,默认占视野不合理)
  collapsedSections: (() => {
    try {
      const raw = localStorage.getItem('psfocus_sumCollapsedSections');
      if (raw == null) return new Set(['project']);
      return new Set(JSON.parse(raw));
    } catch (_) { return new Set(['project']); }
  })(),
};

// === 辅助函数(对齐桌面 main.js)===
function _summaryDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function _summaryDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = (a, b) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  const yest = new Date(today); yest.setDate(yest.getDate()-1);
  if (sameDay(d, today)) return '今天';
  if (sameDay(d, yest)) return '昨天';
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
}
function _summaryEnsureTag(name) {
  if (!Array.isArray(state.summaryTags)) state.summaryTags = [];
  const parts = name.split('/').filter(Boolean);
  let acc = '';
  for (const p of parts) {
    acc = acc ? acc + '/' + p : p;
    if (!state.summaryTags.find(t => t.name === acc)) {
      const max = state.summaryTags.length ? Math.max(...state.summaryTags.map(x => x.order || 0)) : 0;
      state.summaryTags.push({ name: acc, pinned: false, color: '', order: max + 100 });
    }
  }
}
function _summaryParseTagsFromText(text) {
  const re = /#([^\s#,。、,]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const tg = m[1].trim();
    if (tg && !out.includes(tg)) out.push(tg);
  }
  return out;
}
function _summaryModulesForDay(dayKey) {
  if (!state.summaryDayModules) state.summaryDayModules = {};
  if (!Array.isArray(state.summaryDayModules[dayKey])) state.summaryDayModules[dayKey] = [];
  return state.summaryDayModules[dayKey];
}
// 让"今天"自动继承"最近一天"的模板(空 entries),实现"添加过的模块每天都在,无需每天单独加"
// 只在今天 key 完全不存在时跑一次;用户删了今天的模块后,本次不会自动恢复 — 明天 ensure 会照搬今天(含删除)
// 注:用"最近一天"(可能是空数组)而不是"最近有模块的一天" — 这样用户清空今天意图能传递到后续
function _summaryEnsureTodayHasTemplates() {
  const todayKey = _todayKey();
  if (!state.summaryDayModules) state.summaryDayModules = {};
  if (Object.prototype.hasOwnProperty.call(state.summaryDayModules, todayKey)) return;
  const keys = Object.keys(state.summaryDayModules).sort();
  const lastKey = keys[keys.length - 1];
  const template = (lastKey && Array.isArray(state.summaryDayModules[lastKey])) ? state.summaryDayModules[lastKey] : null;
  if (!template) { state.summaryDayModules[todayKey] = []; return; }
  state.summaryDayModules[todayKey] = template.map(m => {
    const out = {
      id: 'mod-' + Math.random().toString(36).slice(2, 10),
      kind: m.kind,
      title: m.title,
      entries: [],
    };
    if (m.max != null) out.max = m.max;
    if (m.source) out.source = m.source;
    if (m.taskId) out.taskId = m.taskId;
    return out;
  });
}
function _todayKey() { return _summaryDayKey(Date.now()); }
function _dayKeyToTs(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
function _newSummaryModule(kind) {
  const id = 'mod-' + Math.random().toString(36).slice(2, 10);
  if (kind === 'rating')   return { id, kind, title: '心情', max: 5, entries: [] };
  if (kind === 'duration') return { id, kind, title: '睡眠时长', source: 'manual', entries: [] };
  if (kind === 'checkin')  return { id, kind, title: '打卡', taskId: null };
  return null;
}
function _summaryFocusMsForDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0).getTime();
  const dayEnd = dayStart + 86400000;
  let total = 0;
  for (const s of (state.sessions || [])) {
    if (!s.startedAt) continue;
    if (s.startedAt < dayStart || s.startedAt >= dayEnd) continue;
    // 防御:单条 session > 16h 不合理(老 bug 留下的脏数据 — OS 休眠没被捕获),跳过不计
    const dur = s.duration || 0;
    if (dur > 16 * 3600_000) {
      console.warn('[summary] skip outlier session', s.id, Math.round(dur/3600000), 'h');
      continue;
    }
    total += dur;
  }
  return total;
}
function _summaryFmtDurationMs(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) ms = 0;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
function _summaryParseDuration(s) {
  if (!s) return 0;
  s = String(s).trim().toLowerCase();
  const mH = s.match(/(\d+(?:\.\d+)?)\s*h/);
  const mM = s.match(/(\d+(?:\.\d+)?)\s*m/);
  if (mH || mM) {
    const h = mH ? parseFloat(mH[1]) : 0;
    const m = mM ? parseFloat(mM[1]) : 0;
    return Math.round((h * 60 + m) * 60000);
  }
  const num = parseFloat(s);
  if (!isNaN(num)) return Math.round(num * 60000);
  return 0;
}
function _summaryFmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function _checkinCountForTask(taskId) {
  if (!taskId) return 0;
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t) return 0;
  return Array.isArray(t.completedOccurrences) ? t.completedOccurrences.length : 0;
}
function _isCheckinDoneToday(taskId) {
  if (!taskId) return false;
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t) return false;
  const today0 = startOfDay(new Date()).getTime();
  const today1 = today0 + 86400000;
  return (t.completedOccurrences || []).some(occ => occ >= today0 && occ < today1);
}

// markdown 渲染(同桌面)
function _renderSummaryNoteHtml(text) {
  let html = esc(text || '');
  const _PA = String.fromCharCode(0xE001);
  const _PB = String.fromCharCode(0xE002);
  html = html.replace(/\*\*([^\n]+?)\*\*/g, _PA + '$1' + _PB);
  html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<i>$1</i>');
  html = html.split(_PA).join('<b>').split(_PB).join('</b>');
  // 吞孤立未配对 ** — 配对的已被 bold regex 吃成 <b></b>; 剩下来的必然 unpaired
  html = html.replace(/\*\*/g, '');
  // [[xxx]] 概念链接 — 在 #tag 替换之前做, 防止 [[xxx]] 内含 # 被误抓
  html = html.replace(/\[\[([^\]\n]+?)\]\]/g, (m, name) =>
    '<span class="concept-link" data-action="concept-open" data-name="' + esc(name.trim()) + '">'
    + esc(name.trim()) + '</span>');
  // inline #xxx 转 clickable tag span(行级标题 "# " 形式跳过)
  html = html.replace(/(^|[^&\w])#([^\s#,。、,<&]+)/g, (m, before, tag) => {
    return before + '<span class="sum-md-tag" data-action="summary-filter" data-filter="tag:' + esc(tag) + '">#' + esc(tag) + '</span>';
  });
  const lines = html.split('\n');
  const out = [];
  let listKind = null;
  let inQuote = false;
  const closeList = () => { if (listKind) { out.push(`</${listKind}>`); listKind = null; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  for (const line of lines) {
    if (/^# (.+)$/.test(line)) {
      closeList(); closeQuote();
      out.push(`<h3 class="sum-md-h">${line.replace(/^# /, '')}</h3>`);
    } else if (/^&gt;\s?(.*)$/.test(line)) {
      // 注意:esc 已把 > 转成 &gt;
      closeList();
      if (!inQuote) { out.push('<blockquote class="sum-md-quote">'); inQuote = true; }
      const inner = line.replace(/^&gt;\s?/, '');
      out.push(`<div class="sum-md-line">${inner || '<br>'}</div>`);
    } else if (/^- (.+)$/.test(line)) {
      closeQuote();
      if (listKind !== 'ul') { closeList(); out.push('<ul class="sum-md-ul">'); listKind = 'ul'; }
      out.push(`<li>${line.replace(/^- /, '')}</li>`);
    } else if (/^\d+\. (.+)$/.test(line)) {
      closeQuote();
      if (listKind !== 'ol') { closeList(); out.push('<ol class="sum-md-ol">'); listKind = 'ol'; }
      out.push(`<li>${line.replace(/^\d+\. /, '')}</li>`);
    } else {
      closeList(); closeQuote();
      if (line.trim()) out.push(`<div class="sum-md-line">${line}</div>`);
      else out.push('<div class="sum-md-blank"></div>');
    }
  }
  closeList(); closeQuote();
  return out.join('');
}

// === 主渲染 ===
function renderSummaryTab(view) {
  // 进 tab 时让"今天"自动继承前一天的模板(若今天还没设过)
  _summaryEnsureTodayHasTemplates();
  const isData = summaryState.tab === 'data';
  view.innerHTML = `<div class="sum-view">
    ${(!isData && summaryState.searchOpen)
      ? `<div class="sum-search-row">
           <span class="ico-search sum-search-ico"></span>
           <input type="text" class="sum-search" placeholder="搜索摘要…" value="${esc(summaryState.searchQuery)}" data-action-input="summary-search-input">
         </div>`
      : ''}
    ${isData
      ? `<div class="sum-data-empty">
          <div class="sum-data-empty-title">数据</div>
          <div class="sum-data-empty-hint">敬请期待 — 这里会展示模块多日趋势</div>
        </div>`
      : `<div class="sum-main">
           <div class="sum-list">${_renderSummaryList()}</div>
         </div>`
    }
  </div>`;
  if (!isData && summaryState.searchOpen) {
    const si = view.querySelector('.sum-search');
    if (si) setTimeout(() => si.focus(), 60);
  }
  // 异步加载摘要里的云图 — 跟 task detail 共用 bindCloudTimelineImages
  if (typeof bindCloudTimelineImages === 'function') bindCloudTimelineImages(view);
}

// 摘要输入面板 — 浮动 FAB 点开的底部输入(参考 flomo:不常驻,用时弹出)
function openSummaryInputSheet() {
  // 在某个 tag 筛选下激活输入框 → 自动把该 tag 预填到草稿,
  // 这样新发的笔记天然就被打上这个标签,不用每次手动 # 一遍
  // 仅当 draft 为空时预填,避免覆盖用户已写的草稿
  _summaryPrefillFilterTagIfEmpty();
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content sum-input-sheet">
      ${_renderSummaryInputBox()}
    </div>
  `, (body) => {
    const ed = body.querySelector('.sum-input');
    if (ed) {
      ed.addEventListener('paste', _summaryHandlePaste);
      ed.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (actions['summary-submit']) actions['summary-submit']();
        }
      });
      ed.focus();
      _caretToEnd(ed);
      // 草稿非空 (用户之前写过/粘过) → 编辑框初始就很高, iOS Safari contenteditable
      // 的 overflow:auto 不一定生效, 工具栏+发送键会被推出 sheet 可视区。
      // sheet 打开后把工具栏 scroll 回视野, 保证发送键永远可见
      setTimeout(() => {
        try {
          const tb = body.querySelector('.sum-input-toolbar');
          if (tb && tb.scrollIntoView) tb.scrollIntoView({ block: 'end', behavior: 'auto' });
        } catch (_) {}
      }, 80);
    }
    // 工具栏按钮 mousedown 阻止默认焦点转移 — 编辑器不失焦,选区保住,
    // execCommand 才能正确作用于当前选区(WYSIWYG 标准做法)
    body.querySelectorAll('.sum-input-toolbar .sum-tb-btn').forEach(b => {
      b.addEventListener('mousedown', e => e.preventDefault());
    });
    if (typeof bindCloudTimelineImages === 'function') bindCloudTimelineImages(body);
  });
}

function _summaryPrefillFilterTagIfEmpty() {
  const f = summaryState.filter || '';
  if (!f.startsWith('tag:')) return;
  const tagName = f.slice(4);
  if (!tagName) return;
  const draft = summaryState.draftNote || '';
  // 草稿空 → 直接预填 "#tag "
  if (!draft.trim()) { summaryState.draftNote = '#' + tagName + ' '; return; }
  // 草稿非空但已经带了 #tag → 不重复加
  // 用 (^|非词) 边界判断, 防 #日记 被 #日 命中
  const re = new RegExp('(^|[^A-Za-z0-9_\\u4e00-\\u9fa5])#' + tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_\\u4e00-\\u9fa5])');
  if (re.test(draft)) return;
  // 草稿非空且没带 — 前缀加上, 用户在 tag 筛选下打开输入框就期望发到这个 tag
  summaryState.draftNote = '#' + tagName + ' ' + draft;
}

function _renderSummaryTagBar() {
  // 字典序排:子标签紧跟父级,避免 order 字段把不同父的标签穿插
  const tags = (state.summaryTags || []).slice().sort((a,b) => (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN'));
  // 项目时间轴加图自动生成的「项目名 tag」单独成一段,排在我的自建 tag 之后,中间用分隔标签隔开
  const _projNamesForTag = new Set((state.projects || []).map(p => p && p.name).filter(Boolean));
  const _isProjectSumTag = (name) => !!name && _projNamesForTag.has(name.split('/')[0]);
  const projectTags = tags.filter(t => _isProjectSumTag(t.name));
  const userTags    = tags.filter(t => !_isProjectSumTag(t.name));
  const chipOf = (tg) => {
    const active = summaryState.filter === ('tag:' + tg.name);
    return `<button class="sum-chip ${active?'active':''}" data-action="summary-filter" data-filter="tag:${esc(tg.name)}">#${esc(tg.name)}</button>`;
  };
  const chips = [`<button class="sum-chip ${summaryState.filter==='all'?'active':''}" data-action="summary-filter" data-filter="all">全部</button>`];
  for (const tg of userTags) chips.push(chipOf(tg));
  if (projectTags.length) {
    chips.push(`<span class="sum-chip-sep" title="以下为项目时间轴自动生成的标签">项目</span>`);
    for (const tg of projectTags) chips.push(chipOf(tg));
  }
  return chips.join('');
}

function _renderSummaryInputBox() {
  const pendingImgs = summaryState.pendingImages.map(im => `<div class="sum-pending-img" data-img-id="${esc(im.id)}">
    <img data-cloud-file-id="${esc(im.cloudFileID)}" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=">
    <button class="sum-pending-img-x" data-action="summary-pending-img-del" data-img-id="${esc(im.id)}">×</button>
  </div>`).join('');
  // 输入框下方录入区(只 rating/duration,checkin 不录入)
  // 折叠面板 — 折叠状态记 localStorage,跨刷新保留
  const todayKey = _todayKey();
  const todayMods = _summaryModulesForDay(todayKey).filter(m => m.kind === 'rating' || m.kind === 'duration');
  const inputModsCollapsed = !!summaryState.inputModsCollapsed;
  const todayModsHtml = todayMods.length ? `<div class="sum-input-day-mods ${inputModsCollapsed ? 'collapsed' : ''}">
    <button class="sum-input-day-mods-head" data-action="summary-toggle-input-mods" type="button">
      <span class="sum-input-day-mods-chev">${inputModsCollapsed ? '▶' : '▼'}</span>
      <span class="sum-input-day-mods-label">今日 · 待录入 <span class="sum-input-day-mods-count">(${todayMods.length})</span></span>
    </button>
    <div class="sum-input-day-mods-body">
      ${todayMods.map(m => _renderSummaryModuleEditor(m, todayKey)).join('')}
    </div>
  </div>` : '';
  const hasPending = Object.keys(summaryState.pendingModuleValues || {}).length > 0;
  const draft = summaryState.draftNote || '';
  const draftTitle = summaryState.draftTitle || '';
  // 2026-05-27 textarea + 预览框 → contenteditable WYSIWYG。Kayu 要实时看效果不分两块。
  // 编辑器 IS 预览:粗体直接显示加粗、标题直接显示大字。底层保存还是 markdown 串。
  // 概要 (title) 输入 — 概念页反链里会高亮显示 (Kayu 2026-05-27)
  return `<div class="sum-input-card ${hasPending ? 'has-pending-modules' : ''}">
    <div class="sum-input" contenteditable="true"
      data-action-input="summary-input-autosize">${_mdToEditHtml(draft)}</div>
    ${pendingImgs ? `<div class="sum-input-pending">${pendingImgs}</div>` : ''}
    ${todayModsHtml}
    <div class="sum-input-toolbar">
      <button class="sum-tb-btn" data-action="summary-tb-tag" title="加标签 #"><span class="sum-tb-hash">#</span></button>
      <label class="sum-tb-btn sum-tb-img" title="上传图片">
        <input type="file" accept="image/*" multiple data-action="summary-upload-image" hidden>
        <span class="ico-image"></span>
      </label>
      <button class="sum-tb-btn sum-tb-more" data-action="summary-tb-more" title="更多"><span class="ico-more"></span></button>
      <div class="sum-input-spacer"></div>
      <button class="sum-input-submit" data-action="summary-submit" title="发布">→</button>
    </div>
  </div>`;
}

// 取摘要输入框 — contenteditable div (优先 sheet 里的, 避免误打到主视图同名 class)
// 2026-05-27 textarea + 独立预览框 → contenteditable WYSIWYG 重构,Kayu 要实时显示不分两块
function _summaryInputTa() {
  return document.querySelector('#sheet-body .sum-input')
      || document.querySelector('.sum-input');
}

// ===== Markdown <-> contenteditable HTML 双向转换 =====
// 保存格式仍是 markdown 字符串(summaryState.draftNote / state.summaries[].note),
// 编辑器渲染时 md → editable HTML, input 事件时反向 HTML → md 同步回 draftNote。
function _mdToEditHtml(md) {
  const txt = String(md || '');
  if (!txt) return '<div><br></div>';
  const _e = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _inline = (s) => {
    let h = _e(s);
    const _PA = '', _PB = '';
    h = h.replace(/\*\*([^\n]+?)\*\*/g, _PA + '$1' + _PB);
    h = h.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<i>$1</i>');
    h = h.split(_PA).join('<b>').split(_PB).join('</b>');
    // 吞孤立未配对 ** 防 unpaired 字面跑到编辑器
    h = h.replace(/\*\*/g, '');
    // [[xxx]] 概念链接 chip — span 内文本就是 [[xxx]], _editHtmlToMd 读 textContent 就 round-trip
    h = h.replace(/\[\[([^\]\n]+?)\]\]/g, (m, name) => {
      const n = name.trim();
      return '<span class="concept-link concept-link-edit" data-action="concept-open" data-name="'
        + n.replace(/"/g, '&quot;') + '">[[' + n + ']]</span>';
    });
    // #xxx tag chip — contenteditable=false 让它整体作为一个原子单元 (backspace 一下就整块删)
    // 落到 md 时 _editNodeToMd 走 span fallback 读 textContent = "#xxx" 还原成普通 #xxx 文本
    h = h.replace(/(^|[^&\w一-龥])#([^\s#,。、,<&]+)/g, (m, before, tag) => {
      return before + '<span class="sum-md-tag tag-chip-edit" contenteditable="false">#' + tag + '</span>';
    });
    return h;
  };
  const lines = txt.split('\n');
  const blocks = [];
  let listType = null, listItems = [];
  let quoteLines = null;          // 连续 > 行 → 同一个 <blockquote>
  const flushList = () => {
    if (listType) {
      blocks.push('<' + listType + '>' + listItems.join('') + '</' + listType + '>');
      listType = null; listItems = [];
    }
  };
  const flushQuote = () => {
    if (quoteLines) {
      blocks.push('<blockquote>' + quoteLines.join('') + '</blockquote>');
      quoteLines = null;
    }
  };
  for (const line of lines) {
    if (/^# (.+)$/.test(line)) {
      flushList(); flushQuote();
      blocks.push('<h3>' + _inline(line.slice(2)) + '</h3>');
    } else if (/^>\s?(.*)$/.test(line)) {
      flushList();
      if (!quoteLines) quoteLines = [];
      const inner = line.replace(/^>\s?/, '');
      quoteLines.push('<div>' + (inner.trim() ? _inline(inner) : '<br>') + '</div>');
    } else if (/^- (.+)$/.test(line)) {
      flushQuote();
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listItems.push('<li>' + _inline(line.slice(2)) + '</li>');
    } else if (/^\d+\. (.+)$/.test(line)) {
      flushQuote();
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listItems.push('<li>' + _inline(line.replace(/^\d+\. /, '')) + '</li>');
    } else {
      flushList(); flushQuote();
      blocks.push(line.trim() ? '<div>' + _inline(line) + '</div>' : '<div><br></div>');
    }
  }
  flushList(); flushQuote();
  return blocks.join('') || '<div><br></div>';
}

function _editHtmlToMd(root) {
  if (!root) return '';
  let md = '';
  for (const child of root.childNodes) md += _editNodeToMd(child);
  return md.replace(/\n+$/, '');
}
function _editNodeToMd(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'b' || tag === 'strong') {
    const inner = _editHtmlToMd(node);
    return inner ? '**' + inner + '**' : '';
  }
  if (tag === 'i' || tag === 'em') {
    const inner = _editHtmlToMd(node);
    return inner ? '*' + inner + '*' : '';
  }
  if (/^h[1-6]$/.test(tag)) return '# ' + _editHtmlToMd(node) + '\n';
  if (tag === 'ul') {
    let out = '';
    for (const li of node.children) {
      if (li.tagName.toLowerCase() === 'li') out += '- ' + _editHtmlToMd(li) + '\n';
    }
    return out;
  }
  if (tag === 'ol') {
    let i = 1, out = '';
    for (const li of node.children) {
      if (li.tagName.toLowerCase() === 'li') { out += i + '. ' + _editHtmlToMd(li) + '\n'; i++; }
    }
    return out;
  }
  if (tag === 'blockquote') {
    // 内部按 div / 文本拆行, 每行前缀 "> "
    const inner = _editHtmlToMd(node).replace(/\n+$/, '');
    const lines = inner.split('\n');
    return lines.map(l => '> ' + l).join('\n') + '\n';
  }
  if (tag === 'div' || tag === 'p') {
    const inner = _editHtmlToMd(node);
    return inner + (inner.endsWith('\n') ? '' : '\n');
  }
  // span, font 等 inline — 仅取内容
  return _editHtmlToMd(node);
}

// contenteditable 里:在当前光标处插入纯文本
function _insertTextAtCaret(text) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    try { document.execCommand('insertText', false, text); } catch (_) {}
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// 光标移到 contenteditable 末尾(替代 textarea.setSelectionRange)
function _caretToEnd(el) {
  if (!el) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// 同步 contenteditable 内容 → 对应的 state(主输入 draftNote / 编辑 modalState.value)
function _syncEditorToState(ed) {
  if (!ed) return;
  const md = _editHtmlToMd(ed);
  if (ed.id === 'sum-edit-note-text') {
    summaryState._editingNoteMd = md;
  } else if (ed.id === 'concept-desc-input') {
    // 概念描述编辑
    const cid = ed.dataset.conceptId;
    const c = (state.concepts || []).find(x => x.id === cid);
    if (c) { c.description = md; c.updatedAt = Date.now(); }
  } else {
    summaryState.draftNote = md;
  }
}

// ===== 概念 [[xxx]] (Obsidian 风格 双向链接, 2026-05-27) =====
function _findConcept(name) {
  if (!name || !Array.isArray(state.concepts)) return null;
  const n = String(name).trim();
  for (const c of state.concepts) {
    if (c.name === n) return c;
    if (Array.isArray(c.aliases) && c.aliases.indexOf(n) >= 0) return c;
  }
  return null;
}
function _ensureConcept(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const found = _findConcept(n);
  if (found) return found;
  if (!Array.isArray(state.concepts)) state.concepts = [];
  const c = {
    id: 'cpt-' + Math.random().toString(36).slice(2, 10),
    name: n, aliases: [], description: '', color: '',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.concepts.push(c);
  return c;
}
function _extractWikilinks(text) {
  const out = [];
  const re = /\[\[([^\]\n]+?)\]\]/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const n = m[1].trim();
    if (n) out.push(n);
  }
  return out;
}
function _extractBacklinks(concept) {
  if (!concept) return [];
  const names = [concept.name].concat(concept.aliases || []).filter(Boolean);
  if (!names.length) return [];
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reAlt = names.map(escRe).join('|');
  const re = new RegExp('\\[\\[(' + reAlt + ')\\]\\]');
  const out = [];
  // (1) summaries
  for (const s of (state.summaries || [])) {
    const note = s.note || '';
    const m = note.match(re);
    if (!m) continue;
    const idx = m.index;
    out.push({
      summary: s,
      ts: s.createdAt || 0,
      context: note.slice(Math.max(0, idx - 30), idx) + m[0] + note.slice(idx + m[0].length, idx + m[0].length + 30),
    });
  }
  // (2) 别的概念的描述里引用本概念 — Obsidian 标准的概念间双向链接
  for (const c of (state.concepts || [])) {
    if (c === concept || c.id === concept.id) continue;
    const desc = c.description || '';
    const m = desc.match(re);
    if (!m) continue;
    const idx = m.index;
    out.push({
      concept: c,
      ts: c.updatedAt || 0,
      context: desc.slice(Math.max(0, idx - 30), idx) + m[0] + desc.slice(idx + m[0].length, idx + m[0].length + 30),
    });
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}
function _extractUnlinkedMentions(concept) {
  if (!concept) return [];
  const names = [concept.name].concat(concept.aliases || []).filter(Boolean);
  if (!names.length) return [];
  // 跳过 [[...]] 区段查找 name 位置 — 否则刚包过的还会显示成 "未链接" 重复
  const findUnwrappedIdx = (note, name) => {
    let i = 0;
    while (i < note.length) {
      if (note.startsWith('[[', i)) {
        const end = note.indexOf(']]', i + 2);
        if (end === -1) { i++; continue; }
        i = end + 2;
        continue;
      }
      if (note.startsWith(name, i)) return i;
      i++;
    }
    return -1;
  };
  const out = [];
  for (const s of (state.summaries || [])) {
    const note = s.note || '';
    for (const n of names) {
      const noteIdx = findUnwrappedIdx(note, n);
      if (noteIdx < 0) continue;
      const before = note.slice(Math.max(0, noteIdx - 30), noteIdx);
      const after  = note.slice(noteIdx + n.length, noteIdx + n.length + 30);
      out.push({
        summary: s, name: n,
        context: before + '〚' + n + '〛' + after,
        noteIdx,
      });
      break;
    }
  }
  out.sort((a, b) => (b.summary.createdAt || 0) - (a.summary.createdAt || 0));
  return out;
}
function _wrapMentionWithLink(summaryId, name) {
  const s = (state.summaries || []).find(x => x.id === summaryId);
  if (!s || !s.note) return false;
  // 把所有未包的同名出现都包成 [[name]], 跳过已经在 [[...]] 内的
  // (Kayu 2026-05-27: 之前只包第一处, 同一笔记有多处时未链接条目不消失)
  let out = '';
  let i = 0;
  let changed = false;
  while (i < s.note.length) {
    if (s.note.startsWith('[[', i)) {
      const end = s.note.indexOf(']]', i + 2);
      if (end === -1) { out += s.note[i]; i++; continue; }
      out += s.note.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (s.note.startsWith(name, i)) {
      out += '[[' + name + ']]';
      i += name.length;
      changed = true;
      continue;
    }
    out += s.note[i];
    i++;
  }
  if (!changed) return false;
  s.note = out;
  s.updatedAt = Date.now();
  return true;
}
function _renameOrMergeConcept(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const oldC = _findConcept(oldName);
  if (!oldC) return;
  const dup = (state.concepts || []).find(c => c !== oldC && c.name === newName);
  const doApply = () => {
    if (dup) {
      const set = new Set(dup.aliases || []);
      for (const a of (oldC.aliases || [])) set.add(a);
      set.add(oldName);
      dup.aliases = Array.from(set);
      if (oldC.description && !dup.description) dup.description = oldC.description;
      else if (oldC.description) dup.description += '\n\n' + oldC.description;
      dup.updatedAt = Date.now();
      state.concepts = state.concepts.filter(c => c !== oldC);
    } else {
      oldC.name = newName;
      oldC.updatedAt = Date.now();
    }
    const escRe = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\[\\[' + escRe + '\\]\\]', 'g');
    for (const s of (state.summaries || [])) {
      if (!s.note || !re.test(s.note)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      s.note = s.note.replace(re, '[[' + newName + ']]');
      s.updatedAt = Date.now();
    }
    pushState();
    renderAll();
  };
  if (dup) {
    const msg = '已存在概念 [[' + newName + ']]。\n'
      + '继续将把 [[' + oldName + ']] 合并进 [[' + newName + ']]:\n'
      + '· 笔记里所有 [[' + oldName + ']] 改为 [[' + newName + ']]\n'
      + '· 旧名 "' + oldName + '" 自动作为别名\n'
      + '· 旧描述追加到新描述末尾';
    if (typeof showConfirm === 'function') {
      showConfirm({ title: '合并概念', message: msg, okText: '合并', onOk: doApply });
    } else if (confirm(msg + '\n\n确定合并?')) {
      doApply();
    }
  } else {
    doApply();
  }
}

// 用 _savedTaSel 兜底:格式按钮 tap 时 textarea 短暂失焦,iOS 可能 selectionStart 归零;
// 我们在 textarea blur 时保存最后一次 sel,format 触发时若发现 sel=0..0 且我们有备份就还原
let _savedTaSel = null;
function _restoreTaSelIfBlurred(ta) {
  if (!ta || !_savedTaSel) return;
  if ((ta.selectionStart || 0) === 0 && (ta.selectionEnd || 0) === 0
      && (ta.value || '').length > 0) {
    try { ta.setSelectionRange(_savedTaSel.start, _savedTaSel.end); } catch (_) {}
  }
}

// 同步 ta.value → draftNote 并刷新预览块 + 重排高度;
// 任何修改 textarea 的格式按钮都得调它,否则:
//   1) draftNote 滞后 → renderAll 重新挂载时撤销了用户的格式编辑
//   2) 预览块跟手输入不一致
function _syncDraftFromTa(ta) {
  if (!ta) return;
  summaryState.draftNote = ta.value;
  try { _refreshSummaryInputPreview(); } catch (_) {}
  try {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  } catch (_) {}
}

// 刷新输入框下方的实时预览 — 内容空时显示 hint,有内容时渲染 markdown
function _refreshSummaryInputPreview() {
  const preview = document.getElementById('sum-input-preview');
  if (!preview) return;
  const v = summaryState.draftNote || '';
  if (v.trim() && typeof _renderSummaryNoteHtml === 'function') {
    preview.innerHTML = _renderSummaryNoteHtml(v);
    preview.classList.remove('sum-input-preview-empty');
  } else {
    preview.innerHTML = '<span class="sum-input-preview-hint">预览效果会显示在这里</span>';
    preview.classList.add('sum-input-preview-empty');
  }
}

function _renderSummaryModuleEditor(m, dayKey) {
  const dataAttrs = `data-day-key="${esc(dayKey)}" data-mod-id="${esc(m.id)}"`;
  // 标题改成可编辑 input — input 事件实时保存(blur 不可靠,iOS 上有时不触发),blur 兜底
  const titleHtml = `<input class="sum-mod-editor-title-input" type="text" ${dataAttrs}
    value="${esc(m.title || '')}"
    data-action-input="summary-mod-edit-title"
    data-action-blur="summary-mod-edit-title"
    placeholder="标题"
    autocomplete="off"
    autocorrect="off"
    autocapitalize="off"
    spellcheck="false">`;
  const delBtn = `<button class="sum-mod-editor-del" ${dataAttrs} data-action="summary-mod-del" title="删除此模块">×</button>`;
  if (m.kind === 'rating') {
    const max = Math.max(1, parseInt(m.max, 10) || 5);
    const pending = summaryState.pendingModuleValues[m.id];
    const pendingNum = (pending != null) ? Math.max(0, Math.min(max, parseInt(pending, 10))) : null;
    let dotsHtml = '';
    for (let i = 1; i <= max; i++) {
      const filled = pendingNum != null && i <= pendingNum;
      dotsHtml += `<button class="sum-mod-dot ${filled?'filled':''}" ${dataAttrs} data-action="summary-rating-pending" data-i="${i}">●</button>`;
    }
    // 满分:/N 可编辑
    const maxHtml = `<input class="sum-mod-editor-max-input" type="number" min="1" max="20" step="1" ${dataAttrs}
      data-action-blur="summary-mod-edit-max"
      value="${max}"
      title="改满分">`;
    return `<div class="sum-mod-editor">
      ${titleHtml}
      <div class="sum-mod-rating-dots">${dotsHtml}</div>
      <span class="sum-mod-editor-slash">/</span>${maxHtml}
      ${delBtn}
    </div>`;
  }
  if (m.kind === 'duration') {
    const isAuto = m.source === 'focus';
    // 来源切换 — 一个小 pill,点切换 manual ↔ focus
    const sourceBtn = `<button class="sum-mod-editor-src-btn ${isAuto?'auto':''}" ${dataAttrs}
      data-action="summary-mod-toggle-src"
      title="${isAuto?'点切到手填':'点切到自动(读专注时长)'}">${isAuto?'自动':'手填'}</button>`;
    if (isAuto) {
      return `<div class="sum-mod-editor">
        ${titleHtml}
        ${sourceBtn}
        ${delBtn}
      </div>`;
    }
    const pending = summaryState.pendingModuleValues[m.id];
    const pendingMs = (pending != null) ? (parseInt(pending, 10) || 0) : null;
    // 分两栏 h + m,跟编辑详情同款 — 单字段「7h30m」解析在 render 重渲染时会把输入裁断,改成 number 双框稳
    const pendingH = pendingMs != null ? Math.floor(pendingMs / 3600000) : '';
    const pendingM = pendingMs != null ? Math.floor((pendingMs % 3600000) / 60000) : '';
    return `<div class="sum-mod-editor">
      ${titleHtml}
      <input class="sum-mod-duration-h" type="number" min="0" max="24" step="1" inputmode="numeric" ${dataAttrs}
        data-action-input="summary-duration-pending-hm"
        value="${pendingH === '' ? '' : pendingH}" placeholder="时">
      <span class="sum-mod-editor-unit">h</span>
      <input class="sum-mod-duration-m" type="number" min="0" max="59" step="1" inputmode="numeric" ${dataAttrs}
        data-action-input="summary-duration-pending-hm"
        value="${pendingM === '' ? '' : pendingM}" placeholder="分">
      <span class="sum-mod-editor-unit">m</span>
      ${sourceBtn}
      ${delBtn}
    </div>`;
  }
  return '';
}

function _renderSummaryList() {
  const filter = summaryState.filter || 'all';
  const q = (summaryState.searchQuery || '').toLowerCase().trim();
  let list = (state.summaries || []).slice();
  if (filter.startsWith('tag:')) {
    const tg = filter.slice(4);
    list = list.filter(s => (s.tags || []).some(x => x === tg || x.startsWith(tg + '/')));
  }
  if (q) {
    list = list.filter(s =>
      (s.note || '').toLowerCase().includes(q) ||
      (s.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const byDay = new Map();
  for (const s of list) {
    const k = _summaryDayKey(s.createdAt);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  // 收集所有"有活动"的天:笔记 / session / 模块 / 今天
  // 过滤模式(tag / search)下只看笔记 days,避免无关空 day 干扰筛选结果
  const activeDays = new Set(byDay.keys());
  if (filter === 'all' && !q) {
    for (const s of (state.sessions || [])) {
      if (s.startedAt) activeDays.add(_summaryDayKey(s.startedAt));
    }
    for (const k of Object.keys(state.summaryDayModules || {})) {
      const arr = state.summaryDayModules[k];
      if (Array.isArray(arr) && arr.length) activeDays.add(k);
    }
    activeDays.add(_todayKey());
  }
  if (!activeDays.size) {
    return `<div class="sum-empty">${q || filter !== 'all' ? '没有符合的笔记' : '还没有笔记 — 上面输入框写一条'}</div>`;
  }
  const maxDays = Math.max(1, summaryState.visibleDaysCount || 20);
  let sortedKeys, moreDays;
  if (filter === 'all' && !q) {
    // 主视图:从今天往回连续 N 天(空天也显示 — 可点铅笔补录)+ 更早的活跃天
    const now = new Date();
    const contiguous = [];
    for (let i = 0; i < maxDays; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      contiguous.push(_summaryDayKey(d.getTime()));
    }
    const cutoffKey = contiguous[contiguous.length - 1];
    const olderActiveSorted = Array.from(activeDays).filter(k => k < cutoffKey).sort().reverse();
    const olderShown = olderActiveSorted.slice(0, maxDays);
    moreDays = olderActiveSorted.length - olderShown.length;
    sortedKeys = contiguous.concat(olderShown);
  } else {
    // 搜索 / 筛选:只显示有结果的天,不补空
    const sortedAllKeys = Array.from(activeDays).sort().reverse();
    sortedKeys = sortedAllKeys.slice(0, maxDays);
    moreDays = sortedAllKeys.length - sortedKeys.length;
  }
  let html = '';
  // 每天最多先渲染 N 条;余下 tap 「显示本天更早」展开。
  // 防止某天写了几百条笔记带云图 → DOM 太大把 iPhone Safari 内存挤爆
  const PER_DAY_INIT = 40;
  for (const k of sortedKeys) {
    const items = byDay.get(k) || [];
    const hasNotes = items.length > 0;
    const collapsed = summaryState.collapsedDays.has(k);
    const refTs = hasNotes ? items[0].createdAt : _dayKeyToTs(k);
    const dayLabel = _summaryDayLabel(refTs);
    const modSummary = _renderSummaryDayHeaderModules(k);
    const editBtn = `<button class="sum-day-edit-btn" data-action="summary-day-edit" data-day-key="${esc(k)}" title="编辑此天的模块"><span class="ico-pencil"></span></button>`;
    if (hasNotes) {
      const expanded = summaryState.expandedDays && summaryState.expandedDays.has(k);
      const visibleItems = expanded ? items : items.slice(0, PER_DAY_INIT);
      const hiddenCount  = items.length - visibleItems.length;
      const moreBtn = hiddenCount > 0
        ? `<button class="sum-day-more-in" data-action="summary-expand-day" data-day-key="${esc(k)}">显示本天更早 (${hiddenCount} 条)</button>`
        : '';
      html += `<div class="sum-day ${collapsed?'collapsed':''}">
        <div class="sum-day-header">
          <button class="sum-day-toggle" data-action="summary-toggle-day" data-day-key="${esc(k)}">
            <span class="sum-day-chev">${collapsed ? '▶' : '▼'}</span>
            <span class="sum-day-label">${dayLabel}</span>
            <span class="sum-day-count">${items.length} 条</span>
          </button>
          ${editBtn}
          ${modSummary ? `<div class="sum-day-mods">${modSummary}</div>` : ''}
        </div>
        ${collapsed ? '' : `<div class="sum-day-body">
          <div class="sum-day-items">${visibleItems.map(_renderSummaryItem).join('')}</div>
          ${moreBtn}
        </div>`}
      </div>`;
    } else {
      // 无笔记:只显示 header,不显示 chevron / count / body
      html += `<div class="sum-day sum-day-empty">
        <div class="sum-day-header">
          <div class="sum-day-toggle sum-day-toggle-static">
            <span class="sum-day-chev-spacer"></span>
            <span class="sum-day-label">${dayLabel}</span>
          </div>
          ${editBtn}
          ${modSummary ? `<div class="sum-day-mods">${modSummary}</div>` : ''}
        </div>
      </div>`;
    }
  }
  if (moreDays > 0) {
    html += `<button class="sum-day-load-more" data-action="summary-load-more">查看更早(还有 ${moreDays} 天)</button>`;
  }
  return html;
}

function _renderSummaryItem(s) {
  // tag chip 行不再单独渲染 — note 里的 #xxx 已被转 clickable;只为 orphan tag(没出现在 note 里)显示
  const noteTagsInText = new Set();
  const noteText = s.note || '';
  let mm;
  const tagRe = /#([^\s#,。、,]+)/g;
  while ((mm = tagRe.exec(noteText)) !== null) noteTagsInText.add(mm[1].trim());
  const orphanTags = (s.tags || []).filter(tg => !noteTagsInText.has(tg));
  const tagsHtml = orphanTags.map(tg => `<span class="sum-item-tag" data-action="summary-filter" data-filter="tag:${esc(tg)}">#${esc(tg)}</span>`).join(' ');
  const imagesHtml = (s.images || []).length
    ? `<div class="sum-item-images">${(s.images||[]).map(im => `<img class="sum-item-image" data-cloud-file-id="${esc(im.cloudFileID)}" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=">`).join('')}</div>`
    : '';
  const tStr = new Date(s.createdAt).toLocaleString('zh-CN');
  return `<div class="sum-item" data-summary-id="${esc(s.id)}">
    <div class="sum-item-meta">
      <span class="sum-item-time">${esc(tStr)}</span>
      <button class="sum-item-more" data-action="summary-item-more" data-id="${esc(s.id)}">⋯</button>
    </div>
    ${(s.note||'').trim() ? `<div class="sum-item-note">${_renderSummaryNoteHtml(s.note)}</div>` : ''}
    ${tagsHtml ? `<div class="sum-item-tags">${tagsHtml}</div>` : ''}
    ${imagesHtml}
  </div>`;
}

function _renderSummaryDayHeaderModules(dayKey) {
  const parts = [];
  const focusMs = _summaryFocusMsForDay(dayKey);
  // 始终显示专注 chip — 0 显示 "—"(用户:"专注时长 0 也要记录")
  parts.push(`<span class="sum-day-mod sum-day-mod-focus">专注 ${focusMs > 0 ? _summaryFmtDurationMs(focusMs) : '—'}</span>`);
  const mods = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
  for (const m of mods) {
    let txt = '';
    const dataAttrs = `data-day-key="${esc(dayKey)}" data-mod-id="${esc(m.id)}"`;
    if (m.kind === 'rating') {
      const max = m.max || 5;
      const entries = m.entries || [];
      const count = entries.length;
      if (count) {
        // 多条 → 平均值;单条 → 该值
        const avg = entries.reduce((sum, e) => sum + (e.value || 0), 0) / count;
        const avgStr = count > 1 ? avg.toFixed(1) : String(entries[0].value || 0);
        txt = `${m.title || '打分'} ${avgStr}/${max}${count > 1 ? ` <span class="sum-day-mod-extra">平均 ×${count}</span>` : ''}`;
      } else {
        txt = `${m.title || '打分'} —`;
      }
    } else if (m.kind === 'duration') {
      if (m.source === 'focus') continue;
      const entries = m.entries || [];
      const count = entries.length;
      if (count) {
        // 多条 → 平均值;单条 → 该值
        const total = entries.reduce((sum, e) => sum + (e.valueMs || 0), 0);
        const avg = total / count;
        const display = count > 1 ? _summaryFmtDurationMs(avg) : _summaryFmtDurationMs(total);
        txt = `${m.title || '时长'} ${display}${count > 1 ? ` <span class="sum-day-mod-extra">平均 ×${count}</span>` : ''}`;
      } else {
        txt = `${m.title || '时长'} —`;
      }
    } else if (m.kind === 'checkin') {
      const done = _isCheckinDoneToday(m.taskId);
      txt = `${m.title || '打卡'} ${done?'✓':'○'}`;
    }
    // 改成 button:点击弹详情 sheet,列出当天该模块的所有 entries
    if (txt) parts.push(`<button class="sum-day-mod sum-day-mod-clickable" data-action="summary-mod-detail" ${dataAttrs} title="查看 / 编辑详情">${txt}</button>`);
  }
  return parts.join('');
}

// 打开模块管理 sheet(手机版用底部 sheet 替代桌面的 popover)
// 编辑某天的全部模块 — 跟 _openSummaryModSheet 的 picker 不同,这里是完整管理面板
function _openSummaryDayEditSheet(dayKey) {
  const dayMods = _summaryModulesForDay(dayKey);
  const cardsHtml = dayMods.length
    ? dayMods.map(m => _renderSummaryModuleCard(m, dayKey)).join('')
    : '<div style="color:var(--text-dim);font-size:13px;padding:14px 0;text-align:center;">该天还没有模块</div>';
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 4px;">${esc(_summaryDayLabel(_dayKeyToTs(dayKey)))} · 模块编辑</div>
      <div style="color:var(--text-dim);font-size:11px;margin-bottom:10px;">改标题/满分/来源,展开看历史 entries,× 删模块</div>
      <div class="sum-mod-popover-cards">${cardsHtml}</div>
      <div style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;">
        <button class="sum-mod-picker-item" data-action="summary-add-module" data-kind="rating" data-day-key="${esc(dayKey)}" style="flex:1;min-width:0;border:1px dashed var(--border-soft);border-radius:8px;padding:8px;background:var(--bg-section);">
          <span class="ico-target sum-mod-picker-icon"></span> 打分
        </button>
        <button class="sum-mod-picker-item" data-action="summary-add-module" data-kind="duration" data-day-key="${esc(dayKey)}" style="flex:1;min-width:0;border:1px dashed var(--border-soft);border-radius:8px;padding:8px;background:var(--bg-section);">
          <span class="ico-clock sum-mod-picker-icon"></span> 时长
        </button>
        <button class="sum-mod-picker-item" data-action="summary-add-module" data-kind="checkin" data-day-key="${esc(dayKey)}" style="flex:1;min-width:0;border:1px dashed var(--border-soft);border-radius:8px;padding:8px;background:var(--bg-section);">
          <span class="ico-check sum-mod-picker-icon"></span> 打卡
        </button>
      </div>
    </div>
  `);
}
// 小菜单 — 只 3 项 add;管理(改名/删除)用每个 editor 的 × 按钮
function _openSummaryModSheet(dayKey) {
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 8px;">加模块</div>
      <div class="sum-mod-picker sum-mod-picker-vertical">
        <button class="sum-mod-picker-item" data-action="summary-add-module" data-kind="rating"   data-day-key="${esc(dayKey)}"><span class="ico-target sum-mod-picker-icon"></span><span>打分模块</span></button>
        <button class="sum-mod-picker-item" data-action="summary-add-module" data-kind="duration" data-day-key="${esc(dayKey)}"><span class="ico-clock sum-mod-picker-icon"></span><span>时长模块</span></button>
        <button class="sum-mod-picker-item" data-action="summary-add-module" data-kind="checkin"  data-day-key="${esc(dayKey)}"><span class="ico-check sum-mod-picker-icon"></span><span>打卡模块</span></button>
      </div>
    </div>
  `);
}

function _renderSummaryModuleCard(m, dayKey) {
  const dataAttrs = `data-day-key="${esc(dayKey)}" data-mod-id="${esc(m.id)}"`;
  const expanded = summaryState.expandedModuleCards.has(m.id);
  const kindLabel = m.kind === 'rating' ? '打分' : m.kind === 'duration' ? '时长' : '打卡';
  const titleHtml = `<input class="sum-mod-title-input" type="text" ${dataAttrs}
    data-action-blur="summary-mod-edit-title" value="${esc(m.title || '')}" placeholder="标题">`;
  const delBtn = `<button class="sum-mod-del" ${dataAttrs} data-action="summary-mod-del">×</button>`;
  const expandBtn = `<button class="sum-mod-expand" ${dataAttrs} data-action="summary-mod-toggle-expand">${expanded ? '▴' : '▾'}</button>`;
  let detailsHtml = '';
  if (expanded) {
    if (m.kind === 'rating') {
      const max = Math.max(1, parseInt(m.max, 10) || 5);
      const entries = m.entries || [];
      // 补加一条:点 dot 即立即写入
      let addDots = '';
      for (let i = 1; i <= max; i++) {
        addDots += `<button class="sum-mod-add-dot" ${dataAttrs} data-action="summary-mod-add-entry-rating" data-value="${i}">${i}</button>`;
      }
      const addRow = `<div class="sum-mod-add-row">
        <span class="sum-mod-add-label">+ 加一条</span>
        <div class="sum-mod-add-dots">${addDots}</div>
      </div>`;
      detailsHtml = `<div class="sum-mod-card-details">
        <label class="sum-mod-meta-label">满分
          <input class="sum-mod-rating-max" type="number" min="1" max="20" step="1" ${dataAttrs}
            data-action-blur="summary-mod-edit-max" value="${max}"></label>
        ${entries.length ? `<div class="sum-mod-entries">${entries.map(e => `
          <span class="sum-mod-entry sum-mod-entry-editable">
            <input class="sum-mod-entry-val-input" type="number" min="1" max="${max}" step="1" inputmode="numeric"
              value="${e.value}" ${dataAttrs} data-entry-id="${esc(e.id)}"
              data-action-blur="summary-mod-entry-edit-rating">
            <span class="sum-mod-entry-slash">/${max}</span>
            <span class="sum-mod-entry-time">${_summaryFmtTime(e.at)}</span>
            <button class="sum-mod-entry-del" ${dataAttrs} data-action="summary-mod-entry-del" data-entry-id="${esc(e.id)}">×</button>
          </span>`).join('')}</div>` : '<div class="sum-mod-empty">还没有记录</div>'}
        ${addRow}
      </div>`;
    } else if (m.kind === 'duration') {
      const isAuto = m.source === 'focus';
      const entries = isAuto ? null : (m.entries || []);
      const addRow = isAuto ? '' : `<div class="sum-mod-add-row">
        <span class="sum-mod-add-label">+ 加一条</span>
        <input class="sum-mod-add-h" type="number" min="0" max="24" step="1" ${dataAttrs} placeholder="时" inputmode="numeric">
        <input class="sum-mod-add-m" type="number" min="0" max="59" step="1" ${dataAttrs} placeholder="分" inputmode="numeric">
        <button class="sum-mod-add-btn" ${dataAttrs} data-action="summary-mod-add-entry-duration">添加</button>
      </div>`;
      detailsHtml = `<div class="sum-mod-card-details">
        <label class="sum-mod-meta-label">来源
          <select class="sum-mod-duration-source" ${dataAttrs} data-action-change="summary-mod-edit-source">
            <option value="manual" ${!isAuto?'selected':''}>手动</option>
            <option value="focus"  ${ isAuto?'selected':''}>自动:专注</option>
          </select></label>
        ${isAuto
          ? '<div class="sum-mod-empty">自动来源 — 实时算,不存历史</div>'
          : (entries.length ? `<div class="sum-mod-entries">${entries.map(e => {
              const totalMin = Math.round((e.valueMs || 0) / 60000);
              const eh = Math.floor(totalMin / 60);
              const em = totalMin % 60;
              return `<span class="sum-mod-entry sum-mod-entry-editable">
                <input class="sum-mod-entry-h-input" type="number" min="0" max="24" step="1" inputmode="numeric"
                  value="${eh}" ${dataAttrs} data-entry-id="${esc(e.id)}"
                  data-action-blur="summary-mod-entry-edit-duration">
                <span class="sum-mod-entry-unit">h</span>
                <input class="sum-mod-entry-m-input" type="number" min="0" max="59" step="1" inputmode="numeric"
                  value="${em}" ${dataAttrs} data-entry-id="${esc(e.id)}"
                  data-action-blur="summary-mod-entry-edit-duration">
                <span class="sum-mod-entry-unit">m</span>
                <span class="sum-mod-entry-time">${_summaryFmtTime(e.at)}</span>
                <button class="sum-mod-entry-del" ${dataAttrs} data-action="summary-mod-entry-del" data-entry-id="${esc(e.id)}">×</button>
              </span>`;
            }).join('')}</div>` : '<div class="sum-mod-empty">还没有记录</div>')}
        ${addRow}
      </div>`;
    } else if (m.kind === 'checkin') {
      const t = m.taskId ? (state.tasks || []).find(x => x.id === m.taskId) : null;
      const taskName = t ? (t.title || '未命名任务') : '未关联';
      const doneToday = _isCheckinDoneToday(m.taskId);
      const total = _checkinCountForTask(m.taskId);
      detailsHtml = `<div class="sum-mod-card-details">
        <button class="sum-mod-checkin-pick" ${dataAttrs} data-action="summary-mod-pick-task">${esc(taskName)}</button>
        <span class="sum-mod-checkin-status ${doneToday?'done':''}">${doneToday ? '✓ 已打卡' : '○ 未打卡'}</span>
        <span class="sum-mod-checkin-streak">累计 ${total} 天</span>
      </div>`;
    }
  }
  return `<div class="sum-mod-card ${expanded?'expanded':''}">
    <div class="sum-mod-card-head">
      <span class="sum-mod-kind-tag">${kindLabel}</span>
      ${titleHtml}
      ${expandBtn}
      ${delBtn}
    </div>
    ${detailsHtml}
  </div>`;
}

// ===== Tag 联想 (输入 # 立即弹, 模糊匹配, 选中后插入 chip) =====
// state + helpers, action 里在 input 事件后调 _tagSuggestUpdate(editor)
let _tagSuggest = { open: false, query: '', editor: null, selectedIdx: 0, items: [] };

// 找当前光标所在的 #xxx token, 返回 {range, text} 或 null
function _tagSuggestCurrentToken(editor) {
  if (!editor) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!r.collapsed) return null;
  if (!editor.contains(r.startContainer)) return null;
  const node = r.startContainer;
  if (node.nodeType !== 3) return null;
  const text = node.textContent || '';
  const caret = r.startOffset;
  // 从光标向前走找最近的 #, 不能跨空白
  let i = caret - 1;
  while (i >= 0 && !/[\s　#]/.test(text[i])) i--;
  // 找到 # 还是空白?要求是 # 且前面是行首/空白/非词字符
  if (i < 0 || text[i] !== '#') {
    // i 可能停在空格, 看看再往前是不是 #
    // 但 token 不允许有空格, 直接 fail
    return null;
  }
  // # 前一个字符必须是空白 / 行首 / 标点 (避免 a#b 这种误命中)
  if (i > 0) {
    const prev = text[i - 1];
    if (/[A-Za-z0-9_一-龥]/.test(prev)) return null;
  }
  const tagText = text.slice(i + 1, caret);
  if (/\s/.test(tagText)) return null;
  const range = document.createRange();
  range.setStart(node, i);
  range.setEnd(node, caret);
  return { range, text: tagText, node, startOffset: i, endOffset: caret };
}

function _tagSuggestMatching(query) {
  const all = ((state && state.summaryTags) || []).map(t => t.name).filter(Boolean);
  if (!query) return all.slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).slice(0, 30);
  const q = query.toLowerCase();
  const scored = [];
  for (const name of all) {
    const lower = name.toLowerCase();
    const segs = name.split('/');
    const lastSeg = segs[segs.length - 1].toLowerCase();
    // 评分:整名以 query 开头 0, 末段以 query 开头 1, 整名/段含 query 2
    let score = -1;
    if (lower.startsWith(q)) score = 0;
    else if (lastSeg.startsWith(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (segs.some(s => s.toLowerCase().includes(q))) score = 3;
    if (score >= 0) scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return scored.slice(0, 30).map(x => x.name);
}

function _tagSuggestClose() {
  if (!_tagSuggest.open) return;
  _tagSuggest.open = false;
  _tagSuggest.editor = null;
  const host = document.getElementById('tag-suggest-host');
  if (host) host.innerHTML = '';
}

function _tagSuggestRender(editor) {
  let host = document.getElementById('tag-suggest-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'tag-suggest-host';
    document.body.appendChild(host);
  }
  if (!_tagSuggest.open || !_tagSuggest.items.length) {
    host.innerHTML = '';
    return;
  }
  const items = _tagSuggest.items.map((name, i) => {
    const isSel = i === _tagSuggest.selectedIdx;
    return `<button type="button" class="tag-suggest-item ${isSel ? 'active' : ''}" data-tag-suggest-pick="${esc(name)}">
      <span class="tag-suggest-hash">#</span><span class="tag-suggest-name">${esc(name)}</span>
    </button>`;
  }).join('');
  host.innerHTML = `<div class="tag-suggest-popup">${items}</div>`;
  // 定位:editor 上方, 跟键盘 + 工具栏错开
  const editorRect = editor.getBoundingClientRect();
  const popup = host.querySelector('.tag-suggest-popup');
  popup.style.left = Math.max(8, editorRect.left) + 'px';
  popup.style.bottom = Math.max(8, window.innerHeight - editorRect.top + 8) + 'px';
  popup.style.maxWidth = Math.min(window.innerWidth - 16, Math.max(220, editorRect.width)) + 'px';
  // 绑定 click — mousedown 阻止默认免得 editor 失焦
  host.querySelectorAll('[data-tag-suggest-pick]').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    btn.addEventListener('click', () => _tagSuggestPick(btn.dataset.tagSuggestPick));
  });
}

function _tagSuggestUpdate(editor) {
  const token = _tagSuggestCurrentToken(editor);
  if (!token) { _tagSuggestClose(); return; }
  _tagSuggest.editor = editor;
  _tagSuggest.query = token.text;
  _tagSuggest.items = _tagSuggestMatching(token.text);
  _tagSuggest.selectedIdx = 0;
  _tagSuggest.open = true;
  _tagSuggestRender(editor);
}

function _tagSuggestPick(tagName) {
  const editor = _tagSuggest.editor;
  if (!editor || !tagName) { _tagSuggestClose(); return; }
  const token = _tagSuggestCurrentToken(editor);
  if (!token) { _tagSuggestClose(); return; }
  // 删 token 文本, 插 chip span + 尾巴 space
  const r = document.createRange();
  r.setStart(token.node, token.startOffset);
  r.setEnd(token.node, token.endOffset);
  r.deleteContents();
  const chip = document.createElement('span');
  chip.className = 'sum-md-tag tag-chip-edit';
  chip.setAttribute('contenteditable', 'false');
  chip.textContent = '#' + tagName;
  r.insertNode(chip);
  // 在 chip 后插 space + 移光标到 space 之后
  const space = document.createTextNode(' ');
  chip.parentNode.insertBefore(space, chip.nextSibling);
  const sel = window.getSelection();
  const nr = document.createRange();
  nr.setStart(space, 1);
  nr.collapse(true);
  sel.removeAllRanges();
  sel.addRange(nr);
  // 同步到 state (chip 用 textContent '#xxx', _editHtmlToMd 走 span fallback 读 textContent → 还原成 #xxx)
  if (typeof _syncEditorToState === 'function') _syncEditorToState(editor);
  _tagSuggestClose();
  editor.focus();
}

// 全局 keydown / pointerdown 兜底关 popup
document.addEventListener('keydown', (e) => {
  if (!_tagSuggest.open) return;
  if (e.key === 'Escape') { e.preventDefault(); _tagSuggestClose(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _tagSuggest.selectedIdx = (_tagSuggest.selectedIdx + 1) % _tagSuggest.items.length;
    _tagSuggestRender(_tagSuggest.editor);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    _tagSuggest.selectedIdx = (_tagSuggest.selectedIdx - 1 + _tagSuggest.items.length) % _tagSuggest.items.length;
    _tagSuggestRender(_tagSuggest.editor);
    return;
  }
  if (e.key === 'Enter') {
    if (_tagSuggest.items.length) {
      e.preventDefault();
      _tagSuggestPick(_tagSuggest.items[_tagSuggest.selectedIdx]);
    }
  }
}, true);
document.addEventListener('pointerdown', (e) => {
  if (!_tagSuggest.open) return;
  const popup = document.querySelector('.tag-suggest-popup');
  if (popup && popup.contains(e.target)) return;
  if (_tagSuggest.editor && _tagSuggest.editor.contains(e.target)) return;
  _tagSuggestClose();
}, true);

// === actions ===
const _summaryActions = {
  'summary-set-tab': (el) => {
    summaryState.tab = el.dataset.tab || 'summary';
    renderAll();
  },
  'summary-filter': (el) => {
    summaryState.filter = el.dataset.filter || 'all';
    // 在 drawer 里点的话也要关掉 drawer(全局 dispatcher 在这里跑;_renderSummaryDrawerNav 的 local listener 先关了 drawer 就不重复)
    if (document.getElementById('drawer-nav').classList.contains('open')) closeDrawerNav();
    renderAll();
  },
  // 单个 module chip 点击 → 弹详情 sheet,列出当天该模块所有 entries(可单条删)
  'summary-mod-detail': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId  = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod) return;
    const entries = mod.entries || [];
    const kindLabel = mod.kind === 'rating' ? '打分' : mod.kind === 'duration' ? '时长' : '打卡';
    const max = mod.max || 5;
    showSheet(`
      <div class="sheet-handle"></div>
      <div class="sheet-content">
        <div class="section-title" style="padding:0 0 4px;">${esc(mod.title || kindLabel)}</div>
        <div style="color:var(--text-dim);font-size:11px;margin-bottom:10px;">${kindLabel} · ${esc(_summaryDayLabel(_dayKeyToTs(dayKey)))}</div>
        ${entries.length ? `<div class="sum-mod-detail-list">
          ${entries.map(e => `
            <div class="sum-mod-detail-entry">
              <span class="sum-mod-detail-val">${mod.kind === 'rating' ? `${e.value}/${max}` : _summaryFmtDurationMs(e.valueMs)}</span>
              <span class="sum-mod-detail-time">${_summaryFmtTime(e.at)}</span>
              <button class="sum-mod-detail-del" data-action="summary-mod-entry-del" data-day-key="${esc(dayKey)}" data-mod-id="${esc(modId)}" data-entry-id="${esc(e.id)}" title="删除此条">×</button>
            </div>
          `).join('')}
        </div>` : '<div style="color:var(--text-dim);font-size:13px;padding:14px 0;text-align:center;">还没有记录</div>'}
        <button class="modal-btn" data-action="summary-day-edit-from-detail" data-day-key="${esc(dayKey)}" style="margin-top:14px;width:100%;">编辑此天模块</button>
      </div>
    `);
  },
  // 从详情 sheet 跳到 day-edit
  'summary-day-edit-from-detail': (el) => {
    closeSheet();
    setTimeout(() => {
      _summaryActions['summary-day-edit']({ dataset: { dayKey: el.dataset.dayKey } });
    }, 100);
  },
  // 编辑当天 — 弹 sheet,列出所有模块卡片(标题/满分/source 可编辑,entries 可删),+ 加模块按钮
  'summary-day-edit': (el) => {
    const dayKey = el.dataset.dayKey;
    if (!dayKey) return;
    summaryState.modulePopoverForDay = dayKey;
    summaryState._dayEditOpen = dayKey;     // 标记当前在 day-edit 上下文
    _openSummaryDayEditSheet(dayKey);
  },
  // tag 子层级折叠
  'summary-tag-toggle-collapse': (el, e) => {
    if (e) e.stopPropagation();
    const t = el.dataset.tag;
    if (!t) return;
    if (!summaryState.collapsedTags) summaryState.collapsedTags = new Set();
    if (summaryState.collapsedTags.has(t)) summaryState.collapsedTags.delete(t);
    else summaryState.collapsedTags.add(t);
    try {
      localStorage.setItem('psfocus_sumCollapsedTags',
        JSON.stringify(Array.from(summaryState.collapsedTags)));
    } catch (_) {}
    _renderSummaryDrawerNav();
  },
  // 大分类(置顶/项目/全部)折叠 — localStorage 持久化跨刷新保留
  'summary-section-toggle': (el) => {
    const k = el.dataset.section;
    if (!k) return;
    if (!summaryState.collapsedSections) summaryState.collapsedSections = new Set();
    if (summaryState.collapsedSections.has(k)) summaryState.collapsedSections.delete(k);
    else summaryState.collapsedSections.add(k);
    try {
      localStorage.setItem('psfocus_sumCollapsedSections',
        JSON.stringify(Array.from(summaryState.collapsedSections)));
    } catch (_) {}
    _renderSummaryDrawerNav();
  },
  // ===== 概念 [[xxx]] 双向链接 actions =====
  'concept-open': (el) => {
    const id = el.dataset.conceptId;
    const name = el.dataset.name;
    let c = null;
    if (id) c = (state.concepts || []).find(x => x.id === id);
    if (!c && name) c = _ensureConcept(name);
    if (!c) return;
    // drawer 打开同时关闭可能开着的左侧 nav drawer
    try { closeDrawerNav(); } catch (_) {}
    _openConceptSheet(c.id);
  },
  'concept-close': () => { try { closeSheet(); } catch (_) {} },
  'concept-desc-input': (el, e) => {
    if (e && e.isComposing) return;
    const id = el.dataset.conceptId;
    const c = (state.concepts || []).find(x => x.id === id);
    if (!c) return;
    if (el._syncRAF) cancelAnimationFrame(el._syncRAF);
    el._syncRAF = requestAnimationFrame(() => {
      el._syncRAF = null;
      c.description = _editHtmlToMd(el);
      c.updatedAt = Date.now();
      // 描述里的 [[xxx]] 自动建概念 — 概念间互链一等公民
      const wl = _extractWikilinks(c.description);
      for (const wn of wl) _ensureConcept(wn);
      pushState();
    });
  },
  'concept-rename': (el) => {
    const id = el.dataset.conceptId;
    const c = (state.concepts || []).find(x => x.id === id);
    if (!c) return;
    const newName = String(el.value || '').trim();
    if (!newName || newName === c.name) { el.value = c.name; return; }
    _renameOrMergeConcept(c.name, newName);
  },
  'concept-delete': (el) => {
    const id = el.dataset.conceptId;
    const c = (state.concepts || []).find(x => x.id === id);
    if (!c) return;
    if (!confirm('删除概念 [[' + c.name + ']]?\n笔记里 [[' + c.name + ']] 文本不会自动删除。')) return;
    state.concepts = (state.concepts || []).filter(x => x.id !== id);
    pushState();
    closeSheet();
    renderAll();
  },
  'concept-add-alias': (el) => {
    const id = el.dataset.conceptId;
    const c = (state.concepts || []).find(x => x.id === id);
    if (!c) return;
    const a = (prompt('为 [[' + c.name + ']] 添加别名:', '') || '').trim();
    if (!a || a === c.name) return;
    const collide = (state.concepts || []).find(x => x !== c &&
      (x.name === a || (x.aliases || []).indexOf(a) >= 0));
    if (collide) { showToast && showToast('「' + a + '」已被 [[' + collide.name + ']] 占用'); return; }
    if (!Array.isArray(c.aliases)) c.aliases = [];
    if (c.aliases.indexOf(a) < 0) c.aliases.push(a);
    c.updatedAt = Date.now();
    pushState();
    _openConceptSheet(c.id);   // 重渲 sheet
  },
  'concept-remove-alias': (el) => {
    const id = el.dataset.conceptId;
    const a = el.dataset.alias;
    const c = (state.concepts || []).find(x => x.id === id);
    if (!c || !Array.isArray(c.aliases)) return;
    c.aliases = c.aliases.filter(x => x !== a);
    c.updatedAt = Date.now();
    pushState();
    _openConceptSheet(c.id);
  },
  'concept-goto-summary': (el) => {
    const sid = el.dataset.summaryId;
    if (!sid) return;
    const s = (state.summaries || []).find(x => x.id === sid);
    if (!s) { closeSheet(); return; }
    closeSheet();
    // 清筛选 + 扩可见窗口 + 展开该天, 防止 target 不在 DOM 里点不到
    summaryState.searchQuery = '';
    summaryState.filter = 'all';
    const targetDayKey = _summaryDayKey(s.createdAt);
    const today0 = startOfDay(new Date()).getTime();
    const target0 = startOfDay(new Date(s.createdAt || Date.now())).getTime();
    const daysAgo = Math.max(0, Math.round((today0 - target0) / 86400000));
    const needDays = daysAgo + 1;
    if ((summaryState.visibleDaysCount || 7) < needDays) {
      summaryState.visibleDaysCount = needDays + 5;
    }
    if (!summaryState.expandedDays) summaryState.expandedDays = new Set();
    summaryState.expandedDays.add(targetDayKey);
    if (summaryState.collapsedDays) summaryState.collapsedDays.delete(targetDayKey);
    renderAll();
    // 即时(非 smooth)滚到位置, 老笔记很远也不卡动画
    requestAnimationFrame(() => {
      const item = document.querySelector('.sum-item[data-summary-id="' + sid + '"]');
      if (item) {
        item.scrollIntoView({ behavior: 'auto', block: 'center' });
        item.classList.add('sum-item-flash');
        setTimeout(() => item.classList.remove('sum-item-flash'), 1400);
      }
    });
  },
  'concept-wrap-mention': (el) => {
    const sid = el.dataset.summaryId;
    const name = el.dataset.name;
    if (!sid || !name) return;
    if (_wrapMentionWithLink(sid, name)) {
      pushState();
      const cid = (state.concepts || []).find(c => c.name === name || (c.aliases||[]).indexOf(name) >= 0);
      if (cid) _openConceptSheet(cid.id);
      else renderAll();
    }
  },
  // 工具栏的 ⋯ → 弹 popover, 列出格式化按钮 + [[]] + 模块
  // flomo 风格的折叠 — 把不常用的二级动作收进来 (Kayu 2026-05-28)
  'summary-tb-more': (el) => {
    const _runFmt = (fmt) => {
      const ed = _summaryInputTa();
      if (!ed) return;
      ed.focus();
      try {
        if (fmt === 'bold')         document.execCommand('bold');
        else if (fmt === 'italic')  document.execCommand('italic');
        else if (fmt === 'head')    document.execCommand('formatBlock', false, 'H3');
        else if (fmt === 'ul')      document.execCommand('insertUnorderedList');
        else if (fmt === 'ol')      document.execCommand('insertOrderedList');
        else if (fmt === 'quote')   document.execCommand('formatBlock', false, 'BLOCKQUOTE');
      } catch (_) {}
      _syncEditorToState(ed);
    };
    const _wikilink = () => {
      const ed = _summaryInputTa();
      if (!ed) return;
      ed.focus();
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0);
          r.deleteContents();
          const node = document.createTextNode('[[]]');
          r.insertNode(node);
          r.setStart(node, 2); r.setEnd(node, 2);
          sel.removeAllRanges(); sel.addRange(r);
        }
      } catch (_) {}
      _syncEditorToState(ed);
    };
    const items = [
      { label: '概念链接 [[…]]',  action: () => { _wikilink();          closePopover(); } },
      { label: '引用',           action: () => { _runFmt('quote');     closePopover(); } },
      { label: '标题',           action: () => { _runFmt('head');      closePopover(); } },
      { label: '粗体',           action: () => { _runFmt('bold');      closePopover(); } },
      { label: '斜体',           action: () => { _runFmt('italic');    closePopover(); } },
      { label: '无序列表',        action: () => { _runFmt('ul');        closePopover(); } },
      { label: '有序列表',        action: () => { _runFmt('ol');        closePopover(); } },
      { divider: true },
      { label: '+ 模块',         action: () => { closePopover(); if (_summaryActions['summary-open-mod-sheet']) _summaryActions['summary-open-mod-sheet'](el); } },
    ];
    showPopover(items, { anchor: el, side: 'right' });
  },
  'summary-tb-wikilink': (el) => {
    const ed = _summaryInputTa();
    if (!ed) return;
    ed.focus();
    // 直接 Range API: 插入 "[[]]" 文本节点, 把光标设到 textNode 偏移 2 (= "[[" 之后, "]]" 之前)
    // 不能用先插入再 setStart(parent, offset-2) — 那是子节点 offset 不是字符 offset, 落点错
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode('[[]]');
        range.insertNode(node);
        range.setStart(node, 2);
        range.setEnd(node, 2);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (_) {}
    _syncEditorToState(ed);
  },
  // 单条 tag 的更多菜单(置顶 / 编辑 / 删除)
  'summary-tag-menu': (el, e) => {
    if (e) e.stopPropagation();
    const tagName = el.dataset.tag;
    if (!tagName) return;
    const tg = (state.summaryTags || []).find(t => t.name === tagName);
    if (!tg) return;
    showSheet(`
      <div class="sheet-handle"></div>
      <div class="sheet-content">
        <div class="section-title" style="padding:0 0 8px;">#${esc(tagName)}</div>
        <button class="modal-list-row" data-tag-action="pin">${tg.pinned?'取消置顶':'置顶'}</button>
        <button class="modal-list-row" data-tag-action="rename">重命名</button>
        <button class="modal-list-row modal-list-row-danger" data-tag-action="delete">删除</button>
      </div>
    `, (body) => {
      body.querySelector('[data-tag-action="pin"]').onclick = () => {
        tg.pinned = !tg.pinned;
        pushState();
        closeSheet();
        _renderSummaryDrawerNav();
      };
      body.querySelector('[data-tag-action="rename"]').onclick = () => {
        closeSheet();
        _openSummaryTagRenameSheet(tagName);
      };
      body.querySelector('[data-tag-action="delete"]').onclick = () => {
        closeSheet();
        _openSummaryTagDeleteSheet(tagName);
      };
    });
  },
  'summary-draft-title': (el) => {
    summaryState.draftTitle = el.value || '';
  },
  'summary-search-input': (el, e) => {
    summaryState.searchQuery = el.value || '';
    // IME 拼音组词期间 input 事件每段都会 fire,跳过不触发重渲(等 compositionend 后正常 input 才走)
    if (e && e.isComposing) return;
    // 250ms 防抖 — 停止打字后才重渲整个 list,避免每键一次几百条 DOM 重建
    if (_summaryActions._searchDebounce) clearTimeout(_summaryActions._searchDebounce);
    _summaryActions._searchDebounce = setTimeout(() => {
      const listEl = document.querySelector('.sum-list');
      if (listEl) {
        listEl.innerHTML = _renderSummaryList();
        if (typeof bindCloudTimelineImages === 'function') bindCloudTimelineImages(listEl);
      }
    }, 250);
  },
  'summary-toggle-day': (el) => {
    const k = el.dataset.dayKey;
    if (!k) return;
    if (summaryState.collapsedDays.has(k)) summaryState.collapsedDays.delete(k);
    else summaryState.collapsedDays.add(k);
    try { localStorage.setItem('psfocus_collapsedDays', JSON.stringify(Array.from(summaryState.collapsedDays))); } catch (_) {}
    renderAll();
  },
  // 分页:加载更多天
  'summary-load-more': () => {
    summaryState.visibleDaysCount = (summaryState.visibleDaysCount || 7) + 14;
    // 只重渲列表,不全 renderAll
    const listEl = document.querySelector('.sum-list');
    if (listEl) {
      listEl.innerHTML = _renderSummaryList();
      if (typeof bindCloudTimelineImages === 'function') bindCloudTimelineImages(listEl);
    }
  },
  // 展开单天的余下条目(原本只渲染最近 40 条)
  'summary-expand-day': (el) => {
    const k = el && el.dataset && el.dataset.dayKey;
    if (!k) return;
    if (!summaryState.expandedDays) summaryState.expandedDays = new Set();
    summaryState.expandedDays.add(k);
    const listEl = document.querySelector('.sum-list');
    if (listEl) {
      listEl.innerHTML = _renderSummaryList();
      if (typeof bindCloudTimelineImages === 'function') bindCloudTimelineImages(listEl);
    }
  },
  // "今日 · 待录入" 折叠/展开 — 记到 localStorage
  'summary-toggle-input-mods': () => {
    summaryState.inputModsCollapsed = !summaryState.inputModsCollapsed;
    try { localStorage.setItem('psfocus_inputModsCollapsed', summaryState.inputModsCollapsed ? '1' : '0'); } catch (_) {}
    // 直接改 DOM(输入框在浮动 sheet 里,renderAll 不会重渲它)— 同时保住 textarea 焦点/内容
    const wrap = document.querySelector('.sum-input-day-mods');
    if (wrap) {
      wrap.classList.toggle('collapsed', summaryState.inputModsCollapsed);
      const chev = wrap.querySelector('.sum-input-day-mods-chev');
      if (chev) chev.textContent = summaryState.inputModsCollapsed ? '▶' : '▼';
    }
  },
  'summary-input-autosize': (el, e) => {
    // contenteditable WYSIWYG — input event 时 HTML → md 同步回 draftNote / 编辑 modal value。
    // 组词期间跳过,等 compositionend 触发的最终 input 再处理(防 IME 拼音被打断)
    if (e && e.isComposing) return;
    // 用 RAF 推一帧,避免高频输入阻塞主线程;前一帧没跑完的 cancel
    if (el._syncRAF) cancelAnimationFrame(el._syncRAF);
    el._syncRAF = requestAnimationFrame(() => {
      el._syncRAF = null;
      _syncEditorToState(el);
      _tagSuggestUpdate(el);
    });
  },
  'summary-tb-tag': () => {
    const ed = _summaryInputTa();
    if (!ed) return;
    ed.focus();
    // 当前光标前是字才补空格,行首/已经有空格就不加(避免行首出现 " #")
    let sep = '';
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).cloneRange();
        r.setStart(ed, 0);
        const txt = r.toString();
        if (txt && !/\s$/.test(txt)) sep = ' ';
      }
    } catch (_) {}
    _insertTextAtCaret(sep + '#');
    _syncEditorToState(ed);
  },
  'summary-tb-format': (el) => {
    const fmt = el.dataset.fmt;
    const ed = _summaryInputTa();
    if (!ed) return;
    ed.focus();
    // execCommand 已 deprecated 但浏览器都还支持, contenteditable WYSIWYG 标准做法
    try {
      if (fmt === 'bold')         document.execCommand('bold');
      else if (fmt === 'italic')  document.execCommand('italic');
      else if (fmt === 'head')    document.execCommand('formatBlock', false, 'H3');
      else if (fmt === 'ul')      document.execCommand('insertUnorderedList');
      else if (fmt === 'ol')      document.execCommand('insertOrderedList');
      else if (fmt === 'quote')   document.execCommand('formatBlock', false, 'BLOCKQUOTE');
      else if (fmt === 'mention') _insertTextAtCaret('@');
    } catch (_) {}
    _syncEditorToState(ed);
  },
  'summary-upload-image': async (el) => {
    const files = Array.from(el.files || []);
    if (!files.length) return;
    showToast(`上传 ${files.length} 张图…`);
    let okCount = 0;
    for (const f of files) {
      try {
        const cloudPath = `psfocus-summary-images/${uid}/${Date.now()}-${(f.name||'img').replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const res = await tcbApp.uploadFile({ cloudPath, filePath: f });
        const fileID = res && res.fileID;
        if (fileID) {
          summaryState.pendingImages.push({
            id: 'img-' + Math.random().toString(36).slice(2, 10),
            cloudFileID: fileID, name: f.name, uploadedAt: Date.now(),
          });
          okCount++;
        }
      } catch (err) { console.warn('[sum-upload]', err); }
    }
    el.value = '';
    if (okCount) showToast(`已加 ${okCount} 张`);
    renderAll();
  },
  'summary-pending-img-del': (el) => {
    const id = el.dataset.imgId;
    summaryState.pendingImages = summaryState.pendingImages.filter(x => x.id !== id);
    renderAll();
  },
  'summary-rating-pending': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId  = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'rating') return;
    const i = parseInt(el.dataset.i, 10);
    const max = Math.max(1, parseInt(mod.max, 10) || 5);
    const value = Math.max(0, Math.min(max, i));
    const cur = summaryState.pendingModuleValues[modId];
    if (cur === value) delete summaryState.pendingModuleValues[modId];
    else summaryState.pendingModuleValues[modId] = value;
    renderAll();
  },
  'summary-duration-pending': (el) => {
    const modId = el.dataset.modId;
    const v = (el.value || '').trim();
    if (!v) {
      delete summaryState.pendingModuleValues[modId];
      return;
    }
    const ms = _summaryParseDuration(v);
    if (!ms) return;
    summaryState.pendingModuleValues[modId] = ms;
  },
  // 时长 h + m 双字段 — 读同行的 .sum-mod-duration-h / -m,实时算 pending ms
  'summary-duration-pending-hm': (el) => {
    const modId = el.dataset.modId;
    const row = el.closest('.sum-mod-editor');
    if (!row) return;
    const hInp = row.querySelector('.sum-mod-duration-h');
    const mInp = row.querySelector('.sum-mod-duration-m');
    const h = Math.max(0, Math.min(24, parseInt((hInp && hInp.value) || '0', 10) || 0));
    const m = Math.max(0, Math.min(59, parseInt((mInp && mInp.value) || '0', 10) || 0));
    const ms = (h * 3600 + m * 60) * 1000;
    if (ms > 0) summaryState.pendingModuleValues[modId] = ms;
    else delete summaryState.pendingModuleValues[modId];
  },
  'summary-submit': () => {
    const ed = _summaryInputTa();
    // 优先实时 editor → md;兜底 summaryState.draftNote
    let text = '';
    if (ed) {
      try { text = _editHtmlToMd(ed).trim(); } catch (_) {}
    }
    if (!text) text = String(summaryState.draftNote || '').trim();
    const imgs = summaryState.pendingImages.slice();
    const pendingMods = Object.keys(summaryState.pendingModuleValues || {});
    const hasNoteOrImg = !!text || imgs.length > 0;
    if (!hasNoteOrImg && !pendingMods.length) {
      // 给用户反馈 — 之前是静默 return,Kayu 反复点都不响应根本看不出原因
      if (typeof showToast === 'function') showToast('内容是空的,先写点啥');
      psLog('WARN', 'summary-submit: empty (ta.value=' + (ta ? JSON.stringify((ta.value||'').slice(0,50)) : 'no-ta')
        + ' draftNote=' + JSON.stringify((summaryState.draftNote||'').slice(0,50)) + ')');
      return;
    }
    const now = Date.now();
    if (pendingMods.length) {
      const todayKey = _todayKey();
      const arr = (state.summaryDayModules && state.summaryDayModules[todayKey]) || [];
      for (const modId of pendingMods) {
        const mod = arr.find(x => x.id === modId);
        if (!mod) continue;
        const v = summaryState.pendingModuleValues[modId];
        if (v == null) continue;
        if (!Array.isArray(mod.entries)) mod.entries = [];
        if (mod.kind === 'rating') {
          mod.entries.push({ id: 'e-' + Math.random().toString(36).slice(2, 8), value: parseInt(v, 10), at: now });
        } else if (mod.kind === 'duration') {
          mod.entries.push({ id: 'e-' + Math.random().toString(36).slice(2, 8), valueMs: parseInt(v, 10), at: now });
        }
      }
    }
    // 读概要 (title) — 优先 sheet 里的输入,兜底 draftTitle
    let title = '';
    const titleEl = document.querySelector('#sheet-body #sum-main-input-title')
      || document.getElementById('sum-main-input-title');
    if (titleEl) title = String(titleEl.value || '').trim();
    if (!title) title = String(summaryState.draftTitle || '').trim();
    if (hasNoteOrImg) {
      const tags = _summaryParseTagsFromText(text);
      for (const tg of tags) _summaryEnsureTag(tg);
      // [[xxx]] 概念自动建库
      const wikiLinks = _extractWikilinks(text);
      for (const wn of wikiLinks) _ensureConcept(wn);
      if (!Array.isArray(state.summaries)) state.summaries = [];
      state.summaries.push({
        id: 'sum-' + Math.random().toString(36).slice(2, 10),
        createdAt: now, updatedAt: now,
        note: text, title, tags, images: imgs,
      });
    }
    summaryState.pendingImages = [];
    summaryState.pendingModuleValues = {};
    summaryState.draftNote = '';
    summaryState.draftTitle = '';
    if (ed) ed.innerHTML = '<div><br></div>';
    if (titleEl) titleEl.value = '';
    pushState();
    if (typeof closeSheet === 'function') closeSheet();   // 收起浮动输入面板
    renderAll();
  },
  // 笔记右上 ⋯ → 弹一个小 sheet:编辑 / 删除
  'summary-item-more': (el) => {
    const id = el.dataset.id;
    const s = (state.summaries || []).find(x => x.id === id);
    if (!s) return;
    showSheet(`
      <div class="sheet-handle"></div>
      <div class="sheet-content">
        <button class="sheet-item" data-action="summary-item-edit" data-id="${esc(id)}">
          <span class="ico-pencil sheet-item-icon"></span><span>编辑</span>
        </button>
        <button class="sheet-item sheet-item-danger" data-action="summary-item-delete" data-id="${esc(id)}">
          <span class="ico-trash sheet-item-icon"></span><span>删除</span>
        </button>
      </div>
    `);
  },
  'summary-item-delete': (el) => {
    const id = el.dataset.id;
    closeSheet();
    if (!confirm('删除这条摘要笔记?')) return;
    state.summaries = (state.summaries || []).filter(s => s.id !== id);
    pushState();
    renderAll();
  },
  // 打开编辑笔记 sheet — datetime-local 改日期 + textarea 改内容
  'summary-item-edit': (el) => {
    const id = el.dataset.id;
    const s = (state.summaries || []).find(x => x.id === id);
    if (!s) return;
    const pad = n => String(n).padStart(2, '0');
    const dt = new Date(s.createdAt || Date.now());
    const dtLocal = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    // 初始化 _editingNoteMd —— 编辑过程中 summary-input-autosize 同步进来
    summaryState._editingNoteMd = s.note || '';
    showSheet(`
      <div class="sheet-handle"></div>
      <div class="sheet-content">
        <div class="section-title" style="padding:0 0 8px;">编辑笔记</div>
        <label class="sum-edit-date-row">
          <span class="sum-edit-date-label">日期 / 时间</span>
          <input id="sum-edit-note-date" class="sum-edit-date-input" type="datetime-local" value="${dtLocal}">
        </label>
        <input id="sum-edit-note-title" type="text" class="sum-edit-title-input"
          value="${esc(s.title || '')}" />
        <div class="sum-input-card sum-edit-card" style="margin-top:8px;">
          <div id="sum-edit-note-text" class="sum-input sum-edit-note-textarea" contenteditable="true"
            data-action-input="summary-input-autosize">${_mdToEditHtml(s.note || '')}</div>
          <div class="sum-input-toolbar">
            <button class="sum-tb-btn" data-action="summary-tb-tag" title="加标签 #"><span class="sum-tb-hash">#</span></button>
            <button class="sum-tb-btn sum-tb-wiki" data-action="summary-tb-wikilink" title="加概念链接 [[xxx]]">[[]]</button>
            <span class="sum-tb-sep"></span>
            <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="bold" title="粗体"><b>B</b></button>
            <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="italic" title="斜体"><i>I</i></button>
            <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="head" title="标题">H</button>
            <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="ul" title="无序"><span class="ico-list"></span></button>
            <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="ol" title="有序">1.</button>
            <button class="sum-tb-btn sum-tb-quote" data-action="summary-tb-format" data-fmt="quote" title="引用">&#8220;</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button class="modal-btn" data-action="close-sheet" style="flex:1;">取消</button>
          <button class="modal-btn modal-btn-primary" data-action="summary-edit-note-save" data-id="${esc(id)}" style="flex:1;">保存</button>
        </div>
      </div>
    `, (body) => {
      const ed = body.querySelector('#sum-edit-note-text');
      if (ed) {
        ed.addEventListener('paste', _summaryHandlePaste);
        ed.focus();
        _caretToEnd(ed);
      }
      // 工具栏 mousedown 保护选区(同主输入)
      body.querySelectorAll('.sum-input-toolbar .sum-tb-btn').forEach(b => {
        b.addEventListener('mousedown', e => e.preventDefault());
      });
    });
  },
  // 保存编辑后的笔记 — note + createdAt + 重新解析 tags
  'summary-edit-note-save': (el) => {
    const id = el.dataset.id;
    const s = (state.summaries || []).find(x => x.id === id);
    if (!s) { closeSheet(); return; }
    const ed = document.getElementById('sum-edit-note-text');
    const dateInp = document.getElementById('sum-edit-note-date');
    // contenteditable → md;兜底 _editingNoteMd
    let nextNote;
    if (ed) {
      try { nextNote = _editHtmlToMd(ed); } catch (_) { nextNote = summaryState._editingNoteMd || (s.note || ''); }
    } else {
      nextNote = summaryState._editingNoteMd || (s.note || '');
    }
    let nextCreatedAt = s.createdAt;
    if (dateInp && dateInp.value) {
      const parsed = new Date(dateInp.value).getTime();
      if (Number.isFinite(parsed)) nextCreatedAt = parsed;
    }
    // 概要 (title) — 概念页上显示
    const titleInp = document.getElementById('sum-edit-note-title');
    const nextTitle = titleInp ? String(titleInp.value || '').trim() : (s.title || '');
    const dateChanged = nextCreatedAt && nextCreatedAt !== s.createdAt;
    const noteChanged = nextNote !== (s.note || '');
    const titleChanged = nextTitle !== (s.title || '');
    if (!dateChanged && !noteChanged && !titleChanged) { closeSheet(); return; }
    if (titleChanged) { s.title = nextTitle; s.updatedAt = Date.now(); }
    if (noteChanged) {
      s.note = nextNote;
      // 重新解析 tags
      const newTags = [];
      const tagRe = /#([^\s#,。、,]+)/g;
      let mm;
      while ((mm = tagRe.exec(nextNote)) !== null) {
        const tg = mm[1].trim();
        if (tg && !newTags.includes(tg)) newTags.push(tg);
      }
      s.tags = newTags;
      for (const tg of newTags) _summaryEnsureTag(tg);
      // [[xxx]] 概念自动建库
      const wikiLinks = _extractWikilinks(nextNote);
      for (const wn of wikiLinks) _ensureConcept(wn);
    }
    if (dateChanged) s.createdAt = nextCreatedAt;
    s.updatedAt = Date.now();
    pushState();
    closeSheet();
    renderAll();
  },
  // 模块管理 sheet — 默认 today;day-header 已不再触发,这里就是 input 工具栏的 "管理模块" 按钮
  'summary-open-mod-sheet': (el) => {
    try {
      const k = (el && el.dataset.dayKey) || _todayKey();
      summaryState.modulePopoverForDay = k;
      summaryState.modulePickerOpenInPopover = false;
      _openSummaryModSheet(k);
    } catch (err) {
      console.error('[summary-open-mod-sheet]', err);
      showToast('打开模块管理失败:' + (err && err.message || err));
    }
  },
  'summary-toggle-picker-in-popover': (el) => {
    summaryState.modulePickerOpenInPopover = !summaryState.modulePickerOpenInPopover;
    const k = el.dataset.dayKey || summaryState.modulePopoverForDay;
    if (k) _openSummaryModSheet(k);
  },
  'summary-add-module': (el) => {
    const kind = el.dataset.kind;
    const dayKey = el.dataset.dayKey;
    if (!dayKey) return;
    const m = _newSummaryModule(kind);
    if (!m) return;
    _summaryModulesForDay(dayKey).push(m);
    summaryState.modulePickerOpenInPopover = false;
    pushState();
    // 在 day-edit sheet 里加的话,sheet 继续开着重渲;在小菜单里加的话,关掉 sheet
    if (summaryState._dayEditOpen === dayKey) {
      _openSummaryDayEditSheet(dayKey);
      renderAll();
    } else {
      summaryState.modulePopoverForDay = null;
      closeSheet();
      renderAll();
    }
  },
  'summary-mod-toggle-expand': (el) => {
    const id = el.dataset.modId;
    if (!id) return;
    if (summaryState.expandedModuleCards.has(id)) summaryState.expandedModuleCards.delete(id);
    else summaryState.expandedModuleCards.add(id);
    const k = el.dataset.dayKey;
    if (summaryState._dayEditOpen === k) _openSummaryDayEditSheet(k);
  },
  'summary-mod-del': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId = el.dataset.modId;
    if (!dayKey || !modId) return;
    if (!confirm('删除此模块?当天的录入会一起删除,其它日期的历史保留。')) return;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    state.summaryDayModules[dayKey] = arr.filter(m => m.id !== modId);
    if (summaryState.pendingModuleValues) delete summaryState.pendingModuleValues[modId];
    pushState();
    if (summaryState._dayEditOpen === dayKey) _openSummaryDayEditSheet(dayKey);
    renderAll();
  },
  'summary-mod-edit-title': (el, e) => {
    // IME 组词中跳过,避免每段拼音都触发 pushState debounce 起来仍累
    if (e && e.isComposing) return;
    const dayKey = el.dataset.dayKey;
    const modId = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod) return;
    const v = (el.value || '').trim();
    if (v === mod.title) return;
    mod.title = v;
    pushState();
  },
  'summary-mod-edit-max': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'rating') return;
    const v = Math.max(1, Math.min(20, parseInt(el.value, 10) || 5));
    if (v === mod.max) return;
    mod.max = v;
    pushState();
    if (summaryState._dayEditOpen === dayKey) _openSummaryDayEditSheet(dayKey);
    renderAll();
  },
  // 一键切 duration source(manual ↔ focus)
  'summary-mod-toggle-src': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'duration') return;
    mod.source = (mod.source === 'focus') ? 'manual' : 'focus';
    pushState();
    if (summaryState._dayEditOpen === dayKey) _openSummaryDayEditSheet(dayKey);
    renderAll();
  },
  'summary-mod-edit-source': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'duration') return;
    mod.source = el.value === 'focus' ? 'focus' : 'manual';
    pushState();
    if (summaryState._dayEditOpen === dayKey) _openSummaryDayEditSheet(dayKey);
    renderAll();
  },
  'summary-mod-entry-del': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod) return;
    const eid = el.dataset.entryId;
    mod.entries = (mod.entries || []).filter(e => e.id !== eid);
    pushState();
    // 详情 sheet 或 day-edit sheet 都需要重新打开刷新
    if (summaryState._dayEditOpen === dayKey) _openSummaryDayEditSheet(dayKey);
    else if (summaryState.modulePopoverForDay === dayKey) {
      // 详情 sheet 上下文 — 重新触发 detail 视图
      _summaryActions['summary-mod-detail']({ dataset: { dayKey, modId } });
    }
    renderAll();
  },
  // 改某条 rating entry 的值
  'summary-mod-entry-edit-rating': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId  = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'rating') return;
    const eid = el.dataset.entryId;
    const entry = (mod.entries || []).find(x => x.id === eid);
    if (!entry) return;
    const max = Math.max(1, parseInt(mod.max, 10) || 5);
    const v = Math.max(1, Math.min(max, parseInt(el.value, 10) || entry.value));
    if (v === entry.value) return;
    entry.value = v;
    el.value = String(v);
    pushState();
    // 不 renderAll,避免抢 focus
  },
  // 改某条 duration entry — h / m 任一框 blur 都触发,读 row 里两个 input 重算 valueMs
  'summary-mod-entry-edit-duration': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId  = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'duration' || mod.source === 'focus') return;
    const eid = el.dataset.entryId;
    const entry = (mod.entries || []).find(x => x.id === eid);
    if (!entry) return;
    const row = el.closest('.sum-mod-entry');
    if (!row) return;
    const hInp = row.querySelector('.sum-mod-entry-h-input');
    const mInp = row.querySelector('.sum-mod-entry-m-input');
    const h = Math.max(0, Math.min(24, parseInt((hInp && hInp.value) || '0', 10) || 0));
    const mm = Math.max(0, Math.min(59, parseInt((mInp && mInp.value) || '0', 10) || 0));
    const valueMs = (h * 3600 + mm * 60) * 1000;
    if (valueMs === entry.valueMs) return;
    entry.valueMs = valueMs;
    pushState();
  },
  // 补加一条 rating entry — 立即写入,at = 当天中午(非今天)或当前(今天)
  'summary-mod-add-entry-rating': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId  = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'rating') return;
    const v = parseInt(el.dataset.value, 10);
    if (!Number.isFinite(v) || v < 1) return;
    const max = Math.max(1, parseInt(mod.max, 10) || 5);
    const value = Math.min(max, v);
    const todayKey = _todayKey ? _todayKey() : _summaryDayKey(Date.now());
    const at = (dayKey === todayKey) ? Date.now() : (_dayKeyToTs(dayKey) + 12 * 3600 * 1000);
    if (!Array.isArray(mod.entries)) mod.entries = [];
    mod.entries.push({ id: 'e-' + Math.random().toString(36).slice(2, 8), value, at });
    pushState();
    if (summaryState._dayEditOpen === dayKey) _openSummaryDayEditSheet(dayKey);
    renderAll();
  },
  // 补加一条 duration entry — 读同卡内 h / m 输入框
  'summary-mod-add-entry-duration': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId  = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'duration' || mod.source === 'focus') return;
    const row = el.closest('.sum-mod-add-row');
    if (!row) return;
    const hInp = row.querySelector('.sum-mod-add-h');
    const mInp = row.querySelector('.sum-mod-add-m');
    const h = Math.max(0, Math.min(24, parseInt((hInp && hInp.value) || '0', 10) || 0));
    const mm = Math.max(0, Math.min(59, parseInt((mInp && mInp.value) || '0', 10) || 0));
    const valueMs = (h * 3600 + mm * 60) * 1000;
    if (valueMs <= 0) { showToast && showToast('请填写有效的时长'); return; }
    const todayKey = _todayKey ? _todayKey() : _summaryDayKey(Date.now());
    const at = (dayKey === todayKey) ? Date.now() : (_dayKeyToTs(dayKey) + 12 * 3600 * 1000);
    if (!Array.isArray(mod.entries)) mod.entries = [];
    mod.entries.push({ id: 'e-' + Math.random().toString(36).slice(2, 8), valueMs, at });
    pushState();
    if (summaryState._dayEditOpen === dayKey) _openSummaryDayEditSheet(dayKey);
    renderAll();
  },
  'summary-mod-pick-task': (el) => {
    const dayKey = el.dataset.dayKey;
    const modId = el.dataset.modId;
    const arr = (state.summaryDayModules && state.summaryDayModules[dayKey]) || [];
    const mod = arr.find(m => m.id === modId);
    if (!mod || mod.kind !== 'checkin') return;
    const recurringTasks = (state.tasks || []).filter(t => {
      const sched = (t.schedules || []).find(s => s && s.repeat && s.repeat !== 'none');
      return !!sched;
    });
    if (!recurringTasks.length) {
      showToast('没有重复任务,先在「任务」section 创建一个');
      return;
    }
    const rows = recurringTasks.map(t => `<button class="modal-list-row" data-summary-pick-task-id="${esc(t.id)}">${esc(t.title || '未命名')}</button>`).join('');
    showSheet(`
      <div class="sheet-handle"></div>
      <div class="sheet-content">
        <div class="section-title" style="padding:0 0 8px;">选关联的重复任务</div>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto;">${rows}</div>
      </div>
    `, (body) => {
      body.querySelectorAll('[data-summary-pick-task-id]').forEach(b => b.onclick = () => {
        mod.taskId = b.dataset.summaryPickTaskId;
        pushState();
        closeSheet();
        _openSummaryModSheet(dayKey);
        renderAll();
      });
    });
  },
};

// 全局 dispatcher — 把 summary-* 的 click/input/blur/change 路由到 _summaryActions
function _bindSummaryGlobalDispatchers() {
  if (window._summaryDispatchersBound) return;
  window._summaryDispatchersBound = true;
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a && (a.startsWith('summary-') || a.startsWith('concept-')) && _summaryActions[a]) _summaryActions[a](el, e);
  });
  document.addEventListener('input', (e) => {
    const el = e.target.closest && e.target.closest('[data-action-input]');
    if (!el) return;
    const a = el.dataset.actionInput;
    if (a && (a.startsWith('summary-') || a.startsWith('concept-')) && _summaryActions[a]) _summaryActions[a](el, e);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest && e.target.closest('[data-action-change],[data-action]');
    if (!el) return;
    const a = el.dataset.actionChange || el.dataset.action;
    if (a && (a.startsWith('summary-') || a.startsWith('concept-')) && _summaryActions[a]) _summaryActions[a](el, e);
  });
  document.addEventListener('blur', (e) => {
    const el = e.target.closest && e.target.closest('[data-action-blur]');
    if (!el) return;
    const a = el.dataset.actionBlur;
    if (a && (a.startsWith('summary-') || a.startsWith('concept-')) && _summaryActions[a]) _summaryActions[a](el, e);
  }, true);
}
_bindSummaryGlobalDispatchers();

// 粘贴 — 图片直接上传; 文本/HTML 强制走纯文本插入
// iPad Safari 上从网页粘贴富文本会带 inline style / <p> / <h1> 等, 会把 contenteditable
// 撑高超过 max-height (overflow:auto 在 iOS contenteditable 上不总生效),
// 工具栏就被推到 sheet 可视区外。统一剥光样式 + 粘完后把工具栏 scroll 回视口。
async function _summaryHandlePaste(ev) {
  const cd = ev.clipboardData;
  const items = (cd && cd.items) || [];
  const imgItems = [];
  for (const it of items) if (it.type && it.type.startsWith('image/')) imgItems.push(it);
  if (imgItems.length) {
    ev.preventDefault();
    showToast(`上传 ${imgItems.length} 张图…`);
    let okCount = 0;
    for (const it of imgItems) {
      const f = it.getAsFile();
      if (!f) continue;
      try {
        const cloudPath = `psfocus-summary-images/${uid}/${Date.now()}-paste.png`;
        const res = await tcbApp.uploadFile({ cloudPath, filePath: f });
        const fileID = res && res.fileID;
        if (fileID) {
          summaryState.pendingImages.push({
            id: 'img-' + Math.random().toString(36).slice(2, 10),
            cloudFileID: fileID, name: f.name || 'paste.png', uploadedAt: Date.now(),
          });
          okCount++;
        }
      } catch (err) { console.warn('[sum-paste]', err); }
    }
    if (okCount) { showToast(`已粘贴 ${okCount} 张`); renderAll(); }
    else { showToast('粘贴失败'); }
    return;
  }
  // 文本路径:强制纯文本,杜绝富 HTML 进编辑器
  const text = (cd && (cd.getData('text/plain') || cd.getData('text'))) || '';
  if (!text) return;  // 没有可识别内容就让浏览器自己处理
  ev.preventDefault();
  try { document.execCommand('insertText', false, text); }
  catch (_) { try { _insertTextAtCaret(text); } catch (__) {} }
  const ed = ev.currentTarget || ev.target;
  if (ed) {
    try { _syncEditorToState(ed); } catch (_) {}
    // 粘贴后保证工具栏 & 发送键还在视野里
    setTimeout(() => {
      try {
        const card = ed.closest && ed.closest('.sum-input-card');
        const tb = card && card.querySelector('.sum-input-toolbar');
        if (tb && tb.scrollIntoView) tb.scrollIntoView({ block: 'end', behavior: 'smooth' });
      } catch (_) {}
    }, 60);
  }
}

function renderTimerTab(view) {
  const day0 = startOfDay(new Date()).getTime();
  const todaySessions = (state.sessions || []).filter(s => s.startedAt && s.startedAt >= day0);
  const totalMin = Math.round(todaySessions.reduce((a, s) => a + (s.duration || 0)/60000, 0));
  view.innerHTML = `
    <div style="padding:32px 18px; text-align:center;">
      <div style="font-size:48px; line-height:1; color:var(--text-faint); margin-bottom:8px;"><span class="ico-clock" style="width:48px;height:48px;"></span></div>
      <div style="font-size:18px; color:var(--text-strong); margin-bottom:6px;">计时</div>
      <div style="font-size:13px; color:var(--text-dim); line-height:1.6;">完整计时功能在桌面端使用。<br>这里展示今天的统计快照。</div>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-num">${totalMin}<span> 分钟</span></div><div class="stat-label">今日专注</div></div>
      <div class="stat-card"><div class="stat-num">${todaySessions.length}</div><div class="stat-label">专注次数</div></div>
    </div>
  `;
}

// =========================================================
// ===== 任务 tab =====
// =========================================================
function renderTasksTab(view) {
  const cl = getCurrentList();
  const project = cl.project;
  const viewMode = project ? (project.viewMode || 'list') : 'list';
  if (viewMode === 'kanban') return renderKanbanView(view, cl);
  if (viewMode === 'gantt')  return renderGanttView(view, cl);
  return renderListView(view, cl);
}

function renderListView(view, cl) {
  const project = cl.project;
  // 项目视图走专门的渲染器(带累计专注 + 可折叠区 + 详情)
  if (project) return renderProjectView(view, cl);
  const hideCompleted = false;
  let tasks = cl.tasks.slice();
  tasks.sort((a, b) => {
    if ((a.done?1:0) !== (b.done?1:0)) return (a.done?1:0) - (b.done?1:0);
    const ta = a.dueAt || a.start || Infinity;
    const tb = b.dueAt || b.start || Infinity;
    if (ta !== tb) return ta - tb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  const undone = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  let html = '';
  if (!tasks.length) {
    html += `<div class="empty">这里还没有任务<br><br>点右下角 <span class="ico-plus" style="vertical-align:-2px"></span> 新建</div>`;
  } else {
    if (undone.length) html += `<div class="card-list">${undone.map(taskCardHtml).join('')}</div>`;
    if (done.length && !hideCompleted) {
      html += `<div class="section-title">已完成 (${done.length})</div>`;
      html += `<div class="card-list">${done.map(taskCardHtml).join('')}</div>`;
    }
  }
  view.innerHTML = html;
  bindTaskCards(view);
}

// ===== 项目视图 — 累计专注 + 可折叠任务区 + 项目信息 / 时间轴 =====
function projectFocusMs(projectId) {
  return (state.sessions || [])
    .filter(s => s.projectId === projectId)
    .reduce((sum, s) => sum + (s.duration || 0), 0);
}
function fmtFocusMs(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

// ===== 薪酬格式化(对齐桌面 formatPayment)=====
const PAYMENT_UNITS = [
  { id: 'none',     label: '',  multiplier: 1     },
  { id: 'hundred',  label: '百', multiplier: 100   },
  { id: 'thousand', label: '千', multiplier: 1000  },
  { id: 'tenK',     label: '万', multiplier: 10000 },
];
function paymentUnitMeta(id) { return PAYMENT_UNITS.find(u => u.id === id) || PAYMENT_UNITS[0]; }
function paymentCurrencyMeta(id) {
  const list = (state && state.settings && state.settings.currencies) || [];
  return list.find(c => c.id === id) || list[0] || { id: 'CNY', symbol: '¥', name: '人民币', rate: 1 };
}
function formatPayment(payment) {
  if (!payment || !payment.value) return '';
  const u = paymentUnitMeta(payment.unit);
  const c = paymentCurrencyMeta(payment.currencyId);
  const v = payment.value;
  const formatted = Number.isInteger(v) ? v.toLocaleString('zh-CN') : v.toFixed(2);
  return `${c.symbol}${formatted}${u.label}`;
}

// ===== 时间轴 helpers(对齐桌面 _ensureTimeline / _fmtTimelineElapsed / _projectFocusMsBefore)=====
function ensureProjectTimeline(p) {
  if (!Array.isArray(p.timeline)) {
    p.timeline = [{
      id: 'tl-' + genId('x').slice(2, 10),
      type: 'created',
      ts: p.createdAt || Date.now(),
      title: '项目创建',
    }];
  }
  return p.timeline;
}
function fmtTimelineElapsed(ms) {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hr   = Math.floor((totalMin % (60 * 24)) / 60);
  const min  = totalMin % 60;
  if (days > 0) return `第 ${days}天 ${hr}小时 ${min}分钟`;
  if (hr > 0)   return `第 ${hr}小时 ${min}分钟`;
  return `第 ${min}分钟`;
}
function projectFocusMsBefore(projectId, ts) {
  if (!projectId) return 0;
  return (state.sessions || [])
    .filter(s => s.projectId === projectId && (s.startedAt + (s.duration || 0)) <= ts)
    .reduce((sum, s) => sum + (s.duration || 0), 0);
}
function renderProjectView(view, cl) {
  const p = cl.project;
  const pid = p.id;
  const isProj = (p.kind || 'project') === 'project';   // false = 任务清单
  const hideCompleted = !!p.hideCompleted;

  let tasks = cl.tasks.slice();
  tasks.sort((a, b) => {
    if ((a.done?1:0) !== (b.done?1:0)) return (a.done?1:0) - (b.done?1:0);
    const ta = a.dueAt || a.start || Infinity;
    const tb = b.dueAt || b.start || Infinity;
    if (ta !== tb) return ta - tb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  const undone = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);

  // 任务区 body
  let taskBody = '';
  if (!tasks.length) {
    taskBody = `<div class="empty" style="padding:18px;">这里还没有任务<br><br>点右下角 <span class="ico-plus" style="vertical-align:-2px"></span> 新建</div>`;
  } else {
    if (undone.length) taskBody += `<div class="card-list">${undone.map(taskCardHtml).join('')}</div>`;
    if (done.length && !hideCompleted) {
      taskBody += `<div class="section-title">已完成 (${done.length})</div>`;
      taskBody += `<div class="card-list">${done.map(taskCardHtml).join('')}</div>`;
    }
  }

  // 任务清单(tasklist)— 简化:不显示累计专注 / 项目信息 / 时间轴(对齐桌面 isProj 判断)
  if (!isProj) {
    view.innerHTML = `<div class="tasklist-view">${taskBody}</div>`;
    bindTaskCards(view);
    return;
  }

  // 项目(project)— 完整渲染
  const focusMs = projectFocusMs(pid);
  const sessionCount = (state.sessions || []).filter(s => s.projectId === pid).length;
  const tasksKey   = 'proj-tasks:' + pid;
  const infoKey    = 'proj-info:'  + pid;
  const tlKey      = 'proj-tl:'    + pid;
  const tasksOpen  = !ui.collapsedSections.has(tasksKey);
  const infoOpen   = !ui.collapsedSections.has(infoKey);
  const tlOpen     = !ui.collapsedSections.has(tlKey);

  view.innerHTML = `
    <div class="proj-stat-strip">
      ${p.color ? `<span class="proj-stat-color" style="background:${esc(p.color)}"></span>` : ''}
      <div class="proj-stat-main">
        <div class="proj-stat-num">${esc(fmtFocusMs(focusMs))}</div>
        <div class="proj-stat-label">累计专注 · ${sessionCount} 次</div>
      </div>
    </div>

    ${collapseSectionHtml(tasksKey, '任务', `${undone.length} 待办 · ${done.length} 已完成`, tasksOpen, taskBody)}
    ${collapseSectionHtml(infoKey,  '项目信息', null, infoOpen, projectInfoBodyHtml(p))}
    ${collapseSectionHtml(tlKey,    '时间轴',   null, tlOpen,   projectTimelineBodyHtml(pid))}
  `;
  bindTaskCards(view);
  view.querySelectorAll('[data-collapse-key]').forEach(el => el.addEventListener('click', () => {
    const k = el.dataset.collapseKey;
    if (ui.collapsedSections.has(k)) ui.collapsedSections.delete(k);
    else ui.collapsedSections.add(k);
    saveUI(); renderAll();
  }));
  // 异步加载时间轴节点的云图
  bindCloudTimelineImages(view);
  // 时间轴节点编辑(只 manual 类型可编辑)— 点节点 body 弹 sheet,点图走 lightbox
  view.querySelectorAll('.proj-tl-node.editable[data-tl-node-id]').forEach(el => {
    el.addEventListener('click', (ev) => {
      // 忽略图片点击(让 lightbox 接管)
      if (ev.target && ev.target.closest && ev.target.closest('.proj-tl-img, .proj-tl-img-wrap, img')) return;
      const projId = el.dataset.tlProjId;
      const nodeId = el.dataset.tlNodeId;
      if (projId && nodeId) openTimelineNodeEditSheet(projId, nodeId);
    });
  });
  // 时间轴「+ 加节点」按钮
  view.querySelectorAll('[data-tl-add-proj]').forEach(el => {
    el.addEventListener('click', () => openTimelineNodeAddSheet(el.dataset.tlAddProj));
  });
}
function collapseSectionHtml(key, title, sub, open, body) {
  return `<section class="proj-section ${open?'is-open':''}">
    <button class="proj-section-head" data-collapse-key="${esc(key)}">
      <span class="ico-chevron-down proj-section-chev"></span>
      <span class="proj-section-title">${esc(title)}</span>
      ${sub ? `<span class="proj-section-sub">${esc(sub)}</span>` : ''}
    </button>
    ${open ? `<div class="proj-section-body">${body}</div>` : ''}
  </section>`;
}
function openProjectFocusDetailSheet(pid) {
  const p = state.projects.find(x => x.id === pid);
  if (!p) return;
  const sessions = (state.sessions || []).filter(s => s.projectId === pid && s.startedAt);
  const totalMs = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  const today0 = startOfDay(new Date()).getTime();
  const week0  = startOfWeek(new Date()).getTime();
  const month0 = startOfMonth(new Date()).getTime();
  const sumOf = (filter) => sessions.filter(filter).reduce((sum, s) => sum + (s.duration || 0), 0);
  const todayMs = sumOf(s => s.startedAt >= today0);
  const weekMs  = sumOf(s => s.startedAt >= week0);
  const monthMs = sumOf(s => s.startedAt >= month0);
  // 按任务聚合
  const byTask = new Map();
  for (const s of sessions) {
    const key = s.taskId || '__none__';
    byTask.set(key, (byTask.get(key) || 0) + (s.duration || 0));
  }
  const taskAgg = Array.from(byTask.entries())
    .map(([tid, ms]) => ({ tid, ms, task: tid !== '__none__' ? state.tasks.find(t => t.id === tid) : null }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8);

  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 6px;">${esc(p.name || '未命名')} · 专注详情</div>
      <div class="focus-stat-grid">
        <div class="focus-stat"><div class="focus-stat-num">${esc(fmtFocusMs(todayMs))}</div><div class="focus-stat-label">今天</div></div>
        <div class="focus-stat"><div class="focus-stat-num">${esc(fmtFocusMs(weekMs))}</div><div class="focus-stat-label">本周</div></div>
        <div class="focus-stat"><div class="focus-stat-num">${esc(fmtFocusMs(monthMs))}</div><div class="focus-stat-label">本月</div></div>
        <div class="focus-stat"><div class="focus-stat-num">${esc(fmtFocusMs(totalMs))}</div><div class="focus-stat-label">累计 · ${sessions.length}</div></div>
      </div>
      ${taskAgg.length ? `
        <div class="settings-sub-title" style="padding:18px 0 4px;">按任务</div>
        <div class="focus-task-list">
          ${taskAgg.map(a => `
            <div class="focus-task-row">
              <span class="focus-task-title">${a.task ? esc(a.task.title || '(无标题)') : '<span style="opacity:.5;">(无任务关联)</span>'}</span>
              <span class="focus-task-dur">${esc(fmtFocusMs(a.ms))}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="settings-hint" style="padding:14px 0 0;">详细 session 列表见桌面端</div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">关闭</button>
    </div>
  `, (body) => {
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
  });
}
function projectInfoBodyHtml(p) {
  // 对齐桌面右侧详情:薪酬 / 客户 / 备注(只读)
  const paymentText = formatPayment(p.payment);
  const clientName = (p.clientName || '').trim();
  const clientContact = (p.clientContact || '').trim();
  const note = (p.note || '').trim();
  const placeholder = (s) => s ? esc(s) : `<span class="proj-info-placeholder">未设</span>`;
  const clientCombined = clientName
    ? (clientContact ? `${esc(clientName)} · ${esc(clientContact)}` : esc(clientName))
    : (clientContact ? esc(clientContact) : `<span class="proj-info-placeholder">未设</span>`);
  return `<div class="proj-info-list">
    <div class="proj-info-row">
      <span class="proj-info-key">薪酬</span>
      <span class="proj-info-val">${paymentText ? esc(paymentText) : `<span class="proj-info-placeholder">未设</span>`}</span>
    </div>
    <div class="proj-info-row">
      <span class="proj-info-key">客户</span>
      <span class="proj-info-val">${clientCombined}</span>
    </div>
    <div class="proj-info-row proj-info-row-multiline">
      <span class="proj-info-key">备注</span>
      <span class="proj-info-val">${placeholder(note)}</span>
    </div>
  </div>`;
}
// 云存储图片 URL 缓存(fileID -> { url, expiry })
// CloudBase 临时 URL 默认 2 小时有效,提前 5 分钟视为过期
const _cloudImageCache = new Map();
async function getCloudImageUrl(fileID) {
  if (!fileID) return null;
  const now = Date.now();
  const cached = _cloudImageCache.get(fileID);
  if (cached && cached.expiry > now) return cached.url;
  try {
    const res = await tcbApp.getTempFileURL({ fileList: [fileID] });
    const item = (res && res.fileList && res.fileList[0]) || null;
    if (!item || item.code !== 'SUCCESS' || !item.tempFileURL) return null;
    _cloudImageCache.set(fileID, { url: item.tempFileURL, expiry: now + 110 * 60 * 1000 });
    return item.tempFileURL;
  } catch (e) {
    console.warn('[cloud image]', fileID, e && e.message);
    return null;
  }
}
// 1×1 透明占位图 — 卸载离屏图时回填,释放解码内存
const _IMG_PH = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
// 云图持久缓存(Cache Storage)— 按 fileID + 缩略尺寸 存图片 blob,跨会话保留
const _IMG_CACHE_NAME = 'psfocus-cloud-img-v2';
function _imgCacheKey(fid, thumb) {
  return 'https://psfocus-img-cache.local/' + encodeURIComponent(fid) + (thumb ? '@' + thumb : '');
}
// 清掉旧版缓存(v1 存的是未缩略原图,白占磁盘)
try { if (window.caches) caches.delete('psfocus-cloud-img-v1'); } catch (_) {}
// COS 服务端缩略 — 项目图常 4000px+,原图一张解码就吃几十 MB,画廊几十张一起 decode
// 直接撑爆内存掉线。改成服务端缩到合适尺寸再下发(只减像素 → 解码内存暴降)。
// CloudBase 临时 URL 的 q-url-param-list 为空,签名不覆盖额外 query,可安全追加 imageMogr2。
// ignore-error/1:COS 处理不了(非图片等)时回退原图,不报错。
function _thumbifyUrl(url, thumb) {
  if (!url || !thumb) return url;
  if (/imageMogr2/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?')
    + 'imageMogr2/thumbnail/!' + thumb + 'x' + thumb + 'r/quality/80/ignore-error/1';
}
function _cloudImgFailDiv() {
  return Object.assign(document.createElement('div'), {
    className: 'proj-tl-img-placeholder',
    innerHTML: '<span class="ico-eye"></span><span>附图加载失败</span>',
  });
}
// 一张图要的缩略尺寸:data-cloud-thumb 显式指定;否则默认 900(够手机内联清晰显示,
// 又远小于原图);data-cloud-thumb="0" = 不缩略(放大查看走 lightbox 单独取原图)。
function _imgThumbSize(img) {
  const v = img.dataset.cloudThumb;
  if (v == null || v === '') return 900;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// 批量换 src:① 持久缓存命中 → 本地 blob 立刻出图 ② 未命中 → 解析临时 URL + 服务端缩略
async function _loadCloudImages(imgs) {
  // 按 fileID + 缩略尺寸分组(同组共用最终 URL)
  const byKey = new Map();
  for (const img of imgs) {
    const fid = img.dataset.cloudFileId;
    if (!fid || img.dataset.cloudLoaded === '1') continue;
    const thumb = _imgThumbSize(img);
    const key = fid + '@' + thumb;
    if (!byKey.has(key)) byKey.set(key, { fid, thumb, imgs: [] });
    byKey.get(key).imgs.push(img);
  }
  if (!byKey.size) return;

  let cache = null;
  try { cache = window.caches ? await caches.open(_IMG_CACHE_NAME) : null; } catch (_) { cache = null; }

  // ① 持久缓存命中 → 本地 blob;objectURL 在 load 后立即 revoke,防句柄堆积
  const need = [];
  await Promise.all(Array.from(byKey.values()).map(async (entry) => {
    if (cache) {
      try {
        const hit = await cache.match(_imgCacheKey(entry.fid, entry.thumb));
        if (hit) {
          const blob = await hit.blob();
          if (blob && blob.size > 0) {
            const objUrl = URL.createObjectURL(blob);
            const t0 = entry.imgs[0];
            if (t0) t0.addEventListener('load', () => { try { URL.revokeObjectURL(objUrl); } catch (_) {} }, { once: true });
            for (const im of entry.imgs) { if (im.isConnected) { im.src = objUrl; im.dataset.cloudLoaded = '1'; } }
            return;
          }
        }
      } catch (_) {}
    }
    need.push(entry);
  }));
  if (!need.length) return;

  // ② 解析临时 URL(按 fid 去重,50 个一批)
  const now = Date.now();
  const fidsToResolve = Array.from(new Set(need.map(e => e.fid)))
    .filter(fid => { const c = _cloudImageCache.get(fid); return !(c && c.expiry > now); });
  for (let i = 0; i < fidsToResolve.length; i += 50) {
    const chunk = fidsToResolve.slice(i, i + 50);
    try {
      const res = await tcbApp.getTempFileURL({ fileList: chunk });
      for (const item of ((res && res.fileList) || [])) {
        if (item && item.code === 'SUCCESS' && item.tempFileURL && item.fileID) {
          _cloudImageCache.set(item.fileID, { url: item.tempFileURL, expiry: Date.now() + 110 * 60 * 1000 });
        }
      }
    } catch (e) { console.warn('[cloud images batch]', e && e.message); }
  }

  // ③ 上图 — 缩略 URL 优先;失败自动回退原图;load 后存进持久缓存
  for (const entry of need) {
    const c = _cloudImageCache.get(entry.fid);
    const imgs = entry.imgs.filter(im => im.isConnected);
    if (!imgs.length) continue;
    if (!c || !c.url) { for (const im of imgs) im.replaceWith(_cloudImgFailDiv()); continue; }
    const thumbUrl = _thumbifyUrl(c.url, entry.thumb);
    const t0 = imgs[0];
    let triedFallback = false;
    const onLoad = () => {
      t0.removeEventListener('error', onError);
      if (cache) {
        const u = t0.currentSrc || t0.src;
        if (u && /^https?:/.test(u)) {
          fetch(u).then(r => { if (r && r.ok) cache.put(_imgCacheKey(entry.fid, entry.thumb), r); }).catch(() => {});
        }
      }
    };
    const onError = () => {
      if (!triedFallback && thumbUrl !== c.url) {
        triedFallback = true;   // 缩略 URL 失败 → 整组退回原图重试一次
        for (const im of imgs) { if (im.isConnected) im.src = c.url; }
        return;
      }
      t0.removeEventListener('load', onLoad);
      for (const im of imgs) { if (im.isConnected) im.replaceWith(_cloudImgFailDiv()); }
    };
    t0.addEventListener('load', onLoad, { once: true });
    t0.addEventListener('error', onError);
    for (const im of imgs) { im.src = thumbUrl; im.dataset.cloudLoaded = '1'; }
  }
}
// 云图懒加载 — IntersectionObserver 双向管控:
//  · 进视口 → 加载  · 离视口 → 卸载(src 回填占位图,释放解码内存)
// 只「加载」不「卸载」时,滚过几百张图后所有图仍占着解码内存,累计一样爆。
// 卸载后内存始终只占当前视口附近的一屏,滚回来会自动重载(URL/blob 有缓存,秒出)。
let _cloudImgObserver = null;
const _cloudImgObserved = new Set();
function _ensureCloudImgObserver() {
  if (_cloudImgObserver) return _cloudImgObserver;
  if (typeof IntersectionObserver === 'undefined') return null;
  const visible = new Set();
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    const toLoad = [];
    for (const img of Array.from(visible)) {
      if (!img.isConnected) { visible.delete(img); continue; }
      if (img.dataset.cloudLoaded === '1') continue;
      toLoad.push(img);
    }
    if (toLoad.length) _loadCloudImages(toLoad);
  };
  _cloudImgObserver = new IntersectionObserver((entries) => {
    let dirty = false;
    for (const e of entries) {
      const img = e.target;
      if (e.isIntersecting) {
        visible.add(img);
        dirty = true;
      } else {
        visible.delete(img);
        // 离开视口且已加载 → 卸载,释放解码内存(滚回来时 flush 会自动重载)
        if (img.dataset.cloudLoaded === '1') {
          const prev = img.src;
          img.dataset.cloudLoaded = '';
          try { img.src = _IMG_PH; } catch (_) {}
          if (prev && prev.indexOf('blob:') === 0) { try { URL.revokeObjectURL(prev); } catch (_) {} }
        }
      }
    }
    if (dirty && !flushTimer) flushTimer = setTimeout(flush, 120);
  }, { rootMargin: '250px 0px' });
  return _cloudImgObserver;
}
function bindCloudTimelineImages(root) {
  // (1) 云图:用 IntersectionObserver 懒加载,只加载视口附近的图
  const imgs = Array.from(root.querySelectorAll('img[data-cloud-file-id]'));
  // 即使本次 root 里没图(比如切去日历 tab),也得做一次扫泄清理,
  // 否则 _cloudImgObserved 会无限增长,每个 detached <img> 都被强引用着,iOS 上很容易把 tab 撑爆
  const obs = _ensureCloudImgObserver();
  if (obs) {
    for (const old of Array.from(_cloudImgObserved)) {
      if (!old.isConnected) { try { obs.unobserve(old); } catch (_) {} _cloudImgObserved.delete(old); }
    }
  }
  if (imgs.length) {
    if (obs) {
      for (const img of imgs) {
        if (_cloudImgObserved.has(img)) continue;
        try { obs.observe(img); _cloudImgObserved.add(img); } catch (_) {}
      }
    } else {
      _loadCloudImages(imgs);   // 不支持 IntersectionObserver → 回退到一次性加载
    }
  }
  // (2) 时间轴节点大图 click → lightbox(同一 .proj-tl-line 容器内为一组)
  root.querySelectorAll('.proj-tl-line').forEach(line => {
    const tlImgs = Array.from(line.querySelectorAll('.proj-tl-img'));
    if (!tlImgs.length) return;
    const slides = tlImgs.map(img => ({ cloudFileID: img.dataset.cloudFileId || '', title: img.alt || '' }));
    tlImgs.forEach((img, i) => {
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (ev) => { ev.stopPropagation(); openImageLightbox(slides, i); });
    });
  });
  // (3) 任务详情图 grid 也支持
  root.querySelectorAll('.dp-image-grid').forEach(grid => {
    const cells = Array.from(grid.querySelectorAll('.dp-image-cell'));
    if (!cells.length) return;
    const slides = cells
      .map(c => c.querySelector('.dp-image'))
      .filter(Boolean)
      .map(img => ({ cloudFileID: img.dataset.cloudFileId || '', title: img.alt || '' }));
    cells.forEach((cell, i) => {
      const img = cell.querySelector('.dp-image');
      if (!img) return;
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (ev) => {
        // 删除按钮在图上,得让删除走自己的 handler
        if (ev.target.closest('[data-action="dp-task-del-image"]')) return;
        ev.stopPropagation();
        openImageLightbox(slides, i);
      });
    });
  });
  // (4) 摘要笔记图片 → lightbox(同条 summary 内的图为一组)
  root.querySelectorAll('.sum-item').forEach(item => {
    const imgs = Array.from(item.querySelectorAll('.sum-item-image'));
    if (!imgs.length) return;
    const slides = imgs.map(img => ({ cloudFileID: img.dataset.cloudFileId || '', title: img.alt || '' }));
    imgs.forEach((img, i) => {
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openImageLightbox(slides, i);
      });
    });
  });
  // (5) 作品完成图集 → lightbox(整组可左右切换)
  root.querySelectorAll('.works-finals-grid').forEach(grid => {
    const imgs = Array.from(grid.querySelectorAll('.works-final-img'));
    if (!imgs.length) return;
    const slides = imgs.map(img => ({ cloudFileID: img.dataset.cloudFileId || '', title: img.alt || '' }));
    imgs.forEach((img, i) => {
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openImageLightbox(slides, i);
      });
    });
  });
}

// =========================================================
// ===== 图片 Lightbox(全屏 + 横向 swipe 切换)=====
// =========================================================
function openImageLightbox(images, startIdx) {
  if (!Array.isArray(images) || !images.length) return;
  startIdx = Math.max(0, Math.min(startIdx || 0, images.length - 1));
  let lb = document.getElementById('img-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'img-lightbox';
    lb.className = 'img-lightbox hidden';
    lb.innerHTML = `
      <div class="img-lb-mask"></div>
      <div class="img-lb-stage">
        <button class="img-lb-close" type="button" aria-label="关闭">×</button>
        <div class="img-lb-viewport">
          <div class="img-lb-track"></div>
        </div>
        <div class="img-lb-foot">
          <span class="img-lb-counter"></span>
          <span class="img-lb-title"></span>
        </div>
      </div>`;
    document.body.appendChild(lb);
    lb.querySelector('.img-lb-mask').addEventListener('click', closeImageLightbox);
    const closeBtn = lb.querySelector('.img-lb-close');
    closeBtn.addEventListener('click', closeImageLightbox);
    // touch fallback — 防 iOS Safari 上 viewport touch-action:none 偶发把附近 tap 吞掉
    closeBtn.addEventListener('touchend', (ev) => { ev.preventDefault(); ev.stopPropagation(); closeImageLightbox(); }, { passive: false });
  }
  const track = lb.querySelector('.img-lb-track');
  track.innerHTML = images.map(im => `
    <div class="img-lb-slide">
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" data-cloud-file-id="${esc(im.cloudFileID || '')}" alt="${esc(im.title || '')}">
    </div>`).join('');
  // 懒加载:只加载当前 ±2 张 — 跨项目浏览时 slides 可能上百张,不能一次性全发请求
  const _loadSlide = (i) => {
    if (i < 0 || i >= images.length) return;
    const sEl = track.children[i];
    const img = sEl && sEl.querySelector('img[data-cloud-file-id]');
    if (!img || img.dataset.loaded) return;
    img.dataset.loaded = '1';
    getCloudImageUrl(img.dataset.cloudFileId).then(url => { if (url) img.src = url; });
  };
  const _loadAround = (i) => { for (let d = -2; d <= 2; d++) _loadSlide(i + d); };
  let idx = startIdx;
  const counter = lb.querySelector('.img-lb-counter');
  const titleEl = lb.querySelector('.img-lb-title');

  // ===== zoom + pan 状态 (per-lightbox 实例) =====
  let scale = 1, tx = 0, ty = 0;
  const MIN_SCALE = 1, MAX_SCALE = 4, ZOOM_TAP_SCALE = 2.5;
  const getCurImg = () => track.children[idx] && track.children[idx].querySelector('img');
  const setImgTransition = (img, on) => {
    if (img) img.style.transition = on ? 'transform .22s cubic-bezier(.2,.7,.3,1)' : 'none';
  };
  const applyImgTransform = (img) => {
    if (img) img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  };
  const clampPan = () => {
    const img = getCurImg();
    if (!img || scale <= 1.001) { tx = 0; ty = 0; return; }
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    // base size 不带 transform — 用 offsetWidth (虽然 img 自身有 max-width 等,offsetWidth 是其 layout box)
    const w = img.offsetWidth * scale;
    const h = img.offsetHeight * scale;
    const maxX = Math.max(0, (w - vw) / 2);
    const maxY = Math.max(0, (h - vh) / 2);
    if (tx > maxX) tx = maxX;
    if (tx < -maxX) tx = -maxX;
    if (ty > maxY) ty = maxY;
    if (ty < -maxY) ty = -maxY;
  };
  const resetZoom = () => { scale = 1; tx = 0; ty = 0; };

  const updateUI = (animate) => {
    track.style.transition = animate ? 'transform .26s cubic-bezier(.2,.7,.3,1)' : 'none';
    track.style.transform = `translateX(${-idx * 100}%)`;
    counter.textContent = `${idx + 1} / ${images.length}`;
    titleEl.textContent = images[idx].title || '';
    _loadAround(idx);
  };
  updateUI(false);

  const viewport = lb.querySelector('.img-lb-viewport');

  // ===== 手势:swipe / pan / pinch / 双击 zoom =====
  let mode = null; // 'swipe' | 'pan' | 'pinch' | null
  let sx = 0, sy = 0, dx = 0, dy = 0, locked = null;
  let stTx = 0, stTy = 0, stScale = 1;
  let stDist = 0, stMidX = 0, stMidY = 0;
  let baseCx = 0, baseCy = 0; // 图像 layout 中心(无 transform)— pinch 锚点
  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;
  const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid2 = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  const computeBaseCenter = (img) => {
    if (!img) return;
    const r = img.getBoundingClientRect();
    baseCx = (r.left + r.width / 2) - tx;
    baseCy = (r.top + r.height / 2) - ty;
  };

  const doZoomToPoint = (clientX, clientY, newScale, animate) => {
    const cur = getCurImg();
    if (!cur) return;
    computeBaseCenter(cur);
    // 当前 scale 下, P_local = (client - baseC - tx) / scale
    const pLx = (clientX - baseCx - tx) / scale;
    const pLy = (clientY - baseCy - ty) / scale;
    tx = clientX - baseCx - pLx * newScale;
    ty = clientY - baseCy - pLy * newScale;
    scale = newScale;
    clampPan();
    setImgTransition(cur, !!animate);
    applyImgTransform(cur);
  };

  const onStart = (e) => {
    const ts = e.touches;
    if (!ts) return;
    if (ts.length === 1) {
      const t = ts[0];
      const now = Date.now();
      const isDouble = (now - lastTapTime) < 280
        && Math.abs(t.clientX - lastTapX) < 30
        && Math.abs(t.clientY - lastTapY) < 30;
      if (isDouble) {
        if (scale > 1.05) {
          resetZoom();
          const cur = getCurImg();
          setImgTransition(cur, true);
          applyImgTransform(cur);
        } else {
          doZoomToPoint(t.clientX, t.clientY, ZOOM_TAP_SCALE, true);
        }
        lastTapTime = 0; mode = null;
        if (e.cancelable) e.preventDefault();
        return;
      }
      lastTapTime = now;
      lastTapX = t.clientX; lastTapY = t.clientY;
      sx = t.clientX; sy = t.clientY; dx = 0; dy = 0;
      if (scale > 1.001) {
        mode = 'pan';
        stTx = tx; stTy = ty;
        const cur = getCurImg();
        setImgTransition(cur, false);
      } else {
        mode = 'swipe';
        locked = null;
        track.style.transition = 'none';
      }
    } else if (ts.length === 2) {
      mode = 'pinch';
      stDist = dist2(ts[0], ts[1]);
      const m = mid2(ts[0], ts[1]);
      stMidX = m.x; stMidY = m.y;
      stScale = scale; stTx = tx; stTy = ty;
      const cur = getCurImg();
      computeBaseCenter(cur);
      setImgTransition(cur, false);
      lastTapTime = 0;
    }
  };

  const onMove = (e) => {
    if (!mode) return;
    const ts = e.touches;
    if (!ts) return;
    if (mode === 'pinch') {
      if (ts.length < 2) return;
      const d = dist2(ts[0], ts[1]);
      const m = mid2(ts[0], ts[1]);
      let newScale = stScale * (d / (stDist || 1));
      if (newScale < 0.5) newScale = 0.5;
      if (newScale > MAX_SCALE + 0.5) newScale = MAX_SCALE + 0.5;
      // P_local 用 pinch 起始锚点(stMidX/stMidY 在起始 transform 下的 image-local 坐标)
      const pLx = (stMidX - baseCx - stTx) / stScale;
      const pLy = (stMidY - baseCy - stTy) / stScale;
      tx = m.x - baseCx - pLx * newScale;
      ty = m.y - baseCy - pLy * newScale;
      scale = newScale;
      applyImgTransform(getCurImg());
      if (e.cancelable) e.preventDefault();
    } else if (mode === 'pan') {
      if (ts.length !== 1) return;
      const t = ts[0];
      tx = stTx + (t.clientX - sx);
      ty = stTy + (t.clientY - sy);
      applyImgTransform(getCurImg());
      if (e.cancelable) e.preventDefault();
    } else if (mode === 'swipe') {
      if (ts.length !== 1) return;
      const t = ts[0];
      dx = t.clientX - sx;
      dy = t.clientY - sy;
      if (locked == null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (locked === 'x') {
        const w = viewport.clientWidth;
        track.style.transform = `translateX(${-idx * w + dx}px)`;
        if (e.cancelable) e.preventDefault();
      } else if (locked === 'y') {
        // 上 / 下滑动 — lightbox 跟手指走 + 渐变透明,松手时按 |dy| 判退出
        const stage = lb.querySelector('.img-lb-stage');
        const mask  = lb.querySelector('.img-lb-mask');
        if (stage) {
          stage.style.transition = 'none';
          stage.style.transform = `translateY(${dy}px)`;
        }
        if (mask) {
          mask.style.transition = 'none';
          mask.style.opacity = String(Math.max(0.3, 1 - Math.abs(dy) / 400));
        }
        if (e.cancelable) e.preventDefault();
      }
    }
  };

  const onEnd = (e) => {
    if (!mode) return;
    const ts = e.touches;
    if (mode === 'pinch') {
      let snap = false;
      if (scale < MIN_SCALE) { resetZoom(); snap = true; }
      else if (scale > MAX_SCALE) { scale = MAX_SCALE; snap = true; }
      const cur = getCurImg();
      clampPan();
      setImgTransition(cur, true);
      applyImgTransform(cur);
      // pinch 结束如果还有一根手指,转为 pan(避免下次必须重新触摸)
      if (ts && ts.length === 1 && scale > 1.001) {
        const t = ts[0];
        sx = t.clientX; sy = t.clientY;
        stTx = tx; stTy = ty;
        mode = 'pan';
        setImgTransition(cur, false);
      } else {
        mode = null;
      }
    } else if (mode === 'pan') {
      const cur = getCurImg();
      const bx = tx, by = ty;
      clampPan();
      if (tx !== bx || ty !== by) {
        setImgTransition(cur, true);
        applyImgTransform(cur);
      }
      mode = null;
    } else if (mode === 'swipe') {
      if (locked === 'x') {
        const w = viewport.clientWidth;
        const threshold = w * 0.18;
        if (dx < -threshold && idx < images.length - 1) idx++;
        else if (dx > threshold && idx > 0) idx--;
        resetZoom();
        updateUI(true);
      } else if (locked === 'y') {
        // 上下划:超过 80px 关闭 lightbox;否则平滑还原
        const stage = lb.querySelector('.img-lb-stage');
        const mask  = lb.querySelector('.img-lb-mask');
        if (Math.abs(dy) > 80) {
          closeImageLightbox();
          // 关闭后清掉残留 transform / opacity,免得下次开 lightbox 还带着
          if (stage) { stage.style.transition = ''; stage.style.transform = ''; }
          if (mask)  { mask.style.transition  = ''; mask.style.opacity   = ''; }
        } else {
          if (stage) {
            stage.style.transition = 'transform .22s cubic-bezier(.2,.7,.3,1)';
            stage.style.transform = '';
          }
          if (mask) {
            mask.style.transition = 'opacity .22s';
            mask.style.opacity = '';
          }
        }
      }
      mode = null; locked = null;
    }
  };

  viewport.addEventListener('touchstart', onStart, { passive: false });
  viewport.addEventListener('touchmove', onMove, { passive: false });
  viewport.addEventListener('touchend', onEnd, { passive: false });
  viewport.addEventListener('touchcancel', onEnd, { passive: false });
  lb.classList.remove('hidden');
}
function closeImageLightbox() {
  const lb = document.getElementById('img-lightbox');
  if (lb) lb.classList.add('hidden');
}

// =========================================================
// ===== 日历侧边抽屉 — 对齐桌面 cal-side-panel,可拖任务到日历 =====
// =========================================================
function _ensureCalSideToggleBtn() {
  let b = document.getElementById('cal-side-toggle-btn');
  if (!b) {
    b = document.createElement('button');
    b.id = 'cal-side-toggle-btn';
    b.className = 'cal-side-toggle-btn';
    b.type = 'button';
    b.innerHTML = '<span class="ico-list"></span>';
    b.setAttribute('aria-label', '任务清单');
    b.addEventListener('click', () => {
      if (ui.calSideOpen) closeCalSideDrawer();
      else openCalSideDrawer();
    });
    document.body.appendChild(b);
  }
  b.style.display = (ui.tab === 'calendar') ? '' : 'none';
}

function _ensureCalSideDrawer() {
  let dr = document.getElementById('cal-side-drawer');
  if (dr) return dr;
  dr = document.createElement('aside');
  dr.id = 'cal-side-drawer';
  dr.className = 'cal-side-drawer hidden';
  dr.innerHTML = `
    <div class="cal-side-drawer-mask" data-action="cal-side-close"></div>
    <div class="cal-side-drawer-body">
      <div class="cal-side-drawer-head">
        <span class="ico-list cal-side-drawer-head-ico"></span>
        <span class="cal-side-drawer-title">任务清单</span>
        <span class="cal-side-drawer-hint">长按拖到日历</span>
        <button class="cal-side-drawer-close" type="button" data-action="cal-side-close" title="关闭">×</button>
      </div>
      <div class="cal-side-drawer-list" id="cal-side-drawer-list"></div>
    </div>`;
  document.body.appendChild(dr);
  dr.querySelectorAll('[data-action="cal-side-close"]').forEach(el => el.addEventListener('click', closeCalSideDrawer));
  return dr;
}

function openCalSideDrawer() {
  const dr = _ensureCalSideDrawer();
  ui.calSideOpen = true; saveUI();
  renderCalSideDrawer();
  dr.classList.remove('hidden');
  // 双 rAF + setTimeout fallback,确保 transition 触发(preview/不可见标签下 rAF 可能不跑)
  setTimeout(() => dr.classList.add('open'), 16);
}
function closeCalSideDrawer() {
  const dr = document.getElementById('cal-side-drawer');
  if (!dr) return;
  ui.calSideOpen = false; saveUI();
  dr.classList.remove('open');
  setTimeout(() => dr.classList.add('hidden'), 280);
}

// ============================================================
// ===== 项目(作品)tab — 移动端项目画廊,对齐桌面 works 模块
// ============================================================
let worksState = {
  filter: { kind: 'all' },   // all | category{id} | uncategorized | tag{path} | rating{stars} | untagged | time{year}
  sort: 'time',              // 'time' | 'custom' | 'updated'
  view: 'list',              // 'list' | 'gallery'(相册模式)
};
// 从 state.settings 还原项目 tab 的视图/排序偏好 — 重开 / 重新登录后保留上次设置
function restoreWorksUiPrefs() {
  const s = (state && state.settings) || {};
  if (s.worksViewMode === 'list' || s.worksViewMode === 'gallery') worksState.view = s.worksViewMode;
  if (['custom', 'time', 'updated', 'time-grouped'].includes(s.worksSortMode)) worksState.sort = s.worksSortMode;
}
// 改项目 tab 视图/排序时:更新运行态 + 持久化进 state.settings + 推云端
function setWorksUiPref(patch) {
  Object.assign(worksState, patch);
  if (state) {
    if (!state.settings) state.settings = {};
    if (patch.view !== undefined) state.settings.worksViewMode = patch.view;
    if (patch.sort !== undefined) state.settings.worksSortMode = patch.sort;
    pushState();
  }
  closePopover();
  renderAll();
}

function worksProjects() {
  return (state.projects || []).filter(p => (p.kind || 'project') === 'project');
}
// 某分类的所有子孙分类 id(含自己)
function worksCategoryDescendants(catId) {
  const ids = new Set([catId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of (state.workCategories || [])) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); added = true; }
    }
  }
  return ids;
}
function filterWorksList(list) {
  const f = worksState.filter || { kind: 'all' };
  if (f.kind === 'category') {
    const ids = worksCategoryDescendants(f.id);
    return list.filter(p => p.categoryId && ids.has(p.categoryId));
  }
  if (f.kind === 'uncategorized') return list.filter(p => !p.categoryId);
  if (f.kind === 'untagged') return list.filter(p => !(p.tags || []).length && !(p.workTags || []).length);
  if (f.kind === 'tag') return list.filter(p => {
    const all = [...(p.tags || []), ...(p.workTags || [])];
    return all.some(t => t === f.path || t.startsWith(f.path + '/'));
  });
  if (f.kind === 'rating') return list.filter(p => (p.rating || 0) === f.stars);
  if (f.kind === 'time') return list.filter(p => p.completedAt && new Date(p.completedAt).getFullYear() === f.year);
  return list;
}
// 项目「最近更新」时间 = max(updatedAt, createdAt, 最新时间轴节点 ts)
function _worksUpdatedTs(p) {
  let t = Math.max(p.updatedAt || 0, p.createdAt || 0);
  if (Array.isArray(p.timeline)) {
    for (const n of p.timeline) { if (n && n.ts > t) t = n.ts; }
  }
  return t;
}
function sortWorksList(list) {
  return list.slice().sort((a, b) => {
    if (worksState.sort === 'custom') return (a.order || 0) - (b.order || 0);
    if (worksState.sort === 'updated') return _worksUpdatedTs(b) - _worksUpdatedTs(a);
    const ta = a.completedAt || a.dueEnd || a.dueStart || a.createdAt || 0;
    const tb = b.completedAt || b.dueEnd || b.dueStart || b.createdAt || 0;
    return tb - ta;
  });
}
function worksStatusOf(p) {
  if (p.completedAt || p.archived) return 'done';
  if (p.status === 'pending') return 'pending';
  return 'active';
}
const WORKS_STATUS_TEXT = { done: '已完成', pending: '未开始', active: '进行中' };

// 项目封面云图 ID — 跟随桌面端逻辑:显式封面 → 完成图集首图 → 时间轴最新带图节点
function worksCoverCloudID(p) {
  if (!p) return null;
  if (p.coverImageCloudID) return p.coverImageCloudID;
  const finals = (p.finalImages || []).filter(f => f && f.cloudFileID);
  if (finals.length) return finals[0].cloudFileID;
  const tlImgs = (p.timeline || []).filter(n => n && n.cloudFileID);
  if (tlImgs.length) {
    tlImgs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return tlImgs[0].cloudFileID;
  }
  return null;
}

// ── 项目封面图后台预缓存 ───────────────────────────────────────────
// 一劳永逸方案:把所有项目封面缩略图「慢慢地」逐个抓下来存进 Cache Storage。
// · 后台串行下载,每张间隔一下 → 不会一次性涌入大量请求把页面压垮/掉线
// · 存进持久缓存后,以后每次进项目 tab 都直接本地出图,零网络请求
// · 已缓存的自动跳过 → 只有第一次会真正下载,以后几乎瞬间完成
let _prefetchState = { running: false, done: 0, total: 0 };
function _worksTabSubtitle() {
  const total = worksProjects().length;
  if (_prefetchState.running) return `${total} 个项目 · 预缓存 ${_prefetchState.done}/${_prefetchState.total}`;
  return total ? `${total} 个项目` : '';
}
function _refreshWorksSubtitle() {
  if (ui.tab === 'works') { const el = $('topbar-subtitle'); if (el) el.textContent = _worksTabSubtitle(); }
}
async function prefetchWorksCovers() {
  if (_prefetchState.running || !tcbApp || !uid) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  // iOS Safari 整个 tab 内存预算 ~384MB。370 个项目 × 2 个尺寸 = 740 张图,
  // 哪怕 200ms 一张串行抓,fetch Response buffer + Cache API put 累计能撑爆。
  // iOS 上完全跳过预缓存,等用户实际滚到时再走 IntersectionObserver 懒加载
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  if (isIOS) {
    psLog('LOG', 'prefetchWorksCovers SKIP (iOS — memory protection)');
    return;
  }
  let cache = null;
  try { cache = window.caches ? await caches.open(_IMG_CACHE_NAME) : null; } catch (_) {}
  if (!cache) return;
  // 收集所有项目封面 — 列表(320)+ 相册(480)两种尺寸都缓上,两个视图都能秒出
  const SIZES = [480, 320];
  const want = [];
  const seen = new Set();
  for (const p of worksProjects()) {
    const fid = worksCoverCloudID(p);
    if (!fid) continue;
    for (const thumb of SIZES) {
      const k = fid + '@' + thumb;
      if (!seen.has(k)) { seen.add(k); want.push({ fid, thumb }); }
    }
  }
  psLog('LOG', 'prefetchWorksCovers start: want=' + want.length);
  // 过滤掉已缓存的
  const todo = [];
  for (const t of want) {
    try { if (!(await cache.match(_imgCacheKey(t.fid, t.thumb)))) todo.push(t); }
    catch (_) { todo.push(t); }
  }
  if (!todo.length) return;   // 全缓存好了
  _prefetchState = { running: true, done: 0, total: todo.length };
  _refreshWorksSubtitle();
  // 批量解析临时 URL(只是拿 URL 字符串,很轻)
  const fids = Array.from(new Set(todo.map(t => t.fid)))
    .filter(fid => { const c = _cloudImageCache.get(fid); return !(c && c.expiry > Date.now()); });
  for (let i = 0; i < fids.length; i += 50) {
    try {
      const res = await tcbApp.getTempFileURL({ fileList: fids.slice(i, i + 50) });
      for (const item of ((res && res.fileList) || [])) {
        if (item && item.code === 'SUCCESS' && item.tempFileURL && item.fileID) {
          _cloudImageCache.set(item.fileID, { url: item.tempFileURL, expiry: Date.now() + 110 * 60 * 1000 });
        }
      }
    } catch (_) {}
  }
  // 逐个慢抓 — 每张之间歇 200ms,温和不压垮
  for (const t of todo) {
    const c = _cloudImageCache.get(t.fid);
    if (c && c.url) {
      try {
        const r = await fetch(_thumbifyUrl(c.url, t.thumb));
        if (r && r.ok) await cache.put(_imgCacheKey(t.fid, t.thumb), r);
      } catch (_) {}
    }
    _prefetchState.done++;
    _refreshWorksSubtitle();
    await new Promise(res => setTimeout(res, 200));
  }
  _prefetchState.running = false;
  _refreshWorksSubtitle();
}

function worksCardHtml(p) {
  const status = worksStatusOf(p);
  const rating = p.rating || 0;
  const stars = rating
    ? `<span class="works-card-stars">${'★'.repeat(rating)}<span class="works-card-stars-dim">${'★'.repeat(5 - rating)}</span></span>`
    : '';
  const allTags = Array.from(new Set([...(p.tags || []), ...(p.workTags || [])]));
  const tagsHtml = allTags.slice(0, 4).map(t =>
    `<span class="works-card-tag" data-works-tag="${esc(t)}">#${esc(t.split('/').pop())}</span>`).join('');
  const metaParts = [];
  const dt = p.completedAt || p.dueEnd || p.dueStart;
  if (dt) metaParts.push((p.completedAt ? '完成 ' : '') + fmtDate(dt));
  if (p.clientName) metaParts.push(esc(p.clientName));
  const pay = formatPayment(p.payment); if (pay) metaParts.push(esc(pay));
  const ms = projectFocusMs(p.id); if (ms > 0) metaParts.push(esc(fmtFocusMs(ms)));
  const color = p.color || '#8b8f96';
  const initial = esc((p.name || '?').slice(0, 1));
  const coverCloudID = worksCoverCloudID(p);
  const thumbHtml = coverCloudID
    ? `<div class="works-card-thumb works-card-thumb-img"><img class="works-card-cover" loading="lazy" data-cloud-file-id="${esc(coverCloudID)}" data-cloud-thumb="320" alt="${esc(p.name || '')}" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="></div>`
    : `<div class="works-card-thumb" style="background:${esc(color)}">${initial}</div>`;
  return `<div class="works-card" data-works-card="${esc(p.id)}">
    ${thumbHtml}
    <div class="works-card-main">
      <div class="works-card-top">
        <span class="works-card-name">${esc(p.name || '未命名')}</span>
        <span class="works-card-status works-card-status-${status}">${WORKS_STATUS_TEXT[status]}</span>
      </div>
      ${stars}
      ${tagsHtml ? `<div class="works-card-tags">${tagsHtml}</div>` : ''}
      ${metaParts.length ? `<div class="works-card-meta">${metaParts.join(' · ')}</div>` : ''}
    </div>
  </div>`;
}

// 相册模式的封面格子
function worksGalleryCellHtml(p) {
  const coverID = worksCoverCloudID(p);
  const _ph = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const inner = coverID
    ? `<img class="works-gallery-img" loading="lazy" data-cloud-file-id="${esc(coverID)}" data-cloud-thumb="480" alt="${esc(p.name || '')}" src="${_ph}">`
    : `<div class="works-gallery-noimg" style="background:${esc(p.color || '#8b8f96')}">${esc((p.name || '?').slice(0, 1))}</div>`;
  return `<div class="works-gallery-cell" data-works-cell="${esc(p.id)}" title="${esc(p.name || '')}">${inner}</div>`;
}

function renderWorksTab(view) {
  const all = worksProjects();
  const filtered = sortWorksList(filterWorksList(all));
  const isGallery = worksState.view === 'gallery';
  const grouped = worksState.sort === 'time-grouped';
  const _monthKey = (p) => {
    const ts = p.completedAt || p.dueEnd || p.dueStart || p.createdAt || 0;
    if (!ts) return '__none__';
    const d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1);
  };
  const _monthLabel = (p) => {
    const ts = p.completedAt || p.dueEnd || p.dueStart || p.createdAt || 0;
    if (!ts) return '无日期';
    const d = new Date(ts);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月';
  };
  const groupedHtml = (renderItem, dividerExtra) => {
    let html = ''; let cur = null;
    for (const p of filtered) {
      const k = _monthKey(p);
      if (k !== cur) {
        cur = k;
        html += `<div class="works-month-divider ${dividerExtra || ''}"><span>${esc(_monthLabel(p))}</span></div>`;
      }
      html += renderItem(p);
    }
    return html;
  };
  const body = !filtered.length
    ? `<div class="empty" style="padding:32px 18px;">没有符合条件的项目</div>`
    : grouped
      ? (isGallery
          ? `<div class="works-gallery">${groupedHtml(worksGalleryCellHtml, 'works-month-divider-gallery')}</div>`
          : `<div class="works-list">${groupedHtml(worksCardHtml)}</div>`)
      : (isGallery
          ? `<div class="works-gallery">${filtered.map(worksGalleryCellHtml).join('')}</div>`
          : `<div class="works-list">${filtered.map(worksCardHtml).join('')}</div>`);
  view.innerHTML = `<div class="works-wrap">${body}</div>`;
  view.querySelectorAll('[data-works-card]').forEach(c => c.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-works-tag]')) return;
    // 点缩略图 → 看项目大图;点右侧文字区 → 进项目详情
    if (ev.target.closest('.works-card-thumb')) openWorksImages(c.dataset.worksCard);
    else openWorksDetailSheet(c.dataset.worksCard);
  }));
  // 相册格子 → 点开看大图
  view.querySelectorAll('[data-works-cell]').forEach(c => c.addEventListener('click', () => {
    openWorksImages(c.dataset.worksCell);
  }));
  view.querySelectorAll('[data-works-tag]').forEach(t => t.addEventListener('click', (ev) => {
    ev.stopPropagation();
    worksState.filter = { kind: 'tag', path: t.dataset.worksTag };
    renderAll();
  }));
  // 异步加载项目卡片封面大图(云存储)
  if (typeof bindCloudTimelineImages === 'function') bindCloudTimelineImages(view);
}

// 取一个项目的灯箱图组(完成图集;没有则封面)
function _worksProjectSlides(p) {
  const finals = (p.finalImages || []).filter(f => f && f.cloudFileID);
  if (finals.length) return finals.map(f => ({ cloudFileID: f.cloudFileID, title: p.name || '' }));
  const coverID = worksCoverCloudID(p);
  return coverID ? [{ cloudFileID: coverID, title: p.name || '' }] : [];
}
// 点项目缩略图 → 看大图;左右滑跨项目 — slides 拼接当前列表里所有项目的图
function openWorksImages(pid) {
  const p0 = state.projects.find(x => x.id === pid);
  if (!p0) return;
  if (!_worksProjectSlides(p0).length) { openWorksDetailSheet(pid); return; }   // 这个项目没图 → 开详情
  // 按项目页当前可见顺序拼所有项目的图,起点 = 点中项目的封面
  const list = sortWorksList(filterWorksList(worksProjects()));
  const p0cover = worksCoverCloudID(p0);
  const slides = [];
  let startIdx = 0;
  for (const p of list) {
    const imgs = _worksProjectSlides(p);
    if (p.id === pid) {
      const off = imgs.findIndex(im => im.cloudFileID === p0cover);
      startIdx = slides.length + (off < 0 ? 0 : off);
    }
    for (const im of imgs) slides.push(im);
  }
  if (!slides.length) { openWorksDetailSheet(pid); return; }
  openImageLightbox(slides, Math.min(startIdx, slides.length - 1));
}

function openWorksDetailSheet(pid) {
  const p = state.projects.find(x => x.id === pid);
  if (!p) return;
  const status = worksStatusOf(p);
  const rating = p.rating || 0;
  const starsHtml = `<span class="works-detail-stars">${'★'.repeat(rating)}<span class="works-card-stars-dim">${'★'.repeat(5 - rating)}</span></span>`;
  const cat = (state.workCategories || []).find(c => c.id === p.categoryId);
  const allTags = Array.from(new Set([...(p.tags || []), ...(p.workTags || [])]));
  const tagsHtml = allTags.length
    ? `<div class="works-detail-tags">${allTags.map(t => `<span class="works-card-tag">#${esc(t)}</span>`).join('')}</div>`
    : '<span class="proj-info-placeholder">无标签</span>';
  const focusMs = projectFocusMs(pid);
  const sessionCount = (state.sessions || []).filter(s => s.projectId === pid).length;
  const fmtRange = (a, b) => {
    if (a && b) return `${fmtDate(a)} ~ ${fmtDate(b)}`;
    if (b) return `截止 ${fmtDate(b)}`;
    if (a) return `开始 ${fmtDate(a)}`;
    return '';
  };
  const dueText = fmtRange(p.dueStart, p.dueEnd);
  const galleryNote = (p.galleryNote || '').trim();
  const color = p.color || '#8b8f96';
  const _imgPlaceholder = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  // 完成图集(只取已同步云端的)+ 封面缩略(跟随桌面逻辑:显式封面→完成图→时间轴最新带图节点)
  const finals = (p.finalImages || []).filter(f => f && f.cloudFileID);
  const detailCoverID = worksCoverCloudID(p);
  const detailThumb = detailCoverID
    ? `<div class="works-card-thumb works-detail-thumb works-card-thumb-img"><img class="works-card-cover" data-cloud-file-id="${esc(detailCoverID)}" alt="${esc(p.name || '')}" src="${_imgPlaceholder}"></div>`
    : `<div class="works-card-thumb works-detail-thumb" style="background:${esc(color)}">${esc((p.name || '?').slice(0, 1))}</div>`;
  const finalsHtml = finals.length
    ? `<div class="section-title" style="padding:14px 0 6px;">完成图集 · ${finals.length}</div>
       <div class="works-finals-grid">${finals.map(f =>
         `<div class="works-final-cell"><img class="works-final-img" loading="lazy" data-cloud-file-id="${esc(f.cloudFileID)}" alt="${esc(f.name || '')}" src="${_imgPlaceholder}"></div>`
       ).join('')}</div>`
    : '';

  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content works-detail">
      <div class="works-detail-head">
        ${detailThumb}
        <div class="works-detail-headmain">
          <div class="works-detail-name">${esc(p.name || '未命名')}</div>
          <div class="works-detail-badges">
            <span class="works-card-status works-card-status-${status}">${WORKS_STATUS_TEXT[status]}</span>
            ${rating ? starsHtml : ''}
          </div>
        </div>
        <button class="works-detail-edit" data-works-edit type="button" title="编辑信息"><span class="ico-edit"></span></button>
      </div>

      <div class="proj-info-list works-detail-info">
        <div class="proj-info-row">
          <span class="proj-info-key">分类</span>
          <span class="proj-info-val">${cat ? esc(cat.name) : '<span class="proj-info-placeholder">未分类</span>'}</span>
        </div>
        <div class="proj-info-row proj-info-row-multiline">
          <span class="proj-info-key">标签</span>
          <span class="proj-info-val">${tagsHtml}</span>
        </div>
        <div class="proj-info-row">
          <span class="proj-info-key">薪酬</span>
          <span class="proj-info-val">${formatPayment(p.payment) ? esc(formatPayment(p.payment)) : '<span class="proj-info-placeholder">未设</span>'}</span>
        </div>
        <div class="proj-info-row">
          <span class="proj-info-key">客户</span>
          <span class="proj-info-val">${p.clientName ? esc(p.clientName) + (p.clientContact ? ' · ' + esc(p.clientContact) : '') : '<span class="proj-info-placeholder">未设</span>'}</span>
        </div>
        <div class="proj-info-row">
          <span class="proj-info-key">周期</span>
          <span class="proj-info-val">${dueText ? esc(dueText) : '<span class="proj-info-placeholder">未设</span>'}</span>
        </div>
        ${p.completedAt ? `<div class="proj-info-row">
          <span class="proj-info-key">完成于</span>
          <span class="proj-info-val">${esc(fmtDate(p.completedAt))}</span>
        </div>` : ''}
        <div class="proj-info-row">
          <span class="proj-info-key">累计专注</span>
          <span class="proj-info-val">${esc(fmtFocusMs(focusMs))} · ${sessionCount} 次</span>
        </div>
        ${galleryNote ? `<div class="proj-info-row proj-info-row-multiline">
          <span class="proj-info-key">简介</span>
          <span class="proj-info-val">${esc(galleryNote)}</span>
        </div>` : ''}
        ${(p.note || '').trim() ? `<div class="proj-info-row proj-info-row-multiline">
          <span class="proj-info-key">备注</span>
          <span class="proj-info-val">${esc((p.note || '').trim())}</span>
        </div>` : ''}
      </div>

      ${finalsHtml}

      <div class="section-title" style="padding:14px 0 6px;">时间轴</div>
      ${projectTimelineBodyHtml(pid)}
    </div>
  `, (body) => {
    bindCloudTimelineImages(body);
    const editBtnEl = body.querySelector('[data-works-edit]');
    if (editBtnEl) editBtnEl.onclick = () => openWorksEditSheet(pid);
    // 头部封面缩略图 → 点击看大图(并入完成图集那一组)
    const coverThumb = body.querySelector('.works-detail-thumb .works-card-cover');
    if (coverThumb) {
      coverThumb.style.cursor = 'zoom-in';
      coverThumb.addEventListener('click', () => {
        if (finals.length) {
          const slides = finals.map(f => ({ cloudFileID: f.cloudFileID, title: f.name || '' }));
          let start = finals.findIndex(f => f.cloudFileID === detailCoverID);
          openImageLightbox(slides, start < 0 ? 0 : start);
        } else if (detailCoverID) {
          openImageLightbox([{ cloudFileID: detailCoverID, title: p.name || '' }], 0);
        }
      });
    }
  });
}

// 项目信息编辑 — 状态 / 完成日期 / 期限 / 客户 / 薪酬 / 评分(对齐桌面端能编辑的字段)
function openWorksEditSheet(pid) {
  const p = state.projects.find(x => x.id === pid);
  if (!p) return;
  let pendingStatus = worksStatusOf(p);
  let pendingRating = p.rating || 0;
  const pay = p.payment || {};
  const UNIT_OPTS = [['none', '无'], ['hundred', '百'], ['thousand', '千'], ['tenK', '万']];
  const dInput = (ts) => ts ? tsToDateInput(ts) : '';
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 12px;">编辑项目信息</div>
      <div class="form-row" style="align-items:flex-start;">
        <label>状态</label>
        <div class="we-status-pills">
          ${['pending', 'active', 'done'].map(s =>
            `<button class="we-status-pill ${s === pendingStatus ? 'active' : ''}" data-we-status="${s}" type="button">${WORKS_STATUS_TEXT[s]}</button>`).join('')}
        </div>
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>完成日期</label>
        <div class="we-date-wrap">
          <input type="date" id="we-completed" value="${esc(dInput(p.completedAt))}">
          <button class="we-mini-btn" id="we-use-due" type="button">用截止</button>
        </div>
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>开始日期</label>
        <input type="date" id="we-start" value="${esc(dInput(p.dueStart))}">
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>截止日期</label>
        <input type="date" id="we-end" value="${esc(dInput(p.dueEnd))}">
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>客户</label>
        <input type="text" id="we-client" value="${esc(p.clientName || '')}" placeholder="客户 / 来源">
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>联系</label>
        <input type="text" id="we-contact" value="${esc(p.clientContact || '')}" placeholder="联系方式(可选)">
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>薪酬</label>
        <div class="we-pay-wrap">
          <input type="number" id="we-pay-val" value="${pay.value ? esc(String(pay.value)) : ''}" placeholder="金额" step="0.01" min="0">
          <select id="we-pay-unit">
            ${UNIT_OPTS.map(([v, l]) => `<option value="${v}" ${(pay.unit || 'none') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>评分</label>
        <div class="we-stars">
          ${[1, 2, 3, 4, 5].map(s => `<button class="we-star ${s <= pendingRating ? 'on' : ''}" data-we-star="${s}" type="button">★</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    body.querySelectorAll('[data-we-status]').forEach(b => b.onclick = () => {
      pendingStatus = b.dataset.weStatus;
      body.querySelectorAll('[data-we-status]').forEach(x => x.classList.toggle('active', x === b));
    });
    body.querySelectorAll('[data-we-star]').forEach(b => b.onclick = () => {
      const s = parseInt(b.dataset.weStar, 10);
      pendingRating = (pendingRating === s) ? 0 : s;   // 再点当前分 = 清零
      body.querySelectorAll('[data-we-star]').forEach(x => x.classList.toggle('on', parseInt(x.dataset.weStar, 10) <= pendingRating));
    });
    body.querySelector('#we-use-due').onclick = () => {
      const v = body.querySelector('#we-end').value || body.querySelector('#we-start').value;
      if (!v) { showToast('还没设截止日期'); return; }
      body.querySelector('#we-completed').value = v;
    };
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      const parseD = (s) => s ? (combineDateAndTime(s, '') || null) : null;
      p.status = pendingStatus;
      if (pendingStatus === 'done') {
        p.completedAt = parseD(body.querySelector('#we-completed').value) || p.completedAt || Date.now();
        p.archived = true;
      } else {
        p.completedAt = null;
        p.archived = false;
      }
      p.dueStart = parseD(body.querySelector('#we-start').value);
      p.dueEnd = parseD(body.querySelector('#we-end').value);
      p.clientName = body.querySelector('#we-client').value.trim();
      p.clientContact = body.querySelector('#we-contact').value.trim();
      const pv = parseFloat(body.querySelector('#we-pay-val').value);
      p.payment = {
        value: Number.isFinite(pv) && pv > 0 ? pv : 0,
        unit: body.querySelector('#we-pay-unit').value || 'none',
        currencyId: (p.payment && p.payment.currencyId) || 'CNY',
      };
      p.rating = pendingRating;
      p.updatedAt = Date.now();
      pushState();
      closeSheet();
      openWorksDetailSheet(pid);
      renderAll();
    };
  });
}

// ============================================================
// ===== 账本 tab — 查看月/季/年收支 + 预算 + 资产 + 流水;手动记一笔
// ============================================================
let ledgerMState = { monthTs: 0, view: 'month' };   // monthTs = 当前月 startOfMonth ms
let _lgAddDraft = {};
function _ledgerCurMonthTs() {
  if (!ledgerMState.monthTs) {
    const d = new Date();
    ledgerMState.monthTs = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }
  return ledgerMState.monthTs;
}
function _ledgerMoney(n) {
  const v = Math.round((n || 0) * 100) / 100;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _ledgerViewMonths() { return ledgerMState.view === 'year' ? 12 : ledgerMState.view === 'quarter' ? 3 : 1; }
function _ledgerViewWord() { return ledgerMState.view === 'year' ? '年度' : ledgerMState.view === 'quarter' ? '季度' : '月度'; }
function _ledgerViewLabel() {
  const m = new Date(_ledgerCurMonthTs());
  if (ledgerMState.view === 'year') return `${m.getFullYear()} 年`;
  if (ledgerMState.view === 'quarter') return `${m.getFullYear()} 年 Q${Math.floor(m.getMonth() / 3) + 1}`;
  return `${m.getFullYear()} 年 ${m.getMonth() + 1} 月`;
}
function _ledgerViewRange() {
  const m = new Date(_ledgerCurMonthTs());
  if (ledgerMState.view === 'year') {
    const y = m.getFullYear();
    return { start: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime() };
  }
  if (ledgerMState.view === 'quarter') {
    const q = Math.floor(m.getMonth() / 3);
    return { start: new Date(m.getFullYear(), q * 3, 1).getTime(), end: new Date(m.getFullYear(), q * 3 + 3, 1).getTime() };
  }
  return { start: m.getTime(), end: new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime() };
}
function _ledgerViewTx() {
  const { start, end } = _ledgerViewRange();
  return ((state.ledger && state.ledger.transactions) || []).filter(t => t.ts >= start && t.ts < end);
}
function _ledgerNav(dir) {
  const m = new Date(_ledgerCurMonthTs());
  if (ledgerMState.view === 'year') m.setFullYear(m.getFullYear() + dir);
  else if (ledgerMState.view === 'quarter') m.setMonth(m.getMonth() + dir * 3);
  else m.setMonth(m.getMonth() + dir);
  ledgerMState.monthTs = new Date(m.getFullYear(), m.getMonth(), 1).getTime();
  renderAll();
}
function _ledgerCatById(id) { return ((state.ledger && state.ledger.categories) || []).find(c => c.id === id) || null; }

// ===== 重复任务的「检查事项」per-occurrence 完成态(对齐桌面 _isPerOccChecklist 等) =====
function _isRecurringTaskM(t) {
  return !!(t && Array.isArray(t.schedules) && t.schedules.some(s => s && s.repeat && s.repeat !== 'none'));
}
function _occDayKeyM(occStart) {
  if (occStart == null) return null;
  const d = new Date(occStart);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// 「今天对应的 occurrence」— 跟自然时间走,不看 completedOccurrences。
// 用来作 checklist 上下文,这样勾的检查事项只属于今天那次出现,明天另算
function _currentOccurrenceForTaskM(task) {
  const schedules = (task.schedules || []).filter(s => s && s.start && s.repeat && s.repeat !== 'none');
  if (!schedules.length) return null;
  const today0 = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const today1 = today0 + 86400000;
  let bestTs = null;
  for (const s of schedules) {
    let occ = new Date(s.start);
    if (s.repeat === 'workday' && (occ.getDay() === 0 || occ.getDay() === 6)) {
      do { occ.setDate(occ.getDate() + 1); } while (occ.getDay() === 0 || occ.getDay() === 6);
    }
    let safety = 5000;
    while (safety-- > 0 && occ.getTime() < today0) {
      const next = new Date(occ);
      if (s.repeat === 'daily') next.setDate(next.getDate() + 1);
      else if (s.repeat === 'weekly') next.setDate(next.getDate() + 7);
      else if (s.repeat === 'monthly') next.setMonth(next.getMonth() + 1);
      else if (s.repeat === 'workday') {
        do { next.setDate(next.getDate() + 1); } while (next.getDay() === 0 || next.getDay() === 6);
      } else { occ = null; break; }
      occ = next;
    }
    if (!occ) continue;
    const ts = occ.getTime();
    if (ts >= today0 && ts < today1) return ts;
    if (bestTs === null || ts < bestTs) bestTs = ts;
  }
  return bestTs;
}
// 切换检查事项在该 occurrence 的勾选状态
function _toggleSubtaskForM(sub, parent, occStart) {
  if (!sub || sub.checklistItem !== true || !_isRecurringTaskM(parent) || occStart == null) {
    // 普通路径:写 sub.done
    sub.done = !sub.done; sub.doneAt = sub.done ? Date.now() : null; sub.updatedAt = Date.now();
    return;
  }
  const key = _occDayKeyM(occStart);
  if (!parent.subtaskCompletions) parent.subtaskCompletions = {};
  // 同时迁移老 ts key 到规范化 day key,避免数据分散
  if (parent.subtaskCompletions[occStart] && occStart !== key) {
    parent.subtaskCompletions[key] = Object.assign({}, parent.subtaskCompletions[key] || {}, parent.subtaskCompletions[occStart]);
    delete parent.subtaskCompletions[occStart];
  }
  if (!parent.subtaskCompletions[key]) parent.subtaskCompletions[key] = {};
  const occ = parent.subtaskCompletions[key];
  if (occ[sub.id]) delete occ[sub.id]; else occ[sub.id] = true;
  if (!Object.keys(occ).length) delete parent.subtaskCompletions[key];
  parent.updatedAt = Date.now();
}

// ===== 消耗品(对齐桌面端 state.ledger.consumables 结构) =====
// c = { id, name, unit, purchases:[{id,ts,qty,price}], genEvent?, nextEventId?, checklistItem? }
// 容错数字解析:中文输入法下「1」可能是全角「１」(U+FF11),原生 parseFloat 会失败
function _parseConsNum(s) {
  if (s == null) return 0;
  let str = String(s).trim();
  if (!str) return 0;
  str = str.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  str = str.replace(/[．。]/g, '.').replace(/[,,\s]/g, '');
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : 0;
}
function _consumableFmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function _consumableFmtNum(n, digits) {
  if (n == null || !isFinite(n)) return '—';
  if (n === 0) return '0';
  const d = digits != null ? digits : (n >= 100 ? 0 : n >= 10 ? 1 : 2);
  return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('zh-CN');
}
function _consumableStats(c) {
  const ps = ((c && c.purchases) || [])
    .filter(p => p && p.ts)
    .map(p => ({ ts: +p.ts, qty: Math.max(0, +p.qty || 0), price: Math.max(0, +p.price || 0) }))
    .sort((a, b) => a.ts - b.ts);
  const n = ps.length;
  if (n === 0) return { empty: true };
  const totalQty   = ps.reduce((s, p) => s + p.qty, 0);
  const totalSpend = ps.reduce((s, p) => s + p.price, 0);
  const lastTs  = ps[n - 1].ts;
  const lastQty = ps[n - 1].qty;
  const firstTs = ps[0].ts;
  const avgUnitPrice = totalQty > 0 ? totalSpend / totalQty : 0;
  if (n < 2) return { lastTs, lastQty, totalQty, totalSpend, avgUnitPrice, needMore: true };
  // 消耗速率:用「除最后一笔外的总数量」÷ 跨度天数(最后一笔还没用,不能算进消耗)
  const consumedQty = Math.max(0, totalQty - lastQty);
  const spanDays = Math.max(1, (lastTs - firstTs) / 86400000);
  const perDayQty = consumedQty / spanDays;
  const perMonth   = perDayQty * 30;
  const perYear    = perDayQty * 365;
  const costPerMonth = avgUnitPrice * perMonth;
  const costPerYear  = avgUnitPrice * perYear;
  let runoutDays = 0, nextTs = null;
  if (perDayQty > 0 && lastQty > 0) {
    runoutDays = lastQty / perDayQty;
    nextTs = lastTs + runoutDays * 86400000;
  }
  return { lastTs, lastQty, totalQty, totalSpend, avgUnitPrice, perMonth, perYear, costPerMonth, costPerYear, runoutDays, nextTs };
}

function renderLedgerTab(view) {
  const lg = state.ledger || {};
  const cats = lg.categories || [];
  const vtx = _ledgerViewTx();
  const expTx = vtx.filter(t => t.dir === 'expense');
  const incTx = vtx.filter(t => t.dir === 'income');
  const expTotal = expTx.reduce((s, t) => s + t.amount, 0);
  const incTotal = incTx.reduce((s, t) => s + t.amount, 0);
  const byCat = (txs) => {
    const m = new Map();
    for (const t of txs) {
      const k = t.categoryId || '__none__';
      if (!m.has(k)) m.set(k, { amt: 0, txs: [] });
      const o = m.get(k); o.amt += t.amount; o.txs.push(t);
    }
    return Array.from(m.entries()).map(([id, o]) => {
      const c = id === '__none__' ? null : _ledgerCatById(id);
      return { id, amt: o.amt, txs: o.txs, name: c ? c.name : '未分类', color: c ? c.color : '#9aa0a8' };
    }).sort((a, b) => b.amt - a.amt);
  };
  const expRows = byCat(expTx), incRows = byCat(incTx);
  const vm = _ledgerViewMonths();
  const expCats = cats.filter(c => (c.kind || 'expense') === 'expense');
  const catBudgetSum = expCats.reduce((s, c) => s + ((c.monthBudget || 0) * vm), 0);
  const totalBudget = Math.max((lg.monthBudget || 0) * vm, catBudgetSum);
  const assetTotal = (lg.accounts || []).reduce((s, a) => s + (a.amount || 0), 0);

  const breakdown = (rows, total, tappable) => {
    if (!rows.length) return '<div class="lg-empty">这段时间没有记录</div>';
    const bar = `<div class="lg-bar">${rows.map(r => {
      const pct = total > 0 ? r.amt / total * 100 : 0;
      return `<span class="lg-bar-seg" style="width:${pct}%;background:${esc(r.color)}"></span>`;
    }).join('')}</div>`;
    const lines = rows.map(r => `<div class="lg-cat-line${tappable ? ' lg-cat-line-tap' : ''}"${tappable ? ` data-lg-cat-detail="${esc(r.id)}"` : ''}>
      <span class="lg-dot" style="background:${esc(r.color)}"></span>
      <span class="lg-cat-name">${esc(r.name)}</span>
      <span class="lg-cat-pct">${total > 0 ? Math.round(r.amt / total * 100) : 0}%</span>
      <span class="lg-cat-amt" style="color:${esc(r.color)}">¥${_ledgerMoney(r.amt)}</span>
      ${tappable ? '<span class="lg-cat-chev">›</span>' : ''}
    </div>`).join('');
    return bar + `<div class="lg-cat-lines">${lines}</div>`;
  };

  view.innerHTML = `
    <div class="lg-view">
      <div class="lg-card">
        <div class="lg-card-head"><span class="lg-card-title">${_ledgerViewWord()}支出</span>
          <span class="lg-card-num exp">¥${_ledgerMoney(expTotal)}</span></div>
        ${breakdown(expRows, expTotal, true)}
      </div>
      <div class="lg-card">
        <div class="lg-card-head"><span class="lg-card-title">${_ledgerViewWord()}收入</span>
          <span class="lg-card-num inc">¥${_ledgerMoney(incTotal)}</span></div>
        ${breakdown(incRows, incTotal, false)}
      </div>
      <div class="lg-card">
        <div class="lg-card-head"><span class="lg-card-title">${_ledgerViewWord()}预算</span>
          <span class="lg-card-num">${totalBudget > 0 ? '¥' + _ledgerMoney(expTotal) + ' / ¥' + _ledgerMoney(totalBudget) : '未设'}</span></div>
        ${totalBudget > 0 ? (() => {
          const tpct = expTotal / totalBudget * 100;
          const tover = expTotal > totalBudget;
          return `<div class="lg-budget-track"><span class="lg-budget-fill ${tover ? 'over' : ''}" style="width:${Math.min(100, tpct)}%"></span></div>
        <div class="lg-budget-pctline ${tover ? 'over' : ''}">已用 ${Math.round(tpct)}%${tover ? ' · 超支 ¥' + _ledgerMoney(expTotal - totalBudget) : ' · 剩余 ¥' + _ledgerMoney(totalBudget - expTotal)}</div>`;
        })() : ''}
        ${expCats.length ? `<div class="lg-budget-cats">${expCats.map(c => {
          const spent = (expRows.find(r => r.id === c.id) || {}).amt || 0;
          const bd = (c.monthBudget || 0) * vm;
          const pct = bd > 0 ? spent / bd * 100 : 0;
          const over = bd > 0 && spent > bd;
          return `<div class="lg-budget-cat">
            <div class="lg-budget-cat-head">
              <span class="lg-dot" style="background:${esc(c.color)}"></span>
              <span class="lg-cat-name">${esc(c.name)}</span>
              ${bd > 0 ? `<span class="lg-budget-cat-pct${over ? ' over' : ''}">${Math.round(pct)}%</span>` : ''}
              <span class="lg-cat-amt" style="color:${esc(c.color)}">¥${_ledgerMoney(spent)}${bd > 0 ? ' / ¥' + _ledgerMoney(bd) : ''}</span>
            </div>
            ${bd > 0 ? `<div class="lg-budget-track lg-budget-track-sm"><span class="lg-budget-fill${over ? ' over' : ''}" style="width:${Math.min(100, pct)}%;${over ? '' : 'background:' + esc(c.color)}"></span></div>` : ''}
          </div>`;
        }).join('')}</div>` : ''}
      </div>
      <div class="lg-card">
        <div class="lg-card-head"><span class="lg-card-title">总资产</span>
          <span class="lg-card-num">¥${_ledgerMoney(assetTotal)}</span></div>
        ${(lg.accounts || []).length ? `<div class="lg-cat-lines">${(lg.accounts || []).map(a =>
          `<div class="lg-cat-line"><span class="lg-cat-name">${esc(a.name || '账户')}</span>
           <span class="lg-cat-amt">¥${_ledgerMoney(a.amount || 0)}</span></div>`).join('')}</div>` : ''}
      </div>
      ${_renderConsumablesCardMobile()}
      <div class="section-title" style="padding:14px 12px 6px;">流水</div>
      ${_ledgerTxListHtml(vtx)}
    </div>`;

  // 期间切换(月/季/年)与前后导航已移到顶栏 — 见 renderTopbar 的 ledger 分支
  // 支出分类单击 → 详情抽屉(tag 拆解 + 最大支出账单)
  view.querySelectorAll('[data-lg-cat-detail]').forEach(el => {
    el.addEventListener('click', () => openLedgerCatDetailSheet(el.dataset.lgCatDetail));
  });
  // 消耗品:卡片点击 = 编辑;右上 + = 新增
  view.querySelectorAll('[data-cons-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.consId;
      const c = ((state.ledger && state.ledger.consumables) || []).find(x => x.id === id);
      if (c) openConsumableEditSheet(c);
    });
  });
  const consAdd = view.querySelector('[data-cons-add]');
  if (consAdd) consAdd.addEventListener('click', () => openConsumableEditSheet(null));
}

// 账本主视图底部:消耗品卡(对齐桌面 _renderConsumablesCard)
function _renderConsumablesCardMobile() {
  const list = ((state.ledger && state.ledger.consumables) || []);
  const cards = list.map(c => {
    const s = _consumableStats(c);
    const unitStr = c.unit ? ' ' + c.unit : '';
    let stat;
    if (s.empty) stat = '<span class="lg-cons-mute">还没有购买记录</span>';
    else if (s.needMore) stat = `<span class="lg-cons-mute">上次 ${_consumableFmtDate(s.lastTs)} · 再加一笔即可统计</span>`;
    else stat = `<div class="lg-cons-stat-grid">
      <div><span>月消耗</span><b>${_consumableFmtNum(s.perMonth)}${esc(unitStr)}</b></div>
      <div><span>月支出</span><b>¥${_consumableFmtNum(s.costPerMonth)}</b></div>
      <div><span>下次</span><b>${_consumableFmtDate(s.nextTs)}</b></div>
    </div>`;
    return `<div class="lg-cons-item" data-cons-id="${esc(c.id)}">
      <div class="lg-cons-name">${esc(c.name || '未命名')}</div>
      ${stat}
    </div>`;
  }).join('');
  return `<div class="lg-card lg-cons-card">
    <div class="lg-card-head">
      <span class="lg-card-title">消耗品</span>
      <button class="lg-cons-add-btn" data-cons-add aria-label="新增消耗品">+</button>
    </div>
    ${list.length ? `<div class="lg-cons-list">${cards}</div>`
      : '<div class="lg-empty">点右上 + 加上常买的东西(牙膏 / 卫生纸 / 猫粮…)</div>'}
  </div>`;
}

// 消耗品编辑 sheet — 新建或编辑现有(existing 可为 null = 新建)
function openConsumableEditSheet(existing) {
  const isNew = !existing;
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  // 把 modal-state-like 对象挂在闭包里;UI 操作都改它,保存时一次性写到 state
  const m = isNew
    ? {
        id: 'cs-' + Math.random().toString(36).slice(2, 10),
        name: '', unit: '',
        purchases: [{ id: 'cp-' + Math.random().toString(36).slice(2, 10), dateStr: todayStr, qty: '1', price: '' }],
        isNew: true,
      }
    : {
        id: existing.id,
        name: existing.name || '',
        unit: existing.unit || '',
        purchases: (existing.purchases || []).map(p => ({
          id: p.id || ('cp-' + Math.random().toString(36).slice(2, 10)),
          dateStr: p.ts ? _consumableFmtDate(p.ts) : todayStr,
          qty: p.qty != null ? String(p.qty) : '',
          price: p.price != null ? String(p.price) : '',
        })),
        isNew: false,
      };
  if (!m.purchases.length) {
    m.purchases.push({ id: 'cp-' + Math.random().toString(36).slice(2, 10), dateStr: todayStr, qty: '1', price: '' });
  }

  const renderBody = () => {
    const previewItem = {
      purchases: m.purchases.map(p => ({
        ts: (() => { const x = new Date(p.dateStr); return isNaN(x.getTime()) ? 0 : x.getTime(); })(),
        qty: _parseConsNum(p.qty),
        price: _parseConsNum(p.price),
      })).filter(p => p.ts && p.qty > 0),
    };
    const s = _consumableStats(previewItem);
    const unitStr = m.unit ? ' ' + m.unit : '';
    let previewHtml;
    if (s.empty) previewHtml = '<span class="lg-cons-mute">填几次购买记录,这里就会出现统计</span>';
    else if (s.needMore) previewHtml = `<div class="lg-cons-preview-grid">
      <div><span>已记录</span><b>1 次</b></div>
      <div><span>上次</span><b>${_consumableFmtDate(s.lastTs)}</b></div>
    </div><div class="lg-cons-mute" style="margin-top:4px;">再加一笔即可计算消耗节奏</div>`;
    else previewHtml = `<div class="lg-cons-preview-grid">
      <div><span>上次</span><b>${_consumableFmtDate(s.lastTs)}</b></div>
      <div><span>预计还能用</span><b>${s.runoutDays ? _consumableFmtNum(s.runoutDays, 0) + ' 天' : '—'}</b></div>
      <div><span>下次预计</span><b>${_consumableFmtDate(s.nextTs)}</b></div>
      <div><span>月消耗</span><b>${_consumableFmtNum(s.perMonth)}${esc(unitStr)}</b></div>
      <div><span>月支出</span><b>¥${_consumableFmtNum(s.costPerMonth)}</b></div>
      <div><span>平均单价</span><b>¥${_consumableFmtNum(s.avgUnitPrice)}</b></div>
      <div><span>累计已花</span><b>¥${_consumableFmtNum(s.totalSpend)}</b></div>
    </div>`;

    const rowsHtml = m.purchases.map((p, i) => `
      <div class="cons-edit-row" data-row-i="${i}">
        <input type="date" class="cons-edit-date" data-field="dateStr" data-i="${i}" value="${esc(p.dateStr || '')}" />
        <input type="text" inputmode="decimal" class="cons-edit-qty" data-field="qty" data-i="${i}" value="${esc(p.qty)}" placeholder="1" />
        <input type="text" inputmode="decimal" class="cons-edit-price" data-field="price" data-i="${i}" value="${esc(p.price)}" placeholder="总价" />
        <button class="cons-edit-row-del" data-row-del="${i}" aria-label="删除这笔">×</button>
      </div>
    `).join('');

    return `
      <div class="sheet-handle"></div>
      <div class="cons-edit-head">
        <button class="cons-edit-cancel">取消</button>
        <span class="cons-edit-title">${m.isNew ? '新增消耗品' : '编辑消耗品'}</span>
        <button class="cons-edit-save">保存</button>
      </div>
      <div class="cons-edit-body">
        <label class="cons-edit-label">名称</label>
        <input id="cons-edit-name" class="cons-edit-input" type="text" value="${esc(m.name)}" placeholder="如 牙膏" />
        <label class="cons-edit-label">单位(可选)</label>
        <input id="cons-edit-unit" class="cons-edit-input" type="text" value="${esc(m.unit)}" placeholder="支 / 卷 / 瓶" />
        <label class="cons-edit-label">购买记录(每次总花费,系统自动算单价)</label>
        <div class="cons-edit-row cons-edit-row-head">
          <span>日期</span><span>数量</span><span>总价</span><span></span>
        </div>
        <div class="cons-edit-rows">${rowsHtml}</div>
        <button class="cons-edit-add-row">+ 加一笔购买</button>
        <div class="cons-edit-preview">${previewHtml}</div>
        ${m.isNew ? '' : '<button class="cons-edit-delete">删除消耗品</button>'}
      </div>
    `;
  };

  // 把 DOM 输入的最新值统一回写到 m(任何重渲 / 保存 / 删行 之前都调一遍)
  const syncFromDom = (body) => {
    const nm = body.querySelector('#cons-edit-name');
    const un = body.querySelector('#cons-edit-unit');
    if (nm) m.name = nm.value;
    if (un) m.unit = un.value;
    body.querySelectorAll('[data-row-i]').forEach(rowEl => {
      const i = +rowEl.dataset.rowI;
      if (!m.purchases[i]) return;
      const d = rowEl.querySelector('[data-field="dateStr"]');
      const q = rowEl.querySelector('[data-field="qty"]');
      const p = rowEl.querySelector('[data-field="price"]');
      if (d) m.purchases[i].dateStr = d.value;
      if (q) m.purchases[i].qty = q.value;
      if (p) m.purchases[i].price = p.value;
    });
  };

  showSheet(`<div class="sheet-content cons-edit-sheet">${renderBody()}</div>`, (body) => {
    const rerender = () => {
      const focusKey = (() => {
        const ae = document.activeElement;
        if (!ae || !body.contains(ae)) return null;
        if (ae.id) return '#' + ae.id;
        if (ae.dataset && ae.dataset.field && ae.dataset.i != null) {
          return `[data-field="${ae.dataset.field}"][data-i="${ae.dataset.i}"]`;
        }
        return null;
      })();
      body.innerHTML = `<div class="sheet-content cons-edit-sheet">${renderBody()}</div>`;
      bindAll(body);
      if (focusKey) {
        const next = body.querySelector(focusKey);
        if (next) { try { next.focus(); } catch (_) {} }
      }
    };
    const bindAll = (b) => {
      // 输入回写 + 重算 preview
      b.querySelectorAll('#cons-edit-name, #cons-edit-unit').forEach(inp => {
        inp.addEventListener('input', () => {
          if (inp.id === 'cons-edit-name') m.name = inp.value;
          else m.unit = inp.value;
          if (inp.id === 'cons-edit-unit') {
            const pv = b.querySelector('.cons-edit-preview');
            if (pv) {
              // 只重渲 preview,不动整个 sheet(避免输入焦点丢失)
              syncFromDom(b);
              const tempBody = document.createElement('div');
              tempBody.innerHTML = `<div>${renderBody()}</div>`;
              const newPv = tempBody.querySelector('.cons-edit-preview');
              if (newPv) pv.innerHTML = newPv.innerHTML;
            }
          }
        });
      });
      b.querySelectorAll('[data-field]').forEach(inp => {
        inp.addEventListener('input', () => {
          const i = +inp.dataset.i;
          if (!m.purchases[i]) return;
          m.purchases[i][inp.dataset.field] = inp.value;
          // 重算 preview(只更新 preview,保留焦点)
          syncFromDom(b);
          const tempBody = document.createElement('div');
          tempBody.innerHTML = `<div>${renderBody()}</div>`;
          const newPv = tempBody.querySelector('.cons-edit-preview');
          const oldPv = b.querySelector('.cons-edit-preview');
          if (oldPv && newPv) oldPv.innerHTML = newPv.innerHTML;
        });
      });
      // 删某行
      b.querySelectorAll('[data-row-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          syncFromDom(b);
          const i = +btn.dataset.rowDel;
          m.purchases.splice(i, 1);
          if (!m.purchases.length) {
            m.purchases.push({ id: 'cp-' + Math.random().toString(36).slice(2, 10), dateStr: todayStr, qty: '1', price: '' });
          }
          rerender();
        });
      });
      // + 加一笔
      const addBtn = b.querySelector('.cons-edit-add-row');
      if (addBtn) addBtn.addEventListener('click', () => {
        syncFromDom(b);
        // 新行日期 = 最新已填日期(没就今日)
        let baseTs = 0;
        for (const p of m.purchases) {
          const d = new Date(p.dateStr);
          if (!isNaN(d.getTime()) && d.getTime() > baseTs) baseTs = d.getTime();
        }
        const d = new Date(baseTs || Date.now());
        m.purchases.push({
          id: 'cp-' + Math.random().toString(36).slice(2, 10),
          dateStr: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
          qty: '1', price: '',
        });
        rerender();
        // 滚到底 + focus 新行 qty
        setTimeout(() => {
          const rows = b.querySelectorAll('[data-row-i]');
          const last = rows[rows.length - 1];
          if (last) {
            try { last.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
            const q = last.querySelector('[data-field="qty"]');
            if (q) { try { q.focus(); q.select(); } catch (_) {} }
          }
        }, 30);
      });
      // 取消
      const cancelBtn = b.querySelector('.cons-edit-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', () => closeSheet());
      // 保存
      const saveBtn = b.querySelector('.cons-edit-save');
      if (saveBtn) saveBtn.addEventListener('click', () => {
        syncFromDom(b);
        const name = (m.name || '').trim();
        if (!name) { showToast('填个名称'); return; }
        const rawCount = m.purchases.length;
        const purchases = m.purchases.map(p => {
          const d = new Date(p.dateStr);
          const ts = !isNaN(d.getTime()) ? d.getTime() : 0;
          const qty = _parseConsNum(p.qty);
          const price = _parseConsNum(p.price);
          return { id: p.id, ts, qty, price };
        }).filter(p => p.ts && p.qty > 0);
        const dropped = rawCount - purchases.length;
        if (!state.ledger) state.ledger = {};
        if (!Array.isArray(state.ledger.consumables)) state.ledger.consumables = [];
        const idx = state.ledger.consumables.findIndex(c => c.id === m.id);
        // 保留原 genEvent/nextEventId/checklistItem 等字段(只动名称 / unit / purchases)
        const oldRec = idx >= 0 ? state.ledger.consumables[idx] : {};
        const rec = { ...oldRec, id: m.id, name, unit: (m.unit || '').trim(), purchases };
        if (idx >= 0) state.ledger.consumables[idx] = rec;
        else          state.ledger.consumables.push(rec);
        pushState(); renderAll(); closeSheet();
        showToast((m.isNew ? '已添加' : '已保存') + (dropped > 0 ? ` · ${dropped} 行因没填日期 / 数量被忽略` : ''));
      });
      // 删除消耗品(仅编辑模式有)
      const delBtn = b.querySelector('.cons-edit-delete');
      if (delBtn) delBtn.addEventListener('click', () => {
        if (!confirm(`删除「${m.name || '未命名'}」?所有购买记录会一并删除,无法恢复。`)) return;
        if (state.ledger && Array.isArray(state.ledger.consumables)) {
          state.ledger.consumables = state.ledger.consumables.filter(c => c.id !== m.id);
        }
        pushState(); renderAll(); closeSheet();
        showToast('已删除');
      });
    };
    bindAll(body);
  });
}

function _ledgerTagById(id) { return ((state.ledger && state.ledger.tags) || []).find(t => t.id === id) || null; }

// 支出分类详情抽屉 — 该分类下:二级标签占比/额度 + 金额最大的账单
function openLedgerCatDetailSheet(catId) {
  const vtx = _ledgerViewTx();
  const txs = vtx.filter(t => t.dir === 'expense' && (t.categoryId || '__none__') === catId);
  const cat = catId === '__none__' ? null : _ledgerCatById(catId);
  const catName = cat ? cat.name : '未分类';
  const catColor = cat ? cat.color : '#9aa0a8';
  const catTotal = txs.reduce((s, t) => s + t.amount, 0);

  // 二级标签拆解 — 一笔可挂多 tag,各计一次(合计可超分类总额);无 tag 计入「未标记」
  const tagMap = new Map();
  let untagged = 0;
  for (const t of txs) {
    const tids = t.tagIds || [];
    if (!tids.length) { untagged += t.amount; continue; }
    for (const tid of tids) tagMap.set(tid, (tagMap.get(tid) || 0) + t.amount);
  }
  const tagRows = Array.from(tagMap.entries())
    .map(([tid, amt]) => { const tg = _ledgerTagById(tid); return { name: tg ? tg.name : '(标签)', color: tg ? tg.color : '#9aa0a8', amt }; })
    .sort((a, b) => b.amt - a.amt);
  if (untagged > 0) tagRows.push({ name: '未标记', color: '#c8ccd2', amt: untagged, untag: true });

  const tagHtml = tagRows.length
    ? tagRows.map(r => `<div class="lg-cat-line">
        <span class="lg-dot" style="background:${esc(r.color)}"></span>
        <span class="lg-cat-name${r.untag ? ' lg-cat-name-dim' : ''}">${esc(r.name)}</span>
        <span class="lg-cat-pct">${catTotal > 0 ? Math.round(r.amt / catTotal * 100) : 0}%</span>
        <span class="lg-cat-amt" style="color:${esc(r.untag ? '#9aa0a8' : r.color)}">¥${_ledgerMoney(r.amt)}</span>
      </div>`).join('')
    : '<div class="lg-empty">该分类账单还没打标签</div>';

  // 金额最大的账单(最多 8 笔)
  const topTx = txs.slice().sort((a, b) => b.amount - a.amount).slice(0, 8);
  const txHtml = topTx.length
    ? topTx.map(t => {
        const d = new Date(t.ts);
        const cp = (t.counterparty || '').trim();
        return `<div class="lg-detail-tx">
          <span class="lg-detail-tx-date">${d.getFullYear()}.${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}</span>
          <div class="lg-detail-tx-mid">
            <div class="lg-detail-tx-title">${esc(t.title || '(无名)')}</div>
            ${cp ? `<div class="lg-detail-tx-cp">对方 · ${esc(cp)}</div>` : ''}
          </div>
          <span class="lg-detail-tx-amt" style="color:${esc(catColor)}">¥${_ledgerMoney(t.amount)}</span>
        </div>`;
      }).join('')
    : '<div class="lg-empty">该分类暂无账单</div>';

  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="lg-detail-head">
        <span class="lg-dot" style="background:${esc(catColor)};width:12px;height:12px;"></span>
        <span class="lg-detail-name">${esc(catName)}</span>
        <span class="lg-detail-sub">${txs.length} 笔 · ¥${_ledgerMoney(catTotal)}</span>
      </div>
      <div class="lg-detail-sec-title">标签拆解</div>
      <div class="lg-cat-lines">${tagHtml}</div>
      <div class="lg-detail-sec-title">最大支出账单</div>
      <div class="lg-detail-txs">${txHtml}</div>
    </div>
    <div class="sheet-actions">
      <button class="primary" data-action="close">关闭</button>
    </div>
  `, (body) => {
    body.querySelector('[data-action="close"]').onclick = closeSheet;
  });
}

function _ledgerTxListHtml(txs) {
  if (!txs.length) return '<div class="lg-empty" style="margin:0 12px;">这段时间还没有账单 — 桌面端导入 CSV 或点右下角记一笔</div>';
  const sorted = txs.slice().sort((a, b) => b.ts - a.ts);
  const groups = [];
  let cur = null;
  for (const t of sorted) {
    const d = new Date(t.ts);
    const key = `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}`;
    if (!cur || cur.key !== key) {
      const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      cur = { key, label: `${key} 周${wd}`, items: [] };
      groups.push(cur);
    }
    cur.items.push(t);
  }
  return groups.map(g => {
    const exp = g.items.filter(t => t.dir === 'expense').reduce((s, t) => s + t.amount, 0);
    const rows = g.items.map(t => {
      const c = t.categoryId ? _ledgerCatById(t.categoryId) : null;
      const cat = t.dir === 'income' ? '收入' : (c ? c.name : '未分类');
      const color = t.dir === 'income' ? '#4cae8f' : (c ? c.color : '#9aa0a8');
      const cp = (t.counterparty || '').trim();
      return `<div class="lg-tx-row">
        <span class="lg-tx-ico" style="background:${esc(color)}22;color:${esc(color)}">${esc((cat || '?').slice(0, 1))}</span>
        <div class="lg-tx-main">
          <div class="lg-tx-title">${esc(t.title || '')}</div>
          <div class="lg-tx-cat">${esc(cat)}${cp ? ' · 对方 ' + esc(cp) : ''}</div>
        </div>
        <span class="lg-tx-amt ${t.dir}">${t.dir === 'income' ? '+' : '-'}${_ledgerMoney(t.amount)}</span>
      </div>`;
    }).join('');
    return `<div class="lg-tx-group">
      <div class="lg-tx-day"><span>${esc(g.label)}</span><span class="lg-tx-daysum">支 ¥${_ledgerMoney(exp)}</span></div>
      ${rows}
    </div>`;
  }).join('');
}

// 手动记一笔 — 底部 sheet
function openLedgerAddSheet() {
  if (!state.ledger) state.ledger = { transactions: [], rules: [], categories: [], tags: [], accounts: [], monthBudget: 0 };
  const lg = state.ledger;
  if (!Array.isArray(lg.transactions)) lg.transactions = [];
  let dir = 'expense';
  const now = new Date();
  const pd = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pd(now.getMonth() + 1)}-${pd(now.getDate())}`;
  _lgAddDraft = {};
  const draw = () => {
    const dcats = (lg.categories || []).filter(c => (c.kind || 'expense') === dir);
    showSheet(`
      <div class="sheet-handle"></div>
      <div class="sheet-content">
        <div class="section-title" style="padding:0 0 12px;">手动记一笔</div>
        <div class="lg-add-dir">
          <button class="lg-add-dir-btn ${dir === 'expense' ? 'on exp' : ''}" data-lg-dir="expense">支出</button>
          <button class="lg-add-dir-btn ${dir === 'income' ? 'on inc' : ''}" data-lg-dir="income">收入</button>
        </div>
        <div class="form-row" style="margin-top:10px;"><label>金额</label>
          <input type="number" id="lg-amt" step="0.01" min="0" placeholder="0.00" value="${esc(_lgAddDraft.amount || '')}"></div>
        <div class="form-row" style="margin-top:8px;"><label>名称</label>
          <input type="text" id="lg-title" placeholder="这笔是什么" value="${esc(_lgAddDraft.title || '')}"></div>
        <div class="form-row" style="margin-top:8px;"><label>日期</label>
          <input type="date" id="lg-date" value="${esc(_lgAddDraft.date || todayStr)}"></div>
        <div class="form-row" style="margin-top:8px;"><label>分类</label>
          <select id="lg-cat">
            <option value="">未分类</option>
            ${dcats.map(c => `<option value="${esc(c.id)}" ${_lgAddDraft.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></div>
      </div>
      <div class="sheet-actions">
        <button data-action="cancel">取消</button>
        <button class="primary" data-action="save">保存</button>
      </div>
    `, (body) => {
      const sync = () => {
        _lgAddDraft.amount = body.querySelector('#lg-amt').value;
        _lgAddDraft.title = body.querySelector('#lg-title').value;
        _lgAddDraft.date = body.querySelector('#lg-date').value;
        _lgAddDraft.categoryId = body.querySelector('#lg-cat').value;
      };
      body.querySelectorAll('[data-lg-dir]').forEach(b => b.onclick = () => {
        sync(); dir = b.dataset.lgDir; _lgAddDraft.categoryId = ''; draw();
      });
      body.querySelector('[data-action="cancel"]').onclick = closeSheet;
      body.querySelector('[data-action="save"]').onclick = () => {
        sync();
        const amt = parseFloat(_lgAddDraft.amount);
        if (!Number.isFinite(amt) || amt <= 0) { showToast('填一个有效金额'); return; }
        const parts = (_lgAddDraft.date || todayStr).split('-').map(Number);
        const ts = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1, 12, 0, 0).getTime();
        const title = (_lgAddDraft.title || '').trim() || (dir === 'income' ? '收入' : '支出');
        const picked = !!_lgAddDraft.categoryId;
        lg.transactions.push({
          id: genId('lt'),
          tradeNo: 'manual-' + genId('m'),
          ts, amount: amt, dir, title, counterparty: '',
          categoryId: _lgAddDraft.categoryId || null,
          tagIds: [], manual: true,
          ...(picked ? { manualCat: true } : {}),
        });
        _lgAddDraft = {};
        pushState();
        closeSheet();
        renderAll();
        showToast(dir === 'income' ? '已记一笔收入' : '已记一笔支出');
      };
    });
  };
  draw();
}

function renderCalSideDrawer() {
  const dr = _ensureCalSideDrawer();
  const list = dr.querySelector('#cal-side-drawer-list');
  if (!list) return;
  if (!ui.calSideExpanded) ui.calSideExpanded = new Set();
  const projects = (state.projects || []).filter(p => !p.archived).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const folders = (state.folders || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const folderIds = new Set(folders.map(f => f.id));
  const pinned    = projects.filter(p => p.pinned);
  const ungrouped = projects.filter(p => !p.pinned && (!p.folderId || !folderIds.has(p.folderId)));

  const rowDot = (p) => {
    const ci = p.icon ? renderCustomIconHtml(p.icon, 'cal-sd-row-ico', p.color || '') : null;
    if (ci) return ci;
    if (p.color) return `<span class="cal-sd-row-dot" style="background:${esc(p.color)}"></span>`;
    return `<span class="${p.kind === 'tasklist' ? 'ico-list' : 'ico-folder'} cal-sd-row-ico"></span>`;
  };
  const projRow = (p) => {
    const key = 'p:' + p.id;
    const expanded = ui.calSideExpanded.has(key);
    let html = `<div class="cal-sd-group">
      <div class="cal-sd-row cal-sd-group-head" data-row-kind="project" data-row-id="${esc(p.id)}">
        <button class="cal-sd-chev ${expanded ? 'expanded' : ''}" data-action="cal-sd-toggle" data-key="${esc(key)}"><span class="ico-chevron-down"></span></button>
        ${rowDot(p)}
        <span class="cal-sd-row-title">${esc(p.name || '')}</span>
      </div>`;
    if (expanded) {
      const inner = (state.tasks || []).filter(t => t.projectId === p.id && !t.parentTaskId && !t.parentEventId && !t.done).sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!inner.length) {
        html += `<div class="cal-sd-empty-inner">暂无未完成任务</div>`;
      } else {
        for (const t of inner) {
          const firstSched = (t.schedules || []).find(s => s && s.start);
          const hint = firstSched ? fmtSchedule(firstSched) : '';
          html += `<div class="cal-sd-row indent" data-row-kind="task" data-row-id="${esc(t.id)}">
            <span class="cal-sd-row-check"></span>
            <span class="cal-sd-row-title">${esc(t.title || '(无标题)')}</span>
            ${hint ? `<span class="cal-sd-row-sched">${esc(hint)}</span>` : ''}
          </div>`;
        }
      }
    }
    html += '</div>';
    return html;
  };
  let html = '';
  if (pinned.length) {
    html += `<div class="cal-sd-subhead">已置顶</div>`;
    for (const p of pinned) html += projRow(p);
  }
  for (const p of ungrouped) html += projRow(p);
  for (const f of folders) {
    const inFolder = projects.filter(p => !p.pinned && p.folderId === f.id);
    if (!inFolder.length) continue;
    const fkey = 'f:' + f.id;
    const fopen = ui.calSideExpanded.has(fkey);
    html += `<div class="cal-sd-folder">
      <div class="cal-sd-row cal-sd-folder-head">
        <button class="cal-sd-chev ${fopen ? 'expanded' : ''}" data-action="cal-sd-toggle" data-key="${esc(fkey)}"><span class="ico-chevron-down"></span></button>
        ${renderCustomIconHtml(f.icon, 'cal-sd-row-ico', '') || `<span class="ico-folder cal-sd-row-ico"></span>`}
        <span class="cal-sd-row-title">${esc(f.name || '')}</span>
      </div>`;
    if (fopen) for (const p of inFolder) html += projRow(p);
    html += '</div>';
  }
  if (!html) html = `<div class="cal-sd-empty">还没有项目</div>`;
  list.innerHTML = html;
  list.querySelectorAll('[data-action="cal-sd-toggle"]').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const k = b.dataset.key;
    if (ui.calSideExpanded.has(k)) ui.calSideExpanded.delete(k); else ui.calSideExpanded.add(k);
    saveUI();
    renderCalSideDrawer();
  }));
  list.querySelectorAll('[data-row-kind][data-row-id]').forEach(row => {
    bindCalSideDragOut(row, { kind: row.dataset.rowKind, id: row.dataset.rowId });
  });
}

// 长按 350ms → ghost 跟手 → touchend hit-test 落点
function bindCalSideDragOut(row, payload) {
  let timer = null;
  let ghost = null;
  let dragging = false;
  let sx = 0, sy = 0;
  let lastHover = null;
  const LONG_PRESS_MS = 350;
  const MOVE_CANCEL = 12;

  function startDrag(t) {
    dragging = true;
    try { navigator.vibrate && navigator.vibrate(15); } catch (_) {}
    const dr = document.getElementById('cal-side-drawer');
    if (dr) dr.classList.add('drag-fade');
    ghost = document.createElement('div');
    ghost.className = 'cal-sd-ghost';
    let label = '任务';
    if (payload.kind === 'task') {
      const src = state.tasks.find(x => x.id === payload.id);
      label = (src && src.title) || '任务';
    } else if (payload.kind === 'project') {
      const src = state.projects.find(x => x.id === payload.id);
      label = (src && src.name) || '项目';
    }
    ghost.textContent = label;
    document.body.appendChild(ghost);
    moveGhost(t.clientX, t.clientY);
  }
  function moveGhost(x, y) {
    if (!ghost) return;
    ghost.style.left = (x - 70) + 'px';
    ghost.style.top  = (y - 18) + 'px';
  }
  function findDropTarget(x, y) {
    const elems = document.elementsFromPoint(x, y);
    for (const el of elems) {
      if (!el || !el.closest) continue;
      const cell = el.closest('[data-cal-day]');
      if (cell) return { kind: 'month', el: cell, dayMs: +cell.dataset.calDay };
      const col = el.closest('.cal-week-col[data-day-ms]');
      if (col) return { kind: 'time', el: col, dayMs: +col.dataset.dayMs, clientY: y };
    }
    return null;
  }
  function setHover(target) {
    const newEl = target ? target.el : null;
    if (lastHover === newEl) return;
    if (lastHover) lastHover.classList.remove('cal-sd-drop-hover');
    lastHover = newEl;
    if (lastHover) lastHover.classList.add('cal-sd-drop-hover');
  }
  function endDrag(t) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dragging) return;
    const target = t ? findDropTarget(t.clientX, t.clientY) : null;
    if (target) _calApplyDrop(payload, target);
    setHover(null);
    if (ghost) { ghost.remove(); ghost = null; }
    const dr = document.getElementById('cal-side-drawer');
    if (dr) dr.classList.remove('drag-fade');
    dragging = false;
    if (target) closeCalSideDrawer();
  }

  row.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (e.target.closest('button')) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => startDrag(t), LONG_PRESS_MS);
  }, { passive: true });
  row.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (!dragging) {
      if (Math.hypot(t.clientX - sx, t.clientY - sy) > MOVE_CANCEL) {
        if (timer) { clearTimeout(timer); timer = null; }
      }
      return;
    }
    e.preventDefault();
    moveGhost(t.clientX, t.clientY);
    setHover(findDropTarget(t.clientX, t.clientY));
  }, { passive: false });
  row.addEventListener('touchend', (e) => {
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    endDrag(t);
  });
  row.addEventListener('touchcancel', () => endDrag(null));
}

// 把 sidebar 的源(task / project)落到日历:复制 task / 改 project.dueStart-End
function _calApplyDrop(payload, target) {
  const buildSchedule = (startTs, endTs, allDay) => ({
    id: 'sl-' + Math.random().toString(36).slice(2, 10),
    kind: allDay ? 'date' : 'range',
    start: startTs,
    end: allDay ? undefined : endTs,
    allDay: !!allDay,
    repeat: 'none',
    reminderOffset: null,
  });
  let startTs, endTs, allDay;
  if (target.kind === 'month') {
    const d0 = startOfDay(new Date(target.dayMs)).getTime();
    startTs = d0;
    endTs = d0 + 24 * 3600000 - 1;
    allDay = true;
  } else {
    const r = target.el.getBoundingClientRect();
    const hourPx = (typeof MOBILE_CAL_HOUR_PX === 'function') ? MOBILE_CAL_HOUR_PX() : 48;
    const minutes = Math.max(0, Math.min(24 * 60 - 30, ((target.clientY - r.top) / hourPx) * 60));
    const SNAP = 15;
    const snapped = Math.round(minutes / SNAP) * SNAP;
    startTs = target.dayMs + snapped * 60000;
    endTs = startTs + 30 * 60000;
    allDay = false;
  }

  if (payload.kind === 'task') {
    const source = state.tasks.find(t => t.id === payload.id);
    if (!source) return;
    const sibs = state.tasks.filter(t => t.projectId === source.projectId && !t.parentTaskId && !t.parentEventId);
    const newOrder = sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 100 : 100;
    state.tasks.push({
      id: genId('t'),
      title: source.title || '',
      done: false,
      doneAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectId: source.projectId || null,
      parentTaskId: null,
      parentEventId: null,
      schedules: [buildSchedule(startTs, endTs, allDay)],
      tags: Array.isArray(source.tags) ? source.tags.slice() : [],
      images: [],
      completedOccurrences: [],
      order: newOrder,
      kanbanColumn: null,
      start: startTs,
      end: allDay ? null : endTs,
      allDay: !!allDay,
      dueAt: startTs,
    });
    pushState();
    showToast('已排上日历');
    renderAll();
  } else if (payload.kind === 'project') {
    const proj = state.projects.find(p => p.id === payload.id);
    if (!proj) return;
    const dayMs = startOfDay(new Date(target.dayMs)).getTime();
    proj.dueStart = dayMs;
    proj.dueEnd = dayMs;
    proj.updatedAt = Date.now();
    pushState();
    showToast('已设项目日期');
    renderAll();
  }
}

function projectTimelineBodyHtml(pid) {
  const p = state.projects.find(x => x.id === pid);
  if (!p) return '';
  const tl = ensureProjectTimeline(p);
  // 倒序:最新进度在最前;起点(最旧)沉到底部
  const nodes = [...tl].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const fmtTs = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const renderImage = (n) => {
    if (!n.image) return '';
    if (n.cloudFileID) {
      // 占位 src(1x1 透明 png),JS 异步替换为临时 URL
      return `<div class="proj-tl-img-wrap"><img class="proj-tl-img" data-cloud-file-id="${esc(n.cloudFileID)}" alt="${esc(n.title || '')}" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="></div>`;
    }
    // 桌面还没上传(或上传失败)→ 占位提示
    return `<div class="proj-tl-img-placeholder"><span class="ico-eye"></span><span>附图(等待桌面上传)</span></div>`;
  };
  const renderNode = (n) => {
    const elapsedLabel = (n.type === 'created') ? '起点' : fmtTimelineElapsed(projectFocusMsBefore(p.id, n.ts));
    const typeIcon = n.type === 'created' ? '◉' : n.type === 'task-done' ? '✓' : '◆';
    const editable = (n.type === 'manual');
    const editAttr = editable ? ` data-tl-node-id="${esc(n.id)}" data-tl-proj-id="${esc(p.id)}"` : '';
    return `<div class="proj-tl-node proj-tl-${esc(n.type || 'manual')} ${editable ? 'editable' : ''}"${editAttr}>
      <div class="proj-tl-marker">${typeIcon}</div>
      <div class="proj-tl-body">
        <div class="proj-tl-meta">
          <span class="proj-tl-elapsed">${esc(elapsedLabel)}</span>
          <span class="proj-tl-time">${esc(fmtTs(n.ts || 0))}</span>
        </div>
        <div class="proj-tl-title">${esc(n.title || '')}</div>
        ${n.note ? `<div class="proj-tl-note">${esc(n.note)}</div>` : ''}
        ${renderImage(n)}
      </div>
    </div>`;
  };
  // 加节点按钮放在列表上方 —— 倒序后顶部即「最新」,新增的节点也会出现在那里,贴近按钮
  const addBtn = `<button class="proj-tl-add-btn" data-tl-add-proj="${esc(p.id)}">
    <span class="ico-plus"></span><span>加节点</span>
  </button>`;
  if (!nodes.length) {
    return `${addBtn}<div class="empty" style="padding:14px;">还没有节点</div>`;
  }
  return `${addBtn}<div class="proj-tl-line">${nodes.map(renderNode).join('')}</div>`;
}

// 时间轴新建 manual 节点 sheet — 跟 edit 共用一套表单
function openTimelineNodeAddSheet(projId) {
  const p = state.projects.find(x => x.id === projId);
  if (!p) return;
  const now = new Date();
  const pd = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pd(now.getMonth()+1)}-${pd(now.getDate())}`;
  const timeStr = `${pd(now.getHours())}:${pd(now.getMinutes())}`;
  let pendingImg = null;   // { name, cloudFileID } or null
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="dp-detail">
      <div class="dp-head">
        <span class="dp-head-kind">加时间轴节点</span>
        <button class="dp-head-close" data-action="cancel" title="关闭">×</button>
      </div>
      <div class="dp-section">
        <input type="text" class="dp-title-input" id="tl-new-title" placeholder="节点标题">
      </div>
      <div class="dp-section">
        <textarea class="dp-note-input" id="tl-new-note" rows="3" placeholder="备注"></textarea>
      </div>
      <div class="dp-section">
        <div class="dp-section-title">时间</div>
        <div style="display:flex;gap:8px;">
          <input type="date" id="tl-new-date" value="${dateStr}" style="flex:1;padding:8px;border:1px solid var(--border-soft);background:var(--bg-input);color:var(--text);border-radius:8px;font-size:13px;">
          <input type="time" id="tl-new-time" value="${timeStr}" style="flex:1;padding:8px;border:1px solid var(--border-soft);background:var(--bg-input);color:var(--text);border-radius:8px;font-size:13px;">
        </div>
      </div>
      <div class="dp-section">
        <div class="dp-section-title">图片</div>
        <div id="tl-new-img-wrap" class="tl-img-wrap"></div>
        <label class="tl-img-add-btn">
          <input type="file" accept="image/*" id="tl-new-img-input" hidden>
          <span class="ico-plus"></span><span>选图片</span>
        </label>
      </div>
    </div>
    <div class="dp-footer">
      <button class="dp-more-btn" data-action="cancel">取消</button>
      <button class="dp-more-btn" data-action="save" style="background:var(--accent);color:#fff;">添加</button>
    </div>
  `, (body) => {
    const titleEl = body.querySelector('#tl-new-title');
    const imgWrap = body.querySelector('#tl-new-img-wrap');
    setTimeout(() => titleEl.focus(), 80);
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    const refreshImg = () => {
      if (!pendingImg) { imgWrap.innerHTML = ''; return; }
      imgWrap.innerHTML = `<div class="tl-img-preview">
        <span>📎 ${esc(pendingImg.name)}</span>
        <button class="tl-img-x" title="移除">×</button>
      </div>`;
      imgWrap.querySelector('.tl-img-x').onclick = () => { pendingImg = null; refreshImg(); };
    };
    body.querySelector('#tl-new-img-input').addEventListener('change', async (e) => {
      const f = (e.target.files || [])[0];
      if (!f) return;
      if (!tcbApp || !uid) { showToast('未登录,不能上传'); return; }
      showToast('上传中…');
      try {
        const cloudPath = `psfocus-timeline/${p.id}/${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const res = await tcbApp.uploadFile({ cloudPath, filePath: f });
        const fid = res && res.fileID;
        if (fid) { pendingImg = { name: f.name, cloudFileID: fid }; refreshImg(); showToast('已上传'); }
        else showToast('上传失败');
      } catch (err) { console.warn('[tl-upload]', err); showToast('上传失败'); }
      e.target.value = '';
    });
    body.querySelector('[data-action="save"]').onclick = () => {
      const newTitle = (titleEl.value || '').trim();
      if (!newTitle) { showToast('标题不能为空'); return; }
      const newNote = (body.querySelector('#tl-new-note').value || '').trim();
      const dateStr2 = body.querySelector('#tl-new-date').value;
      const timeStr2 = body.querySelector('#tl-new-time').value;
      const ts = combineDateAndTime(dateStr2, timeStr2);
      const node = {
        id: 'tl-' + genId('x').slice(2, 10),
        type: 'manual',
        ts: Number.isFinite(ts) ? ts : Date.now(),
        title: newTitle,
      };
      if (newNote) node.note = newNote;
      if (pendingImg) { node.image = pendingImg.name; node.cloudFileID = pendingImg.cloudFileID; }
      ensureProjectTimeline(p).push(node);
      p.updatedAt = Date.now();   // 时间轴节点变动算作项目更新
      pushState();
      closeSheet();
      renderAll();
      showToast('节点已添加');
    };
  });
}

// 时间轴节点编辑 sheet — 点击节点触发(只 manual 类型可编辑)
function openTimelineNodeEditSheet(projId, nodeId) {
  const p = state.projects.find(x => x.id === projId);
  if (!p) return;
  const n = (p.timeline || []).find(x => x.id === nodeId);
  if (!n) return;
  const tsToInputs = (ts) => {
    const d = new Date(ts || Date.now());
    const pd = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pd(d.getMonth()+1)}-${pd(d.getDate())}`,
      time: `${pd(d.getHours())}:${pd(d.getMinutes())}`,
    };
  };
  const t0 = tsToInputs(n.ts);
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="dp-detail">
      <div class="dp-head">
        <span class="dp-head-kind">编辑节点</span>
        <button class="dp-head-close" data-action="cancel" title="关闭">×</button>
      </div>
      <div class="dp-section">
        <input type="text" class="dp-title-input" id="tl-edit-title" placeholder="节点标题" value="${esc(n.title || '')}">
      </div>
      <div class="dp-section">
        <textarea class="dp-note-input" id="tl-edit-note" rows="3" placeholder="备注">${esc(n.note || '')}</textarea>
      </div>
      <div class="dp-section">
        <div class="dp-section-title">时间</div>
        <div style="display:flex;gap:8px;">
          <input type="date" id="tl-edit-date" value="${t0.date}" style="flex:1;padding:8px;border:1px solid var(--border-soft);background:var(--bg-input);color:var(--text);border-radius:8px;font-size:13px;">
          <input type="time" id="tl-edit-time" value="${t0.time}" style="flex:1;padding:8px;border:1px solid var(--border-soft);background:var(--bg-input);color:var(--text);border-radius:8px;font-size:13px;">
        </div>
      </div>
      <div class="dp-section">
        <div class="dp-section-title">图片</div>
        <div id="tl-edit-img-wrap" class="tl-img-wrap"></div>
        <label class="tl-img-add-btn">
          <input type="file" accept="image/*" id="tl-edit-img-input" hidden>
          <span class="ico-plus"></span><span>${n.cloudFileID ? '换图' : '加图'}</span>
        </label>
      </div>
    </div>
    <div class="dp-footer">
      <button class="dp-project-pill" data-action="del" style="color:var(--danger);"><span class="ico-trash"></span><span>删除</span></button>
      <button class="dp-more-btn" data-action="cancel">取消</button>
      <button class="dp-more-btn" data-action="save" style="background:var(--accent);color:#fff;">保存</button>
    </div>
  `, (body) => {
    // 编辑模式:本地暂存「待应用」的图片状态(避免改了 cancel 还是改了)
    let imgState = n.cloudFileID
      ? { name: n.image || '已附图', cloudFileID: n.cloudFileID, _orig: true }
      : null;
    const imgWrap = body.querySelector('#tl-edit-img-wrap');
    const refreshImg = () => {
      if (!imgState) { imgWrap.innerHTML = ''; return; }
      imgWrap.innerHTML = `<div class="tl-img-preview">
        <span>📎 ${esc(imgState.name)}</span>
        <button class="tl-img-x" title="移除">×</button>
      </div>`;
      imgWrap.querySelector('.tl-img-x').onclick = () => { imgState = null; refreshImg(); };
    };
    refreshImg();
    body.querySelector('#tl-edit-img-input').addEventListener('change', async (e) => {
      const f = (e.target.files || [])[0];
      if (!f) return;
      if (!tcbApp || !uid) { showToast('未登录,不能上传'); return; }
      showToast('上传中…');
      try {
        const cloudPath = `psfocus-timeline/${p.id}/${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const res = await tcbApp.uploadFile({ cloudPath, filePath: f });
        const fid = res && res.fileID;
        if (fid) { imgState = { name: f.name, cloudFileID: fid }; refreshImg(); showToast('已上传'); }
        else showToast('上传失败');
      } catch (err) { console.warn('[tl-upload]', err); showToast('上传失败'); }
      e.target.value = '';
    });
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      const newTitle = (body.querySelector('#tl-edit-title').value || '').trim();
      const newNote = (body.querySelector('#tl-edit-note').value || '').trim();
      const dateStr = body.querySelector('#tl-edit-date').value;
      const timeStr = body.querySelector('#tl-edit-time').value;
      if (!newTitle) { showToast('标题不能为空'); return; }
      n.title = newTitle;
      if (newNote) n.note = newNote; else delete n.note;
      const newTs = combineDateAndTime(dateStr, timeStr);
      if (Number.isFinite(newTs)) n.ts = newTs;
      // 图片同步
      if (imgState) {
        n.image = imgState.name;
        n.cloudFileID = imgState.cloudFileID;
      } else {
        delete n.image;
        delete n.cloudFileID;
      }
      p.updatedAt = Date.now();   // 时间轴节点变动算作项目更新
      pushState();
      closeSheet();
      renderAll();
      showToast('节点已更新');
    };
    body.querySelector('[data-action="del"]').onclick = () => {
      if (!confirm('删除这个节点?')) return;
      p.timeline = (p.timeline || []).filter(x => x.id !== nodeId);
      p.updatedAt = Date.now();   // 时间轴节点变动算作项目更新
      pushState();
      closeSheet();
      renderAll();
      showToast('节点已删除');
    };
  });
}

function taskCardHtml(t) {
  const proj = projectOf(t);
  const projColor = proj?.color || '';
  const timeStr = fmtTaskTime(t);
  const tCls = timeStateClass(t);
  const tags = (t.tags || []).slice(0, 3);
  const animCls = _animateDoneIds.has(t.id) ? ' just-done-anim' : '';
  return `
    <div class="card ${t.done ? 'completed' : ''}${animCls}" data-task-id="${esc(t.id)}">
      <div class="card-checkbox ${t.done ? 'checked' : ''}"><span class="ico-check"></span></div>
      <div class="card-body">
        <div class="card-title">${esc(t.title || '(无标题)')}</div>
        ${(timeStr || proj || tags.length) ? `<div class="card-meta">
          ${proj ? `${projColor ? `<span class="proj-color" style="background:${esc(projColor)}"></span>`:''}<span>${esc(proj.name)}</span>` : ''}
          ${(proj && (timeStr || tags.length)) ? `<span class="dot">·</span>` : ''}
          ${timeStr ? `<span class="meta-due ${tCls}">${esc(timeStr)}</span>` : ''}
          ${(timeStr && tags.length) ? `<span class="dot">·</span>` : ''}
          ${tags.map(tg => `<span class="tag-chip">${esc(tg)}</span>`).join('')}
        </div>` : ''}
      </div>
    </div>`;
}

function bindTaskCards(view) {
  view.querySelectorAll('.card[data-task-id]').forEach(card => {
    const id = card.dataset.taskId;
    card.querySelector('.card-checkbox').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTaskDone(id);
    });
    card.addEventListener('click', () => openTaskDetail(id));
  });
}

// 完成动画:勾选时把 task id 加进 Set,renderAll 后渲染时给对应行加 .just-done-anim class
const _animateDoneIds = new Set();
function _markDoneAnim(id) {
  if (!id) return;
  _animateDoneIds.add(id);
  setTimeout(() => _animateDoneIds.delete(id), 600);
}

function toggleTaskDone(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  // 重复任务勾选 = 完成 nextPending occurrence;非重复切 t.done
  const isRecurring = _isRecurringTask(t);
  if (isRecurring) {
    const recur = (t.schedules || []).find(s => s && s.repeat && s.repeat !== 'none');
    const pendingTs = _nextPendingOccurrence(t);
    if (recur && pendingTs != null) {
      toggleOccurrenceDone(t, recur, pendingTs);
      _markDoneAnim(id);
      pushState(); renderAll();
      showToast('已完成本次');
    }
    return;
  }
  const willBeDone = !t.done;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  if (willBeDone) _markDoneAnim(id);
  pushState(); renderAll();
}

// ----- 看板视图 -----
function renderKanbanView(view, cl) {
  const p = cl.project;
  const cols = (Array.isArray(p.kanbanColumns) && p.kanbanColumns.length) ? p.kanbanColumns : ['未开始', '进行中', '已完成'];
  const grouped = cols.map(col => ({
    name: col,
    tasks: cl.tasks.filter(t => (t.kanbanColumn || cols[0]) === col),
  }));
  const hideCompleted = !!p.hideCompleted;
  let html = `<div class="kanban">`;
  grouped.forEach(g => {
    let ts = g.tasks.slice();
    if (hideCompleted) ts = ts.filter(t => !t.done);
    ts.sort((a, b) => (a.done?1:0)-(b.done?1:0) || (b.createdAt||0)-(a.createdAt||0));
    html += `<div class="kanban-col">
      <div class="kanban-col-head"><span class="kanban-col-name">${esc(g.name)}</span><span class="kanban-col-count">${ts.length}</span></div>
      <div class="kanban-col-body">${ts.map(t => kanbanCardHtml(t, cols, g.name)).join('')}</div>
    </div>`;
  });
  html += `</div>`;
  view.innerHTML = html;
  bindTaskCards(view);
  // 绑定看板列切换:点卡片右下「⇄」可以切到下一列
  view.querySelectorAll('[data-kanban-next]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.kanbanNext;
      const t = state.tasks.find(x => x.id === id);
      if (!t) return;
      const i = cols.indexOf(t.kanbanColumn || cols[0]);
      t.kanbanColumn = cols[(i+1) % cols.length];
      pushState(); renderAll();
    });
  });
}
function kanbanCardHtml(t, cols, curCol) {
  const proj = projectOf(t);
  const tags = (t.tags || []).slice(0, 2);
  const timeStr = fmtTaskTime(t);
  const tCls = timeStateClass(t);
  return `
    <div class="card ${t.done ? 'completed' : ''}" data-task-id="${esc(t.id)}">
      <div class="card-checkbox ${t.done ? 'checked' : ''}"><span class="ico-check"></span></div>
      <div class="card-body">
        <div class="card-title">${esc(t.title || '(无标题)')}</div>
        ${(timeStr || tags.length) ? `<div class="card-meta">
          ${timeStr ? `<span class="meta-due ${tCls}">${esc(timeStr)}</span>` : ''}
          ${tags.map(tg => `<span class="tag-chip">${esc(tg)}</span>`).join('')}
        </div>` : ''}
        <div class="kanban-col-switch" data-kanban-next="${esc(t.id)}">→ ${esc(cols[(cols.indexOf(curCol)+1)%cols.length])}</div>
      </div>
    </div>`;
}

// ----- 甘特图视图(简化版) -----
function renderGanttView(view, cl) {
  const tasks = cl.tasks.filter(t => t.start || t.dueAt).slice();
  if (!tasks.length) {
    view.innerHTML = `<div class="empty">这个项目里没有任务设置时间<br><br>设置时间后,任务会显示在甘特图上</div>`;
    return;
  }
  // 找时间范围
  let minMs = Infinity, maxMs = -Infinity;
  tasks.forEach(t => {
    const a = t.start || t.dueAt, b = t.end || t.dueAt || a;
    if (a < minMs) minMs = a;
    if (b > maxMs) maxMs = b;
  });
  // 最少 14 天范围
  const DAY = 86400000;
  if (maxMs - minMs < 14*DAY) maxMs = minMs + 14*DAY;
  const min0 = startOfDay(new Date(minMs)).getTime();
  const max0 = startOfDay(new Date(maxMs)).getTime() + DAY;
  const totalDays = Math.ceil((max0 - min0) / DAY);
  const COL_W = 36, ROW_H = 40, TITLE_W = 120;
  // 表头
  let header = '';
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(min0 + i*DAY);
    const isToday = d.toDateString() === new Date().toDateString();
    const isWk = d.getDay() === 0 || d.getDay() === 6;
    header += `<div class="gantt-day ${isToday?'today':''} ${isWk?'weekend':''}" style="width:${COL_W}px">
      <div class="gantt-day-num">${d.getDate()}</div>
      <div class="gantt-day-dow">${'日一二三四五六'[d.getDay()]}</div>
    </div>`;
  }
  // 任务行
  const rows = tasks.map(t => {
    const a = t.start || t.dueAt, b = t.end || t.dueAt || a;
    const left = TITLE_W + ((a - min0) / DAY) * COL_W;
    const width = Math.max(8, ((b - a) / DAY) * COL_W);
    const proj = projectOf(t);
    const color = proj?.color || 'var(--accent)';
    return `<div class="gantt-row" data-task-id="${esc(t.id)}">
      <div class="gantt-row-title">${esc(t.title || '(无标题)')}</div>
      <div class="gantt-bar ${t.done?'done':''}" style="left:${left}px;width:${width}px;background:${esc(color)}1a;border-color:${esc(color)};color:${esc(color)};">
        <span class="gantt-bar-label">${esc(t.title || '')}</span>
      </div>
    </div>`;
  }).join('');
  view.innerHTML = `
    <div class="gantt-wrap">
      <div class="gantt-scroll">
        <div class="gantt-header" style="width:${totalDays*COL_W}px;">${header}</div>
        <div class="gantt-body" style="width:${totalDays*COL_W + TITLE_W}px;">${rows}</div>
      </div>
    </div>`;
  view.querySelectorAll('.gantt-row[data-task-id]').forEach(row => {
    row.addEventListener('click', () => openTaskDetail(row.dataset.taskId));
  });
}

// =========================================================
// ===== 任务详情抽屉 =====
// =========================================================
function openTaskDetail(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  // 保留 sheet 已打开时的滚动位置(子任务勾选/添加/删除等局部操作不要回顶)
  const _sheetEl = $('sheet');
  const _wasOpen = _sheetEl && !_sheetEl.classList.contains('hidden');
  const _prevScrollTop = _wasOpen ? (($('sheet-body').querySelector('.dp-detail') || {}).scrollTop || 0) : 0;
  const proj = projectOf(t);
  const projColor = proj ? (proj.color || '') : '';
  const projLabel = proj ? proj.name : '未分类';

  const isRecurring = _isRecurringTask(t);
  // 显示完成态:重复任务 → 看 nextPending occurrence 是否在已完成集合(永远 false:nextPending = 未完成的下一个)
  // 实际上 nextPending 永远是"未完成"的 → 显示未勾。点击 = 把它推进 completedOccurrences
  // 非重复 → 看 t.done
  const checked = isRecurring ? false : !!t.done;

  // 累计专注
  const ms = (state.sessions || []).filter(s => s.taskId === t.id).reduce((sum, s) => sum + (s.duration || 0), 0);
  const focusedHtml = ms >= 1000 ? `<div class="dp-meta"><span class="dp-meta-pill"><span class="ico-clock"></span>${esc(fmtHuman(ms))}</span></div>` : '';

  // schedule pill 行
  const schedules = (t.schedules && t.schedules.length)
    ? t.schedules
    : (t.start ? [{ id: 'legacy', start: t.start, end: t.end, allDay: t.allDay, repeat: 'none', kind: 'range' }] : []);
  // 对齐列表 fmtTaskTime:重复任务的 pill 显示"下一次未完成 occurrence",而不是原始 start
  const completedOcc = new Set(Array.isArray(t.completedOccurrences) ? t.completedOccurrences : []);
  const _effectiveSchedule = (s) => {
    if (!s || !s.start || !s.repeat || s.repeat === 'none') return s;
    const dur = (s.end && s.start) ? (s.end - s.start) : 0;
    let occ = new Date(s.start);
    if (s.repeat === 'workday' && (occ.getDay() === 0 || occ.getDay() === 6)) {
      do { occ.setDate(occ.getDate() + 1); } while (occ.getDay() === 0 || occ.getDay() === 6);
    }
    let safety = 5000;
    while (safety-- > 0) {
      const ts = occ.getTime();
      if (!completedOcc.has(ts)) {
        return { ...s, start: ts, end: dur > 0 ? ts + dur : null };
      }
      const next = new Date(occ);
      if (s.repeat === 'daily') next.setDate(next.getDate() + 1);
      else if (s.repeat === 'weekly') next.setDate(next.getDate() + 7);
      else if (s.repeat === 'monthly') next.setMonth(next.getMonth() + 1);
      else if (s.repeat === 'workday') {
        do { next.setDate(next.getDate() + 1); } while (next.getDay() === 0 || next.getDay() === 6);
      } else break;
      occ = next;
      if (occ.getTime() - Date.now() > 365 * 86400000 * 5) break;
    }
    return s;
  };
  const _schedStateClass = (s) => {
    if (t.done) return '';
    if (!s || !s.start) return '';
    const today0 = startOfDay(new Date()).getTime();
    const today1 = today0 + 86400000;
    if (s.start < today0) return 'overdue';
    if (s.start < today1) return 'today';
    return 'future';
  };
  const schedHtml = schedules.map(s => {
    const eff = _effectiveSchedule(s);
    return `<span class="dp-sched-pill ${_schedStateClass(eff)}">
      <span class="ico-clock"></span>
      <span class="dp-sched-text">${esc(fmtSchedule(eff))}</span>
      <button class="dp-sched-x" data-action="dp-remove-schedule" data-task-id="${t.id}" data-sched-id="${esc(s.id || 'legacy')}" title="删除此时间">×</button>
    </span>`;
  }).join('');

  // 子任务 — union 桌面模型(parentTaskId)+ 老 mobile 模型(t.subtasks 数组)
  // 重复任务下「检查事项(checklistItem=true)」的完成态走 parent.subtaskCompletions[dayKey] map,
  // 跟自然时间走,每次出现自动重置 — 对齐桌面 _subtaskDoneFor 逻辑
  const _parentRecurring = _isRecurringTaskM(t);
  const _occStart = _parentRecurring ? _currentOccurrenceForTaskM(t) : null;
  const _isChecklistDoneNow = (sub) => {
    if (!sub || sub.checklistItem !== true) return !!sub.done;
    if (!_parentRecurring || _occStart == null) return false;
    const key = _occDayKeyM(_occStart);
    const all = t.subtaskCompletions || {};
    const occ = all[key] || all[_occStart] || {};
    return !!occ[sub.id];
  };
  const childTasks = (state.tasks || [])
    .filter(x => x.parentTaskId === t.id)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const legacySubs = Array.isArray(t.subtasks) ? t.subtasks : [];
  const subItemsRaw = [
    ...childTasks.map(c => ({
      source: 'task', id: c.id, title: c.title,
      checklistItem: c.checklistItem === true,
      done: _isChecklistDoneNow(c),
    })),
    ...legacySubs.map(s => ({
      source: 'legacy', id: s.id, title: s.title,
      checklistItem: false,
      done: !!s.done,
    })),
  ];
  // 普通子任务(checklistItem=false)在上,检查事项在下;同组内未完成在前已完成在后
  const normalSubs = subItemsRaw.filter(s => !s.checklistItem)
    .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
  const checklistSubs = subItemsRaw.filter(s => s.checklistItem)
    .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
  const _renderSubRow = (s) => `
    <li class="dp-sub ${s.done?'done':''}" data-sub-id="${esc(s.id)}" data-sub-source="${s.source}"${s.checklistItem ? ' data-sub-checklist="1"' : ''}>
      <button class="dp-sub-check ${s.done?'done':''}" data-action="toggle-sub">${s.done ? '✓' : ''}</button>
      ${s.checklistItem ? '<span class="dp-sub-checklist-mark" title="检查事项 — 每次重复都会重置">≡</span>' : ''}
      <span class="dp-sub-title" contenteditable="true" spellcheck="false" data-action="edit-sub-title">${esc(s.title || '')}</span>
      <button class="dp-sub-del" data-action="del-sub" title="删除">×</button>
    </li>`;
  let subsInner = normalSubs.map(_renderSubRow).join('');
  if (checklistSubs.length) {
    if (normalSubs.length) subsInner += `<li class="dp-sub-divider"><span>检查事项</span></li>`;
    subsInner += checklistSubs.map(_renderSubRow).join('');
  }
  const subsHtml = subItemsRaw.length
    ? `<ul class="dp-sub-list">${subsInner}</ul>`
    : '<div class="dp-empty">还没有子任务</div>';

  // 标签 chips + 全局 tag 列表(用于 datalist)
  const tags = Array.isArray(t.tags) ? t.tags : [];
  const allTagNames = (() => {
    const reg = ((state.settings && state.settings.tags) || []).map(x => x && x.name).filter(Boolean);
    const seen = new Set(reg);
    const out = reg.slice();
    for (const tk of (state.tasks || [])) for (const tg of (tk.tags || [])) if (!seen.has(tg)) { seen.add(tg); out.push(tg); }
    return out;
  })();
  const tagChipsHtml = tags.map(tg => {
    const c = colorOfTag(tg);
    return `<span class="dp-tag-chip" style="background:color-mix(in srgb,${esc(c)} 15%,transparent);color:${esc(c)};border-color:color-mix(in srgb,${esc(c)} 40%,transparent);">
      <span>${esc(tg)}</span>
      <button class="dp-tag-chip-x" data-action="dp-remove-tag" data-tag="${esc(tg)}" title="移除">×</button>
    </span>`;
  }).join('');
  const datalistId = 'dp-all-tags-' + t.id;

  // 图片(任务自身的)
  const images = Array.isArray(t.images) ? t.images : [];
  const imagesHtml = images.map(im => `
    <div class="dp-image-cell" data-img-id="${esc(im.id)}">
      <img class="dp-image" data-cloud-file-id="${esc(im.cloudFileID)}" alt="${esc(im.name || '')}" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=">
      <button class="dp-image-del" data-action="dp-task-del-image" data-img-id="${esc(im.id)}" title="删除">×</button>
    </div>
  `).join('');

  const sheet = $('sheet'), body = $('sheet-body');
  body.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="dp-detail">

      <div class="dp-time-bar">
        ${schedHtml}
        <button class="dp-add-sched-btn" data-action="dp-add-schedule" title="加时间">
          <span class="ico-plus"></span>
          <span>${schedules.length ? '改' : '加时间'}</span>
        </button>
      </div>

      <div class="dp-title-row">
        <button class="dp-check ${checked ? 'done' : ''}" data-action="toggle-done" title="${checked ? '标记未完成' : '标记完成'}">${checked ? '✓' : ''}</button>
        <input type="text" class="dp-title-input ${checked ? 'done' : ''}" value="${esc(t.title || '')}" />
      </div>

      ${focusedHtml}

      <div class="dp-section dp-merged-section">
        <textarea class="dp-note-input" rows="3" placeholder="备注、笔记…  输入 #xxx 自动加标签;粘贴图片直接上传">${esc(t.note || '')}</textarea>
        <div class="dp-merged-row">
          <div class="dp-merged-tags">${tagChipsHtml || '<span class="dp-merged-tags-empty">暂无标签</span>'}</div>
          <label class="dp-merged-add-img" title="上传图片">
            <input type="file" accept="image/*" multiple data-action="dp-task-add-images" hidden>
            <span class="ico-plus"></span>
          </label>
        </div>
        ${images.length ? `<div class="dp-image-grid">${imagesHtml}</div>` : ''}
      </div>
      <datalist id="${datalistId}">
        ${allTagNames.filter(x => !tags.includes(x)).map(x => `<option value="${esc(x)}"></option>`).join('')}
      </datalist>

      <div class="dp-section">
        <div class="dp-section-title">子待办 <span class="dp-section-count">${subItemsRaw.length}</span></div>
        <div class="dp-sub-add">
          <input type="text" class="dp-sub-add-input" placeholder="加个子任务,回车确认">
        </div>
        ${subsHtml}
      </div>
    </div>
    <div class="dp-footer">
      <button class="dp-project-pill" data-action="dp-pick-project">
        ${projColor ? `<span class="dp-project-dot" style="background:${esc(projColor)}"></span>` : '<span class="ico-folder"></span>'}
        <span>${esc(projLabel)}</span>
      </button>
      <button class="dp-more-btn" data-action="task-detail-more" title="更多"><span class="ico-more"></span></button>
    </div>
  `;
  body.style.transform = '';
  body.style.transition = '';
  sheet.classList.remove('hidden');
  bindTaskDetailEvents(body, id);
  bindSheetSwipeClose(body);
  // 恢复滚动位置(在 bind 之后,DOM 已就绪)
  if (_wasOpen && _prevScrollTop > 0) {
    const dp = body.querySelector('.dp-detail');
    if (dp) dp.scrollTop = _prevScrollTop;
  }
}
function bindTaskDetailEvents(body, id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  body.querySelector('[data-action="task-detail-close"]').onclick = closeSheet;
  body.querySelector('[data-action="task-detail-more"]').onclick = (ev) => { ev.stopPropagation(); openTaskDetailMenu(id, ev.currentTarget); };

  // 标题
  const titleEl = body.querySelector('.dp-title-input');
  titleEl.addEventListener('blur', () => {
    const v = titleEl.value.trim();
    if (v && v !== t.title) { t.title = v; pushState(); renderAll(); }
  });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleEl.blur(); });

  // 大勾选 — 重复任务切 nextPending occurrence,非重复切全局
  // 同时绑 click 和 touchend,防 iOS Safari 上 sheet swipe 的 passive:false touchmove 偶尔吞掉后续 click
  const checkBtn = body.querySelector('[data-action="toggle-done"]');
  if (checkBtn) {
    let _checkBusy = false;
    const doToggle = (ev) => {
      if (ev) { ev.stopPropagation(); ev.preventDefault(); }
      if (_checkBusy) return;
      _checkBusy = true;
      setTimeout(() => { _checkBusy = false; }, 350);
      const isRecurring = _isRecurringTask(t);
      if (isRecurring) {
        const pendingTs = _nextPendingOccurrence(t);
        const recur = (t.schedules || []).find(s => s && s.repeat && s.repeat !== 'none');
        if (recur && pendingTs != null) {
          toggleOccurrenceDone(t, recur, pendingTs);
          pushState(); openTaskDetail(id); renderAll();
          showToast('已完成本次');
        }
      } else {
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : null;
        pushState(); openTaskDetail(id); renderAll();
      }
    };
    checkBtn.addEventListener('click', doToggle);
    checkBtn.addEventListener('touchend', doToggle);
  }

  // 把第一个 schedule 同步回 legacy 字段(start/end/allDay/dueAt)— 老桌面端只看 legacy
  const _syncLegacyFromSchedules = () => {
    if (!t.schedules || !t.schedules.length) {
      t.start = null; t.end = null; t.allDay = false; t.dueAt = null;
    } else {
      const s0 = t.schedules[0];
      t.start = s0.start || null;
      t.end = s0.end || null;
      t.allDay = !!s0.allDay;
      t.dueAt = s0.start || null;
    }
  };

  // 加时间按钮 → 走支持重复的 picker
  body.querySelector('[data-action="dp-add-schedule"]').onclick = () => {
    openQuickTimePickerSheet(null, (newSched) => {
      if (!newSched) return;
      if (!Array.isArray(t.schedules)) t.schedules = [];
      t.schedules.push(newSched);
      _syncLegacyFromSchedules();
      pushState(); openTaskDetail(id); renderAll();
    });
  };

  // schedule pill 点击文字/图标区域 → 编辑该 schedule(支持改重复设置)
  body.querySelectorAll('.dp-sched-pill').forEach(pill => {
    const xBtn = pill.querySelector('.dp-sched-x');
    const sid = xBtn?.dataset.schedId;
    const editArea = pill.querySelector('.dp-sched-text');
    if (!editArea) return;
    // 同时让 ico-clock 也能点
    const clickAreas = [editArea, pill.querySelector('.ico-clock')].filter(Boolean);
    clickAreas.forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const existing = (sid && sid !== 'legacy')
          ? (t.schedules || []).find(s => s.id === sid)
          : (t.schedules || [])[0] || (t.start ? { start: t.start, end: t.end, allDay: !!t.allDay, repeat: 'none' } : null);
        openQuickTimePickerSheet(existing || null, (newSched) => {
          if (!newSched) return;
          if (!Array.isArray(t.schedules)) t.schedules = [];
          if (sid && sid !== 'legacy') {
            const idx = t.schedules.findIndex(s => s.id === sid);
            if (idx >= 0) t.schedules[idx] = newSched;
            else t.schedules.push(newSched);
          } else {
            // legacy 或第一段:整体覆盖第一段
            if (t.schedules.length) t.schedules[0] = newSched;
            else t.schedules.push(newSched);
          }
          _syncLegacyFromSchedules();
          pushState(); openTaskDetail(id); renderAll();
        });
      });
    });
  });

  // schedule pill ×按钮 → 删除
  body.querySelectorAll('[data-action="dp-remove-schedule"]').forEach(b => b.onclick = (ev) => {
    ev.stopPropagation();
    const sid = b.dataset.schedId;
    if (sid && sid !== 'legacy' && Array.isArray(t.schedules)) {
      t.schedules = t.schedules.filter(s => s.id !== sid);
    }
    if (sid === 'legacy') t.schedules = [];
    _syncLegacyFromSchedules();
    pushState(); openTaskDetail(id); renderAll();
  });

  // 备注 + #tag 自动解析:blur 时把 note 里的 #xxx 抽取为标签(去重),note 文本保留
  const noteEl = body.querySelector('.dp-note-input');
  if (noteEl) {
    noteEl.addEventListener('blur', () => {
      const v = noteEl.value;
      const noteChanged = v !== (t.note || '');
      // 解析 #xxx(支持中英文 / 数字 / _),停在空白或换行处
      const found = [];
      const re = /#([^\s#,。、,]+)/g;
      let m;
      while ((m = re.exec(v)) !== null) {
        const tg = m[1].trim();
        if (tg) found.push(tg);
      }
      const before = (t.tags || []).slice();
      const tagsChanged = found.length && (() => {
        let changed = false;
        for (const tg of found) {
          if (!before.includes(tg)) {
            t.tags = t.tags || [];
            t.tags.push(tg);
            // 注册到 settings.tags(若不存在)
            if (!Array.isArray(state.settings.tags)) state.settings.tags = [];
            if (!state.settings.tags.find(x => x.name === tg)) {
              const max = state.settings.tags.length ? Math.max(...state.settings.tags.map(x => x.order || 0)) : 0;
              state.settings.tags.push({ name: tg, color: '', order: max + 100 });
            }
            changed = true;
          }
        }
        return changed;
      })();
      if (noteChanged) t.note = v;
      if (noteChanged || tagsChanged) {
        pushState();
        if (tagsChanged) { openTaskDetail(id); renderAll(); }
      }
    });
    // 粘贴图片直接上传
    noteEl.addEventListener('paste', async (ev) => {
      const items = (ev.clipboardData && ev.clipboardData.items) || [];
      const imgItems = [];
      for (const it of items) if (it.type && it.type.startsWith('image/')) imgItems.push(it);
      if (!imgItems.length) return;
      ev.preventDefault();
      showToast(`上传 ${imgItems.length} 张图…`);
      t.images = Array.isArray(t.images) ? t.images : [];
      let okCount = 0;
      for (const it of imgItems) {
        const f = it.getAsFile();
        if (!f) continue;
        try {
          const cloudPath = `psfocus-task-images/${uid}/${t.id}/${Date.now()}-paste.png`;
          const res = await tcbApp.uploadFile({ cloudPath, filePath: f });
          const fileID = res && res.fileID;
          if (fileID) {
            t.images.push({ id: 'img-' + Math.random().toString(36).slice(2, 10), cloudFileID: fileID, name: f.name || 'paste.png', uploadedAt: Date.now() });
            okCount++;
          }
        } catch (err) { console.warn('[paste-upload]', err); }
      }
      if (okCount) {
        t.updatedAt = Date.now();
        pushState();
        showToast(`已粘贴 ${okCount} 张`);
        openTaskDetail(id);
      } else {
        showToast('粘贴失败');
      }
    });
  }

  // 标签 chip × 删除(只此一个入口,合并 UI 后不再有 input 加标签 — 改在 note 里输 #xxx)
  body.querySelectorAll('[data-action="dp-remove-tag"]').forEach(b => b.onclick = (ev) => {
    ev.stopPropagation();
    const tg = b.dataset.tag;
    t.tags = (t.tags || []).filter(x => x !== tg);
    pushState(); openTaskDetail(id); renderAll();
  });

  // 子任务 — toggle / 删除 / 添加 / 编辑标题(支持桌面 parentTaskId 模型 + 老 mobile t.subtasks)
  body.querySelectorAll('[data-sub-id]').forEach(row => {
    const sid = row.dataset.subId;
    const source = row.dataset.subSource;
    row.querySelector('[data-action="toggle-sub"]').onclick = () => {
      if (source === 'task') {
        const child = state.tasks.find(x => x.id === sid);
        if (!child) { pushState(); openTaskDetail(id); return; }
        // 检查事项 + 父重复 → per-occurrence map(各次出现独立勾选)
        if (child.checklistItem === true && _isRecurringTaskM(t)) {
          const occ = _currentOccurrenceForTaskM(t);
          if (occ != null) {
            _toggleSubtaskForM(child, t, occ);
            pushState(); openTaskDetail(id); return;
          }
        }
        // 普通子任务 → 老路径
        child.done = !child.done; child.doneAt = child.done ? Date.now() : null; child.updatedAt = Date.now();
      } else {
        const s = (t.subtasks || []).find(x => x.id === sid);
        if (s) { s.done = !s.done; s.doneAt = s.done ? Date.now() : null; }
      }
      pushState(); openTaskDetail(id);
    };
    row.querySelector('[data-action="del-sub"]').onclick = () => {
      if (source === 'task') {
        state.tasks = state.tasks.filter(x => x.id !== sid);
      } else {
        t.subtasks = (t.subtasks || []).filter(x => x.id !== sid);
      }
      pushState(); openTaskDetail(id); renderAll();
    };
    // 单击标题就修改 — contenteditable + blur 保存,Enter 也保存
    const titleEl = row.querySelector('[data-action="edit-sub-title"]');
    if (titleEl) {
      const save = () => {
        const v = (titleEl.textContent || '').trim();
        if (source === 'task') {
          const child = state.tasks.find(x => x.id === sid);
          if (child && v && child.title !== v) { child.title = v; child.updatedAt = Date.now(); pushState(); }
        } else {
          const s = (t.subtasks || []).find(x => x.id === sid);
          if (s && v && s.title !== v) { s.title = v; pushState(); }
        }
      };
      titleEl.addEventListener('blur', save);
      titleEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
      });
    }
  });
  const addSubInput = body.querySelector('.dp-sub-add-input');
  addSubInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = addSubInput.value.trim();
    if (!v) return;
    // 新子任务用桌面模型(独立 task + parentTaskId),跟桌面同步
    const maxOrder = state.tasks
      .filter(x => x.parentTaskId === t.id)
      .reduce((m, x) => Math.max(m, x.order || 0), 0);
    state.tasks.push({
      id: genId('t'),
      title: v,
      done: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectId: t.projectId || null,
      parentTaskId: t.id,
      parentEventId: null,
      schedules: [],
      tags: [],
      completedOccurrences: [],
      order: maxOrder + 100,
      kanbanColumn: null,
    });
    pushState(); openTaskDetail(id); renderAll();
  });

  // 项目 pill — 切换所属清单/项目
  body.querySelector('[data-action="dp-pick-project"]').onclick = (ev) => {
    ev.stopPropagation();
    openProjectPicker(t.projectId, ev.currentTarget, (newPid) => {
      t.projectId = newPid;
      t.updatedAt = Date.now();
      pushState();
      openTaskDetail(id);
      renderAll();
    });
  };

  // 图片:上传 + 删除
  const fileInput = body.querySelector('[data-action="dp-task-add-images"]');
  if (fileInput) fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    showToast(`上传 ${files.length} 张图…`);
    t.images = Array.isArray(t.images) ? t.images : [];
    let okCount = 0;
    for (const f of files) {
      try {
        const cloudPath = `psfocus-task-images/${uid}/${t.id}/${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const res = await tcbApp.uploadFile({ cloudPath, filePath: f });
        const fileID = res && res.fileID;
        if (fileID) {
          t.images.push({ id: 'img-' + Math.random().toString(36).slice(2, 10), cloudFileID: fileID, name: f.name, uploadedAt: Date.now() });
          okCount++;
        }
      } catch (err) {
        console.warn('[upload]', err);
      }
    }
    fileInput.value = '';
    if (okCount) {
      t.updatedAt = Date.now();
      pushState();
      showToast(`已上传 ${okCount} 张`);
      openTaskDetail(id); // 刷新图片网格
    } else {
      showToast('上传失败');
    }
  });
  body.querySelectorAll('[data-action="dp-task-del-image"]').forEach(b => b.onclick = (ev) => {
    ev.stopPropagation();
    const imgId = b.dataset.imgId;
    if (!confirm('删除这张图?')) return;
    t.images = (t.images || []).filter(x => x.id !== imgId);
    t.updatedAt = Date.now();
    pushState();
    openTaskDetail(id);
  });

  // 异步加载所有云图(图片 + 时间轴 placeholder 等任何 data-cloud-file-id)
  bindCloudTimelineImages(body);
}

// ----- 时间编辑器 -----
function openTimeEditor(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const dateVal = tsToDateInput(t.dueAt || t.start);
  const timeVal = tsToTimeInput(t.dueAt || t.start);
  const allDay = !!t.allDay;
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 8px;">设置时间</div>
      <div class="form-row"><label>日期</label><input type="date" id="time-date" value="${esc(dateVal)}"></div>
      <div class="form-row"><label>时间</label><input type="time" id="time-time" value="${esc(timeVal)}" ${allDay?'disabled':''}></div>
      <div class="form-row"><label>全天</label><label class="form-toggle"><input type="checkbox" id="time-allday" ${allDay?'checked':''}><span></span></label></div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button data-action="clear" class="danger">清除</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    const dEl = body.querySelector('#time-date');
    const tEl = body.querySelector('#time-time');
    const aEl = body.querySelector('#time-allday');
    aEl.onchange = () => { tEl.disabled = aEl.checked; };
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="clear"]').onclick = () => {
      t.dueAt = null; t.start = null; t.end = null; t.allDay = false;
      pushState(); closeSheet(); openTaskDetail(id);
    };
    body.querySelector('[data-action="save"]').onclick = () => {
      const ts = combineDateAndTime(dEl.value, aEl.checked ? '' : tEl.value);
      if (!ts) return;
      t.dueAt = ts;
      t.start = ts;
      t.allDay = aEl.checked;
      pushState(); closeSheet(); openTaskDetail(id);
    };
  });
}

// ----- 标签编辑器 -----
function openTagEditor(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const allTags = uniq([
    ...(state.tags || []).map(x => typeof x === 'string' ? x : x?.name).filter(Boolean),
    ...state.tasks.flatMap(x => Array.isArray(x.tags) ? x.tags : []),
  ]).filter(Boolean);
  const cur = new Set(t.tags || []);
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 8px;">选择标签</div>
      <input id="tag-new-input" placeholder="输入新标签按回车添加" style="margin-bottom:10px;">
      <div class="tag-list">
        ${allTags.length ? allTags.map(tg => `
          <label class="tag-row">
            <input type="checkbox" data-tag="${esc(tg)}" ${cur.has(tg)?'checked':''}>
            <span>${esc(tg)}</span>
          </label>
        `).join('') : '<div class="empty" style="padding:20px;">还没有标签,在上面输入框新建</div>'}
      </div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    const newInput = body.querySelector('#tag-new-input');
    const list = body.querySelector('.tag-list');
    newInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = newInput.value.trim();
        if (!v || allTags.includes(v)) return;
        allTags.push(v); cur.add(v);
        list.insertAdjacentHTML('afterbegin', `<label class="tag-row"><input type="checkbox" data-tag="${esc(v)}" checked><span>${esc(v)}</span></label>`);
        newInput.value = '';
      }
    });
    list.addEventListener('change', (e) => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement)) return;
      const tag = cb.dataset.tag;
      if (cb.checked) cur.add(tag); else cur.delete(tag);
    });
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      t.tags = Array.from(cur);
      // 把新标签登记到 state.tags
      const known = new Set((state.tags || []).map(x => typeof x === 'string' ? x : x?.name));
      t.tags.forEach(tg => { if (!known.has(tg)) state.tags.push(tg); });
      pushState(); closeSheet(); openTaskDetail(id);
    };
  });
}

// ----- 通用 sheet 显示 -----
function showSheet(html, onMount) {
  const sheet = $('sheet'), body = $('sheet-body');
  body.innerHTML = html;
  body.style.transform = '';
  body.style.transition = '';
  sheet.classList.remove('hidden');
  if (onMount) onMount(body);
  bindSheetSwipeClose(body);
}
function closeSheet() {
  const body = $('sheet-body');
  body.style.transform = '';
  body.style.transition = '';
  $('sheet').classList.add('hidden');
  body.innerHTML = '';
  // 清掉 day-edit 上下文标记
  if (typeof summaryState !== 'undefined') summaryState._dayEditOpen = null;
}
// 下拉关闭手势 — 接受 sheet 顶部 60px 区域内任何位置触摸,识别区扩大
// 触摸点落在输入控件 / 按钮上时跳过(避免影响打字 / 点击)
function bindSheetSwipeClose(body) {
  let startY = 0, dy = 0, dragging = false;
  const HIT_AREA_PX = 60; // 顶部 60px 内任何空白区域可下拉
  function isInteractive(target) {
    if (!(target instanceof Element)) return false;
    return !!target.closest('input, textarea, select, button, [contenteditable="true"]');
  }
  function onStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const r = body.getBoundingClientRect();
    if (t.clientY - r.top > HIT_AREA_PX) return;
    if (isInteractive(t.target)) return;
    startY = t.clientY;
    dy = 0;
    dragging = true;
    body.style.transition = 'none';
  }
  function onMove(e) {
    if (!dragging) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    body.style.transform = `translateY(${dy}px)`;
    if (dy > 5 && e.cancelable) e.preventDefault();
  }
  function onEnd() {
    if (!dragging) return;
    dragging = false;
    body.style.transition = 'transform .22s ease';
    const threshold = Math.max(80, body.offsetHeight * 0.25);
    if (dy > threshold) {
      body.style.transform = `translateY(${body.offsetHeight}px)`;
      setTimeout(() => closeSheet(), 220);
    } else {
      body.style.transform = '';
    }
  }
  body.addEventListener('touchstart', onStart, { passive: true });
  body.addEventListener('touchmove',  onMove,  { passive: false });
  body.addEventListener('touchend',   onEnd,   { passive: true });
  body.addEventListener('touchcancel',onEnd,   { passive: true });
}

// ----- 详情更多菜单 -----
function openTaskDetailMenu(id, anchor) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  showPopover([
    { label: '保存为模板', icon: 'ico-template', action: () => { closePopover(); openSaveTaskAsTemplateSheet(id); } },
    { divider: true },
    { label: '删除任务', icon: 'ico-trash', danger: true, action: () => {
      state.tasks = state.tasks.filter(x => x.id !== id);
      pushState(); closePopover(); closeSheet(); renderAll();
    }},
  ], { anchor });
}

// ===== 模板系统 =====
function buildTaskTemplatePayload(task) {
  return {
    title: task.title || '',
    duration: (task.start && task.end) ? (task.end - task.start) : null,
    allDay: !!task.allDay,
    color: task.color || '',
    tags: Array.isArray(task.tags) ? [...task.tags] : [],
    subtasks: (Array.isArray(task.subtasks) ? task.subtasks : [])
      .map(s => ({ title: s.title || '' })),
  };
}
function applyTaskTemplate(tmpl, dayMs, projectId, opts) {
  const p = tmpl.payload || {};
  opts = opts || {};
  const hasExplicitStart = Number.isFinite(opts.startTs);
  // 调用方传了具体时间(从时间轴拖出来)→ 一定不是全天;否则尊重模板
  const allDay = hasExplicitStart ? false : !!p.allDay;
  // start 取值优先级:
  //   opts.startTs(明确传)→ 直接用(从时间轴拖出来时,只接管起点;时长仍走模板)
  //   日历选中日 = 今天 → 当前时刻 + 5min snap(对齐 Kayu 期望"从触发时间点创建")
  //   日历选中日 ≠ 今天 → 那天 09:00(只能落到目标日)
  //   未传 dayMs → 当前时刻
  let start;
  if (hasExplicitStart) {
    start = opts.startTs;
  } else if (Number.isFinite(dayMs)) {
    const today0 = startOfDay(new Date()).getTime();
    const day0 = startOfDay(new Date(dayMs)).getTime();
    if (day0 === today0) {
      // 当前时间向上对 5 分钟取整
      const now = new Date();
      now.setSeconds(0, 0);
      const SNAP = 5;
      const min = now.getMinutes();
      now.setMinutes(Math.ceil(min / SNAP) * SNAP);
      start = now.getTime();
    } else {
      start = combineDateAndTime(tsToDateInput(dayMs), '09:00');
    }
  } else {
    const now = new Date(); now.setSeconds(0, 0);
    const min = now.getMinutes();
    now.setMinutes(Math.ceil(min / 5) * 5);
    start = now.getTime();
  }
  // end 始终用模板 duration(用户拖出来的时长被故意忽略 —— Kayu 要求模板任务保留模板时长)
  const dur = (Number.isFinite(p.duration) && p.duration > 0) ? p.duration : 30 * 60000;
  const end = start + dur;
  const sibs = state.tasks.filter(t => t.projectId === (projectId || null) && !t.parentTaskId && !t.parentEventId);
  const newOrder = sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 100 : 100;
  // 新 task 字段对齐桌面 sanitize 期望(防被严格过滤过滤掉)
  const newTask = {
    id: genId('t'),
    title: p.title || '新任务',
    done: false,
    doneAt: null,
    createdAt: Date.now(), updatedAt: Date.now(),
    projectId: projectId || null,
    parentTaskId: null,
    parentEventId: null,
    dueAt: start,
    start,
    end: p.allDay ? null : end,
    allDay: !!p.allDay,
    color: p.color || '',
    tags: Array.isArray(p.tags) ? [...p.tags] : [],
    subtasks: (Array.isArray(p.subtasks) ? p.subtasks : [])
      .map(s => ({ id: genId('s'), title: s.title || '', done: false, createdAt: Date.now() })),
    schedules: [{
      id: 'sl-' + Math.random().toString(36).slice(2, 10),
      kind: p.allDay ? 'date' : 'range',
      start,
      end: p.allDay ? undefined : end,
      allDay: !!p.allDay,
      repeat: 'none',
      reminderOffset: null,
    }],
    images: [],
    completedOccurrences: [],
    kanbanColumn: null,
    order: newOrder,
  };
  state.tasks.push(newTask);
  return newTask;
}

function openSaveTaskAsTemplateSheet(taskId) {
  const t = state.tasks.find(x => x.id === taskId);
  if (!t) return;
  const defaultName = t.title || '未命名模板';
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 6px;">保存为模板</div>
      <div class="form-row"><label>模板名</label><input type="text" id="tmpl-name" value="${esc(defaultName)}" maxlength="60"></div>
      <div class="settings-hint" style="padding:8px 0 0;">将保存:标题、时长、颜色、标签、${(t.subtasks||[]).length} 个子任务</div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    const inp = body.querySelector('#tmpl-name');
    setTimeout(() => inp.focus(), 50);
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      const name = inp.value.trim() || defaultName;
      state.templates = state.templates || [];
      state.templates.push({
        id: 'tmpl-' + genId('x').slice(2, 10),
        kind: 'task',
        name,
        payload: buildTaskTemplatePayload(t),
        createdAt: Date.now(),
      });
      pushState();
      closeSheet();
      showToast('模板已保存');
    };
  });
}

function openCreateFromTemplatePicker(opts) {
  // task / event 模板都能用来建任务(对齐桌面 cal-from-template 的混用)
  opts = opts || {};
  const all = (state.templates || []).filter(t => t.kind === 'task' || t.kind === 'event');
  if (!all.length) {
    showToast('还没有可用模板,在桌面端创建模板后会同步过来');
    closePopover();
    return;
  }
  const tasks = all.filter(t => t.kind === 'task');
  const events = all.filter(t => t.kind === 'event');
  const items = [];
  const apply = (tmpl) => {
    closePopover();
    const cl = getCurrentList();
    const projectId = (opts.projectId !== undefined && opts.projectId !== null)
      ? opts.projectId
      : (cl.kind === 'project' ? cl.project?.id : null);
    let newTask;
    if (Number.isFinite(opts.startTs)) {
      // 从时间轴拖出来的:用拖出来的起点,时长走模板自身(不接管 endTs)
      newTask = applyTaskTemplate(tmpl, null, projectId, { startTs: opts.startTs });
    } else {
      const day = ui.tab === 'calendar' ? (ui.calSelectedDay || ui.calCursor) : Date.now();
      newTask = applyTaskTemplate(tmpl, day, projectId);
    }
    pushState();
    renderAll();
    showToast(`已新建任务「${newTask.title}」`);
  };
  if (tasks.length) {
    items.push({ sectionTitle: '任务模板' });
    for (const tmpl of tasks) items.push({ label: tmpl.name || '未命名', icon: 'ico-template', action: () => apply(tmpl) });
  }
  if (events.length) {
    if (items.length) items.push({ divider: true });
    items.push({ sectionTitle: '事件模板' });
    for (const tmpl of events) items.push({ label: tmpl.name || '未命名', icon: 'ico-calendar', action: () => apply(tmpl) });
  }
  showPopover(items, opts);
}

// ----- 项目 / 清单 / 文件夹 / 标签 编辑 sheet -----
function openEditProjectSheet(p) {
  const isProj = (p.kind || 'project') === 'project';
  const label = isProj ? '编辑项目' : '编辑清单';
  const wantedFolderKind = isProj ? 'project' : 'tasklist';
  // 文件夹下拉只显示同 kind 的文件夹(项目挂项目文件夹,清单挂清单文件夹)
  const folders = (state.folders || [])
    .filter(f => (f.kind || 'project') === wantedFolderKind)
    .slice().sort((a,b)=> (a.order||0)-(b.order||0));
  const presetColors = ['#FF6B6B','#FFB86B','#FFD93D','#6BCB77','#4D96FF','#9B5DE5','#FF6FB5','','#888888'];
  const currentColor = p.color || '';
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 12px;">${label}</div>
      <div class="form-row"><label>名称</label>
        <input type="text" id="ep-name" value="${esc(p.name||'')}" maxlength="40">
      </div>
      <div class="form-row" style="margin-top:8px;align-items:flex-start;">
        <label>颜色</label>
        <div class="ep-color-swatches">
          ${presetColors.map(c => `<button class="ep-color-swatch ${c===currentColor?'active':''}" data-color="${esc(c)}" style="${c?`background:${esc(c)};`:'background:transparent;border:1px dashed var(--border-soft);'}" title="${c||'无色'}"></button>`).join('')}
          <label class="ep-color-native-wrap" title="自定义"><input type="color" id="ep-color" value="${esc(currentColor || '#888888')}"><span class="ep-color-native-label">自定义</span></label>
        </div>
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>文件夹</label>
        <select id="ep-folder">
          <option value="">未分组</option>
          ${folders.map(f => `<option value="${esc(f.id)}" ${(p.folderId===f.id)?'selected':''}>${esc(f.name||'未命名')}</option>`).join('')}
          <option value="__new__">+ 新建文件夹…</option>
        </select>
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>置顶</label>
        <label class="form-toggle"><input type="checkbox" id="ep-pin" ${p.pinned?'checked':''}><span></span></label>
      </div>
      <div class="form-row" style="margin-top:8px;">
        <label>归档</label>
        <label class="form-toggle"><input type="checkbox" id="ep-arch" ${p.archived?'checked':''}><span></span></label>
      </div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button class="danger" data-action="del">删除</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    let pickedColor = currentColor;
    const colorInp = body.querySelector('#ep-color');
    const refreshSwatches = () => {
      body.querySelectorAll('.ep-color-swatch').forEach(el => {
        el.classList.toggle('active', el.dataset.color === pickedColor);
      });
    };
    body.querySelectorAll('.ep-color-swatch').forEach(el => {
      el.onclick = () => {
        pickedColor = el.dataset.color;
        if (pickedColor) colorInp.value = pickedColor;
        refreshSwatches();
      };
    });
    colorInp.onchange = () => { pickedColor = colorInp.value; refreshSwatches(); };
    // 文件夹下拉:选「+ 新建文件夹」→ 弹输入名 → 建好并选中
    const folderSel = body.querySelector('#ep-folder');
    let _prevFolderVal = folderSel.value;
    folderSel.addEventListener('change', () => {
      if (folderSel.value !== '__new__') { _prevFolderVal = folderSel.value; return; }
      const name = (prompt('新文件夹名称') || '').trim();
      if (!name) { folderSel.value = _prevFolderVal; return; }
      const maxOrder = (state.folders || []).reduce((m, x) => Math.max(m, x.order || 0), 0);
      const nf = {
        id: 'f-' + Math.random().toString(36).slice(2, 10),
        name, color: '', icon: '', order: maxOrder + 100,
        kind: wantedFolderKind,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      if (!Array.isArray(state.folders)) state.folders = [];
      state.folders.push(nf);
      pushState();
      // 重建下拉:未分组 + 同 kind 文件夹 + 新建项,选中刚建的
      const sameKind = (state.folders || [])
        .filter(f => (f.kind || 'project') === wantedFolderKind)
        .slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      folderSel.innerHTML = '<option value="">未分组</option>'
        + sameKind.map(f => `<option value="${esc(f.id)}" ${f.id === nf.id ? 'selected' : ''}>${esc(f.name || '未命名')}</option>`).join('')
        + '<option value="__new__">+ 新建文件夹…</option>';
      folderSel.value = nf.id;
      _prevFolderVal = nf.id;
    });
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="del"]').onclick = () => {
      if (!confirm(`删除${isProj?'项目':'清单'}「${p.name||'未命名'}」?该${isProj?'项目':'清单'}下的任务也会被删除。`)) return;
      state.tasks = state.tasks.filter(t => t.projectId !== p.id);
      state.projects = state.projects.filter(x => x.id !== p.id);
      ui.selectedKind = 'smart'; ui.selectedId = 'all'; saveUI();
      pushState(); closeSheet(); renderAll();
    };
    body.querySelector('[data-action="save"]').onclick = () => {
      const name = body.querySelector('#ep-name').value.trim();
      if (!name) { showToast('请输入名称'); return; }
      p.name = name;
      p.color = pickedColor;
      p.folderId = body.querySelector('#ep-folder').value || null;
      p.pinned = body.querySelector('#ep-pin').checked;
      p.archived = body.querySelector('#ep-arch').checked;
      p.updatedAt = Date.now();
      pushState(); closeSheet(); renderAll();
    };
  });
}

function openEditFolderSheet(f) {
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 12px;">编辑文件夹</div>
      <div class="form-row"><label>名称</label>
        <input type="text" id="ef-name" value="${esc(f.name||'')}" maxlength="40">
      </div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button class="danger" data-action="del">删除</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="del"]').onclick = () => {
      if (!confirm(`删除文件夹「${f.name||'未命名'}」?里面的项目会变成"未分组"。`)) return;
      state.projects.forEach(p => { if (p.folderId === f.id) p.folderId = null; });
      state.folders = state.folders.filter(x => x.id !== f.id);
      ui.selectedKind = 'smart'; ui.selectedId = 'all'; saveUI();
      pushState(); closeSheet(); renderAll();
    };
    body.querySelector('[data-action="save"]').onclick = () => {
      const name = body.querySelector('#ef-name').value.trim();
      if (!name) { showToast('请输入名称'); return; }
      f.name = name;
      f.updatedAt = Date.now();
      pushState(); closeSheet(); renderAll();
    };
  });
}

function openEditTagSheet(tagName) {
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 12px;">编辑标签</div>
      <div class="form-row"><label>名称</label>
        <input type="text" id="et-name" value="${esc(tagName)}" maxlength="40">
      </div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      const newName = body.querySelector('#et-name').value.trim();
      if (!newName) { showToast('请输入名称'); return; }
      if (newName === tagName) { closeSheet(); return; }
      state.tasks.forEach(t => {
        if (Array.isArray(t.tags)) t.tags = t.tags.map(x => x === tagName ? newName : x);
      });
      if (state.settings && Array.isArray(state.settings.tags)) {
        state.settings.tags.forEach(x => { if (x && x.name === tagName) x.name = newName; });
      }
      if (Array.isArray(state.tags)) {
        state.tags = state.tags.map(x =>
          typeof x === 'string'
            ? (x === tagName ? newName : x)
            : (x && x.name === tagName ? { ...x, name: newName } : x)
        );
      }
      if (ui.selectedKind === 'tag' && ui.selectedId === tagName) { ui.selectedId = newName; saveUI(); }
      pushState(); closeSheet(); renderAll();
    };
  });
}

// ----- 列表更多菜单(右上 ⋯)-----
function openListMoreMenu() {
  const cl = getCurrentList();
  const items = [];
  if (cl.kind === 'project' && cl.project) {
    const p = cl.project;
    const isProj = (p.kind || 'project') === 'project';
    items.push({ label: isProj ? '编辑项目' : '编辑清单', icon: 'ico-edit', action: () => { closePopover(); openEditProjectSheet(p); } });
    // 专注详情只对真正的项目显示;任务清单不挂时间不计专注,没意义
    if (isProj) items.push({ label: '专注详情', icon: 'ico-clock', action: () => { closePopover(); openProjectFocusDetailSheet(p.id); } });
    items.push({ label: p.pinned ? '取消置顶' : '置顶', icon: 'ico-pin', action: () => { p.pinned = !p.pinned; pushState(); closePopover(); renderAll(); } });
    items.push({ label: p.archived ? '取消归档' : '归档', icon: 'ico-archive', action: () => { p.archived = !p.archived; pushState(); closePopover(); renderAll(); } });
    items.push({ label: '设置自动标签', icon: 'ico-magic', action: () => { showToast('自动标签:暂未实现'); closePopover(); } });
    items.push({ divider: true });
    items.push({ sectionTitle: '视图' });
    [
      { id: 'list', label: '列表', icon: 'ico-list' },
      { id: 'kanban', label: '看板', icon: 'ico-kanban' },
      { id: 'gantt', label: '甘特图', icon: 'ico-gantt' },
    ].forEach(vm => items.push({
      toggle: true, label: vm.label, icon: vm.icon,
      stateText: (p.viewMode || 'list') === vm.id ? '已选' : '',
      action: () => { p.viewMode = vm.id; pushState(); closePopover(); renderAll(); },
    }));
    items.push({ divider: true });
    items.push({ toggle: true, label: '隐藏已完成', icon: 'ico-eye', stateText: p.hideCompleted ? '已开' : '', action: () => { p.hideCompleted = !p.hideCompleted; pushState(); closePopover(); renderAll(); } });
    items.push({ toggle: true, label: '显示时间', icon: 'ico-clock', stateText: p.showTime !== false ? '已开' : '', action: () => { p.showTime = !(p.showTime !== false); pushState(); closePopover(); renderAll(); } });
    items.push({ divider: true });
    items.push({ label: '删除项目', icon: 'ico-trash', danger: true, action: () => {
      if (!confirm('删除项目「' + (p.name||'未命名') + '」?该项目下的任务也会被删除。')) return;
      state.tasks = state.tasks.filter(t => t.projectId !== p.id);
      state.projects = state.projects.filter(x => x.id !== p.id);
      ui.selectedKind = 'smart'; ui.selectedId = 'all'; saveUI();
      pushState(); closePopover(); renderAll();
    }});
  } else if (cl.kind === 'folder' && cl.folder) {
    const f = cl.folder;
    items.push({ label: '编辑文件夹', icon: 'ico-edit', action: () => { closePopover(); openEditFolderSheet(f); } });
    items.push({ divider: true });
    items.push({ label: '删除文件夹', icon: 'ico-trash', danger: true, action: () => {
      if (!confirm('删除文件夹「' + (f.name||'未命名') + '」?里面的项目会变成"未分组"。')) return;
      state.projects.forEach(p => { if (p.folderId === f.id) p.folderId = null; });
      state.folders = state.folders.filter(x => x.id !== f.id);
      ui.selectedKind = 'smart'; ui.selectedId = 'all'; saveUI();
      pushState(); closePopover(); renderAll();
    }});
  } else if (cl.kind === 'tag') {
    items.push({ label: '编辑标签', icon: 'ico-edit', action: () => { closePopover(); openEditTagSheet(cl.tag); } });
    items.push({ label: '删除标签', icon: 'ico-trash', danger: true, action: () => {
      if (!confirm('删除标签「' + cl.tag + '」?引用此标签的任务会移除该标签。')) return;
      state.tasks.forEach(t => { if (Array.isArray(t.tags)) t.tags = t.tags.filter(x => x !== cl.tag); });
      state.tags = state.tags.filter(x => (typeof x === 'string' ? x : x?.name) !== cl.tag);
      ui.selectedKind = 'smart'; ui.selectedId = 'all'; saveUI();
      pushState(); closePopover(); renderAll();
    }});
  } else {
    items.push({ label: '当前清单不可编辑', disabled: true });
  }
  // 通用项:从模板创建(task / event 模板都能用)
  if ((state.templates || []).some(t => t.kind === 'task' || t.kind === 'event')) {
    items.push({ divider: true });
    items.push({ label: '从模板创建任务', icon: 'ico-template', action: () => { closePopover(); openCreateFromTemplatePicker(); } });
  }
  showPopover(items);
}

// ----- 弹层菜单 -----
// opts.anchor:把 popover 定位在该元素附近(优先放在元素上方/下方,自动避免溢出)
// opts.side:left|right(无 anchor 时的默认侧)
function showPopover(items, opts) {
  const pop = $('popover'), body = $('popover-body');
  body.classList.toggle('popover-left', !!(opts && opts.side === 'left'));
  // 重置 anchor 定位
  body.style.top = '';
  body.style.left = '';
  body.style.right = '';
  body.style.bottom = '';
  body.classList.toggle('popover-anchored', !!(opts && opts.anchor));
  body.innerHTML = items.map((it, i) => {
    if (it.divider) return `<div class="popover-divider"></div>`;
    if (it.sectionTitle) return `<div class="popover-section-title">${esc(it.sectionTitle)}</div>`;
    if (it.numberInput) {
      return `<div class="popover-row-input">
        ${it.icon ? `<span class="popover-icon ${it.icon}"></span>` : ''}
        <span class="popover-row-label">${esc(it.label)}</span>
        <input type="number" class="popover-num-input" data-num-i="${i}"
          value="${esc(String(it.value))}" min="${it.min ?? 0}" max="${it.max ?? 999}" step="${it.step ?? 1}"
          inputmode="numeric">
        ${it.unit ? `<span class="popover-row-unit">${esc(it.unit)}</span>` : ''}
      </div>`;
    }
    if (it.toggle) {
      return `<button class="popover-toggle ${it.checked?'checked':''}" data-i="${i}" ${it.disabled?'disabled':''}>
        ${it.icon ? `<span class="popover-icon ${it.icon}"></span>` : ''}
        <span>${esc(it.label)}</span>
        ${it.stateText ? `<span class="toggle-state">${esc(it.stateText)}</span>` : ''}
      </button>`;
    }
    // it.iconHtml 优先(用于项目色点/自定义 SVG),否则 fallback 到 it.icon class
    const iconBlock = it.iconHtml
      ? `<span class="popover-icon popover-icon-custom">${it.iconHtml}</span>`
      : (it.icon ? `<span class="popover-icon ${it.icon}"></span>` : '');
    return `<button class="popover-item ${it.danger?'danger':''}" data-i="${i}" ${it.disabled?'disabled':''}>
      ${iconBlock}
      <span>${esc(it.label)}</span>
    </button>`;
  }).join('');
  pop.classList.remove('hidden');
  body.querySelectorAll('[data-i]').forEach(el => {
    const i = +el.dataset.i;
    const it = items[i];
    if (it && it.action && !it.disabled) el.addEventListener('click', it.action);
  });
  body.querySelectorAll('.popover-num-input[data-num-i]').forEach(el => {
    const i = +el.dataset.numI;
    const it = items[i];
    el.addEventListener('click', e => e.stopPropagation());
    el.addEventListener('change', () => {
      const v = parseInt(el.value, 10);
      if (it && it.onChange) it.onChange(Number.isFinite(v) ? v : (it.value || 0));
    });
  });
  pop.querySelector('.popover-mask').onclick = closePopover;
  // 若提供 anchor,弹在锚点附近(下方优先,空间不够则放上方,左右贴齐避免溢出)
  if (opts && opts.anchor instanceof Element) {
    requestAnimationFrame(() => {
      const ar = opts.anchor.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      const margin = 8;
      const vw = window.innerWidth, vh = window.innerHeight;
      let top = ar.bottom + 6;
      if (top + br.height + margin > vh) top = Math.max(margin, ar.top - br.height - 6);
      let left = ar.right - br.width;
      if (left < margin) left = margin;
      if (left + br.width > vw - margin) left = vw - margin - br.width;
      body.style.top = top + 'px';
      body.style.left = left + 'px';
      body.style.right = 'auto';
    });
  }
}
function closePopover() { $('popover').classList.add('hidden'); }

// =========================================================
// ===== 左抽屉(清单导航)=====
// =========================================================
function openDrawerNav() {
  const dr = $('drawer-nav');
  dr.classList.remove('hidden');
  // setTimeout 替代 rAF — 防 preview / 不可见标签下 rAF 不跑
  setTimeout(() => dr.classList.add('open'), 16);
  renderDrawerNav();
}
function closeDrawerNav() {
  $('drawer-nav').classList.remove('open');
  setTimeout(() => $('drawer-nav').classList.add('hidden'), 280);
}
// 重命名标签 sheet
// 概念页 sheet (2026-05-27, Obsidian-style [[xxx]] 双向链接)
function _openConceptSheet(conceptId) {
  const c = (state.concepts || []).find(x => x.id === conceptId);
  if (!c) return;
  const backlinks = _extractBacklinks(c);
  const unlinked = _extractUnlinkedMentions(c);
  const _ctxHtml = (ctx) => esc(ctx).replace(/\[\[([^\]\n]+?)\]\]/g, '<span class="concept-link-ctx">[[$1]]</span>');
  const _summaryBlMeta = (s) => {
    const time = esc(_summaryDayLabel(s.createdAt));
    const tags = (s.tags || []).slice(0, 5).map(t =>
      '<span class="concept-bl-tag">#' + esc(t) + '</span>').join('');
    return '<div class="concept-backlink-meta">' + time + (tags ? ' ' + tags : '') + '</div>';
  };
  const _summaryTitle = (s) =>
    (s.title && s.title.trim()) ? '<div class="concept-backlink-title">' + esc(s.title) + '</div>' : '';
  const backlinksHtml = backlinks.length
    ? backlinks.map(bl => {
        if (bl.summary) {
          return `<button class="concept-backlink" data-action="concept-goto-summary" data-summary-id="${esc(bl.summary.id)}">
            ${_summaryBlMeta(bl.summary)}
            ${_summaryTitle(bl.summary)}
            <div class="concept-backlink-ctx">…${_ctxHtml(bl.context)}…</div>
          </button>`;
        } else if (bl.concept) {
          return `<button class="concept-backlink concept-backlink-cpt" data-action="concept-open" data-concept-id="${esc(bl.concept.id)}">
            <div class="concept-backlink-meta">概念 <span class="concept-link-bracket">[[</span>${esc(bl.concept.name)}<span class="concept-link-bracket">]]</span></div>
            <div class="concept-backlink-ctx">…${_ctxHtml(bl.context)}…</div>
          </button>`;
        }
        return '';
      }).join('')
    : '<div class="concept-empty">还没有笔记或概念引用 [[' + esc(c.name) + ']]</div>';
  const unlinkedHtml = unlinked.length
    ? '<div class="concept-section-title">未链接提及 (' + unlinked.length + ')</div>'
      + unlinked.map(u => `<div class="concept-unlinked">
          <button class="concept-unlinked-main" data-action="concept-goto-summary" data-summary-id="${esc(u.summary.id)}">
            ${_summaryBlMeta(u.summary)}
            ${_summaryTitle(u.summary)}
            <div class="concept-backlink-ctx">…${esc(u.context)}…</div>
          </button>
          <button class="concept-wrap-btn" data-action="concept-wrap-mention" data-summary-id="${esc(u.summary.id)}" data-name="${esc(u.name)}">+ 链上</button>
        </div>`).join('')
    : '';
  const aliasesHtml = (c.aliases || []).map(a =>
    `<span class="concept-alias-chip">${esc(a)}<button class="concept-alias-x" data-action="concept-remove-alias" data-concept-id="${esc(c.id)}" data-alias="${esc(a)}">×</button></span>`
  ).join('');
  // 结构:固定头 (sheet-handle + concept-sheet-fixed-head) 在 sheet-body 顶部不滚,
  // 滚动内容 (.sheet-content.concept-sheet) 独立滚 — 这样关闭按钮永远固定可见
  // (Kayu 2026-05-27 反馈:之前 sticky 在 flex 容器里不稳, 顶端跑出画面)
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="concept-sheet-fixed-head">
      <input type="text" class="concept-title-input" value="${esc(c.name)}" data-action-blur="concept-rename" data-action-enter="concept-rename" data-concept-id="${esc(c.id)}">
    </div>
    <div class="sheet-content concept-sheet">
      <div class="concept-aliases">
        ${aliasesHtml}
        <button class="concept-alias-add" data-action="concept-add-alias" data-concept-id="${esc(c.id)}">+ 别名</button>
      </div>
      <div class="concept-desc">
        <div class="sum-input-card">
          <div id="concept-desc-input" class="sum-input" contenteditable="true"
            data-action-input="concept-desc-input"
            data-concept-id="${esc(c.id)}">${_mdToEditHtml(c.description || '')}</div>
        </div>
      </div>
      <div class="concept-backlinks">
        <div class="concept-section-title">反链 (${backlinks.length})</div>
        ${backlinksHtml}
        ${unlinkedHtml}
      </div>
      <div style="display:flex;justify-content:flex-end;padding-top:8px;border-top:1px solid var(--border-soft);margin-top:8px;">
        <button class="concept-delete-btn" data-action="concept-delete" data-concept-id="${esc(c.id)}">删除概念</button>
      </div>
    </div>
  `, (body) => {
    if (typeof bindCloudTimelineImages === 'function') bindCloudTimelineImages(body);
  });
}

function _openSummaryTagRenameSheet(oldName) {
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 8px;">重命名 #${esc(oldName)}</div>
      <input type="text" id="sum-tag-rename-input" value="${esc(oldName)}" style="width:100%;padding:10px;border:1px solid var(--border-soft);border-radius:8px;font-size:14px;background:var(--bg-section);color:var(--text);outline:none;" autocomplete="off">
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="modal-btn" data-rename-action="cancel" style="flex:1;">取消</button>
        <button class="modal-btn modal-btn-primary" data-rename-action="ok" style="flex:1;">保存</button>
      </div>
    </div>
  `, (body) => {
    const input = body.querySelector('#sum-tag-rename-input');
    setTimeout(() => input.focus(), 50);
    body.querySelector('[data-rename-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-rename-action="ok"]').onclick = () => {
      const newName = (input.value || '').trim();
      if (!newName || newName === oldName) { closeSheet(); return; }
      _summaryRenameOrMergeTag(oldName, newName, () => closeSheet());
    };
  });
}

// 重命名 tag — 撞名时弹合并确认 + 去重(同 desktop 端逻辑,2026-05-27 加)
// 之前直接改名会让 summaryTags 表里出现两条同名 entry,后续删除时两条都被命中,
// 该 tag 下的所有笔记一起失去标签(Kayu 真实事故 — #日記 改 #日记 后 52 条笔记 tag 消失)
function _summaryRenameOrMergeTag(oldName, newName, onDone) {
  if (!oldName || !newName || oldName === newName) { if (onDone) onDone(); return; }
  const tags = state.summaryTags || [];
  const movingEntries = tags.filter(t =>
    t.name === oldName || t.name.startsWith(oldName + '/'));
  const targetNames = movingEntries.map(t =>
    t.name === oldName ? newName : newName + t.name.slice(oldName.length));
  const existingInNewNs = tags.filter(t =>
    t.name !== oldName && !t.name.startsWith(oldName + '/') &&
    (t.name === newName || t.name.startsWith(newName + '/')));
  const collisionNames = existingInNewNs
    .map(t => t.name)
    .filter(n => targetNames.includes(n));

  const _doApply = () => {
    for (const me of movingEntries) {
      const newTagName = me.name === oldName ? newName : newName + me.name.slice(oldName.length);
      const dup = state.summaryTags.find(t => t !== me && t.name === newTagName);
      if (dup) {
        state.summaryTags = state.summaryTags.filter(t => t !== me);
      } else {
        me.name = newTagName;
      }
    }
    for (const s of (state.summaries || [])) {
      if (!Array.isArray(s.tags)) continue;
      let changed = false;
      const mapped = s.tags.map(x => {
        if (x === oldName) { changed = true; return newName; }
        if (x.startsWith(oldName + '/')) { changed = true; return newName + x.slice(oldName.length); }
        return x;
      });
      const deduped = [];
      const seen = new Set();
      for (const t of mapped) { if (!seen.has(t)) { seen.add(t); deduped.push(t); } }
      if (deduped.length !== s.tags.length || changed) {
        s.tags = deduped;
        const re = new RegExp('#' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        s.note = (s.note || '').replace(re, '#' + newName);
        s.updatedAt = Date.now();
      }
    }
    if (Array.isArray(summaryState.tagFilters)) {
      const f = summaryState.tagFilters.map(t =>
        (t === oldName || t.startsWith(oldName + '/'))
          ? newName + t.slice(oldName.length) : t);
      const fSeen = new Set();
      summaryState.tagFilters = f.filter(t => fSeen.has(t) ? false : (fSeen.add(t), true));
    }
    pushState();
    if (onDone) onDone();
    renderAll();
  };

  if (collisionNames.length) {
    const tagsText = collisionNames.slice(0, 5).map(n => '#' + n).join(' ');
    const more = collisionNames.length > 5 ? ` 等 ${collisionNames.length} 个` : '';
    const msg = '已存在同名标签 ' + tagsText + more + '。\n\n'
      + '继续将把 #' + oldName + (movingEntries.length > 1 ? ' 及其子标签' : '')
      + ' 合并进 #' + newName + ':\n'
      + '· 两边笔记一起共用合并后的标签\n'
      + '· 每条笔记的 tags 自动去重\n'
      + '· 保留已存在那条的设置(置顶/颜色/排序)';
    if (typeof showConfirm === 'function') {
      showConfirm({
        title: '合并标签',
        message: msg,
        okText: '合并',
        onOk: _doApply,
      });
    } else if (confirm(msg + '\n\n确定合并?')) {
      _doApply();
    } else {
      if (onDone) onDone();
    }
    return;
  }
  _doApply();
}
// 删除标签 sheet
function _openSummaryTagDeleteSheet(tagName) {
  const noteCount = (state.summaries || []).filter(s =>
    (s.tags || []).some(x => x === tagName || x.startsWith(tagName + '/'))).length;
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 8px;">删除 #${esc(tagName)}</div>
      <div style="color:var(--text-dim);font-size:13px;line-height:1.5;margin-bottom:12px;">
        ${noteCount > 0
          ? `这个标签被 ${noteCount} 条笔记使用。删除后笔记保留,但标签会从这些笔记中移除。`
          : '这个标签还没被任何笔记使用,可以放心删。'}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="modal-btn" data-del-action="cancel" style="flex:1;">取消</button>
        <button class="modal-btn modal-btn-danger" data-del-action="ok" style="flex:1;">删除</button>
      </div>
    </div>
  `, (body) => {
    body.querySelector('[data-del-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-del-action="ok"]').onclick = () => {
      state.summaryTags = (state.summaryTags || []).filter(t => t.name !== tagName && !t.name.startsWith(tagName + '/'));
      for (const s of (state.summaries || [])) {
        if (Array.isArray(s.tags)) s.tags = s.tags.filter(x => x !== tagName && !x.startsWith(tagName + '/'));
      }
      if (summaryState.filter === 'tag:' + tagName) summaryState.filter = 'all';
      pushState();
      closeSheet();
      renderAll();
    };
  });
}

// 摘要 tab 的左侧 drawer — 跟桌面 _renderSummarySidebar 一致(标签列表 + 折叠 + 编辑)
function _renderSummaryDrawerNav() {
  const body = $('drawer-nav-body');
  const tags = (state.summaryTags || []).slice().sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN'));
  const pinned = tags.filter(t => t.pinned);
  // 项目时间轴加图会自动生成「项目名」tag —— 单独归到「项目」大类,不混在我的自建 tag 里。
  // 规则:tag 顶层段 = 某个项目名 → 整棵子树归项目类
  const _projNamesForTag = new Set((state.projects || []).map(p => p && p.name).filter(Boolean));
  const _isProjectSumTag = (name) => !!name && _projNamesForTag.has(name.split('/')[0]);
  const projectTags = tags.filter(t => _isProjectSumTag(t.name));
  const userTags    = tags.filter(t => !_isProjectSumTag(t.name));
  const tagCount = (tagName) => (state.summaries || []).filter(s =>
    (s.tags || []).some(x => x === tagName || x.startsWith(tagName + '/'))).length;
  const hasChildren = (tagName) => tags.some(t => t.name.startsWith(tagName + '/'));
  if (!summaryState.collapsedTags) summaryState.collapsedTags = new Set();
  if (!summaryState.collapsedSections) summaryState.collapsedSections = new Set();
  const collapsedTags = summaryState.collapsedTags;
  const sec = summaryState.collapsedSections;
  const _isVisibleTag = (name) => {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (collapsedTags.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  };
  const renderTagRow = (tg) => {
    if (!_isVisibleTag(tg.name)) return '';
    const parts = tg.name.split('/').filter(Boolean);
    const indent = (parts.length - 1) * 12;
    const label = parts[parts.length - 1];
    const active = summaryState.filter === ('tag:' + tg.name);
    const count = tagCount(tg.name);
    const hasC = hasChildren(tg.name);
    const isC = collapsedTags.has(tg.name);
    const chev = hasC
      ? `<button class="sum-nav-chev ${isC?'collapsed':''}" data-action="summary-tag-toggle-collapse" data-tag="${esc(tg.name)}" title="${isC?'展开':'折叠'}子标签">▾</button>`
      : `<span class="sum-nav-chev sum-nav-chev-spacer"></span>`;
    return `<div class="sum-nav-row ${active?'active':''}" style="padding-left:${4 + indent}px;">
      ${chev}
      <button class="sum-nav-row-main-btn" data-action="summary-filter" data-filter="tag:${esc(tg.name)}" data-tag-name="${esc(tg.name)}">
        <span class="sum-tag-hash">#</span><span class="sum-tag-label">${esc(label)}</span>
      </button>
      <span class="sum-tag-count">${count}</span>
      <button class="sum-tag-more" data-action="summary-tag-menu" data-tag="${esc(tg.name)}" title="更多"><span class="ico-more"></span></button>
    </div>`;
  };
  const sectionHead = (key, label) => {
    const isHidden = sec.has(key);
    return `<button class="sum-nav-section-title ${isHidden?'collapsed':''}" data-action="summary-section-toggle" data-section="${key}">
      <span class="sum-nav-section-chev">▾</span>
      <span>${esc(label)}</span>
    </button>`;
  };
  const pinnedHidden  = sec.has('pinned');
  const projectHidden = sec.has('project');
  const allHidden     = sec.has('all');
  const conceptsHidden = sec.has('concepts');
  // 概念列表 — Obsidian 风格 [[xxx]] (2026-05-27)
  const concepts = (state.concepts || []).slice().sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN'));
  const renderConceptRow = (c) => {
    const cnt = _extractBacklinks(c).length;
    return `<div class="sum-nav-row concept-nav-row" title="${cnt} 条笔记引用">
      <span class="sum-nav-chev sum-nav-chev-spacer"></span>
      <button class="sum-nav-row-main-btn" data-action="concept-open" data-concept-id="${esc(c.id)}" data-name="${esc(c.name)}">
        <span class="concept-link-bracket">[[</span><span class="sum-tag-label">${esc(c.name)}</span><span class="concept-link-bracket">]]</span>
      </button>
      <span class="sum-tag-count">${cnt}</span>
    </div>`;
  };
  // 「我的标签」放在「项目标签」之上 — 用户自建 tag 是主用例;项目标签默认折叠(也是项目自动生成的辅料,默认占视野不合理)
  body.innerHTML = `
    <button class="sum-nav-row sum-nav-row-main ${summaryState.filter==='all'?'active':''}"
      data-action="summary-filter" data-filter="all">
      <span class="ico-list"></span><span>全部笔记</span>
    </button>
    ${pinned.length ? `${sectionHead('pinned', '置顶标签')}
      ${pinnedHidden ? '' : pinned.map(renderTagRow).join('')}` : ''}
    ${userTags.length ? `${sectionHead('all', '我的标签')}
      ${allHidden ? '' : userTags.map(renderTagRow).join('')}` : (tags.length ? '' : '<div class="sum-nav-empty">还没有标签 — 写笔记时输入 #xxx 自动建立</div>')}
    ${concepts.length ? `${sectionHead('concepts', '概念')}
      ${conceptsHidden ? '' : concepts.map(renderConceptRow).join('')}` : ''}
    ${projectTags.length ? `${sectionHead('project', '项目标签')}
      ${projectHidden ? '' : projectTags.map(renderTagRow).join('')}` : ''}
  `;
  // tag 点击 filter:本地 listener 关 drawer + 触发 filter(全局 dispatcher 也会接,但顺序保证 close drawer)
  body.querySelectorAll('[data-action="summary-filter"]').forEach(b => {
    b.addEventListener('click', () => {
      summaryState.filter = b.dataset.filter || 'all';
      closeDrawerNav();
      renderAll();
    });
  });
}

// 项目 tab 的左侧 drawer — 桌面端同款:全部 + 分类 / 标签 / 评分 / 完成时间 分区
function _renderWorksDrawerNav() {
  const body = $('drawer-nav-body');
  const all = worksProjects();
  const cats = (state.workCategories || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const f = worksState.filter || { kind: 'all' };
  const row = (active, label, count, attrs) =>
    `<button class="sum-nav-row works-nav-row ${active ? 'active' : ''}" ${attrs}>
       <span class="works-nav-label">${esc(label)}</span>
       <span class="works-nav-count">${count}</span>
     </button>`;
  const sectionHead = (label) => `<div class="works-nav-section">${esc(label)}</div>`;

  let html = row(f.kind === 'all', '全部项目', all.length, 'data-wf="all"');

  // 分类
  const topCats = cats.filter(x => !x.parentId);
  const uncat = all.filter(p => !p.categoryId).length;
  if (topCats.length || uncat) {
    html += sectionHead('分类');
    for (const c of topCats) {
      const ids = worksCategoryDescendants(c.id);
      const n = all.filter(p => p.categoryId && ids.has(p.categoryId)).length;
      html += row(f.kind === 'category' && f.id === c.id, c.name || '未命名', n, `data-wf="cat" data-wf-id="${esc(c.id)}"`);
    }
    if (uncat) html += row(f.kind === 'uncategorized', '未分类', uncat, 'data-wf="uncat"');
  }

  // 标签 — 按层级展示(跟桌面 sidebar 一致):/ 分级缩进 + 父级可折叠子级
  const tagSet = new Set();
  for (const p of all) {
    for (const t of new Set([...(p.tags || []), ...(p.workTags || [])])) if (t) tagSet.add(t);
  }
  // workTagPool 里登记但还没挂作品的标签也纳入(跟桌面一致)
  for (const e of (state.workTagPool || [])) if (e && e.name) tagSet.add(e.name);
  // 展开所有中间分组节点 — "a/b/c" 也算上 "a"、"a/b"
  const allTagPaths = new Set();
  for (const t of tagSet) {
    const parts = t.split('/');
    for (let i = 1; i <= parts.length; i++) allTagPaths.add(parts.slice(0, i).join('/'));
  }
  // 层级排序:子标签紧跟父级
  const sortedTagPaths = Array.from(allTagPaths).sort((a, b) => {
    const ap = a.split('/'), bp = b.split('/');
    const n = Math.min(ap.length, bp.length);
    for (let i = 0; i < n; i++) {
      if (ap[i] !== bp[i]) return ap[i].localeCompare(bp[i], 'zh-Hans-CN');
    }
    return ap.length - bp.length;
  });
  const tagAggCount = (path) => {
    let n = 0;
    for (const p of all) {
      const ts = new Set([...(p.tags || []), ...(p.workTags || [])]);
      for (const t of ts) {
        if (t === path || t.startsWith(path + '/')) { n++; break; }
      }
    }
    return n;
  };
  const tagHasChildren = (path) => sortedTagPaths.some(p => p.startsWith(path + '/'));
  const collapsedTags = worksState.drawerCollapsedTags || (worksState.drawerCollapsedTags = new Set());
  const isVisibleTagPath = (path) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (collapsedTags.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  };
  const untaggedN = all.filter(p => !(p.tags || []).length && !(p.workTags || []).length).length;
  if (sortedTagPaths.length || untaggedN) {
    html += sectionHead('标签');
    for (const path of sortedTagPaths) {
      if (!isVisibleTagPath(path)) continue;
      const parts = path.split('/');
      const indent = (parts.length - 1) * 12;
      const leaf = parts[parts.length - 1];
      const active = f.kind === 'tag' && f.path === path;
      const hasC = tagHasChildren(path);
      const isC = collapsedTags.has(path);
      const count = tagAggCount(path);
      const chev = hasC
        ? `<button class="sum-nav-chev ${isC ? 'collapsed' : ''}" data-wt-toggle="${esc(path)}" type="button" aria-label="${isC ? '展开' : '折叠'}子标签">▾</button>`
        : `<span class="sum-nav-chev sum-nav-chev-spacer"></span>`;
      html += `<div class="sum-nav-row ${active ? 'active' : ''}" style="padding-left:${4 + indent}px;">
        ${chev}
        <button class="sum-nav-row-main-btn" data-wf="tag" data-wf-path="${esc(path)}" type="button">
          <span class="sum-tag-hash">#</span><span class="sum-tag-label">${esc(leaf)}</span>
        </button>
        <span class="sum-tag-count">${count}</span>
      </div>`;
    }
    if (untaggedN) html += row(f.kind === 'untagged', '无标签', untaggedN, 'data-wf="untagged"');
  }

  // 评分
  if (all.some(p => (p.rating || 0) > 0)) {
    html += sectionHead('评分');
    for (let s = 5; s >= 1; s--) {
      const n = all.filter(p => (p.rating || 0) === s).length;
      if (n) html += row(f.kind === 'rating' && f.stars === s, '★'.repeat(s), n, `data-wf="rating" data-wf-stars="${s}"`);
    }
  }

  // 完成时间分类已去除 — 改用右上「排序」里的「按时间分组」(按月分隔线呈现)

  body.innerHTML = html;
  body.querySelectorAll('[data-wf]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.wf;
    if (k === 'cat')          worksState.filter = { kind: 'category', id: b.dataset.wfId };
    else if (k === 'uncat')   worksState.filter = { kind: 'uncategorized' };
    else if (k === 'tag')     worksState.filter = { kind: 'tag', path: b.dataset.wfPath };
    else if (k === 'untagged')worksState.filter = { kind: 'untagged' };
    else if (k === 'rating')  worksState.filter = { kind: 'rating', stars: parseInt(b.dataset.wfStars, 10) };
    else if (k === 'time')    worksState.filter = { kind: 'time', year: parseInt(b.dataset.wfYear, 10) };
    else                      worksState.filter = { kind: 'all' };
    closeDrawerNav();
    renderAll();
  }));
  // 标签层级折叠 — 点 chev 切换该 path 的折叠态,不触发筛选
  body.querySelectorAll('[data-wt-toggle]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const p = b.dataset.wtToggle;
    if (!p) return;
    if (collapsedTags.has(p)) collapsedTags.delete(p); else collapsedTags.add(p);
    _renderWorksDrawerNav();
  }));
}

// 项目 tab 排序菜单(顶栏右上角;视图切换已独立成左边那个按钮)
function openWorksSortMenu(anchor) {
  showPopover([
    { sectionTitle: '排序' },
    { label: '按时间', icon: 'ico-history', stateText: worksState.sort === 'time' ? '当前' : '',
      action: () => setWorksUiPref({ sort: 'time' }) },
    { label: '最近更新', icon: 'ico-clock', stateText: worksState.sort === 'updated' ? '当前' : '',
      action: () => setWorksUiPref({ sort: 'updated' }) },
    { label: '自定义顺序', icon: 'ico-template', stateText: worksState.sort === 'custom' ? '当前' : '',
      action: () => setWorksUiPref({ sort: 'custom' }) },
    { label: '按时间分组(按月分隔)', icon: 'ico-calendar', stateText: worksState.sort === 'time-grouped' ? '当前' : '',
      action: () => setWorksUiPref({ sort: 'time-grouped' }) },
  ], { anchor });
}

function renderDrawerNav() {
  $('drawer-user-name').textContent = uid || '未登录';
  // 在 drawer header 区放一个 + 按钮 — 任务 tab 用于"新建清单/项目/文件夹",摘要 tab 隐藏
  const drawerHead = document.querySelector('#drawer-nav .drawer-head');
  if (drawerHead) {
    let createBtn = drawerHead.querySelector('[data-action="drawer-create"]');
    if (!createBtn) {
      createBtn = document.createElement('button');
      createBtn.className = 'drawer-create-btn';
      createBtn.dataset.action = 'drawer-create';
      createBtn.innerHTML = '<span class="ico-plus"></span>';
      createBtn.onclick = (e) => {
        e.stopPropagation();
        // 先关抽屉再开 sheet — 否则在窄屏 / 抽屉边缘附近,sheet 会被左侧抽屉遮一部分,视觉看起来「跑下面去了」
        closeDrawerNav();
        // 等抽屉动画收完再开 sheet,避免 transition 期间 layout 抖动
        setTimeout(() => openCreateProjectSheet(), 220);
      };
      drawerHead.appendChild(createBtn);
    }
    if (ui.tab === 'summary') {
      createBtn.style.display = 'none';
    } else {
      createBtn.style.display = '';
      createBtn.title = '新建清单 / 项目 / 文件夹';
    }
  }
  // 根据当前 tab 决定渲染什么 — 摘要 tab 用 tag 侧栏,项目 tab 用分类列表,其它用任务清单导航
  if (ui.tab === 'summary') { _renderSummaryDrawerNav(); return; }
  if (ui.tab === 'works')   { _renderWorksDrawerNav();   return; }
  const body = $('drawer-nav-body');
  const smartLists = (state.smartLists || []);
  let html = '';
  if (smartLists.length) {
    html += navSectionTitle('__smart__', '智能清单');
    if (!ui.collapsedSections.has('__smart__')) {
      html += smartLists.map(sl => {
        const cnt = smartListTasks(sl).filter(t => !t.done).length;
        return navRowHtml({ kind: 'smart-list', id: sl.id, label: sl.name || '未命名', icon: 'ico-magic', count: cnt });
      }).join('');
    }
  }
  const tagNames = uniq([
    ...(state.tags || []).map(t => typeof t === 'string' ? t : t?.name).filter(Boolean),
    ...state.tasks.flatMap(t => Array.isArray(t.tags) ? t.tags : []),
  ]).filter(Boolean);
  if (tagNames.length) {
    html += navSectionTitle('__tags__', '标签');
    if (!ui.collapsedSections.has('__tags__')) {
      html += tagNames.map(tg => {
        const cnt = state.tasks.filter(t => Array.isArray(t.tags) && t.tags.includes(tg) && !t.done).length;
        return navRowHtml({ kind: 'tag', id: tg, label: '#' + tg, icon: 'ico-tag', count: cnt });
      }).join('');
    }
  }
  // 项目 / 清单按 folder.kind 各自归类 — 文件夹是「项目文件夹」就出现在「项目」section,
  // 是「清单文件夹」就出现在「任务清单」section
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
  const folderKindOf = (f) => f.kind || 'project';   // 老数据兼容
  const folderById = new Map((state.folders || []).map(f => [f.id, f]));
  const projectFolders  = state.folders.filter(f => folderKindOf(f) === 'project').slice().sort(byOrder);
  const tasklistFolders = state.folders.filter(f => folderKindOf(f) === 'tasklist').slice().sort(byOrder);

  const projectFolderIds  = new Set(projectFolders.map(f => f.id));
  const tasklistFolderIds = new Set(tasklistFolders.map(f => f.id));

  // ===== 任务清单 section =====
  const allTasklists = state.projects.filter(p => !p.archived && p.kind === 'tasklist').slice().sort(byOrder);
  const folderlessTasklists = allTasklists.filter(p => !p.folderId || !tasklistFolderIds.has(p.folderId));
  const tasklistsInFolder = (fid) => allTasklists.filter(p => p.folderId === fid);
  if (allTasklists.length || tasklistFolders.length) {
    html += navSectionTitle('__tasklists__', '任务清单');
    if (!ui.collapsedSections.has('__tasklists__')) {
      tasklistFolders.forEach(f => {
        const collapsed = ui.collapsedFolders.has(f.id);
        const children = tasklistsInFolder(f.id);
        const folderCustomIco = renderCustomIconHtml(f.icon, 'nav-folder-ico', '') || '';
        const active = ui.selectedKind === 'folder' && ui.selectedId === f.id;
        const undoneCnt = state.tasks.filter(t => children.some(p => p.id === t.projectId) && !t.done).length;
        html += `<div class="nav-folder-head ${collapsed?'collapsed':''} ${active?'active':''}" data-select-kind="folder" data-select-id="${esc(f.id)}">
          <button class="nav-folder-chev" data-folder-toggle="${esc(f.id)}" aria-label="${collapsed?'展开':'折叠'}"><span class="ico-chevron-down"></span></button>
          ${folderCustomIco || `<span class="nav-icon ico-folder"></span>`}
          <span class="nav-folder-name">${esc(f.name || '未命名')}</span>
          <span class="nav-count">${undoneCnt || children.length}</span>
        </div>`;
        html += `<div class="nav-folder-children">`;
        html += children.map(p => projectRowHtml(p)).join('');
        html += `</div>`;
      });
      if (folderlessTasklists.length) {
        if (tasklistFolders.length) html += `<div class="nav-section-title" style="text-transform:none;font-weight:500;">未分组</div>`;
        html += folderlessTasklists.map(p => projectRowHtml(p)).join('');
      }
    }
  }

  // ===== 项目 section =====
  html += navSectionTitle('__tasks__', '项目');
  if (!ui.collapsedSections.has('__tasks__')) {
    const allProjects = state.projects
      .filter(p => !p.archived && (p.kind || 'project') === 'project')
      .slice().sort(byOrder);
    const pinned = allProjects.filter(p => p.pinned);
    const projectsInFolder = (fid) => allProjects.filter(p => !p.pinned && p.folderId === fid);
    const ungroupedProjects = allProjects.filter(p => !p.pinned && (!p.folderId || !projectFolderIds.has(p.folderId)));
    if (pinned.length) {
      html += `<div class="nav-section-title">已置顶</div>`;
      html += pinned.map(p => projectRowHtml(p)).join('');
    }
    projectFolders.forEach(f => {
      const collapsed = ui.collapsedFolders.has(f.id);
      const children = projectsInFolder(f.id);
      const folderCustomIco = renderCustomIconHtml(f.icon, 'nav-folder-ico', '') || '';
      const active = ui.selectedKind === 'folder' && ui.selectedId === f.id;
      const undoneCnt = state.tasks.filter(t => children.some(p => p.id === t.projectId) && !t.done).length;
      html += `<div class="nav-folder-head ${collapsed?'collapsed':''} ${active?'active':''}" data-select-kind="folder" data-select-id="${esc(f.id)}">
        <button class="nav-folder-chev" data-folder-toggle="${esc(f.id)}" aria-label="${collapsed?'展开':'折叠'}"><span class="ico-chevron-down"></span></button>
        ${folderCustomIco || `<span class="nav-icon ico-folder"></span>`}
        <span class="nav-folder-name">${esc(f.name || '未命名')}</span>
        <span class="nav-count">${undoneCnt || children.length}</span>
      </div>`;
      html += `<div class="nav-folder-children">`;
      html += children.map(p => projectRowHtml(p)).join('');
      html += `</div>`;
    });
    if (ungroupedProjects.length) {
      html += `<div class="nav-section-title" style="text-transform:none;font-weight:500;">未分组</div>`;
      html += ungroupedProjects.map(p => projectRowHtml(p)).join('');
    }
    // 已归档项目不在任务视图列出 — 归档后就从清单导航里隐藏(项目 tab 仍可查看)
  }
  body.innerHTML = html;
  body.querySelectorAll('[data-folder-toggle]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation(); // 别冒泡到 folder head 选中
    const id = el.dataset.folderToggle;
    if (ui.collapsedFolders.has(id)) ui.collapsedFolders.delete(id); else ui.collapsedFolders.add(id);
    saveUI(); renderDrawerNav();
  }));
  body.querySelectorAll('[data-section-toggle]').forEach(el => el.addEventListener('click', () => {
    const id = el.dataset.sectionToggle;
    if (ui.collapsedSections.has(id)) ui.collapsedSections.delete(id); else ui.collapsedSections.add(id);
    saveUI(); renderDrawerNav();
  }));
  body.querySelectorAll('[data-select-kind]').forEach(el => el.addEventListener('click', () => {
    ui.selectedKind = el.dataset.selectKind;
    ui.selectedId = el.dataset.selectId;
    saveUI(); closeDrawerNav(); renderAll();
  }));
}
function navSectionTitle(id, label) {
  const collapsed = ui.collapsedSections.has(id);
  return `<div class="nav-section-title ${collapsed?'collapsed':''}" data-section-toggle="${esc(id)}">
    <span class="ico-chevron-down"></span><span>${esc(label)}</span>
  </div>`;
}
function navRowHtml({ kind, id, label, icon, customIcon, count, color, pinned }) {
  const active = ui.selectedKind === kind && ui.selectedId === id;
  // 优先级:customIcon (project/folder 选过的 SVG) > color (项目色块) > icon (类名 fallback)
  const customHtml = customIcon ? renderCustomIconHtml(customIcon, '', color || '') : null;
  const iconHtml = customHtml
    ? customHtml
    : color
      ? `<span class="nav-icon color-dot" style="background:${esc(color)}"></span>`
      : `<span class="nav-icon ${esc(icon || 'ico-list')}"></span>`;
  return `<div class="nav-row ${active?'active':''}" data-select-kind="${esc(kind)}" data-select-id="${esc(id)}">
    ${iconHtml}<span class="nav-label">${esc(label)}</span>
    ${pinned ? `<span class="nav-pin ico-pin"></span>` : ''}
    ${count != null ? `<span class="nav-count">${count}</span>` : ''}
  </div>`;
}
function projectRowHtml(p) {
  const cnt = state.tasks.filter(t => t.projectId === p.id && !t.done).length;
  return navRowHtml({ kind: 'project', id: p.id, label: p.name || '未命名', color: p.color, customIcon: p.icon, pinned: p.pinned, count: cnt });
}
function smartCount(id) {
  if (!state) return 0;
  if (id === 'all') return state.tasks.filter(t => !t.done && !t.archived).length;
  if (id === 'today') {
    const a = startOfDay(new Date()).getTime(), b = endOfDay(new Date()).getTime();
    return state.tasks.filter(t => taskHitDate(t, a, b) && !t.done).length;
  }
  if (id === 'next7') {
    const a = startOfDay(new Date()).getTime(), b = a + 7*86400000;
    return state.tasks.filter(t => taskHitDate(t, a, b) && !t.done).length;
  }
  if (id === 'noDate') return state.tasks.filter(t => !t.dueAt && !t.start && !t.done).length;
  if (id === 'completed') return state.tasks.filter(t => t.done).length;
  return 0;
}

// =========================================================
// ===== 日历 tab =====
// =========================================================
function renderCalendarTab(view) {
  if (ui.calMode === 'month') return renderMonthView(view);
  if (ui.calMode === 'week') return renderWeekView(view);
  return renderDayView(view);
}

function tasksOnDay(dayMs) {
  const a = startOfDay(new Date(dayMs)).getTime();
  const b = a + 86400000;
  const showDone   = !state || !state.settings || state.settings.calShowDone   !== false;
  const showRepeat = !state || !state.settings || state.settings.calShowAllRepeat !== false;
  const today0 = startOfDay(new Date()).getTime();
  const out = [];
  for (const t of (state.tasks || [])) {
    if (t.archived) continue;
    // 按 occurrence 展开(覆盖重复任务的后续重复天)
    const occs = expandItemOccurrencesInDay(t, a, b);
    let occ = occs[0] || null;
    if (!occ && !t.start && t.dueAt != null && t.dueAt >= a && t.dueAt < b) {
      occ = { start: t.dueAt, schedule: null };
    }
    if (!occ) continue;
    const isRepeat = occ.schedule && occ.schedule.repeat && occ.schedule.repeat !== 'none';
    const occDone = occ.schedule ? isOccDone(t, occ.schedule, occ.start) : !!t.done;
    if (!showDone && occDone) continue;
    if (!showRepeat && isRepeat && a > today0) continue;
    out.push(t);
  }
  return out;
}

function renderMonthView(view) {
  const cursor = new Date(ui.calCursor);
  const today0 = startOfDay(new Date()).getTime();
  const sel0 = startOfDay(new Date(ui.calSelectedDay || today0)).getTime();
  // 连续周流:从 cursor 月份前 6 个月的第 1 周到后 6 个月最后 1 周
  const startMonth = startOfMonth(addMonths(cursor, -6));
  const endMonth = startOfMonth(addMonths(cursor, 7));
  const firstWeek = startOfWeek(startMonth);
  const lastWeek = startOfWeek(endMonth);
  const totalWeeks = Math.round((lastWeek - firstWeek) / (7*86400000));

  // 索引构建(尊重 calShowDone / calShowAllRepeat)
  // 对齐桌面:任务/事件都要按 schedule 展开重复 occurrence,覆盖每个 occurrence 覆盖的天
  const showDone   = !state.settings || state.settings.calShowDone   !== false;
  const showRepeat = !state.settings || state.settings.calShowAllRepeat !== false;
  const showFocus  = !state.settings || state.settings.calShowFocus  !== false;

  // dayMs → 该天的 pill 列表(只放真正的单日条目;多天 span 单独走 row-level ribbon overlay)
  // pill: { id, kind, title, color, done }
  const pillsByDay = new Map();
  const addPill = (dayMs, pill) => {
    if (!pillsByDay.has(dayMs)) pillsByDay.set(dayMs, []);
    pillsByDay.get(dayMs).push(pill);
  };
  // 多天 ribbon 收集(项目 / 跨日 task / 跨日 event)— 渲染时按周切片 + lane 分配,贴在 row 顶部
  // span: { id, kind, title, color, done, start: dayMs, end: dayMs(含末天) }
  const allSpans = [];
  const addSpan = (span) => { allSpans.push(span); };

  const rangeStart = firstWeek.getTime();
  const rangeEnd   = addDays(firstWeek, totalWeeks * 7).getTime();
  // 对每个 task/event 在视图范围内逐天 expand;单日塞 pillsByDay,跨日塞 allSpans(去重)
  function _expandAndBucket(item, kind) {
    if (kind === 'task' && item.archived) return;
    const seen = new Set();   // 同一个 occurrence 在每天的 expand 都会返回,要去重
    for (let dms = rangeStart; dms < rangeEnd; dms += 86400000) {
      const dayEnd = dms + 86400000;
      const occs = expandItemOccurrencesInDay(item, dms, dayEnd);
      for (const occ of occs) {
        let occDone = false;
        if (kind === 'task') {
          occDone = (typeof isOccDone === 'function') ? isOccDone(item, occ.schedule, occ.start) : !!item.done;
          if (!showDone && occDone) continue;
        }
        const isRepeat = occ.schedule && occ.schedule.repeat && occ.schedule.repeat !== 'none';
        if (!showRepeat && isRepeat && occ.start > today0 + 86400000 - 1) continue;
        const occStartDay = startOfDay(new Date(occ.start)).getTime();
        const occEndDay = startOfDay(new Date(occ.end - 1)).getTime();
        if (occStartDay === occEndDay) {
          // 单日 → cell-level pill
          addPill(dms, {
            id: item.id, kind,
            title: item.title || '(无标题)',
            color: colorOfCalItem(item) || 'var(--accent)',
            done: occDone,
          });
        } else {
          // 跨日 → row-level ribbon(去重:同 occStart 只加一次)
          const key = `${kind}:${item.id}:${occ.start}`;
          if (seen.has(key)) continue;
          seen.add(key);
          addSpan({
            id: item.id, kind,
            title: item.title || '(无标题)',
            color: colorOfCalItem(item) || 'var(--accent)',
            done: occDone,
            start: occStartDay,
            end: occEndDay,
          });
        }
      }
    }
  }
  for (const t of (state.tasks || [])) {
    _expandAndBucket(t, 'task');
    // dueAt-only 任务 → 单日 pill
    const hasSchedule = (Array.isArray(t.schedules) && t.schedules[0]) || t.start;
    if (!hasSchedule && t.dueAt && !t.archived) {
      if (!showDone && t.done) continue;
      const k = startOfDay(new Date(t.dueAt)).getTime();
      if (k < rangeStart || k >= rangeEnd) continue;
      addPill(k, {
        id: t.id, kind: 'task',
        title: t.title || '(无标题)',
        color: colorOfCalItem(t) || 'var(--accent)',
        done: !!t.done,
      });
    }
  }
  for (const ev of (state.events || [])) _expandAndBucket(ev, 'event');
  // 项目 dueStart/dueEnd → ribbon
  for (const proj of (state.projects || [])) {
    if (proj.archived) continue;
    if ((proj.kind || 'project') !== 'project') continue;
    if (!proj.dueStart && !proj.dueEnd) continue;
    const ps = startOfDay(new Date(proj.dueStart || proj.dueEnd)).getTime();
    const pe = startOfDay(new Date(proj.dueEnd   || proj.dueStart)).getTime();
    if (pe < rangeStart || ps >= rangeEnd) continue;
    if (ps === pe) {
      addPill(ps, {
        id: proj.id, kind: 'project',
        title: proj.name || '(无名项目)',
        color: proj.color || 'var(--accent)',
        done: false,
      });
    } else {
      addSpan({
        id: proj.id, kind: 'project',
        title: proj.name || '(无名项目)',
        color: proj.color || 'var(--accent)',
        done: false,
        start: ps, end: pe,
      });
    }
  }
  // 单日 pills 按 occStart / 类型排序(项目优先?— 先按 kind,再按色稳定)
  for (const arr of pillsByDay.values()) {
    arr.sort((a, b) => (a.kind || '').localeCompare(b.kind || '') || (a.title || '').localeCompare(b.title || ''));
  }
  // 按 start 升序排 allSpans,让 lane 分配稳定(同 lane 上的 ribbon 不会回头堆)
  allSpans.sort((a, b) => a.start - b.start || (b.end - a.start) - (a.end - a.start));

  // 计算某周里的 ribbon 切片 + lane 分配
  // 返回 { ribbons: [{ ..., startIdx 0-6, endIdx 0-6, isFirstWeek, isLastWeek, lane }], laneCount }
  function _ribbonsForWeek(weekStartMs) {
    const weekEndMs = weekStartMs + 7 * 86400000;
    const list = [];
    for (const s of allSpans) {
      const sEndExcl = s.end + 86400000;
      if (sEndExcl <= weekStartMs) continue;
      if (s.start >= weekEndMs) continue;
      const a = Math.max(s.start, weekStartMs);
      const b = Math.min(s.end, weekEndMs - 86400000);
      const startIdx = Math.round((a - weekStartMs) / 86400000);
      const endIdx   = Math.round((b - weekStartMs) / 86400000);
      list.push({
        ...s,
        startIdx, endIdx,
        isFirstWeek: s.start === a,
        isLastWeek:  s.end === b,
      });
    }
    list.sort((a, b) => a.startIdx - b.startIdx || (b.endIdx - b.startIdx) - (a.endIdx - a.startIdx));
    // Greedy lane:第一个空闲 lane(其上一条 ribbon 已经在 startIdx 前结束)
    const lanesEnd = []; // lanesEnd[i] = 该 lane 上一条 ribbon 的 endIdx
    for (const r of list) {
      let lane = 0;
      while (lane < lanesEnd.length && lanesEnd[lane] >= r.startIdx) lane++;
      r.lane = lane;
      lanesEnd[lane] = r.endIdx;
    }
    return { ribbons: list, laneCount: lanesEnd.length };
  }

  // sessByDay → 当日合计专注时长(ms)
  const sessByDay = new Map();
  if (showFocus) {
    for (const s of (state.sessions || [])) {
      if (!s.startedAt || !s.duration) continue;
      // 防御:单条 > 16h 视为 OS 休眠老脏数据,跳过
      if (s.duration > 16 * 3600000) continue;
      const k = startOfDay(new Date(s.startedAt)).getTime();
      sessByDay.set(k, (sessByDay.get(k) || 0) + s.duration);
    }
  }
  const _fmtMs = (ms) => {
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60), m = min % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  };

  let weeksHtml = '';
  const RIBBON_H = 14;         // 单条 ribbon 高度(px)— 跟单日 chip 视觉接近
  const RIBBON_GAP = 2;        // ribbon 之间的间距(px)
  const NUM_AREA_H = 52;       // 日期区域(label + num + focus)预留高度,ribbon 起始 top — 给月初(有「5月」label)留足空间
  for (let w = 0; w < totalWeeks; w++) {
    const ws = addDays(firstWeek, w * 7);
    const weekStartMs = startOfDay(ws).getTime();
    const { ribbons, laneCount } = _ribbonsForWeek(weekStartMs);
    // ribbon 占用条带高度;cell-pills 用 margin-top 让出对应空间,这样 ribbon 落在「日期 → 单日 chip」之间
    const ribbonStripH = laneCount > 0 ? (laneCount * (RIBBON_H + RIBBON_GAP) + 2) : 0;
    // 渲染 ribbon overlay(绝对定位)— top = 日期区高度,落在日期下方
    const ribbonsHtml = ribbons.map(r => {
      const leftPct = (r.startIdx / 7) * 100;
      const widthPct = ((r.endIdx - r.startIdx + 1) / 7) * 100;
      const topPx = r.lane * (RIBBON_H + RIBBON_GAP);
      const rTL = r.isFirstWeek ? '4px' : '0';
      const rTR = r.isLastWeek  ? '4px' : '0';
      const labelHtml = r.isFirstWeek ? `<span class="cal-ribbon-label">${esc(r.title)}</span>` : '';
      return `<div class="cal-ribbon ${r.done?'done':''}"
        style="left:${leftPct}%;width:${widthPct}%;top:${topPx}px;height:${RIBBON_H}px;background:${esc(r.color)};border-top-left-radius:${rTL};border-bottom-left-radius:${rTL};border-top-right-radius:${rTR};border-bottom-right-radius:${rTR};"
        title="${esc(r.title)}">${labelHtml}</div>`;
    }).join('');

    let cells = '';
    for (let c = 0; c < 7; c++) {
      const d = addDays(ws, c);
      const dms = startOfDay(d).getTime();
      const isFirst = d.getDate() === 1;
      const isToday = dms === today0;
      const isSel = dms === sel0;
      const cellMonth = d.getFullYear() * 100 + d.getMonth();
      const pills = pillsByDay.get(dms) || [];
      const MAX_PILLS = 3;
      const pillsHtml = pills.slice(0, MAX_PILLS).map(p => {
        return `<div class="cal-cell-pill ${p.done?'done':''}" style="--pill-color:${esc(p.color)}" title="${esc(p.title)}">${esc(p.title)}</div>`;
      }).join('');
      const moreHtml = pills.length > MAX_PILLS
        ? `<div class="cal-cell-more">+${pills.length - MAX_PILLS}</div>`
        : '';
      const monthLabel = isFirst ? `<span class="cal-month-label">${d.getMonth()+1}月</span>` : '';
      const focusMs = sessByDay.get(dms) || 0;
      const focusHtml = focusMs > 0
        ? `<span class="cal-cell-focus">${_fmtMs(focusMs)}</span>`
        : '';
      cells += `<div class="cal-cell ${isToday?'today':''} ${isSel?'sel':''}" data-cal-day="${dms}" data-cell-month="${cellMonth}" data-cal-anchor-month="${isFirst ? cellMonth : ''}">
        <div class="cal-cell-num-wrap">
          ${monthLabel}
          <div class="cal-cell-num">${d.getDate()}</div>
          ${focusHtml}
        </div>
        <div class="cal-cell-pills">${pillsHtml}${moreHtml}</div>
      </div>`;
    }
    // row 不再 padding-top;改用 CSS var 让每个 cell-pills 自己 margin-top 让位
    // ribbon overlay 用绝对定位锚在 NUM_AREA_H 下方
    weeksHtml += `<div class="cal-week-row" style="--ribbon-strip-h:${ribbonStripH}px;">
      ${cells}
      ${ribbonsHtml ? `<div class="cal-week-ribbons" style="top:${NUM_AREA_H}px;height:${ribbonStripH}px;">${ribbonsHtml}</div>` : ''}
    </div>`;
  }

  view.innerHTML = `
    <div class="cal-month-flow">
      <div class="cal-weekhead">
        ${'一二三四五六日'.split('').map(w => `<div class="cal-weekhead-cell">${w}</div>`).join('')}
      </div>
      <div class="cal-flow-grid" id="cal-flow-grid">
        <svg class="cal-month-card" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
          <defs>
            <filter id="cal-card-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.06"/>
              <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.12"/>
            </filter>
          </defs>
          <path d="" filter="url(#cal-card-shadow)"/>
        </svg>
        ${weeksHtml}
      </div>
      <div class="cal-day-detail" id="cal-day-detail"></div>
    </div>`;

  // 滚到 cursor 月份的位置
  const cursorMonthEl = view.querySelector(`[data-cal-anchor-month="${cursor.getFullYear()*100+cursor.getMonth()}"]`);
  if (cursorMonthEl) {
    requestAnimationFrame(() => {
      const row = cursorMonthEl.closest('.cal-week-row');
      if (row) row.scrollIntoView({ block: 'start' });
    });
  }

  // 滚动监听:更新 topbar 当前月份 + 当前月描边框
  const grid = view.querySelector('#cal-flow-grid');
  applyActiveMonth(grid, cursor.getFullYear()*100 + cursor.getMonth());

  // 绑定日格点击(grid 提前定义,这里能访问)
  view.querySelectorAll('[data-cal-day]').forEach(c => {
    c.addEventListener('click', () => {
      if (_calDragCreating) return; // 拖拽刚结束的 ghost click,忽略
      const dms = +c.dataset.calDay;
      ui.calSelectedDay = dms;
      ui.calCursor = dms;
      saveUI();
      view.querySelectorAll('.cal-cell.sel').forEach(el => el.classList.remove('sel'));
      c.classList.add('sel');
      if (c.dataset.cellMonth) applyActiveMonth(grid, +c.dataset.cellMonth);
      renderCalDayDetail();
      renderTopbar();
    });
  });

  let scrollT = null;
  view.addEventListener('scroll', () => {
    // 滚动期间立即淡出阴影
    const cardEl = grid.querySelector('.cal-month-card');
    if (cardEl) cardEl.style.opacity = '0';
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const rows = grid.querySelectorAll('.cal-week-row');
      const viewMid = view.scrollTop + view.clientHeight / 2;
      let bestRow = null, bestDelta = Infinity;
      rows.forEach(r => {
        const rowMid = r.offsetTop + r.offsetHeight / 2;
        const d = Math.abs(rowMid - viewMid);
        if (d < bestDelta) { bestDelta = d; bestRow = r; }
      });
      if (bestRow) {
        const midCell = bestRow.querySelectorAll('.cal-cell')[3];
        const firstCell = bestRow.querySelector('.cal-cell');
        const ref = midCell || firstCell;
        if (ref) {
          const mid = new Date(+ref.dataset.calDay);
          const activeKey = mid.getFullYear()*100 + mid.getMonth();
          applyActiveMonth(grid, activeKey);
          // 滚动停止后总是淡入(即使月份未变)
          if (cardEl) cardEl.style.opacity = '1';
          const newCursor = mid.getTime();
          if (Math.abs(newCursor - ui.calCursor) > 2*86400000) {
            ui.calCursor = newCursor;
            saveUI();
            renderTopbar();
          }
        }
      }
    }, 80);
  }, { passive: true });

  renderCalDayDetail();
  bindCalendarGestures(view);
  bindMonthDragCreate(grid);
}

// 月视图:长按某日 → 拖动到另一日 → 弹新建任务浮窗(预填日期范围)
function bindMonthDragCreate(grid) {
  if (!grid) return;
  let startCell = null, endCell = null;
  let sx = 0, sy = 0;
  let longPressTimer = null;
  let dragging = false;
  const LONG_PRESS_MS = 400;
  const MOVE_CANCEL_PX = 10;

  function clearHighlight() {
    grid.querySelectorAll('.cal-cell.dragging-from, .cal-cell.in-range').forEach(el => {
      el.classList.remove('dragging-from', 'in-range');
    });
  }
  function applyHighlight() {
    if (!startCell) return;
    const a = +startCell.dataset.calDay;
    const b = +(endCell || startCell).dataset.calDay;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    grid.querySelectorAll('.cal-cell[data-cal-day]').forEach(el => {
      const d = +el.dataset.calDay;
      el.classList.toggle('in-range', d >= lo && d <= hi);
      el.classList.toggle('dragging-from', el === startCell);
    });
  }
  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const cell = (t.target instanceof Element) && t.target.closest('[data-cal-day]');
    if (!cell || !grid.contains(cell)) return;
    sx = t.clientX; sy = t.clientY;
    startCell = cell; endCell = cell;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      dragging = true;
      _calDragCreating = true;
      try { navigator.vibrate && navigator.vibrate(15); } catch (_) {}
      applyHighlight();
    }, LONG_PRESS_MS);
  }
  function onTouchMove(e) {
    if (!startCell) return;
    const t = e.touches[0];
    if (!dragging) {
      // 长按未触发就移动 → 当作普通滚动/滑动,取消长按
      if (Math.hypot(t.clientX - sx, t.clientY - sy) > MOVE_CANCEL_PX) {
        clearTimeout(longPressTimer);
        startCell = null;
      }
      return;
    }
    // 拖拽中 — 阻止页面滚动,跟踪手指下方的 cell
    e.preventDefault();
    const elem = document.elementFromPoint(t.clientX, t.clientY);
    const cell = elem && elem.closest && elem.closest('[data-cal-day]');
    if (cell && grid.contains(cell) && cell !== endCell) {
      endCell = cell;
      applyHighlight();
    }
  }
  function onTouchEnd() {
    clearTimeout(longPressTimer);
    if (dragging && startCell) {
      const a = +startCell.dataset.calDay;
      const b = +(endCell || startCell).dataset.calDay;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      clearHighlight();
      // 先复位,延迟开 sheet 避免 ghost click
      const s = startCell;
      startCell = null; endCell = null; dragging = false;
      setTimeout(() => {
        _calDragCreating = false;
        openCreateTaskSheet({ startDay: lo, endDay: hi });
      }, 0);
      return;
    }
    startCell = null; endCell = null; dragging = false;
  }
  function onTouchCancel() {
    clearTimeout(longPressTimer);
    clearHighlight();
    startCell = null; endCell = null; dragging = false;
    _calDragCreating = false;
  }

  grid.addEventListener('touchstart', onTouchStart, { passive: true });
  grid.addEventListener('touchmove',  onTouchMove,  { passive: false });
  grid.addEventListener('touchend',   onTouchEnd,   { passive: true });
  grid.addEventListener('touchcancel',onTouchCancel,{ passive: true });
}
let _calDragCreating = false;

// 给当前月生成一个整体 polygon,通过 clip-path 应用到 .cal-month-card 浮层上
function applyActiveMonth(grid, activeMonthKey) {
  if (!grid) return;
  if (grid.dataset.activeMonth === String(activeMonthKey)) return;
  grid.dataset.activeMonth = String(activeMonthKey);

  // 维护 in-active-month 标记(供 sel/today 等其他样式判断)
  grid.querySelectorAll('.cal-cell').forEach(cell => {
    cell.classList.toggle('in-active-month', +cell.dataset.cellMonth === activeMonthKey);
  });

  const card = grid.querySelector('.cal-month-card');
  if (!card) return;
  const activeCells = grid.querySelectorAll(`.cal-cell[data-cell-month="${activeMonthKey}"]`);
  if (!activeCells.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  // 按行聚合 active cells:每行 (top, bottom, left, right)
  const gridRect = grid.getBoundingClientRect();
  const rowMap = new Map();
  activeCells.forEach(c => {
    const r = c.getBoundingClientRect();
    const key = Math.round(r.top - gridRect.top);
    if (!rowMap.has(key)) {
      rowMap.set(key, {
        top: r.top - gridRect.top,
        bottom: r.bottom - gridRect.top,
        left: Infinity,
        right: -Infinity
      });
    }
    const row = rowMap.get(key);
    row.left = Math.min(row.left, r.left - gridRect.left);
    row.right = Math.max(row.right, r.right - gridRect.left);
  });
  const rows = [...rowMap.values()].sort((a, b) => a.top - b.top);

  // 顺时针构建 polygon 顶点
  const pts = [];
  pts.push([rows[0].left, rows[0].top]);
  pts.push([rows[0].right, rows[0].top]);
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i+1].right !== rows[i].right) {
      pts.push([rows[i].right, rows[i].bottom]);
      pts.push([rows[i+1].right, rows[i].bottom]);
    }
  }
  const last = rows[rows.length - 1];
  pts.push([last.right, last.bottom]);
  pts.push([last.left, last.bottom]);
  for (let i = rows.length - 1; i > 0; i--) {
    if (rows[i-1].left !== rows[i].left) {
      pts.push([rows[i].left, rows[i].top]);
      pts.push([rows[i-1].left, rows[i].top]);
    }
  }

  // 将 polygon 顶点转成带圆角的 SVG path(凸角加 14px 圆弧,凹角保持直角)
  const path = card.querySelector('path');
  if (path) path.setAttribute('d', buildRoundedPolygonPath(pts, 14));
  card.style.opacity = '1';
}

function buildRoundedPolygonPath(pts, radius) {
  const n = pts.length;
  const cmds = [];
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const dxIn = cur[0] - prev[0], dyIn = cur[1] - prev[1];
    const dxOut = next[0] - cur[0], dyOut = next[1] - cur[1];
    // 屏幕坐标(Y 朝下),顺时针 polygon:cross > 0 → 凸角
    const cross = dxIn * dyOut - dyIn * dxOut;
    const isConvex = cross > 0;
    if (!isConvex) {
      cmds.push((i === 0 ? 'M' : 'L') + ` ${cur[0].toFixed(2)} ${cur[1].toFixed(2)}`);
      continue;
    }
    const lenIn = Math.hypot(dxIn, dyIn);
    const lenOut = Math.hypot(dxOut, dyOut);
    const r = Math.min(radius, lenIn / 2, lenOut / 2);
    const bx = cur[0] - (dxIn / lenIn) * r;
    const by = cur[1] - (dyIn / lenIn) * r;
    const ax = cur[0] + (dxOut / lenOut) * r;
    const ay = cur[1] + (dyOut / lenOut) * r;
    cmds.push((i === 0 ? 'M' : 'L') + ` ${bx.toFixed(2)} ${by.toFixed(2)}`);
    cmds.push(`A ${r} ${r} 0 0 1 ${ax.toFixed(2)} ${ay.toFixed(2)}`);
  }
  cmds.push('Z');
  return cmds.join(' ');
}

function renderCalDayDetail() {
  const det = $('cal-day-detail');
  if (!det) return;
  const sel0 = startOfDay(new Date(ui.calSelectedDay || Date.now())).getTime();
  const tks = tasksOnDay(sel0);
  const dt = new Date(sel0);
  det.innerHTML = `
    <div class="section-title">${dt.getMonth()+1} 月 ${dt.getDate()} 日(${'日一二三四五六'[dt.getDay()]})· ${tks.length} 条</div>
    ${tks.length
      ? `<div class="card-list">${tks.map(taskCardHtml).join('')}</div>`
      : `<div class="empty" style="padding:20px;">这天没有任务</div>`}
  `;
  bindTaskCards(det);
}

// ===== Schedule 展开(简化版,对齐桌面 expandScheduleInRange)=====
// 把一个 item(task/event)在 [dayStart, dayEnd) 内的所有 occurrence 展开
// 支持 repeat: 'none'/'daily'/'weekly'/'monthly'/'workday';不识别的当 'none'
function expandItemOccurrencesInDay(item, dayStart, dayEnd) {
  const sched = (Array.isArray(item.schedules) && item.schedules[0])
    || (item.start ? { start: item.start, end: item.end || null, allDay: !!item.allDay, repeat: 'none' } : null);
  if (!sched || !sched.start) return [];
  const dur = (sched.end && sched.end > sched.start) ? (sched.end - sched.start) : 0;
  const repeat = sched.repeat || 'none';
  const allDay = !!sched.allDay;
  const out = [];
  const addOcc = (occStart) => {
    const occEnd = occStart + (dur || 30 * 60000); // 没 duration 给 30 分钟,占位可见
    if (occEnd <= dayStart || occStart >= dayEnd) return;
    out.push({ start: occStart, end: occEnd, allDay, schedule: sched });
  };
  if (repeat === 'none') {
    addOcc(sched.start);
    return out;
  }
  // 计算该天对应的 occurrence 时刻(同 anchor 的小时:分)
  const anchorD = new Date(sched.start);
  const dayD = new Date(dayStart);
  const occ = new Date(dayStart);
  occ.setHours(anchorD.getHours(), anchorD.getMinutes(), 0, 0);
  if (occ.getTime() < sched.start) return out; // 第一次实例之前不展开
  const dow = dayD.getDay();
  if (repeat === 'daily') {
    addOcc(occ.getTime());
  } else if (repeat === 'weekly') {
    if (anchorD.getDay() === dow) addOcc(occ.getTime());
  } else if (repeat === 'monthly') {
    if (anchorD.getDate() === dayD.getDate()) addOcc(occ.getTime());
  } else if (repeat === 'workday') {
    if (dow !== 0 && dow !== 6) addOcc(occ.getTime());
  } else {
    // 不识别的 repeat → 单次
    addOcc(sched.start);
  }
  return out;
}
// 全天任务是否落在某天 — 支持重复展开 / 多天 range / dueAt-only;命中返回 {done},否则 null
// 修复:旧版用 taskHitDate 只看原始 start,重复的全天任务在后续重复天不显示
function allDayTaskOnDay(t, dStart) {
  if (!t || t.archived) return null;
  const dEnd = dStart + 86400000;
  const occs = expandItemOccurrencesInDay(t, dStart, dEnd);
  for (const o of occs) {
    if (o.allDay) return { done: isOccDone(t, o.schedule, o.start) };
  }
  if (!t.start && t.dueAt != null && t.dueAt >= dStart && t.dueAt < dEnd) {
    return { done: !!t.done };
  }
  return null;
}
function _isRecurringTask(t) {
  return Array.isArray(t.schedules) && t.schedules.some(s => s && s.repeat && s.repeat !== 'none');
}
// 重复任务下一个未完成 occurrence 的开始时刻(过期/今天/未来),没有则 null
function _nextPendingOccurrence(t) {
  const schedules = (t.schedules || []).filter(s => s && s.start);
  if (!schedules.length) return null;
  const completed = new Set(Array.isArray(t.completedOccurrences) ? t.completedOccurrences : []);
  const today = new Date();
  let bestTs = null;
  for (const s of schedules) {
    let occ = new Date(s.start);
    if (s.repeat === 'workday' && (occ.getDay() === 0 || occ.getDay() === 6)) {
      do { occ.setDate(occ.getDate() + 1); } while (occ.getDay() === 0 || occ.getDay() === 6);
    }
    let safety = 5000;
    while (safety-- > 0) {
      const ts = occ.getTime();
      if (!completed.has(ts)) {
        if (bestTs == null || ts < bestTs) bestTs = ts;
        break;
      }
      // 找下一个 occurrence
      const next = new Date(occ);
      const r = s.repeat;
      if (r === 'daily') next.setDate(next.getDate() + 1);
      else if (r === 'weekly') next.setDate(next.getDate() + 7);
      else if (r === 'monthly') next.setMonth(next.getMonth() + 1);
      else if (r === 'workday') {
        do { next.setDate(next.getDate() + 1); } while (next.getDay() === 0 || next.getDay() === 6);
      } else break;
      occ = next;
      // 防 forever 循环
      if (occ.getTime() - new Date().getTime() > 365 * 86400000 * 5) break;
    }
  }
  return bestTs;
}
function fmtSchedule(s) {
  if (!s || !s.start) return '';
  const d = new Date(s.start);
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const repeatLabel = (s.repeat && s.repeat !== 'none') ? ` · ${
    s.repeat === 'daily' ? '每天' :
    s.repeat === 'weekly' ? '每周' :
    s.repeat === 'monthly' ? '每月' :
    s.repeat === 'workday' ? '工作日' : s.repeat
  }` : '';
  if (s.allDay) return `${dateStr}${repeatLabel}`;
  const startTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (s.end && s.end > s.start) {
    const e = new Date(s.end);
    const sameDay = e.getFullYear() === d.getFullYear() && e.getMonth() === d.getMonth() && e.getDate() === d.getDate();
    const endTime = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
    return sameDay
      ? `${dateStr} ${startTime}-${endTime}${repeatLabel}`
      : `${dateStr} ${startTime} → ${e.getMonth()+1}/${e.getDate()} ${endTime}${repeatLabel}`;
  }
  return `${dateStr} ${startTime}${repeatLabel}`;
}
function fmtHuman(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function isOccDone(item, schedule, occStart) {
  // 重复任务:完全忽略全局 item.done(老数据 / 误操作可能让它残留 true),只看 occurrence-level 完成
  const isRecurring = schedule && schedule.repeat && schedule.repeat !== 'none';
  if (isRecurring) {
    return Array.isArray(item.completedOccurrences) && item.completedOccurrences.includes(occStart);
  }
  return !!item.done;
}
function toggleOccurrenceDone(item, schedule, occStart) {
  const isRecurring = schedule && schedule.repeat && schedule.repeat !== 'none';
  if (!isRecurring) {
    item.done = !item.done;
    item.doneAt = item.done ? Date.now() : null;
  } else {
    if (!Array.isArray(item.completedOccurrences)) item.completedOccurrences = [];
    const idx = item.completedOccurrences.indexOf(occStart);
    if (idx >= 0) {
      // 取消已完成的 occurrence —— 不动 subtasks(用户可能想看回上次到哪)
      item.completedOccurrences.splice(idx, 1);
    } else {
      // 完成本次 → 推进到下一次 occurrence,**重置子任务**(对齐 TickTick/Todoist:
      // 子任务的勾选属于当次出现,新一次出现应当从未勾选开始)
      item.completedOccurrences.push(occStart);
      item.completedOccurrences.sort((a, b) => a - b);
      const now = Date.now();
      // legacy 行内 subtasks
      if (Array.isArray(item.subtasks)) {
        item.subtasks.forEach(s => {
          if (s.done) { s.done = false; s.doneAt = null; }
        });
      }
      // 通过 parentTaskId 挂的真任务子任务
      if (typeof state !== 'undefined' && Array.isArray(state.tasks)) {
        state.tasks.forEach(c => {
          if (c.parentTaskId === item.id && c.done) {
            c.done = false;
            c.doneAt = null;
            c.updatedAt = now;
          }
        });
      }
    }
  }
  item.updatedAt = Date.now();
}

// 同项目相邻 session 合并(对齐桌面 _mergeAdjacentSessions)
// 间隔判断用 startedAt + duration(纯专注时间结束),不用 endedAt(后者含暂停)
function mergeAdjacentSessions(sessions, gapMs) {
  if (!sessions.length) return [];
  const focusEndOf = (s) => s.startedAt + (s.duration || 0);
  const groups = new Map();
  for (const s of sessions) {
    if (!s.projectId) continue;
    if (!groups.has(s.projectId)) groups.set(s.projectId, []);
    groups.get(s.projectId).push(s);
  }
  const out = [];
  for (const [, list] of groups) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    let cur = null;
    for (const s of list) {
      if (cur && s.startedAt - cur._lastFocusEnd <= gapMs) {
        cur.endedAt = Math.max(cur.endedAt || 0, s.endedAt || focusEndOf(s));
        cur.duration = (cur.duration || 0) + (s.duration || 0);
        cur._sessions.push(s);
        cur._mergedCount = cur._sessions.length;
        cur._lastFocusEnd = focusEndOf(s);
        if (cur.taskId !== s.taskId) cur.taskId = null;
      } else {
        cur = { ...s, _mergedCount: 1, _sessions: [s], _lastFocusEnd: focusEndOf(s) };
        out.push(cur);
      }
    }
  }
  return out;
}

// ===== 时间轴块描述符(对齐桌面 _renderColumnBlocks)— 含 sessions / events / tasks =====
// 一天范围内取所有"时间块"(非全天的)
function dayTimedBlockDescs(dayStartMs) {
  const dayEnd = dayStartMs + 86400000;
  const descs = [];
  const showDone   = !state.settings || state.settings.calShowDone   !== false;
  const showFocus  = !state.settings || state.settings.calShowFocus  !== false;
  const showRepeat = !state.settings || state.settings.calShowAllRepeat !== false;
  const today0 = startOfDay(new Date()).getTime();

  // sessions(已完成的专注)— 同项目相邻段按用户设的合并间隔合并
  if (showFocus) {
    // 对齐桌面 renderDayGrid:**按 startedAt 的日**归属,不用 [startedAt, endedAt] range overlap
    // 否则 endedAt 错乱(session 没正常 finalize,被推到几小时/几天后)的脏数据会污染好几天
    const daySessions = (state.sessions || []).filter(s => {
      if (!s.startedAt || !s.duration || !s.projectId) return false;
      return s.startedAt >= dayStartMs && s.startedAt < dayEnd;
    });
    const gapMin = (state.settings && typeof state.settings.calMergeGapMin === 'number')
      ? state.settings.calMergeGapMin : 15;
    const merged = mergeAdjacentSessions(daySessions, gapMin * 60 * 1000);
    for (const m of merged) {
      const a = m.startedAt;
      // 块宽度用「真专注时长」(startedAt + duration),**不用 endedAt** — endedAt 含暂停 / 异常拉伸,会让一个 1 分钟 session 视觉上拉到 6 小时
      const b = m.startedAt + (m.duration || 0);
      if (b <= dayStartMs || a >= dayEnd) continue;
      const proj = state.projects.find(p => p.id === m.projectId);
      const tk   = m.taskId ? state.tasks.find(t => t.id === m.taskId) : null;
      const merged2 = m._mergedCount > 1;
      descs.push({
        kind: 'session',
        start: Math.max(a, dayStartMs),
        end:   Math.min(b, dayEnd),
        origStart: a, origEnd: b,
        color: (proj && proj.color) || 'var(--accent)',
        title: tk ? (tk.title || '专注') : (proj ? proj.name : '专注'),
        sub:   merged2 ? `${m._mergedCount} 段` : (tk && proj ? proj.name : ''),
        sessionId: m.id, taskId: m.taskId,
        focusMs: m.duration || 0,
        mergedCount: m._mergedCount || 1,
      });
    }
  }

  // events(用户日程)— 展开 schedule 重复
  for (const ev of (state.events || [])) {
    const occs = expandItemOccurrencesInDay(ev, dayStartMs, dayEnd);
    for (const occ of occs) {
      if (occ.allDay) continue; // 全天事件由顶部 banner 处理
      const isRepeat = occ.schedule && occ.schedule.repeat && occ.schedule.repeat !== 'none';
      if (!showRepeat && isRepeat && occ.start > today0 + 86400000 - 1) continue;
      descs.push({
        kind: 'event',
        start: Math.max(occ.start, dayStartMs),
        end:   Math.min(occ.end,   dayEnd),
        origStart: occ.start, origEnd: occ.end,
        color: colorOfCalItem(ev) || 'var(--accent)',
        title: ev.title || '(无标题)',
        eventId: ev.id,
      });
    }
  }

  // tasks(有时间的任务)— 展开 schedule 重复 + occurrence-level 完成判断
  for (const t of (state.tasks || [])) {
    if (t.archived) continue;
    const occs = expandItemOccurrencesInDay(t, dayStartMs, dayEnd);
    for (const occ of occs) {
      if (occ.allDay) continue;
      const occDone = isOccDone(t, occ.schedule, occ.start);
      if (!showDone && occDone) continue;
      const isRepeat = occ.schedule && occ.schedule.repeat && occ.schedule.repeat !== 'none';
      if (!showRepeat && isRepeat && occ.start > today0 + 86400000 - 1) continue;
      descs.push({
        kind: 'task',
        start: Math.max(occ.start, dayStartMs),
        end:   Math.min(occ.end,   dayEnd),
        origStart: occ.start, origEnd: occ.end,
        color: colorOfCalItem(t) || 'var(--accent)',
        title: t.title || '(无标题)',
        taskId: t.id, done: occDone,
        scheduleId: occ.schedule && occ.schedule.id,
        occurrenceStart: occ.start,
        project: t.projectId ? state.projects.find(p => p.id === t.projectId) : null,
      });
    }
  }
  return descs;
}

// Lane 分配(对齐桌面 _assignBlockLanes):
//   1) 块按"长度降序 → 起点升序"排;贪心分配 lane(找第一个不冲突的跑道)
//   2) BFS 找重叠连通簇,每个簇内统一 laneCount = max(lane in cluster) + 1
// 这样不重叠的块各自占 100% 宽,只有时间真正重叠的块才并列分跑道
function assignLanes(descs) {
  if (descs.length <= 1) {
    if (descs.length === 1) { descs[0].lane = 0; descs[0].laneCount = 1; }
    return descs;
  }
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  // 1) 长度降序 → 起点升序;长块抢 lane 0
  const sorted = descs.slice().sort((a, b) => ((b.end - b.start) - (a.end - a.start)) || (a.start - b.start));
  const lanes = []; // lanes[i] = 数组,保存该 lane 上已放的块
  for (const d of sorted) {
    let li = 0;
    while (li < lanes.length && lanes[li].some(x => overlaps(x, d))) li++;
    if (li === lanes.length) lanes.push([]);
    lanes[li].push(d);
    d.lane = li;
  }
  // 2) BFS 连通簇:任两块重叠就连边,簇内共享 maxLane+1
  const adj = sorted.map(() => new Set());
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (overlaps(sorted[i], sorted[j])) { adj[i].add(j); adj[j].add(i); }
    }
  }
  const seen = new Array(sorted.length).fill(false);
  for (let i = 0; i < sorted.length; i++) {
    if (seen[i]) continue;
    const queue = [i]; seen[i] = true;
    const cluster = [];
    while (queue.length) {
      const x = queue.shift();
      cluster.push(x);
      for (const y of adj[x]) if (!seen[y]) { seen[y] = true; queue.push(y); }
    }
    let maxLane = 0;
    for (const j of cluster) if (sorted[j].lane > maxLane) maxLane = sorted[j].lane;
    const count = maxLane + 1;
    for (const j of cluster) sorted[j].laneCount = count;
  }
  return descs;
}

function calBlockHtml(d, dayStartMs) {
  const startMin  = (d.start - dayStartMs) / 60000;
  const heightMin = (d.end - d.start) / 60000;
  const startStr = `${pad(new Date(d.origStart).getHours())}:${pad(new Date(d.origStart).getMinutes())}`;
  const compact = heightMin < 45;
  const styleVars = `--top-min:${startMin};--height-min:${heightMin};--lane-idx:${d.lane};--lane-count:${d.laneCount};--block-color:${esc(d.color)};`;

  if (d.kind === 'task') {
    const sidAttr = d.scheduleId ? `data-schedule-id="${esc(d.scheduleId)}"` : '';
    const occAttr = d.occurrenceStart != null ? `data-occurrence-start="${d.occurrenceStart}"` : '';
    const animCls = _animateDoneIds.has(d.taskId) ? ' just-done-anim' : '';
    return `<div class="cal-block cal-block-task ${compact?'compact':''}${d.done?' task-done':''}${animCls}" data-task-id="${esc(d.taskId)}" ${sidAttr} ${occAttr} style="${styleVars}">
      <div class="cal-task-row">
        <span class="cal-task-check ${d.done?'checked':''}" data-action="cal-task-toggle" data-task-id="${esc(d.taskId)}" ${sidAttr} ${occAttr}></span>
        <div class="cal-task-title">${esc(d.title)}</div>
      </div>
      ${!compact && d.project ? `<div class="cal-task-sub">${esc(d.project.name || '')}</div>` : ''}
      ${!compact ? `<div class="cal-task-meta">${startStr}</div>` : ''}
    </div>`;
  }

  if (d.kind === 'event') {
    return `<div class="cal-block cal-block-event ${compact?'compact':''}" data-event-id="${esc(d.eventId)}" style="${styleVars}">
      <div class="cal-block-title">${esc(d.title)}</div>
      ${heightMin >= 30 ? `<div class="cal-block-time">${startStr}</div>` : ''}
    </div>`;
  }

  // session — origStart/origEnd 给详情 sheet 用来在 state.sessions 里找回合并组里所有段
  // 块上直接写「真专注时长」(对齐桌面),如 "8m" / "1h 30m";合并段加 ×N
  const focusMs = d.focusMs || 0;
  const totalMin = Math.round(focusMs / 60000);
  const h = Math.floor(totalMin / 60), mn = totalMin % 60;
  const durStr = h ? (mn ? `${h}h ${mn}m` : `${h}h`) : `${mn}m`;
  const countStr = (d.mergedCount > 1) ? ` ×${d.mergedCount}` : '';
  return `<div class="cal-block cal-block-session ${compact?'compact':''}"
    data-session-id="${esc(d.sessionId || '')}"
    data-orig-start="${d.origStart}"
    data-orig-end="${d.origEnd}"
    style="${styleVars}">
    <div class="cal-block-title">${esc(d.title)}${countStr}</div>
    <div class="cal-block-dur">${esc(durStr)}${heightMin >= 30 ? ' · ' + esc(startStr) : ''}</div>
  </div>`;
}

function calHourLinesHtml(hours) {
  let html = '';
  for (let h = 0; h < hours; h++) {
    html += `<div class="cal-hour-line" style="--hour-idx:${h};"></div>`;
  }
  return html;
}
function calHourLabelsHtml(hours) {
  let html = '';
  for (let h = 0; h < hours; h++) {
    html += `<div class="cal-hour-label" style="--hour-idx:${h};">${pad(h)}:00</div>`;
  }
  return html;
}

const CAL_HOURS = 24;
// 每小时像素高度 — mobile 端独立持久化在 localStorage(不污染桌面 state.settings.calHourPx)
let _mobileCalHourPx = null;
function MOBILE_CAL_HOUR_PX() {
  if (_mobileCalHourPx == null) {
    const v = parseInt(localStorage.getItem('psfocus.mobile.calHourPx') || '', 10);
    _mobileCalHourPx = (Number.isFinite(v) && v >= 24 && v <= 160) ? v : 44;
  }
  return _mobileCalHourPx;
}
function setMobileCalHourPx(v) {
  const clamped = Math.max(24, Math.min(160, Math.round(v)));
  _mobileCalHourPx = clamped;
  try { localStorage.setItem('psfocus.mobile.calHourPx', String(clamped)); } catch (_) {}
  return clamped;
}

// 时间轴长按拖拽创建任务(日/周视图)— 长按 col 内某点 → 拖到另一点 → 弹新建任务窗口预填时间范围
function bindCalGridDragCreate(host) {
  if (!host) return;
  const bodyEl = host.querySelector('.cal-week-body');
  if (!bodyEl) return;
  let startCol = null;       // 起点所在的 col 元素(决定哪一天)
  let startMin = 0, endMin = 0;
  let sx = 0, sy = 0;
  let longPressTimer = null;
  let dragging = false;
  let overlay = null;        // 范围高亮的 div
  const LONG_PRESS_MS = 400;
  const MOVE_CANCEL_PX = 10;
  const SNAP_MIN = 15;

  function pointToMinutes(col, clientY) {
    const r = col.getBoundingClientRect();
    const hourPx = MOBILE_CAL_HOUR_PX();
    const yInCol = clientY - r.top;
    const min = Math.max(0, Math.min(24 * 60, (yInCol / hourPx) * 60));
    // 吸附到 SNAP_MIN
    return Math.round(min / SNAP_MIN) * SNAP_MIN;
  }
  function clearOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }
  function applyOverlay() {
    if (!startCol) return;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'cal-drag-create-overlay';
      startCol.appendChild(overlay);
    }
    const lo = Math.min(startMin, endMin);
    const hi = Math.max(startMin, endMin);
    const hourPx = MOBILE_CAL_HOUR_PX();
    overlay.style.top    = `${(lo / 60) * hourPx}px`;
    overlay.style.height = `${Math.max(8, ((hi - lo) / 60) * hourPx)}px`;
  }
  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const col = (t.target instanceof Element) && t.target.closest('.cal-week-col');
    if (!col || !host.contains(col)) return;
    // 落在时间块上 → 让块自己处理(打开详情等),不进 drag-create
    if (t.target.closest('.cal-block')) return;
    sx = t.clientX; sy = t.clientY;
    startCol = col;
    startMin = endMin = pointToMinutes(col, t.clientY);
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      dragging = true;
      _calDragCreating = true;
      try { navigator.vibrate && navigator.vibrate(15); } catch (_) {}
      applyOverlay();
    }, LONG_PRESS_MS);
  }
  function onTouchMove(e) {
    if (!startCol) return;
    const t = e.touches[0];
    if (!dragging) {
      if (Math.hypot(t.clientX - sx, t.clientY - sy) > MOVE_CANCEL_PX) {
        clearTimeout(longPressTimer);
        startCol = null;
      }
      return;
    }
    // passive: true,无法 preventDefault — 接受 native scroll 同时跑(让用户滚 cal 顺畅);overlay 仍跟手画
    endMin = pointToMinutes(startCol, t.clientY);
    applyOverlay();
  }
  function onTouchEnd() {
    clearTimeout(longPressTimer);
    if (dragging && startCol) {
      const lo = Math.min(startMin, endMin);
      const hi = Math.max(startMin, endMin);
      const dayMs = +startCol.dataset.dayMs || (function() {
        // day view 的 col 没 data-day-ms,fallback 用 ui.calCursor 当天
        return startOfDay(new Date(ui.calCursor)).getTime();
      })();
      clearOverlay();
      const sCol = startCol;
      startCol = null; dragging = false;
      const startTs = dayMs + lo * 60000;
      const endTs   = dayMs + Math.max(hi, lo + SNAP_MIN) * 60000;
      setTimeout(() => {
        _calDragCreating = false;
        openCreateTaskSheet({ startTs, endTs });
      }, 0);
      return;
    }
    startCol = null; dragging = false;
  }
  function onTouchCancel() {
    clearTimeout(longPressTimer);
    clearOverlay();
    startCol = null; dragging = false;
    _calDragCreating = false;
  }
  host.addEventListener('touchstart', onTouchStart, { passive: true });
  host.addEventListener('touchmove',  onTouchMove,  { passive: true });
  host.addEventListener('touchend',   onTouchEnd,   { passive: true });
  host.addEventListener('touchcancel',onTouchCancel,{ passive: true });
}

// 双指捏合缩放时间轴(mobile-only)— 直接改 host 上的 --cal-hour-px,
// 块/线/标签都用此变量算位置,自动 reflow,无需重渲染
function bindCalPinchZoom(host) {
  if (!host) return;
  const bodyEl = host.querySelector('.cal-week-body');
  if (!bodyEl) return;
  let pinching = false;
  let initialDist = 0;
  let initialHourPx = 0;
  let pinchAnchorY = 0;       // body 内的内容 Y(scroll + viewport offset)
  let initialMidClientY = 0;  // 两指中点的 client Y
  const dist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  const midY = (a, b) => (a.clientY + b.clientY) / 2;

  host.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    pinching = true;
    initialDist = dist(e.touches[0], e.touches[1]);
    initialHourPx = MOBILE_CAL_HOUR_PX();
    initialMidClientY = midY(e.touches[0], e.touches[1]);
    const r = bodyEl.getBoundingClientRect();
    pinchAnchorY = (initialMidClientY - r.top) + bodyEl.scrollTop;
    e.preventDefault();
  }, { passive: false });

  host.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault();
    const newDist = dist(e.touches[0], e.touches[1]);
    if (initialDist < 1) return;
    const ratio = newDist / initialDist;
    const newHourPx = Math.max(24, Math.min(160, Math.round(initialHourPx * ratio)));
    host.style.setProperty('--cal-hour-px', newHourPx);
    // 强制 reflow,让 scrollHeight 立即按新 hour-px 算 — 否则 scrollTop 被旧 maxScroll clamp,中心点偏移
    void bodyEl.scrollHeight;
    // 让捏合中心点的内容 Y 保持在屏幕同一位置
    const r = bodyEl.getBoundingClientRect();
    const newMidClientY = midY(e.touches[0], e.touches[1]);
    const newAnchorY = pinchAnchorY * (newHourPx / initialHourPx);
    bodyEl.scrollTop = newAnchorY - (newMidClientY - r.top);
  }, { passive: false });

  function endPinch() {
    if (!pinching) return;
    pinching = false;
    const cur = parseInt(host.style.getPropertyValue('--cal-hour-px'), 10);
    if (Number.isFinite(cur) && cur !== initialHourPx) setMobileCalHourPx(cur);
  }
  host.addEventListener('touchend',    () => endPinch(), { passive: true });
  host.addEventListener('touchcancel', () => endPinch(), { passive: true });
}

function _calScrollToHour(view, hour) {
  requestAnimationFrame(() => {
    const body = view.querySelector('.cal-week-body');
    if (!body) return;
    body.scrollTop = Math.max(0, hour * MOBILE_CAL_HOUR_PX() - 12);
  });
}

// 记忆 day/week 视图的 scroll 位置 — 同 mode 同 anchor day 直接复用,跨日才回到默认
const _calScrollMemo = new Map();
function _calScrollKey() {
  const day0 = startOfDay(new Date(ui.calCursor)).getTime();
  return `${ui.calMode}::${day0}`;
}
function _calApplyScrollMemo(view, defaultHour) {
  const body = view.querySelector('.cal-week-body');
  if (!body) return;
  const key = _calScrollKey();
  const saved = _calScrollMemo.get(key);
  // 用 setTimeout 0/50ms 双保险 — rAF 在 tab 切换/不可见时可能不跑,导致 cal 卡在顶
  const apply = () => {
    if (!body || !body.isConnected) return;
    if (saved != null && Number.isFinite(saved)) {
      body.scrollTop = saved;
    } else {
      body.scrollTop = Math.max(0, defaultHour * MOBILE_CAL_HOUR_PX() - 12);
    }
  };
  setTimeout(apply, 0);
  setTimeout(apply, 60);
  // 监听滚动实时记忆(防 pinch 时被覆盖,只在用户主动滚才记;passive 不阻塞)
  body.addEventListener('scroll', () => {
    _calScrollMemo.set(_calScrollKey(), body.scrollTop);
  }, { passive: true });
}

function _bindCalBlocks(view) {
  // 勾选框 — 优先绑定,stopPropagation 防止冒到 task block 打开详情
  view.querySelectorAll('[data-action="cal-task-toggle"]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const tid = el.dataset.taskId;
    const t = state.tasks.find(x => x.id === tid);
    if (!t) return;
    const sid = el.dataset.scheduleId;
    const occStart = el.dataset.occurrenceStart ? +el.dataset.occurrenceStart : null;
    const sched = sid ? (t.schedules || []).find(s => s.id === sid)
                      : (t.schedules && t.schedules[0]) || null;
    toggleOccurrenceDone(t, sched, occStart);
    _markDoneAnim(tid);
    pushState();
    renderAll();
  }));
  // task block 主体 → 打开详情(checkbox 因为 stopPropagation 不会触发)
  view.querySelectorAll('.cal-block-task[data-task-id]').forEach(el => el.addEventListener('click', (e) => {
    // 编辑模式下吞掉 click(避免触发 openTaskDetail)
    if (_calBlockEditing && _calBlockEditing.el === el) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    openTaskDetail(el.dataset.taskId);
  }));
  // 全天 pill 也要响应(它们在 banner row 里,带 data-task-id,但没 cal-block-task class)
  view.querySelectorAll('.cal-allday-pill[data-task-id]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    openTaskDetail(el.dataset.taskId);
  }));
  view.querySelectorAll('[data-event-id]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    showToast('事件编辑暂未实现,在桌面端查看');
  }));
  // session 块点击 → 弹详情 sheet,可看合并段 / 删除单段 / 删除整组
  view.querySelectorAll('.cal-block-session[data-session-id]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const sid = el.dataset.sessionId;
    const origStart = parseInt(el.dataset.origStart, 10);
    const origEnd   = parseInt(el.dataset.origEnd, 10);
    openSessionDetailSheet(sid, origStart, origEnd);
  }));
  // 长按编辑模式
  bindCalBlockEdit(view);
}

// 专注段详情 sheet — 点日历块触发,显示合并组所有段,可单删 / 全删
function openSessionDetailSheet(seedId, origStart, origEnd) {
  if (!seedId) return;
  const seed = (state.sessions || []).find(x => x.id === seedId);
  if (!seed) { showToast('session 已不存在'); return; }
  const proj = state.projects.find(p => p.id === seed.projectId);
  const task = seed.taskId ? state.tasks.find(t => t.id === seed.taskId) : null;
  // 找回合并组里所有段:同 project + 时间落在 [origStart, origEnd] 内
  const groupSessions = (state.sessions || [])
    .filter(s => s.projectId === seed.projectId && s.startedAt >= origStart - 1 && s.startedAt <= origEnd + 1)
    .sort((a, b) => a.startedAt - b.startedAt);
  const totalMs = groupSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
  const startStr = new Date(origStart).toLocaleString('zh-CN');
  const endStr = origEnd ? new Date(origEnd).toLocaleString('zh-CN') : '未结束';
  const segsHtml = groupSessions.map(s => {
    const t = s.taskId ? state.tasks.find(x => x.id === s.taskId) : null;
    return `<div class="sess-seg">
      <div class="sess-seg-meta">
        <span class="sess-seg-time">${esc(new Date(s.startedAt).toLocaleString('zh-CN'))}</span>
        <span class="sess-seg-dur">${esc(fmtHuman(s.duration || 0))}</span>
      </div>
      ${t ? `<div class="sess-seg-task">${esc(t.title || '(无标题)')}</div>` : ''}
      <div class="sess-seg-id" title="${esc(s.id)}">${esc(s.id)}</div>
      <button class="sess-seg-del" data-sess-id="${esc(s.id)}" title="删除此段">×</button>
    </div>`;
  }).join('');
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 12px;">专注详情</div>
      ${proj ? `<div class="form-row"><label>项目</label><span class="sess-proj-name">${proj.color?`<span class="sess-color-dot" style="background:${esc(proj.color)};"></span>`:''}${esc(proj.name)}</span></div>` : '<div class="form-row"><label>项目</label><span style="color:var(--text-faint);">(无项目)</span></div>'}
      ${task ? `<div class="form-row"><label>任务</label><span>${esc(task.title || '(无标题)')}</span></div>` : ''}
      <div class="form-row"><label>开始</label><span>${esc(startStr)}</span></div>
      <div class="form-row"><label>结束</label><span>${esc(endStr)}</span></div>
      <div class="form-row"><label>总时长</label><span>${esc(fmtHuman(totalMs))}</span></div>
      <div class="form-row"><label>段数</label><span>${groupSessions.length}</span></div>
      <div class="section-title" style="padding:12px 0 6px;font-size:13px;">所有段</div>
      <div class="sess-seg-list">${segsHtml}</div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">关闭</button>
      <button class="danger" data-action="del-all">删除整组(${groupSessions.length} 段)</button>
    </div>
  `, (body) => {
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="del-all"]').onclick = () => {
      if (!confirm(`删除这 ${groupSessions.length} 段专注(${fmtHuman(totalMs)})?`)) return;
      const ids = new Set(groupSessions.map(s => s.id));
      state.sessions = (state.sessions || []).filter(x => !ids.has(x.id));
      pushState(); closeSheet(); renderAll();
      showToast('已删除');
    };
    body.querySelectorAll('.sess-seg-del').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.sessId;
        const s = (state.sessions || []).find(x => x.id === id);
        if (!s) return;
        if (!confirm(`删除此段(${fmtHuman(s.duration||0)})?`)) return;
        state.sessions = (state.sessions || []).filter(x => x.id !== id);
        pushState();
        // 重打开 sheet 刷新(若组里只剩 0 段就关掉)
        const remaining = groupSessions.filter(x => x.id !== id);
        if (!remaining.length) { closeSheet(); renderAll(); return; }
        openSessionDetailSheet(remaining[0].id, origStart, origEnd);
        renderAll();
      };
    });
  });
}

// =========================================================
// ===== 时间轴块长按编辑 — 拖动 / 拉长缩短 / 边界滚 / 点空白退出 =====
// =========================================================
let _calBlockEditing = null;          // { el, taskId, scheduleId, occStart, dayMs }
let _calBlockEditDocBound = false;

function _exitBlockEdit(commit) {
  if (!_calBlockEditing) return;
  const { el, taskId, scheduleId, occStart } = _calBlockEditing;
  const dayMs = _calBlockEditing.dayMs;
  if (commit) {
    const t = state.tasks.find(x => x.id === taskId);
    if (t) {
      const newTop = parseFloat(el.style.getPropertyValue('--top-min')) || 0;
      const newH = parseFloat(el.style.getPropertyValue('--height-min')) || 30;
      const newStart = dayMs + Math.round(newTop) * 60000;
      const newEnd = dayMs + Math.round(newTop + newH) * 60000;
      const isRecurring = (t.schedules || []).some(s => s && s.repeat && s.repeat !== 'none');
      if (isRecurring && occStart != null) {
        showToast('重复任务暂不支持单次编辑');
      } else {
        let sched = scheduleId ? (t.schedules || []).find(s => s.id === scheduleId) : null;
        if (!sched && (t.schedules || []).length) sched = t.schedules[0];
        if (sched) {
          sched.start = newStart;
          sched.end = newEnd;
          sched.allDay = false;
          sched.kind = 'range';
          // 同步 legacy
          t.start = newStart;
          t.end = newEnd;
          t.allDay = false;
          t.dueAt = newStart;
          t.updatedAt = Date.now();
          pushState();
        }
      }
    }
  }
  el.classList.remove('editing');
  // 移除手柄
  el.querySelectorAll('.cal-block-handle').forEach(h => h.remove());
  document.body.classList.remove('cal-block-editing');
  _calBlockEditing = null;
  if (commit) renderAll();
}

function bindCalBlockEdit(view) {
  if (!_calBlockEditDocBound) {
    _calBlockEditDocBound = true;
    // 全局:点空白(块外)退出并保存
    document.addEventListener('click', (e) => {
      if (!_calBlockEditing) return;
      const insideEditing = e.target.closest && e.target.closest('.cal-block.editing');
      // 也忽略点 sheet/popover/抽屉(不算"空白")
      const insidePopup = e.target.closest && e.target.closest('#sheet, #popover, #drawer-nav, #cal-side-drawer, #img-lightbox');
      if (insideEditing || insidePopup) return;
      _exitBlockEdit(true);
    }, true);
    document.addEventListener('touchstart', (e) => {
      if (!_calBlockEditing) return;
      const t = e.target;
      const insideEditing = t.closest && t.closest('.cal-block.editing');
      const insidePopup = t.closest && t.closest('#sheet, #popover, #drawer-nav, #cal-side-drawer, #img-lightbox');
      if (insideEditing || insidePopup) return;
      _exitBlockEdit(true);
    }, true);
  }
  view.querySelectorAll('.cal-block-task[data-task-id]').forEach(el => {
    let pressTimer = null;
    let pressX = 0, pressY = 0, pressT0 = 0;
    let touchMoved = false;
    let dragMode = null;       // 'move' | 'resize-top' | 'resize-bottom'
    let startTop = 0, startH = 0, startY = 0;
    const SNAP = 15;
    const LONG_PRESS_MS = 320;
    const FALLBACK_LONG_PRESS_MS = 260;  // touchend 时若 duration > 这个值也算长按
    const MOVE_CANCEL_PX = 15;
    const HOUR_PX = () => MOBILE_CAL_HOUR_PX();
    const snap = (m) => Math.round(m / SNAP) * SNAP;
    const setVars = (top, h) => {
      el.style.setProperty('--top-min', String(top));
      el.style.setProperty('--height-min', String(h));
    };
    const readVars = () => {
      const m = el.getAttribute('style') || '';
      const top = parseFloat((m.match(/--top-min:([\d.\-]+)/) || [])[1] || el.style.getPropertyValue('--top-min') || '0');
      const h = parseFloat((m.match(/--height-min:([\d.\-]+)/) || [])[1] || el.style.getPropertyValue('--height-min') || '30');
      return { top, h };
    };
    const autoScroll = (clientY) => {
      const body = el.closest('.cal-week-body');
      if (!body) return;
      const r = body.getBoundingClientRect();
      const margin = 60;
      if (clientY > r.bottom - margin) body.scrollTop += 6;
      else if (clientY < r.top + margin) body.scrollTop -= 6;
    };
    const enterEditMode = () => {
      if (_calBlockEditing && _calBlockEditing.el === el) return;
      if (_calBlockEditing && _calBlockEditing.el !== el) _exitBlockEdit(true);
      if (!el.querySelector('.cal-block-handle.top')) {
        el.insertAdjacentHTML('afterbegin', '<span class="cal-block-handle top"></span>');
      }
      if (!el.querySelector('.cal-block-handle.bottom')) {
        el.insertAdjacentHTML('beforeend', '<span class="cal-block-handle bottom"></span>');
      }
      el.classList.add('editing');
      document.body.classList.add('cal-block-editing');
      const col = el.closest('.cal-week-col');
      const dayMs = col ? +col.dataset.dayMs : 0;
      _calBlockEditing = {
        el,
        taskId: el.dataset.taskId,
        scheduleId: el.dataset.scheduleId || null,
        occStart: el.dataset.occurrenceStart != null ? +el.dataset.occurrenceStart : null,
        dayMs,
      };
      try { navigator.vibrate && navigator.vibrate(15); } catch (_) {}
    };

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      pressX = t.clientX; pressY = t.clientY;
      pressT0 = Date.now();
      touchMoved = false;
      // 已经在编辑中:决定 move/resize
      if (_calBlockEditing && _calBlockEditing.el === el) {
        const handle = (t.target instanceof Element) && t.target.closest('.cal-block-handle');
        dragMode = handle ? (handle.classList.contains('top') ? 'resize-top' : 'resize-bottom') : 'move';
        const cur = readVars();
        startTop = cur.top; startH = cur.h; startY = t.clientY;
        e.stopPropagation();
        return;
      }
      // 未编辑:启动长按 timer
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { pressTimer = null; enterEditMode(); }, LONG_PRESS_MS);
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      // 长按未触发 + 移动太多 → 取消
      if (pressTimer && Math.hypot(t.clientX - pressX, t.clientY - pressY) > MOVE_CANCEL_PX) {
        clearTimeout(pressTimer); pressTimer = null;
        touchMoved = true;
      }
      if (_calBlockEditing && _calBlockEditing.el === el && dragMode) {
        // passive: true 时无法 preventDefault — 接受 native scroll 同时跑
        const dy = t.clientY - startY;
        const dMin = (dy / HOUR_PX()) * 60;
        if (dragMode === 'move') {
          let nt = snap(startTop + dMin);
          nt = Math.max(0, Math.min(24 * 60 - startH, nt));
          setVars(nt, startH);
        } else if (dragMode === 'resize-top') {
          let nt = snap(startTop + dMin);
          let nh = startH - (nt - startTop);
          if (nh < SNAP) { nt = startTop + startH - SNAP; nh = SNAP; }
          if (nt < 0) { nh += nt; nt = 0; }
          setVars(nt, nh);
        } else {
          let nh = snap(startH + dMin);
          nh = Math.max(SNAP, Math.min(24 * 60 - startTop, nh));
          setVars(startTop, nh);
        }
        autoScroll(t.clientY);
      }
    }, { passive: true });

    el.addEventListener('touchend', () => {
      // 还没进入 edit 模式 — 检查 fallback:duration 够长但 timer 还没跑就抬手 → 视为长按
      if (pressTimer) {
        clearTimeout(pressTimer); pressTimer = null;
        if (!touchMoved && Date.now() - pressT0 >= FALLBACK_LONG_PRESS_MS) {
          enterEditMode();
        }
      }
      if (_calBlockEditing && _calBlockEditing.el === el) {
        dragMode = null;
        // 不退出 edit;等用户点空白才退出
      }
    });
    el.addEventListener('touchcancel', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      dragMode = null;
    });
    // 阻止 iOS 长按弹系统选择/Look Up 菜单
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  });
}

function renderDayView(view) {
  const cursor = new Date(ui.calCursor);
  const dayStart = startOfDay(cursor).getTime();
  const today0 = startOfDay(new Date()).getTime();
  const isToday = dayStart === today0;
  const showDone = !state.settings || state.settings.calShowDone !== false;

  // 全天:tasks + events
  const allDayItems = [];
  for (const t of (state.tasks || [])) {
    if (t.archived) continue;
    if (t.start && !t.allDay) continue;
    const r = allDayTaskOnDay(t, dayStart);
    if (!r) continue;
    if (!showDone && r.done) continue;
    allDayItems.push({ kind: 'task', id: t.id, title: t.title || '(无标题)', color: colorOfCalItem(t) || 'var(--accent)', done: r.done });
  }
  for (const ev of (state.events || [])) {
    if (!ev.start) continue;
    if (!ev.allDay) continue;
    const evEnd = ev.end || (ev.start + 86400000 - 1);
    if (evEnd < dayStart || ev.start > dayStart + 86400000) continue;
    allDayItems.push({ kind: 'event', id: ev.id, title: ev.title || '(无标题)', color: colorOfCalItem(ev) || 'var(--accent)' });
  }
  // 时间块
  const descs = assignLanes(dayTimedBlockDescs(dayStart));
  const blocksHtml = descs.map(d => calBlockHtml(d, dayStart)).join('');

  view.innerHTML = `
    <div class="cal-day-view" style="--cal-hour-px:${MOBILE_CAL_HOUR_PX()};--cal-hours:${CAL_HOURS};">
      ${allDayItems.length ? `<div class="cal-week-allday-row">
        <div class="cal-week-allday-spacer"></div>
        <div class="cal-week-allday-bars">
          ${allDayItems.map(it => `<div class="cal-allday-pill ${it.done?'done':''}" ${it.kind==='task'?`data-task-id="${esc(it.id)}"`:`data-event-id="${esc(it.id)}"`} style="--block-color:${esc(it.color)}">${esc(it.title)}</div>`).join('')}
        </div>
      </div>` : ''}
      <div class="cal-week-body">
        <div class="cal-week-gutter">${calHourLabelsHtml(CAL_HOURS)}</div>
        <div class="cal-week-cols">
          <div class="cal-week-col cal-day-col" data-day-ms="${dayStart}">
            ${calHourLinesHtml(CAL_HOURS)}
            ${blocksHtml}
            ${isToday ? renderNowLineHtml() : ''}
          </div>
        </div>
      </div>
    </div>`;
  _bindCalBlocks(view);
  bindCalendarGestures(view);
  bindCalPinchZoom(view.querySelector('.cal-day-view'));
  bindCalGridDragCreate(view.querySelector('.cal-day-view'));
  _calApplyScrollMemo(view, isToday ? Math.max(0, new Date().getHours() - 1) : 8);
}

function renderWeekView(view) {
  const cursor = new Date(ui.calCursor);
  const ws = startOfWeek(cursor);
  const today0 = startOfDay(new Date()).getTime();
  const days = []; for (let i = 0; i < 7; i++) days.push(addDays(ws, i));

  // 头部:每日 dow + date
  let head = `<div class="cal-week-head"><div class="cal-week-weekno"></div>`;
  for (let i = 0; i < 7; i++) {
    const d = days[i];
    const isToday = startOfDay(d).getTime() === today0;
    head += `<div class="cal-week-day-head ${isToday?'today':''}" data-week-day-ms="${startOfDay(d).getTime()}">
      <span class="cal-week-dow">${'一二三四五六日'[i]}</span>
      <span class="cal-week-num">${d.getDate()}</span>
    </div>`;
  }
  head += `</div>`;

  // 全天 banner row(7 天 union)
  const showDone = !state.settings || state.settings.calShowDone !== false;
  const allDayPerDay = days.map(() => []);
  for (const t of (state.tasks || [])) {
    if (t.archived) continue;
    if (t.start && !t.allDay) continue;
    for (let i = 0; i < 7; i++) {
      const dStart = startOfDay(days[i]).getTime();
      const r = allDayTaskOnDay(t, dStart);
      if (!r) continue;
      if (!showDone && r.done) continue;
      allDayPerDay[i].push({ kind: 'task', id: t.id, title: t.title || '(无标题)', color: colorOfCalItem(t) || 'var(--accent)', done: r.done });
    }
  }
  for (const ev of (state.events || [])) {
    if (!ev.start || !ev.allDay) continue;
    for (let i = 0; i < 7; i++) {
      const dStart = startOfDay(days[i]).getTime();
      const evEnd = ev.end || (ev.start + 86400000 - 1);
      if (evEnd < dStart || ev.start > dStart + 86400000) continue;
      allDayPerDay[i].push({ kind: 'event', id: ev.id, title: ev.title || '(无标题)', color: colorOfCalItem(ev) || 'var(--accent)' });
    }
  }
  const allDayHtml = allDayPerDay.some(a => a.length) ? `<div class="cal-week-allday-row">
    <div class="cal-week-allday-spacer"></div>
    ${allDayPerDay.map(items => `<div class="cal-week-allday-cell">
      ${items.slice(0, 3).map(it => `<div class="cal-allday-pill ${it.done?'done':''}" ${it.kind==='task'?`data-task-id="${esc(it.id)}"`:`data-event-id="${esc(it.id)}"`} style="--block-color:${esc(it.color)}">${esc(it.title)}</div>`).join('')}
      ${items.length > 3 ? `<div class="cal-allday-more">+${items.length - 3}</div>` : ''}
    </div>`).join('')}
  </div>` : '';

  // 7 列时间块
  const colsHtml = days.map((d, i) => {
    const dStart = startOfDay(d).getTime();
    const isToday = dStart === today0;
    const descs = assignLanes(dayTimedBlockDescs(dStart));
    return `<div class="cal-week-col ${isToday?'today':''}" data-day-ms="${dStart}">
      ${calHourLinesHtml(CAL_HOURS)}
      ${descs.map(de => calBlockHtml(de, dStart)).join('')}
      ${isToday ? renderNowLineHtml() : ''}
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="cal-week" style="--cal-hour-px:${MOBILE_CAL_HOUR_PX()};--cal-hours:${CAL_HOURS};">
      ${head}
      ${allDayHtml}
      <div class="cal-week-body">
        <div class="cal-week-gutter">${calHourLabelsHtml(CAL_HOURS)}</div>
        <div class="cal-week-cols">${colsHtml}</div>
      </div>
    </div>`;
  // 周视图日格点击 → 切到日视图当天
  view.querySelectorAll('[data-week-day-ms]').forEach(el => el.addEventListener('click', () => {
    ui.calCursor = +el.dataset.weekDayMs;
    ui.calMode = 'day';
    saveUI(); renderAll();
  }));
  _bindCalBlocks(view);
  bindCalendarGestures(view);
  bindCalPinchZoom(view.querySelector('.cal-week'));
  bindCalGridDragCreate(view.querySelector('.cal-week'));
  // 滚到 8:00 或当前小时(如果今天在本周内)
  const todayInWeek = days.some(d => startOfDay(d).getTime() === today0);
  _calApplyScrollMemo(view, todayInWeek ? Math.max(0, new Date().getHours() - 1) : 8);
}

function renderNowLineHtml() {
  const now = new Date();
  const minNow = now.getHours() * 60 + now.getMinutes();
  return `<div class="cal-now-line" style="--now-min:${minNow};"></div>`;
}

function bindCalendarGestures(el) {
  let sx = 0, sy = 0, t0 = 0, swiping = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; t0 = Date.now(); swiping = true;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!swiping) return; swiping = false;
    if (_calDragCreating) return; // 拖拽创建优先,跳过 swipe 翻月
    // 月视图是连续滚动流(13 个月一锅渲染),不接收左右翻月手势 — 跟垂直滚动冲突 + 不必要
    if (ui.calMode === 'month') return;
    const dx = (e.changedTouches[0].clientX - sx);
    const dy = (e.changedTouches[0].clientY - sy);
    const dt = Date.now() - t0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)*1.5 && dt < 800) {
      if (dx > 0) calNavigate(-1); else calNavigate(1);
    }
  }, { passive: true });
}
function calNavigate(dir) {
  const c = new Date(ui.calCursor);
  if (ui.calMode === 'month') { c.setMonth(c.getMonth() + dir); }
  else if (ui.calMode === 'week') { c.setDate(c.getDate() + dir*7); }
  else { c.setDate(c.getDate() + dir); }
  ui.calCursor = c.getTime();
  saveUI(); renderAll();
}

function openCalendarModeSwitcher() {
  showPopover([
    { toggle: true, label: '月', icon: 'ico-calendar', stateText: ui.calMode==='month'?'已选':'', action: () => { ui.calMode = 'month'; saveUI(); closePopover(); renderAll(); } },
    { toggle: true, label: '周', icon: 'ico-calendar', stateText: ui.calMode==='week'?'已选':'', action: () => { ui.calMode = 'week'; saveUI(); closePopover(); renderAll(); } },
    { toggle: true, label: '日', icon: 'ico-calendar', stateText: ui.calMode==='day'?'已选':'', action: () => { ui.calMode = 'day'; saveUI(); closePopover(); renderAll(); } },
  ], { side: 'left' });
}

// 账本期间切换(月/季/年)— 顶栏左上 pill 点出,样式对齐日历视图切换
function openLedgerViewSwitcher() {
  showPopover([
    { toggle: true, label: '月', icon: 'ico-calendar', stateText: ledgerMState.view==='month'?'已选':'',   action: () => { ledgerMState.view = 'month';   closePopover(); renderAll(); } },
    { toggle: true, label: '季', icon: 'ico-calendar', stateText: ledgerMState.view==='quarter'?'已选':'', action: () => { ledgerMState.view = 'quarter'; closePopover(); renderAll(); } },
    { toggle: true, label: '年', icon: 'ico-calendar', stateText: ledgerMState.view==='year'?'已选':'',    action: () => { ledgerMState.view = 'year';    closePopover(); renderAll(); } },
  ], { side: 'left' });
}

function openCalendarMoreMenu() {
  const s = state.settings;
  const showDone   = s.calShowDone      !== false;
  const showFocus  = s.calShowFocus     !== false;
  const showRepeat = s.calShowAllRepeat !== false;
  const colorByTag = (s.calColorMode || 'project') === 'tag';
  const mergeGap   = (typeof s.calMergeGapMin === 'number') ? s.calMergeGapMin : 15;
  // 视图切换在左上 pill 已经能用,这里不重复
  const items = [
    { label: '展开任务侧栏', icon: 'ico-list', action: () => { closePopover(); openCalendarSidebar(); } },
    { divider: true },
    { toggle: true, label: '显示已完成',       icon: 'ico-check',  stateText: showDone   ? '已开' : '', action: () => { s.calShowDone      = !showDone;   pushState(); closePopover(); renderAll(); } },
    { toggle: true, label: '显示专注记录',     icon: 'ico-clock',  stateText: showFocus  ? '已开' : '', action: () => { s.calShowFocus     = !showFocus;  pushState(); closePopover(); renderAll(); } },
    { toggle: true, label: '显示所有重复周期', icon: 'ico-clock',  stateText: showRepeat ? '已开' : '', action: () => { s.calShowAllRepeat = !showRepeat; pushState(); closePopover(); renderAll(); } },
    { toggle: true, label: '颜色用标签(否则项目)', icon: 'ico-tag', stateText: colorByTag ? '已开' : '', action: () => { s.calColorMode = colorByTag ? 'project' : 'tag'; pushState(); closePopover(); renderAll(); } },
    { numberInput: true, label: '专注合并间隔', icon: 'ico-clock', value: mergeGap, min: 0, max: 240, step: 1, unit: '分钟',
      onChange: (v) => { s.calMergeGapMin = Math.max(0, Math.min(240, v)); pushState(); renderAll(); } },
    { divider: true },
    { label: '回到今日', icon: 'ico-today', action: () => {
      ui.calCursor = Date.now();
      ui.calSelectedDay = startOfDay(new Date()).getTime();
      saveUI(); closePopover(); renderAll();
    }},
  ];
  showPopover(items);
}

// ----- 右抽屉(任务侧栏)-----
function openCalendarSidebar() {
  $('drawer-right').classList.remove('hidden');
  requestAnimationFrame(() => $('drawer-right').classList.add('open'));
  renderCalendarSidebar();
}
function closeCalendarSidebar() {
  $('drawer-right').classList.remove('open');
  setTimeout(() => $('drawer-right').classList.add('hidden'), 280);
}
function renderCalendarSidebar() {
  const body = $('drawer-right-body');
  if (!body) return;
  const dms = ui.calSelectedDay || startOfDay(new Date()).getTime();
  const tks = tasksOnDay(dms);
  const undone = tks.filter(t => !t.done);
  const done = tks.filter(t => t.done);
  const dt = new Date(dms);
  let html = `<div class="drawer-right-head">
    <div class="drawer-right-title">${dt.getMonth()+1} 月 ${dt.getDate()} 日</div>
    <div class="drawer-right-sub">${tks.length} 条任务</div>
  </div>`;
  html += `<div class="drawer-body">`;
  if (undone.length) html += `<div class="card-list">${undone.map(taskCardHtml).join('')}</div>`;
  if (done.length && state.settings.calShowDone !== false) {
    html += `<div class="section-title">已完成 (${done.length})</div>`;
    html += `<div class="card-list">${done.map(taskCardHtml).join('')}</div>`;
  }
  if (!tks.length) html += `<div class="empty" style="padding:24px;">这天没有任务</div>`;
  html += `</div>`;
  body.innerHTML = html;
  bindTaskCards(body);
}

// =========================================================
// ===== 统计 tab =====
// =========================================================
function renderStatsTab(view) {
  const sessions = state.sessions || [];
  const today0 = startOfDay(new Date()).getTime();
  const week0 = startOfWeek(new Date()).getTime();
  const minOf = (s) => Math.max(0, (s.duration || 0) / 60000);
  const todayMin = Math.round(sessions.filter(s => s.startedAt >= today0).reduce((a,s) => a+minOf(s), 0));
  const weekMin = Math.round(sessions.filter(s => s.startedAt >= week0).reduce((a,s) => a+minOf(s), 0));
  const totalMin = Math.round(sessions.reduce((a,s) => a+minOf(s), 0));

  // 最近 7 天每日专注分钟
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(startOfDay(new Date()), -i);
    const a = d.getTime(), b = a + 86400000;
    const m = Math.round(sessions.filter(s => s.startedAt >= a && s.startedAt < b).reduce((acc,s) => acc + minOf(s), 0));
    days.push({ d, min: m });
  }
  const max = Math.max(60, ...days.map(x => x.min));

  // 最近 7 天每日完成任务数
  const doneDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(startOfDay(new Date()), -i);
    const a = d.getTime(), b = a + 86400000;
    const c = state.tasks.filter(t => t.done && t.doneAt && t.doneAt >= a && t.doneAt < b).length;
    doneDays.push({ d, c });
  }
  const maxDone = Math.max(3, ...doneDays.map(x => x.c));

  view.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-num">${todayMin}<span>分</span></div><div class="stat-label">今日专注</div></div>
      <div class="stat-card"><div class="stat-num">${weekMin}<span>分</span></div><div class="stat-label">本周专注</div></div>
      <div class="stat-card"><div class="stat-num">${state.tasks.filter(t=>t.done).length}</div><div class="stat-label">累计完成</div></div>
      <div class="stat-card"><div class="stat-num">${Math.round(totalMin/60)}<span>时</span></div><div class="stat-label">累计专注</div></div>
    </div>
    <div class="section-title">最近 7 天专注分钟</div>
    <div class="stat-bars">
      ${days.map(x => `<div class="stat-bar-col">
        <div class="stat-bar" style="height:${(x.min/max*100)|0}%"><span>${x.min || ''}</span></div>
        <div class="stat-bar-label">${x.d.getMonth()+1}/${x.d.getDate()}</div>
      </div>`).join('')}
    </div>
    <div class="section-title">最近 7 天完成任务</div>
    <div class="stat-bars">
      ${doneDays.map(x => `<div class="stat-bar-col">
        <div class="stat-bar accent2" style="height:${(x.c/maxDone*100)|0}%"><span>${x.c || ''}</span></div>
        <div class="stat-bar-label">${x.d.getMonth()+1}/${x.d.getDate()}</div>
      </div>`).join('')}
    </div>
  `;
}

// =========================================================
// ===== 设置 tab =====
// =========================================================
function renderSettingsTab(view) {
  if (ui.settingsPage === 'appearance') return renderSettingsAppearance(view);
  if (ui.settingsPage === 'system')     return renderSettingsSystem(view);
  if (ui.settingsPage === 'templates')  return renderSettingsTemplates(view);
  if (ui.settingsPage === 'account')    return renderSettingsAccount(view);
  if (ui.settingsPage === 'about')      return renderSettingsAbout(view);
  return renderSettingsRoot(view);
}

function _settingsRowCard(page, icon, title) {
  return `<button class="settings-cat-row" data-action="open-settings-page" data-page="${page}">
    <span class="settings-cat-icon ${icon}"></span>
    <span class="settings-cat-title">${esc(title)}</span>
    <span class="settings-cat-arrow ico-chevron-right"></span>
  </button>`;
}

function renderSettingsRoot(view) {
  view.innerHTML = `
    <div class="settings-cat-list">
      ${_settingsRowCard('appearance', 'ico-palette',  '外观')}
      ${_settingsRowCard('system',     'ico-grid',     '系统')}
      ${_settingsRowCard('templates',  'ico-template', '模板')}
    </div>
    <div class="settings-cat-list">
      ${_settingsRowCard('account', 'ico-user', '账号')}
      ${_settingsRowCard('about',   'ico-info', '关于')}
    </div>
  `;
  view.querySelectorAll('[data-action="open-settings-page"]').forEach(b => b.onclick = () => {
    ui.settingsPage = b.dataset.page;
    renderAll();
  });
}

function _renderMobileGlassBgSettings(s) {
  const g = s.glassBg || {};
  const type = g.type || 'gradient';
  const typeSeg = ['solid','gradient','image'].map(t => {
    const labelMap = { solid:'纯色', gradient:'渐变', image:'图片' };
    return `<button class="${type===t?'on':''}" data-action="glass-bg-type" data-type="${t}">${labelMap[t]}</button>`;
  }).join('');
  let detail = '';
  if (type === 'solid') {
    const c = g.solidColor || '#eef1f5';
    detail = `<label class="color-input-wrap"><input type="color" class="color-input" data-glass-field="solidColor" value="${esc(c)}"><span class="color-input-hex">${esc(c)}</span></label>`;
  } else if (type === 'gradient') {
    const f = (g.gradient && g.gradient.from) || '#e8eef5';
    const tCol = (g.gradient && g.gradient.to)   || '#c9d4e3';
    const a = (g.gradient && g.gradient.angle != null) ? +g.gradient.angle : 135;
    detail = `
      <label class="color-input-wrap"><span class="color-input-label">起</span><input type="color" class="color-input" data-glass-field="gradFrom" value="${esc(f)}"></label>
      <label class="color-input-wrap"><span class="color-input-label">止</span><input type="color" class="color-input" data-glass-field="gradTo" value="${esc(tCol)}"></label>
      <div class="settings-glass-angle">
        <input type="range" min="0" max="360" step="5" value="${a}" data-glass-field="gradAngle">
        <span class="settings-glass-angle-val">${a}°</span>
      </div>`;
  } else if (type === 'image') {
    const has = !!g.imageDataUrl;
    detail = `
      <button class="settings-mini-btn" data-action="glass-image-pick">${has ? '换图' : '选图'}</button>
      ${has ? `<button class="settings-mini-btn" data-action="glass-image-clear">清除</button>` : ''}
      ${has ? `<img class="settings-glass-img-preview" src="${esc(g.imageDataUrl)}" alt="">` : '<div class="settings-hint">建议横版,会自动压到 1600px JPEG</div>'}
    `;
  }
  const blur = (g.blur != null) ? +g.blur : 24;
  return `
    <div class="settings-row">
      <div class="settings-row-label">背景类型</div>
      <div class="settings-segment">${typeSeg}</div>
    </div>
    <div class="settings-row">
      <div class="settings-row-label">背景内容</div>
      <div class="settings-glass-detail">${detail}</div>
    </div>
    <div class="settings-row">
      <div class="settings-row-label">玻璃模糊</div>
      <div class="settings-glass-blur">
        <input type="range" min="0" max="60" step="2" value="${blur}" data-glass-field="blur">
        <span class="settings-glass-blur-val">${blur}px</span>
      </div>
    </div>`;
}
function renderSettingsAppearance(view) {
  const s = state.settings = state.settings || {};
  const themeMode  = s.theme || 'auto';
  const accent     = s.accentColor   || '#4cc26a';
  const contrast   = s.contrastColor || '';
  const bgPage     = s.bgPage        || '';
  const presets    = Array.isArray(s.themePresets) ? s.themePresets : [];
  const palettes   = Array.isArray(s.palettes) ? s.palettes : [];
  const activePid  = s.activePaletteId || (palettes[0] && palettes[0].id) || '';

  const themeBtns = [
    { id: 'light', label: '浅色' },
    { id: 'dark',  label: '深色' },
    { id: 'auto',  label: '跟随系统' },
  ].map(t => `<button class="${themeMode===t.id?'on':''}" data-action="set-theme" data-theme="${t.id}">${t.label}</button>`).join('');

  const presetCards = presets.map(tp => `
    <button class="theme-preset-card" data-action="apply-preset" data-preset-id="${esc(tp.id)}" title="${esc(tp.desc || tp.name || '')}">
      <div class="theme-preset-swatches">
        <span style="background:${esc(tp.bgPage || '#fff')}"></span>
        <span style="background:${esc(tp.accentColor || '#000')}"></span>
        <span style="background:${esc(tp.contrastColor || '#000')}"></span>
      </div>
      <div class="theme-preset-name">${esc(tp.name || '未命名')}</div>
    </button>
  `).join('');

  const paletteCards = palettes.map(p => {
    const dots = (p.colors || []).slice(0, 6).map(c => `<span class="palette-card-dot" style="background:${esc(c)}"></span>`).join('');
    const isDefault = p.id === activePid;
    return `<button class="palette-card ${isDefault?'is-default':''}" data-action="set-palette" data-palette-id="${esc(p.id)}" title="${isDefault?'当前默认色板':'点击设为默认'}">
      <div class="palette-card-dots">${dots}</div>
      <div class="palette-card-name">${esc(p.name || '未命名')}${isDefault ? ' <span class="palette-card-default-tag">默认</span>' : ''}</div>
    </button>`;
  }).join('');

  view.innerHTML = `
    <div class="settings-row">
      <div class="settings-row-label">主题</div>
      <div class="settings-segment">${themeBtns}</div>
    </div>

    <div class="settings-sub-title">主题预设</div>
    <div class="settings-hint">点击应用 = 主色 + 对比色 + 页底色 一键替换</div>
    <div class="theme-preset-grid">
      ${presetCards || '<div class="settings-hint" style="grid-column:1/-1;">还没有主题预设,在桌面端创建后会同步过来</div>'}
    </div>

    <div class="settings-row">
      <div class="settings-row-label">主色</div>
      <label class="color-input-wrap"><input type="color" class="color-input" data-color-key="accentColor" value="${esc(accent)}"><span class="color-input-hex">${esc(accent)}</span></label>
    </div>
    <div class="settings-row">
      <div class="settings-row-label">对比色</div>
      <label class="color-input-wrap"><input type="color" class="color-input" data-color-key="contrastColor" value="${esc(contrast || '#1a1a1a')}"><span class="color-input-hex">${esc(contrast || '默认')}</span></label>
      ${contrast ? `<button class="color-input-clear" data-action="clear-color" data-color-key="contrastColor">恢复默认</button>` : ''}
    </div>
    <div class="settings-row">
      <div class="settings-row-label">页底色</div>
      <label class="color-input-wrap"><input type="color" class="color-input" data-color-key="bgPage" value="${esc(bgPage || '#f1f2f4')}"><span class="color-input-hex">${esc(bgPage || '默认')}</span></label>
      ${bgPage ? `<button class="color-input-clear" data-action="clear-color" data-color-key="bgPage">恢复默认</button>` : ''}
    </div>

    <div class="settings-sub-title">界面风格</div>
    <div class="settings-hint">默认扁平 / 毛玻璃(半透明 + 模糊)</div>
    <div class="settings-row">
      <div class="settings-row-label">风格</div>
      <div class="settings-segment">
        <button class="${(s.uiSkin || 'flat')==='flat'?'on':''}" data-action="set-skin" data-skin="flat">默认</button>
        <button class="${s.uiSkin==='glass'?'on':''}" data-action="set-skin" data-skin="glass">毛玻璃</button>
      </div>
    </div>
    ${s.uiSkin === 'glass' ? _renderMobileGlassBgSettings(s) : ''}

    <div class="settings-sub-title">默认色板</div>
    <div class="settings-hint">编辑项目 / 事件颜色时从默认色板取色</div>
    <div class="palette-card-grid">
      ${paletteCards || '<div class="settings-hint" style="grid-column:1/-1;">还没有色板,在桌面端创建后会同步过来</div>'}
    </div>
  `;

  view.querySelectorAll('[data-action="set-theme"]').forEach(b => b.onclick = () => {
    s.theme = b.dataset.theme;
    pushState(); applyTheme();
    renderSettingsAppearance(view);
  });
  view.querySelectorAll('[data-action="apply-preset"]').forEach(b => b.onclick = () => {
    const id = b.dataset.presetId;
    const tp = presets.find(x => x.id === id);
    if (!tp) return;
    if (tp.accentColor)   s.accentColor   = tp.accentColor;
    if (tp.contrastColor) s.contrastColor = tp.contrastColor;
    if (tp.bgPage)        s.bgPage        = tp.bgPage;
    applyAllAppearance();
    pushState();
    renderSettingsAppearance(view);
  });
  view.querySelectorAll('[data-action="set-palette"]').forEach(b => b.onclick = () => {
    s.activePaletteId = b.dataset.paletteId;
    pushState();
    renderSettingsAppearance(view);
  });
  view.querySelectorAll('.color-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const key = inp.dataset.colorKey;
      const v = inp.value;
      s[key] = v;
      if (key === 'accentColor')   applyAccent(v);
      if (key === 'contrastColor') applyContrast(v);
      if (key === 'bgPage')        applyBgPage(v);
      const hexEl = inp.parentElement.querySelector('.color-input-hex');
      if (hexEl) hexEl.textContent = v;
    });
    inp.addEventListener('change', () => { pushState(); renderSettingsAppearance(view); });
  });
  view.querySelectorAll('[data-action="clear-color"]').forEach(b => b.onclick = () => {
    const key = b.dataset.colorKey;
    s[key] = '';
    if (key === 'contrastColor') applyContrast('');
    if (key === 'bgPage')        applyBgPage('');
    pushState();
    renderSettingsAppearance(view);
  });
  // ===== 毛玻璃皮肤 =====
  view.querySelectorAll('[data-action="set-skin"]').forEach(b => b.onclick = () => {
    const v = b.dataset.skin;
    if (v !== 'flat' && v !== 'glass') return;
    s.uiSkin = v;
    if (v === 'glass' && !s.glassBg) {
      s.glassBg = { type: 'gradient', gradient: { from: '#e8eef5', to: '#c9d4e3', angle: 135 }, blur: 24 };
    }
    applySkin();
    pushState();
    renderSettingsAppearance(view);
  });
  view.querySelectorAll('[data-action="glass-bg-type"]').forEach(b => b.onclick = () => {
    if (!s.glassBg) s.glassBg = {};
    s.glassBg.type = b.dataset.type;
    applySkin();
    pushState();
    renderSettingsAppearance(view);
  });
  view.querySelectorAll('[data-glass-field]').forEach(inp => {
    inp.addEventListener('input', () => {
      if (!s.glassBg) s.glassBg = {};
      const f = inp.dataset.glassField;
      const v = inp.value;
      if (f === 'solidColor') s.glassBg.solidColor = v;
      else if (f === 'gradFrom' || f === 'gradTo' || f === 'gradAngle') {
        if (!s.glassBg.gradient) s.glassBg.gradient = { from:'#e8eef5', to:'#c9d4e3', angle:135 };
        if (f === 'gradFrom')  s.glassBg.gradient.from = v;
        if (f === 'gradTo')    s.glassBg.gradient.to = v;
        if (f === 'gradAngle') {
          s.glassBg.gradient.angle = parseInt(v, 10) || 0;
          const lbl = inp.parentElement && inp.parentElement.querySelector('.settings-glass-angle-val');
          if (lbl) lbl.textContent = s.glassBg.gradient.angle + '°';
        }
      } else if (f === 'blur') {
        s.glassBg.blur = parseInt(v, 10) || 0;
        const lbl = inp.parentElement && inp.parentElement.querySelector('.settings-glass-blur-val');
        if (lbl) lbl.textContent = s.glassBg.blur + 'px';
      }
      applySkin();
      // hex 显示同步(纯色)
      const hex = inp.parentElement && inp.parentElement.querySelector('.color-input-hex');
      if (hex) hex.textContent = v;
    });
    inp.addEventListener('change', () => { pushState(); });
  });
  view.querySelectorAll('[data-action="glass-image-pick"]').forEach(b => b.onclick = async () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (f) {
        try {
          const dataUrl = await _downscaleImageToDataUrl(f, 1600, 0.85);
          if (!s.glassBg) s.glassBg = {};
          s.glassBg.imageDataUrl = dataUrl;
          s.glassBg.type = 'image';
          applySkin();
          pushState();
          renderSettingsAppearance(view);
        } catch (e) { showToast('图片处理失败:' + (e && e.message || e)); }
      }
      try { document.body.removeChild(inp); } catch (_) {}
    });
    inp.click();
  });
  view.querySelectorAll('[data-action="glass-image-clear"]').forEach(b => b.onclick = () => {
    if (s.glassBg) delete s.glassBg.imageDataUrl;
    applySkin();
    pushState();
    renderSettingsAppearance(view);
  });
}

function renderSettingsSystem(view) {
  const order = getMobileTabOrder();
  const hidden = getMobileTabHiddenSet();
  const rowsHtml = order.map(id => {
    const t = TAB_DEFS[id];
    const isFixed = id === 'settings';
    const isHidden = hidden.has(id);
    return `<div class="tab-order-row ${isFixed?'is-fixed':''} ${isHidden?'is-hidden':''}" data-tab="${id}">
      <span class="tab-order-handle ${isFixed?'is-disabled':''}" aria-hidden="${isFixed?'true':'false'}"><span class="ico-grip"></span></span>
      <span class="tab-order-icon ${t.icon}"></span>
      <span class="tab-order-label">${esc(t.label)}</span>
      ${isFixed
        ? `<span class="tab-order-fixed-tag">固定最右</span>`
        : `<button class="tab-order-toggle ${isHidden?'is-off':'is-on'}" data-action="toggle-tab-visible" data-tab-id="${id}">${isHidden?'已隐藏':'显示中'}</button>`}
    </div>`;
  }).join('');
  view.innerHTML = `
    <div class="settings-sub-title">底部 tab</div>
    <div class="settings-hint">长按 ☰ 拖拽重新排序;开关控制是否显示。设置永远固定在最右</div>
    <div class="tab-order-list" id="tab-order-list">${rowsHtml}</div>
    <div class="settings-sub-title" style="margin-top:24px;">版本</div>
    <div class="settings-version-row">
      <span class="settings-version-label">移动端构建</span>
      <span class="settings-version-value">${esc(_PSFOCUS_BUILD || '未知')}</span>
    </div>
  `;
  bindTabOrderDrag(view.querySelector('#tab-order-list'), view);
  view.querySelectorAll('[data-action="toggle-tab-visible"]').forEach(b => b.onclick = () => {
    const id = b.dataset.tabId;
    if (id === 'settings') return;
    const set = new Set(state.settings.mobileTabHidden || []);
    if (set.has(id)) set.delete(id); else set.add(id);
    state.settings.mobileTabHidden = Array.from(set);
    pushState();
    renderSettingsSystem(view);
    renderTabBar();
  });
}

// 触摸 / 鼠标 拖拽排序
function bindTabOrderDrag(list, view) {
  if (!list) return;
  let dragRow = null, startY = 0, dragging = false;

  function commitOrder() {
    const order = Array.from(list.querySelectorAll('.tab-order-row')).map(r => r.dataset.tab);
    state.settings.mobileTabOrder = order;
    pushState();
    renderTabBar();
  }
  function clientY(e) { return e.touches ? e.touches[0].clientY : e.clientY; }
  function onStart(e) {
    const handle = (e.target instanceof Element) && e.target.closest('.tab-order-handle');
    if (!handle || handle.classList.contains('is-disabled')) return;
    const row = handle.closest('.tab-order-row');
    if (!row || row.classList.contains('is-fixed')) return;
    e.preventDefault();
    dragRow = row;
    startY = clientY(e);
    dragging = false;
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onEnd);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onEnd);
  }
  function onMove(e) {
    if (!dragRow) return;
    const y = clientY(e);
    if (!dragging) {
      if (Math.abs(y - startY) < 4) return;
      dragging = true;
      dragRow.classList.add('dragging');
    }
    if (e.cancelable) e.preventDefault();
    const rows = Array.from(list.querySelectorAll('.tab-order-row'));
    for (const r of rows) {
      if (r === dragRow || r.classList.contains('is-fixed')) continue;
      const rect = r.getBoundingClientRect();
      if (y < rect.top || y > rect.bottom) continue;
      const before = (y - rect.top) < (rect.height / 2);
      const ref = before ? r : r.nextSibling;
      if (ref !== dragRow && ref !== dragRow.nextSibling) list.insertBefore(dragRow, ref);
      break;
    }
  }
  function onEnd() {
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onEnd);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onEnd);
    if (!dragRow) return;
    dragRow.classList.remove('dragging');
    if (dragging) commitOrder();
    dragRow = null; dragging = false;
  }
  list.addEventListener('touchstart', onStart, { passive: false });
  list.addEventListener('mousedown',  onStart);
}

function renderSettingsTemplates(view) {
  const all = state.templates || [];
  const groups = [
    { kind: 'task',    label: '任务模板', icon: 'ico-folder' },
    { kind: 'event',   label: '事件模板', icon: 'ico-calendar' },
    { kind: 'project', label: '项目模板', icon: 'ico-template' },
  ];
  let html = '';
  for (const g of groups) {
    const list = all.filter(t => t.kind === g.kind);
    if (!list.length) continue;
    html += `<div class="settings-sub-title">${esc(g.label)} · ${list.length}</div>`;
    html += '<div class="tmpl-list">';
    for (const tmpl of list) {
      const sub = tmpl.payload && Array.isArray(tmpl.payload.subtasks) ? tmpl.payload.subtasks.length : 0;
      const tagCnt = tmpl.payload && Array.isArray(tmpl.payload.tags) ? tmpl.payload.tags.length : 0;
      const meta = [];
      if (sub) meta.push(`${sub} 个子任务`);
      if (tagCnt) meta.push(`${tagCnt} 个标签`);
      if (tmpl.payload && tmpl.payload.duration) meta.push(`${Math.round(tmpl.payload.duration/60000)} 分钟`);
      html += `<button class="tmpl-row" data-action="edit-template" data-tmpl-id="${esc(tmpl.id)}">
        <span class="tmpl-row-icon ${g.icon}"></span>
        <span class="tmpl-row-body">
          <span class="tmpl-row-title">${esc(tmpl.name || '未命名模板')}</span>
          ${meta.length ? `<span class="tmpl-row-meta">${esc(meta.join(' · '))}</span>` : ''}
        </span>
        <span class="tmpl-row-arrow ico-chevron-right"></span>
      </button>`;
    }
    html += '</div>';
  }
  if (!html) {
    html = `<div class="settings-hint" style="padding:32px 18px; text-align:center;">还没有模板。<br>在任务详情菜单里选「保存为模板」创建第一个。</div>`;
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-action="edit-template"]').forEach(b => b.onclick = () => openTemplateEditSheet(b.dataset.tmplId));
}

function openTemplateEditSheet(id) {
  const tmpl = (state.templates || []).find(x => x.id === id);
  if (!tmpl) return;
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 6px;">编辑模板</div>
      <div class="form-row"><label>名称</label><input type="text" id="tmpl-edit-name" value="${esc(tmpl.name || '')}" maxlength="60"></div>
      <div class="settings-hint" style="padding:8px 0 0;">类型:${tmpl.kind === 'task' ? '任务' : tmpl.kind === 'event' ? '事件' : '项目'} · 创建于 ${new Date(tmpl.createdAt || 0).toLocaleDateString('zh-CN')}</div>
    </div>
    <div class="sheet-actions">
      <button data-action="delete" class="danger">删除</button>
      <button data-action="cancel">取消</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    const inp = body.querySelector('#tmpl-edit-name');
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      const name = inp.value.trim();
      if (!name) return;
      tmpl.name = name;
      pushState();
      closeSheet();
      const view = elView();
      if (ui.tab === 'settings' && ui.settingsPage === 'templates') renderSettingsTemplates(view);
    };
    body.querySelector('[data-action="delete"]').onclick = () => {
      if (!confirm(`删除模板「${tmpl.name || '未命名'}」?此操作不可撤销。`)) return;
      state.templates = (state.templates || []).filter(x => x.id !== id);
      pushState();
      closeSheet();
      const view = elView();
      if (ui.tab === 'settings' && ui.settingsPage === 'templates') renderSettingsTemplates(view);
    };
  });
}

function renderSettingsAccount(view) {
  view.innerHTML = `
    <div class="card-list">
      <div class="card"><div class="card-body">
        <div class="card-title">${esc(uid || '未登录')}</div>
        <div class="card-meta">已与桌面端云同步</div>
      </div></div>
      <div class="card" data-action="logout"><div class="card-body">
        <div class="card-title" style="color:var(--danger);">退出登录</div>
      </div></div>
    </div>
  `;
  view.querySelector('[data-action="logout"]').onclick = async () => {
    if (!confirm('确定退出登录?')) return;
    _clearCreds();          // 主动登出 → 清凭证,避免下次启动自动登回去
    // 加长冷却到 1 小时,期间不允许自动重登(用户明确想退出)
    _autoReloginCooldownUntil = Date.now() + 3600 * 1000;
    try { await auth.signOut(); } catch (_) {}
  };
}

function renderSettingsAbout(view) {
  view.innerHTML = `
    <div class="card-list">
      <div class="card"><div class="card-body">
        <div class="card-title">PS Focus Mobile</div>
        <div class="card-meta">桌面端数据通过腾讯云开发同步</div>
      </div></div>
    </div>
  `;
}

// =========================================================
// ===== FAB / 新建任务 =====
// =========================================================
// 新建项目 / 任务清单 / 文件夹
function openCreateProjectSheet() {
  const folders = (state.folders || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  // 帮 select 选项做 kind 标签 — 没设 kind 的老 folder 默认当 'project'
  const folderKindOf = (f) => f.kind || 'project';
  const projectFolders  = folders.filter(f => folderKindOf(f) === 'project');
  const tasklistFolders = folders.filter(f => folderKindOf(f) === 'tasklist');
  const folderOpts = (list) => `<option value="">未分组</option>` + list.map(f => `<option value="${esc(f.id)}">${esc(f.name || '未命名')}</option>`).join('');
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 12px;">新建</div>
      <div class="form-row"><label>类型</label>
        <select id="cp-kind">
          <option value="project" selected>项目</option>
          <option value="tasklist">任务清单</option>
          <option value="folder">文件夹</option>
        </select>
      </div>
      <div class="form-row" style="margin-top:8px;"><label>名称</label>
        <input type="text" id="cp-name" placeholder="名称" maxlength="40">
      </div>
      <div class="form-row" id="cp-folder-row" style="margin-top:8px;">
        <label>所属文件夹</label>
        <select id="cp-folder"></select>
      </div>
      <!-- 仅在 kind=folder 时显示:文件夹自己的分类 -->
      <div class="form-row" id="cp-folder-kind-row" style="margin-top:8px;display:none;">
        <label>文件夹类型</label>
        <select id="cp-folder-kind">
          <option value="project" selected>项目文件夹</option>
          <option value="tasklist">任务清单文件夹</option>
        </select>
      </div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button class="primary" data-action="save">创建</button>
    </div>
  `, (body) => {
    const nameEl = body.querySelector('#cp-name');
    const kindEl = body.querySelector('#cp-kind');
    const folderRow = body.querySelector('#cp-folder-row');
    const folderKindRow = body.querySelector('#cp-folder-kind-row');
    const folderSelect = body.querySelector('#cp-folder');
    // 根据当前 kind 切 folder 下拉里的选项 + 显隐
    const refreshFolderSelect = () => {
      const k = kindEl.value;
      if (k === 'folder') {
        folderRow.style.display = 'none';
        folderKindRow.style.display = '';
      } else {
        folderKindRow.style.display = 'none';
        // project 类型只显示项目文件夹,tasklist 类型只显示清单文件夹
        const list = (k === 'tasklist') ? tasklistFolders : projectFolders;
        folderSelect.innerHTML = folderOpts(list);
        folderRow.style.display = list.length ? '' : 'none';
      }
    };
    refreshFolderSelect();
    kindEl.onchange = refreshFolderSelect;
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      const name = nameEl.value.trim();
      if (!name) { showToast('请输入名称'); return; }
      const kind = kindEl.value;
      const folderId = (kind === 'folder') ? null : (folderSelect.value || null);
      if (kind === 'folder') {
        const folderKind = body.querySelector('#cp-folder-kind').value || 'project';
        const maxOrder = (state.folders || []).reduce((m, x) => Math.max(m, x.order || 0), 0);
        state.folders.push({
          id: 'f-' + Math.random().toString(36).slice(2, 10),
          name, color: '', icon: '', order: maxOrder + 100,
          kind: folderKind,   // 'project' | 'tasklist' — 决定它出现在哪个 section + 哪些 item 能挂进来
          createdAt: Date.now(), updatedAt: Date.now(),
        });
      } else {
        const maxOrder = (state.projects || []).reduce((m, x) => Math.max(m, x.order || 0), 0);
        const newId = 'p-' + Math.random().toString(36).slice(2, 10);
        state.projects.push({
          id: newId,
          name, color: '', icon: '',
          kind,                              // 'project' | 'tasklist'
          folderId,
          pinned: false, archived: false,
          dueStart: null, dueEnd: null,
          payment: { value: 0, unit: 'none', currencyId: 'CNY' },
          clientName: '', clientContact: '', note: '',
          tags: [], kanbanColumns: ['未开始', '进行中', '已完成'],
          filePatterns: [], referenceImages: [], timeline: [],
          sortMode: 'custom', groupMode: 'custom',
          hideCompleted: false, viewMode: 'list',
          order: maxOrder + 100,
          createdAt: Date.now(), updatedAt: Date.now(),
        });
        // 创建后自动跳转进去
        ui.selectedKind = 'project';
        ui.selectedId = newId;
      }
      pushState();
      closeSheet();
      saveUI();
      renderAll();
      if (document.getElementById('drawer-nav').classList.contains('open')) renderDrawerNav();
    };
  });
}

// 切换任务所属:popover 列出所有项目/清单(按抽屉同款排序),选了 callback
function openProjectPicker(currentProjectId, anchor, onPick) {
  const items = [];
  items.push({ sectionTitle: '清单' });
  // inbox / 收件箱(无项目)
  items.push({
    label: '收件箱(未分类)',
    icon: 'ico-inbox',
    action: () => { closePopover(); onPick(null); },
  });
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
  // 项目/清单图标:自定义 SVG > 项目色点 > fallback 类名(清单 ico-list / 项目 ico-folder)
  const buildIconHtml = (p, fallbackClass) => {
    const custom = p.icon ? renderCustomIconHtml(p.icon, '', p.color || '') : null;
    if (custom) return custom;
    if (p.color) return `<span class="nav-icon color-dot" style="background:${esc(p.color)}"></span>`;
    return `<span class="${fallbackClass}"></span>`;
  };
  // 任务清单
  const tasklists = (state.projects || []).filter(p => !p.archived && p.kind === 'tasklist').slice().sort(byOrder);
  if (tasklists.length) {
    items.push({ divider: true });
    items.push({ sectionTitle: '任务清单' });
    for (const p of tasklists) {
      items.push({
        label: (p.id === currentProjectId ? '✓ ' : '') + (p.name || '未命名'),
        iconHtml: buildIconHtml(p, 'ico-list'),
        action: () => { closePopover(); onPick(p.id); },
      });
    }
  }
  // 项目(按抽屉:置顶 → 文件夹 → 未分组)
  const activeProjects = (state.projects || []).filter(p => !p.archived && (p.kind || 'project') === 'project').slice().sort(byOrder);
  const folderIds = new Set((state.folders || []).map(f => f.id));
  const pinned = activeProjects.filter(p => p.pinned);
  const ungrouped = activeProjects.filter(p => !p.pinned && (!p.folderId || !folderIds.has(p.folderId)));
  const projItem = (p) => ({
    label: (p.id === currentProjectId ? '✓ ' : '') + (p.name || '未命名'),
    iconHtml: buildIconHtml(p, 'ico-folder'),
    action: () => { closePopover(); onPick(p.id); },
  });
  if (pinned.length) {
    items.push({ divider: true });
    items.push({ sectionTitle: '已置顶项目' });
    for (const p of pinned) items.push(projItem(p));
  }
  for (const f of (state.folders || []).slice().sort(byOrder)) {
    const inFolder = activeProjects.filter(p => !p.pinned && p.folderId === f.id);
    if (!inFolder.length) continue;
    items.push({ divider: true });
    items.push({ sectionTitle: f.name || '未命名文件夹' });
    for (const p of inFolder) items.push(projItem(p));
  }
  if (ungrouped.length) {
    items.push({ divider: true });
    items.push({ sectionTitle: '未分组项目' });
    for (const p of ungrouped) items.push(projItem(p));
  }
  showPopover(items, { anchor });
}

function openCreateTaskSheet(opts) {
  opts = opts || {};
  const cl = getCurrentList();
  // 默认项目:当前清单是 project/tasklist 才挂;否则 null。可由项目 pill 切换
  let pickedProjectId = cl.kind === 'project' ? cl.project?.id : null;

  // 时间默认值:opts.startTs / endTs(精确时刻,从时间轴拖拽来)优先;否则按选中日 9:00
  // 兼容老 opts.startDay/endDay(日期,从月视图拖拽来)
  let startTs = opts.startTs || null;
  let endTs   = opts.endTs   || null;
  let allDayDefault = false;
  if (!startTs) {
    const startDay = opts.startDay || (ui.tab === 'calendar' ? (ui.calSelectedDay || ui.calCursor) : null);
    const endDay   = opts.endDay   || startDay;
    if (startDay) {
      startTs = combineDateAndTime(tsToDateInput(startDay), '09:00');
      const isRange = endDay && startOfDay(new Date(endDay)).getTime() !== startOfDay(new Date(startDay)).getTime();
      endTs = isRange ? combineDateAndTime(tsToDateInput(endDay), '17:00') : null;
      allDayDefault = true;
    }
  }
  // 用 schedule 形式持有(对齐桌面)
  let sched = startTs ? {
    id: 'sl-' + Math.random().toString(36).slice(2, 10),
    kind: (endTs && endTs > startTs) ? 'range' : 'date',
    start: startTs,
    end: endTs || undefined,
    allDay: allDayDefault,
    repeat: 'none',
    reminderOffset: null,
  } : null;

  function schedPillHtml() {
    if (!sched) return '';
    return `<span class="dp-sched-pill">
      <span class="ico-clock"></span>
      <span class="dp-sched-text">${esc(fmtSchedule(sched))}</span>
      <button class="dp-sched-x" data-action="qe-remove-sched" title="删除时间">×</button>
    </span>`;
  }

  function projPillHtml() {
    const p = pickedProjectId ? state.projects.find(x => x.id === pickedProjectId) : null;
    const c = p ? (p.color || '') : '';
    const lbl = p ? (p.name || '未命名') : '收件箱';
    return `${c ? `<span class="dp-project-dot" style="background:${esc(c)}"></span>` : '<span class="ico-folder"></span>'}<span>${esc(lbl)}</span>`;
  }

  showSheet(`
    <div class="sheet-handle"></div>
    <div class="dp-detail">
      <div class="dp-time-bar" id="qe-time-bar">
        ${schedPillHtml()}
        <button class="dp-add-sched-btn" data-action="qe-add-sched" title="${sched ? '改时间' : '加时间'}">
          <span class="ico-calendar"></span>
        </button>
      </div>
      <div class="dp-title-row">
        <button class="dp-check" id="qe-check" title="创建为已完成"></button>
        <input type="text" class="dp-title-input" id="qe-title">
      </div>
      <div class="dp-section dp-merged-section">
        <textarea class="dp-note-input" id="qe-note" rows="3"></textarea>
        <div class="dp-merged-row">
          <div class="dp-merged-tags"></div>
          <label class="dp-merged-add-img" title="上传图片">
            <input type="file" accept="image/*" multiple id="qe-img-input" hidden>
            <span class="ico-image"></span>
          </label>
        </div>
        <div id="qe-img-list" class="dp-image-grid" style="min-height:0;"></div>
      </div>
      <div class="dp-section">
        <div class="dp-section-title">子待办 <span class="dp-section-count" id="qe-sub-count">0</span></div>
        <div class="dp-sub-add">
          <input type="text" class="dp-sub-add-input" id="qe-sub-add">
        </div>
        <ul class="dp-sub-list" id="qe-sub-list"></ul>
      </div>
    </div>
    <div class="dp-footer">
      <button class="dp-project-pill" id="qe-proj-pill" data-action="qe-pick-project">${projPillHtml()}</button>
      <button class="dp-more-btn" data-action="qe-more" title="更多"><span class="ico-more"></span></button>
      <button class="dp-more-btn dp-more-btn-primary" data-action="save" title="保存"><span class="ico-check"></span></button>
    </div>
  `, (body) => {
    const titleEl = body.querySelector('#qe-title');
    const noteEl  = body.querySelector('#qe-note');
    const imgList = body.querySelector('#qe-img-list');
    // 暂存待上传成功的图(创建时再写到 task.images)
    const pendingImages = [];
    // 暂存子待办 + 完成状态(创建时再落库)
    const pendingSubs = [];
    let pendingDone = false;
    const refreshImgs = () => {
      imgList.innerHTML = pendingImages.map(im => `
        <div class="dp-image-cell" data-img-id="${esc(im.id)}">
          <img class="dp-image" data-cloud-file-id="${esc(im.cloudFileID)}" alt="${esc(im.name||'')}" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=">
          <button class="dp-image-del" data-img-id="${esc(im.id)}" title="删除">×</button>
        </div>
      `).join('');
      // 异步换 src
      bindCloudTimelineImages(imgList);
      // 删除按钮
      imgList.querySelectorAll('.dp-image-del').forEach(b => b.onclick = (ev) => {
        ev.stopPropagation();
        const i = pendingImages.findIndex(x => x.id === b.dataset.imgId);
        if (i >= 0) { pendingImages.splice(i, 1); refreshImgs(); }
      });
    };
    body.querySelector('#qe-img-input').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      if (!tcbApp || !uid) { showToast('未登录,不能上传'); return; }
      showToast(`上传 ${files.length} 张图…`);
      for (const f of files) {
        try {
          const cloudPath = `psfocus-task-images/${uid}/_pending/${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const res = await tcbApp.uploadFile({ cloudPath, filePath: f });
          const fid = res && res.fileID;
          if (fid) pendingImages.push({ id: 'img-' + Math.random().toString(36).slice(2, 10), cloudFileID: fid, name: f.name, uploadedAt: Date.now() });
        } catch (err) { console.warn('[qe-upload]', err); }
      }
      e.target.value = '';
      refreshImgs();
    });
    // 同步 focus(仍在 FAB / 拖拽点击手势内)→ iOS 打开抽屉即自动弹键盘,不用再点一下标题框
    titleEl.focus();

    // 标题勾选框 — 点一下 = 创建为已完成
    const checkBtn = body.querySelector('#qe-check');
    checkBtn.onclick = () => {
      pendingDone = !pendingDone;
      checkBtn.classList.toggle('done', pendingDone);
      checkBtn.textContent = pendingDone ? '✓' : '';
      titleEl.classList.toggle('done', pendingDone);
    };

    // 子待办 — 创建时就能加,保存时一并落库为独立 task(parentTaskId)
    const subList = body.querySelector('#qe-sub-list');
    const subCount = body.querySelector('#qe-sub-count');
    const refreshSubs = () => {
      subCount.textContent = pendingSubs.length;
      subList.innerHTML = pendingSubs.map(s => `
        <li class="dp-sub ${s.done ? 'done' : ''}" data-sub-id="${esc(s.id)}">
          <button class="dp-sub-check ${s.done ? 'done' : ''}" data-qe-sub-toggle="${esc(s.id)}">${s.done ? '✓' : ''}</button>
          <span class="dp-sub-title">${esc(s.title)}</span>
          <button class="dp-sub-del" data-qe-sub-del="${esc(s.id)}" title="删除">×</button>
        </li>`).join('');
      subList.querySelectorAll('[data-qe-sub-toggle]').forEach(b => b.onclick = () => {
        const s = pendingSubs.find(x => x.id === b.dataset.qeSubToggle);
        if (s) { s.done = !s.done; refreshSubs(); }
      });
      subList.querySelectorAll('[data-qe-sub-del]').forEach(b => b.onclick = () => {
        const i = pendingSubs.findIndex(x => x.id === b.dataset.qeSubDel);
        if (i >= 0) { pendingSubs.splice(i, 1); refreshSubs(); }
      });
    };
    const subAddEl = body.querySelector('#qe-sub-add');
    subAddEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = subAddEl.value.trim();
      if (!v) return;
      pendingSubs.push({ id: genId('t'), title: v, done: false });
      subAddEl.value = '';
      refreshSubs();
    });

    function refreshSchedRow() {
      const bar = body.querySelector('#qe-time-bar');
      bar.innerHTML = `
        ${schedPillHtml()}
        <button class="dp-add-sched-btn" data-action="qe-add-sched" title="${sched ? '改时间' : '加时间'}">
          <span class="ico-calendar"></span>
        </button>`;
      bindBarHandlers();
    }
    function bindBarHandlers() {
      const xBtn = body.querySelector('[data-action="qe-remove-sched"]');
      if (xBtn) xBtn.onclick = () => { sched = null; refreshSchedRow(); };
      const addBtn = body.querySelector('[data-action="qe-add-sched"]');
      if (addBtn) addBtn.onclick = () => openQuickTimePickerSheet(sched, (newSched) => {
        sched = newSched;
        refreshSchedRow();
      });
    }
    bindBarHandlers();

    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="qe-pick-project"]').onclick = (ev) => {
      ev.stopPropagation();
      openProjectPicker(pickedProjectId, ev.currentTarget, (newPid) => {
        pickedProjectId = newPid;
        body.querySelector('#qe-proj-pill').innerHTML = projPillHtml();
      });
    };
    // 更多菜单 — 含「从模板创建」
    body.querySelector('[data-action="qe-more"]').onclick = (ev) => {
      ev.stopPropagation();
      const menuItems = [];
      // task / event 模板都能用来建任务
      const hasUsable = (state.templates || []).some(t => t.kind === 'task' || t.kind === 'event');
      if (hasUsable) {
        menuItems.push({ label: '从模板创建', icon: 'ico-template', action: () => {
          closePopover();
          // 把当前 sheet 的时间槽 + 项目带过去,模板套到拖出来的时间上,而不是回退到默认时间
          const carryStart = sched && Number.isFinite(sched.start) ? sched.start : undefined;
          const carryEnd   = sched && Number.isFinite(sched.end)   ? sched.end   : undefined;
          const carryProj  = pickedProjectId || undefined;
          closeSheet();
          openCreateFromTemplatePicker({ startTs: carryStart, endTs: carryEnd, projectId: carryProj });
        }});
      } else {
        menuItems.push({ label: '从模板创建(暂无可用模板)', icon: 'ico-template', disabled: true });
      }
      showPopover(menuItems, { anchor: ev.currentTarget });
    };
    const save = () => {
      const title = titleEl.value.trim();
      if (!title) { closeSheet(); return; }
      const note = noteEl ? noteEl.value : '';
      // 从 note 解析 #tag(对齐摘要/详情的 tag 行为)
      const tags = [];
      const tagRe = /#([^\s#,。、,]+)/g;
      let mm;
      while ((mm = tagRe.exec(note)) !== null) {
        const tg = mm[1].trim();
        if (tg && !tags.includes(tg)) tags.push(tg);
      }
      const startMs = sched && sched.start || null;
      const endMs   = sched && sched.end   || null;
      // 字段对齐桌面 sanitize 期望(同 applyTaskTemplate 那条 path),
      // 缺 doneAt / color / images 会让桌面端把这条 task 过滤掉或渲染异常 — 之前漏了
      const newTask = {
        id: genId('t'),
        title,
        note,
        done: pendingDone,
        doneAt: pendingDone ? Date.now() : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectId: pickedProjectId || null,
        parentTaskId: null,
        parentEventId: null,
        dueAt: startMs,
        start:  startMs,
        end:    endMs && endMs > startMs ? endMs : null,
        allDay: sched ? !!sched.allDay : false,
        color: '',
        tags,
        subtasks: [],
        schedules: sched ? [sched] : [],
        images: [],
        completedOccurrences: [],
        kanbanColumn: null,
        order: 100,
      };
      newTask.images = pendingImages.slice();
      state.tasks.push(newTask);
      // 子待办 → 独立 task + parentTaskId(对齐详情/桌面模型)
      let subOrder = 100;
      for (const s of pendingSubs) {
        state.tasks.push({
          id: s.id,
          title: s.title,
          note: '',
          done: !!s.done,
          doneAt: s.done ? Date.now() : null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          projectId: newTask.projectId,
          parentTaskId: newTask.id,
          parentEventId: null,
          dueAt: null, start: null, end: null,
          allDay: false,
          color: '',
          tags: [],
          subtasks: [],
          schedules: [],
          images: [],
          completedOccurrences: [],
          kanbanColumn: null,
          order: subOrder,
        });
        subOrder += 100;
      }
      pushState(); closeSheet(); renderAll();
    };
    body.querySelector('[data-action="save"]').onclick = save;
    titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  });
}

// 简易时间选择 sheet — 改/加 schedule(只设第一个,不做多 schedule 编辑)
function openQuickTimePickerSheet(currentSched, onSave) {
  const now = currentSched && currentSched.start ? new Date(currentSched.start) : new Date();
  const allDay = currentSched ? !!currentSched.allDay : false;
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const endTs = currentSched && currentSched.end || null;
  const endStr = endTs ? `${pad(new Date(endTs).getHours())}:${pad(new Date(endTs).getMinutes())}` : '';
  const repeat = currentSched ? (currentSched.repeat || 'none') : 'none';
  const repeatOpts = [
    { v: 'none', l: '不重复' },
    { v: 'daily', l: '每天' },
    { v: 'weekly', l: '每周' },
    { v: 'monthly', l: '每月' },
    { v: 'workday', l: '工作日' },
  ];
  showSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-content">
      <div class="section-title" style="padding:0 0 12px;">设置时间</div>
      <div class="form-row"><label>日期</label><input type="date" id="qt-date" value="${esc(dateStr)}"></div>
      <div class="form-row" style="margin-top:8px;"><label>开始</label><input type="time" id="qt-start" value="${esc(timeStr)}" ${allDay?'disabled':''}></div>
      <div class="form-row" style="margin-top:8px;"><label>结束</label><input type="time" id="qt-end" value="${esc(endStr)}" placeholder="可选" ${allDay?'disabled':''}></div>
      <div class="form-row" style="margin-top:8px;"><label>全天</label><label class="form-toggle"><input type="checkbox" id="qt-allday" ${allDay?'checked':''}><span></span></label></div>
      <div class="form-row" style="margin-top:8px;"><label>重复</label>
        <select id="qt-repeat">
          ${repeatOpts.map(o => `<option value="${o.v}" ${o.v===repeat?'selected':''}>${o.l}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="sheet-actions">
      <button data-action="cancel">取消</button>
      <button class="primary" data-action="save">保存</button>
    </div>
  `, (body) => {
    const allDayEl = body.querySelector('#qt-allday');
    const startEl = body.querySelector('#qt-start');
    const endEl = body.querySelector('#qt-end');
    allDayEl.onchange = () => { startEl.disabled = endEl.disabled = allDayEl.checked; };
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      const dStr = body.querySelector('#qt-date').value;
      const sStr = body.querySelector('#qt-start').value;
      const eStr = body.querySelector('#qt-end').value;
      const ad = allDayEl.checked;
      const rp = body.querySelector('#qt-repeat').value;
      if (!dStr) { closeSheet(); onSave(null); return; }
      const startMs = combineDateAndTime(dStr, ad ? '' : (sStr || '09:00'));
      let endMs = null;
      if (!ad && eStr) endMs = combineDateAndTime(dStr, eStr);
      const newSched = {
        id: (currentSched && currentSched.id) || ('sl-' + Math.random().toString(36).slice(2, 10)),
        kind: (endMs && endMs > startMs) ? 'range' : 'date',
        start: startMs,
        end: endMs || undefined,
        allDay: ad,
        repeat: rp,
        reminderOffset: null,
      };
      closeSheet();
      onSave(newSched);
    };
  });
}

// =========================================================
// ===== 全局事件绑定 =====
// =========================================================
function bindGlobalEvents() {
  $('topbar-left-btn').addEventListener('click', () => {
    if (ui.tab === 'calendar') openCalendarModeSwitcher();
    else if (ui.tab === 'ledger') openLedgerViewSwitcher();
    else if (ui.tab === 'settings' && ui.settingsPage) { ui.settingsPage = null; renderAll(); }
    else openDrawerNav();
  });
  $('topbar-right-btn').addEventListener('click', () => {
    if (ui.tab === 'tasks') openListMoreMenu();
    else if (ui.tab === 'calendar') openCalendarMoreMenu();
    else if (ui.tab === 'works') openWorksSortMenu($('topbar-right-btn'));
    else if (ui.tab === 'summary') {
      summaryState.searchOpen = !summaryState.searchOpen;
      if (!summaryState.searchOpen) summaryState.searchQuery = '';
      renderAll();
    }
  });
  // 第二个右上按钮 — 项目 tab:点击直接切换列表/相册视图(无菜单)
  $('topbar-right-btn2').addEventListener('click', () => {
    if (ui.tab === 'works') {
      setWorksUiPref({ view: worksState.view === 'gallery' ? 'list' : 'gallery' });
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.dataset && t.dataset.action === 'close-drawer-nav') closeDrawerNav();
    if (t.dataset && t.dataset.action === 'close-drawer-right') closeCalendarSidebar();
    if (t.dataset && t.dataset.action === 'close-popover') closePopover();
    if (t.dataset && t.dataset.action === 'close-sheet') closeSheet();
  });
  // tab bar 由 renderTabBar 自带 click handler,这里不再重复绑定
  // FAB 短按 = 新建任务;长按 = 从模板创建
  (function bindFab() {
    const fab = $('fab');
    let timer = null, longPressed = false;
    function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
    function start() {
      longPressed = false;
      clearTimer();
      timer = setTimeout(() => {
        if (ui.tab === 'summary' || ui.tab === 'ledger') return;   // 这些 tab 的 FAB 无长按动作
        longPressed = true;
        try { navigator.vibrate && navigator.vibrate(15); } catch (_) {}
        if ((state.templates || []).some(t => t.kind === 'task' || t.kind === 'event')) {
          openCreateFromTemplatePicker();
        } else {
          showToast('还没有可用模板,在桌面端创建后会同步过来');
        }
      }, 450);
    }
    function cancel() { clearTimer(); }
    fab.addEventListener('touchstart', start, { passive: true });
    fab.addEventListener('touchend',   cancel, { passive: true });
    fab.addEventListener('touchmove',  cancel, { passive: true });
    fab.addEventListener('touchcancel', cancel, { passive: true });
    fab.addEventListener('mousedown',  start);
    fab.addEventListener('mouseup',    cancel);
    fab.addEventListener('mouseleave', cancel);
    fab.addEventListener('click', (e) => {
      if (longPressed) { e.preventDefault(); e.stopPropagation(); longPressed = false; return; }
      if (ui.tab === 'summary') openSummaryInputSheet();
      else if (ui.tab === 'ledger') openLedgerAddSheet();
      else openCreateTaskSheet();
    });
  })();
  // 顶部标题点击:日历 tab 时回今日
  $('topbar-title').parentElement.addEventListener('click', () => {
    if (ui.tab === 'calendar') {
      ui.calCursor = Date.now();
      ui.calSelectedDay = startOfDay(new Date()).getTime();
      saveUI(); renderAll();
    }
  });
  // 切回前台 / 切到后台 — visibilitychange 处理:
  //   - 后台时:主动关 watcher(WebSocket)→ 让页面 BFCache 资格成立,iOS 不会强制 reload
  //   - 前台时:重启 watcher + 拉一次 state
  // 节流版避免 visibilitychange 风暴(iOS 切换 / 键盘弹出都会触发)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      // 切到后台 — 关掉 WebSocket。BFCache 不允许开放 WS;关了之后 iOS / Chrome 能把 tab 整个冷冻起来
      // 切回前台时再 reopen(下面的 visible 分支)。即使 iOS 没用 BFCache,关 WS 也省电
      try { stopWatch(); } catch (_) {}
      return;
    }
    if (!uid || !state) return;
    startWatchThrottled('visibilitychange');
    pullStateOnceThrottled('visibilitychange');
  });
  // BFCache 恢复事件:页面从 BFCache 复原(没触发 load / DOMContentLoaded)。
  // 这时 watcher 一定是关的(上面 hidden 分支关掉的),要重启
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && uid && state) {
      console.log('[bfcache] restored, restart watcher + pull');
      startWatchThrottled('pageshow-bfcache');
      pullStateOnceThrottled('pageshow-bfcache');
    }
  });
  // 网络从断开恢复 → 重启 watcher + 拉一次状态。手机在地铁、电梯进出 / WiFi 切 4G 时常见
  window.addEventListener('online', () => {
    if (!uid || !state) return;
    console.log('[cloud] network online — restart watcher + pull');
    startWatchThrottled('online');
    pullStateOnceThrottled('online');
  });
  // 离线时把同步条标红,用户知道现在不是 app 出问题,是网络断了
  window.addEventListener('offline', () => {
    setSync('error', '网络断开,等待恢复…');
  });
}

// iOS / Android 软键盘弹起时把 sheet 上移,避免输入框被遮
// visualViewport.height 在键盘弹起时会变小(键盘占用部分);用 window.innerHeight - vv.height 算键盘高度
// 是否独立 PWA(加到主屏)运行 — 此时没有浏览器返回手势
const _PSF_STANDALONE = window.navigator.standalone === true
  || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

// ===== 任务页左边缘右拉 → 呼出 drawer-nav(仅独立 PWA;浏览器内交给下面的历史守卫)=====
(function bindEdgeSwipeDrawer() {
  // 浏览器内 iOS Safari 的「边缘返回」拦不干净 — 改由 bindHistoryGuard 的 popstate 兜底。
  // 这套拖拽手势只在独立 PWA(无浏览器返回)里用,避免和系统返回打架导致抽屉一闪就关。
  if (!_PSF_STANDALONE) return;
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, locked = null;
  let panel = null, drawer = null, mask = null;
  const EDGE_SIZE = 24;
  const OPEN_THRESHOLD = 80;

  function reset(open) {
    dragging = false;
    locked = null;
    if (panel) { panel.style.transition = ''; panel.style.transform = ''; }
    if (mask) mask.style.background = '';
    if (drawer && !open && !drawer.classList.contains('open')) {
      // 没打开 → 加回 hidden(避免遮其它点击)
      setTimeout(() => {
        if (drawer && !drawer.classList.contains('open')) drawer.classList.add('hidden');
      }, 260);
    }
  }
  document.body.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (typeof ui === 'undefined' || ui.tab !== 'tasks') return;
    drawer = document.getElementById('drawer-nav');
    if (!drawer) return;
    if (drawer.classList.contains('open')) return;
    panel = drawer.querySelector('.drawer-panel');
    mask = drawer.querySelector('.drawer-mask');
    if (!panel) return;
    const t = e.touches[0];
    if (t.clientX > EDGE_SIZE) return;
    // 别拦输入 / sheet / popover
    if (e.target.closest && e.target.closest('input, textarea, button, .sheet-body, #sheet, .popover-body')) return;
    startX = t.clientX; startY = t.clientY;
    dx = 0; dy = 0;
    dragging = true; locked = null;
    drawer.classList.remove('hidden');
    panel.style.transition = 'none';
    panel.style.transform = 'translateX(-100%)';
  }, { passive: true });
  document.body.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    dx = t.clientX - startX;
    dy = t.clientY - startY;
    if (locked == null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (locked === 'y') { reset(false); return; }
    // 关键:从左边缘开始的横向拖拽 → preventDefault 吃掉 iOS Safari 的「边缘返回」系统手势,
    // 否则系统返回会和呼出抽屉同时触发(监听器必须 passive:false 才能 preventDefault)
    if (e.cancelable) e.preventDefault();
    if (locked !== 'x' || dx <= 0) return;
    const w = panel.getBoundingClientRect().width || 280;
    const ratio = Math.min(1, dx / w);
    panel.style.transform = `translateX(${(ratio - 1) * 100}%)`;
    if (mask) mask.style.background = `rgba(0, 0, 0, ${0.34 * ratio})`;
  }, { passive: false });
  document.body.addEventListener('touchend', () => {
    if (!dragging) return;
    if (panel) panel.style.transition = '';
    if (mask) mask.style.background = '';
    if (locked === 'x' && dx >= OPEN_THRESHOLD) {
      if (panel) panel.style.transform = '';
      // 走 openDrawerNav 让它 render + 加 open class(rAF)
      if (typeof openDrawerNav === 'function') openDrawerNav();
      else drawer.classList.add('open');
      reset(true);
    } else {
      reset(false);
    }
  });
  document.body.addEventListener('touchcancel', () => reset(false));
})();

// ===== 历史守卫:浏览器内吃掉「边缘返回」,改成关浮层 / 任务页呼出左侧栏 =====
// iOS Safari 的边缘返回是系统手势,preventDefault 拦不住;改用 pushState 守卫:
// 任何「返回」都先弹到守卫条目(不离开 app),由 popstate 接管处理。
(function bindHistoryGuard() {
  if (_PSF_STANDALONE) return;   // 独立 PWA 没有浏览器返回,不需要守卫
  const _t0 = Date.now();
  try { history.pushState({ _psfGuard: 1 }, ''); } catch (_) {}
  window.addEventListener('popstate', () => {
    // 立刻补一个守卫,保证下次返回还被接住,不会真的退出 app
    try { history.pushState({ _psfGuard: 1 }, ''); } catch (_) {}
    if (Date.now() - _t0 < 600) return;   // 忽略加载初期可能的 popstate
    const shown = (id, cls) => {
      const el = document.getElementById(id);
      return el && (cls ? el.classList.contains(cls) : !el.classList.contains('hidden'));
    };
    // 返回 = 先收起最上层浮层
    if (shown('img-lightbox') && typeof closeImageLightbox === 'function') { try { closeImageLightbox(); } catch (_) {} return; }
    if (shown('sheet') && typeof closeSheet === 'function') { try { closeSheet(); } catch (_) {} return; }
    if (shown('popover') && typeof closePopover === 'function') { try { closePopover(); } catch (_) {} return; }
    if (shown('cal-side-drawer', 'open') && typeof closeCalSideDrawer === 'function') { try { closeCalSideDrawer(); } catch (_) {} return; }
    if (shown('drawer-nav', 'open')) { try { closeDrawerNav(); } catch (_) {} return; }
    // 没有浮层:任务页 → 呼出左侧清单栏
    if (typeof ui !== 'undefined' && ui.tab === 'tasks' && typeof openDrawerNav === 'function') {
      try { openDrawerNav(); } catch (_) {}
    }
  });
})();

// ===== 下拉刷新 — 在主 view 顶部下拉超过阈值触发 manualPullState =====
(function bindPullRefresh() {
  const view = document.getElementById('view');
  if (!view) return;
  let indicator = document.getElementById('pull-refresh-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'pull-refresh-indicator';
    indicator.className = 'pull-refresh';
    indicator.innerHTML = `<span class="pull-refresh-arrow"></span><span class="pull-refresh-label">下拉刷新</span>`;
    view.parentElement.insertBefore(indicator, view);
  }
  const THRESHOLD = 130;        // 拉超过这个距离才触发刷新(以前 80 太低,正常滑就过)
  const MAX = 160;
  const TRIGGER_AFTER = 14;     // 第一次明确运动阈值,防短滑误锁
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, locked = null, busy = false;

  function setIndicator(d) {
    const clamped = Math.min(d, MAX);
    indicator.style.transform = `translateY(${clamped - 50}px)`;
    indicator.style.opacity = String(Math.min(1, d / 30));
    // 让整个 view 跟着手指一起下移,看起来像把列表从顶部"拽下来"露出 indicator
    view.style.transform = `translateY(${clamped}px)`;
    const ready = d >= THRESHOLD;
    indicator.classList.toggle('ready', ready);
    const lbl = indicator.querySelector('.pull-refresh-label');
    if (lbl) lbl.textContent = ready ? '松开刷新' : '下拉刷新';
  }
  function reset() {
    indicator.style.transition = 'transform .22s ease, opacity .22s ease';
    view.style.transition = 'transform .22s ease';
    indicator.style.transform = '';
    indicator.style.opacity = '';
    view.style.transform = '';
    setTimeout(() => {
      indicator.style.transition = '';
      view.style.transition = '';
    }, 250);
  }
  view.addEventListener('touchstart', (e) => {
    if (busy) return;
    if (e.touches.length !== 1) return;
    // 只在任务 tab 启用下拉刷新 — 日历/统计/设置 各自有内部滚动容器,view.scrollTop 永远是 0,
    // 不限定 tab 会让日历下拉误触发(cal-week-body 才是真滚动容器)
    if (typeof ui !== 'undefined' && ui.tab !== 'tasks') return;
    // 起手时必须已经在顶部(允许 1px 浮动)— 如果在中间下滑回顶,不会触发
    if (view.scrollTop > 1) return;
    // 不拦输入 / sheet / popover
    if (e.target.closest && e.target.closest('input, textarea, button, .sheet-body, #sheet, .popover-body')) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    dx = 0; dy = 0;
    dragging = true; locked = null;
    indicator.style.transition = 'none';
    view.style.transition = 'none';
  }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    dx = t.clientX - startX;
    dy = t.clientY - startY;
    // 方向锁定:第一次明显运动决定走哪条路
    if (locked == null) {
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax > TRIGGER_AFTER || ay > TRIGGER_AFTER) {
        // 必须明确向下 + 垂直主导,才接管;否则放弃,让 native 处理
        if (dy > 0 && ay > ax) locked = 'pull';
        else { locked = 'cancel'; dragging = false; reset(); return; }
      } else {
        return;
      }
    }
    if (locked !== 'pull' || dy <= 0) return;
    setIndicator(dy);
  }, { passive: true });
  // 第二个 listener:passive: false。
  // 必须从第一次 touchmove 就 preventDefault,否则 Android Chrome 在前 10-15px 内已经启动 native pull-to-reload,
  // 等我们的 locked='pull' 设值再 preventDefault 已经晚了。
  // 条件:dragging(touchstart 已经过 tab/顶部检查) + 向下 + 垂直主导 — 满足才 preventDefault。
  view.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    if (locked === 'cancel') return;
    const t = e.touches[0];
    const _dy = t.clientY - startY;
    const _dx = t.clientX - startX;
    if (_dy > 0 && Math.abs(_dy) >= Math.abs(_dx)) {
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  async function endDrag() {
    if (!dragging) { reset(); return; }
    dragging = false;
    // 只在锁定为 pull 且过阈值才触发刷新;其它情况直接静默
    if (locked === 'pull' && dy >= THRESHOLD) {
      busy = true;
      indicator.classList.remove('ready');
      indicator.classList.add('refreshing');
      indicator.style.transition = 'transform .22s ease';
      view.style.transition = 'transform .22s ease';
      indicator.style.transform = 'translateY(20px)';
      indicator.style.opacity = '1';
      // refreshing 状态下让 view 留在 indicator 下方一段距离,跟手指松开后视觉连贯
      view.style.transform = 'translateY(70px)';
      const lbl = indicator.querySelector('.pull-refresh-label');
      if (lbl) lbl.textContent = '正在同步…';
      let result = 'error';
      try {
        result = await (typeof manualPullState === 'function' ? manualPullState() : 'no-cloud');
      } catch (_) {}
      busy = false;
      indicator.classList.remove('refreshing');
      reset();
      const errSuffix = (typeof _lastSyncErrorMsg === 'string' && _lastSyncErrorMsg) ? (':' + _lastSyncErrorMsg) : '';
      const msg =
        result === 'updated'   ? '已拉取云端更新' :
        result === 'no-change' ? ('已是最新' + (errSuffix && _lastSyncErrorMsg === '云端无 state' ? errSuffix : '')) :
        result === 'no-cloud'  ? ('请先登录或检查网络' + errSuffix) :
                                 ('同步失败' + errSuffix);
      try { showToast && showToast(msg, 4500); } catch (_) {}
    } else {
      reset();
    }
    dy = 0;
  }
  view.addEventListener('touchend', endDrag);
  view.addEventListener('touchcancel', endDrag);
})();

(function bindSheetKeyboardLift() {
  const vv = window.visualViewport;
  if (!vv) return;
  let lastOffset = 0;
  // 算法:每次 apply 都先复原 transform 再测真位置, 算需要 lift 的绝对值, 一次性 set。
  // 不再累加 (旧 0703 的 bug: 多次 vv.resize 期间 lift 滚雪球, 把 sheet 顶部跑出视窗)。
  // (Kayu 2026-05-27 第三次报: 新建/编辑 sheet 一开始输入框完全看不见, 关键盘才能下来)
  let applying = false;
  const apply = () => {
    if (applying) return;
    const sheet = $('sheet');
    if (!sheet || sheet.classList.contains('hidden')) return;
    const body = $('sheet-body');
    if (!body) return;
    const kbHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    const ae = document.activeElement;
    const focused = ae && body.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);

    // 没键盘 或 焦点不在 sheet 里 → 复位
    if (kbHeight < 50 || !focused) {
      if (lastOffset !== 0) {
        applying = true;
        body.style.transition = 'transform .18s ease';
        body.style.transform = '';
        lastOffset = 0;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          body.style.transition = '';
          applying = false;
        }));
      }
      return;
    }

    // 键盘开了 + 焦点在 sheet 里 — 整个 sheet body 上抬一个键盘高度, 让 sheet 底部
    // (= 工具栏底部) 跟键盘 (含 iOS 输入法附加栏) 顶部贴齐, 不留空白。
    // 然后用 scrollIntoView 把焦点元素滚进可视区, 防止被工具栏自身遮住。
    // (Kayu 2026-05-28: 之前用 input rect 计算 lift, 工具栏在 input 下方就被键盘吃掉)
    applying = true;
    const newOffset = -kbHeight;

    if (newOffset === lastOffset) {
      applying = false;
      return;
    }
    body.style.transition = 'transform .18s ease';
    body.style.transform = `translateY(${newOffset}px)`;
    lastOffset = newOffset;
    // 抬完了再把焦点滚进视野 — 工具栏紧贴键盘, focus 通常本来就在工具栏上面所以可见;
    // 不可见的情况 (sheet 很高,focus 被 sheet 内部 scroll 隐藏) scrollIntoView 兜底
    requestAnimationFrame(() => requestAnimationFrame(() => {
      body.style.transition = '';
      applying = false;
      try {
        if (ae && typeof ae.scrollIntoView === 'function') {
          ae.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      } catch (_) {}
    }));
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  // focus/blur 触发 — 键盘可能在 vv 事件之前调起
  document.addEventListener('focusin', () => setTimeout(apply, 80), true);
  document.addEventListener('focusout', () => setTimeout(apply, 80), true);
})();

// 启动
applyTheme();
setupAuth();
bindGlobalEvents();
