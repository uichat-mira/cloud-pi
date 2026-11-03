# AGT-03x 验收基线：现有运行面盘点与飞书回归基线

- 执行日期：2026-11-04（Asia/Shanghai）
- 执行者：verifier（独立 worktree，只读运行，未修改任何 `src/` 代码）
- 基线代码：`uichat-mira/cloud-pi` `origin/dev` @ `8efc2507e088ea7e94b60db19e7671db8904705c`
- 分支 / worktree：`docs/agt-03x-acceptance-baseline` / `D:\cloud-pi-wt\verify`
- 依赖组织规范：`uichat-mira/.github` `main` AGENTS.md（Policy revision `2026-09-16.2`）、`docs/engineering/testing-standard.md`
- 依赖仓库规范：`cloud-pi/AGENTS.md`（本仓库根）

## 0. 本文能证明什么、不能证明什么

**能证明**：在 Windows + Node v24.9.0 上，dev@8efc250 的离线回归与两个本地证据脚本的真实执行结果，包含 2 个确定性失败项及其根因。

**不能证明**：真实飞书 API、真实模型推理、真实企业微信收发、真实 Cloud Auth 令牌、真实 Guanlan 远端 MCP。这些都需要凭证与管理员配置（见 §6）。

组织 `testing-standard.md` 的分层口径：本基线覆盖 **T1/T2/T3**（单元 / 契约 / 运行时集成）与两个**本地**证据脚本；**T4 环境 E2E** 与 **T5 生产 smoke** 一次都没有执行，也没有可执行的环境。

## 1. 环境与前置条件

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows（本机），PowerShell 7 |
| Node | `v24.9.0` |
| npm | `11.6.0` |
| git | `2.46.0.windows.1` |
| 依赖安装 | `npm ci --no-audit --no-fund` → `added 180 packages in 5s` |
| Guanlan fixture | 已由 `scripts/prepare-guanlan-fixture.mjs` 预备在 `%TEMP%\cloud-pi-guanlan`，`HEAD=3362ef9254be154694cb786fc35921884c62b792`（与脚本 pin 一致），`dist/` 与 `node_modules/miniflare` 均存在 |
| `.env` | worktree 内不存在；主工作树 `D:\cloud-pi\.env` 存在但**未**复制或读取（本地凭证不跨 worktree 传递） |
| 网络 | 直连 GitHub 时好时坏：一次 `git fetch origin dev` 失败、`git -c http.proxy= -c https.proxy= fetch` 成功；随后 `git clone` 直连超时、经 `http://127.0.0.1:1080` 代理成功。npm 装包未走代理 |

### `npm test` 的 pretest 语义（重要）

`package.json` 中 `test` 有 `pretest`：`node scripts/prepare-guanlan-fixture.mjs`。它会：

- 未设 `GUANLAN_DIR` 时，在 OS 临时目录克隆 `uichat-mira/cloud-mcp-guanlan`，`checkout --force` 到 pinned commit，然后 `npm ci` + `npm run build`；
- 本次因为临时 clone 已存在且 HEAD/产物/依赖齐备，走 `reuse` 分支，**没有联网、没有重建**，实测耗时含在 28.8s 内；
- 在 CI（干净 runner）上这一步会真实 clone 并构建，耗时与网络依赖远高于本次测得值 —— 本次的 28.8s **不能**当作 CI 耗时基线。

## 2. 现有运行面盘点

### 2.1 进程级入口

| 入口 | 命令 | 代码 | 对外契约 | 失败语义 |
| --- | --- | --- | --- | --- |
| 单次 Agent | `npm run agent -- "<prompt>"`（`agent:json`） | `src/cli.mjs` | 一次 `createAgentRuntime().run()`；人读摘要或 `--json` 的 `{config, record}`；run record 是稳定契约 | exit `0` succeeded / `1` failed·timeout·cancelled / `2` 配置无效（`ConfigError`/`RuntimeError`）；密钥不入 stdout，provider 错误经 `redactSecrets` |
| 飞书常驻通道 | `npm run channel:feishu` | `src/channels/feishu/server.mjs` → `service.mjs` | 长连接收事件 → Channel → 单轮 run / `/research` → 原消息回复；每行一条 JSONL 日志（不含正文、secret、完整 id） | exit `0` 收到信号后干净 drain / `1` 有活跃工作未能 drain / `2` `FeishuConfigError`·`ConfigError`；启动失败写 `feishu_channel_start_failed` |
| 本地管理 API smoke | `npm run api:smoke` | `scripts/agt-034/api-smoke.mjs` | 真实 loopback HTTP server + 真实 Scheduler + 真实 AGT-028 executor，仅 AGT-027 port 是确定性 fixture；输出 JSONL 证据 | 任一断言失败即抛错，非 0 退出；成功末行为 `{"event":"result","ok":true,...}` |
| 调度重启/恢复证据 | `npm run scheduler:poc` | `scripts/scheduler-poc-evidence.mjs` | 真实子进程 + 真实磁盘 store，AGT-027 port 为 fixture；打印两个场景的完整状态快照 | 子进程退出码不在白名单（场景 B 期望硬退出 `42`）即 reject；成功末行 `POC evidence complete: no real model or network call was made.` |
| 研究（真实链路） | `npm run research` | `scripts/research.mjs` | 真实模型 + 真实网络的研究运行（需 `.env`） | **本次未执行**（无凭证，见 §6） |
| 飞书一次性 Live | `npm run feishu:live` | `scripts/feishu-live-poc.mjs` | 等待一条真人发送的匹配事件并写脱敏证据 | **本次未执行**（无凭证 + 需真人操作） |
| Live 测试套件 | `npm run test:live` | `scripts/run-live-tests.mjs` | 真实 provider/网络用例 | **本次未执行**（无凭证） |

**结论：目前没有「一个进程同时承载 Feishu + Scheduler + Delivery + API」的统一运行入口。** `createDeliveringScheduler()` 与 `createManagementApi()` 的组合只出现在证据脚本里（`scripts/agt-033/local-delivery-evidence.mjs`、`scripts/agt-035/live-collaboration-evidence.mjs`、`scripts/agt-034/api-smoke.mjs`），不在任何产品入口中。

### 2.2 模块级契约

| 模块 | 代码 | 对外契约 | 失败语义 |
| --- | --- | --- | --- |
| Channel 适配器 | `src/channels/feishu/channel.mjs` | `createFeishuChannel({allowedChatIds, botOpenId, runTurn, runResearch, reply, log, onOutcome})`；`handleEvent`、`stopAll`、`whenIdle`；回复词表 `CHANNEL_REPLIES`；研究命令 `/research`、`/研究`；停止词 `/stop`、`/cancel`、`停止`、`取消`；研究回复上限 1800 字符 | 不 import 网络与 Pi SDK（可用假 run/reply 测）；未授权群/未 @/非 user/非文本/空文本一律忽略且不调 Runtime；`/stop` 无活跃运行时只回一句、不调用 Runtime；被 abort 的 run 不再发第二条消息 |
| 事件归一 | `src/channels/feishu/events.mjs` | `normalizeFeishuMessageEvent` / `readFeishuEventType` / `FEISHU_MESSAGE_EVENT` | 非消息事件、缺字段返回 null（fail closed） |
| 路由策略 | `src/channels/feishu/policy.mjs` | `decideFeishuRoute` | 私聊允许；授权群必须明确 @bot 且 bot open_id 已验证，否则忽略 |
| 去重 | `src/channels/feishu/dedupe.mjs` | `createDedupeStore({ttlMs, maxEntries})`；key 优先 `event:${event_id}`，回退 `message:${message_id}` | 两者都缺失则忽略；key 在任何异步 run 前同步预留；**进程内** TTL 24h / 上限 2048，重启不共享 |
| 通道 runtime | `src/channels/feishu/runtime.mjs` | `createFeishuAgentRunner` / `createFeishuResearchRunner` / `feishuChannelPromptExtension` | 每次 `run()` 新建 Session、不保留历史；`allowedTools`/`exposedTools`/`customTools` 全空 → 飞书消息无法触发任何本地或 MCP 工具；会话 cwd 为私有临时目录 |
| 传输 | `src/channels/feishu/transport.mjs` | `createFeishuTransport({config, onEvent, log})` → `start()`/`stop()`/`reply()`/`getBotOpenId()`；官方 `@larksuiteoapi/node-sdk` WSClient + `im/v1/messages/:id/reply` | 只有连接级重连（SDK 提供），**没有**应用级发送重试；投递失败只记录 outcome |
| Scheduler | `src/scheduler/*` | `createScheduler({stateDir, researchDeps})`：`createSchedule`/`load`/`update`/`delete`/`enable`/`pause`/`runNow`/`start`/`stop`/`tick`/`cancel`；`SCHEDULE_KIND`=once·recurring；`SCHEDULE_STATUS`=active·paused·completed；`TRIGGER_STATUS`=scheduled·started·succeeded·partial·failed·cancelled·timeout·interrupted·missed；`MISSED_RUN_POLICY`=coalesce_one；`SCHEDULER_CONTRACT_VERSION`=1 | 无 HTTP 层；update/delete 在持有 lease 或活跃 controller 时 fail closed；`completed_with_errors` → `partial`，**绝不**映射成 `succeeded`；重启把仍 running 的 trigger 标 `interrupted`（不重试）；同一 tick 重复触发由 dedupeKey 去重 |
| 投递 | `src/delivery/*` | `createDeliveringScheduler` / `createDeliveryCoordinator`；幂等键 `${runId}#${type}:${id}`；`DELIVERY_STATUS`=pending·sent·failed；`DELIVERY_RUN_STATUS`=none·pending·sent·partial·failed；`DELIVERY_KIND`=report·report_partial·status·none；`DELIVERY_ERROR` 6 类；上限 maxAttempts 3 / retryDelayMs 250 / maxSegments 3 / 4000 字符/段 | 收件人只来自可信 schedule 配置，报告/消息/模型输出不能改写目标；单目标失败不改写他目标记录、不回滚研究结论；研究失败时按 `DELIVERY_KIND` 降级为状态通知或不发 |
| 研究执行 | `src/research/*` | `executeResearch` / `startResearch` / `readResearchRun` / `listResearchRuns`；artifact 根解析 `rootDir` > `RESEARCH_RUNS_DIR` > `.work/research-runs`；`RUNTIME_PORT_VERSION`=1 | 不读凭证、不建 Pi session、不直接联网（由注入的 port + toolLayer 承担）；runtime 缺失时 `RuntimeUnavailableError`（`runtime_unavailable`）fail closed；`RunStoreError` 分 `not_found`/`parse_error`/`invalid_run_id`；损坏 run 目录在 `list` 中被跳过 |
| Runtime port 适配 | `src/research/runtime/agt-027.mjs` | `createAgt027RuntimePort({module})` → `runAgent({systemPrompt, prompt, customTools, limits, signal, onEvent})`；系统提示通过 Pi `before_agent_start` 扩展前插 | 状态映射 `succeeded|completed`→`completed`，其余→`failed`/`timeout`/`cancelled`；运行前后建/删临时 cwd（避免加载仓库 `AGENTS.md`）；`blocked` 的工具调用不得报成 ok |
| 管理 API | `src/api/*` | `createManagementApi({scheduler, runsDir, host, port, env, shutdownTimeoutMs})` → `start()`/`stop()`；`API_PREFIX=/v1`，`API_CONTRACT_VERSION=1`；路由：`GET /v1/health`、`GET /v1/status`、`GET|POST /v1/schedules`、`GET|PATCH|DELETE /v1/schedules/:id`、`POST …/:id/{pause,enable,run-now,cancel}`、`GET /v1/runs`、`GET /v1/runs/:runId`、`GET /v1/runs/:runId/report`、`GET /v1/runs/:runId/delivery`；错误类 8 个（400/404/409/503/500/405/415/413） | 只接受字面 `127.0.0.1`/`::1`，其它 host（含 `0.0.0.0`、`localhost`）在开 socket 前拒绝；未分类异常一律 `internal_error`（不带 stack/路径）；视图层逐字段投影，绝不原样返回存储记录 |
| 目标解析 | `src/delivery/targets.mjs` | `TARGET_TYPE`=open_id·chat_id；`UNAVAILABLE_REASON`=bot_not_in_chat·chat_name_ambiguous·open_id_not_observed；`TARGET_CONTRACT_VERSION`=1 | 群只解析成平台 `im/v1/chats` 真实返回过的 `chat_id`；不可用情况明确报告而不是编造身份；本模块不发消息 |
| MCP 绑定（P0） | `poc/pi-session.mjs`（配套 `poc/guanlan-fixture.mjs`、`scripts/prepare-guanlan-fixture.mjs`） | 真实 Pi SDK：`createMcpExtension({logPath})` + `pi.registerMcpServer("guanlan", {url, headers:{Authorization}, exposure:"direct", timeout})`，`tools:["mcp__guanlan__*"]`，模型用 SDK 自带 `fauxProvider` | `pi.on("tool_call")` 权限门可 `{block:true, reason}` 拒绝未授权 MCP 工具；fixture 令牌只经 MCP server header，不进 prompt/工具参数/日志 |
| MCP 绑定（AGT-027 runtime） | `src/runtime.mjs` | `createAgentRuntime({config, cwd, customTools, allowedTools, exposedTools, extensionFactories})`；`allowedTools` 支持精确名与 `*` 通配（如 `mcp__guanlan__*`），默认为空即什么都不允许；`run()` 在同一实例内串行 | 扩展工厂是唯一注入点（AGT-028/未来 AGT-038 的 MCP 走这里）；key 从 `process.env` 删除后再建 session，避免 stdio 子进程继承 |

### 2.3 已核实的不存在项（缺口事实，不是猜测）

- `src/`、`scripts/`、`tests/` 中 **没有任何** `wecom` / `work_weixin` / `企业微信` / `aibot` 标识 —— 企业微信通道零代码、零测试。
- `src/` 中 **没有** `trace` / `traceId` / `span` 相关实现（唯一命中是 `router.mjs` 注释里的 "stack trace"）。全链路 Trace 目前只有各进程各自的 JSONL 日志，没有任何跨组件关联 id。
- 没有统一运行入口（见 §2.1 结论）。
- 生产/远端 MCP 尚未接入：`poc/` 只连本地 workerd fixture，`src/research/tools/*` 是自研 HTTP 抓取工具层（search/read-page），不是 Guanlan MCP。

## 3. 基线执行结果（真实执行）

所有命令在 `D:\cloud-pi-wt\verify` 下顺序执行，未并发，避免端口/CPU 干扰。

| # | 命令 | 退出码 | tests | pass | fail | `duration_ms`（runner 自报） | 墙钟耗时 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `npm test` | **1** | 555 | 553 | **2** | 28010.18 | 28.8 s | 含 pretest（走 `reuse`）；2 个失败均为 Windows 可移植性断言，见 §4 |
| 2 | `npm run test:feishu` | 0 | 48 | 48 | 0 | 1885.07 | 2.2 s | AGT-029，无 pretest |
| 3 | `npm run test:api` | 0 | 26 | 26 | 0 | 2296.11 | 2.6 s | AGT-034 |
| 4 | `npm run test:scheduler` | 0 | 31 | 31 | 0 | 809.77 | 1.1 s | AGT-030（t1/t2/t3 三个文件） |
| 5 | `npm run test:targets` | 0 | 29 | 29 | 0 | 373.96 | 0.7 s | AGT-035 |
| 6 | `npm run api:smoke` | 0 | — | — | — | — | 1.3 s | `{"event":"result","ok":true,"requests":18}` |
| 7 | `npm run scheduler:poc` | 0 | — | — | — | — | 0.9 s | 两场景全绿；末行 `POC evidence complete: no real model or network call was made.` |

`npm test` 自报汇总原文（runner 输出，非改写）：

```text
ℹ tests 555
ℹ suites 80
ℹ pass 553
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28010.1779
```

细粒度脚本自报汇总原文：

```text
# test:feishu     ℹ tests 48  ℹ suites 15  ℹ pass 48  ℹ fail 0  ℹ duration_ms 1885.0701
# test:api        ℹ tests 26  ℹ suites 0   ℹ pass 26  ℹ fail 0  ℹ duration_ms 2296.1087
# test:scheduler  ℹ tests 31  ℹ suites 0   ℹ pass 31  ℹ fail 0  ℹ duration_ms 809.7683
# test:targets    ℹ tests 29  ℹ suites 0   ℹ pass 29  ℹ fail 0  ℹ duration_ms 373.9627
```

**文档漂移（实测 vs 仓库文档）**：`docs/engineering/agt-032-feishu-research.md` 写 `tests 438 / pass 438`，`agt-034-local-management-api.md` 写 `424 tests` 与 "25 tests, 25 pass" 的 API 套件；实测全量为 **555**、API 套件为 **26**。差异源于后续 AGT-035 合入与用例增补，属于文档滞后，不影响结论，但说明「文档里的数字」不能当基线。

### 3.1 入口级 smoke 的可复核输出（节选，全程脱敏）

`npm run api:smoke`（真实 loopback server + 真实 Scheduler + 真实 executor，端口由 OS 分配，每次不同）：

```json
{"event":"bind-policy","requestedHost":"0.0.0.0","rejected":true,"code":"invalid_request"}
{"event":"listen","host":"127.0.0.1","family":"IPv4","port":5886,"url":"http://127.0.0.1:5886/v1"}
{"event":"request","label":"create","method":"POST","path":"/schedules","status":201}
{"event":"run-now","scheduleId":"smoke-daily","triggerStatus":"succeeded","researchStatus":"completed","runId":"r-20261103T000000-e2db62"}
{"event":"request","label":"delivery","method":"GET","path":"/runs/r-20261103T000000-e2db62/delivery","status":404,"code":"not_found"}
{"event":"restart-consistency","before":{"scheduleId":"smoke-daily","nextRunAt":"2026-11-03T01:00:00.000Z","lastRunId":"r-20261103T000000-e2db62","triggerCount":1},"after":{"scheduleId":"smoke-daily","nextRunAt":"2026-11-03T01:00:00.000Z","lastRunId":"r-20261103T000000-e2db62","triggerCount":1},"consistent":true}
{"event":"stop","drained":true}
{"event":"result","ok":true,"requests":18}
```

`delivery` 返回 404 是**预期**：该 smoke 没有配置 `deliveryTargets`，投递视图只在 AGT-033 组合根存在时可用。

`npm run scheduler:poc` 关键事实（原文节选）：Scenario A 干净重启后 `nextRunAt` 从 `2026-11-04T01:00:00Z` 推进到 `2026-11-05T01:00:00Z`、`stats.succeeded=2`、`duplicateTickTriggered: 0`；Scenario B 硬退出（子进程 exit `42`）后恢复运行，把原 trigger 标为 `interrupted` 并写下 `code: "interrupted"` 的错误，`stats.interrupted=1`，随后下一次触发 `succeeded`。

## 4. 两个确定性失败项（照实记录 + 根因）

两者都是**测试代码的 Windows 可移植性缺陷**，不是产品回归；都在 `origin/dev` 原样代码上复现，与本次 worktree 无关。已单独重跑两个文件确认可重复（数值完全一致）。

### 4.1 `tests/research-store.test.mjs:52` — `resolveRunsRoot: explicit > env > default`

```text
✖ resolveRunsRoot: explicit > env > default (2.546ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'D:\\tmp\\explicit'
  - '/tmp/explicit'
      at TestContext.<anonymous> (file:///D:/cloud-pi-wt/verify/tests/research-store.test.mjs:53:10)
```

根因：测试字面量使用 POSIX 路径 `"/tmp/explicit"`，而 `resolveRunsRoot()` 按契约 `resolve()` 成绝对路径；Windows 上 `D:\tmp\explicit`。生产代码行为正确，断言跨平台不成立。

### 4.2 `tests/research-verify-adapter.test.mjs:162` — 「policy 进入模型可见系统提示且 runtime 提示保留」

```text
✖ the research policy reaches the model-visible system prompt and the runtime prompt survives (91.1308ms)
  AssertionError [ERR_ASSERTION]: cwd must not be inside the repository
      at TestContext.<anonymous> (file:///D:/cloud-pi-wt/verify/tests/research-verify-adapter.test.mjs:202:12)
```

根因：断言 `relative(REPO_ROOT, sentinel.cwd).startsWith("..")`（第 202 行）假设 repo 与临时目录同盘。本机 repo 在 `D:\`、`tmpdir()` 在 `C:\`，`path.relative()` 跨盘返回绝对路径，于是不以 `..` 开头。同一测试里紧邻的 `startsWith(realpathSync(tmpdir()))`（第 201 行）**通过**，说明「cwd 在 tmpdir 且不在仓库内」这一安全属性实际成立，失败的是断言写法。

### 4.3 跨平台交叉验证：同一份代码在 CI 上是绿的

本分支（`docs/agt-03x-acceptance-baseline`，测试代码与 `dev@8efc250` 完全一致）的 CI `Validate / test` job（`ubuntu-latest`，Node `22.19.0`，`npm test`）**通过**（run `41674641155`，head `b613f6b`）。结合 §4.1/§4.2 的根因（POSIX 路径字面量、跨盘 `path.relative()`），可以确定这 2 项失败是 **Windows 专有**，不是产品逻辑或依赖问题，也不是本次交付引入的。

### 4.4 对回归门禁的直接影响

`npm test` 在 Windows 上**不是绿的**（exit 1 / 2 fail）。因此：

- 不能在 Windows 上把 `npm test` 的退出码当作「飞书未退化」的判据；
- 现阶段可用的本机门禁 = `npm run test:feishu` && `npm run test:api` && `npm run test:scheduler` && `npm run test:targets`（134 项全绿，实测 6.6 s 墙钟），外加 `npm test` 的输出对比（要求 fail 集合恒为上述已知 2 项、且不得新增）；
- 修这两个测试属于 `tests/` 变更，不在本卡范围（本卡不改任何代码）；建议由 pi-dev 在后续卡片里顺手修掉，使 `npm test` 在 Windows 上重新可作为单一门禁。

## 5. 与组织测试标准的分层映射

| 层 | 覆盖情况 | 证据 |
| --- | --- | --- |
| T1 单元 | 有（配置、路由、去重、契约、格式化、时间语义） | `npm test` 内多个 suite；`test:feishu`/`test:api`/`test:scheduler`/`test:targets` |
| T2 契约 | 有（API 路由/错误契约、投递幂等与失败类、调度 trigger 状态机、runtime port、飞书事件/路由） | 同上；`tests/agt-033-contracts.test.mjs`、`tests/agt-034-*.test.mjs`、`tests/agt-029-policy.test.mjs` |
| T3 运行时集成 | 有（真实 Pi SDK Session + faux provider + 真实 MCP extension；真实 loopback HTTP server；真实子进程 + 真实磁盘 store） | `tests/p0-pi-mcp.test.mjs`、`tests/agt-027-runtime.test.mjs`、`tests/agt-029-runtime.test.mjs`、`tests/scheduler-t3.test.mjs`、`npm run api:smoke`、`npm run scheduler:poc` |
| T4 环境 E2E | **无**（历史 Live 证据见 `docs/engineering/agt-029-live-evidence.md`、`agt-027-live-evidence.md`、`poc/evidence/*`，均早于本次基线，不可复用于新功能） | — |
| T5 生产 smoke | **无**（无部署环境） | — |

## 6. 本次未执行的验证及原因

| 项 | 原因 |
| --- | --- |
| `npm run agent` / `npm run research` / `npm run test:live` | 需要真实模型凭证；worktree 内无 `.env`，主工作树的 `.env` 按纪律不复制、不读取 |
| `npm run channel:feishu` / `npm run feishu:live` | 需要 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 与真人发消息；凭证未注入本会话 |
| 真实企业微信收发 | 通道尚不存在，且维护者尚未提供企业微信管理员配置与机器人凭证（团队唯一外部阻塞项） |
| 真实 Guanlan 远端 MCP | 需要 Cloud Auth 签发的内部消费者凭证（GLN-013/GLN-014 尚未完成）；现有 P0 只连本地 workerd fixture |
| T4/T5 | 无 test/prod 环境，也不在授权范围内 |

**结论：本基线是「离线可复核基线」，不是产品验收。** 按组织 AGENTS 硬边界 7，离线 fixture 既不能证明真实服务签发，也不能证明真实部署。

## 7. 缺口清单：现有能力 vs 本任务目标（供 lead 排期校准）

| # | 目标能力 | 现状（本文已核实） | 缺口 | 归属卡片（团队任务） |
| --- | --- | --- | --- | --- |
| G1 | 真实企业微信收发 | 零代码、零测试、零脚本 | 需要 Channel（事件归一 / 路由 / 去重 / 停止）+ transport，并保证与 Feishu 同一 Agent 执行入口 | t3（研究）、t4（ADR）、t6（AGT-036 MVP） |
| G2 | 统一运行入口 | 只有 feishu-only 常驻进程；Scheduler+Delivery+API 只在证据脚本里组合 | 需要一个产品级组合根：Feishu + WeCom + Scheduler + Delivery + Management API 共存，且共享状态目录与优雅退出 | t7（AGT-037） |
| G3 | 真实 Guanlan MCP（Pi SDK 原生 extension） | P0 用 faux provider + 本地 workerd fixture + fixture 令牌；AGT-027 已支持 `extensionFactories` 与 `mcp__*` 白名单；研究工具层是自研 HTTP 抓取 | 需要真实令牌（Cloud Auth 签发）、真实远端 MCP URL、把 MCP 工具装进研究/通道 runtime 的 allowlist 与权限门 | t8（GLN-013）、t9（AGT-038）、t10（GLN-014） |
| G4 | 定时研究 + 主动投递 | Scheduler（once/recurring、missed 合并、重启恢复）与 AGT-033 投递（幂等、多目标、有界重试）均已实现并本地验证 | 投递目标只有 Feishu `open_id`/`chat_id`；企业微信需新增 transport 与目标类型；跨通道投递需保持同一幂等键语义 | t7（组合根）、t6（若目标解析需扩展） |
| G5 | 全链路 Trace | **无** traceId/span/关联 id；只有各进程独立 JSONL | 需要贯穿 入口→事件→run→trigger→delivery→API 读回 的关联 id 与白名单投影；这是新增设计面 | **无卡片**：建议 lead 新增或并入 t7 |
| G6 | Management API 可查 | `/v1` 15 条路由，loopback-only，字段白名单投影 | 需要能查企业微信会话/投递目标；需要「API 读回」成为验收矩阵的判定手段（已在草案中使用） | t7 / t11（验证矩阵落地） |
| G7 | 飞书通道不退化 | 48 项 feishu 套件全绿；全量 553/555（2 项 Windows 断言缺陷） | 需要把飞书回归固化成判据（见 acceptance-matrix 场景 C），并消除 `npm test` 的 Windows 假阴性 | t11（验证矩阵）、t12（E2E） |
| G8 | 未授权/无效凭证/重复消息/重启/投递失败 | 飞书侧已有 fail-closed 实现与 T1/T2 负例；调度侧重启与 interrupted 恢复有本地证据 | 企业微信侧全部为零；跨通道的重复消息与重启语义待设计 | t6、t7、t12 |

**需要 lead 裁决的两点**：(a) G5（Trace）当前没有归属卡，若并入 t7 会显著扩大 t7 范围；(b) `npm test` 的 2 个 Windows 断言缺陷需要有人修（本卡按纪律不改代码），否则「全量绿」无法作为验收判据。

## 8. 复现步骤

```powershell
# 1. 独立 worktree（从 origin/dev）
git -C D:\cloud-pi worktree add D:\cloud-pi-wt\verify -b docs/agt-03x-acceptance-baseline origin/dev
cd D:\cloud-pi-wt\verify
npm ci --no-audit --no-fund

# 2. 基线（顺序执行，勿并发）
npm test                 # 预期 exit 1：2 个已知 Windows 断言失败（§4）
npm run test:feishu      # 预期 48/48
npm run test:api         # 预期 26/26
npm run test:scheduler   # 预期 31/31
npm run test:targets     # 预期 29/29
npm run api:smoke        # 预期末行 {"event":"result","ok":true,...}
npm run scheduler:poc    # 预期末行 POC evidence complete: ...

# 3. 判定规则
#    - 上述 4 个细粒度套件必须 0 fail；
#    - npm test 的 fail 集合必须恰为 §4 的两个已知项，不得新增；
#    - 任何新增 fail = 回归。
```
