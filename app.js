/* =========================================================
   PS Focus Mobile — 完整版(任务/日历/统计/设置)
   ========================================================= */

// ===== 全局错误捕获 =====
function showFatal(msg) {
  const box = document.getElementById('fatal-err');
  const m = document.getElementById('fatal-err-msg');
  if (!box || !m) return;
  m.textContent = String(msg || '未知错误').slice(0, 800);
  box.classList.remove('hidden');
  const auth = document.getElementById('auth-screen');
  if (auth) auth.classList.add('hidden');
  const app = document.getElementById('app');
  if (app) app.classList.add('hidden');
}
window.addEventListener('error', (e) => {
  showFatal((e?.error?.stack) || (e?.message) || 'JS 错误');
});
window.addEventListener('unhandledrejection', (e) => {
  showFatal('未处理的 Promise:' + (e?.reason?.message || e?.reason || ''));
});

// ===== TCB 初始化 =====
if (typeof cloudbase === 'undefined') {
  showFatal('CloudBase SDK 没加载到。检查网络或浏览器是否拦了 static.cloudbase.net。');
  throw new Error('cloudbase undefined');
}
const ENV_ID = 'psfocus-1921-d1g0x0og7e99d5502';
const REGION = 'ap-shanghai';
const COLLECTION = 'user_states';
const tcbApp = cloudbase.init({ env: ENV_ID, region: REGION });
const auth = tcbApp.auth({ persistence: 'local' });
const db = tcbApp.database();

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
  const ts = t.dueAt || t.start;
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

let _autoReloginTried = false;
function _scheduleAutoRelogin() {
  if (_autoReloginTried) return;
  _autoReloginTried = true;
  setTimeout(async () => {
    if (uid) return; // 期间已经登上了
    const creds = _loadCreds();
    if (!creds) return;
    const msg = $('auth-msg');
    if (msg) msg.textContent = '自动重新登录…';
    try {
      await auth.signIn({ username: creds.u, password: creds.p });
      // onLoginStateChanged 会接管(隐藏 auth-screen + bindCloud)
    } catch (e) {
      _clearCreds();
      if (msg) msg.textContent = '凭证失效,请重新登录';
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

// ===== 同步层 =====
function setSync(kind, msg) {
  const bar = $('sync-bar'); if (!bar) return;
  bar.classList.remove('is-syncing','is-error');
  if (kind === 'syncing') bar.classList.add('is-syncing');
  if (kind === 'error')   bar.classList.add('is-error');
  $('sync-text').textContent = msg || '';
  if (kind === 'synced') {
    bar.classList.remove('hidden');
    clearTimeout(setSync._t);
    setSync._t = setTimeout(() => bar.classList.add('hidden'), 1500);
  } else { bar.classList.remove('hidden'); }
}
async function bindCloud() {
  setSync('syncing', '加载中…');
  try {
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'pull', docId: uid } });
    const r = res && res.result;
    const remote = (r && r.ok) ? r.state : null;
    state = remote ? sanitizeState(remote) : emptyState();
    setSync('synced', remote ? '已同步' : '已同步(空)');
  } catch (e) {
    state = emptyState();
    setSync('error', '加载失败,以空数据继续');
    console.error('[bindCloud pull]', e);
  }
  applyAllAppearance();
  renderAll();
  startWatch();
  startPeriodicPull();
  // 拉到云端旧数据后,如果 sanitize 补了缺字段,立刻 push 回去让云端自愈
  // (这样桌面下次拉到的就是补全版本,无需重启 .exe 也能看到旧 mobile 加的任务)
  if (_stateNeedsBackfillPush) {
    _stateNeedsBackfillPush = false;
    setTimeout(() => { try { pushState(); } catch (_) {} }, 1500);
  }
}
function stopWatch() { if (watcher) { try { watcher.close(); } catch(_) {} watcher = null; } }
let _watchReconnectTimer = null;
function _scheduleWatchReconnect() {
  if (_watchReconnectTimer) return;
  _watchReconnectTimer = setTimeout(() => {
    _watchReconnectTimer = null;
    if (uid && document.visibilityState === 'visible') {
      console.log('[cloud] reconnecting watcher…');
      startWatch();
    }
  }, 4000);
}
function startWatch() {
  stopWatch();
  try {
    watcher = db.collection(COLLECTION).doc(uid).watch({
      onChange: (snapshot) => {
        const docs = snapshot && snapshot.docs ? snapshot.docs : [];
        if (!docs.length) return;
        if (Date.now() - lastPushAt < 2000) return;
        const data = docs[0];
        if (!data || !data.state) return;
        applyingRemote = true;
        state = sanitizeState(data.state);
        applyingRemote = false;
        setSync('synced', '已同步');
        applyAllAppearance();
        renderAll();
      },
      onError: (err) => {
        console.warn('[cloud watch error]', err);
        setSync('error', '监听断线,重连中…');
        stopWatch();
        _scheduleWatchReconnect();
      },
    });
  } catch (e) {
    console.warn('[cloud startWatch fail]', e);
    _scheduleWatchReconnect();
  }
}
// 兜底:每 30 秒主动 pull 一次(只在前台),防 watcher silent 断线导致 Kayu 看不到桌面更新
let _periodicPullId = null;
function startPeriodicPull() {
  if (_periodicPullId) return;
  _periodicPullId = setInterval(() => {
    if (!uid || !state) return;
    if (document.visibilityState !== 'visible') return;
    pullStateOnce();
  }, 30000);
}
function pushState() {
  if (applyingRemote || !uid) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      setSync('syncing', '同步中…');
      state._cloudUpdatedAt = Date.now();
      lastPushAt = Date.now();
      const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'push', docId: uid, state } });
      const r = res && res.result;
      if (!r || r.ok !== true) throw new Error((r && r.error) || '云函数返回失败');
      setSync('synced', '已同步');
    } catch (e) { setSync('error', '同步失败'); console.error('[push error]', e); }
  }, 1000);
}
async function pullStateOnce() {
  try {
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'pull', docId: uid } });
    const r = res && res.result;
    const remote = (r && r.ok) ? r.state : null;
    if (!remote) return;
    const local = state && state._cloudUpdatedAt || 0;
    const remoteTs = remote._cloudUpdatedAt || 0;
    if (remoteTs > local) {
      applyingRemote = true;
      state = sanitizeState(remote);
      applyingRemote = false;
      applyAllAppearance();
      renderAll();
    }
  } catch (_) {}
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
async function manualPullState() {
  if (!tcbApp || !uid) return 'no-cloud';
  try {
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'pull', docId: uid } });
    const r = res && res.result;
    const remote = (r && r.ok) ? r.state : null;
    if (!remote) return 'no-cloud';
    const before = _stateFingerprint(state);
    applyingRemote = true;
    state = sanitizeState(remote);
    applyingRemote = false;
    applyAllAppearance();
    renderAll();
    const after = _stateFingerprint(state);
    return (before !== after) ? 'updated' : 'no-change';
  } catch (e) {
    console.warn('[pull-refresh]', e);
    return 'error';
  }
}

function emptyState() {
  return {
    folders: [], projects: [], taskLists: [], tasks: [],
    events: [], sessions: [], tags: [], smartLists: [], templates: [],
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

  return {
    ...e, ...s,
    folders: arr(s.folders), projects: arr(s.projects), taskLists: arr(s.taskLists),
    tasks, events, sessions: arr(s.sessions),
    tags: arr(s.tags), smartLists: arr(s.smartLists), templates: arr(s.templates),
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
  calendar: { label: '日历', icon: 'ico-calendar' },
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
  // 当前 tab 被隐藏了 → 自动切到第一个可见的
  const visible = getVisibleMobileTabs();
  if (!visible.includes(ui.tab)) ui.tab = visible[0] || 'tasks';
  applyTheme();
  renderTabBar();
  renderTopbar();
  renderTab(ui.tab);
  if ($('drawer-nav').classList.contains('open')) renderDrawerNav();
  if ($('drawer-right') && $('drawer-right').classList.contains('open')) renderCalendarSidebar();
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $('fab').classList.toggle('hidden', !(ui.tab === 'tasks' || ui.tab === 'calendar'));
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
    ui.tab = b.dataset.tab;
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
    if (ui.calMode === 'month') $('topbar-title').textContent = `${c.getFullYear()} 年 ${c.getMonth()+1} 月`;
    else if (ui.calMode === 'week') {
      const ws = startOfWeek(c), we = addDays(ws, 6);
      $('topbar-title').textContent = `${ws.getMonth()+1}/${ws.getDate()} – ${we.getMonth()+1}/${we.getDate()}`;
    } else $('topbar-title').textContent = `${c.getMonth()+1} 月 ${c.getDate()} 日`;
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
  if (tab === 'calendar') return renderCalendarTab(view);
  if (tab === 'stats') return renderStatsTab(view);
  if (tab === 'timer') return renderTimerTab(view);
  if (tab === 'settings') return renderSettingsTab(view);
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
function bindCloudTimelineImages(root) {
  // (1) 异步换 src
  const imgs = root.querySelectorAll('img[data-cloud-file-id]');
  imgs.forEach(async (img) => {
    const fid = img.dataset.cloudFileId;
    const url = await getCloudImageUrl(fid);
    if (url) img.src = url;
    else img.replaceWith(Object.assign(document.createElement('div'), {
      className: 'proj-tl-img-placeholder',
      innerHTML: '<span class="ico-eye"></span><span>附图加载失败</span>',
    }));
  });
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
    lb.querySelector('.img-lb-close').addEventListener('click', closeImageLightbox);
  }
  const track = lb.querySelector('.img-lb-track');
  track.innerHTML = images.map(im => `
    <div class="img-lb-slide">
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" data-cloud-file-id="${esc(im.cloudFileID || '')}" alt="${esc(im.title || '')}">
    </div>`).join('');
  // 异步加载所有图(reuse 现成函数,但 lightbox 内不会有 .proj-tl-line / .dp-image-grid,不会再绑 click)
  track.querySelectorAll('img[data-cloud-file-id]').forEach(async (img) => {
    const url = await getCloudImageUrl(img.dataset.cloudFileId);
    if (url) img.src = url;
  });
  let idx = startIdx;
  const counter = lb.querySelector('.img-lb-counter');
  const titleEl = lb.querySelector('.img-lb-title');
  const updateUI = (animate) => {
    track.style.transition = animate ? 'transform .26s cubic-bezier(.2,.7,.3,1)' : 'none';
    track.style.transform = `translateX(${-idx * 100}%)`;
    counter.textContent = `${idx + 1} / ${images.length}`;
    titleEl.textContent = images[idx].title || '';
  };
  updateUI(false);
  // 手势:横向 swipe 切换
  const viewport = lb.querySelector('.img-lb-viewport');
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, locked = null;
  const onStart = (e) => {
    if (e.touches && e.touches.length !== 1) return;
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX; startY = t.clientY; dx = 0; dy = 0;
    dragging = true; locked = null;
    track.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    dx = t.clientX - startX;
    dy = t.clientY - startY;
    if (locked == null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (locked === 'x') {
      const w = viewport.clientWidth;
      track.style.transform = `translateX(${-idx * w + dx}px)`;
      if (e.cancelable) e.preventDefault();
    }
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    if (locked === 'x') {
      const w = viewport.clientWidth;
      const threshold = w * 0.18;
      if (dx < -threshold && idx < images.length - 1) idx++;
      else if (dx > threshold && idx > 0) idx--;
      updateUI(true);
    } else if (locked == null && Math.abs(dx) < 6 && Math.abs(dy) < 6) {
      // tap 空白(非图片自身)— 不动
    }
  };
  viewport.ontouchstart = onStart;
  viewport.ontouchmove = onMove;
  viewport.ontouchend = onEnd;
  viewport.ontouchcancel = onEnd;
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
  const nodes = [...tl].sort((a, b) => (a.ts || 0) - (b.ts || 0));
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
  if (!nodes.length) return '<div class="empty" style="padding:14px;">还没有节点</div>';
  return `<div class="proj-tl-line">${nodes.map(renderNode).join('')}</div>`;
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
    </div>
    <div class="dp-footer">
      <button class="dp-project-pill" data-action="del" style="color:var(--danger);"><span class="ico-trash"></span><span>删除</span></button>
      <button class="dp-more-btn" data-action="cancel">取消</button>
      <button class="dp-more-btn" data-action="save" style="background:var(--accent);color:#fff;">保存</button>
    </div>
  `, (body) => {
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
      pushState();
      closeSheet();
      renderAll();
      showToast('节点已更新');
    };
    body.querySelector('[data-action="del"]').onclick = () => {
      if (!confirm('删除这个节点?')) return;
      p.timeline = (p.timeline || []).filter(x => x.id !== nodeId);
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
  const _schedStateClass = (s) => {
    if (t.done) return '';
    if (!s || !s.start) return '';
    const today0 = startOfDay(new Date()).getTime();
    const today1 = today0 + 86400000;
    if (s.start < today0) return 'overdue';
    if (s.start < today1) return 'today';
    return 'future';
  };
  const schedHtml = schedules.map(s => `<span class="dp-sched-pill ${_schedStateClass(s)}">
    <span class="ico-clock"></span>
    <span class="dp-sched-text">${esc(fmtSchedule(s))}</span>
    <button class="dp-sched-x" data-action="dp-remove-schedule" data-task-id="${t.id}" data-sched-id="${esc(s.id || 'legacy')}" title="删除此时间">×</button>
  </span>`).join('');

  // 子任务 — union 桌面模型(parentTaskId)+ 老 mobile 模型(t.subtasks 数组)
  const childTasks = (state.tasks || [])
    .filter(x => x.parentTaskId === t.id)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const legacySubs = Array.isArray(t.subtasks) ? t.subtasks : [];
  const subItemsRaw = [
    ...childTasks.map(c => ({ source: 'task', id: c.id, title: c.title, done: !!c.done })),
    ...legacySubs.map(s => ({ source: 'legacy', id: s.id, title: s.title, done: !!s.done })),
  ];
  // 已完成沉到下方,未完成在上(对齐桌面)
  const subItems = subItemsRaw.slice().sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
  const subsHtml = subItems.length ? `<ul class="dp-sub-list">${subItems.map(s => `
    <li class="dp-sub ${s.done?'done':''}" data-sub-id="${esc(s.id)}" data-sub-source="${s.source}">
      <button class="dp-sub-check ${s.done?'done':''}" data-action="toggle-sub">${s.done ? '✓' : ''}</button>
      <span class="dp-sub-title" contenteditable="true" spellcheck="false" data-action="edit-sub-title">${esc(s.title || '')}</span>
      <button class="dp-sub-del" data-action="del-sub" title="删除">×</button>
    </li>
  `).join('')}</ul>` : '<div class="dp-empty">还没有子任务</div>';

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
      <div class="dp-head">
        <span class="dp-head-kind">${isRecurring ? '重复任务' : '任务'}</span>
        <button class="dp-head-close" data-action="task-detail-close" title="关闭">×</button>
      </div>

      <div class="dp-time-bar">
        ${schedHtml}
        <button class="dp-add-sched-btn" data-action="dp-add-schedule" title="加时间">
          <span class="ico-plus"></span>
          <span>${schedules.length ? '改' : '加时间'}</span>
        </button>
      </div>

      <div class="dp-title-row">
        <button class="dp-check ${checked ? 'done' : ''}" data-action="toggle-done" title="${checked ? '标记未完成' : '标记完成'}">${checked ? '✓' : ''}</button>
        <input type="text" class="dp-title-input ${checked ? 'done' : ''}" value="${esc(t.title || '')}" placeholder="任务标题" />
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
        <div class="dp-section-title">子待办 <span class="dp-section-count">${subItems.length}</span></div>
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

  // schedule pill 加按钮 → 时间编辑器(老的还能用,只编辑第一个 schedule + legacy)
  body.querySelector('[data-action="dp-add-schedule"]').onclick = () => openTimeEditor(id);

  // schedule pill ×按钮 → 删除
  body.querySelectorAll('[data-action="dp-remove-schedule"]').forEach(b => b.onclick = (ev) => {
    ev.stopPropagation();
    const sid = b.dataset.schedId;
    if (sid && sid !== 'legacy' && Array.isArray(t.schedules)) {
      t.schedules = t.schedules.filter(s => s.id !== sid);
    }
    // 如果删完了,清掉 legacy 字段
    if (!t.schedules || !t.schedules.length || sid === 'legacy') {
      t.start = null; t.end = null; t.allDay = false; t.dueAt = null;
      if (sid === 'legacy') t.schedules = [];
    } else {
      // 把第一个 schedule 同步回 legacy
      const s0 = t.schedules[0];
      t.start = s0.start || null; t.end = s0.end || null; t.allDay = !!s0.allDay; t.dueAt = s0.start || null;
    }
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
        if (child) { child.done = !child.done; child.doneAt = child.done ? Date.now() : null; child.updatedAt = Date.now(); }
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
  // start 取值优先级:
  //   opts.startTs(明确传)→ 直接用
  //   日历选中日 = 今天 → 当前时刻 + 5min snap(对齐 Kayu 期望"从触发时间点创建")
  //   日历选中日 ≠ 今天 → 那天 09:00(只能落到目标日)
  //   未传 dayMs → 当前时刻
  let start;
  if (Number.isFinite(opts.startTs)) {
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
    const projectId = cl.kind === 'project' ? cl.project?.id : null;
    const day = ui.tab === 'calendar' ? (ui.calSelectedDay || ui.calCursor) : Date.now();
    const newTask = applyTaskTemplate(tmpl, day, projectId);
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

// ----- 列表更多菜单(右上 ⋯)-----
function openListMoreMenu() {
  const cl = getCurrentList();
  const items = [];
  if (cl.kind === 'project' && cl.project) {
    const p = cl.project;
    const isProj = (p.kind || 'project') === 'project';
    items.push({ label: isProj ? '编辑项目' : '编辑清单', icon: 'ico-edit', action: () => { showToast('编辑:暂未实现'); closePopover(); } });
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
    items.push({ label: '编辑文件夹', icon: 'ico-edit', action: () => { showToast('编辑:暂未实现'); closePopover(); } });
    items.push({ divider: true });
    items.push({ label: '删除文件夹', icon: 'ico-trash', danger: true, action: () => {
      if (!confirm('删除文件夹「' + (f.name||'未命名') + '」?里面的项目会变成"未分组"。')) return;
      state.projects.forEach(p => { if (p.folderId === f.id) p.folderId = null; });
      state.folders = state.folders.filter(x => x.id !== f.id);
      ui.selectedKind = 'smart'; ui.selectedId = 'all'; saveUI();
      pushState(); closePopover(); renderAll();
    }});
  } else if (cl.kind === 'tag') {
    items.push({ label: '编辑标签', icon: 'ico-edit', action: () => { showToast('编辑:暂未实现'); closePopover(); } });
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
function renderDrawerNav() {
  $('drawer-user-name').textContent = uid || '未登录';
  // 在 drawer header 区放一个 + 按钮(创建清单/项目/文件夹)
  const drawerHead = document.querySelector('#drawer-nav .drawer-head');
  if (drawerHead && !drawerHead.querySelector('[data-action="drawer-create"]')) {
    const btn = document.createElement('button');
    btn.className = 'drawer-create-btn';
    btn.dataset.action = 'drawer-create';
    btn.title = '新建清单 / 项目 / 文件夹';
    btn.innerHTML = '<span class="ico-plus"></span>';
    btn.onclick = (e) => { e.stopPropagation(); openCreateProjectSheet(); };
    drawerHead.appendChild(btn);
  }
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
  // 任务清单 — 单独 section,不跟项目混(对齐 Kayu 反馈:tasklist ≠ project)
  const tasklists = state.projects.filter(p => !p.archived && p.kind === 'tasklist').slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  if (tasklists.length) {
    html += navSectionTitle('__tasklists__', '任务清单');
    if (!ui.collapsedSections.has('__tasklists__')) {
      html += tasklists.map(p => projectRowHtml(p)).join('');
    }
  }

  html += navSectionTitle('__tasks__', '项目');
  if (!ui.collapsedSections.has('__tasks__')) {
    const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
    // 项目组只含 kind='project'
    const activeProjects = state.projects.filter(p => !p.archived && (p.kind || 'project') === 'project').slice().sort(byOrder);
    const folderIds = new Set(state.folders.map(f => f.id));
    const pinned = activeProjects.filter(p => p.pinned);
    const inFolder = (fid) => activeProjects.filter(p => !p.pinned && p.folderId === fid);
    const ungrouped = activeProjects.filter(p => !p.pinned && (!p.folderId || !folderIds.has(p.folderId)));
    if (pinned.length) {
      html += `<div class="nav-section-title">已置顶</div>`;
      html += pinned.map(p => projectRowHtml(p)).join('');
    }
    state.folders.slice().sort(byOrder).forEach(f => {
      const collapsed = ui.collapsedFolders.has(f.id);
      const projs = inFolder(f.id);
      const folderCustomIco = renderCustomIconHtml(f.icon, 'nav-folder-ico', '') || '';
      const active = ui.selectedKind === 'folder' && ui.selectedId === f.id;
      const undoneCnt = state.tasks.filter(t => projs.some(p => p.id === t.projectId) && !t.done).length;
      html += `<div class="nav-folder-head ${collapsed?'collapsed':''} ${active?'active':''}" data-select-kind="folder" data-select-id="${esc(f.id)}">
        <button class="nav-folder-chev" data-folder-toggle="${esc(f.id)}" aria-label="${collapsed?'展开':'折叠'}"><span class="ico-chevron-down"></span></button>
        ${folderCustomIco || `<span class="nav-icon ico-folder"></span>`}
        <span class="nav-folder-name">${esc(f.name || '未命名')}</span>
        <span class="nav-count">${undoneCnt || projs.length}</span>
      </div>`;
      html += `<div class="nav-folder-children">`;
      html += projs.map(p => projectRowHtml(p)).join('');
      html += `</div>`;
    });
    if (ungrouped.length) {
      html += `<div class="nav-section-title" style="text-transform:none;font-weight:500;">未分组</div>`;
      html += ungrouped.map(p => projectRowHtml(p)).join('');
    }
    const archived = state.projects.filter(p => p.archived && (p.kind || 'project') === 'project');
    if (archived.length) {
      html += `<div class="nav-section-title">已归档 (${archived.length})</div>`;
      html += archived.map(p => projectRowHtml(p)).join('');
    }
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
  const b = endOfDay(new Date(dayMs)).getTime();
  return calFilterTasks(state.tasks.filter(t => taskHitDate(t, a, b)), a);
}
// 按 calShowDone / calShowAllRepeat 过滤(repeat 占位:重复任务暂未在移动端展开,只过滤 done)
function calFilterTasks(arr, dayStart) {
  const showDone = !state || !state.settings || state.settings.calShowDone !== false;
  const showRepeat = !state || !state.settings || state.settings.calShowAllRepeat !== false;
  const today0 = startOfDay(new Date()).getTime();
  return arr.filter(t => {
    if (!showDone && t.done) return false;
    // 重复任务未来实例:移动端目前没有重复展开,占位只在 calShowAllRepeat=false 时把"未来日期"的重复任务挡掉
    if (!showRepeat && t.repeat && dayStart != null && dayStart > today0) return false;
    return true;
  });
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

  // 任务索引(尊重 calShowDone / calShowAllRepeat)
  const showDone = state.settings.calShowDone !== false;
  const showRepeat = state.settings.calShowAllRepeat !== false;
  const taskByDay = new Map();
  for (const t of state.tasks) {
    if (!showDone && t.done) continue;
    const dt = t.start || t.dueAt;
    if (!dt) continue;
    const k = startOfDay(new Date(dt)).getTime();
    if (!showRepeat && t.repeat && k > today0) continue;
    if (!taskByDay.has(k)) taskByDay.set(k, []);
    taskByDay.get(k).push(t);
  }

  let weeksHtml = '';
  for (let w = 0; w < totalWeeks; w++) {
    const ws = addDays(firstWeek, w * 7);
    let cells = '';
    for (let c = 0; c < 7; c++) {
      const d = addDays(ws, c);
      const dms = startOfDay(d).getTime();
      const isFirst = d.getDate() === 1;
      const isToday = dms === today0;
      const isSel = dms === sel0;
      const cellMonth = d.getFullYear() * 100 + d.getMonth();
      const tks = taskByDay.get(dms) || [];
      const MAX_PILLS = 2;
      const pillsHtml = tks.slice(0, MAX_PILLS).map(t => {
        const col = colorOfCalItem(t) || 'var(--accent)';
        return `<div class="cal-cell-pill ${t.done?'done':''}" style="--pill-color:${esc(col)}" title="${esc(t.title || '')}">${esc(t.title || '')}</div>`;
      }).join('');
      const moreHtml = tks.length > MAX_PILLS
        ? `<div class="cal-cell-more">+${tks.length - MAX_PILLS}</div>`
        : '';
      const monthLabel = isFirst ? `<span class="cal-month-label">${d.getMonth()+1}月</span>` : '';
      cells += `<div class="cal-cell ${isToday?'today':''} ${isSel?'sel':''}" data-cal-day="${dms}" data-cell-month="${cellMonth}" data-cal-anchor-month="${isFirst ? cellMonth : ''}">
        <div class="cal-cell-num-wrap">
          ${monthLabel}
          <div class="cal-cell-num">${d.getDate()}</div>
        </div>
        <div class="cal-cell-pills">${pillsHtml}${moreHtml}</div>
      </div>`;
    }
    weeksHtml += `<div class="cal-week-row">${cells}</div>`;
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
    if (idx >= 0) item.completedOccurrences.splice(idx, 1);
    else { item.completedOccurrences.push(occStart); item.completedOccurrences.sort((a, b) => a - b); }
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
    const daySessions = (state.sessions || []).filter(s => {
      if (!s.startedAt || !s.duration || !s.projectId) return false;
      const a = s.startedAt;
      const b = (s.endedAt || (s.startedAt + s.duration));
      return b > dayStartMs && a < dayEnd;
    });
    const gapMin = (state.settings && typeof state.settings.calMergeGapMin === 'number')
      ? state.settings.calMergeGapMin : 15;
    const merged = mergeAdjacentSessions(daySessions, gapMin * 60 * 1000);
    for (const m of merged) {
      const a = m.startedAt;
      const b = m.endedAt || (m.startedAt + (m.duration || 0));
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

  // session
  return `<div class="cal-block cal-block-session ${compact?'compact':''}" data-session-id="${esc(d.sessionId || '')}" style="${styleVars}">
    <div class="cal-block-title">${esc(d.title)}</div>
    ${heightMin >= 30 ? `<div class="cal-block-time">${startStr}</div>` : ''}
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
  // session 块点击暂不做(无对应详情页)
  // 长按编辑模式
  bindCalBlockEdit(view);
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
    if (!showDone && t.done) continue;
    if (!taskHitDate(t, dayStart, dayStart + 86400000 - 1)) continue;
    if (t.start && !t.allDay) continue;
    allDayItems.push({ kind: 'task', id: t.id, title: t.title || '(无标题)', color: colorOfCalItem(t) || 'var(--accent)', done: t.done });
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
    if (!showDone && t.done) continue;
    if (t.start && !t.allDay) continue;
    for (let i = 0; i < 7; i++) {
      const dStart = startOfDay(days[i]).getTime();
      if (taskHitDate(t, dStart, dStart + 86400000 - 1)) {
        allDayPerDay[i].push({ kind: 'task', id: t.id, title: t.title || '(无标题)', color: colorOfCalItem(t) || 'var(--accent)', done: t.done });
      }
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
    _autoReloginTried = true; // 阻止 onLoginStateChanged 触发自动重登
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
      <div class="form-row" id="cp-folder-row" style="margin-top:8px;${folders.length ? '' : 'display:none'}">
        <label>所属文件夹</label>
        <select id="cp-folder">
          <option value="">未分组</option>
          ${folders.map(f => `<option value="${esc(f.id)}">${esc(f.name || '未命名')}</option>`).join('')}
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
    setTimeout(() => nameEl.focus(), 80);
    kindEl.onchange = () => {
      // 文件夹自身不挂文件夹
      folderRow.style.display = (kindEl.value === 'folder' || !folders.length) ? 'none' : '';
    };
    body.querySelector('[data-action="cancel"]').onclick = closeSheet;
    body.querySelector('[data-action="save"]').onclick = () => {
      const name = nameEl.value.trim();
      if (!name) { showToast('请输入名称'); return; }
      const kind = kindEl.value;
      const folderId = (kind === 'folder') ? null : (body.querySelector('#cp-folder').value || null);
      if (kind === 'folder') {
        const maxOrder = (state.folders || []).reduce((m, x) => Math.max(m, x.order || 0), 0);
        state.folders.push({
          id: 'f-' + Math.random().toString(36).slice(2, 10),
          name, color: '', icon: '', order: maxOrder + 100,
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
      <div class="dp-head">
        <span class="dp-head-kind">新建任务</span>
        <button class="dp-head-close" data-action="cancel" title="关闭">×</button>
      </div>
      <div class="dp-time-bar" id="qe-time-bar">
        ${schedPillHtml()}
        <button class="dp-add-sched-btn" data-action="qe-add-sched" title="加时间">
          <span class="ico-plus"></span>
          <span>${sched ? '改时间' : '加时间'}</span>
        </button>
      </div>
      <div class="dp-title-row">
        <span class="dp-check" style="visibility:hidden"></span>
        <input type="text" class="dp-title-input" id="qe-title" placeholder="任务标题">
      </div>
    </div>
    <div class="dp-footer">
      <button class="dp-project-pill" id="qe-proj-pill" data-action="qe-pick-project">${projPillHtml()}</button>
      <button class="dp-more-btn" data-action="qe-more" title="更多"><span class="ico-more"></span></button>
      <button class="dp-more-btn dp-more-btn-primary" data-action="save" title="保存"><span class="ico-check"></span></button>
    </div>
  `, (body) => {
    const titleEl = body.querySelector('#qe-title');
    setTimeout(() => titleEl.focus(), 80);

    function refreshSchedRow() {
      const bar = body.querySelector('#qe-time-bar');
      bar.innerHTML = `
        ${schedPillHtml()}
        <button class="dp-add-sched-btn" data-action="qe-add-sched" title="加时间">
          <span class="ico-plus"></span>
          <span>${sched ? '改时间' : '加时间'}</span>
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
          closePopover(); closeSheet();
          openCreateFromTemplatePicker();
        }});
      } else {
        menuItems.push({ label: '从模板创建(暂无可用模板)', icon: 'ico-template', disabled: true });
      }
      showPopover(menuItems, { anchor: ev.currentTarget });
    };
    const save = () => {
      const title = titleEl.value.trim();
      if (!title) { closeSheet(); return; }
      const startMs = sched && sched.start || null;
      const endMs   = sched && sched.end   || null;
      const newTask = {
        id: genId('t'),
        title, done: false, createdAt: Date.now(), updatedAt: Date.now(),
        projectId: pickedProjectId || null,
        parentTaskId: null,
        parentEventId: null,
        dueAt: startMs,
        start:  startMs,
        end:    endMs && endMs > startMs ? endMs : null,
        allDay: sched ? !!sched.allDay : false,
        tags: [], subtasks: [],
        schedules: sched ? [sched] : [],
        completedOccurrences: [],
        kanbanColumn: null,
        order: 100,
      };
      state.tasks.push(newTask);
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
    else if (ui.tab === 'settings' && ui.settingsPage) { ui.settingsPage = null; renderAll(); }
    else openDrawerNav();
  });
  $('topbar-right-btn').addEventListener('click', () => {
    if (ui.tab === 'tasks') openListMoreMenu();
    else if (ui.tab === 'calendar') openCalendarMoreMenu();
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
      openCreateTaskSheet();
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
  // 切回前台主动 pull
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && uid && state) pullStateOnce();
  });
}

// iOS / Android 软键盘弹起时把 sheet 上移,避免输入框被遮
// visualViewport.height 在键盘弹起时会变小(键盘占用部分);用 window.innerHeight - vv.height 算键盘高度
// ===== 任务页左边缘右拉 → 呼出 drawer-nav =====
(function bindEdgeSwipeDrawer() {
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
    if (locked !== 'x' || dx <= 0) return;
    const w = panel.getBoundingClientRect().width || 280;
    const ratio = Math.min(1, dx / w);
    panel.style.transform = `translateX(${(ratio - 1) * 100}%)`;
    if (mask) mask.style.background = `rgba(0, 0, 0, ${0.34 * ratio})`;
  }, { passive: true });
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
    const ready = d >= THRESHOLD;
    indicator.classList.toggle('ready', ready);
    const lbl = indicator.querySelector('.pull-refresh-label');
    if (lbl) lbl.textContent = ready ? '松开刷新' : '下拉刷新';
  }
  function reset() {
    indicator.style.transition = 'transform .22s ease, opacity .22s ease';
    indicator.style.transform = '';
    indicator.style.opacity = '';
    setTimeout(() => { indicator.style.transition = ''; }, 250);
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
      indicator.style.transform = 'translateY(20px)';
      indicator.style.opacity = '1';
      const lbl = indicator.querySelector('.pull-refresh-label');
      if (lbl) lbl.textContent = '正在同步…';
      let result = 'error';
      try {
        result = await (typeof manualPullState === 'function' ? manualPullState() : 'no-cloud');
      } catch (_) {}
      busy = false;
      indicator.classList.remove('refreshing');
      reset();
      const msg =
        result === 'updated'   ? '已拉取云端更新' :
        result === 'no-change' ? '已是最新' :
        result === 'no-cloud'  ? '请先登录或检查网络' :
                                 '同步失败';
      try { showToast && showToast(msg); } catch (_) {}
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
  const apply = () => {
    const sheet = $('sheet');
    if (!sheet || sheet.classList.contains('hidden')) return;
    const body = $('sheet-body');
    if (!body) return;
    const kbHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // 焦点在 sheet 内的 input/textarea/contenteditable 才偏移(避免没必要的位移)
    const ae = document.activeElement;
    const focused = ae && body.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    const target = (focused && kbHeight > 50) ? -kbHeight : 0;
    if (target !== lastOffset) {
      lastOffset = target;
      // 不动 transition(避免跟下拉关闭手势冲突,直接跳)
      const prevTrans = body.style.transition;
      body.style.transition = 'transform .18s ease';
      body.style.transform = target ? `translateY(${target}px)` : '';
      // 下次 RAF 还原 transition,让下拉手势能用 'none'
      requestAnimationFrame(() => requestAnimationFrame(() => { body.style.transition = prevTrans; }));
    }
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  // focus/blur 也触发(键盘可能在 visualViewport 事件之前就被调起)
  document.addEventListener('focusin', () => setTimeout(apply, 50), true);
  document.addEventListener('focusout', () => setTimeout(apply, 50), true);
})();

// 启动
applyTheme();
setupAuth();
bindGlobalEvents();
