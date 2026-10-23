// 群主的管理工具：查看账号、停用/启用、重置密码。
// 注册由群友自己在网站上完成，这里不再发放访问码。
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { hashPassword } from './auth.mjs';
import { openDatabase } from './sqlite.mjs';

const USAGE = `用法：node backend/members.mjs <list|disable|enable|reset> [账号] [--sql 文件]

  list            列出所有账号（本地数据库）
  disable 账号    停用账号，已有预约保留但无法继续登录
  enable 账号     恢复被停用的账号
  reset 账号      生成新的随机密码，旧密码立即失效
  --sql 文件      只导出 SQL，供 npx wrangler d1 execute <库> --remote --file <文件> 执行`;

const [command, account, ...args] = process.argv.slice(2);
const sqlIndex = args.indexOf('--sql');
const sqlFile = sqlIndex === -1 ? null : args[sqlIndex + 1];
const commands = ['list', 'disable', 'enable', 'reset'];
const validArgs = sqlIndex === -1 ? args.length === 0 : args.length === 2 && Boolean(sqlFile);
if (!commands.includes(command) || (command === 'list' ? account !== undefined : !account) || !validArgs) {
  console.error(USAGE); process.exit(1);
}
if (account && (account.length < 2 || account.length > 32 || /\s/.test(account) || /[\p{C}]/u.test(account))) {
  console.error('账号需为 2–32 个字符，且不能包含空格。'); process.exit(1);
}

if (command === 'list') {
  const db = openDatabase();
  const { results } = await db.prepare(`SELECT m.account, m.display_name AS displayName, m.enabled,
      (SELECT count(*) FROM bookings b WHERE b.member_id = m.id AND b.cancelled_ms IS NULL AND b.end_ms > ?) AS active
    FROM members m ORDER BY m.created_ms, m.account`).bind(Date.now()).all();
  db.close();
  if (!results.length) { console.log('还没有任何已注册账号。'); process.exit(0); }
  console.log(['账号', '显示 ID', '状态', '未结束预约'].join('\t'));
  for (const row of results) console.log([row.account, row.displayName, row.enabled ? '正常' : '已停用', row.active].join('\t'));
  process.exit(0);
}

const password = command === 'reset' ? randomBytes(12).toString('base64url') : null;
const statement = {
  disable: ['UPDATE members SET enabled = 0 WHERE account = ?;', [account]],
  enable: ['UPDATE members SET enabled = 1 WHERE account = ?;', [account]],
  reset: ['UPDATE members SET password_hash = ? WHERE account = ?;', [await hashPassword(password), account]],
}[command];
const [template, values] = statement;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

if (sqlFile) {
  let i = 0;
  writeFileSync(sqlFile, `${template.replace(/\?/g, () => quote(values[i++]))}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`SQL 已导出到 ${sqlFile}；需执行到 D1 后才生效。`);
} else {
  const db = openDatabase();
  const result = await db.prepare(template).bind(...values).run();
  db.close();
  if (!result.meta.changes) { console.error(`没有找到账号「${account}」。`); process.exit(1); }
  console.log({ disable: `已停用：${account}`, enable: `已启用：${account}`, reset: `已重置密码：${account}` }[command]);
}
if (password) console.log(`新的密码（仅显示一次，请单独交给本人）：\n${password}`);
