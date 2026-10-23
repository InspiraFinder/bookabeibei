// Optional end-to-end test against a disposable local Node or Wrangler instance.
// Registers a fresh throwaway account on every run. Never targets a remote deployment.
import assert from 'node:assert/strict';

const base = process.env.SMOKE_URL || 'http://127.0.0.1:8788';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Set a local-only SMOKE_URL pointing to an isolated test database.');
const created = [];
let token = '';
async function send(path, body, method = body ? 'POST' : 'GET') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}/api${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  return { status: response.status, ...(await response.json()) };
}
try {
  const page = await fetch(base);
  assert.equal(page.status, 200); assert.match(await page.text(), /杯杯/);
  assert.ok(page.headers.get('content-security-policy')?.includes("script-src 'self'"));
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  assert.equal((await send('/schedule', null, 'GET')).status, 401);

  const account = `smoke${Date.now().toString(36)}`;
  const registered = await send('/register', { account, password: 'smoke-test-pass' });
  assert.equal(registered.status, 201);
  token = registered.token;
  assert.equal(registered.member.displayName, account);
  assert.equal((await send('/login', { account, password: 'smoke-test-pass' })).status, 200);
  const renamed = await send('/account', { displayName: `smoke-${account.slice(-6)}` }, 'PATCH');
  assert.equal(renamed.status, 200);
  assert.equal((await send(`/account`, { displayName: account }, 'PATCH')).member.displayName, account);

  const session = await send('/session');
  assert.equal(session.status, 200);
  const config = await send('/config', null, 'GET');
  assert.equal(config.status, 200);
  assert.ok(Array.isArray(config.cups) && config.cups.length >= 1, '至少配置一只杯杯');
  const startAt = session.now + 45 * 60000;
  const attempts = await Promise.all(Array.from({ length: 8 }, () => send('/bookings', { startAt, durationMinutes: 30 })));
  for (const result of attempts) if (result.status === 201) created.push(result.booking.id);
  assert.equal(attempts.filter(result => result.status === 201).length, 1);
  assert.equal(attempts.filter(result => result.code === 'BOOKING_CONFLICT').length, 7);
  const schedule = await send('/schedule');
  assert.ok(schedule.mine.some(b => b.id === created[0]));
  assert.equal(schedule.mine.find(b => b.id === created[0]).memberName, account);
  if (config.cups[1]) {
    // 同一时段在另一只杯杯上互不影响。
    const other = await send('/bookings', { cup: config.cups[1].id, startAt, durationMinutes: 30 });
    assert.equal(other.status, 201);
    created.push(other.booking.id);
    const otherBoard = await send(`/schedule?cup=${config.cups[1].id}`);
    assert.ok(otherBoard.mine.some(b => b.id === other.booking.id));
    assert.ok(!otherBoard.mine.some(b => b.id === created[0]), '看板按杯杯隔离');
  }
  assert.equal((await send(`/bookings/${created[0]}/release`, null, 'POST')).status, 200);
  const immediate = await send('/bookings', { startAt: 'now', durationMinutes: 15 });
  assert.equal(immediate.status, 201); created.push(immediate.booking.id);
  assert.equal((await send('/schedule')).current.id, immediate.booking.id);
  const ended = await send(`/bookings/${immediate.booking.id}/release`, null, 'POST');
  assert.equal(ended.status, 200);
  assert.equal((await send('/schedule')).current, null);
  assert.equal((await send('/logout', null, 'POST')).status, 200);
  assert.equal((await send('/session')).status, 401);
  console.log('HTTP smoke passed: static assets + security headers + register/login + ID rename + cup list + per-cup schedules + 8 concurrent requests + schedule + cancel + immediate booking + early release + logout.');
} finally {
  for (const id of created) await send(`/bookings/${id}/release`, null, 'POST').catch(() => {});
}
