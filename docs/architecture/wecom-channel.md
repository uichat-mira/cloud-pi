# WeCom（企业微信）Channel 架构

> **状态：设计提议，不是已实现架构。** 截至 2026-11-04，仓库中**没有** `src/channels/wecom/`，
> 也没有任何企业微信代码。本文把 `docs/research/wecom-channel/` 的研究结论固化成可实现的形状，
> 每一段都标注"现有代码入口"与"计划新增文件"，供 t5/t8 实现、维护者裁决。
>
> 关联：Issue #13、PR #23、[研究结论](../research/wecom-channel/README.md)、
> [ADR-001 传输](../decisions/ADR-001-wecom-transport.md)、[ADR-002 身份](../decisions/ADR-002-wecom-identity.md)。
> 研究证据等级沿用研究目录的 `[文档]/[SDK源码]/[实验]/[社区]/[未验证]` 标签。

## 1. 总体链路

```text
                    ┌──────────────── 长连接（WSS，单连接） ────────────────┐
企业微信用户 ──消息──▶ aibot_msg_callback ──▶ WeCom Channel ──▶ Cloud Pi runtime
   （单聊 / 群@）                              （去重/路由/串行/取消）        │
                                                                             ▼
                                                              Pi SDK Session（每轮一个）
                                                                             │
                                     ┌───────────────────────────────────────┤
                                     ▼                                       ▼
                         模型网关（OpenAI 兼容）                    Pi SDK MCP Extension
                         src/provider.mjs                         （extensionFactories；
                         CLOUD_PI_MODEL_*）                         Guanlan MCP 由 t5/t8 接入）
                                                                             │
                                                                             ▼
                                                                   报告 / 回答文本
                                                                             │
                     ┌───────────────────────────────────────────────────────┘
                     ▼
      原会话回复（stream，≤20480 字节/帧，10 分钟内 finish）
      或 Scheduler 触发的主动投递（aibot_send_msg，仅限已有会话）
```

两条独立入口、一个执行内核：

| 入口 | 触发者 | 是否需要入站消息 | 现有代码 |
| --- | --- | --- | --- |
| 聊天 Channel | 企业微信用户 | 是（消息回调） | 计划 `src/channels/wecom/*`，形状照抄 `src/channels/feishu/*` |
| Scheduler | cron / 手动 run-now | **不需要**（但投递需要目标会话已有入站） | `src/scheduler/*` + `src/delivery/*`（已实现） |

## 2. 代码入口对照表（真实存在 vs 计划）

### 2.1 已存在、必须复用（不得复制）

| 职责 | 入口（文件:导出） | 说明 |
| --- | --- | --- |
| Agent 执行唯一入口 | `src/runtime.mjs:createAgentRuntime`（`:143`） | 每轮一个 Pi SDK Session；`allowedTools`/`exposedTools`/`customTools`/`extensionFactories` 在此注入 |
| 每轮 runId | `src/runtime.mjs:198`（`randomUUID()`） | 通过 `onEvent` 发 `run_start`/`run_end`（`:234`、`:368`） |
| 模型网关 | `src/provider.mjs:createModelRuntime`；配置键 `src/config.mjs:CONFIG_KEYS`（`CLOUD_PI_MODEL_BASE_URL/API_KEY/ID/API/PROVIDER_ID`） | Key 只以运行时凭证存在，不落盘 |
| 研究执行 | `src/research/execute.mjs:startResearch`（`:913`）/`executeResearch`（`:901`） | 返回 `{ runId, done }`；runId 由 `generateRunId`（`:90`）生成，形如 `r-YYYYMMDDTHHMMSS-xxxxxx` |
| 研究持久化 | `src/research/run-store.mjs` | `<root>/<runId>/{run.json,report.md,sources.json,sources.md}` |
| 调度器 | `src/scheduler/scheduler.mjs:createScheduler`（`:116`） | tick 到点调用 `startResearch`，把 `runId` 写进 `activeTrigger`（`:822-834`） |
| 调度+投递装配 | `src/delivery/scheduler.mjs:createDeliveringScheduler` | 观察终态 trigger，交给 coordinator；**不改 scheduler** |
| 投递阶段 | `src/delivery/coordinator.mjs:createDeliveryCoordinator`（`:101`，需注入 `sendMessage`） | 每目标独立记录，不改研究结论 |
| 投递幂等键 | `src/delivery/contracts.mjs:buildDeliveryKey`（`:134`） | `${runId}#${type}:${id}` 持久化 |
| 分段 | `src/delivery/format.mjs:splitBounded`（`:41`） | **按码点**切分，`DELIVERY_LIMITS.maxCharsPerSegment=4000`、`maxSegments=3` |
| Management API | `src/api/server.mjs:createManagementApi`；路由 `src/api/router.mjs` | `GET /v1/runs/:runId/delivery` 已存在 |
| 飞书参照实现 | `src/channels/feishu/{transport,events,policy,dedupe,channel,runtime,service,server}.mjs` | WeCom 适配层的形状基线，**不复用其代码**（平台差异见架构 §7） |

### 2.2 计划新增（实现卡范围，本文只定义职责）

| 计划文件 | 职责 | 明确不做什么 |
| --- | --- | --- |
| `src/channels/wecom/transport.mjs` | `@wecom/aibot-node-sdk` 薄封装：连接/订阅/心跳/断线事件/`replyStream`/`sendMessage`/`downloadFile` | 不读配置文件、不建 Session、不解析业务语义 |
| `src/channels/wecom/events.mjs` | 原始帧 → 可信字段（`msgid`/`chattype`/`chatid`/`from.userid`/文本、剥 `@名称`） | 不做授权判断 |
| `src/channels/wecom/policy.mjs` | 单聊/群 @/未授权群/`compat_info` 的 fail-closed 判定 | 不调用模型 |
| `src/channels/wecom/dedupe.mjs` | `msgid` 幂等（同步预留 + TTL + 上限） | 不做跨实例共享（首版） |
| `src/channels/wecom/channel.mjs` | 路由→去重→每 chat 串行→`runTurn`→流式回复→`/stop` | 不直接 import SDK |
| `src/channels/wecom/runtime.mjs` | 唯一 `createAgentRuntime()` 装配（cwd 临时目录、无工具或按需） | 不复制 runtime 逻辑 |
| `src/channels/wecom/service.mjs` / `server.mjs` | 组装、启动停止、JSONL 日志（脱敏） | 不打印正文/凭证/完整 userid |

> 计划文件命名与飞书对齐，是为了让审查者能逐文件对照；这不代表要把两者抽成同一接口
> （见 [研究 §Channel Port](../research/wecom-channel/feishu-comparison.md#2-是否抽极薄-channel-port)）。

## 3. 时序（文字版，逐步对应代码）

### 3.1 单聊消息 → 流式回复

| # | 步骤 | 代码位置 |
| --- | --- | --- |
| 1 | 企业微信推送 `aibot_msg_callback`（WSS 帧） | 计划 `src/channels/wecom/transport.mjs` |
| 2 | SDK 解析并 emit `message.text` | `@wecom/aibot-node-sdk`（`message-handler.ts`） |
| 3 | 归一化：`msgid`、`chattype=single`、`from.userid`、是否含 `compat_info` | 计划 `src/channels/wecom/events.mjs`；参照 `src/channels/feishu/events.mjs:normalizeFeishuMessageEvent`（`:65`） |
| 4 | 授权判定（单聊是否允许、是否非用户消息） | 计划 `src/channels/wecom/policy.mjs`；参照 `src/channels/feishu/policy.mjs` |
| 5 | **同步**预留去重 key（`msgid`），并发重投只产生一个 run | 计划 `src/channels/wecom/dedupe.mjs`；参照 `src/channels/feishu/dedupe.mjs:createDedupeStore`（`:17`） |
| 6 | 进入该 chat 的串行队列；`/stop` 递增 epoch 丢弃排队任务 | 计划 `src/channels/wecom/channel.mjs`；参照 `channel.mjs:207` 起 |
| 7 | `runTurn()` → `createAgentRuntime(...).run(prompt)` | 计划 `src/channels/wecom/runtime.mjs` → `src/runtime.mjs:143` |
| 8 | 生成 `runId`，发 `run_start`；模型调用走 `src/provider.mjs` | `src/runtime.mjs:198/234`、`src/provider.mjs` |
| 9 | 首帧 `replyStream(finish=false)`；中间帧 `replyStreamNonBlocking`；终帧 `finish=true` | 计划 `transport.mjs`；SDK `replyStream`/`replyStreamNonBlocking` |
| 10 | 发 `run_end`；`onOutcome` 写 JSONL（脱敏） | `src/runtime.mjs:368`；参照 `src/channels/feishu/server.mjs:write`（`:17`） |
| 11 | 记录回给调用方（不落盘，见 §8 缺口） | —— |

**关键约束**：`req_id` 必须原样带回；流式 `content` 是**全量**而非增量；`finish=true` 后不可再更新；
首帧到终帧 ≤10 分钟；每帧 ≤20480 字节。

### 3.2 群聊 @ → 回复

与 3.1 相同，差异只在第 3–4 步：

- `chattype=group`，带 `chatid`；**没有** `mentions` 结构，`@机器人` 混在 `text.content` 里。
- 只接受"可解释形态"：文本以 `@<机器人显示名>` 开头或首段含该标记；解析失败记
  `ignored:mention_unparsed`，**不猜**（研究 §4 的 #15/#4 风险）。
- 群必须先在允许列表内才调用模型（fail closed），与飞书 `FEISHU_ALLOWED_CHAT_IDS` 同策略。

### 3.3 Scheduler 定时研究 → 主动投递

| # | 步骤 | 代码位置 |
| --- | --- | --- |
| 1 | 装配 scheduler + delivery | `src/delivery/scheduler.mjs:createDeliveringScheduler` → `src/scheduler/scheduler.mjs:createScheduler`（`:116`） |
| 2 | cron 到点 → `startResearch(schedule.request)` | `src/scheduler/scheduler.mjs`（`_startResearch`，`:822`）→ `src/research/execute.mjs:913` |
| 3 | 立即写 `run.json`（`status=running`），研究用 runId 从此可查 | `src/research/execute.mjs:154`、`src/research/run-store.mjs` |
| 4 | trigger 记录 `runId`；终态（succeeded/partial/failed/cancelled/timeout） | `src/scheduler/scheduler.mjs:831-834`；终态集合见 `src/delivery/scheduler.mjs` `DELIVERABLE_TRIGGER_STATUSES` |
| 5 | 终态 trigger → `deliverTrigger()` | `src/delivery/scheduler.mjs` |
| 6 | coordinator 读 run/report，按目标逐个投递 | `src/delivery/coordinator.mjs:deliverToTarget` |
| 7 | 分段：`splitBounded(report)` | `src/delivery/format.mjs:41` |
| 8 | 逐段 `sendMessage(chatid, {msgtype:'markdown'})`（WeCom 主动推送） | 计划 `src/channels/wecom/transport.mjs`（`aibot_send_msg`） |
| 9 | 每目标写一条 delivery record（`pending→sent/failed`） | `src/delivery/store.mjs`；键 `buildDeliveryKey`（`contracts.mjs:134`） |
| 10 | 管理侧查询 | `GET /v1/runs/:runId/delivery` → `src/api/controller.mjs:243` |

**投递前的硬校验（新增，必须实现）**：目标必须是"已有入站会话"。
建议在 Channel 侧维护 `knownConversations`（`{type, id, lastInboundAt}`），coordinator 或
WeCom `sendMessage` 在发送前检查；无记录 → `failed: no_prior_inbound`，**不试发**（研究 §4）。

## 4. 状态机（文字版）

### 4.1 连接状态机（transport）

```text
disconnected ──connect()──▶ connecting ──ws open──▶ subscribing ──errcode:0──▶ authenticated
     ▲                          │                        │
     │                          │ tcp/tls error          │ errcode=853000（凭证错）
     │                          ▼                        ▼
     └──── backoff(1s..30s) ◀── reconnecting ◀──── auth_failed（≤5 次，超限则终态）
authenticated ──disconnected_event（被新连接踢）──▶ disconnected（**不自动重连**，等运维/主备切换）
authenticated ──disconnect()──▶ closed（幂等）
```

- 依据：`[文档]` 62154/62156；SDK 行为（心跳 30 s、`maxMissedPong=2`、退避上限 30 s、
  `maxAuthFailureAttempts=5`）见 `sdk.md` §2。
- 单连接是平台约束：**同一时刻只允许一个进程处于 authenticated**。主备切换必须先确认旧实例
  已 `disconnected`，否则新实例订阅会踢掉旧实例。

### 4.2 单条消息状态机（channel）

```text
received → normalized → policy(allow|ignore:<reason>) → dedupe_reserved
   → queued → running → (replied | reply_failed) → done
                 └── /stop(epoch bump) ──▶ cancelled（不进入模型或中止当前 run）
```

- 去重 key 在 `running` 之前同步预留；`cancelled` 不释放去重 key（防重投复活）。
- 与飞书一致：同一 chat 串行；不同 chat 并行。

### 4.3 投递状态机（delivery，已实现 + 一处待裁决）

```text
pending ──send ok──▶ sent
   │
   ├──非重试错误 / 预算耗尽──▶ failed（终态，记录 error.code）
   └──WeCom 回执 5s 超时（服务端可能已接受）──▶ ???（当前契约只有 pending/sent/failed）
```

**待裁决**：是否需要 `unknown`（"已发送但未确认"）。新增状态要 bump
`DELIVERY_CONTRACT_VERSION`（`src/delivery/contracts.mjs:37`），影响 API 视图与持久化读兼容。
首版建议：**不新增状态**，超时记 `failed` 且 `error.retryable=false`，同时日志标 `ack_timeout`，
由人工核对——宁可少发一次，也不重复发（研究 §3.3）。

## 5. 身份边界

```text
企业微信身份                        Cloud Pi                      Mira Cloud 身份
from.userid（明文或 open_userid）  ──▶  仅作为"会话路由键"  ──▶   Cloud Account（Cloud Auth 拥有）
chatid（群）                           不映射、不授予、不持久化为账号
```

- **禁止**把 `userid`/`open_userid` 当作 Cloud Account id、Mira Device id 或 Guanlan consumer。
- **禁止**用 `from.userid` 决定工具权限、数据范围或 audience；模型输入不能选择身份（仓库 AGENTS.md §3）。
- 首版 Channel 以**服务身份**运行：模型 Key、MCP 凭证都由部署环境注入，与聊天者身份无关；
  聊天者只能触发"这个服务能做的事"，不能借消息提升权限。
- 若未来需要"以用户身份访问其 Mira 数据"，必须走 [ADR-002](../decisions/ADR-002-wecom-identity.md)
  的绑定/授权路径，且不得复用 Relay/Desktop 凭证。
- `open_userid` 转换（`[文档]` 61328）需要自建应用 `access_token` + 可见范围 → 属新权限面，
  首版**不做**；需要时单独裁决。

## 6. 去重与幂等

| 层 | 键 | 存储 | 作用域 | 现状 |
| --- | --- | --- | --- | --- |
| 入站消息 | `msgid` | 进程内 TTL 24 h / 上限 2048（对齐飞书） | 单实例 | 计划 |
| 研究 run | `r-…`（`generateRunId`） | `run.json` 持久化 | 跨重启 | 已实现 |
| 投递 | `${runId}#${type}:${id}` | `.work/delivery` 持久化 | 跨重启、可重放 | 已实现 |
| 投递分段 | `segmentUuid(deliveryKey, index)` | 随 record | 段级幂等 | 已实现（`src/delivery/format.mjs:176`） |

企业微信**未公布**事件重投窗口（`[未验证]`），所以只能假设"可能重投"；进程内去重 + 持久化
`runId`/`deliveryKey` 组合覆盖了"重投不重复研究、不重复投递"，但**不覆盖**"多实例同时收到重投"
（单连接约束下天然只有一个实例在收，所以首版可接受）。

## 7. 失败与重连（分层）

| 层 | 失败 | 处理 |
| --- | --- | --- |
| WS 连接 | TLS/网络中断 | 指数退避重连；`isConnected=false` 期间拒收发 |
| 认证 | `853000` 等 | 不重试（配置错误），告警；`maxAuthFailureAttempts` 后停 |
| 被踢 | `disconnected_event` | 不自动重连；主备切换；在途回复标记失败 |
| 协议回执 | 5 s 超时 | 不重发；`replyStreamNonBlocking` 跳过积压帧；记 `ack_timeout` |
| 业务回复 | 24 h 窗口过期 / 10 min 流式超时 | 终态失败，不补发；日志标 `reply_window_expired`/`stream_expired` |
| 研究 | 模型错误/超时/取消 | 已有分类（`src/research/contracts.mjs:RUN_STATUS`），run 记录可查 |
| 投递 | 无前置入站 / 频控 / 鉴权 | `no_prior_inbound` 终态；频控退避；鉴权终态 |

**重连与投递的交互**：主备切换窗口内不得发起主动投递（`authenticated` 之前发送必然失败）；
coordinator 应把 WeCom transport 的 `isConnected()` 作为发送前置（计划接口）。

## 8. 分段与长度（现有实现与 WeCom 的差异）

- 企业微信：`markdown.content ≤ 20480 **字节**`（UTF-8）；分段必须按字节。
- 现有 `splitBounded` 按**码点**：`maxCharsPerSegment=4000`、`maxSegments=3`
  （`src/delivery/contracts.mjs:90`）。
- 安全性：UTF-8 每码点最多 4 字节 → 4000 码点最坏 16000 字节 < 20480，**不会超限**。
- 代价：`maxSegments=3` 意味着报告最多约 12000 字，超出会被截断（带 run id 标记）。对企业微信
  而言这是**保守但安全**的；若要发更长报告，应做**按目标的限额**而不是全局调大（否则飞书侧行为
  一起变）。

**建议（待 t8 实现卡确认）**：给 `DELIVERY_LIMITS` 增加按目标类型的 overrides
（例如 `wecom: { maxBytesPerSegment: 20000, maxSegments: 8 }`），由 coordinator 在发送前用
`Buffer.byteLength` 断言；不改全局默认值。是否纳入本次契约变更，交 t4/t8 与维护者裁决。

## 9. Trace 关联点（runId 如何贯穿）

```text
企业微信 msgid ──▶ channelRunId（src/runtime.mjs randomUUID，每轮一个）
                        │
                        └─（仅当 /research 或 Scheduler）─▶ researchRunId（r-…，持久化）
                                                              │
                                              scheduleId + trigger.dedupeKey
                                                              │
                                              deliveryKey = `${runId}#${type}:${id}`
                                                              │
                                              GET /v1/runs/:runId[/report|/delivery]
```

| 关联点 | 字段 | 现状 |
| --- | --- | --- |
| 入站 → 轮次 | `msgid` ↔ `channelRunId` | **缺口**：channel 不落盘 run 记录，`channelRunId` 只出现在 JSONL 日志（`onOutcome`） |
| 轮次 → 研究 | `channelRunId` ↔ `researchRunId` | **缺口**：`run.json` 的 `runtime` 段只有 status/duration/usage/error，**没有** agent runId（`src/research/execute.mjs:789-807`） |
| 研究 → 调度 | `researchRunId` ↔ `scheduleId`/`trigger` | 已实现（scheduler 持久化 `activeTrigger.runId`） |
| 研究 → 投递 | `researchRunId` ↔ `deliveryKey` | 已实现 |
| 查询 | `runId` | 已实现（API `v1/runs/:runId`、`.../report`、`.../delivery`） |

**t8（全链路 Trace）的最小增量建议**（不在本卡实现）：

1. `run.json` 增加 `runtime.agentRunId`（additive，不改 `CONTRACT_VERSION` 的读取逻辑）；
2. WeCom channel 的 `onOutcome` 写一行结构化 JSONL：`{ts, msgid, channelRunId, chattype, status, model, durationMs}`，
   不含正文与完整 userid；
3. 若 `/research` 由聊天触发，回复里带上 `researchRunId`，让"消息 → run"可人工追溯。

## 10. 与飞书的关系（边界）

- **不抽通用 Channel Port**，理由见研究 §2。两个 adapter 各自实现，共享的只有
  `createAgentRuntime().run()`、`src/delivery/*` 的投递合同、以及 `runId` 语义。
- 飞书侧行为不得回退：新增 WeCom 代码不得修改 `src/channels/feishu/*` 与 `src/delivery/*` 的
  既有默认值（`maxCharsPerSegment=4000`、`maxSegments=3`、`DELIVERY_CONTRACT_VERSION=1`）。
- `deliveryTargets` 类型词表按 W1 扩展（lead 2026-11-04 已定：扩展类型词表 +
  `SCHEDULER_CONTRACT_VERSION 1→2` 兼容读）。WeCom 目标为 `wecom_user` / `wecom_chat`，
  见 §3.3 与研究 `feishu-comparison.md` §3.5。

## 11. 未决问题（交维护者 / t8）

1. 投递状态是否新增 `unknown`（§4.3）。
2. 分段限额是按目标覆盖还是全局调整（§8）。
3. `runtime.agentRunId` 与 channel JSONL 是否纳入 t8 范围（§9）。
4. 群 @ 解析规则的产品口径（显示名匹配 vs 其它可解释形态）。
5. 主备切换的选主机制（人工/外部探活），官方未给机制。
6. 目标"已有入站"记录的存储位置（channel 进程内存 vs 共享存储），影响重启后能否继续投递。
