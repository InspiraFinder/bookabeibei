import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../backend/sqlite.mjs';

test('upgrading an access-code database keeps booking history and retires unused identities', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jbb-migrate-'));
  const filename = join(dir, 'legacy.sqlite');
  const opened = [];
  t.after(() => {
    for (const db of opened) { try { db.close(); } catch { /* 已关闭 */ } }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // 旧版本的数据库：只有 0001 的表结构、两条访问码身份和一条历史预约。
  const legacy = new DatabaseSync(filename);
  legacy.exec('PRAGMA foreign_keys = ON;');
  legacy.exec(readFileSync(new URL('../backend/migrations/0001_init.sql', import.meta.url), 'utf8'));
  legacy.exec("INSERT INTO members (id, token_hash) VALUES ('旧群友', 'hash-1'), ('没人用过', 'hash-2')");
  legacy.exec("INSERT INTO bookings (id, member_id, start_ms, end_ms, planned_end_ms, created_ms) VALUES ('old', '旧群友', 1000, 1801000, 1801000, 500)");
  legacy.close();

  const db = openDatabase(filename); opened.push(db);
  const members = (await db.prepare('SELECT id, account, display_name AS displayName, enabled FROM members ORDER BY id').bind().all())
    .results.map(row => ({ ...row }));

  // 有历史预约的旧身份保留为停用占位，否则外键会悬空；没人用过的不留痕迹。
  assert.deepEqual(members, [{ id: '旧群友', account: 'legacy:旧群友', displayName: '旧群友', enabled: 0 }]);
  assert.equal((await db.prepare('SELECT member_id AS memberId FROM bookings').bind().first()).memberId, '旧群友');

  // 新表结构、会话表与防重叠触发器就位。
  assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").bind().first());
  const trigger = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bookings_no_overlap_insert'").bind().first();
  assert.match(trigger.sql, /BOOKING_CONFLICT/);
  assert.deepEqual((await db.prepare('SELECT name FROM schema_migrations ORDER BY name').bind().all()).results.map(row => row.name),
    ['0001_init.sql', '0002_accounts.sql', '0003_cup_mark.sql']);
  db.close();

  // 再次打开不会重复执行迁移。
  const again = openDatabase(filename); opened.push(again);
  assert.equal((await again.prepare('SELECT count(*) AS n FROM members').bind().first()).n, 1);
  assert.equal((await again.prepare('SELECT count(*) AS n FROM bookings').bind().first()).n, 1);
});
