# AGT-036 WeCom 智能机器人 Channel

状态（2026-11-04）：**离线验收完成，Live 未执行**（维护者尚未提供 `BotID`/`Secret`）。
本文件说明配置、启动方式、真实/离线边界、已知限制与证据位置。研究结论见
`docs/research/wecom-channel/`（PR #23），集成面梳理见
`docs/engineering/agt-036-wecom-integration-notes.md`（本分支上一个 commit）。

## 1. 做了什么

新增 `src/channels/wecom/`：一个**通道**，不是 runtime。

| 模块 | 职责 |
| --- | --- |
| `config.mjs` | 从环境变量读取并校验通道配置；`describeWecomConfig()` 只回答"是否配置"；`hashId()` 为日志提供不可逆短标识 |
| `events.mjs` | 回调帧 → 可信字段（`chatId`/`chatType`/`senderType`/`text`/`dedupeKey`）；`stripBotMention()` 处理无结构化 mention 的现实 |
| `policy.mjs` | 模型调用之前的路由判定（fail-closed）：非用户来源、非文本、单聊白名单、群聊必须先 `@<botName>` |
| `dedupe.mjs` | 有界进程内去重（`msgid`，TTL 24h，上限 2048），在异步工作之前同步预留 |
| `text.mjs` | 按 **UTF-8 字节** 分段（平台上限 20480 B），不切断多字节字符 |
| `channel.mjs` | 每会话串行队列、`/stop` 取消、`/research` 注入、分段回复、结构化 outcome |
| `runtime.mjs` | 唯一的 Agent 执行面：`createAgentRuntime()` + 私有临时工作目录 + 空工具集 |
| `transport.mjs` | 官方 SDK 薄封装：订阅/心跳/重连交给 SDK；本层负责回复帧、字节上限、频率限制、单聊推送拒绝、超时 |
| `sessions.mjs` | 已知会话登记（`lastInboundAt`）：主动推送只允许已有入站会话 |
| `instance.mjs` | 单实例锁：每机器人只允许一条长连接，第二个进程必须启动失败而不是把第一个踢掉 |
| `service.mjs` / `server.mjs` / `index.mjs` | 装配、进程入口（JSON 行日志、退出码 0/1/2）、公开导出 |

明确**没有**做的事：

- 没有第二个 runtime、没有自造 WebSocket/JSON-RPC 客户端（协议与心跳由官方 SDK 负责）。
- 没有修改 `src/channels/feishu/*`、`src/delivery/*`、`src/scheduler/*`、`src/api/*` 的任何一行。
- 没有抽通用 Channel Port（与 AGENTS"Pi first / thin glue"及 ADR 一致）。

## 2. 配置

凭证只从环境变量读取，不写入任何文件、不进日志、不进模型上下文。
模型配置沿用既有 `src/config.mjs`（与 CLI 共用一套合同）。

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WECOM_BOT_ID` | 是 | — | 智能机器人 BotID |
| `WECOM_BOT_SECRET` | 是 | — | 智能机器人 Secret |
| `WECOM_BOT_NAME` | 群聊必填 | — | 机器人显示名；群聊只接受"文本以 `@<该名>` 开头"的消息 |
| `WECOM_ALLOWED_USER_IDS` | 否 | 空（不限制） | 单聊 sender `userid` 白名单，逗号分隔；**不是** Cloud Auth 授权 |
| `WECOM_ALLOWED_CHAT_IDS` | 否 | 空（不限制） | 群聊 `chatid` 白名单，逗号分隔 |
| `WECOM_WS_URL` | 否 | 不设置 | **不设置时使用 SDK 自己的默认端点**；仅用于排查或私有网关 |
| `WECOM_HEARTBEAT_INTERVAL_MS` | 否 | `30000` | 官方建议 30s |
| `WECOM_CONNECT_TIMEOUT_MS` | 否 | `20000` | 未完成认证即判启动失败 |
| `WECOM_REPLY_MAX_BYTES` | 否 | `20000` | 单段字节预算，上限 20480 |
| `WECOM_REPLY_TIMEOUT_MS` | 否 | `15000` | 单次发送/回复的硬超时 |

`WECOM_WS_URL` 故意不写死：**实测**真实订阅端点是 `wss://openws.work.weixin.qq.com`（直连，不走代理；
`aibot_subscribe` 返回 `errcode:0 / Authentication successful`，实测 ws_connected 192ms、subscribed 380ms），
与 SDK 源码默认值一致。实现仍不硬编码，缺省交给 SDK，需要覆盖时用该变量显式指定。

## 3. 启动

```bash
# 只校验配置与装配，不连网、不发消息（离线可跑）
npm run wecom:check

# 真实长连接（需要真实凭证）
npm run channel:wecom

# 真实链路验收：订阅 → 收一条入站 → 真实模型回复 → 读回证据（见 §8）
npm run wecom:live
```

退出码：`0` 干净停止，`1` 运行期失败（含认证失败），`2` 配置错误。日志是 stdout 上的 JSON 行，`event` 字段固定，标识符全部经 `hashId()` 投影，
不含消息正文、原始 `userid`/`chatid`、不含 secret。

认证失败的处理：SDK 把"订阅被拒"报成 `error` 事件（`853000` / `invalid bot_id`），
transport 据此立刻以 `auth_failed` 拒绝 `start()`，而不是干等连接超时。

## 4. 一条消息的处理路径

实测的入站顺序：先 `event.enter_chat`，约 **3 秒后**才有 `aibot_msg_callback`；回复必须用
**callback 那一帧**的 `req_id`（不是 enter_chat 的）。

1. `transport` 收到 SDK 的 `message` 事件 → 同步交给 `channel.handleEvent()`（**不 await 模型**，
   协议回执属于 SDK/transport，模型耗时不影响回执）。
2. `events.normalizeWecomMessageEvent()` 产出封闭字段集；无法回复的帧（无 `chatid` 的单聊、
   未知 `chattype`）直接丢弃。
3. `policy.decideWecomRoute()` 判定：非用户来源（`compat_info.source`）→ 拒；非文本 → 拒；
   单聊白名单 → 校验；群聊必须先 `@<botName>`，否则 `mention_required`。
4. `dedupe.reserve("wecom:msg:<msgid>")`：同步预留，重复回调不会触发第二次模型调用。
5. `/stop` → 取消该会话当前 run 并丢弃其排队任务（平台无取消原语，这是本地命令）。
6. 其余文本进入该会话的串行队列 → `runtime.runTurn()` → 分段回复到原会话（`replyStream`，
   按回调的 `req_id` 定位）。

`onOutcome` 与日志共用一份结构化 outcome：`action`（accepted/ignored/replied/cancelled/stopped/failed）、
`reason`、`status`、`runId`（研究回复正文里也带 `runId`，便于"消息 ↔ run"关联）、
`segments`/`segmentsDelivered`/`truncated`，以及哈希后的 id。

## 5. 硬约束与实现取值

| 约束 | 实现 |
| --- | --- |
| 单条 20480 **字节** | `splitForSend()` 按 UTF-8 字节切，段间加 `（续 N/M）`；超 8 段时末段追加省略说明 |
| 30 条/分、1000 条/时 | `transport` 按会话滑动窗口计数，超限抛 `rate_limited`（`retryable: true`，带 `retryAfter` 语义） |
| 每机器人 1 条连接 | 单实例锁（pid 存活检测 + 陈旧锁接管）；被踢下线只记日志，不静默重启循环 |
| 协议回执 5s（SDK 硬编码） | 回复超时 `WECOM_REPLY_TIMEOUT_MS`（默认 15s）单向兜底；超时**不重发**，避免重复投递 |
| 主动推送需先有入站 | `sessions.mjs` 记录 `lastInboundAt`；未知会话返回 `no_prior_inbound`，不盲目试发 |
| SDK 缺 `chat_type` | `send()` 对单聊目标直接拒绝（`chat_type_unsupported`），避免被平台按群聊误投 |
| 回复要整帧不要 headers | `replyStream(frame, …)` 必须传**整个 callback frame**：SDK 内部读 `frame.headers.req_id`，只传 `frame.headers` 会得到空 `req_id`，平台返回 `846605 invalid req_id`（真实冒烟实测，测试用 `assert.equal(client.replies[0].frame, inbound)` 钉住） |
| 单连接互踢 | 新订阅会踢掉旧连接（旧连接收到 `disconnected_event`）；运行前必须确认没有其它进程/队友占用 |
| 身份边界 | `userid`/`open_userid` 只做通道级识别，**不映射** Cloud Account / Guanlan consumer / 工具权限。实测本机器人 `from_is_open_userid=false`（明文 `userid`，超管创建），实现两者都按不透明 id 处理 |

## 6. 未决与已知限制

1. **W1（`deliveryTargets` 类型词表 + `SCHEDULER_CONTRACT_VERSION` 1→2）不在本卡实现。**
   lead 在 2026-11-04 裁决采用 W1，但 t6 合同同时要求"未改动 scheduler/delivery/api 的既有合同"，
   两者互斥。本卡选择遵守合同：`scheduler`/`delivery` 零改动，因此
   - 定时研究**还不能**投递到企业微信目标；
   - `transport.send()` 已实现能力与限制（群聊可发、单聊因 SDK 缺陷拒绝），但**没有**接线到投递链。
   W1 需要单独的工作项或明确覆盖 t6 合同后才能落地。
2. **Live 需要真实凭证**：凭证由维护者写入本机私有文件，**只有** `npm run wecom:live`
   会按 `KEY=VALUE` 读入进程环境变量；值不写入 `.env`、代码、fixture、日志或异常消息。
   离线测试一律用假值。
3. **去重与已知会话都是进程内**：重启或多实例后失效；持久化属于投递/会话工作项。
4. **群聊 `@` 判定依赖显示名**：机器人改名、群昵称、`@所有人` 会影响判定；无法解析时记
   `mention_required`，不猜测。
5. **流式回复未实现**：每段是一次完整回复（`finish=true`），与飞书一致；`msg_item`（图文混排）
   未使用（SDK 与文档在此不一致，见 `docs/research/wecom-channel/sdk.md` §5）。
6. **媒体未实现**：图片/语音/文件不进入模型，直接忽略（`unsupported_message_type`）。
7. **`/research` 需要注入 runner**：本卡只提供接缝（`runResearch`），进程入口尚未装配研究执行；
   研究装配属于 AGT-037 统一入口，避免在本卡复制研究策略。

## 7. 证据

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 通道离线测试 | `npm run test:wecom` | 61 passed / 0 failed（7 个测试文件：config、events/policy/dedupe、channel/text/sessions、transport、service/lock、runtime、live 脚本） |
| 全仓回归 | `npm test` | 见 PR 描述（含既有飞书、调度、API、投递测试） |
| 配置校验入口 | `npm run wecom:check` | 有凭证时 exit 0 并输出脱敏配置摘要；无凭证 exit 2 且列出缺失字段 |
| 真实链路 | `npm run wecom:live` | 见 §8；结果写入 PR 证据表（成功或失败都如实记录） |

真实证据只写白名单投影：`action/status/runId/segments/耗时` + 哈希 id，不写正文与原始标识。

## 8. Live 验收：`npm run wecom:live`

一条命令完成"订阅 → 收一条入站 → 真实模型回复 → 读回证据"：

```bash
# 默认从 ~/.mira-secrets/wecom.env 读通道凭证，从仓库 .env 读模型配置
npm run wecom:live

# 也可显式指定（值仍然只在进程内，不落盘）
node scripts/agt-036/wecom-live.mjs --secrets <path> --env-file <path> --timeout-ms 180000
```

行为与证据：

| 阶段 | 通过标准 | 失败时的输出 |
| --- | --- | --- |
| 启动 | `authenticated` 事件到达（真实 `bot_id`/`secret` 被平台接受） | `phase:"connect"` + `code`（`auth_failed`/`connect_timeout`） |
| 入站 | 窗口内出现一条可回复消息 | `phase:"wait_inbound"` + `reason:"no_inbound_message"` |
| 回复 | 真实模型产出内容并送达原会话（`replyDelivered:true`） | `phase:"reply"`，按 `outcome.action` 区分 `failed` |
| 读回 | `wecom_live_result` 行含 `runId`/`status`/`segments`/哈希 id | 退出码非 0 |

限制（如实声明）：

- **单连接**：平台同一机器人只允许一条长连接，运行前必须确认没有其它进程/队友占用
  （新连接会把旧连接踢下线，旧连接收到 `disconnected_event`）。
- **不证明投递**：`wecom:live` 只覆盖"入站 → 回复"。定时研究主动投递需要 W1（见 §6.1）。
- **不持久化聊天 run**：`runId` 由 `src/runtime.mjs` 运行时生成，聊天 run 目前不落盘
  （run 落盘/`runId` 链路属于 AGT-037 trace 工作项），因此"读回"是进程内 outcome 而非 run store。
