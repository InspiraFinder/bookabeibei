# API

所有接口同域，基础路径 `/api`。除注册与登录外，都需要会话令牌：

```http
Authorization: Bearer <登录或注册返回的 token>
```

带请求体的接口另加 `Content-Type: application/json`。身份完全由服务端会话决定，客户端不提供可信的群友 ID。接口不开放跨域，不使用 URL 中的口令，也不使用隐式 Cookie 鉴权。

## 注册

`POST /api/register`

```json
{ "account": "特征码1", "password": "特征码2" }
```

- `account`：2–32 个字符，不能有空格或控制字符，全站唯一且**不区分大小写**。
- `password`：8–128 个字符，服务端以 PBKDF2-SHA256（随机盐，50000 轮）保存哈希。
- 新账号的显示 ID 默认等于账号，登录后可以修改。

成功返回 `201`：

```json
{ "token": "…", "member": { "id": "内部ID", "account": "特征码1", "displayName": "特征码1" }, "now": 1792720800000 }
```

账号已存在返回 `409 ACCOUNT_TAKEN`。

## 登录

`POST /api/login`

```json
{ "account": "特征码1", "password": "特征码2" }
```

成功返回 `200`，结构与注册相同。账号不存在、密码错误、账号被停用都返回 `401`（不透露是哪一种）。同一账号 10 分钟内失败 8 次后返回 `429 TOO_MANY_ATTEMPTS`。

## 退出登录

`POST /api/logout`：删除当前会话令牌，返回 `{ "ok": true }`。

## 获取身份和规则

`GET /api/session`

```json
{
  "member": { "id": "内部ID", "account": "特征码1", "displayName": "小杯" },
  "rules": { "minMinutes": 15, "maxMinutes": 120, "stepMinutes": 15, "maxBookings": 3, "advanceDays": 7, "timezone": "Asia/Shanghai", "pollSeconds": 60 },
  "now": 1792720800000
}
```

`id` 是内部不可变标识，`displayName` 是其他群友看到的 ID。所有时间戳使用 Unix **毫秒**，以服务端时钟为准；前端显示北京时间，并通过 `now` 校准显示时钟。

## 修改自己的账号

`PATCH /api/account`

```json
{ "displayName": "小杯" }
```

修改显示 ID：1–20 个字符，不能与他人重复，返回 `409 NAME_TAKEN` 表示被占用。

```json
{ "currentPassword": "旧密码", "newPassword": "新密码" }
```

修改密码：必须提供正确的当前密码，否则返回 `403 WRONG_PASSWORD`。改密成功后，除当前会话外的其他登录全部失效。两个字段可以在同一次请求中一起提交。

## 获取看板

`GET /api/schedule?date=2026-10-23`

`date` 按 UTC+8 解释，省略时默认服务端当前北京日期。响应包括：

- `now`、`date`、`member`、`rules`。
- `current`：当前预约或 `null`，条件 `startMs <= now < endMs`。
- `next`：下一条未来预约或 `null`，不局限于所选日期。
- `bookings`：与所选北京日期相交的预约，按开始时间升序。
- `mine`：当前用户未结束的预约，按开始时间升序。

预约对象：

```json
{
  "id": "uuid",
  "memberId": "内部ID",
  "memberName": "小杯",
  "startMs": 1792720800000,
  "endMs": 1792722600000,
  "plannedEndMs": 1792722600000
}
```

展示时用 `memberName`（用户自定义 ID），判断“是不是我”用 `memberId === member.id`。取消的预约不会出现在看板；提前结束的预约保留原 `plannedEndMs` 供核对。一次 SQL 读取提供一致的看板快照。

## 创建预约

`POST /api/bookings`

```json
{ "startAt": 1792720800000, "durationMinutes": 30 }
```

立即使用：

```json
{ "startAt": "now", "durationMinutes": 30 }
```

成功为 `201`，响应 `{ "booking": { ... }, "now": 1792720800000 }`。

开始时间须在 `[服务端现在, 现在 + 7 × 24h]` 内；结束允许延伸到第 7 天之后最多两小时。时长须为 15 的整数倍，范围 15–120。开始时间无需对齐 15 分钟刻度；前端选择精确到分钟，“现在使用”用服务器毫秒时间。任意重叠或超过每人 3 单上限返回 `409`。

区间采用 `[startMs, endMs)`：上一人 10:30 结束，下一人可从 10:30 开始。

## 取消 / 提前结束

`POST /api/bookings/:id/release`，无请求体。

- 未开始预约：标记取消，立即释放。
- 正在使用：把实际 `endMs` 缩短到当前服务端时间，保留原计划结束时间。
- 恰好在开始毫秒释放：直接取消，避免留下极短的占用。
- 已结束、已取消、不属于此人的预约：`404`。重复释放不会产生额外改变。

所有权、状态判断与写入在同一 SQL `UPDATE ... RETURNING` 中完成。

## 错误

```json
{ "error": "中文错误说明", "code": "BOOKING_CONFLICT" }
```

| 状态码 | 含义 |
| --- | --- |
| 400 | 参数无效、账号或密码不符合规则、JSON 格式错误 |
| 401 | 未登录、会话过期、账号或密码错误、账号被停用 |
| 403 | 请求 Origin 与本站不符；修改密码时当前密码不正确 |
| 404 | 路由不存在、预约不存在或无权限释放 |
| 409 | `ACCOUNT_TAKEN`、`NAME_TAKEN`、`BOOKING_CONFLICT` 或 `BOOKING_LIMIT` |
| 413 | 实际请求体超过 2 KB |
| 415 | 带请求体的接口没有使用 JSON |
| 429 | `TOO_MANY_ATTEMPTS` 登录失败次数过多 |
| 503 | 数据库或服务暂时不可用 |

所有 API 响应设置 `Cache-Control: no-store`，不向前端泄漏 SQL 或服务端错误详情。网络超时后的提交结果可能不确定，前端提示先刷新个人预约确认，避免盲目重复提交。
