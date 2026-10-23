import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { handleApi, hashToken } from '../backend/api.mjs';
import { cups } from '../backend/cups.mjs';
import { hashPassword } from '../backend/auth.mjs';
import { openDatabase } from '../backend/sqlite.mjs';

const NOW = Date.parse('2026-10-23T10:00:00+08:00');
const MINUTE = 60_000;
const DAY = 86_400_000;
const ALICE = 'm-alice', BOB = 'm-bob';
const aliceToken = 'a'.repeat(43), bobToken = 'b'.repeat(43);
const PASSWORD = 'correct-horse-battery';
const CUP_A = cups[0].id, CUP_B = cups[1]?.id;

async function addMember(DB, { id, account, displayName = account, enabled = 1, password = PASSWORD }) {
  await DB.prepare('INSERT INTO members (id, account, password_hash, display_name, enabled, created_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, account, await hashPassword(password), displayName, enabled, NOW).run();
}
async function addSession(DB, memberId, token, now = NOW) {
  await DB.prepare('INSERT INTO sessions (token_hash, member_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), memberId, now, now + 30 * DAY).run();
}
async function setup(t, filename = ':memory:') {
  const DB = openDatabase(filename); t.after(() => DB.close());
  await addMember(DB, { id: ALICE, account: 'Alice' });
  await addMember(DB, { id: BOB, account: 'Bob' });
  await addSession(DB, ALICE, aliceToken);
  await addSession(DB, BOB, bobToken);
  const call = async (path, { token = aliceToken, body, method = body ? 'POST' : 'GET', time = NOW, headers = {} } = {}) => {
    const response = await handleApi(new Request(`http://localhost/api${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { DB }, () => time);
    return { status: response.status, ...(await response.json()) };
  };
  return { DB, call };
}
const booking = (startAt = NOW + MINUTE, durationMinutes = 30) => ({ startAt, durationMinutes });

test('registration, login, logout and disabled accounts', async t => {
  const { DB, call } = await setup(t);
  assert.equal((await call('/session')).member.account, 'Alice');
  assert.equal((await call('/schedule', { token: '' })).status, 401);
  assert.equal((await call('/session', { token: 'x'.repeat(43) })).status, 401);

  const registered = await call('/register', { token: '', body: { account: 'carol', password: 's3cret-passphrase' } });
  assert.equal(registered.status, 201);
  assert.equal(registered.member.displayName, 'carol');
  assert.ok(registered.token.length >= 40);
  assert.equal((await call('/session', { token: registered.token })).member.account, 'carol');

  // 特征码1 不能重复，且不区分大小写。
  assert.equal((await call('/register', { token: '', body: { account: 'CAROL', password: 'another-passphrase' } })).code, 'ACCOUNT_TAKEN');
  assert.equal((await call('/register', { token: '', body: { account: 'dave', password: 'short' } })).status, 400);

  const login = await call('/login', { token: '', body: { account: 'carol', password: 's3cret-passphrase' } });
  assert.equal(login.status, 200);
  assert.equal(login.member.displayName, 'carol');
  assert.equal((await call('/login', { token: '', body: { account: 'carol', password: 'wrong-passphrase' } })).status, 401);

  assert.equal((await call('/logout', { token: login.token, method: 'POST' })).status, 200);
  assert.equal((await call('/session', { token: login.token })).status, 401);

  // 停用后既有会话立即失效。
  await DB.prepare('UPDATE members SET enabled = 0 WHERE id = ?').bind(ALICE).run();
  assert.equal((await call('/session')).status, 401);
});

test('a new account is refused when its default ID is already taken', async t => {
  const { call } = await setup(t);
  assert.equal((await call('/account', { token: bobToken, method: 'PATCH', body: { displayName: 'carol' } })).status, 200);
  const clash = await call('/register', { token: '', body: { account: 'carol', password: 'another-passphrase' } });
  assert.equal(clash.status, 409);
  assert.equal(clash.code, 'NAME_TAKEN');
  // 账号本身没被占用，换个名字就能注册。
  assert.equal((await call('/register', { token: '', body: { account: 'carol2', password: 'another-passphrase' } })).status, 201);
});

test('users can rename their own ID and the new name is what everyone sees', async t => {
  const { call } = await setup(t);
  const renamed = await call('/account', { method: 'PATCH', body: { displayName: '小艾' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.member.displayName, '小艾');
  assert.equal(renamed.member.id, ALICE);

  const created = await call('/bookings', { body: booking() });
  assert.equal(created.booking.memberName, '小艾');
  assert.equal((await call('/schedule')).current, null);
  assert.equal((await call('/schedule')).bookings[0].memberName, '小艾');

  assert.equal((await call('/account', { method: 'PATCH', body: { displayName: 'Bob' } })).code, 'NAME_TAKEN');
  assert.equal((await call('/account', { method: 'PATCH', body: { displayName: 'x'.repeat(21) } })).status, 400);
  assert.equal((await call('/account', { method: 'PATCH', body: { displayName: '   ' } })).status, 400);
});

test('changing the password needs the current one and revokes other sessions', async t => {
  const { call } = await setup(t);
  const otherDevice = await call('/login', { token: '', body: { account: 'Alice', password: PASSWORD } });
  assert.equal(otherDevice.status, 200);

  assert.equal((await call('/account', { method: 'PATCH', body: { newPassword: 'next-passphrase', currentPassword: 'wrong-one' } })).code, 'WRONG_PASSWORD');
  assert.equal((await call('/account', { method: 'PATCH', body: { newPassword: 'short', currentPassword: PASSWORD } })).status, 400);
  assert.equal((await call('/account', { method: 'PATCH', body: { newPassword: 'next-passphrase', currentPassword: PASSWORD } })).status, 200);

  assert.equal((await call('/session', { token: otherDevice.token })).status, 401, '其他设备应被登出');
  assert.equal((await call('/session')).status, 200, '当前会话应保留');
  assert.equal((await call('/login', { token: '', body: { account: 'Alice', password: PASSWORD } })).status, 401);
  assert.equal((await call('/login', { token: '', body: { account: 'Alice', password: 'next-passphrase' } })).status, 200);
});

test('repeated wrong passwords are throttled per account', async t => {
  const { call } = await setup(t);
  for (let i = 0; i < 8; i++) {
    assert.equal((await call('/login', { token: '', body: { account: 'Bob', password: 'wrong-passphrase' } })).status, 401);
  }
  assert.equal((await call('/login', { token: '', body: { account: 'Bob', password: PASSWORD } })).code, 'TOO_MANY_ATTEMPTS');
  assert.equal((await call('/login', { token: '', body: { account: 'Alice', password: PASSWORD } })).status, 200);
});

test('each cup keeps its own schedule, conflicts and three-booking limit', async t => {
  const { call } = await setup(t);
  const config = await call('/config', { token: '' });
  assert.equal(config.status, 200, '未登录也能读取杯杯列表');
  assert.deepEqual(config.cups.map(cup => cup.id), cups.map(cup => cup.id));
  assert.equal(config.cups[0].name, cups[0].name);

  const mine = await call('/bookings', { body: { cup: CUP_A, ...booking(NOW + 60 * MINUTE) } });
  assert.equal(mine.status, 201);
  assert.equal(mine.booking.cupId, CUP_A);

  if (CUP_B) {
    // 同一时段在另一只杯杯上互不影响。
    assert.equal((await call('/bookings', { token: bobToken, body: { cup: CUP_B, ...booking(NOW + 60 * MINUTE) } })).status, 201);
    // 同一只杯杯上仍然冲突。
    assert.equal((await call('/bookings', { token: bobToken, body: { cup: CUP_A, ...booking(NOW + 60 * MINUTE) } })).code, 'BOOKING_CONFLICT');

    // 看板按杯杯隔离，省略 cup 时用列表里的第一只。
    assert.equal((await call('/schedule')).cup.id, CUP_A);
    assert.equal((await call(`/schedule?cup=${CUP_A}`)).bookings.length, 1);
    assert.equal((await call(`/schedule?cup=${CUP_B}`)).bookings.length, 1);
  } else {
    assert.equal((await call('/schedule')).cup.id, CUP_A);
  }
  assert.equal((await call('/schedule?cup=nope')).status, 400);
  assert.equal((await call('/bookings', { body: { cup: 'nope', ...booking(NOW + 120 * MINUTE) } })).status, 400);

  // 每人每只杯杯各自最多 3 单。
  const created = [];
  for (let i = 2; i <= 3; i++) created.push(await call('/bookings', { body: { cup: CUP_A, ...booking(NOW + i * 60 * MINUTE) } }));
  assert.ok(created.every(result => result.status === 201));
  assert.equal((await call('/bookings', { body: { cup: CUP_A, ...booking(NOW + 6 * 60 * MINUTE) } })).code, 'BOOKING_LIMIT');
  if (CUP_B) assert.equal((await call('/bookings', { body: { cup: CUP_B, ...booking(NOW + 6 * 60 * MINUTE) } })).status, 201);
});

test('database prevents partial overlap, containment and equal intervals; adjacent intervals are allowed', async t => {
  const { call } = await setup(t);
  assert.equal((await call('/bookings', { body: booking(NOW + 60 * MINUTE, 60) })).status, 201);
  for (const [start, duration] of [[60, 60], [45, 30], [75, 30], [105, 30], [45, 120]]) {
    const result = await call('/bookings', { token: bobToken, body: booking(NOW + start * MINUTE, duration) });
    assert.equal(result.status, 409); assert.equal(result.code, 'BOOKING_CONFLICT');
  }
  assert.equal((await call('/bookings', { token: bobToken, body: booking(NOW + 120 * MINUTE) })).status, 201);
});

test('identity is server-controlled and another member cannot cancel a booking', async t => {
  const { call } = await setup(t);
  const created = await call('/bookings', { body: { ...booking(), memberId: BOB } });
  assert.equal(created.booking.memberId, ALICE);
  assert.equal((await call(`/bookings/${created.booking.id}/release`, { token: bobToken, method: 'POST' })).status, 404);
  assert.equal((await call('/schedule')).bookings.length, 1);
});

test('cancel frees a future reservation and cancellation is idempotent in effect', async t => {
  const { call } = await setup(t);
  const created = await call('/bookings', { body: booking() });
  assert.equal((await call(`/bookings/${created.booking.id}/release`, { method: 'POST' })).status, 200);
  assert.equal((await call(`/bookings/${created.booking.id}/release`, { method: 'POST' })).status, 404);
  assert.equal((await call('/schedule')).bookings.length, 0);
  assert.equal((await call('/bookings', { token: bobToken, body: booking() })).status, 201);
});

test('end early preserves planned end, frees remaining time, and never alters someone else’s booking', async t => {
  const { call } = await setup(t);
  const created = await call('/bookings', { body: booking('now') });
  assert.equal((await call('/schedule')).current.memberId, ALICE);
  const time = NOW + 5 * MINUTE;
  const result = await call(`/bookings/${created.booking.id}/release`, { method: 'POST', time });
  assert.equal(result.booking.endMs, time);
  assert.equal(result.booking.plannedEndMs, NOW + 30 * MINUTE);
  assert.equal((await call('/schedule', { time })).current, null);
  assert.equal((await call('/bookings', { token: bobToken, body: booking('now'), time })).status, 201);
});

test('release at exact start cancels without leaving a phantom active interval', async t => {
  const { call } = await setup(t);
  const created = await call('/bookings', { body: booking('now') });
  assert.equal((await call(`/bookings/${created.booking.id}/release`, { method: 'POST' })).status, 200);
  assert.equal((await call('/schedule')).current, null);
  assert.equal((await call('/bookings', { token: bobToken, body: booking('now') })).status, 201);
});

test('time and duration validation is enforced on the backend', async t => {
  const { call } = await setup(t);
  for (const duration of [0, 14, 16, 121, 135, '30', 30.5]) assert.equal((await call('/bookings', { body: booking(NOW + MINUTE, duration) })).status, 400);
  for (const start of [NOW - 1, NOW + 7 * DAY + 1, '2026-10-23', null, NOW + .5]) assert.equal((await call('/bookings', { body: booking(start) })).status, 400);
  assert.equal((await call('/bookings', { body: booking(NOW + 7 * DAY) })).status, 201);
  for (const date of ['2026-02-30', '2026-13-01', 'bad', '2026-01-01']) assert.equal((await call(`/schedule?date=${date}`)).status, 400);
});

test('three-reservation limit is atomic and capacity returns after cancellation or expiry', async t => {
  const { call } = await setup(t);
  const created = [];
  for (let i = 1; i <= 3; i++) created.push(await call('/bookings', { body: booking(NOW + i * 60 * MINUTE) }));
  assert.ok(created.every(r => r.status === 201));
  assert.equal((await call('/bookings', { body: booking(NOW + 5 * 60 * MINUTE) })).code, 'BOOKING_LIMIT');
  await call(`/bookings/${created[0].booking.id}/release`, { method: 'POST' });
  assert.equal((await call('/bookings', { body: booking(NOW + 5 * 60 * MINUTE) })).status, 201);
  assert.equal((await call('/bookings', { body: booking(NOW + 6 * 60 * MINUTE), time: NOW + 3 * 60 * MINUTE })).status, 201);
});

test('schedule uses half-open intervals and Beijing calendar days, including midnight crossings', async t => {
  const { call } = await setup(t);
  const start = Date.parse('2026-10-23T23:45:00+08:00');
  const created = await call('/bookings', { body: booking(start, 30) });
  const today = await call('/schedule?date=2026-10-23');
  const tomorrow = await call('/schedule?date=2026-10-24');
  assert.equal(today.bookings[0].id, created.booking.id);
  assert.equal(tomorrow.bookings[0].id, created.booking.id);
  assert.equal(today.current, null); assert.equal(today.next.memberId, ALICE);
  assert.equal((await call('/schedule', { time: start })).current.id, created.booking.id);
  assert.equal((await call('/schedule', { time: start + 30 * MINUTE })).current, null);
});

test('cross-origin writes and oversized request bodies are rejected', async t => {
  const { call } = await setup(t);
  assert.equal((await call('/bookings', { body: booking(), headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await call('/bookings', { body: { ...booking(), padding: 'x'.repeat(3000) } })).status, 413);
  assert.equal((await call('/bookings', { body: booking(), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/login', { token: '', body: { padding: 'x'.repeat(3000) } })).status, 413);
});

test('database trigger also protects against overlapping raw UPDATEs', async t => {
  const { DB, call } = await setup(t);
  await call('/bookings', { body: booking(NOW + 60 * MINUTE) });
  const second = await call('/bookings', { token: bobToken, body: booking(NOW + 120 * MINUTE) });
  await assert.rejects(DB.prepare('UPDATE bookings SET start_ms = ? WHERE id = ?').bind(NOW + 70 * MINUTE, second.booking.id).run(), /BOOKING_CONFLICT/);
});

test('data survives database reopen and passwords are stored only as salted hashes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jbb-persist-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'db.sqlite');
  let DB = openDatabase(filename);
  await addMember(DB, { id: ALICE, account: 'Alice', password: 'a-very-secret-passphrase' });
  await addSession(DB, ALICE, aliceToken);
  DB.close(); DB = openDatabase(filename);
  try {
    const row = await DB.prepare('SELECT account, password_hash AS passwordHash FROM members WHERE id = ?').bind(ALICE).first();
    assert.equal(row.account, 'Alice');
    assert.match(row.passwordHash, /^pbkdf2-sha256\$50000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.doesNotMatch(row.passwordHash, /a-very-secret-passphrase/);
    const response = await handleApi(new Request('http://localhost/api/session', { headers: { Authorization: `Bearer ${aliceToken}` } }), { DB }, () => NOW);
    assert.equal(response.status, 200);
  } finally { DB.close(); }
});

test('12 truly concurrent SQLite writers: exactly one wins the same slot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jbb-race-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'race.sqlite');
  const db = openDatabase(filename);
  for (let i = 0; i < 12; i++) {
    await db.prepare('INSERT INTO members (id, account, password_hash, display_name, enabled, created_ms) VALUES (?, ?, ?, ?, 1, ?)')
      .bind(`member${i}`, `member${i}`, '!', `member${i}`, NOW).run();
  }
  db.close();
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.filename);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    parentPort.once('message', () => {
      let result;
      try { db.prepare('INSERT INTO bookings (id, member_id, start_ms, end_ms, planned_end_ms, created_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run('booking' + workerData.i, 'member' + workerData.i, workerData.now, workerData.now + 1800000, workerData.now + 1800000, workerData.now); result = 'won'; }
      catch (e) { result = e.message.includes('BOOKING_CONFLICT') ? 'conflict' : e.message; }
      db.close(); parentPort.postMessage(result);
    });
    parentPort.postMessage('ready');
  `;
  const workers = Array.from({ length: 12 }, (_, i) => new Worker(source, { eval: true, workerData: { filename, i, now: NOW } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
  const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.postMessage('go'); })));
  assert.equal(results.filter(result => result === 'won').length, 1);
  assert.equal(results.filter(result => result === 'conflict').length, 11);
});
