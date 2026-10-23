# Cloudflare 免费计划部署

无需购买 VPS，默认使用平台子域名。

本仓库不包含任何 Cloudflare 账户、域名或数据库标识，所有资源都需要你在自己的账户下创建。

## 1. 安装部署工具与登录

本地运行不需要 npm 包；只有部署或 Cloudflare 模拟时需要安装 Wrangler。

```powershell
npm install
npx wrangler login
```

如果本机 npm 的全局路径异常，可使用 Node 安装目录中的 npm CLI：

```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install
```

后续 `npx wrangler ...` 也可换成 `node node_modules/wrangler/bin/wrangler.js ...`。

## 2. 创建 D1 并更新配置

```powershell
npx wrangler d1 create bookabeibei
```

将命令输出的 `database_id` 填入 `wrangler.jsonc`，替换 `REPLACE_WITH_YOUR_D1_DATABASE_ID`；保留 `binding: "DB"`。

```powershell
npx wrangler d1 migrations apply bookabeibei --remote
```

此迁移会建立 members / sessions / bookings 表、索引、防重叠触发器。之后增加数据库变更应新建编号迁移文件，备份后再执行。

## 3. 群友注册（无需预先配置）

注册由群友自己在网页完成，群主不需要发放任何凭证。部署完成后把链接发到群里，各自点击右上角「登录 / 注册」→「注册」，填写：

- **账号（特征码 1）**：全局唯一，不区分大小写，2–32 个字符。
- **密码（特征码 2）**：至少 8 位，服务端只存 PBKDF2-SHA256 加盐哈希。

注册后自动登录，可以在账号窗口里把显示 ID 改成自己的称呼。

需要封禁或重置密码时，用管理命令生成 SQL 再执行到线上 D1（`.gitignore` 已忽略 `members-*.sql`，脚本拒绝覆盖已有文件）：

```powershell
node backend/members.mjs disable 账号 --sql members-disable.sql
npx wrangler d1 execute bookabeibei --remote --file members-disable.sql

node backend/members.mjs reset 账号 --sql members-reset.sql   # 输出新密码，交给本人
npx wrangler d1 execute bookabeibei --remote --file members-reset.sql
```

查看线上账号列表：

```powershell
npx wrangler d1 execute bookabeibei --remote --command "SELECT account, display_name, enabled FROM members ORDER BY created_ms"
```

停用后，该账号不能再登录、读看板或操作预约，已有预约仍然保留。如需管理员释放，先从下面的查询获得预约 ID，再执行取消 SQL：

```powershell
npx wrangler d1 execute bookabeibei --remote --command "SELECT b.id, m.display_name, datetime(b.start_ms/1000, 'unixepoch', '+8 hours') AS beijing_start FROM bookings b JOIN members m ON m.id = b.member_id WHERE b.cancelled_ms IS NULL AND b.end_ms > unixepoch()*1000 ORDER BY b.start_ms"
npx wrangler d1 execute bookabeibei --remote --command "UPDATE bookings SET cancelled_ms = unixepoch()*1000 WHERE id = '替换为具体预约ID'"
```

## 4. 部署前后端

```powershell
node --test tests/*.test.mjs
npx wrangler deploy
```

Wrangler 会一起上传 `frontend/` 静态文件与 `backend/worker.mjs`，并绑定 D1。用部署输出的 HTTPS 链接登录测试，然后将链接发到群里。Cloudflare 中应保持 Workers **Free** 计划。

首次验收建议：

1. 两个独立浏览器分别注册两个账号并登录。
2. 在 A 预约一个时间段，B 选择重叠时段应失败。
3. A 取消后，B 可预约该时段。
4. “现在使用”成功后，刷新另一端，应显示使用者 ID 和起止时间。
5. A 不能取消 B 的预约。
6. A 在账号窗口改名后，B 刷新应看到新 ID。

## Wrangler 本地模拟

完成配置后，可以用实际 Workers / D1 模拟器运行：

```powershell
npx wrangler d1 migrations apply bookabeibei --local
npx wrangler dev
```

启动后在 http://127.0.0.1:8787（或 Wrangler 提示的端口）直接注册一个账号即可，不需要预先写入成员数据。

注意 `--local` 与 `--remote` 指向两个数据库；Node 本地入口则使用第三个独立 SQLite 文件，测试数据不会自动出现在云端。

## 导出与备份

导出成 CSV 给运营/对账用（不含密码哈希）：

```powershell
node backend/export.mjs --remote --out 预约记录.csv
```

完整数据库备份（含账号与密码哈希，注意保管）：

```powershell
npx wrangler d1 export bookabeibei --remote --output backup.sql
```

## 备份与维护

- 本地 Node 模式：停止进程后复制 `.data/booking.sqlite`；运行中不要只复制数据库主文件而遗漏 WAL。
- 线上 D1 导出：`npx wrangler d1 export bookabeibei --remote --output backup.sql`。备份包含账号与密码哈希，妥善保存，不要上传公开仓库。
- 监控 Workers 请求量及 D1 行读取/写入量；Free 达到限额时可能报错。界面会明确显示同步失败，不会将连接失败当成空闲。
- 历史预约持续保留。如群长期使用，可在备份后删除不再需要的历史数据；查询使用时间范围和索引，但存储仍会逐渐增长。
- 若群友反馈打不开默认域名，先核实其网络环境，再考虑自定义域名或其他部署环境。本地 Node 后端也可放在已有常开设备上，外部访问自行配置 HTTPS。
