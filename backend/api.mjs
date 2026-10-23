import { hashPassword, hashToken, randomToken, verifyPassword, ITERATIONS } from './auth.mjs';

export { hashToken } from './auth.mjs';

const MINUTE = 60_000;
const DAY = 86_400_000;
export const rules = Object.freeze({ minMinutes: 15, maxMinutes: 120, stepMinutes: 15, maxBookings: 3, advanceDays: 7, timezone: 'Asia/Shanghai', pollSeconds: 60 });

const SESSION_TTL = 30 * DAY;
const ACCOUNT = Object.freeze({ min: 2, max: 32 });
const PASSWORD = Object.freeze({ min: 8, max: 128 });
const NAME = Object.freeze({ max: 20 });
const THROTTLE = Object.freeze({ window: 10 * MINUTE, limit: 8 });

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

const bearer = request => (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1] || '';
const cleanText = value => (typeof value === 'string' ? value.trim() : '');

function accountProblem(account) {
  if (account.length < ACCOUNT.min || account.length > ACCOUNT.max) return `账号需为 ${ACCOUNT.min}–${ACCOUNT.max} 个字符。`;
  if (/\s/.test(account)) return '账号不能包含空格。';
  if (/[\p{C}]/u.test(account)) return '账号包含无效字符。';
  return '';
}
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < PASSWORD.min || password.length > PASSWORD.max) return `密码需为 ${PASSWORD.min}–${PASSWORD.max} 个字符。`;
  return '';
}
function nameProblem(name) {
  if (!name) return 'ID 不能为空。';
  if (name.length > NAME.max) return `ID 最多 ${NAME.max} 个字符。`;
  if (/[\p{C}]/u.test(name)) return 'ID 包含无效字符。';
  return '';
}

// 杯身上的字属于部署配置：部署者在 wrangler.jsonc 的 vars.CUP_MARK 里填一个字符，
// 留空则杯子上不显示任何字。这里只取第一个字符，避免配置写多。
function cupMark(env) {
  const raw = typeof env?.CUP_MARK === 'string' ? env.CUP_MARK.trim() : '';
  const first = [...raw][0] ?? '';
  return /[\p{C}]/u.test(first) ? '' : first;
}

// 每个 isolate 内的轻量限速：同一账号连续失败过多时短暂拒绝，避免在线暴力猜密码。
const failures = new Map();
function pruneFailures(now) {
  if (failures.size < 500) return;
  for (const [key, entry] of failures) if (entry.reset <= now) failures.delete(key);
}
const throttleKey = account => account.toLowerCase();
function blocked(account, now) {
  const entry = failures.get(throttleKey(account));
  return Boolean(entry && entry.reset > now && entry.count >= THROTTLE.limit);
}
function recordFailure(account, now) {
  const key = throttleKey(account);
  const entry = failures.get(key);
  failures.set(key, entry && entry.reset > now
    ? { count: entry.count + 1, reset: entry.reset }
    : { count: 1, reset: now + THROTTLE.window });
  pruneFailures(now);
}

async function findMemberByAccount(db, account) {
  return db.prepare('SELECT id, account, display_name AS displayName, password_hash AS passwordHash, enabled FROM members WHERE account = ?')
    .bind(account).first();
}

async function createSession(db, memberId, now) {
  const token = randomToken();
  await db.prepare('INSERT INTO sessions (token_hash, member_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), memberId, now, now + SESSION_TTL).run();
  return token;
}

async function authenticate(request, db, now) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, '请先登录后再操作。');
  const member = await db.prepare(`SELECT m.id, m.account, m.display_name AS displayName, m.enabled
    FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token_hash = ? AND s.expires_ms > ?`)
    .bind(await hashToken(token), now).first();
  if (!member) throw new HttpError(401, '登录已失效，请重新登录。');
  if (!member.enabled) throw new HttpError(401, '该账号已被停用，请联系群主。');
  return { id: member.id, account: member.account, displayName: member.displayName };
}

async function readBody(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求。');
  // Bound the actual streamed body, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '缺少请求内容。');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2048) { await reader.cancel(); throw new HttpError(413, '请求内容过长。'); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder().decode(buffer));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, '请求内容不是有效的 JSON 对象。'); }
}

export function dayBounds(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD。');
  const start = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(start) || new Date(start + 8 * 3600000).toISOString().slice(0, 10) !== date) throw new HttpError(400, '日期无效。');
  return [start, start + DAY];
}

const fields = 'id, member_id AS memberId, start_ms AS startMs, end_ms AS endMs, planned_end_ms AS plannedEndMs';

export async function handleApi(request, env, clock = Date.now) {
  const now = clock();
  try {
    const url = new URL(request.url);
    // Prevent cross-origin browser writes; bearer credentials are never accepted in a URL/cookie.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, '请在本站页面操作。');
    const path = url.pathname;

    if (path === '/api/register' && request.method === 'POST') {
      const body = await readBody(request);
      const account = cleanText(body.account);
      const password = typeof body.password === 'string' ? body.password : '';
      const problem = accountProblem(account) || passwordProblem(password);
      if (problem) throw new HttpError(400, problem);
      if (await findMemberByAccount(env.DB, account)) throw new HttpError(409, '这个账号已经被注册了，换一个吧。', 'ACCOUNT_TAKEN');
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare('INSERT INTO members (id, account, password_hash, display_name, enabled, created_ms) VALUES (?, ?, ?, ?, 1, ?)')
          .bind(id, account, await hashPassword(password), account, now).run();
      } catch (error) {
        const detail = `${error.message} ${error.cause?.message || ''}`;
        if (detail.includes('members.account')) throw new HttpError(409, '这个账号已经被注册了，换一个吧。', 'ACCOUNT_TAKEN');
        if (detail.includes('members.display_name')) throw new HttpError(409, '这个账号名对应的 ID 已被他人使用，请换一个账号名。', 'NAME_TAKEN');
        throw error;
      }
      return json({ token: await createSession(env.DB, id, now), member: { id, account, displayName: account }, now }, 201);
    }

    if (path === '/api/login' && request.method === 'POST') {
      const body = await readBody(request);
      const account = cleanText(body.account);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!account || !password) throw new HttpError(400, '请输入账号和密码。');
      if (blocked(account, now)) throw new HttpError(429, '尝试次数过多，请 10 分钟后再试。', 'TOO_MANY_ATTEMPTS');
      const row = await findMemberByAccount(env.DB, account);
      // Verify against a dummy hash when the account is unknown so both paths cost the same.
      const checked = await verifyPassword(password,
        row ? row.passwordHash : `pbkdf2-sha256$${ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`);
      if (!row || !checked || !row.enabled) {
        recordFailure(account, now);
        throw new HttpError(401, row && !row.enabled ? '该账号已被停用，请联系群主。' : '账号或密码不正确。');
      }
      if (checked.iterations < ITERATIONS) {
        await env.DB.prepare('UPDATE members SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), row.id).run();
      }
      await env.DB.prepare('DELETE FROM sessions WHERE expires_ms <= ?').bind(now).run();
      return json({ token: await createSession(env.DB, row.id, now), member: { id: row.id, account: row.account, displayName: row.displayName }, now });
    }

    // 公开配置：页面未登录时也要能拿到杯身上的字。
    if (path === '/api/config' && request.method === 'GET') return json({ cupMark: cupMark(env), now });

    const member = await authenticate(request, env.DB, now);

    if (path === '/api/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(bearer(request))).run();
      return json({ ok: true, now });
    }

    if (path === '/api/session' && request.method === 'GET') return json({ member, rules, now });

    if (path === '/api/account' && request.method === 'PATCH') {
      const body = await readBody(request);
      if (body.displayName !== undefined) {
        const displayName = cleanText(body.displayName);
        const problem = nameProblem(displayName);
        if (problem) throw new HttpError(400, problem);
        try {
          await env.DB.prepare('UPDATE members SET display_name = ? WHERE id = ?').bind(displayName, member.id).run();
        } catch (error) {
          if (`${error.message} ${error.cause?.message || ''}`.includes('members.display_name')) throw new HttpError(409, '这个 ID 已经被其他群友使用了。', 'NAME_TAKEN');
          throw error;
        }
        member.displayName = displayName;
      }
      if (body.newPassword !== undefined) {
        const problem = passwordProblem(body.newPassword);
        if (problem) throw new HttpError(400, problem);
        const row = await env.DB.prepare('SELECT password_hash AS passwordHash FROM members WHERE id = ?').bind(member.id).first();
        if (!await verifyPassword(typeof body.currentPassword === 'string' ? body.currentPassword : '', row?.passwordHash)) {
          throw new HttpError(403, '当前密码不正确。', 'WRONG_PASSWORD');
        }
        await env.DB.prepare('UPDATE members SET password_hash = ? WHERE id = ?').bind(await hashPassword(body.newPassword), member.id).run();
        // 改密后让其他设备上的登录失效，只保留当前会话。
        await env.DB.prepare('DELETE FROM sessions WHERE member_id = ? AND token_hash <> ?')
          .bind(member.id, await hashToken(bearer(request))).run();
      }
      return json({ member, now });
    }

    if (path === '/api/schedule' && request.method === 'GET') {
      const date = url.searchParams.get('date') || new Date(now + 8 * 3600000).toISOString().slice(0, 10);
      const [start, end] = dayBounds(date);
      if (start < now - 8 * DAY || start > now + 8 * DAY) throw new HttpError(400, '仅支持查看最近一周和未来一周。');
      // One query gives a coherent snapshot: selected day + current use + next use + own upcoming.
      const { results } = await env.DB.prepare(`SELECT b.id, b.member_id AS memberId, b.start_ms AS startMs, b.end_ms AS endMs,
          b.planned_end_ms AS plannedEndMs, m.display_name AS memberName
        FROM bookings b JOIN members m ON m.id = b.member_id
        WHERE b.cancelled_ms IS NULL AND b.end_ms > ? AND b.start_ms < ? ORDER BY b.start_ms`)
        .bind(Math.min(start, now), Math.max(end, now + rules.advanceDays * DAY + rules.maxMinutes * MINUTE)).all();
      return json({ now, date, rules, member,
        current: results.find(b => b.startMs <= now && b.endMs > now) || null,
        next: results.find(b => b.startMs > now) || null,
        bookings: results.filter(b => b.startMs < end && b.endMs > start),
        mine: results.filter(b => b.memberId === member.id && b.endMs > now),
      });
    }

    if (path === '/api/bookings' && request.method === 'POST') {
      const body = await readBody(request);
      if (!Number.isInteger(body.durationMinutes) || body.durationMinutes < rules.minMinutes || body.durationMinutes > rules.maxMinutes || body.durationMinutes % rules.stepMinutes !== 0) {
        throw new HttpError(400, '单次预约为 15–120 分钟，时长须为 15 分钟的倍数。');
      }
      const startMs = body.startAt === 'now' ? now : body.startAt;
      if (!Number.isSafeInteger(startMs) || startMs < now || startMs > now + rules.advanceDays * DAY) throw new HttpError(400, '请选择当前时间至未来 7 天内的开始时间。');
      const endMs = startMs + body.durationMinutes * MINUTE;
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO bookings (id, member_id, start_ms, end_ms, planned_end_ms, created_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, member.id, startMs, endMs, endMs, now).run();
      return json({ booking: { id, memberId: member.id, memberName: member.displayName, startMs, endMs, plannedEndMs: endMs }, now }, 201);
    }

    const release = path.match(/^\/api\/bookings\/([a-zA-Z0-9-]{1,64})\/release$/);
    if (release && request.method === 'POST') {
      // Authorization, state check, and release happen in a single atomic UPDATE.
      const booking = await env.DB.prepare(`UPDATE bookings
        SET cancelled_ms = CASE WHEN start_ms >= ? THEN ? ELSE cancelled_ms END,
            end_ms = CASE WHEN start_ms < ? THEN ? ELSE end_ms END
        WHERE id = ? AND member_id = ? AND cancelled_ms IS NULL AND end_ms > ?
        RETURNING ${fields}, cancelled_ms AS cancelledMs`)
        .bind(now, now, now, now, release[1], member.id, now).first();
      if (!booking) throw new HttpError(404, '未找到可操作的预约，或预约不属于你。');
      return json({ booking: { ...booking, memberName: member.displayName }, now });
    }
    throw new HttpError(404, '接口不存在或请求方式不正确。');
  } catch (error) {
    const detail = `${error.message} ${error.cause?.message || ''}`;
    if (detail.includes('BOOKING_CONFLICT')) return json({ error: '这个时间段刚刚被预约了，请选择其他时间。', code: 'BOOKING_CONFLICT' }, 409);
    if (detail.includes('BOOKING_LIMIT')) return json({ error: '每人最多保留 3 个未结束的预约，请先完成或取消已有预约。', code: 'BOOKING_LIMIT' }, 409);
    if (error instanceof HttpError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    // Never log request headers, passwords, or database query parameters.
    console.error('Booking service: database or internal error');
    return json({ error: '服务暂时不可用，请稍后重试。' }, 503);
  }
}
