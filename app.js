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
  const msg = String(e?.reason?.message || e?.reason || '');
  // 已知暂态错误 — CloudBase SDK 内部 ws 超时会自动重连,iOS Safari 切后台 / 网络抖动会触发
  // 这种全屏报错只会让用户以为"挂了"。日志记一下就好,不要 hijack 整个 app。
  const isTransient =
    /wsclient\.send timedout/i.test(msg) ||
    /Failed to fetch/i.test(msg) ||
    /Network request failed/i.test(msg) ||
    /timeout/i.test(msg) ||
    /WebSocket/i.test(msg) ||
    /AbortError/i.test(msg);
  if (isTransient) {
    console.warn('[transient swallowed]', msg);
    e.preventDefault && e.preventDefault();
    return;
  }
  showFatal('未处理的 Promise:' + msg);
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

// 客户端构建版本(每次发新代码会改这个,Kayu 能在 sync-bar 看到当前版本号识别是否拿到最新)
const _PSFOCUS_BUILD = '20260515-0100';
console.log('[PSFocus mobile] build', _PSFOCUS_BUILD);

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
  setSync('syncing', '加载中…');
  try {
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'pull', docId: uid } });
    const r = res && res.result;
    const remote = (r && r.ok) ? r.state : null;
    if (remote) {
      state = sanitizeState(remote);
      _initialPullOk = true;
      _lastKnownGoodTaskCount = (state.tasks || []).length;
      setSync('synced', '已同步');
    } else {
      // 云端真的空(可能新账号)— 允许后续 push,但记录
      state = emptyState();
      _initialPullOk = true;
      _lastKnownGoodTaskCount = 0;
      setSync('synced', '已同步(空)');
    }
  } catch (e) {
    // 网络/鉴权失败 — 严禁后续 push,避免空 state 覆盖云端
    state = emptyState();
    _initialPullOk = false;
    _lastKnownGoodTaskCount = -1;
    setSync('error', '加载失败,本地暂用空数据 — 已锁定,不会覆盖云端');
    console.error('[bindCloud pull]', e);
  }
  applyAllAppearance();
  renderAll();
  startWatch();
  startPeriodicPull();
  // 拉到云端旧数据后,如果 sanitize 补了缺字段,立刻 push 回去让云端自愈
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
        // 时间戳防御:云端比本地旧 → 跳过(本地有未同步的改动,如刚改完模块标题但 push 还在防抖窗口里)
        // 否则旧 snapshot 会覆盖本地的最新改动
        const remoteTs = (data.state && data.state._cloudUpdatedAt) || 0;
        const localTs  = (state && state._cloudUpdatedAt) || 0;
        if (remoteTs < localTs) {
          console.warn('[watch] skip older snapshot:', remoteTs, '<', localTs, '— 本地更新,主动推一次');
          try { pushState(); } catch (_) {}
          return;
        }
        applyingRemote = true;
        state = sanitizeState(data.state);
        applyingRemote = false;
        _initialPullOk = true;  // watcher 收到 = 云端可达
        _lastKnownGoodTaskCount = (state.tasks || []).length;
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
  pushTimer = setTimeout(async () => {
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
      setSync('error', '同步失败:' + errMsg);
      console.error('[push error]', e);
    }
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
      _initialPullOk = true;
      _lastKnownGoodTaskCount = (state.tasks || []).length;
      applyAllAppearance();
      renderAll();
    } else if (remote) {
      // 哪怕没更新也算云端可达
      _initialPullOk = true;
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
let _lastSyncErrorMsg = '';
async function manualPullState() {
  _lastSyncErrorMsg = '';
  if (!tcbApp) { _lastSyncErrorMsg = 'tcbApp 未就绪'; return 'no-cloud'; }
  if (!uid) { _lastSyncErrorMsg = '未登录(uid 为空)'; return 'no-cloud'; }
  try {
    const res = await tcbApp.callFunction({ name: 'syncState', data: { action: 'pull', docId: uid } });
    const r = res && res.result;
    if (!r) { _lastSyncErrorMsg = '云函数无返回'; return 'error'; }
    if (r.ok === false) { _lastSyncErrorMsg = r.error || 'fn ok=false'; return 'error'; }
    const remote = r.state || null;
    if (!remote) { _lastSyncErrorMsg = '云端无 state'; return 'no-change'; }
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
    if (!sum.createdAt) sum.createdAt = sum.updatedAt || Date.now();
    if (!sum.updatedAt) sum.updatedAt = sum.createdAt;
    if (sum.modules) delete sum.modules;
  }
  const summaryTags = arr(s.summaryTags);
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
  summary:  { label: '摘要', icon: 'ico-pencil' },
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
  } else if (ui.tab === 'summary') {
    $('topbar-title').textContent = '摘要';
    $('topbar-subtitle').textContent = '';
    leftBtn.innerHTML = `<span class="ico-list"></span>`;
    leftBtn.setAttribute('aria-label', '标签');
    leftBtn.classList.remove('hidden');
    $('topbar-right-btn').classList.add('hidden');
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
  if (tab === 'summary') return renderSummaryTab(view);
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
  // 日期折叠状态 — 跨刷新保留(per-device UI 偏好,不走云端)
  collapsedDays: (() => {
    try { return new Set(JSON.parse(localStorage.getItem('psfocus_collapsedDays') || '[]')); }
    catch (_) { return new Set(); }
  })(),
  visibleDaysCount: 20,        // 默认只渲染最近 20 天,余下点"加载更早"
  pendingImages: [],           // [{ id, cloudFileID, name }]
  pendingModuleValues: {},     // { [modId]: value/valueMs }
  draftNote: '',               // 输入框未发布的笔记草稿 — 防 renderAll 时清空
  modulePopoverForDay: null,   // sheet 形式打开时的 dayKey
  modulePickerOpenInPopover: false,
  expandedModuleCards: new Set(),
  // 输入框下方"今日 · 待录入"面板的折叠状态 — 跨刷新保留
  inputModsCollapsed: (() => { try { return localStorage.getItem('psfocus_inputModsCollapsed') === '1'; } catch (_) { return false; } })(),
  // tag 侧栏:父 tag 折叠子 tag 状态、大分类(置顶 / 全部)折叠状态
  collapsedTags: new Set(),
  collapsedSections: new Set(),
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
  // inline #xxx 转 clickable tag span(行级标题 "# " 形式跳过)
  html = html.replace(/(^|[^&\w])#([^\s#,。、,<&]+)/g, (m, before, tag) => {
    return before + '<span class="sum-md-tag" data-action="summary-filter" data-filter="tag:' + esc(tag) + '">#' + esc(tag) + '</span>';
  });
  const lines = html.split('\n');
  const out = [];
  let listKind = null;
  const closeList = () => { if (listKind) { out.push(`</${listKind}>`); listKind = null; } };
  for (const line of lines) {
    if (/^# (.+)$/.test(line)) {
      closeList();
      out.push(`<h3 class="sum-md-h">${line.replace(/^# /, '')}</h3>`);
    } else if (/^- (.+)$/.test(line)) {
      if (listKind !== 'ul') { closeList(); out.push('<ul class="sum-md-ul">'); listKind = 'ul'; }
      out.push(`<li>${line.replace(/^- /, '')}</li>`);
    } else if (/^\d+\. (.+)$/.test(line)) {
      if (listKind !== 'ol') { closeList(); out.push('<ol class="sum-md-ol">'); listKind = 'ol'; }
      out.push(`<li>${line.replace(/^\d+\. /, '')}</li>`);
    } else {
      closeList();
      if (line.trim()) out.push(`<div class="sum-md-line">${line}</div>`);
      else out.push('<div class="sum-md-blank"></div>');
    }
  }
  closeList();
  return out.join('');
}

// === 主渲染 ===
function renderSummaryTab(view) {
  // 进 tab 时让"今天"自动继承前一天的模板(若今天还没设过)
  _summaryEnsureTodayHasTemplates();
  const isData = summaryState.tab === 'data';
  view.innerHTML = `<div class="sum-view">
    <div class="sum-tabs-row">
      <div class="sum-tabs">
        <button class="sum-tab ${!isData?'active':''}" data-action="summary-set-tab" data-tab="summary">摘要</button>
        <button class="sum-tab ${isData?'active':''}" data-action="summary-set-tab" data-tab="data">数据</button>
      </div>
      ${!isData ? `<input type="text" class="sum-search" placeholder="搜索…" value="${esc(summaryState.searchQuery)}" data-action-input="summary-search-input">` : ''}
    </div>
    ${isData
      ? `<div class="sum-data-empty">
          <div class="sum-data-empty-title">数据</div>
          <div class="sum-data-empty-hint">敬请期待 — 这里会展示模块多日趋势</div>
        </div>`
      : `<div class="sum-main">
           ${_renderSummaryInputBox()}
           <div class="sum-list">${_renderSummaryList()}</div>
         </div>`
    }
  </div>`;

  // 输入框 paste 图片直接上传 + Ctrl/⌘+Enter 提交
  const ta = view.querySelector('.sum-input');
  if (ta) {
    ta.addEventListener('paste', _summaryHandlePaste);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (actions['summary-submit']) actions['summary-submit']();
      }
    });
    setTimeout(() => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }, 0);
  }
  // 异步加载摘要里的云图 — 跟 task detail 共用 bindCloudTimelineImages
  if (typeof bindCloudTimelineImages === 'function') bindCloudTimelineImages(view);
}

function _renderSummaryTagBar() {
  // 字典序排:子标签紧跟父级,避免 order 字段把不同父的标签穿插
  const tags = (state.summaryTags || []).slice().sort((a,b) => (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN'));
  const chips = [`<button class="sum-chip ${summaryState.filter==='all'?'active':''}" data-action="summary-filter" data-filter="all">全部</button>`];
  for (const tg of tags) {
    const active = summaryState.filter === ('tag:' + tg.name);
    chips.push(`<button class="sum-chip ${active?'active':''}" data-action="summary-filter" data-filter="tag:${esc(tg.name)}">#${esc(tg.name)}</button>`);
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
    ${inputModsCollapsed ? '' : `<div class="sum-input-day-mods-body">
      ${todayMods.map(m => _renderSummaryModuleEditor(m, todayKey)).join('')}
    </div>`}
  </div>` : '';
  const hasPending = Object.keys(summaryState.pendingModuleValues || {}).length > 0;
  return `<div class="sum-input-card ${hasPending ? 'has-pending-modules' : ''}">
    <textarea class="sum-input" rows="2" placeholder="现在的想法是…  输入 #xxx 自动加标签;粘贴图片直接上传"
      data-action-input="summary-input-autosize">${esc(summaryState.draftNote || '')}</textarea>
    ${pendingImgs ? `<div class="sum-input-pending">${pendingImgs}</div>` : ''}
    ${todayModsHtml}
    <div class="sum-input-toolbar">
      <button class="sum-tb-btn" data-action="summary-tb-tag" title="加标签 #"><span class="sum-tb-hash">#</span></button>
      <label class="sum-tb-btn sum-tb-img" title="上传图片">
        <input type="file" accept="image/*" multiple data-action="summary-upload-image" hidden>
        <span class="ico-image"></span>
      </label>
      <span class="sum-tb-sep"></span>
      <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="bold" title="粗体"><b>B</b></button>
      <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="italic" title="斜体"><i>I</i></button>
      <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="head" title="标题">H</button>
      <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="ul" title="无序"><span class="ico-list"></span></button>
      <button class="sum-tb-btn" data-action="summary-tb-format" data-fmt="ol" title="有序">1.</button>
      <span class="sum-tb-sep"></span>
      <button class="sum-tb-btn sum-tb-mod" data-action="summary-open-mod-sheet" title="管理模块">+ 模块</button>
      <div class="sum-input-spacer"></div>
      <button class="sum-input-submit" data-action="summary-submit" title="发布">→</button>
    </div>
  </div>`;
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
  for (const k of sortedKeys) {
    const items = byDay.get(k) || [];
    const hasNotes = items.length > 0;
    const collapsed = summaryState.collapsedDays.has(k);
    const refTs = hasNotes ? items[0].createdAt : _dayKeyToTs(k);
    const dayLabel = _summaryDayLabel(refTs);
    const modSummary = _renderSummaryDayHeaderModules(k);
    const editBtn = `<button class="sum-day-edit-btn" data-action="summary-day-edit" data-day-key="${esc(k)}" title="编辑此天的模块"><span class="ico-pencil"></span></button>`;
    if (hasNotes) {
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
          <div class="sum-day-items">${items.map(_renderSummaryItem).join('')}</div>
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
    _renderSummaryDrawerNav();
  },
  // 大分类(置顶/全部)折叠
  'summary-section-toggle': (el) => {
    const k = el.dataset.section;
    if (!k) return;
    if (!summaryState.collapsedSections) summaryState.collapsedSections = new Set();
    if (summaryState.collapsedSections.has(k)) summaryState.collapsedSections.delete(k);
    else summaryState.collapsedSections.add(k);
    _renderSummaryDrawerNav();
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
    summaryState.visibleDaysCount = (summaryState.visibleDaysCount || 20) + 20;
    // 只重渲列表,不全 renderAll
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
    renderAll();
  },
  'summary-input-autosize': (el, e) => {
    // 实时保存草稿 — 防 renderAll(点 dot / 模块按钮等)时 textarea 被替换丢失内容
    summaryState.draftNote = el.value;
    // IME 组词期间不 reflow(每段拼音都重排很卡),等 compositionend 触发的最终 input 再 resize
    if (e && e.isComposing) return;
    // 把 reflow 推到下一帧,不阻塞当前 input event;前一帧没跑完的 cancel 掉,避免堆积
    if (el._autosizeRAF) cancelAnimationFrame(el._autosizeRAF);
    el._autosizeRAF = requestAnimationFrame(() => {
      el._autosizeRAF = null;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    });
  },
  'summary-tb-tag': () => {
    const ta = document.querySelector('.sum-input');
    if (!ta) return;
    ta.focus();
    const s = ta.selectionStart || 0;
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(ta.selectionEnd || s);
    const sep = (s > 0 && !/\s/.test(before.slice(-1))) ? ' ' : '';
    ta.value = before + sep + '#' + after;
    const np = (before + sep + '#').length;
    ta.setSelectionRange(np, np);
  },
  'summary-tb-format': (el) => {
    const fmt = el.dataset.fmt;
    const ta = document.querySelector('.sum-input');
    if (!ta) return;
    ta.focus();
    const v = ta.value;
    const s = ta.selectionStart || 0;
    const e = ta.selectionEnd || 0;
    const before = v.slice(0, s);
    const sel = v.slice(s, e);
    const after = v.slice(e);
    const _linePrefix = (prefix) => {
      const lineStart = before.lastIndexOf('\n') + 1;
      const beforeLine = v.slice(0, lineStart);
      const lineAndAfter = v.slice(lineStart);
      const segEnd = e - lineStart;
      const segText = lineAndAfter.slice(0, segEnd);
      const tail = lineAndAfter.slice(segEnd);
      const lines = segText.split('\n');
      const newLines = lines.map((l, i) => (i === 0 || l.length > 0 ? prefix + l : l));
      const newSegText = newLines.join('\n');
      ta.value = beforeLine + newSegText + tail;
      const np = beforeLine.length + newSegText.length;
      ta.setSelectionRange(np, np);
    };
    const _wrap = (mark) => {
      const inner = sel || '文字';
      ta.value = before + mark + inner + mark + after;
      const ns = before.length + mark.length;
      ta.setSelectionRange(ns, ns + inner.length);
    };
    if (fmt === 'bold')        _wrap('**');
    else if (fmt === 'italic') _wrap('*');
    else if (fmt === 'head')   _linePrefix('# ');
    else if (fmt === 'ul')     _linePrefix('- ');
    else if (fmt === 'ol')     _linePrefix('1. ');
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
    const ta = document.querySelector('.sum-input');
    const text = ta ? ta.value.trim() : '';
    const imgs = summaryState.pendingImages.slice();
    const pendingMods = Object.keys(summaryState.pendingModuleValues || {});
    const hasNoteOrImg = !!text || imgs.length > 0;
    if (!hasNoteOrImg && !pendingMods.length) return;
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
    if (hasNoteOrImg) {
      const tags = _summaryParseTagsFromText(text);
      for (const tg of tags) _summaryEnsureTag(tg);
      if (!Array.isArray(state.summaries)) state.summaries = [];
      state.summaries.push({
        id: 'sum-' + Math.random().toString(36).slice(2, 10),
        createdAt: now, updatedAt: now,
        note: text, tags, images: imgs,
      });
    }
    summaryState.pendingImages = [];
    summaryState.pendingModuleValues = {};
    summaryState.draftNote = '';
    if (ta) ta.value = '';
    pushState();
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
    showSheet(`
      <div class="sheet-handle"></div>
      <div class="sheet-content">
        <div class="section-title" style="padding:0 0 8px;">编辑笔记</div>
        <label class="sum-edit-date-row">
          <span class="sum-edit-date-label">日期 / 时间</span>
          <input id="sum-edit-note-date" class="sum-edit-date-input" type="datetime-local" value="${dtLocal}">
        </label>
        <textarea id="sum-edit-note-text" class="sum-edit-note-textarea"
          data-action-input="summary-input-autosize"
          placeholder="备注、笔记…  输入 #xxx 自动加标签" rows="6">${esc(s.note || '')}</textarea>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button class="modal-btn" data-action="close-sheet" style="flex:1;">取消</button>
          <button class="modal-btn modal-btn-primary" data-action="summary-edit-note-save" data-id="${esc(id)}" style="flex:1;">保存</button>
        </div>
      </div>
    `, (body) => {
      // 聚焦 textarea 末尾 + autosize 初始化
      const ta = body.querySelector('#sum-edit-note-text');
      if (ta) {
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 360) + 'px';
      }
    });
  },
  // 保存编辑后的笔记 — note + createdAt + 重新解析 tags
  'summary-edit-note-save': (el) => {
    const id = el.dataset.id;
    const s = (state.summaries || []).find(x => x.id === id);
    if (!s) { closeSheet(); return; }
    const ta = document.getElementById('sum-edit-note-text');
    const dateInp = document.getElementById('sum-edit-note-date');
    const nextNote = ta ? ta.value : (s.note || '');
    let nextCreatedAt = s.createdAt;
    if (dateInp && dateInp.value) {
      const parsed = new Date(dateInp.value).getTime();
      if (Number.isFinite(parsed)) nextCreatedAt = parsed;
    }
    const dateChanged = nextCreatedAt && nextCreatedAt !== s.createdAt;
    const noteChanged = nextNote !== (s.note || '');
    if (!dateChanged && !noteChanged) { closeSheet(); return; }
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
    if (a && a.startsWith('summary-') && _summaryActions[a]) _summaryActions[a](el, e);
  });
  document.addEventListener('input', (e) => {
    const el = e.target.closest && e.target.closest('[data-action-input]');
    if (!el) return;
    const a = el.dataset.actionInput;
    if (a && a.startsWith('summary-') && _summaryActions[a]) _summaryActions[a](el, e);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest && e.target.closest('[data-action-change],[data-action]');
    if (!el) return;
    const a = el.dataset.actionChange || el.dataset.action;
    if (a && a.startsWith('summary-') && _summaryActions[a]) _summaryActions[a](el, e);
  });
  document.addEventListener('blur', (e) => {
    const el = e.target.closest && e.target.closest('[data-action-blur]');
    if (!el) return;
    const a = el.dataset.actionBlur;
    if (a && a.startsWith('summary-') && _summaryActions[a]) _summaryActions[a](el, e);
  }, true);
}
_bindSummaryGlobalDispatchers();

// 粘贴图片直接上传(textarea paste handler)
async function _summaryHandlePaste(ev) {
  const items = (ev.clipboardData && ev.clipboardData.items) || [];
  const imgItems = [];
  for (const it of items) if (it.type && it.type.startsWith('image/')) imgItems.push(it);
  if (!imgItems.length) return;
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
  if (okCount) {
    showToast(`已粘贴 ${okCount} 张`);
    renderAll();
  } else {
    showToast('粘贴失败');
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
  // 异步加载所有图(reuse 现成函数,但 lightbox 内不会有 .proj-tl-line / .dp-image-grid,不会再绑 click)
  track.querySelectorAll('img[data-cloud-file-id]').forEach(async (img) => {
    const url = await getCloudImageUrl(img.dataset.cloudFileId);
    if (url) img.src = url;
  });
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
  const addBtn = `<button class="proj-tl-add-btn" data-tl-add-proj="${esc(p.id)}">
    <span class="ico-plus"></span><span>加节点</span>
  </button>`;
  if (!nodes.length) {
    return `<div class="empty" style="padding:14px;">还没有节点</div>${addBtn}`;
  }
  return `<div class="proj-tl-line">${nodes.map(renderNode).join('')}</div>${addBtn}`;
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
      // 改 summaryTags
      const tg = (state.summaryTags || []).find(t => t.name === oldName);
      if (tg) tg.name = newName;
      // 改所有 summary 里的 tags 引用 + 笔记里 #oldName 文本
      for (const s of (state.summaries || [])) {
        if (Array.isArray(s.tags)) s.tags = s.tags.map(x => x === oldName ? newName : (x.startsWith(oldName + '/') ? newName + x.slice(oldName.length) : x));
        if (s.note) {
          const re = new RegExp('#' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
          s.note = s.note.replace(re, '#' + newName);
        }
      }
      pushState();
      closeSheet();
      renderAll();
    };
  });
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
  const pinnedHidden = sec.has('pinned');
  const allHidden = sec.has('all');
  body.innerHTML = `
    <button class="sum-nav-row sum-nav-row-main ${summaryState.filter==='all'?'active':''}"
      data-action="summary-filter" data-filter="all">
      <span class="ico-list"></span><span>全部笔记</span>
    </button>
    ${pinned.length ? `${sectionHead('pinned', '置顶标签')}
      ${pinnedHidden ? '' : pinned.map(renderTagRow).join('')}` : ''}
    ${tags.length ? `${sectionHead('all', '全部标签')}
      ${allHidden ? '' : tags.map(renderTagRow).join('')}` : '<div class="sum-nav-empty">还没有标签 — 写笔记时输入 #xxx 自动建立</div>'}
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
  // 根据当前 tab 决定渲染什么 — 摘要 tab 用 tag 侧栏,其它用任务清单导航
  if (ui.tab === 'summary') { _renderSummaryDrawerNav(); return; }
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
      <div class="dp-section dp-merged-section">
        <textarea class="dp-note-input" id="qe-note" rows="3" placeholder="备注、笔记…  输入 #xxx 自动加标签"></textarea>
        <div class="dp-merged-row" style="margin-top:8px;">
          <div id="qe-img-list" class="dp-image-grid" style="min-height:0;"></div>
          <label class="dp-merged-add-img" title="上传图片">
            <input type="file" accept="image/*" multiple id="qe-img-input" hidden>
            <span class="ico-plus"></span>
          </label>
        </div>
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
        done: false,
        doneAt: null,
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
