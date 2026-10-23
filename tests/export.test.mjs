import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../backend/sqlite.mjs';

const MINUTE = 60_000;
const exportScript = fileURLToPath(new URL('../backend/export.mjs', import.meta.url));

async function seed(dir) {
  const db = openDatabase(join(dir, 'booking.sqlite'));
  const now = Date.now();
  const addMember = async (id, account, displayName = account) =>
    db.prepare('INSERT INTO members (id, account, password_hash, display_name, enabled, created_ms) VALUES (?, ?, ?, ?, 1, ?)')
      .bind(id, account, '!', displayName, now).run();
  await addMember('m-alice', 'alice', 'Alice');
  await addMember('m-odd', 'odd', '带,逗号的"ID"');
  const insert = (id, member, start, end, planned, cancelled = null) =>
    db.prepare('INSERT INTO bookings (id, member_id, start_ms, end_ms, planned_end_ms, created_ms, cancelled_ms) VALUES (?,?,?,?,?,?,?)')
      .bind(id, member, start, end, planned, now - 60 * MINUTE, cancelled).run();
  await insert('b1', 'm-alice', now - 10 * MINUTE, now + 20 * MINUTE, now + 20 * MINUTE);
  await insert('b2', 'm-alice', now + 60 * MINUTE, now + 90 * MINUTE, now + 120 * MINUTE);
  await insert('b3', 'm-odd', now - 120 * MINUTE, now - 90 * MINUTE, now - 90 * MINUTE, now - 100 * MINUTE);
  db.close();
}

function runExport(dir, args) {
  const result = spawnSync(process.execPath, [exportScript, ...args], {
    encoding: 'utf8', env: { ...process.env, DATABASE_PATH: join(dir, 'booking.sqlite') },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('export writes a BOM-prefixed CSV with Beijing times, statuses and escaped group IDs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jb-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed(dir);
  const out = join(dir, 'bookings.csv');
  const stdout = runExport(dir, ['--out', out]);

  const csv = readFileSync(out, 'utf8');
  assert.ok(csv.startsWith('\uFEFF'), 'Excel needs a UTF-8 BOM');
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0], '预约ID,群友ID,账号,状态,开始时间(北京),结束时间(北京),计划结束时间(北京),实际时长(分钟),创建时间(北京),取消时间(北京)');
  assert.equal(lines.length, 4);
  assert.ok(lines.some(line => line.startsWith('b3,"带,逗号的""ID""",odd,已取消,')), 'group IDs must be CSV-escaped');
  assert.ok(lines.some(line => line.startsWith('b1,Alice,alice,使用中,')));
  assert.ok(lines.some(line => line.startsWith('b2,Alice,alice,待开始,')));
  assert.match(stdout, /共 3 条预约记录，其中未结束 2 条/);
  assert.doesNotMatch(csv, /[a-f0-9]{64}/, 'access-code hashes must never be exported');
});

test('export can emit JSON and reports an empty result without failing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jb-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'bookings.json');
  const stdout = runExport(dir, ['--format', 'json', '--out', out]);

  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), []);
  assert.match(stdout, /共 0 条预约记录/);
});
