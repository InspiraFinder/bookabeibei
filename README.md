# 杯杯 · 群友预约室

一个完整、可本地运行、可部署到 Cloudflare 免费计划的前后端项目。每个预约时段只能由一位群友占用。

## 已实现

- 当前预约使用者的 ID、起止时间、剩余时间、下一位群友。
- 北京时间未来 7 天的预约看板，以及个人未结束预约列表。
- 选择时间预约、立即使用、取消预约、提前结束。
- 15–120 分钟一单，以 15 分钟为时长单位；最多保留 3 单。
- 数据库触发器原子拦截重叠预约，覆盖同时提交、包含、部分交叉等情况；首尾相接允许预约。
- 群友自助注册：特征码 1 是账号（全局唯一，不区分大小写），特征码 2 是密码；不再需要群主发放访问码。
- 登录后可以随时修改自己的显示 ID 和密码；预约身份由服务端会话决定，不能在请求中冒用他人。
- 页面每 60 秒同步，可手动刷新，切回标签页时同步。超过 90 秒未成功同步时显示“状态待确认”。预约到点后自然结束，无需定时任务。
- 桌面和手机布局、键盘操作、错误提示与操作确认。

“使用中”表示**处于预约时段**，不代表已经检测到杯杯的实际使用情况。本系统负责排期；若还需阻止其他人实际使用杯杯，需要将杯杯的入口接入本项目的身份和时段校验。

## 目录与技术方案

```text
frontend/                前端：原生 HTML / CSS / JavaScript，无构建依赖
backend/api.mjs          后端：共用业务与鉴权，基于标准 Request / Response
backend/auth.mjs         密码哈希（PBKDF2-SHA256）与会话令牌
backend/worker.mjs       Cloudflare Workers 入口
backend/local.mjs        Node.js 本地 HTTP 入口，提供前端和 API
backend/sqlite.mjs       本地 SQLite 与 D1 兼容适配，按文件名顺序执行迁移
backend/members.mjs      群主管理工具：查看账号、停用/启用、重置密码
backend/export.mjs       导出预约数据到 CSV / JSON
backend/migrations/     数据表、索引和防冲突触发器
tests/                  业务、迁移、导出、持久化和真实并发写入测试
docs/                   方案、API 与部署说明
wrangler.jsonc          Cloudflare 部署配置
```

```text
群友浏览器 ── HTTPS ── Cloudflare 静态资源（frontend）
                       └─ /api/* → Worker（backend）→ D1（SQLite）

本地：浏览器 → Node.js（同一套 API + 静态资源）→ 本地 SQLite 文件
```

## 本地启动：无需安装 npm 依赖

需要 Node.js **22.13+**，建议 Node.js 24 LTS。`node:sqlite` 在某些 Node 版本可能显示实验性提示。

在项目目录打开 PowerShell，直接启动：

```powershell
node backend/local.mjs
```

打开 **http://127.0.0.1:8787**，点击右上角“登录 / 注册”，切到“注册”标签，输入你自己的账号（特征码 1）和密码（特征码 2）即可。注册后自动登录，ID 默认等于账号。

其他群友用同一个网址各自注册即可，不需要群主预先发放任何东西：

- **账号**（特征码 1）：2–32 个字符，不能有空格，全站唯一且不区分大小写。
- **密码**（特征码 2）：至少 8 位。服务端只保存 PBKDF2-SHA256 加盐哈希，明文不落库。
- 登录后在右上角账号窗口里可以把**显示 ID** 改成自己习惯的称呼（1–20 个字符，不能与他人重复），也可以改密码。

登录成功后服务端发放会话令牌，保存在当前浏览器标签页，30 天有效；退出登录或改密码会让其他设备上的会话失效。数据保存在 `.data/booking.sqlite`，服务重启后仍保留。

如需局域网测试：

```powershell
$env:HOST = "0.0.0.0"
node backend/local.mjs
```

群友通过此电脑的局域网 IP 访问，电脑必须保持运行。本地 HTTP 适合本机/可信局域网试用；正式群友访问使用下面的 HTTPS 部署。

可用环境变量：`HOST`、`PORT`、`DATABASE_PATH`。本地和 Wrangler 本地模拟使用**不同数据库**，不会自动同步；Wrangler 模式参考部署文档。

## 上线与费用

推荐 **Cloudflare Workers 静态资源 + Workers API + D1**，前后端同域，无需自购 VPS，也不强制购买域名。上线步骤见 [部署说明](docs/DEPLOY.md)。

截至 2026-10-23，官方免费计划列出：

| 项目 | 免费额度 |
| --- | --- |
| Workers 动态请求 | 每天 100,000 次 |
| Workers 静态资源请求 | 免费且不限量 |
| D1 行读取 | 每天 5,000,000 行 |
| D1 行写入 | 每天 100,000 行 |
| D1 存储 | 账户合计 5 GB |

例如 20 位群友每天各打开看板 1 小时，每 60 秒轮询，约 1,200 次看板 API 请求/日，另加登录与预约操作。D1 按**读取的行数**计量，不能把请求次数当作数据库行数；本项目使用索引并限制查询时间范围。免费额度与账户中的其他项目共享。Free 计划超额可能停止服务，不能承诺无限免费；不要为本项目主动升级 Paid 计划。

来源：[Workers 计费](https://developers.cloudflare.com/workers/platform/pricing/)、[静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)。

群友若主要在中国大陆，建议先用手机和常用网络实测 Cloudflare 访问情况。默认 `workers.dev` 域名的实际可达性需要按群友网络验证；可选自有域名但有额外域名费用。

## 导出预约数据

`backend/export.mjs` 把预约导出成 CSV（带 UTF-8 BOM，Excel 直接打开不乱码）或 JSON。默认读取本地数据库，加 `--remote` 读取线上 D1：

```powershell
node backend/export.mjs --remote                      # 线上，默认存到 exports/bookings-时间.csv
node backend/export.mjs --remote --out D:\预约.csv     # 指定路径
node backend/export.mjs --format json --out D:\预约.json
node backend/export.mjs                               # 本地 .data/booking.sqlite
```

导出列为：预约ID、群友ID、账号、状态（待开始/使用中/已结束/已取消）、开始时间、结束时间、计划结束时间、实际时长、创建时间、取消时间，时间均为北京时间。`结束时间` 是实际释放的时刻，提前结束会早于 `计划结束时间`。**只导出预约与群友 ID，不包含密码哈希**；`--remote` 需要先 `npx wrangler login`。

## 群主管理命令

注册由群友自己完成，群主一般不需要干预。需要封禁或重置密码时：

```powershell
node backend/members.mjs list              # 本地数据库里的账号、ID、状态、未结束预约数
node backend/members.mjs disable 账号       # 停用：立即失效登录，已有预约保留
node backend/members.mjs enable 账号        # 恢复
node backend/members.mjs reset 账号         # 生成新的随机密码，旧密码立刻失效
```

线上数据库加 `--sql 文件` 导出 SQL，再用 Wrangler 执行（脚本会拒绝覆盖已存在的文件）：

```powershell
node backend/members.mjs disable 账号 --sql members-disable.sql
npx wrangler d1 execute bookabeibei --remote --file members-disable.sql
```

## 验证

```powershell
node --test tests/*.test.mjs
```

测试覆盖注册与账号唯一性、登录与密码校验、失败次数限速、修改 ID 与密码、会话失效、禁止冒用身份、他人预约保护、重叠及相邻时段、3 单限制、取消与提前结束、到点释放、跨午夜、无效输入、跨域与体积限制、持久化、旧库升级迁移、数据导出，以及 **12 个独立线程同时抢一个时段**。前后端通过同一 `api.mjs` 执行业务。

## 后续调整

- 预约时长、提前天数、预约上限目前是代码规则。修改 `backend/api.mjs`、数据库约束/触发器和前端文案时保持一致；线上已有数据库应新增迁移，不能只改已执行的迁移文件。
- 账号由群友自己注册，不是 QQ/微信官方身份验证；谁掌握账号密码就能代表该身份使用预约。密码泄露请立刻在账号窗口修改，或由群主停用账号。
- 本项目不集成群机器人通知、付费短信、邮件或硬件控制。已包含的 UI 和 API 可作为这些功能的基础。

详细接口见 [API 文档](docs/API.md)，决策与边界见 [设计方案](docs/DESIGN.md)，本次验证结果见 [验收记录](docs/VALIDATION.md)。
