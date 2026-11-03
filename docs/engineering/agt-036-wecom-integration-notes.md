# AGT-036 前置 · Cloud Pi 集成面梳理与 WeCom adapter 设计草案

> 状态（2026-11-04）：**设计草案，不是实现，不改 `src/`。**
> 基线 `origin/dev@8efc250`（AGT-035 / PR #20 已合并），分支 `feat/agt-036-wecom-channel`。
> 本文件回答一个问题：**若要把企业微信作为 Cloud Pi 的第二个 IM Channel，
> 现有代码里哪些面已经可以直接复用、哪些面必须新增、哪些面必须动一点点合同。**
>
> 本文**不判断**企业微信侧 API/SDK 的真实能力（连接模式、ACK、去重、限流、消息长度单位）——
> 那是 [AGT-031 / #13](https://github.com/uichat-mira/cloud-pi/issues/13) 的研究范围。
> 涉及企业微信平台事实的条目在本文中一律标为 **「待 t2 结论」**，不作为已确认事实使用。
> Cloud Pi 侧的每一条接口断言都能在当前 `dev` 代码里用文末 [§10](#10-断言自检) 的命令复现。

---

## 1. 结论摘要

1. **不新建 runtime。** 消息入口唯一执行面是
   `createAgentRuntime().run()`（`src/runtime.mjs:143`、`:187`），研究入口唯一执行面是
   `startResearch()`（`src/research/index.mjs:39-46`）。WeCom 只提供事件与回复，不装配 Pi Session。
2. **WeCom adapter 的最小职责 = 飞书 adapter 的四个缝**：`normalizeEvent` → `routePolicy` →
   `runTurn/runResearch` → `reply`。`src/channels/feishu/channel.mjs` 已经把「路由 / 去重 /
   每会话串行队列 / `/stop` epoch / 结果回复」写成与平台无关的纯逻辑，只有 **两处** 平台依赖
   （`src/channels/feishu/channel.mjs:510` 的事件归一化、`src/channels/feishu/channel.mjs:518` 的路由判定）。
3. **建议通过 2 个极小扩展点复用该 channel 逻辑**（注入式覆盖，缺省值等于现有行为，飞书 0 回归）：
   `src/channels/feishu/channel.mjs:183-192` 的 options 增加两个可选覆盖，`src/channels/feishu/channel.mjs:510`/`:518` 改为调用它们。
   **不建议**为 WeCom 复制一份 channel 队列逻辑，也**不建议**造通用 IM Channel Port（§5.3）。
4. **真正卡住的不是消息方向，而是投递方向的 destination 词表。** `schedule.deliveryTargets`
   目前只接受飞书的 `{type: open_id|chat_id, id: /^ou_/|/^oc_/}`（`src/scheduler/contracts.mjs:117-129`、
   `:146-190`），未知字段直接抛错（`:162-165`）。WeCom 的 userid/chatid **无法**在现有合同里表达。
   这是唯一需要动冻结合同（`SCHEDULER_CONTRACT_VERSION`）的地方，须维护者裁决（§6）。
5. **幂等键不需要改。** `${runId}#${type}:${id}`（`src/delivery/contracts.mjs:134-140`）本身以
   `type` 区分渠道，WeCom 只要定义自己的 type 字面量即可；分段续传由 `segmentsSent` 保证
   （`src/delivery/coordinator.mjs:228-250`）。
6. **Management API 不需要改。** 投递读回口子已经是注入式（`src/api/server.mjs:92-95`、
   `src/api/controller.mjs:243-251`），WeCom 投递只要仍由同一个 coordinator 落盘即可被读回。

---

## 2. 可复用的运行面（唯一 Agent 执行面）

| 契约 | 位置 | 说明 |
| --- | --- | --- |
| `createAgentRuntime(options)` → `Promise<Runtime>` | `src/runtime.mjs:143`（jsdoc `:129-142`） | `options`: `config` / `env` / `allowedTools` / `exposedTools` / `customTools` / `extensionFactories` / `cwd` / `modelRuntime` / `model`（`:132-141`），另有 `agentDir`（`:168-169`） |
| `Runtime.run(prompt, {signal, timeoutMs, onEvent})` → `Promise<RunRecord>` | `src/runtime.mjs:187`（参数 `:181-185`） | 失败**不 throw**，返回分类记录（`:11-12`）；只有构造参数非法才 throw |
| RunRecord 字段 | `src/runtime.mjs:499-526` | `runId, status, startedAt, durationMs, model{providerId,modelId,api}, limits{timeoutMs,maxToolCalls,maxOutputTokens}, text, stopReason, usage{input,output,cacheRead,cacheWrite,total,cost}, toolCalls[], error` |
| RunRecord.status 取值 | `src/runtime.mjs:454-487` | `succeeded` / `failed` / `timeout` / `cancelled`（通道回复只依赖这 4 个，见 `src/channels/feishu/channel.mjs:416-428`） |
| 失败记录（无 session 时） | `src/runtime.mjs:428-447` | `text:""`、`usage` 全 0、`error` 来自 `classifyError()` |
| 错误码词表 | `src/errors.mjs:51-100` | `timeout, cancelled, config_error, tool_denied, tool_budget_exhausted, auth_error, model_not_found, rate_limit, provider_unavailable, invalid_request, network_error, tool_error, provider_error`；可重试集合 `src/errors.mjs:10`（仅 `rate_limit`/`provider_unavailable`/`network_error`） |
| `Runtime.dispose()` | `src/runtime.mjs:372-377` | 幂等；只释放自己拥有的 model runtime 与临时 agentDir |
| `runAgentOnce(prompt, options)` | `src/runtime.mjs:533-539` | 一次性包装，**不要**在常驻通道里用（每条消息新建 runtime） |
| 工具白/黑名单语义 | `src/runtime.mjs:38-41`、`:152-155`、`:269-271` | `allowedTools` 是执行面、`exposedTools` 是模型可见面；空数组 **有意义**（不暴露内置工具） |
| 运行时硬约束 | `src/runtime.mjs:1-13`、`:187-191` | **一个 runtime 实例不得同时跑两个 turn**；`src/channels/feishu/runtime.mjs:68-71` 用 `runLock` 串行化。两个 channel 各自建 runner = 两个 Pi Session 并行（允许，但内存×2） |

研究执行面（WeCom 的 `/research` 若要做，必须走这里，不得复制执行器）：

| 契约 | 位置 | 说明 |
| --- | --- | --- |
| `startResearch(request, deps)` → `{runId, done}` | `src/research/index.mjs:39-46` | `done` resolve 为持久化 run 记录；`run.json` 在返回前已落盘（`:21-23`） |
| `readResearchRun(runId, {rootDir, env})` → `{run, report, sources}` | `src/research/index.mjs:61-83` | 未知 run 抛 `RunStoreError("not_found")`，损坏抛 `parse_error` |
| `listResearchRuns({rootDir, env})` | `src/research/index.mjs:92-95` | 新的在前；坏目录跳过 |
| `RUN_STATUS` | `src/research/contracts.mjs:24-32` | `running / completed / completed_with_errors / failed / cancelled / timeout` |
| `isTerminalStatus()` | `src/research/contracts.mjs:73-81` | 调度器恢复与投递 plan 都依赖它 |
| Runtime port 适配器 | `src/research/runtime/agt-027.mjs:89-133` | 研究侧**只**通过 `loadAgentRuntimePort()` 装配运行时（`src/research/port.mjs:117-146`）；`mapAgentRuntimeRecord()` `:47-83` 把 RunRecord 映射成 port 结果 |
| Research deps 形状 | `src/research/index.mjs:30-31`、`src/scheduler/scheduler.mjs:816-821` | `{runtimePort, toolLayer, store?, now?, logger?, signal?, rootDir?, env?}` |

> 运行面**不改**。WeCom 需要的任何"新能力"（流式、卡片、多媒体）都必须落在 transport 层，
> 不得反推 runtime 增加分支。

---

## 3. 飞书 channel 已实现的内部契约（= WeCom 必须满足的接口）

`src/channels/feishu/channel.mjs` 是**可复用的通道内核**，它对外只有 4 个平台相关缝：

| 缝 | 现状 | WeCom 需要提供 |
| --- | --- | --- |
| 事件归一化 | `normalizeFeishuMessageEvent(raw)`（`src/channels/feishu/events.mjs:65-97`），在 `src/channels/feishu/channel.mjs:510` 调用 | `normalize*Event(raw)` → 或 `null`（不支持的事件） |
| 路由判定 | `decideFeishuRoute(event, policy)`（`src/channels/feishu/policy.mjs:26-49`），在 `src/channels/feishu/channel.mjs:518` 调用 | `decide*Route(event, policy)` → `{allowed, kind, reason}` |
| 单轮 run | `runTurn({text, chatId, chatType, messageId, eventId, senderOpenId, signal})`（`src/channels/feishu/channel.mjs:378-386`） | 同样的入参形状；可复用 `createFeishuAgentRunner` 的 `runTurn`（`src/channels/feishu/runtime.mjs:97-113`）或同构实现 |
| 回复 | `reply(messageId, text)` → `{messageId?}`（`src/channels/feishu/channel.mjs:178`、`:270-283`） | 同样形状；失败必须 throw，由 `safeReply()` 记录 |

归一化后事件被 channel 读取的字段是**封闭集合**，WeCom 归一化器必须产出同名键（`src/channels/feishu/channel.mjs:502-529`）：

```
{ eventId?, messageId, chatId, chatType, messageType, senderType,
  senderOpenId?, text: string|null, mentions[], dedupeKey: string|null }
```

- 拒绝顺序（fail closed）：`disposed/closing` → `invalid_event`/`unsupported_event` →
  `route.allowed` → `senderType !== "user"` → `messageType !== "text"` → 空文本 →
  `missing_dedupe_key` → `duplicate_event`（`src/channels/feishu/channel.mjs:503-525`）。
- 通道内已有、**不要重写**的机制：
  - 每会话串行队列 `queues` + `pending` 计数 + `whenIdle()`（`:203-230`、`:285-323`）；
  - `/stop` epoch：停止前排队消息不再执行（`:208`、`:345-348`、`:473-495`）；
  - `stopAll({timeoutMs})` 对称释放 pending，shutdown 不靠 timeout（`:557-570`）；
  - 结果→回复文案映射：`succeeded`/`cancelled`/`timeout`/其它（`:416-428`），空答案文案 `CHANNEL_REPLIES.empty`（`:30-36`）；
  - 研究回复构建 `buildResearchReply()`（`:142-168`）与终态映射 `mapResearchStatus()`（`:83-85`），未知状态 fail closed 为 `failed`；
  - 命令词表 `STOP_COMMANDS`（`:28`）、`RESEARCH_COMMANDS`（`:43`）、单条研究回复上限 `MAX_RESEARCH_REPLY_CHARS = 1800`（`:46`）。
- 去重：`createDedupeStore()`（`src/channels/feishu/dedupe.mjs:17-71`），`reserve()` 在**任何异步 run 之前同步**占位（`src/channels/feishu/channel.mjs:525`），TTL 24h / 上限 2048（`src/channels/feishu/dedupe.mjs:14-15`），**进程内**（`:9-12`）。

### 3.1 三个"看起来可复用但语义是飞书专用"的部分

| 模块 | 为什么不能直接给 WeCom 用 |
| --- | --- |
| `src/channels/feishu/policy.mjs:26-49` | 判据是 `chatType === "p2p" / "group"` + `mentions[].openId === botOpenId`；WeCom 的会话类型与 @ 表达方式 **待 t2 结论**，直接套用等于把飞书词表伪装成平台事实 |
| `src/channels/feishu/transport.mjs` | 全部基于 `@larksuiteoapi/node-sdk@1.76.0`（`package.json:33`），含 `Lark.WSClient`、`im/v1/messages/:id/reply`、`bot/v3/info`、`RETRYABLE_FEISHU_SEND_CODES = [99991400]`（`src/channels/feishu/transport.mjs:34`）。**飞书业务码不可复用** |
| `src/channels/feishu/config.mjs:16-22`、`:84-114` | `cli_`/`ou_`/`oc_` 正则与 `FEISHU_*` 变量名；WeCom 凭证形状 **待 t2 结论** |

可复用但需注意语义差的公共helper：

- `maskId(value, {head, tail})`（`src/channels/feishu/config.mjs:182-185`）——**已经被跨模块复用**
  （`src/delivery/contracts.mjs:34`、`:153`、`src/delivery/targets.mjs:26`），所以 WeCom 模块引用它不构成新的耦合。
  **但**：`maskId` 保留"前 6 + 后 4"（`:183`），对飞书 `ou_…`/`oc_…` 这种随机 id 合适，对企业微信
  **稳定员工 userid** 不是脱敏（`zhangsan` 会被原样返回）。WeCom 侧应改为整段哈希前缀或完全不记 sender id（§9-R6）。
- `redactSecrets(text, secrets)`（`src/config.mjs:240-250`）——对 `Bearer`、`sk-`、`api_key=` 有规则，
  可复用，但它**不认识**企业微信 AppSecret 形态，需把 secret 显式放进 `secrets` 数组。

---

## 4. WeCom adapter 最小接口清单

新增目录 `src/channels/wecom/`，**只允许**这 6 个模块（与飞书目录一一对应，不做平台抽象层）：

### 4.0 最小接口清单（一屏速查）

| 职责 | 模块（新增 `src/channels/wecom/`） | 最小接口 | 必须满足的既有契约（飞书侧） |
| --- | --- | --- | --- |
| 配置校验 | `config.mjs` | `loadWecomConfig(env)` / `describeWecomConfig(config)` | 失败即抛分类错误、secret 不出函数（`src/channels/feishu/config.mjs:84-147`） |
| 收消息归一化 | `events.mjs` | `normalizeWecomMessageEvent(raw) -> event \| null` | 产出 §3 的封闭字段集，含 `dedupeKey`（`src/channels/feishu/events.mjs:65-97`） |
| 路由 / 授权 | `policy.mjs` | `decideWecomRoute(event, policy) -> {allowed,kind,reason}` | fail closed，判定在模型之前（`src/channels/feishu/policy.mjs:26-49`） |
| 收消息→runner→回复 | 复用 `channel` 内核 + `runtime.mjs` | `runTurn({text,chatId,chatType,messageId,eventId,senderOpenId,signal}) -> RunRecord`；`reply(messageId,text)` | RunRecord.status 四值（`src/runtime.mjs:454-487`）；回复失败 throw（`src/channels/feishu/channel.mjs:270-283`） |
| 主动投递 | `transport.send()` | `send({receiveIdType,receiveId,text,uuid?}) -> {messageId}` | 无 message id = 失败；错误带 `{code,retryable}`（`src/delivery/coordinator.mjs:230-250`、`:265-278`） |
| dedupe | 复用 `createDedupeStore()` | `reserve(key) / has(key) / size` | key 在任何异步 run 之前同步占位（`src/channels/feishu/channel.mjs:525`） |
| 身份识别 | `events.mjs` + `policy.mjs` | 只从平台字段取身份，不解析正文 | 不映射 Cloud Account / 工具权限（`src/channels/feishu/policy.mjs:12-13`） |
| 日志脱敏 | 全模块 | `maskId` / 哈希前缀 / `redactSecrets` | 不记正文、secret、完整 id（§8） |
| 常驻进程 | `server.mjs` | `npm run channel:wecom`，JSON 行日志，退出码 0/1/2 | 与 `src/channels/feishu/server.mjs:17-52` 同构 |

### 4.1 `src/channels/wecom/config.mjs` — 配置校验

```text
loadWecomConfig(env) -> Readonly<{ botId, botSecret, allowedChatIds, ... }>
  - 校验失败抛 WecomConfigError(fields, detail)，code = "wecom_config_error"（镜像 src/channels/feishu/config.mjs:48-55、:103-105）
  - 返回值 deepFreeze，不含任何可用于打印的 secret 派生视图之外的字段
describeWecomConfig(config) -> { botIdConfigured, allowedChatCount, ... }   // 镜像 src/channels/feishu/config.mjs:140-147
resolveSendTimeoutMs(value) -> int   // 镜像 src/channels/feishu/transport.mjs:56-65；越界 fail closed，不允许"无上限"
```

- 变量名（`WECOM_*`）与是否区分 `userid`/`open_userid` **待 t2 结论**后才能定稿；
  在此之前**不要**把候选变量名写进 `.env.example`，避免被当成已确认合同。
- 群/单聊允许名单语义照搬：本地可信 POC 允许名单 ≠ Cloud Auth 授权（`src/channels/feishu/policy.mjs:12-13`、`docs/engineering/agt-029-feishu-channel.md` §4）。

### 4.2 `src/channels/wecom/events.mjs` — 事件归一化

```text
readWecomEventType(payload) -> string|undefined
normalizeWecomMessageEvent(payload) -> null | {
  eventId?, messageId, chatId, chatType, messageType, senderType,
  senderOpenId?, text: string|null, mentions[], dedupeKey: string|null
}
```

- 输出键名必须与 §3 的封闭集合**完全一致**（含 `dedupeKey`），否则 channel 内 `missing_dedupe_key`
  会静默丢弃全部消息（`src/channels/feishu/channel.mjs:524-525`）。
- `dedupeKey` 沿用同一套前缀约定：优先 `event:<平台事件 id>`，缺失回退 `message:<平台消息 id>`
  （`src/channels/feishu/events.mjs:94`），这样 `createDedupeStore` 无需改动。
- **身份不得来自文本**：发送者身份只能取平台字段，不能解析消息正文（`src/channels/feishu/events.mjs:7-8` 的同款约束）。
- 媒体/卡片/转发等非文本事件 → 归一化为 `messageType !== "text"`，由 channel 侧统一忽略（`src/channels/feishu/channel.mjs:522`），
  不在归一化层实现"半支持"。

### 4.3 `src/channels/wecom/policy.mjs` — 路由判定

```text
decideWecomRoute(event, policy) -> { allowed:boolean, kind:string, reason:string }
```

- 必须 fail closed 的同构规则（对照 `src/channels/feishu/policy.mjs:31-48`）：未验证机器人身份时不允许群消息进入；
  未授权会话一律忽略；无法证明 @ 到本机器人时不允许。
- 具体判据（是否需要显式 @、`chatType` 取值、机器人身份字段）**待 t2 结论**。
- 群成员身份**不得**映射为 Cloud Account / Guanlan consumer / 管理权限（AGENTS.md 硬边界 3；
  `src/channels/feishu/policy.mjs:12-13`）。

### 4.4 `src/channels/wecom/transport.mjs` — 平台网络层（唯一持有 SDK 的模块）

```text
createWecomTransport({ config, onEvent, log, client?, sendTimeoutMs? }) -> {
  start()         -> Promise<{ botIdentity: string }>   // 镜像 src/channels/feishu/transport.mjs:222-260
  stop()          -> void                                // 镜像 :382-394
  reply(messageId, text) -> Promise<{ messageId }>       // 镜像 :262-277；无 message id 视为失败
  send({ receiveIdType, receiveId, text, uuid? }) -> Promise<{ messageId }>   // 镜像 :289-380
  getBotIdentity() -> string|undefined                    // src/channels/feishu/service.mjs:57 以 getter 形式使用
  diagnostics()   -> object                               // 只读、脱敏，镜像 :404-408
}
```

硬要求（全部来自现有调用方，不是新发明）：

1. `onEvent(raw)` 由 transport 调用，**不得**在此 await 模型：`src/channels/feishu/service.mjs:48-53` 明确"never block the
   SDK dispatcher"，`channel.handleEvent()` 是**同步**返回决策的函数（`src/channels/feishu/channel.mjs:502-555`）。
   这条同时满足"回调模式必须在平台超时前 ACK"的要求（具体超时值 **待 t2 结论**）。
2. `reply()` 必须返回平台 message id，否则 `safeReply()` 会把回复记为失败（`src/channels/feishu/channel.mjs:270-283`）。
3. `send()` 的入参由 coordinator 决定：`receiveIdType` = `target.type`、`receiveId` = `target.id`、
   `text` = 一个已切好的分段、`uuid` = `segmentUuid(key, index)`（`src/delivery/coordinator.mjs:230-238`、
   `src/delivery/format.mjs:176-178`）。**`uuid` 是飞书特性**：WeCom 若不支持，transport 必须显式忽略并
   在 `diagnostics()` 里暴露 `segmentDedupeSupported:false`，不得假装有第二重保护。
4. 错误必须**分类可判定**：镜像 `FeishuSendError`（`src/channels/feishu/transport.mjs:37-49`）的自定义错误，至少携带
   `{code, retryable}`，因为 coordinator 只根据 `error.retryable === true` 决定是否重试
   （`src/delivery/coordinator.mjs:265-278`），并把错误码映射成 `DELIVERY_ERROR`（`src/delivery/contracts.mjs:265-279`）。
   哪些平台错误可重试 **待 t2 结论**；**不得**沿用飞书的 `99991400`。
5. 代理：不要依赖进程级 `HTTPS_PROXY` 隐式生效。研究工具的出网代理是独立变量
   `RESEARCH_HTTPS_PROXY`（`src/research/contracts.mjs:159`），若把全局代理一起打开，会同时改变
   研究出网行为。transport 应显式接收代理/agent 选项（§9-R5）。

### 4.5 `src/channels/wecom/runtime.mjs` — 通道运行面装配（薄 glue）

```text
createWecomAgentRunner({ env, cwd?, config?, createRuntime? }) -> { runTurn, dispose }
```

- 直接复用 `createFeishuAgentRunner` 的装配方式：私有临时 cwd、`allowedTools/exposedTools/customTools`
  全空、`before_agent_start` 注入固定 channel system prompt（`src/channels/feishu/runtime.mjs:29-43`、
  `:63-93`）、`runLock` 串行化（`:68-71`、`:97-113`）。
- **决策点（需 t4 定）**：WeCom 与 Feishu 是否共享同一个 agent runner 实例。
  - 共享：两个 channel 的 turn 全局限流为 1，内存最省，但一条慢消息会阻塞另一个渠道；
  - 各自实例：并发 2 个 Pi Session（`src/runtime.mjs:1-13` 只禁止**同一实例**并发），更稳但内存×2（2C2G 目标机需复核）。
- 若要做 `/research`：必须调 `startResearch()`，装配走 `loadAgentRuntimePort()`（`src/research/port.mjs:117-146`），
  并沿用 `createFeishuResearchRunner` 的槽位/并发/放弃语义（`src/channels/feishu/runtime.mjs:188-379`），
  但**不要**直接引用 `loadFeishuResearchConfig()`（`src/channels/feishu/config.mjs:159-176`，变量名是 `FEISHU_*`）。

### 4.6 `src/channels/wecom/server.mjs` — 常驻进程入口

- 与 `src/channels/feishu/server.mjs` 同构：一行一个 JSON 日志（`:17-21`）、`SIGINT`/`SIGTERM`
  `once` 处理器（`:38-42`）、退出码 `0` 干净停止 / `1` 未排空 / `2` 配置非法（`:30-32`、`:52`）。
- `package.json` 增加 `channel:wecom`（对照 `package.json:20`）。

---

## 5. 不改动清单与极小扩展点

### 5.1 明确「不改动」的模块（本卡与后续 POC 都不应碰）

| 模块 | 理由 |
| --- | --- |
| `src/runtime.mjs`、`src/provider.mjs`、`src/config.mjs`、`src/errors.mjs`、`src/index.mjs` | 唯一 Agent 执行面；WeCom 不得反推分支 |
| `src/research/**`（含 `runtime/agt-027.mjs`、`port.mjs`、`execute.mjs`、`run-store.mjs`） | 研究执行与持久化已合并；WeCom 只是调用方 |
| `src/scheduler/**`（除 §6 裁决后的那 2 处） | 定时语义、租约、恢复与渠道无关 |
| `src/delivery/coordinator.mjs`、`store.mjs`、`src/delivery/format.mjs`、`src/scheduler/scheduler.mjs` | 投递阶段与渠道无关；`sendMessage` 已是注入点 |
| `src/api/**` | 投递读回口子已注入式（`src/api/server.mjs:92-95`） |
| `src/channels/feishu/**` | 飞书通道不得因 WeCom 改变行为；除 §5.2 的 E1 覆盖点（向后兼容） |
| `src/tools.mjs`、`poc/pi-session.mjs`、`tests/agt-029-*`、`tests/p0-*` | 与本卡无关 |

### 5.2 需要「极小扩展点」的 3 处（附向后兼容证明）

**(E1) `src/channels/feishu/channel.mjs` — 让通道内核接受注入的归一化/路由**

- 位置：options 对象 `src/channels/feishu/channel.mjs:183-192`（新增 `normalizeEvent`、`decideRoute` 两个可选参数）；
  调用点 `src/channels/feishu/channel.mjs:510`、`:518` 改为 `normalizeEvent(raw)` / `decideRoute(event, policy)`。
- 向后兼容：缺省值绑定当前的 `normalizeFeishuMessageEvent` / `decideFeishuRoute`，
  `src/channels/feishu/service.mjs:55-63` 不传即等于现有行为；`tests/agt-029-channel.test.mjs:54` 起全部现有断言不变。
- 副作用：模块名/导出名 `createFeishuChannel` 会显得不准确。**最小**做法是保留该函数为
  默认参数包装，另导出 `createChannel`（不重命名、不加抽象层）。

**(E2) `src/channels/wecom/*` — 全新目录（本文 §4）**

- 纯新增，零回归面。`src/channels/feishu/index.mjs:8-40` 的导出清单不受影响。

**(E3) 投递 destination 词表 — 唯一需要动冻结合同的地方（§6，需裁决）**

- 位置：`src/scheduler/contracts.mjs:117-129`（type 枚举 + id 正则）、`:130`（允许字段集）、
  `:146-190`（`normalizeDeliveryTargets`）；连带 `src/scheduler/contracts.mjs:17`
  （`SCHEDULER_CONTRACT_VERSION`）与 `src/scheduler/schedule.mjs:369-371`（版本校验）。
- 影响面（必须一起评估）：`src/delivery/contracts.mjs:134-140`（`buildDeliveryKey` 无需改，
  只要 type 字面量全局唯一）、`src/delivery/store.mjs:95-98`（文件名仍是 sha256，无需改）、
  `src/api/views.mjs`（`toDeliveryView` 的 `type` 直出）。
- 若维护者选择「零改动」：WeCom 投递必须**另起**一套 delivery 存储与读回视图，
  代价是同一份"研究终态投递"出现两套实现——这与 AGT-033 的单一事实源冲突，本文不推荐。

### 5.3 明确「不做」的事

- 不建通用 `Channel` 抽象 / `ChannelPort` / 插件注册表：两处平台差异（事件形状、路由判据）
  已被 E1 覆盖，其余 90% 是同一份代码；再抽一层只会把飞书词表藏进抽象。是否抽取
  Channel Port 的正式判断权属 [AGT-031 / #13](https://github.com/uichat-mira/cloud-pi/issues/13) §5。
- 不实现会话持久化、多轮历史、多媒体、卡片、表情回复（与飞书 POC 缺口一致，
  `docs/engineering/agt-029-feishu-channel.md` §9）。
- 不在本卡改 `src/`、不提交实现代码、不部署。

---

## 6. Scheduler / Delivery 衔接（本卡最关键的合同问题）

### 6.1 现状（可复用的部分）

```text
schedule.deliveryTargets            // 可信配置，非模型/报告/消息可改
  normalizeDeliveryTargets()        // src/scheduler/contracts.mjs:146-190，最多 10 个（:122-126）
  → { type, id, label? }（frozen）
      ↓ 由 createDeliveringScheduler 观察 scheduler 终态 trigger
  coordinator.deliverRun({runId, researchStatus, triggerStatus, schedule})
                                     // src/delivery/scheduler.mjs:47-155、:69-83
      → planDelivery()               // src/delivery/contracts.mjs:166-201（研究状态优先，trigger 兜底）
      → buildDeliveryMessage()       // src/delivery/format.mjs:112-169（分段+截断标记）
      → deliverToTarget()            // src/delivery/coordinator.mjs:183-293
          sendMessage({receiveIdType, receiveId, text, uuid})   // :230-238
      → 落盘 <deliveryStateDir>/runs/<runId>/<sha256(key)[0..32]>.json   // src/delivery/store.mjs:4-16、:95-98
```

- 触发来源：`scheduler.tick()` / `runNow()` / 启动 `reconcile()`（`src/delivery/scheduler.mjs:91-131`），
  可投递的终态集合固定为 `succeeded/partial/failed/cancelled/timeout`（`:25-31`）。
- 投递阶段**不影响**研究状态；单个目标失败不影响其它目标（`src/delivery/coordinator.mjs:369-385`）。

### 6.2 卡片：WeCom destination 无法用现有词表表达

- `DELIVERY_TARGET_TYPE` 只有 `open_id` / `chat_id`（`src/scheduler/contracts.mjs:117-120`）；
- id 正则固定 `^ou_[A-Za-z0-9]+$` / `^oc_[A-Za-z0-9_-]+$`（`:128-129`、`:170-177`）；
- `label` 之外**任何**字段都抛 `invalid_request`（`:130`、`:162-165`）；
- `assertScheduleShape()` 在读盘时再校验一次（`src/scheduler/schedule.mjs:386-392`）。

⇒ 企业微信 userid / chatid 今天**不可能**进入 `schedule.deliveryTargets`。

### 6.3 两个候选方案（交维护者裁决，本卡不实现）

**方案 W1（推荐）：把渠道维度加进 destination 词表**

- 新增 type 字面量，例如 `wecom_userid` / `wecom_chatid`（具体取值 **待 t2 结论**后按平台术语定名），
  并在 `normalizeDeliveryTargets` 里按 type 选择各自的 id 校验。
- `SCHEDULER_CONTRACT_VERSION` 1 → 2，`assertScheduleShape` 增加"读到 v1 记录时按 v1 校验并
  在内存中升级"的兼容分支（`src/scheduler/schedule.mjs:369-371` 目前直接拒绝非当前版本）。
- 好处：单一投递事实源、幂等键天然不冲突、Management API 零改动。
- 代价：动 2 个已合并文件 + 一次合同版本号；需 `tests/agt-033-*`、`scheduler-t*` 全部回归。

**方案 W2：完全不动现有合同，WeCom 另起投递存储**

- 好处：飞书路径 0 风险。
- 代价：`deliveryStatus` 出现第二份事实源，`GET /v1/runs/:runId/delivery` 只能读飞书那份，
  或需要新的 API 分支；与"可信 schedule 配置决定收件人"的 provenance 原则（`src/delivery/targets.mjs:1-24`）冲突。
- 本文不推荐，但记录为合法备选，因为它是唯一"零改动已合并文件"的路径。

### 6.4 幂等键（不需要改，但必须写清）

| 事实 | 位置 |
| --- | --- |
| 键 = `${runId}#${type}:${id}` | `src/delivery/contracts.mjs:134-140` |
| 键校验 + 落盘时再验 | `src/delivery/contracts.mjs:143-145`、`src/delivery/store.mjs:52-56` |
| `sent`/`failed` 为终态，重放不再发送 | `src/delivery/coordinator.mjs:189-196` |
| 每次尝试**先落盘再发网络** | `src/delivery/coordinator.mjs:217-225` |
| 分段粒度续传（已确认的段不重发） | `src/delivery/coordinator.mjs:228-250`、`record.segmentsSent` |
| 每段 uuid（飞书第二重保险，可缺省） | `src/delivery/format.mjs:176-178` |
| 重启后的补偿重放（每 schedule 最多 1 条终态） | `src/delivery/scheduler.mjs:91-104`、`DELIVERY_LIMITS.reconcilePerSchedule`（`src/delivery/contracts.mjs:99-100`） |

结论：WeCom 只要把 type 定成全局唯一的字面量，**键、落盘、续传、重放全部复用**；
平台侧的"同一条消息重复发送"能力（若有）只能作为第二重保险，不能替代本地落盘。

---

## 7. Management API / 可观测性

- 现有 15 条 `/v1` 路由与错误模型见 `src/api/router.mjs:18-98`、`src/api/contracts.mjs:41-61`；
  错误码 `invalid_request/not_found/conflict/busy/internal_error/method_not_allowed/`
  `unsupported_media_type/payload_too_large`（`src/api/contracts.mjs:41-50`）。
- 投递读回：`GET /v1/runs/:runId/delivery`（`src/api/router.mjs:90-97`）→ `controller.getRunDelivery()`
  （`src/api/controller.mjs:243-251`）→ 注入的 `getRunDelivery`（`src/api/server.mjs:92-95`）→ 来自
  `createDeliveringScheduler` 的 `getRunDelivery`（`src/delivery/scheduler.mjs:139`）。
  ⇒ WeCom 投递若走同一 coordinator，**API 不需要加路由**。
- 监听面只能是 `127.0.0.1` / `::1`（`src/api/contracts.mjs:22`、`src/api/policy.mjs:15-27`），
  **不能**被当作 WeCom 的回调入口（§9-R7）。
- 全链路 trace 的现有抓手（不加新依赖即可用）：run `runId`（`src/runtime.mjs:198`）、研究 `runId`
  （`src/research/contracts.mjs`/run-store）、trigger `dedupeKey`（`src/scheduler/schedule.mjs:429-431`）、
  delivery `deliveryKey`（`src/delivery/contracts.mjs:134-140`）。四者已能串起
  "消息 → run → trigger → 投递"，实现时只需要在日志里坚持携带它们。

---

## 8. 日志与证据卫生（跨渠道统一口径）

| 规则 | 现有实现 | WeCom 注意 |
| --- | --- | --- |
| 不记正文 | channel 只发 outcome（`src/channels/feishu/channel.mjs:232-253`），research 只记状态/耗时 | 同 |
| 不记完整 id | `maskId`（`src/channels/feishu/config.mjs:182-185`） | sender userid 是稳定人员标识，**不要**用 6+4 掩码（会暴露人）；改整段哈希或只记 `sender:present` |
| 不记 secret | `describeConfig()`（`src/config.mjs:225-237`）、`describeFeishuConfig()`（`src/channels/feishu/config.mjs:140-147`）只输出"是否配置" | 同构 `describeWecomConfig()` |
| 文本脱敏 | `redactSecrets()`（`src/config.mjs:240-250`）+ `classifyError`（`src/errors.mjs:51-53`） | 需把 WeCom secret 显式放进 `secrets` 数组 |
| 错误不外泄路径/栈 | `mapApiError()`（`src/api/router.mjs:142-179`）只回分类码 | 同 |

---

## 9. 真实风险清单

> 每条都写"触发条件 / 现在的代码事实 / 不验证就不要声称通过"。
> 标注 **待 t2** 的条目，其平台事实以 [AGT-031 / #13](https://github.com/uichat-mira/cloud-pi/issues/13) 结论为准。

### R1 连接重连与"重连即重投"

- 事实：飞书完全依赖 SDK 自带重连（`src/channels/feishu/transport.mjs:8-10`、`:240-254`），本仓库没有应用级重连、
  没有 keep-alive；scheduler 的 tick 定时器是 `unref()` 的（`src/scheduler/scheduler.mjs:577-578`），**不构成进程存活来源**。
- 风险：若 WeCom SDK 不提供等价重连，需要 adapter 自己写有界退避；一旦重连期间平台重投事件，
  而进程内 dedupe 已在重启后清空（`src/channels/feishu/dedupe.mjs:9-12`），同一条消息会**再跑一次模型**。
- 不可声称：只做"连接成功"的 smoke，就宣称"收发稳定"。

### R2 ACK / 回调超时

- 事实：`channel.handleEvent()` 同步返回路由决策，模型在后台跑（`src/channels/feishu/channel.mjs:502-555`）；
  `src/channels/feishu/service.mjs:48-53` 明确不阻塞 SDK dispatcher；transport 捕获 handler 异常只记日志（`src/channels/feishu/transport.mjs:227-237`）。
- 风险：若 WeCom 采用 URL 回调模式，"处理中不得等待模型"是**平台硬约束**（具体超时值 **待 t2**）。
  当前设计天然满足，但任何"在事件回调里 await reply"的实现都会踩线。
- 不可声称：把"回调 200"当成"消息已处理"。

### R3 重复事件

- 事实：`reserve()` 在任何异步 run 前同步占位（`src/channels/feishu/channel.mjs:525`），TTL 24h/2048 条（`src/channels/feishu/dedupe.mjs:14-15`）。
- 风险：单进程内有效；多实例或重启后无效。WeCom 是否重投、重投时间窗 **待 t2**。
- 缓解（实现期）：事件 id 缺失时**必须**回退消息 id（`src/channels/feishu/events.mjs:94` 的约定），否则 `missing_dedupe_key`
  会丢弃消息——这是"静默不回复"的最可能根因。

### R4 长报告分段与长度单位

- 事实：分段预算 `DELIVERY_LIMITS.maxCharsPerSegment = 4000`（`src/delivery/contracts.mjs:98`）、
  最多 3 段（`:96`）；`splitBounded()` 按 **Unicode 码点**计数（`src/delivery/format.mjs:21-28`、`:41-89`），
  末尾附截断标记（`:19`、`:68-74`）。
- 风险：若 WeCom 的限制是**字节**而非字符，4000 个中文码点 ≈ 12000 字节，单条消息会超限；
  而现有 formatter **无法**表达字节预算。缓解是给 WeCom 的 coordinator 传一个更小的
  `limits.maxCharsPerSegment`（`src/delivery/coordinator.mjs:37-53`、`:108` 已支持覆盖），把码点预算压到
  安全值（例如按最坏 3 字节/码点反推）。**不要**为此改 `src/delivery/format.mjs`，除非 t2 证明字节限制确实存在。
- 不可声称：本地小文本发送成功 = 长报告可投递。

### R5 代理与出网

- 事实：研究工具走 `RESEARCH_HTTPS_PROXY`（`src/research/contracts.mjs:159`）；飞书 SDK 直连（AGT-035 §3 记录）；
  本机直连外网不稳定是已记录的环境事实（`docs/engineering/agt-035-feishu-collaboration.md` §4.1、§6）。
- 风险：把 `HTTPS_PROXY` 全局打开会同时改变研究出网与飞书/企微长连接行为；企业微信 API 是否需要代理 **待 t2**。
- 缓解：transport 显式接收 agent/代理选项；通道进程与研究进程的代理配置分离、各自显式注入。

### R6 身份映射与脱敏

- 事实：通道身份不参与授权（`src/channels/feishu/policy.mjs:12-13`）；日志掩码是 6+4（`src/channels/feishu/config.mjs:183`）。
- 风险一：把 WeCom userid 当成 Mira Cloud Account / Guanlan consumer 使用 → 违反 AGENTS.md 硬边界 3，
  必须由 Cloud Auth 侧另行裁决。
- 风险二：企业微信 userid 常是稳定员工标识（姓名缩写/工号），6+4 掩码等于半公开。
- 不可声称：拿到 userid = 完成身份接入。

### R7 无公网回调入口

- 事实：飞书方向不需要入站端口（`src/channels/feishu/transport.mjs:240-256` WS 长连接）；管理 API 只能绑回环
  （`src/api/policy.mjs:15-27`），因此**不能**复用它当回调服务器。
- 风险：若 t2 推荐的是 URL 回调模式，Windows 开发机/内网主机需要公网可达的 HTTPS 入口 +
  URL 验证握手 + 签名/解密参数 + 重放窗口；这套东西本仓库目前**一行都没有**。
  若 t2 推荐长连接模式，此风险消失，但要在部署文档里明确"无常驻入站端口"。
- 不可声称：本机用 `curl` 打通本地端口 = 平台回调验证通过。

### R8 Windows 常驻进程

- 事实：`npm run channel:feishu` 是前台 Node 进程（`package.json:20`），无守护/无自启；
  信号处理只覆盖 `SIGINT`/`SIGTERM`（`src/channels/feishu/server.mjs:38-42`），Windows 下"关窗口"不等于优雅停止；
  退出码 0/1/2 有明确含义（`src/channels/feishu/server.mjs:30-32`、`:52`）。
- 风险：进程被关掉后周期任务静默停止；`unref()` 的 tick 定时器不会阻止进程退出
  （`src/scheduler/scheduler.mjs:577-578`），所以"进程活着"完全依赖通道连接句柄。
- 缓解（实现期）：显式存活探针（管理 API `GET /v1/health` 已有，`src/api/router.mjs:19`）+
  外部计划任务拉起；不要在 Windows 上假设 POSIX 信号语义。

### R9 回复失败与二次消息

- 事实：`safeReply()` 吞掉异常但记 outcome（`src/channels/feishu/channel.mjs:270-283`）；`/stop` 之后被中止的 run
  **不再**发第二条消息（`:402-414`）；无活动 run 的 `/stop` 只回一句（`:473-495`）。
- 风险：平台侧"回复失败但消息已送达"或反之，会造成用户视角重复/缺失。平台是否支持幂等回复 **待 t2**。
- 不可声称：日志无 error = 用户收到了回复。

### R10 权限/凭据仍是外部阻塞

- 事实：飞书 POC 的凭证全部按进程注入，`.env.example` 明确不落库（`.env.example:21-32`）；
  企业微信需要管理员配置与机器人凭证，当前**未提供**（团队已知阻塞项）。
- 结论：离线测试与文档只能证明"Cloud Pi 侧接口就绪"，**不能**证明真实收发；
  真实端到端验收（t12）必须等维护者提供配置，且不得用 mock 替代。

---

## 10. 断言自检

本文所有 `文件:行号` 断言都可直接复核（`dev@8efc250`）：

```bash
# 运行面
sed -n '143p;187p;372p;499,526p' src/runtime.mjs
sed -n '10p;51,100p' src/errors.mjs

# 通道内核两处平台缝 + 内部机制
sed -n '183,192p;502,529p' src/channels/feishu/channel.mjs
sed -n '26,49p' src/channels/feishu/policy.mjs
sed -n '65,97p' src/channels/feishu/events.mjs
sed -n '14,15p;44,54p' src/channels/feishu/dedupe.mjs

# 投递 destination 卡点（关键）
sed -n '117,129p;130p;146,190p' src/scheduler/contracts.mjs
sed -n '386,392p' src/scheduler/schedule.mjs

# 幂等键与分段
sed -n '90,101p;134,155p' src/delivery/contracts.mjs
sed -n '189,196p;217,250p;265,278p' src/delivery/coordinator.mjs
sed -n '19,28p;41,89p;176,178p' src/delivery/format.mjs

# 配置/脱敏/常驻
sed -n '182,185p' src/channels/feishu/config.mjs    # maskId
sed -n '240,250p' src/config.mjs                    # redactSecrets
sed -n '577,578p' src/scheduler/scheduler.mjs
sed -n '15,27p' src/api/policy.mjs
```

本文件写作时的验证命令与结果：

```bash
git -C <worktree> rev-parse --short HEAD     # 8efc250（= origin/dev）
grep -rn "wecom\|WeCom\|企业微信" src/        # 0 命中：WeCom 面确实是新增，无历史实现可复用
```

---

## 11. 待裁决 / 待 t2 结论

**需要维护者裁决**

1. 是否接受方案 W1（destination 词表扩展 + `SCHEDULER_CONTRACT_VERSION` 1→2 的兼容读），
   还是选择 W2（WeCom 独立投递存储、飞书零改动）。
2. WeCom 与飞书是否共享同一个 agent runner 实例（并发 1 vs 2，2C2G 目标机上内存需评估）。
3. WeCom 消息里的发送者身份**是否允许**进入任何持久化记录（本文建议默认不持久化）。

**需要 t2（AGT-031 / #13）结论才能定稿**

4. 接入模式：长连接 vs URL 回调（直接决定 R7 是否成立、`transport.start()` 的形态）。
5. 事件 ACK 语义与超时值（R2）、事件重投窗口（R3）。
6. 单条消息的长度单位（码点/字节）与上限（R4）。
7. destination 的两类 id 的准确名称与是否可直接用于主动发送（§6.3 命名）。
8. 是否需要显式 @ 才能进群消息、机器人自身身份的稳定标识（§4.3）。
9. 可重试的错误分类（§4.4 第 4 条）与是否提供发送去重（§4.4 第 3 条）。
10. 官方 SDK 的 license / Node 22-24 兼容性 / 依赖体积（`package.json:30-38` 现有依赖已全部锁版本）。

**本卡未做的事**

- 未实现任何代码，未改 `src/`，未改 `.env.example`（变量名待定稿）。
- 未做任何企业微信 Live 连接；无凭证，且不得用 mock 冒充。
- 未开 PR：`cloud-pi` 当前没有 AGT-036 的 Issue（检索 `AGT-036` 命中 0），而按组织纪律 PR 必须关联 Issue；
  Issue 创建需维护者授权。建议在 t4 一并处理（Issue + 实现 + Draft PR）。
