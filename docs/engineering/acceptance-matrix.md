# 验收矩阵（草案 v0）— Cloud Agent V1 真实企业微信闭环

- 状态：**草案**，随 AGT-031/036/037/038/GLN-013/014 推进修订
- 基线代码：`origin/dev` @ `8efc250`
- 基线证据：[docs/evidence/agt-03x-baseline.md](../evidence/agt-03x-baseline.md)（2026-11-04 实测）
- 组织口径：`uichat-mira/.github` `docs/engineering/testing-standard.md`（T1–T5 分层）

## 1. 使用规则

1. **一条判据 = 可执行判定**：每条判据必须写成「运行 X 命令 / 读取 Y 证据文件，看到 Z」，不接受「观察行为正常」「人工确认可用」这类不可复核描述。
2. **证据必须来自真实链路**：涉及企业微信、模型、Guanlan 的判据只接受真实 provider/真实企业微信 API/真实 MCP 的输出；fixture、faux provider、mock transport 的结果**只能**证明离线契约（T1/T2/T3），不能填进 T4/T5 判据。
3. **每一行都要标状态**：`可执行`（命令与代码已存在）／`待能力`（依赖尚未实现的卡片，注明卡号）／`待凭证`（外部阻塞）。
4. **判据不得自我弱化**：不允许因为跑不过而放宽断言、跳过用例或改判据口径；跑不过就是失败，并在报告中记录真实原因。
5. **脱敏**：证据只允许白名单投影与脱敏值（见 §2），任何密钥、完整 `open_id`/`chat_id`/`userid`、消息正文不得进入仓库。

## 2. 证据格式约定

### 2.1 允许写入仓库的字段（白名单投影）

| 类别 | 允许 | 禁止 |
| --- | --- | --- |
| 标识 | `runId`、`scheduleId`、`triggerDedupeKey`、脱敏后 id（`ou_***`/`oc_***`/`wm***`）、`traceId` | 完整 `open_id`/`chat_id`/企业微信 `userid`/`chatid`、应用 ID 全值 |
| 状态 | `status`、`code`（稳定错误码）、`outcome`、计数（`triggers`/`sent`/`attempts`） | 原始异常堆栈、绝对路径、环境变量快照 |
| 模型 | `providerId`、`modelId`、`usage.{input,output,total}`、`durationMs` | API key、base URL 中的凭证、完整 provider 响应体 |
| 内容 | 报告长度 `reportChars`、来源计数 `sourcesTotal`、来源域名 | 报告正文、抓取页面原文、用户消息正文 |
| 时间 | ISO 8601 时间戳（UTC 或带偏移） | — |

### 2.2 三类证据载体

| 载体 | 形态 | 用途 |
| --- | --- | --- |
| **脱敏 JSONL** | 每行一个 JSON 事件，字段受 §2.1 约束，落盘到 `poc/evidence/*.jsonl` 或 `docs/evidence/<card>/` | 证明「事件确实发生过」，可按时间排序与计数 |
| **API 读回** | `GET /v1/...` 的响应体（已过 `views.mjs` 白名单投影） | 证明「系统自己记下的状态」与运行链路一致，而不是脚本自己打印的结论 |
| **Trace 关联** | `traceId` 贯穿 入口→事件→run→trigger→delivery→API 读回 | 证明「同一条用户请求的各阶段可以串起来」；**当前代码无 trace 实现**，字段名与落地方式待 t7（AGT-037）定稿，本矩阵只固定「必须可关联」这一要求 |
| 测试输出 | `node --test` 汇总行（tests/pass/fail/duration_ms）+ 版本信息 | 证明离线回归（T1–T3）未退化 |

> Trace 草案（**待 t7 定稿，勿当成已实现**）：一次企业微信入站最迟在 `traceId` 下记录 `channel.ingress`、`channel.route`、`agent.run`、`scheduler.trigger`（若走定时）、`delivery.attempt`、`api.readback` 六类事件，每类含 `traceId`、`at`、`status`、`durationMs`、脱敏目标标识。判定时只要求「同一 traceId 下这六类事件齐全且状态自洽」。

### 2.3 通用前置条件（所有真实场景判据共同要求）

| 前置 | 判定方式 | 当前状态 |
| --- | --- | --- |
| 企业微信机器人凭证与管理员配置（回调/长连接模式、接收消息权限、可见范围） | 进程启动日志出现 `wecom_channel_started` 且不含 secret | **待凭证（外部阻塞，需维护者提供）** |
| 真实模型凭证 | `npm run agent -- "ping"` exit 0 且输出含 `provider`/`model`/`duration` | 待凭证（本机主工作树有 `.env`，worktree 内无） |
| 真实 Cloud Auth 内部消费者凭证（Guanlan） | `npm run test:live` 中 MCP 用例通过 | 待能力（t8 GLN-013 / t9 AGT-038） |
| loopback 管理 API 可用 | `npm run api:smoke` → `{"event":"result","ok":true,...}` | **可执行（已实测 exit 0）** |

## 3. 场景 A：企业微信主动提问（单轮真实往返）

目标：真人/真机在企业微信里 @机器人 提问，机器人用真实模型回答，同一会话可读回。

| # | 判据 | 判定方式（命令 / 证据） | 证据要点 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | 入站事件被接收并归一为可信字段（发送者、会话、消息 id、文本），且**未经模型**即完成路由判定 | 运行 `npm run wecom:live -- --expect reply`（**待新增**，t6 交付；类比现有 `npm run feishu:live`），检查 `poc/evidence/agt-036-live.jsonl` 中 `channel.ingress` 事件 | 事件数 ≥1；含 `traceId`、脱敏发送者/会话、`messageId`（脱敏）、`at` | 待能力（t6） |
| A2 | 真实模型推理发生且 usage 来自 provider | 同一 JSONL 中 `agent.run` 事件 | `providerId`、`modelId`、`usage.input>0`、`usage.output>0`、`durationMs`、`status:"completed"` | 待能力（t6） |
| A3 | 回复真实回到企业微信，且被平台接受 | JSONL 中 `delivery.attempt`/`reply.sent` 事件 + 真人在客户端看到答案（截图归档为本地附件，不入库正文） | `status:"sent"`、`messageId`（脱敏）、`attempts:1` | 待能力（t6） |
| A4 | 单轮不越权：该轮 `allowedTools`/MCP 工具集合与策略一致 | 运行 `npm run test:feishu` 不应变绿/变红（回归），并检查 A1 事件里 `tools.exposed` 数组为空或仅为白名单 | `tools.exposed` 与 `docs/engineering/agt-036-*.md` 声明的白名单逐项相等 | 待能力（t6） |
| A5 | 同一 `traceId` 能把 A1→A2→A3 串起来 | 用 `traceId` 过滤 JSONL：`Select-String -Pattern $traceId` | 三类事件全部命中，时间单调递增 | 待能力（t7 的 Trace） |

## 4. 场景 B：定时研究 + 主动投递

目标：Scheduler 按 cron 触发真实研究（真实模型 + 真实 Guanlan MCP），把结果主动投递到指定企业微信/飞书目标，并且可经 API 读回。

| # | 判据 | 判定方式 | 证据要点 | 状态 |
| --- | --- | --- | --- | --- |
| B1 | 到点触发恰好一次，且重复 tick 不产生第二次运行 | `npm run scheduler:poc`（已存在，离线证据）+ 真实场景下从 API 读回 `GET /v1/schedules/:id` | `stats.triggers` 增量 = 1；`stats.duplicatesSkipped ≥ 0` 且无重复 `runId` | 离线**可执行**；真实场景待能力（t7） |
| B2 | 研究是真实链路：真实模型 + 真实 Guanlan MCP 工具调用 | JSONL 中 `agent.run` + `tool.end`（`mcp__guanlan__*`） | `toolName` 形如 `mcp__guanlan__*`、`status:"ok"`、`durationMs>0`；`usage.*>0` | 待能力（t9 AGT-038） |
| B3 | trigger 终态与研究终态一致，`completed_with_errors` 不得显示为成功 | `GET /v1/schedules/:id` 的 triggers 与 `GET /v1/runs/:runId` 对比 | `trigger.status` 与 `run.status` 满足 `mapResearchStatusToTriggerStatus`；`partial ≠ succeeded` | **可执行（契约）**：`npm run test:scheduler`、`npm run test:api`；真实场景待能力 |
| B4 | 投递到每个配置目标各一次，且幂等（重放/重启不重复发） | `GET /v1/runs/:runId/delivery` + 投递 JSONL | 每目标一条 `sent`、`attempts:1`；重启后重放同一 run 仍为 `sent` 且不再新增消息 | 离线**可执行**（`npm run test:targets` + `api:smoke`）；真实待能力（t7） |
| B5 | 投递失败不污染研究结论、不影响其他目标 | 见 D4/D5（失败注入） | `run.status` 不变；其他目标仍 `sent`；失败目标 `failed` + 稳定 `code` | 离线**可执行**（`tests/agt-033-*`）；真实待能力 |
| B6 | 长报告按上限分段且有界重试 | `npm run test:targets` / `tests/agt-033-transport.test.mjs` | `maxSegments=3`、`maxCharsPerSegment=4000`、`maxAttempts=3` 生效 | **可执行** |
| B7 | API 读回的研究与磁盘 run store 一致 | 先 `GET /v1/runs/:runId`，再读 `run.json`（同一 `RESEARCH_RUNS_DIR`） | `runId`/`status`/`createdAt`/`finishedAt` 逐字段相等 | **可执行**（`npm run api:smoke` 已内含 restart-consistency） |

## 5. 场景 C：飞书回归（不得退化）

目标：企业微信接入后，飞书通道的行为与 2026-11-04 基线逐项一致。

| # | 判据 | 判定方式 | 证据要点 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | 飞书离线套件全绿且用例数不减少 | `npm run test:feishu` | `tests ≥ 48`、`fail 0`（基线：48/48，`duration_ms 1885`） | **可执行** |
| C2 | API / 调度 / 目标解析套件不退化 | `npm run test:api`、`npm run test:scheduler`、`npm run test:targets` | 26 / 31 / 29，`fail 0` | **可执行** |
| C3 | 全量 `npm test` 的失败集合不扩大 | `npm test` | 基线为 555 tests；Windows 上已知 2 项失败（`research-store.test.mjs:52`、`research-verify-adapter.test.mjs:162`，见基线 §4）。接入后要求：**失败集合 ⊆ 已知 2 项**，且新增用例必须 pass | **可执行**（判据即「不新增 fail」；建议 pi-dev 修掉这 2 项后改为「fail 0」） |
| C4 | 飞书真实往返仍可用（私聊 + 授权群 @） | `npm run feishu:live -- --expect reply`（真实凭证 + 真人发消息） | `poc/evidence/agt-029-live-p2p.jsonl` 形态的事件：`status:"sent"`、真实 `runId`、`usage` 非零 | **待凭证** |
| C5 | 飞书侧安全语义未被新通道改动 | `npm run test:feishu`（policy/dedupe 用例）+ 代码审阅 `src/channels/feishu/policy.mjs` 未被企业微信改动波及 | 未授权群/未 @/bot open_id 未验证 三类负例仍 fail closed | **可执行** |
| C6 | 飞书与企业微信共享同一 Agent 执行入口（不出现第二套 runtime） | 代码检查：企业微信 runner 必须调用 `src/runtime.mjs:createAgentRuntime().run()` 或 `src/research/runtime/agt-027.mjs` 的既有 port | 无新增 provider/session 装配实现；`grep -r "createAgentSession" src/` 仅出现在 AGT-027 一处 | 待能力（t6 交付时审） |

## 6. 场景 D：故障与安全（未授权、无效凭证、重复消息、重启、投递失败）

| # | 判据 | 判定方式 | 证据要点 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | 未授权会话（未在白名单 / 非 @ / 非文本 / 空文本 / 非 user 发送者）一律忽略且**不调用模型** | `npm run test:feishu`（`agt-029-policy`/`agt-029-channel` 负例）+ 企业微信对应负例（t6 新增） | 断言 `runTurn` 调用次数 = 0；JSONL 中只有 `channel.ignored` + `reason`，无 `agent.run` | 飞书**可执行**；企业微信待能力（t6） |
| D2 | 无效/过期凭证 fail closed，不降级为可用 | 用错误凭证启动通道：`FEISHU_APP_SECRET=invalid npm run channel:feishu`（企业微信同类） | exit `2`（配置无效）；或 `feishu_channel_start_failed` / `wecom_channel_start_failed` 含稳定 `code`；**不得**出现「启动成功但回复全部失败」的假健康状态 | 飞书**可执行**（需真实 app id + 故意错 secret）；企业微信待凭证 |
| D3 | 重复消息只产生一次运行 | `npm run test:feishu` 去重用例 + 真实场景注入：同一 `event_id` 连发 2 次 | 断言 run 次数 = 1；JSONL 中第二条记 `channel.deduped` | 离线**可执行**；真实注入待凭证 |
| D4 | 重启后：调度定义与投递幂等不丢、不重发；进行中的 trigger 标 `interrupted` 而非重试 | `npm run scheduler:poc`（已存在）+ `npm run api:smoke` restart-consistency | Scenario B 形态：`status:"interrupted"` + `stats.interrupted=1` + 后续触发仍成功；`restart-consistency.consistent=true` | **可执行**（已实测 exit 0） |
| D5 | 投递失败有界重试并落稳定错误码，不无限重试 | `tests/agt-033-transport.test.mjs` + `scripts/agt-033/live-failure-probe.mjs`（**只打不可达 id**，不产生真实消息） | `attempts ≤ 3`、`code ∈ {transport_error, retry_exhausted, invalid_destination, report_missing, missing_message_id}`、`DELIVERY_STATUS=failed` | 离线**可执行**；真实探针需凭证 |
| D6 | `/stop`（企业微信侧的停止语义）真正取消模型调用，且不产生第二条结果消息 | 通道 T2 用例（t6）+ 真实窗口（可选） | `status:"cancelled"`；stop 后无 `agent.run` 的 completed 事件；stop 本身只回一次 | 待能力（t6） |
| D7 | 模型输入无法改变可信判定（提示注入） | 研究侧：`npm run test:targets` 的目标解析用例（目标只来自 schedule 配置）；通道侧：D1 负例 + 固定 system prompt 断言 | 模型输出/网页内容无法新增或改写 `deliveryTargets`；无法改变 `allowedChatIds` | 研究侧**可执行**；通道侧部分待能力 |
| D8 | 证据与日志本身不泄露 | 对 `poc/evidence/*.jsonl` 与进程日志做模式扫描（`sk-`、`Bearer`、`app_secret`、完整 `ou_`/`oc_`/`userid`） | 零命中；命中即失败 | **可执行**（可用 `grep`/`Select-String` 作为判定命令） |

## 7. 当前可立即执行的门禁（不依赖凭证）

在维护者提供企业微信配置之前，能用来防「飞书退化」的最小门禁：

```powershell
npm run test:feishu      # 48/48
npm run test:api         # 26/26
npm run test:scheduler   # 31/31
npm run test:targets     # 29/29
npm run api:smoke        # {"event":"result","ok":true,...}
npm run scheduler:poc    # POC evidence complete: ...
npm test                 # fail 集合必须 ⊆ 已知 2 项（基线 §4）
```

任一条不满足即判定为回归。命令、预期数字与 2026-11-04 基线一一对应（见基线文档 §3）。

## 8. 尚不可判定项汇总

| 场景 | 不可判定原因 | 解除条件 |
| --- | --- | --- |
| A1–A5 | 企业微信通道不存在 | t6（AGT-036）交付 + 维护者提供机器人凭证 |
| B2 | 无真实 Cloud Auth 令牌，无法接真实 Guanlan MCP | t8（GLN-013）签发 + t9（AGT-038）接入 |
| B4/B5 真实投递 | 企业微信投递 transport 不存在 | t7（AGT-037）组合根 |
| C4/D2/D3/D5 真实用例 | 飞书/企业微信凭证未注入本会话 | 维护者注入凭证（不写入仓库） |
| A5/B* 的 Trace 关联 | 代码中无 trace 实现 | t7 定稿 Trace 契约（当前无归属卡，需 lead 裁决） |
| T5 生产 smoke | 无 prod 环境与部署授权 | 另行授权 |
