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
| `channel.mjs` | 每会话串行队列、`/stop` 取消、`/research` 注入、**两段式回复**（立即 ack + 完成后 `aibot_send_msg` 推送）、分段回复、结构化 outcome |
| `runtime.mjs` | 唯一的 Agent 执行面：`createAgentRuntime()` + 私有临时工作目录 + 空工具集 |
| `transport.mjs` | 官方 SDK 薄封装：订阅/心跳/重连交给 SDK；本层负责回复帧、字节上限、频率限制、`chat_type` 显式透传、超时 |
| `sessions.mjs` | 已知会话登记（命名空间键 `wecom:user:` / `wecom:group:`）：主动推送只允许已有入站会话 |
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
| `WECOM_ALLOWED_USER_IDS` | 启用外部工具时必填 | 空（不限制） | 单聊 sender `userid` 白名单，逗号分隔；**不是** Cloud Auth 授权（见 §2.1） |
| `WECOM_ALLOWED_CHAT_IDS` | 启用外部工具时必填（与上一条二选一） | 空（不限制） | 群聊 `chatid` 白名单，逗号分隔 |
| `WECOM_DENIED_REPLY` | 否 | 不回复 | 被白名单拒绝时的固定文案；默认不回复，避免白名单被探测 |
| `WECOM_WS_URL` | 否 | 不设置 | **不设置时使用 SDK 自己的默认端点**；仅用于排查或私有网关 |
| `WECOM_HEARTBEAT_INTERVAL_MS` | 否 | `30000` | 官方建议 30s |
| `WECOM_CONNECT_TIMEOUT_MS` | 否 | `20000` | 未完成认证即判启动失败 |
| `WECOM_REPLY_MAX_BYTES` | 否 | `20000` | 单段字节预算，上限 20480 |
| `WECOM_ACK_ENABLED` | 否 | `true` | 两段式 ack 开关；关闭退回"一次回调一次回复"（详见 §12） |
| `WECOM_ACK_TEXT` | 否 | `收到，这个要跑一会儿。跑完我直接发结论，中间不用等。` | 长任务 ack 文案（模板，非密钥；详见 §13） |
| `WECOM_ACK_MERGE_MS` | 否 | `1500` | ack 合并窗口：聊天回答在此窗口内完成则不发 ack；`0` 恢复"每条都 ack" |
| `WECOM_SINGLE_MAX_SEGMENTS` | 否 | `3` | 单聊回复最多分几段（超出用「（续 n/m）」+ 续发提示） |
| `WECOM_GROUP_MAX_SEGMENTS` | 否 | `1` | 群聊回复最多分几段（群聊不分段） |
| `WECOM_REPLY_TIMEOUT_MS` | 否 | `15000` | 单次发送/回复的硬超时 |

`WECOM_WS_URL` 故意不写死：**实测**真实订阅端点是 `wss://openws.work.weixin.qq.com`（直连，不走代理；
`aibot_subscribe` 返回 `errcode:0 / Authentication successful`，实测 ws_connected 192ms、subscribed 380ms），
与 SDK 源码默认值一致。实现仍不硬编码，缺省交给 SDK，需要覆盖时用该变量显式指定。

## 2.1 单租户委托下的授权边界（t29）

这一节回答一个问题：**谁能触发一次读取，以及那次读取消的是谁的身份。**

**事实一：V1 的所有 Guanlan 读取都使用维护者身份。** 云端是"维护者委托的单一 consumer 令牌"
（ADR-002；按账户的 X1–X4 是 Deferred）。机器人读到的每一条新闻，都是以维护者被授权的那个
consumer 身份读出来的，不存在"张三问就按张三的身份读"这条路径——因为 V1 还没有可用的
per-user 委托。

**事实二：白名单只决定"谁可以触发"，不决定"能读什么"。** `WECOM_ALLOWED_USER_IDS` /
`WECOM_ALLOWED_CHAT_IDS` 是本进程的**本地会话授权**：它只回答"这条消息能否启动一次 run"。
它**不是** Cloud Auth 授权，不授予账户、consumer 或工具权限；工具返回什么，仍由工具端的身份与
资源授权决定。两者的关系是"闸门"与"门里的东西"，不能互相替代。

**由此得到的硬性约束（t29 起强制）：** 只要外部工具被启用（`GUANLAN_MCP_URL` /
`GUANLAN_MCP_TOKEN` / `GUANLAN_MCP_TOKEN_FILE` 任一存在），WeCom 通道**必须**配置
`WECOM_ALLOWED_USER_IDS` 和/或 `WECOM_ALLOWED_CHAT_IDS`；两者都空时**进程拒绝启动**
（`wecom_config_error` → 退出码 2），错误信息会点名这两个变量。原因是这两种状态不能同时成立：
"任何能给机器人发消息的人都能触发一次 run" + "那次 run 用维护者身份读外部数据" =
任何一个被拉进测试群的第三方都能借维护者的身份拿到数据。

没有启用外部工具时（纯对话部署）保持原行为：不配白名单即不限制，因为此时 run 只能说话，
不触及任何外部身份。

**前提是"超管创建的机器人只服务于受控会话"。** ADR-002 §5 的单租户委托能成立，依赖两个部署侧
事实：一是机器人由**企业超级管理员**创建，`from.userid` 才是明文 `userid`（否则恒为 `open_userid`，
即 ADR-002 的 X4），本通道的会话路由键才可信；二是这个机器人**只被拉进受控的会话集合**。
本节的启动闸门不是这两个前提的替代品，而是把它们**变成可检查的**——一旦有人在没有白名单的情况下
把外部工具打开，进程不会"善意地"默认放行，而是直接起不来。

**被拒绝时发生什么：** 判定发生在 `decideWecomRoute()`，早于模型与工具：不建 run、不调模型、
不调工具，日志记一条 `wecom_channel_outcome` 结论行（`reason: user_not_allowed` /
`chat_not_allowed`，标识符经 `hashId()` 投影）。默认**不回**任何消息，避免把白名单当成可探测的
接口；需要给同事一个解释时用 `WECOM_DENIED_REPLY` 配一句固定文案。

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

**启动闸门**：外部工具已启用（Guanlan MCP 环境变量存在）但会话白名单为空时，进程**启动即失败**
（`wecom_config_error` → 退出码 2），见 §2.1。

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
| SDK 类型缺 `chat_type` | SDK 的 `SendMsgBody` 不声明该字段，但 `sendMessage(chatid, body)` 会把 `body` 原样展开进 `aibot_send_msg` 帧，因此**显式传** `chat_type`（1 单聊 / 2 群）：缺省时平台优先按群聊投递，会误投。`send()` 对未知 `chatType` 返回 `invalid_target`，不猜 |
| 回复要整帧不要 headers | `replyStream(frame, …)` 必须传**整个 callback frame**：SDK 内部读 `frame.headers.req_id`，只传 `frame.headers` 会得到空 `req_id`，平台返回 `846605 invalid req_id`（真实冒烟实测，测试用 `assert.equal(client.replies[0].frame, inbound)` 钉住） |
| 单连接互踢 | 新订阅会踢掉旧连接（旧连接收到 `disconnected_event`）；运行前必须确认没有其它进程/队友占用 |
| 身份边界 | `userid`/`open_userid` 只做通道级识别，**不映射** Cloud Account / Guanlan consumer / 工具权限。实测本机器人 `from_is_open_userid=false`（明文 `userid`，超管创建），实现两者都按不透明 id 处理 |

## 6. 未决与已知限制

1. **投递执行器已接线（本卡补完），live 待一次真实入站。** 按 lead 2026-11-04 裁决：
   `deliveryTargets` 增加 `wecom_user` / `wecom_chat` 两种目标，`SCHEDULER_CONTRACT_VERSION` 1→2，
   旧 v1 记录兼容读（见 §9 兼容矩阵）。约束遵守：未改飞书默认行为、未改
   `DELIVERY_CONTRACT_VERSION`（只新增错误码，见 §10.2）、未把 wecom 目标塞进 `^ou_`/`^oc_` 分支。
   `src/delivery/coordinator.mjs` 现在按目标类型分派 sender：飞书走 `sendMessage`，wecom 走通道
   transport（同一条长连接、同一份限流账本），**没有** wecom 目标会落到飞书 transport 上；
   未注册 sender 的类型仍以 `unsupported_target_type` 显式拒绝。
   离线链路（真实 scheduler + 真实 research 执行器 + 真实 run/delivery store）已绿；**真实企业微信
   定时投递**需要维护者先给机器人发一条消息（平台不允许向"机器人从未见过的会话"推送），
   执行记录见 §10.4。
2. **Live 需要真实凭证**：凭证由维护者写入本机私有文件，**只有** `npm run wecom:live` /
   `npm run wecom:wait-inbound` 会按 `KEY=VALUE` 读入进程环境变量；值不写入 `.env`、代码、
   fixture、日志或异常消息。离线测试一律用假值。
3. **去重与已知会话都是进程内**：重启或多实例后失效；持久化属于投递/会话工作项。
   因此投递侧有显式开关 `WECOM_DELIVERY_ALLOW_UNKNOWN_SESSION=1`：它只跳过本地预检，平台侧的前置
   条件仍然生效（平台会自己拒绝），失败会记成 `transport_error` 而不是静默丢弃（见 §10.2）。
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
| 通道离线测试 | `npm run test:wecom` | 86 passed / 0 failed（9 个测试文件：config、events/policy/dedupe、channel/text/sessions、transport、service/lock、runtime、live 脚本、W1 合同、投递接线） |
| 全仓回归 | `npm test` | 657 passed / 0 failed |
| 配置校验入口 | `npm run wecom:check` | 有凭证时 exit 0 并输出脱敏配置摘要；无凭证 exit 2 且列出缺失字段 |
| **真实链路（已执行）** | `npm run wecom:live` | 见 §8.1：真实入站 → 真实模型 → 平台接受回复，2.7s |
| 定时投递（离线链路） | `node --test tests/agt-036-delivery-wecom.test.mjs` | 15 passed：目标解析、未知会话、限流重试、20480 字节、命名空间隔离、组合根接线 |
| 定时投递（真实企业微信） | `npm run delivery:live` | 见 §10.4；**需要在窗口内有真实入站**，见 §12 |

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
- **不证明投递**：`wecom:live` 只覆盖"入站 → 回复"。定时研究主动投递的执行器接线尚未完成（见 §6.1）。
- **不持久化聊天 run**：`runId` 由 `src/runtime.mjs` 运行时生成，聊天 run 目前不落盘
  （run 落盘/`runId` 链路属于 AGT-037 trace 工作项），因此"读回"是进程内 outcome 而非 run store。

### `npm run wecom:wait-inbound`

维护者控时模式（t12 场景 A 的可控入口）：连上后只等一条真实入站，拿到任何终态结果就退出，
不要求回复被投递成功。

```bash
# 窗口由调用方决定；收到入站立即返回，不空转
npm run wecom:wait-inbound -- --timeout-ms 600000
```

退出码：`0` 处理到一条入站（结果见 JSONL），`1` 窗口内无入站或连接失败，`2` 配置/参数错误。
证据同时写 stdout 与 `--evidence` 指定的 JSONL（默认 `.work/wecom-channel/live-evidence.jsonl`）。

## 8.1 真实链路执行记录（2026-11-04）

命令：`npm run wecom:live -- --env-file D:\cloud-pi\.env --timeout-ms 1800000`

| 字段 | 值 |
| --- | --- |
| 结果 | `action:"replied"`, `ok:true`, 退出码 0 |
| `runId` | `5075459b-66bf-48b0-828c-b8ad00b80a01` |
| 模型 provider / model | `mira-ai` / `deepseek-v4.1-flash-od`（配置值，非密钥） |
| usage 输入 / 输出 token | **未采集**：该次运行用的是加入 token 投影之前的构建；新构建的 outcome 已带 `usage.{input,output,total}` 并由离线用例覆盖 |
| 回复分段 | 1 段（未截断），单段即完整回复，**非流式**（一次 `replyStream(finish=true)`） |
| 平台接受 | SDK 收到回执 `Reply ack received`；新构建把 `errcode` 投影为 `platformErrcode` |
| 端到端耗时 | 2726 ms（入站 → 回复被平台接受） |
| 会话类型 | `single`（单聊），`from_is_open_userid=false`（明文 `userid`，仅用于会话定位，**不映射** Cloud Account） |
| 连接 | `wss://openws.work.weixin.qq.com` 直连（无代理），握手 ~160ms，认证 ~130ms，心跳 30s |
| 入站顺序 | `event.enter_chat` 后约 3s 才 `aibot_msg_callback` |
| 脱敏 | 消息 id / chat id / userid 全部经 `hashId()`；无正文、无原始标识、无 secret |

**Trace 可读回性（如实）**：该 `runId` 只在本次进程的 outcome 与日志里。聊天 run 的落盘由
AGT-037 统一入口补上（`src/runs/chat-runs.mjs`），此后新运行的聊天 run 会写 run store；
Management API 的 run/delivery 查询只覆盖研究 run。因此"聊天 runId → API 读回"这条链在 AGT-037
之后部分成立，本文档不把研究 run 的读回混用来充当聊天 run 的证据。

## 9. W1：deliveryTargets 扩展与 `SCHEDULER_CONTRACT_VERSION` 1→2 兼容读

目标词表（`src/scheduler/contracts.mjs`）：

| `type` | 平台 | id 规则 | 说明 |
| --- | --- | --- | --- |
| `open_id` | 飞书 | `^ou_[A-Za-z0-9]+$` | AGT-033 原样保留 |
| `chat_id` | 飞书 | `^oc_[A-Za-z0-9_-]+$` | AGT-033 原样保留 |
| `wecom_user` | 企业微信 | `^[A-Za-z0-9_@.-]{1,64}$` | 单聊 `userid`；拒绝 `ou_`/`oc_` 前缀（跨平台串用） |
| `wecom_chat` | 企业微信 | `^[A-Za-z0-9_+/=@.-]{1,128}$` | 群 `chatid`；同上拒绝飞书前缀 |

未改动的东西（约束遵守证据）：`^ou_`/`^oc_` 两条正则与飞书拒绝分支保持不变；
`DELIVERY_CONTRACT_VERSION` 未动；飞书投递默认行为未改；未新增投递存储。

兼容矩阵（`tests/agt-036-w1-contracts.test.mjs` 逐条覆盖）：

| 磁盘记录版本 | 含 wecom 目标 | 可读 | 读后是否改写 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | 否（唯一真实历史形态） | 是 | 否，原样返回 v1 | 旧文件不会因读一次就变成 v2 |
| 1（人工编辑塞入 wecom） | 是 | 是 | 否 | 类型校验与版本无关，词典只增不减 |
| 2（新写入） | 可选 | 是 | — | `normalizeScheduleInput` 写 `contractVersion: 2` |
| 3（未来） | — | 否 | — | `parse_error`，启动即失败而不是静默丢调度 |

投递侧现状（本卡已接线）：`src/delivery/coordinator.mjs` 按目标类型分派 sender，wecom 目标走本通道
transport（见 §10）。未注册 sender 的类型（例如将来新增而尚未实现的类型）仍在发送前被过滤，并以
`reason:"unsupported_target_type"` 返回，**不会**把该平台的 id 交给另一个平台的 transport。

## 10. 投递执行器接线：定时研究终态 → 企业微信

### 10.1 一条投递怎么走

```
scheduler tick/runNow → research 终态 trigger
  → createDeliveringScheduler.deliverTrigger
    → coordinator.deliverRun({ runId, triggerStatus, researchStatus, schedule })
      → 目标按类型分派：open_id/chat_id → 飞书 sendMessage
                        wecom_user/wecom_chat → createWecomDeliverySender → transport.send → aibot_send_msg
      → 每个 (runId, destination) 一条投递记录（原子写）
```

关键设计取舍（为什么这样选、另一侧代价）：

| 选择 | 为什么 | 另一侧代价 |
| --- | --- | --- |
| 目标按类型分派 sender，而不是在 coordinator 里写 if/else | 飞书路径零改动；新通道只注册 sender，不需要编辑 coordinator 的分支 | coordinator 多一个可注入参数，需要文档说明"未注册 = 不支持" |
| 复用通道 transport，而不是另起一套推送客户端 | 一个机器人只有一条长连接（新连接会踢旧连接），另起连接会互相踢；限流账本也全局唯一 | 投递与回复共享 30/min、1000/h 配额，两者之和受限（平台规则本来如此） |
| 分段/重试/幂等键完全留在 coordinator | 与飞书同一套已验证语义，不出现两份策略 | wecom 侧不能自定义分段大小（沿用 `maxCharsPerSegment` 4000 字符） |
| 平台不回 message id，把稳定的 segment uuid 记为 `messageId`、平台回执记 `ack` | 幂等键仍可用于"重发判定"，同时留下真回执 | 记录里 `messageId` 不是平台 id，读者不能拿它去平台查询（文档已注明） |
| 未知会话默认拒绝，另给显式开关 | 平台硬前置是"用户先给机器人发过消息"，探测不到就拒绝比盲发诚实 | 进程重启后本地会话表为空，可能误拒平台其实接受的会话 → 需要 `WECOM_DELIVERY_ALLOW_UNKNOWN_SESSION=1` 由操作者显式放开 |

### 10.2 失败码（加法，`DELIVERY_CONTRACT_VERSION` 仍是 1）

只新增错误码枚举值，未改任何持久化字段或状态；旧读者读到不认识的 `lastError.code` 仍能正常展示
`status`/`attempts`，因此不需要升版本。

| code | 触发条件 | 可重试 | 说明 |
| --- | --- | --- | --- |
| `rate_limited` | 通道 transport 判定超出 30/min 或 1000/h | 是 | 仍受 `maxAttempts` 约束；重试耗尽终态为 `rate_limited` |
| `session_unknown` | 本地已知会话表里没有该会话（`no_prior_inbound` / `chat_type_mismatch`） | 否 | 不消耗重试预算：平台前置条件不满足，重试无意义；**绝不静默丢弃**，写记录并返回非 0 |
| `segment_too_large` | 单段 UTF-8 字节数 > 20480 | 否 | 发送前判定；不截断（截断的半篇报告比没有更糟） |
| `channel_unavailable` | 进程内该通道未运行（例如 `--channels feishu` 但调度里有 wecom 目标） | 否 | 配置类错误，记录而非崩溃 |
| 既有 `transport_error` | 其它 transport 失败（连接断开、超时、SDK 不可用映射） | 视 transport | 与飞书同一映射入口，保留原 transit 码到 message |

### 10.3 限流、分段与字节上限

| 约束 | 取值 | 落在哪 |
| --- | --- | --- |
| 每会话 30 条/分钟、1000 条/小时 | `WECOM_RATE_LIMITS` | `transport.mjs` 的 per-chat `sendHistory`（回复与推送共用同一账本） |
| 单条 ≤ 20480 字节（UTF-8） | `WECOM_MAX_CONTENT_BYTES` | 通道侧 `assertTextFits` + 投递侧 `segment_too_large` 双重判定（发送前） |
| 分段 | `DELIVERY_LIMITS.maxSegments=3`、`maxCharsPerSegment=4000` | coordinator（与飞书同一策略）；含 CJK 时 4000 字符 ≈ 12000 字节，低于 20480 |
| 幂等 | `${runId}#${type}:${id}` + 段 uuid | coordinator；重跑同一 run 不会重复推送已 sent 的段 |

### 10.4 live 验收入口：`npm run delivery:live`

一条命令完成"起进程 → 等一条真实入站 → 建调度（目标=该会话）→ 立即触发研究 → 投递回该会话 →
写证据"：

```bash
# 默认从 ~/.mira-secrets/wecom.env 取通道凭证、从 D:\cloud-pi\.env 取模型配置
npm run delivery:live

# 显式指定路径与超时；窗口内没有入站就以退出码 1 结束（不空转、不伪造）
node scripts/agt-036/delivery-live.mjs --secrets <path> --env-file <path> --inbound-timeout-ms 600000
```

| 阶段 | 通过标准 |
| --- | --- |
| 启动 | `agt036_delivery_started`（WeCom `authenticated`） |
| 入站 | 窗口内至少一条真实入站，取其 `chatId`/`chatType` 作为投递目标（**只**来自平台字段，不来自消息正文或模型输出） |
| 触发 | `scheduler.runNow` 返回 `runId`，研究跑到终态 |
| 投递 | `deliveryStatus:"sent"`、`segments≥1`、`acks[0]===0` |
| 证据 | JSONL 一行：`scheduleId/runId/targetType/destinationMasked/researchStatus/triggerStatus/deliveryStatus/segments/acks/attempts/durationMs`，无正文、无原始 id |

`--self-test` 只替换模型 port 与 transport（scheduler / research 执行器 / run store / 投递全是真的），
用于离线自检命令本身；它的 `mode` 字段是 `self-test`，**不作为真实链路证据**。

#### 试运行记录（2026-11-04 03:20–03:40 +08，未成功，如实记录）

| 项 | 值 |
| --- | --- |
| 命令 | `node scripts/agt-036/delivery-live.mjs --inbound-timeout-ms=1200000` |
| 连接 | `wss://openws.work.weixin.qq.com` 直连，`Authentication successful`（真实 bot_id/secret 被平台接受） |
| 入站 | **0 条**（20 分钟窗口内无任何真实入站；维护者当时已休息，无法配合发消息） |
| 结果 | harness 以退出码 1 结束：`ok:false, error:"timed out waiting for an inbound WeCom message"`，**没有**创建调度、**没有**发送任何消息、**没有**写成功证据 |
| 结论 | 投递代码路径已离线验证；真实企业微信投递仍**未验证**，见 §12 与 blocker |

重跑只需一条真实入站（任一单聊消息即可）：

```bash
npm run delivery:live -- --inbound-timeout-ms=600000
```

成功时 stdout 与 `.work/agt-036-delivery/live-evidence.jsonl` 会各出现一行
`agt036_delivery_live`，其中 `deliveryStatus:"sent"`、`acks:[0]`；失败时同一行带 `error`/`lastError`。

## 11. 脱敏修复：短 id 不再原样出现在投递视图

`maskId()`（飞书）对长度不足 6+4 的 id 会原样返回；企业微信 `userid`（例如 8 个字符）正好落在这个
缺口里，投递记录的 operator 视图与证据会把**原始 userid** 暴露出去。`maskDestination()` 现在检测
"掩码后与原文相同"并回退到 `hashId()`（`id:xxxxxxxx`）。飞书 id 都远长于窗口，行为不变。

## 12. 两段式回复：先 ack，再主动推送

### 12.1 为什么必须两段

回调帧里的 `req_id` 是**一次性、短时**的回复句柄：`replyStream(frame, …)` 只能在它过期前用它。
实测（2026-11-04，t26 群聊观测）里，回调回复窗口只有数秒量级，而一次真实模型/研究运行常常是秒级到分钟级。
把"等模型跑完再 `replyStream`"当成唯一出口，等于把长任务判死。

因此通道改成两段：

```text
入站回调 ──┬─► phase 1  ack：立刻 replyStream(frame, "已收到，正在处理…")
           │            （同一 req_id，秒内完成；<WECOM_ACK_TEXT> 可配）
           └─► 排队运行（同一会话串行，/stop 可取消）
                     │
                     └─► phase 2  final：aibot_send_msg → 同一会话（chat_type 显式）
```

两条证据行（`phase: "ack"` / `phase: "final"`）带**同一个 `requestId`（回调 `req_id`）**和同一个
哈希后的 `messageId`，可以无需求助第二个追踪系统就对起来。

### 12.2 通道与目标（不凭空构造）

| 入站 | 会话键 | `chat_type` |
| --- | --- | --- |
| 单聊 | `wecom:user:<userid>` | `1` |
| 群聊 | `wecom:group:<chatid>` | `2` |

- 推送目标**只来自产生这条入站的会话**：`channel.pushSegments()` 先查已知会话表
  （`assertDeliverable({chatId, chatType})`），不通过就**不碰网络**，终态 `action=failed`、
  `reason=no_prior_inbound`、`platformCode=93006`（平台"会话未知"语义）。会话键带命名空间，
  同一字符串同时是 userid 和 chatid 时不会串。
- 已知会话表仍由 service 在 `accepted` 时写入；通道自己**不写**，避免"自己给自己授权"。
- 只有 `push` 已接线时才启用两段式；没有 push 的老路径（例如只注入 `reply` 的调用方）保持
  "一次回调一次回复"，行为不变。

### 12.3 字节预算（20480 / 40058）

- 平台限制是 **UTF-8 字节**：`markdown.content ≤ 20480`。`splitForSend()` 按码点走、按字节停，
  默认预算 20000（留续段后缀空间），单段永不跨 UTF-8 序列。
- 推送前再显式校验一次 `Buffer.byteLength(segment) > 20480`：超限不硬发，报
  `segment_too_large` + `platformCode=40058`（平台"内容超长"语义），并在可能时降级为分段。
- `src/delivery/format.mjs` 的**按码点**默认值未改：飞书通道与投递契约不受影响。

### 12.4 配置项

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `WECOM_ACK_ENABLED` | `true` | 关闭后退回"一次回调一次回复"（只适合秒回场景） |
| `WECOM_ACK_TEXT` | `收到，这个要跑一会儿。跑完我直接发结论，中间不用等。` | 长任务 ack 文案；按字节同样受 20480 限制（t31 起，见 §13） |
| `WECOM_ACK_MERGE_MS` | `1500` | ack 合并窗口；`0` 恢复"每条都 ack"（t31 起，见 §13） |
| `WECOM_REPLY_MAX_BYTES` | `20000` | 单段预算（上限 20480） |

> §12.4 曾记录"**没有**实现 1.5 秒合并模式"，理由是"先跑模型、超时再回 ack"会出现 ack 与 final
> 同时发的窗口。t31 的实现方向相反：**收到消息时先挂一个 1.5s 定时器**，回答在窗口内完成就取消
> 定时器（`action=ack_suppressed`），超时才发 ack。这样 ack 与 final 严格互斥，不会同时出现；
> 且 `/research` 属于已知长任务，**不等窗口，立即 ack**。详见 §13.3。

### 12.5 离线验收

```bash
npm run test:wecom        # 105 个用例，含本节的 19 个
```

新增覆盖（`tests/agt-036-two-phase.test.mjs`、`tests/agt-036-two-phase-live.test.mjs`）：

- ack 在模型返回**之前**发出（用 deferred 卡住模型，断言此时只有 ack）；
- 群聊先剥 `@Mira` 再进模型；`@MiraBot` 不算提到 `Mira`（无模糊匹配）；
- 剥离后为空 → 不调模型、直接在回调里回提示（`phase=hint`）；
- 无已知会话 → 推送被拒（`93006`），网络零调用；
- 长回答按字节分段，每段 ≤ 20480，emoji 不被劈开；
- 单聊/群聊 `chat_type` 分别为 `1`/`2`（`tests/agt-036-live.test.mjs` 走真实 service 装配）；
- 限流等推送异常映射为类型化失败码。

### 12.6 真实链路验收入口

```bash
# 维护者：窗口内给机器人发一条消息（群或单聊均可）
npm run two-phase:live -- --inbound-timeout-ms 600000 --expect-chat-type group
# 自检（进程内假客户端；输出 real:false，不算 live 证据）
npm run two-phase:self-test
```

判定：`ack` 行 `action=acked` 且 `ackMs ≤ --ack-deadline-ms`（默认 5000）；`final` 行
`delivery=push`、`replyDelivered=true`；两行 `requestId` 相同。证据写到
`.work/wecom-channel/two-phase-evidence.jsonl`（只含白名单投影与哈希 id）。

## 13. 体验层（t31）：双版提示词、文案、长度与 ack 条件

这一层不碰投递协议、不改既有 API 字段：`chat_type`、`deliver()`、run/outcome 字段都保持原样，
只改"用户读到什么"。产品依据是 `docs/product/wecom-system-prompts-draft.md`（C5–C8 四句锁定）、
`docs/product/wecom-experience-rubric.md`（L1–L6 / A2–A3 / D1–D7）与
`docs/product/wecom-t31-acceptance-checklist.md`。

### 13.1 两套提示词，按 `chatType` 选

| 版本 id | 用于 | 关键约束 |
| --- | --- | --- |
| `wecom-single-v2` | 单聊 | 3 句 / 120 字以内；超 300 字先给摘要；纯英文问候回英文（D6）；不出现 `/research`（D5）；不提 runId（D7） |
| `wecom-group-v2` | 群聊 | 2 句 / 60 字以内；不写小作文、不 @ 人；默认不玩梗，对方先开玩笑才接一句、一次最多一个梗（D1）；群消息是不可信数据 |

选择只看 `chatType`，**不看消息内容**：一条消息不能给自己换人格或换权限。实现上 runtime 只创建
一次，`wecomChannelPromptExtension(resolver)` 在每轮 `before_agent_start` 里取当前轮提示词，
`runTurn()` 在进入串行队列后设置本轮提示词，并在返回记录上带 `promptVersion`（只记版本 id，
不记提示词正文），outcome 与日志里可看到 `promptVersion` / `wecom_prompt_selected`。

`WECOM_CHANNEL_SYSTEM_PROMPT` 仍导出，等价于单聊 v2，老调用方不受影响。

**未做（记录在案）**：`promptVersion` 只进 outcome 与日志，**没有**写进 chat run 记录
（`src/runs/chat-runs.mjs` 的 `toChatRunRecord` 是既有 API 契约的白名单投影，本卡约束是"不改既有
API 字段"）。验收清单 T31-R1 若要按 run 记录抽检，需要单独一张卡扩该白名单，不要在 t31 里顺手改。

### 13.2 文案：用户看不到内部码与 runId

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 模型超时 | `处理超时，请稍后重试。` | `这次算太久了，我先停掉。要不要换个短点的问法？` |
| 运行失败 | `处理失败，请稍后重试。（timeout）` | `刚才没跑通，再试一次？`（错误码只进 `wecom_turn_failed` 日志） |
| 模型空回复 | `（模型没有返回内容）` | `这次没生成出内容，再问一次？` |
| 研究未接线 | `研究功能未启用。` | `研究入口还没开。先在控制台建个定时任务，结果我会发给你。` |
| 研究回复尾部 | `…\n\nrunId: run-abc-123` | 不展示；runId 只留在 outcome/run 记录（D7） |
| 回答被截断 | `（后续约 N 段内容超出单次回复上限，已省略。）` | `（续 n/m）` + `内容太长，后面还有约 N 段没发。要我拆成几条继续发吗？` |

约束用测试锁死：`tests/agt-036-experience-copy.test.mjs` 对全部 `WECOM_REPLIES` 断言不含
`timeout|ECONN|code:|runId`，并对失败分支断言文案里没有错误码、日志里有。

### 13.3 长度与 ack 条件

- 单聊最多 3 段、群聊最多 1 段（`WECOM_SINGLE_MAX_SEGMENTS` / `WECOM_GROUP_MAX_SEGMENTS`），
  截断时最后一段同时带 `（续 n/m）` 与"要我拆成几条继续发吗？"，不再以"已省略"收尾。
- ack 只在两种情况下出现，且与 `deliver()` 严格互斥：
  1. `/research`（已知长任务）→ 收到即 ack；
  2. 聊天回答超出 `WECOM_ACK_MERGE_MS`（默认 1500ms）→ 定时器到期才 ack；
  回答在窗口内完成 → 取消定时器，只发回答（`action=ack_suppressed`、`reason=answered_within_merge_window`）。
- `WECOM_ACK_MERGE_MS=0` 恢复历史行为（每条 accepted 都 ack），用于真实链路取证脚本的自检。
- **A3c（10 s 安全网）由本实现覆盖**：判定"不 ack"的短问答最多等 1.5 s 就会改判为"要 ack"，
  因此不存在"既不 ack、又 10 s 无输出"的窗口，无需再补一条主动推送；曲线是"1.5 s 内只有终稿，
  超过 1.5 s 先 ack、再终稿"，A3a 与 A3b 的判据同时成立。

### 13.4 离线验收

```bash
npm test            # 724 个用例
npm run test:wecom  # 125 个用例，含本节 10 个
```

新增覆盖（`tests/agt-036-experience-copy.test.mjs`）：提示词按 `chatType` 选择且群聊更短、
每轮扩展渲染当前轮提示词、失败文案无内部码（正则）、全部文案无 runId、研究回复不展示 runId
但 outcome 保留、单聊 3 段/群聊 1 段上限、截断提示可执行、快速回答不发 ack（`ack_suppressed`）、
慢回答与 `/research` 发 ack、空回复文案。

## 14. 尚未验证 / 遗留

| 项 | 状态 | 说明 |
| --- | --- | --- |
| **单聊主动投递（真实企业微信）** | **未验证（blocker）** | 代码路径 + 通道认证已就绪；2026-11-04 03:20–03:40 的 20 分钟窗口内无任何真实入站，harness 以退出码 1 诚实结束（未建调度、未发消息）。需维护者在窗口内给机器人发任意一条消息后重跑 `npm run delivery:live` |
| 群聊主动投递 | 未验证 | 需要维护者提供一个测试群并把机器人拉进群；`wecom_chat` 分支离线已覆盖 |
| **两段式 ack→push（真实企业微信）** | **未验证（blocker）** | 离线链路 + 真实 service 装配（假客户端）全绿；真实群/单聊窗口内无入站，`two-phase:live` 未能产出 ack/final 两条真实证据。需维护者窗口内发一条消息后重跑 `npm run two-phase:live` |
| 群内 `@` 前缀与空消息提示 | 已实现（离线） | 剥 `@<WECOM_BOT_NAME>`、无模糊匹配、剥离后为空回提示；真实群聊窗口未触发 |
| 未知会话持久化 | 未做 | 已知会话表仍是进程内存；重启后需重新入站或显式开 `WECOM_DELIVERY_ALLOW_UNKNOWN_SESSION` |
| 验收判据对接 | 已就绪 | dev 的 `scripts/agt-03x/b-scheduled-research-delivery.mjs` 是**只读裁判**（读 Management API + 磁盘），本卡的 harness 是**生产者**；`--offline` 自检 7/7 通过。裁判的 B2 还要求研究链路真的调用 Guanlan MCP 工具，属 t9/t28 的真实 Guanlan 接线范围 |

