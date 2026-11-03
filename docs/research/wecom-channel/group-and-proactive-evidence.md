# 群聊 @ 与主动推送真实观测证据（t26）

> **状态：真实链路已执行（非 fixture）。** 执行时间 2026-11-04 02:01:49–02:03:18（UTC+8），
> 凭证由维护者提供，仅在进程内注入。
> 字段白名单：时间、耗时、`errcode`/`errmsg`、`chattype`、脱敏 `chatid`（首尾各 2 字符）、
> 发送者脱敏（首尾各 1 字符，5 位 id）、正文长度、是否含 `@` 前缀、字段名清单（只列 key）。
> **未记录**完整 `chatid`/`userid`、`msgid`、正文原文、凭证、客户端 IP。
> 关联：Issue #13、PR #23、[单聊冒烟证据](live-smoke-evidence.md)、[t6 交接 §7](t6-answers.md)。

## 0. 结论速览

| 验证项 | 结果 | 关键码 |
| --- | --- | --- |
| 群聊 @ 入站 | ✅ 真实到达 | `chattype=group`、`chatid` 可得（len=32）、带 `aibotid`/`msgid`/`response_url`、**无结构化 mention** |
| 群内回复（整帧 `replyStream`） | ✅ 被接受 | `errcode 0 / ok`（483 ms） |
| 主动推送 · 群（SDK 不带 `chat_type`） | ✅ 被接受 | `errcode 0 / ok`（294 ms） |
| 主动推送 · 群（原始帧 `chat_type=2`） | ✅ 被接受 | `errcode 0 / ok`（282 ms） |
| 主动推送 · 单聊（SDK 不带 `chat_type`） | ✅ 被接受 | `errcode 0 / ok`（280 ms） |
| 主动推送 · 单聊（原始帧 `chat_type=1`） | ✅ 被接受 | `errcode 0 / ok`（263 ms） |
| 不存在 chatid | ❌ 明确拒绝 | **`93006 invalid chatid`**（108 ms） |
| 21000 字节长文本 | ❌ 明确拒绝（非截断） | **`40058`** `body.markdown.content exceed max length 20480` |
| 3 条连发（限速探针） | ✅ 全部接受 | 3×`errcode 0`，**未触达限速阈值** |

## 1. 群聊 @ 入站（真实现场）

订阅：02:01:49.751 建连（175 ms）→ 02:01:49.884 认证（306 ms）→ **`errcode 0`**。

**群里 @Mira 一条文本**，02:03:16.180 到达（订阅后 86.6 s）：

| 观测点 | 实测值 |
| --- | --- |
| `chattype` | **`group`** |
| `chatid` | **有**，`wr****UA`（`len=32`；单聊没有此字段，见单聊证据） |
| `body` 顶层字段（仅字段名） | `aibotid`, `chatid`, `chattype`, `from`, `msgid`, `msgtype`, `response_url`, `text` |
| 是否有结构化 mention | **没有**（`body` 无 `mention`/`mentions` 字段） |
| `from` 字段（仅字段名） | `userid`（**明文**，`from_is_open_userid=false`） |
| 发送者脱敏 | `d****o`（`len=5`） |
| 正文长度 | 8 字节 |
| 正文是否以 `@Mira` 开头 | **是**（`text_has_at_bot_prefix=true`，`text_contains_at_bot=true`） |
| `req_id` | 有，`len=24` |

**要点**
1. 群里 `@机器人` **只体现为正文文本前缀**，平台不提供结构化的被 @ 对象列表；
2. `chatid` 是群会话的唯一键（32 位），**只在群消息里出现**；
3. `response_url` 真实存在（本次未使用，是 HTTP 回调回复的备用通道）；
4. 发送者仍是**明文 `userid`**（机器人由企业超管创建，与单聊证据一致）。

## 2. 群内回复

用**该 callback 的 `req_id`**、**整个 frame** 调 `replyStream`（见 [t6 §7](t6-answers.md)）：

| 项 | 值 |
| --- | --- |
| 回执时间 | 02:03:16.663（入站后 **483 ms**） |
| 回执 | **`errcode 0` / `errmsg: ok`** |
| 固定文案 | `Cloud Agent 冒烟：群聊与主动推送观测` |

结论：群消息的 `req_id` 与单聊同样可用于回复，**回复路径不需要 `chatid`**（`req_id` 即会话凭据）。

## 3. 主动推送（`aibot_send_msg`，不经入站）

四条对照，统一用 markdown 消息、同一固定文案（时间从 02:03:16.957 起）：

| # | 目标 | 帧形态 | 结果 |
| --- | --- | --- | --- |
| 3.1 | 群（`chatid`） | SDK `sendMessage(chatid, body)`（**不带** `chat_type`） | `errcode 0 / ok`（294 ms） |
| 3.2 | 群（`chatid`） | 原始帧 `{chatid, chat_type: 2}` | `errcode 0 / ok`（282 ms） |
| 3.3 | 单聊（`userid` 当 chatid） | SDK `sendMessage(userid, body)`（**不带** `chat_type`） | `errcode 0 / ok`（280 ms） |
| 3.4 | 单聊（`userid` 当 chatid） | 原始帧 `{chatid: userid, chat_type: 1}` | `errcode 0 / ok`（263 ms） |

**要点**
1. **不需要先有"本轮"入站**：本次主动推送发生在入站之后的同一连接内，平台接受
   （维护者此前已给机器人发过消息 → 会话存在；"必须已有会话"的约束仍然成立，见 §5）；
2. SDK 的 `sendMessage` **不带 `chat_type` 时对群和单聊都被接受**（与 t6 §5 基于文档的"默认按群聊处理"担忧不一致）——
   但**不能据此推断路由一定正确**：`errcode 0` 只证明平台受理。实现仍应显式带 `chat_type`
   （群 2 / 单聊 1），避免依赖默认值；
3. 单聊目标 = `userid` 直接当 `chatid`，与文档一致。

## 4. 边界与失败码

### 4.1 不存在的 chatid

- 帧：`{chatid: "nonexistent-smoke-chat-0001", chat_type: 2, ...}`
- 结果：**`errcode 93006` / `invalid chatid`**（108 ms），`errmsg` 附带 hint 与查询链接。
- 含义：目标必须来自**真实会话**，实现不能伪造或猜 `chatid`；失败是**即时拒绝**，不会静默丢弃。

### 4.2 超长消息（21000 字节）

- 帧：`{chatid, chat_type: 2, msgtype: "markdown", markdown: {content: 21000 字节}}`
- 结果：**`errcode 40058` / `body.markdown.content exceed max length 20480. invalid Request Parameter`**（100 ms）
- 含义：**平台是拒绝，不是截断**；实现必须自己按**字节**分段（`Buffer.byteLength`），
  不能依赖平台截断，也不能用 `str.length`。

### 4.3 限速（30 条/分钟/会话）

- 3 条连发（02:03:18.259 / .529 / .792，间隔约 270 ms）：**全部 `errcode 0`**。
- 结论：**限速在本轮未触达**，因此**不能**声称"限速已观测"。为不触发封禁，未刻意打满 30 条/分；
  实现侧仍需按文档假设 30/分 & 1000/小时设计退避，并把超限错误码作为未知项留待需要时再测。

## 5. 产品实现必须怎么做（约束清单）

1. **群会话键**：`chattype=group` 时用 `chatid`（32 位）；`chattype=single` 时没有 `chatid`，
   用 `from.userid`。统一成 `wecom:{chattype}:{chatid || userid}`，**不要**把 `userid` 当群键、也不要把 `chatid` 当用户身份。
2. **`@` 文本必须先剥离再送模型**：平台不给结构化 mention，正文形如 `@Mira 内容`；
   `@Mira` 只是显示名，机器人改名/群昵称/`@所有人` 都会影响判定。实现须：
   - 只剥离**开头**的 `@<WECOM_BOT_NAME>`（可容忍其后 1 个空格/全角空格）；
   - 剥离后若为空 → 记 `ignored:empty_after_mention_strip`，不调模型；
   - 不在正文中间做模糊匹配（避免误删用户内容），中间出现 `@Mira` 视为普通文本；
   - `WECOM_BOT_NAME` 必须可配置（本次实测 `Mira`），不能硬编码。
3. **回复用 `req_id`，不用 `chatid`**：群/单聊一致，必须传**整个 frame**（t6 §7.1）。
   `req_id` 只在短窗口内有效，收到即回，不要排队到模型跑完再回——模型耗时长时先回"正在处理"。
4. **主动推送目标只能来自已有会话**：`chatid`（群）或 `userid`（单聊）都必须从**真实入站**里取，
   平台对伪造目标返回 `93006`。Scheduler 投递必须维护"可投递会话表"，冷启动无会话 = 不可投递（ADR-001 C2）。
5. **`chat_type` 显式传**：群 `2`、单聊 `1`。实测不带也被接受，但那是平台默认行为，不是契约；
   显式传可避免"私聊被当群聊"的隐式风险。
6. **分段按字节**：`markdown.content` / `stream.content` 上限 20480 字节，超出**直接 40058 拒绝**；
   分段函数必须 `Buffer.byteLength(str,'utf8')`，中文 3 字节/字，群与单聊同规则。
7. **限速**：30 条/分/会话、1000/小时（文档），本轮未触达；实现要内置排队 + 退避，不要靠错误码反推。
8. **`response_url` 先不用**：群回调里有 `response_url`，可作为 HTTP 回复备通道；
   V1 维持长连接 `req_id` 单一路径，减少一条状态机分支。

## 6. 未验证 / 边界

- 群成员列表、群人数、`@所有人`、机器人改名后的前缀判定
- 主动推送给**从未入站**的会话（应为不可用，本轮未构造该场景）
- 30/分 限速的真实错误码（有意未打满）
- 群内流式回复（多次 `replyStream` 同一 `streamId`）与 10 分钟上限
- 图片/文件/语音/模板卡片在群里的表现
- 媒体上传后的 `media_id` 复用

## 7. 复现方式

1. 起一条长连接订阅（`aibot_subscribe`，`errcode 0`）；
2. 群里 `@<机器人名>` 发一条文本 → 取 `chatid`、`req_id`、`from.userid`；
3. 用 `req_id` 整帧 `replyStream` 回复 → 期望 `errcode 0`；
4. 用 `chatid` 按 `aibot_send_msg` 发群消息（`chat_type=2`）、用 `userid` 发单聊（`chat_type=1`）；
5. 用不存在的 `chatid`、超 20480 字节内容各发一次 → 期望 `93006` / `40058`；
6. 结束立即 `disconnect()`（本轮 02:03:18.793 断开，exit 0，无残留连接）。
