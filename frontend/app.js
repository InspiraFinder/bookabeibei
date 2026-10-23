const $ = id => document.getElementById(id);
const MINUTE = 60_000;
const DAY = 86_400_000;
const storedToken = () => { try { return sessionStorage.getItem('jbb-token') || ''; } catch { return ''; } };
const state = { token: storedToken(), member: null, data: null, date: dateKey(Date.now()), mode: 'later', offset: 0, syncedAt: 0, busy: false, refreshing: false, view: 'board', phase: '' };
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' });
const weekdayFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' });
const now = () => Date.now() + state.offset;
function dateKey(time) { return new Date(time + 8 * 3600000).toISOString().slice(0, 10); }
function displayTime(time) { return timeFormat.format(time); }
function displayDate(time) { return dateFormat.format(time); }
function fullTime(time) { return `${displayDate(time)} ${displayTime(time)}`; }
function text(id, value) { $(id).textContent = value; }
function saveToken(value) { state.token = value; try { value ? sessionStorage.setItem('jbb-token', value) : sessionStorage.removeItem('jbb-token'); } catch { /* In-memory login still works. */ } }
function showError(id, message = '') { text(id, message); $(id).hidden = !message; }
let toastTimer;
function toast(message) { text('toast', message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }

class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
async function api(path, options = {}, token = state.token) {
  const headers = { Authorization: `Bearer ${token}` };
  if (options.body) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(`/api${path}`, { ...options, headers, cache: 'no-store', signal: AbortSignal.timeout(12000) }); }
  catch { throw new ApiError('网络连接失败，请检查网络后重试。', 0); }
  let data;
  try { data = await response.json(); } catch { throw new ApiError('服务响应异常，请稍后重试。', response.status); }
  if (!response.ok) throw new ApiError(data.error || '操作失败，请稍后重试。', response.status);
  if (Number.isFinite(data.now)) state.offset = data.now - Date.now();
  return data;
}

function resetIdentity() {
  saveToken(''); state.member = null; state.data = null; state.syncedAt = 0; state.phase = '';
  $('connection-banner').hidden = true;
  render();
}
function openLogin() { if (!$('login-dialog').open) { setAuthMode('login'); $('login-dialog').showModal(); } }
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  $('tab-login').setAttribute('aria-selected', String(!registering));
  $('tab-register').setAttribute('aria-selected', String(registering));
  text('auth-title', registering ? '第一次来，先注册。' : '欢迎回来，群友。');
  text('auth-hint', registering ? '设一个账号和密码，注册后就能预约。' : '用账号和密码登录，开始安排时间。');
  $('login-submit').firstChild.textContent = registering ? '注册并进入 ' : '登录 ';
  $('password-input').setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
  showError('login-error');
}
function renderIdentity() {
  text('identity-label', state.member ? state.member.displayName : '登录 / 注册');
  text('identity-avatar', state.member ? Array.from(state.member.displayName)[0] : '群');
  text('mine-count', state.data?.mine.length || 0);
  text('submit-label', state.member ? (state.mode === 'now' ? '确认，现在使用' : '确认预约') : '登录后预约');
}

function drawDates() {
  const today = dateKey(now());
  $('booking-date').min = today;
  $('booking-date').max = dateKey(now() + 7 * DAY);
  const root = $('date-strip'); root.replaceChildren();
  for (let i = 0; i <= 7; i++) {
    const day = Date.parse(`${today}T12:00:00+08:00`) + i * DAY;
    const key = dateKey(day);
    const button = document.createElement('button'); button.type = 'button';
    button.className = `date-button${state.date === key ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(state.date === key));
    button.setAttribute('aria-label', `${displayDate(day)} ${weekdayFormat.format(day)}`);
    const label = document.createElement('span'); label.textContent = i === 0 ? '今天' : weekdayFormat.format(day);
    const number = document.createElement('strong'); number.textContent = new Date(day + 8 * 3600000).getUTCDate();
    button.append(label, number);
    button.addEventListener('click', () => {
      if (state.date === key) return;
      state.date = key; $('booking-date').value = key; updateSummary(); drawDates();
      // Do not show a previous day's data under the new date while loading.
      renderSchedule(); refresh();
    });
    root.append(button);
  }
  text('today-label', `${displayDate(now())} · ${weekdayFormat.format(now())}`);
}

function currentBooking() {
  if (!state.data) return null;
  return [state.data.current, state.data.next, ...state.data.bookings].find(b => b && b.startMs <= now() && b.endMs > now()) || null;
}
function isStale() { return state.syncedAt && Date.now() - state.syncedAt > 90000; }
function renderStatus() {
  const current = currentBooking();
  const stale = isStale();
  const ready = state.member && state.data;
  $('status-pill').className = `status-pill${!ready || stale ? ' unknown' : current ? ' busy' : ''}`;
  text('status-label', !ready ? '等待登录' : stale ? '状态待确认' : current ? '预约使用中' : '现在空闲');
  text('status-overline', !ready ? '欢迎来到群友预约室' : stale ? '上次同步的预约状态' : current ? '这一刻的杯杯，属于' : '下一段好时光，等你开启');
  text('status-title', !ready ? '好时光，\n大家轮流享用。' : stale ? '稍等，正在重新连接。' : current ? current.memberName : '杯杯正在等你。');
  text('status-description', !ready ? '登录后，查看当前使用者和预约安排。' : stale ? '连接恢复后会自动更新，请以同步后的信息为准。' : current ? `还剩 ${Math.max(1, Math.ceil((current.endMs - now()) / MINUTE))} 分钟 · 预约到点自动释放` : '现在没有预约使用者，来约一段属于你的时间。');
  $('current-time').hidden = !current || stale;
  if (current) text('current-time', `${fullTime(current.startMs)} — ${dateKey(current.startMs) === dateKey(current.endMs) ? displayTime(current.endMs) : fullTime(current.endMs)}`);
  text('status-action', !ready ? '登录或注册 ↗' : stale ? '重新同步 ↻' : current?.memberId === state.member.id ? '提前结束，释放时间 ↗' : current ? '预约下一段时间 ↗' : '现在使用杯杯 ↗');
  const upcoming = state.data?.next;
  text('next-label', ready && upcoming && upcoming.startMs > now() ? `下一位：${upcoming.memberName} · ${fullTime(upcoming.startMs)}` : '一个杯杯，每次只属于一位群友。');
  text('sync-label', !ready ? '登录后同步' : stale ? '等待重连' : '每分钟同步');
  $('usage-progress').hidden = !current || stale;
  if (current) $('usage-progress-bar').value = Math.max(0, Math.min(100, 100 * (now() - current.startMs) / (current.endMs - current.startMs)));
}

function emptyState(title, description) {
  const wrap = document.createElement('div'); wrap.className = 'empty-state';
  const icon = document.createElement('span'); icon.className = 'empty-icon'; icon.textContent = '◷'; icon.setAttribute('aria-hidden', 'true');
  const heading = document.createElement('h3'); heading.textContent = title;
  const detail = document.createElement('p'); detail.textContent = description;
  wrap.append(icon, heading, detail); return wrap;
}
function reservationCard(booking, includeDate = false) {
  const active = booking.startMs <= now() && booking.endMs > now();
  const finished = booking.endMs <= now();
  const own = booking.memberId === state.member?.id;
  const row = document.createElement('article'); row.className = `reservation${active ? ' is-current' : ''}${own ? ' is-own' : ''}${finished ? ' finished' : ''}`;
  const times = document.createElement('div'); times.className = 'reservation-time';
  times.append(document.createTextNode(includeDate ? fullTime(booking.startMs) : displayTime(booking.startMs)));
  const end = document.createElement('span'); end.textContent = `至 ${dateKey(booking.startMs) !== dateKey(booking.endMs) ? fullTime(booking.endMs) : displayTime(booking.endMs)}`; times.append(end);
  const body = document.createElement('div'); body.className = 'reservation-body';
  const info = document.createElement('div'); info.className = 'reservation-info';
  const id = document.createElement('div'); id.className = 'reservation-id'; id.textContent = booking.memberName || '已注销群友';
  if (own) { const tag = document.createElement('span'); tag.className = 'booking-tag'; tag.textContent = '我'; id.append(tag); }
  const meta = document.createElement('div'); meta.className = 'reservation-meta';
  const duration = Math.ceil((booking.endMs - booking.startMs) / MINUTE);
  meta.textContent = `${active ? '预约使用中' : finished ? '已结束' : '已预约'} · ${duration} 分钟${booking.endMs < booking.plannedEndMs ? ' · 提前结束' : ''}`;
  info.append(id, meta); body.append(info);
  if (own && !finished) {
    const button = document.createElement('button'); button.className = 'release-button'; button.type = 'button';
    button.textContent = active ? '提前结束' : '取消预约'; button.disabled = state.busy;
    button.setAttribute('aria-label', `${active ? '提前结束' : '取消'} ${fullTime(booking.startMs)} 的预约`);
    button.addEventListener('click', () => releaseBooking(booking)); body.append(button);
  }
  row.append(times, body); return row;
}
function renderSchedule() {
  const root = $('schedule-list'); root.replaceChildren();
  const selected = Date.parse(`${state.date}T12:00:00+08:00`);
  text('schedule-date', `${displayDate(selected)} · ${state.data?.date === state.date ? state.data.bookings.length : '—'} 个预约`);
  if (!state.member) { root.append(emptyState('先和大家打个照面', '登录后，即可查看群友的预约安排。')); return; }
  if (!state.data || state.data.date !== state.date) { root.append(emptyState('正在同步安排', '预约以服务器最新数据为准。')); return; }
  if (!state.data.bookings.length) { root.append(emptyState('这一天，还很宽敞', '选个喜欢的时间，让好时光有个着落。')); return; }
  for (const booking of state.data.bookings) root.append(reservationCard(booking));
}
function renderMine() {
  const root = $('mine-list'); root.replaceChildren();
  const mine = state.data?.mine.filter(b => b.endMs > now()) || [];
  text('mine-count', mine.length);
  if (!state.member) { root.append(emptyState('你的时间，等你来安排', '点击右上角登录，查看自己的预约。')); return; }
  if (!mine.length) { root.append(emptyState('还没有未结束的预约', '回到预约看板，挑一个喜欢的时间吧。')); return; }
  for (const booking of mine) root.append(reservationCard(booking, true));
}
function render() { renderIdentity(); renderStatus(); renderSchedule(); renderMine(); }

let requestVersion = 0;
async function refresh() {
  if (!state.token) return;
  const version = ++requestVersion;
  const token = state.token;
  const date = state.date;
  state.refreshing = true; $('refresh-button').disabled = true;
  try {
    const data = await api(`/schedule?date=${date}`);
    if (version !== requestVersion || token !== state.token || date !== state.date) return;
    state.data = data; state.member = data.member; state.syncedAt = Date.now();
    $('connection-banner').hidden = true;
    render();
  } catch (error) {
    if (version !== requestVersion || token !== state.token) return;
    if (error.status === 401) { resetIdentity(); toast(error.message); }
    else { text('connection-banner', `${error.message} 页面会自动重试，也可以点击刷新。`); $('connection-banner').hidden = false; renderStatus(); }
  } finally {
    if (version === requestVersion) { state.refreshing = false; $('refresh-button').disabled = false; }
  }
}

function setView(view) {
  state.view = view;
  $('board-panel').hidden = view !== 'board'; $('mine-panel').hidden = view !== 'mine';
  for (const name of ['board', 'mine']) { $(`${name}-tab`).classList.toggle('selected', view === name); $(`${name}-tab`).setAttribute('aria-pressed', String(view === name)); }
  if (view === 'mine') renderMine();
}
function setMode(mode) {
  state.mode = mode;
  $('later-fields').hidden = mode === 'now'; $('now-tip').hidden = mode !== 'now';
  $('booking-date').required = mode !== 'now'; $('booking-time').required = mode !== 'now';
  for (const name of ['later', 'now']) { $(`mode-${name}`).classList.toggle('active', mode === name); $(`mode-${name}`).setAttribute('aria-pressed', String(mode === name)); }
  showError('booking-error'); updateSummary(); renderIdentity();
}
function selectedStart() { return state.mode === 'now' ? now() : Date.parse(`${$('booking-date').value}T${$('booking-time').value}:00+08:00`); }
function updateSummary() {
  const start = selectedStart();
  text('booking-end', Number.isFinite(start) ? fullTime(start + Number($('duration').value) * MINUTE) : '请选择开始时间');
}
function setBusy(value) { state.busy = value; $('submit-booking').disabled = value; renderMine(); renderSchedule(); }

$('booking-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.member) { openLogin(); return; }
  if (state.busy) return;
  showError('booking-error');
  const start = selectedStart();
  if (state.mode !== 'now' && (!Number.isFinite(start) || start < now())) { showError('booking-error', '开始时间已过去，请选择一个稍晚的时间，或切换“现在使用”。'); return; }
  setBusy(true);
  try {
    const data = await api('/bookings', { method: 'POST', body: JSON.stringify({ startAt: state.mode === 'now' ? 'now' : start, durationMinutes: Number($('duration').value) }) });
    state.date = dateKey(data.booking.startMs); drawDates();
    toast(`预约成功：${fullTime(data.booking.startMs)} — ${displayTime(data.booking.endMs)}。`);
    await refresh();
  } catch (error) {
    if (error.status === 401) { resetIdentity(); openLogin(); }
    showError('booking-error', error.status === 0 ? `${error.message} 提交结果可能尚未返回，请先刷新“我的预约”确认，再决定是否重试。` : error.message);
    if (error.status === 409) await refresh();
  } finally { setBusy(false); }
});

function confirmRelease(booking) {
  const active = booking.startMs <= now();
  text('confirm-title', active ? '提前结束这次使用？' : '取消这次预约？');
  text('confirm-description', `${fullTime(booking.startMs)} — ${fullTime(booking.endMs)}。确认后，剩余时段会立即开放给其他群友。`);
  $('confirm-dialog').showModal();
  return new Promise(resolve => {
    const finish = value => { $('confirm-dialog').close(); $('confirm-no').removeEventListener('click', no); $('confirm-yes').removeEventListener('click', yes); $('confirm-dialog').removeEventListener('cancel', cancel); resolve(value); };
    const no = () => finish(false), yes = () => finish(true), cancel = event => { event.preventDefault(); finish(false); };
    $('confirm-no').addEventListener('click', no); $('confirm-yes').addEventListener('click', yes); $('confirm-dialog').addEventListener('cancel', cancel);
  });
}
async function releaseBooking(booking) {
  if (state.busy || !(await confirmRelease(booking))) return;
  setBusy(true);
  try { await api(`/bookings/${booking.id}/release`, { method: 'POST' }); toast('已释放这段时间，谢谢你为下一位留出空间。'); await refresh(); }
  catch (error) { toast(error.message); if (error.status === 401) resetIdentity(); else await refresh(); }
  finally { setBusy(false); }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-submit').disabled = true; showError('login-error');
  const account = $('account-input').value.trim();
  const password = $('password-input').value;
  const registering = authMode === 'register';
  try {
    const data = await api(registering ? '/register' : '/login', { method: 'POST', body: JSON.stringify({ account, password }) }, '');
    saveToken(data.token); state.member = data.member;
    $('password-input').value = ''; $('login-dialog').close(); renderIdentity();
    await refresh();
    toast(registering ? `注册成功，欢迎你，${data.member.displayName}。` : `欢迎回来，${data.member.displayName}。`);
  } catch (error) { showError('login-error', error.message); }
  finally { $('login-submit').disabled = false; }
});
$('tab-login').addEventListener('click', () => setAuthMode('login'));
$('tab-register').addEventListener('click', () => setAuthMode('register'));
$('identity-button').addEventListener('click', () => {
  if (!state.member) { openLogin(); return; }
  text('account-name', state.member.account);
  $('display-name').value = state.member.displayName;
  $('current-password').value = ''; $('new-password').value = '';
  showError('id-error'); showError('password-error');
  $('account-dialog').showModal();
});
$('id-form').addEventListener('submit', async event => {
  event.preventDefault();
  const displayName = $('display-name').value.trim();
  if (!displayName) { showError('id-error', 'ID 不能为空。'); return; }
  if (displayName === state.member.displayName) { $('account-dialog').close(); return; }
  $('save-id').disabled = true; showError('id-error');
  try {
    const data = await api('/account', { method: 'PATCH', body: JSON.stringify({ displayName }) });
    state.member = data.member; render();
    await refresh();
    toast(`ID 已更新为 ${data.member.displayName}。`);
  } catch (error) { showError('id-error', error.message); }
  finally { $('save-id').disabled = false; }
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const currentPassword = $('current-password').value;
  const newPassword = $('new-password').value;
  if (!currentPassword || !newPassword) { showError('password-error', '请填写当前密码和新密码。'); return; }
  $('save-password').disabled = true; showError('password-error');
  try {
    await api('/account', { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) });
    $('current-password').value = ''; $('new-password').value = '';
    toast('密码已更新，其他设备上的登录已失效。');
  } catch (error) { showError('password-error', error.message); }
  finally { $('save-password').disabled = false; }
});
$('close-login').addEventListener('click', () => $('login-dialog').close());
$('close-account').addEventListener('click', () => $('account-dialog').close());
$('logout-button').addEventListener('click', async () => {
  $('account-dialog').close(); requestVersion++; state.refreshing = false; $('refresh-button').disabled = false;
  const token = state.token;
  resetIdentity();
  if (token) { try { await api('/logout', { method: 'POST' }, token); } catch { /* 本地已登出，忽略网络错误 */ } }
  toast('已退出登录。');
});
$('board-tab').addEventListener('click', () => setView('board'));
$('mine-tab').addEventListener('click', () => setView('mine'));
$('mode-later').addEventListener('click', () => setMode('later'));
$('mode-now').addEventListener('click', () => setMode('now'));
for (const id of ['booking-date', 'booking-time', 'duration']) $(id).addEventListener('change', updateSummary);
$('refresh-button').addEventListener('click', () => state.token ? refresh() : openLogin());
$('status-action').addEventListener('click', () => {
  if (!state.member) { openLogin(); return; }
  if (isStale()) { refresh(); return; }
  const current = currentBooking();
  if (current?.memberId === state.member.id) { releaseBooking(current); return; }
  setMode(current ? 'later' : 'now');
  $('booking-title').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  (current ? $('booking-time') : $('duration')).focus({ preventScroll: true });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { drawDates(); updateSummary(); refresh(); } });
window.addEventListener('online', refresh);

let lastToday = dateKey(now());
const initialStart = Math.ceil((now() + 5 * MINUTE) / (15 * MINUTE)) * 15 * MINUTE;
$('booking-date').value = dateKey(initialStart);
$('booking-time').value = displayTime(initialStart);
drawDates(); updateSummary(); render();
if (state.token) refresh();
setInterval(() => { if (!document.hidden && !state.refreshing) refresh(); }, 60000);
setInterval(() => {
  if (document.hidden) return;
  renderStatus(); if (state.mode === 'now') updateSummary();
  const current = currentBooking();
  const phase = `${current?.id || 'free'}:${state.data?.mine.filter(b => b.endMs > now()).length || 0}`;
  if (phase !== state.phase) { const hadPhase = state.phase; state.phase = phase; renderSchedule(); renderMine(); if (hadPhase && !state.refreshing) refresh(); }
  const today = dateKey(now());
  if (today !== lastToday) { lastToday = today; state.date = today; drawDates(); refresh(); }
}, 1000);
