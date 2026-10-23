// 导出预约数据到 CSV / JSON。
// 默认读取本地 Node 数据库；加 --remote 时通过 Wrangler 读取线上 D1。
// 只导出预约与其群友 ID，不包含密码哈希。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './sqlite.mjs';
import { cups } from './cups.mjs';

const USAGE = `用法：node backend/export.mjs [--remote] [--out 文件] [--format csv|json] [--db 数据库名]

  --remote        导出线上 D1（需要已登录的 Wrangler）
  --out           输出文件，默认 exports/bookings-<本地时间>.csv
  --format        csv（默认，带 UTF-8 BOM，Excel 可直接打开）或 json
  --db            线上数据库名，默认 bookabeibei`;

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] || null;
};
const known = new Set(['remote', 'out', 'format', 'db']);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (!arg.startsWith('--') || !known.has(arg.slice(2))) { console.error(USAGE); process.exit(1); }
  if (arg !== '--remote') i += 1;
}

const format = (value('format') || 'csv').toLowerCase();
if (!['csv', 'json'].includes(format)) { console.error(USAGE); process.exit(1); }
const remote = flag('remote');
const databaseName = value('db') || 'bookabeibei';

const QUERY = `SELECT b.id, b.cup_id AS cupId, b.member_id AS memberId, b.start_ms AS startMs, b.end_ms AS endMs,
  b.planned_end_ms AS plannedEndMs, b.created_ms AS createdMs, b.cancelled_ms AS cancelledMs,
  m.display_name AS memberName, m.account AS memberAccount, m.enabled AS memberEnabled
FROM bookings b LEFT JOIN members m ON m.id = b.member_id
ORDER BY b.start_ms`;

// 杯杯名称来自部署配置 backend/cups.mjs，数据库里只存 cup_id。
const cupName = new Map(cups.map(cup => [cup.id, cup.name]));
const formatCup = booking => cupName.get(booking.cupId) ?? booking.cupId ?? '';

function runRemote(command) {
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', databaseName, '--remote', '--json', '--command', command], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.error) throw new Error(`无法调用 Wrangler：${result.error.message}\n请先执行 npm install。`);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end < start) throw new Error(`Wrangler 未返回预期结果，请先确认已登录：\n${output.trim().slice(0, 800)}`);
  let parsed;
  try { parsed = JSON.parse(output.slice(start, end + 1)); } catch { throw new Error(`Wrangler 输出无法解析：\n${output.trim().slice(0, 800)}`); }
  if (!Array.isArray(parsed) || !parsed[0]?.success) throw new Error(`查询失败：\n${output.trim().slice(0, 800)}`);
  return parsed[0].results || [];
}

async function runLocal() {
  const db = openDatabase();
  try {
    const { results } = await db.prepare(QUERY).bind().all();
    return results;
  } finally { db.close(); }
}

const byBeijing = ms => (ms == null ? '' : new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '));
const minutes = (from, to) => (from == null || to == null ? '' : Math.round((to - from) / 60000));

function status(booking, now) {
  if (booking.cancelledMs != null) return '已取消';
  if (booking.endMs <= now) return '已结束';
  if (booking.startMs <= now) return '使用中';
  return '待开始';
}

const escapeCsv = text => {
  let cell = String(text ?? '');
  // 防止被 Excel 当成公式执行。
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};

const HEADERS = ['预约ID', '杯杯', '群友ID', '账号', '状态', '开始时间(北京)', '结束时间(北京)', '计划结束时间(北京)', '实际时长(分钟)', '创建时间(北京)', '取消时间(北京)'];

function toRows(bookings, now) {
  return bookings.map(b => [
    b.id, formatCup(b), b.memberName ?? b.memberId, b.memberAccount ?? '', status(b, now),
    byBeijing(b.startMs), byBeijing(b.endMs), byBeijing(b.plannedEndMs),
    minutes(b.startMs, b.endMs), byBeijing(b.createdMs), byBeijing(b.cancelledMs),
  ]);
}

function stamp() {
  const d = new Date(Date.now() + 8 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

const bookings = remote ? runRemote(QUERY) : await runLocal();
const now = Date.now();
const rows = toRows(bookings, now);

const out = resolve(value('out') || fileURLToPath(new URL(`../exports/bookings-${stamp()}.${format}`, import.meta.url)));
mkdirSync(dirname(out), { recursive: true });
if (format === 'json') {
  writeFileSync(out, `${JSON.stringify(bookings.map((b, i) => Object.fromEntries(HEADERS.map((h, j) => [h, rows[i][j]]))), null, 2)}\n`, 'utf8');
} else {
  const csv = [HEADERS, ...rows].map(row => row.map(escapeCsv).join(',')).join('\r\n');
  writeFileSync(out, `\uFEFF${csv}\r\n`, 'utf8');
}

const active = bookings.filter(b => ['待开始', '使用中'].includes(status(b, now))).length;
console.log(`来源：${remote ? `线上 D1（${databaseName}）` : '本地数据库'}`);
console.log(`共 ${rows.length} 条预约记录，其中未结束 ${active} 条。`);
console.log(`已导出到 ${out}`);
if (!rows.length) console.log('（当前没有任何预约，文件只包含表头。）');
