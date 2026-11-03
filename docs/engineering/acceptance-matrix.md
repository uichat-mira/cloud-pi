# 验收矩阵（草案 v0）— Cloud Agent V1 真实企业微信闭环

- 状态：**草案**，随 AGT-031/036/037/038/GLN-013/014 推进修订
- 基线代码：`origin/dev` @ `8efc250`
- 基线证据：[docs/evidence/agt-03x-baseline.md](../evidence/agt-03x-baseline.md)（2026-11-04 实测）
- 组织口径：`uichat-mira/.github` `docs/engineering/testing-standard.md`（T1–T5 分层）

## 0. 执行闸门（2026-11-04 校准）

维护者尚未提供企业微信机器人凭证与管理员配置，且 `src/` 中没有任何企业微信代码（见基线 §2.3）。因此：

1. **凡依赖真实企业微信或真实模型的行，状态一律写作「凭证就绪后执行」**（等价于 `待凭证`）。凭证就绪前这些行**不得**记为通过、不得记为「不适用」、不得用 fixture 结果顶替，只能记为「未执行（阻塞：凭证）」。
2. 凭证就绪前唯一有效的门禁是 §7 的离线套件；它只能防「飞书退化」，**不能**证明企业微信闭环。
3. 凭证一旦到位，执行顺序固定为：A1→A3（单轮打通）→ D1/D2/D3（负例）→ B1–B7（定时 + 投递）→ A5（Trace 关联）。链路未打通之前不追 Trace，避免把「链路不通」误判成「Trace 缺失」。

### 0.1 前置清单（P1–P8，可勾选；缺一项即 blocker，不得记为通过）

本清单只回答「能不能开始跑」，**不证明任何判据通过**。执行前用
`node scripts/agt-03x/preflight.mjs --scenario <A|B|C|D>` 打勾；脚本只检查变量存在性，
不读取/打印值。任何一项未满足时，对应场景的判定必须是 `blocker`，不得降级为 pass 或「不适用」。

- [ ] **P1 企业微信机器人已创建（API 模式 + 长连接）**，`WECOM_BOT_ID`/`WECOM_SECRET` 已注入本地 `.env`（不入库）。
- [ ] **P2 非生产 Cloud Auth 实例可访问**：签发 URL + JWKS URL，且**禁止指向生产**（`CLOUD_AUTH_ENV` 必须是 dev/nonprod/staging；issuer 含 `prod` 直接判 unmet）。
- [ ] **P3 测试 Cloud Account 已存在，且已完成设备绑定登录**：`mcs_v1.*` 设备会话有效；过期需重新登录。这是**一次真实运维动作**，代码无法替代。
- [ ] **P4 Guanlan 隔离环境已部署**：Worker URL 可访问 + migrations 迁到 **0005**（含 `guanlan_registration_receipts` 收据表）+ `MIRA_GUANLAN_REGISTRATION_SECRET` 已设置（≥32 字符）。
- [ ] **P5 该账号在 Guanlan 有 consumer 行**（由 GLN-015 真实投递建立；仅显式 seed 时接受）+ ≥1 已批准源与新闻行。
  **若走 seed：证据里必须原样标注「seed 数据，非 A2 注册链能力」。**
- [ ] **P6 模型网关可用**：`CLOUD_PI_MODEL_BASE_URL`/`CLOUD_PI_MODEL_API_KEY`/`CLOUD_PI_MODEL_ID`。
- [ ] **P7 注册密钥两侧逐字节一致**：Cloud Auth 的 `MIRA_GUANLAN_REGISTRATION_SECRET` == GLN-015 接收端同名密钥，**无尾随换行/空白**（接收端对带空白值直接 `503 registration_not_configured`，把配置错误伪装成失败的排查代价很高）。本机无法在不泄漏密钥的前提下比对，因此只接受维护者人工声明 `AGTX_P7_SECRET_MATCH=byte-identical`。
- [ ] **P8 非生产 Cloud Auth 公网 JWKS 可达（仅公钥）**：`CLOUD_AUTH_PUBLIC_JWKS_URL` 为 **https**，Guanlan Worker 能取到并缓存 300s。本机 loopback 只适用于 `wrangler dev`，已部署 Worker 不可达 `127.0.0.1`。

场景依赖：A = P1,P3,P6；B = P1–P8；C = 无（另有 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 仅 C4 使用）；D = P1。

执行入口与证据骨架：`docs/evidence/wecom-v1/README.md`（A/B/C/D 脚本用法 + 四份空证据模板 + 白名单投影说明）。

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
| **Trace 关联** | 同一 `runId` 在 入口事件→run→trigger→delivery→Management API / run-store 之间逐级互查 | 证明「同一条请求的各阶段可串起来且可由 API 读回」；**当前 `src/` 中无任何 traceId/span 实现**（基线 §2.3），范围已由 lead 于 2026-11-04 收紧到「runId 贯穿 + 可读回关联」，见下行口径 |
| 测试输出 | `node --test` 汇总行（tests/pass/fail/duration_ms）+ 版本信息 | 证明离线回归（T1–T3）未退化 |

> Trace 判定口径（lead 2026-11-04 裁定，**不按理想 trace 系统要求**）：只要求同一 `runId` 能从 channel 入口→run→schedule trigger→delivery→Management API / run-store 读回并互相对应；**不引入** OTel、分布式 span、新可观测平台。具体字段名与落盘形态由 t7（AGT-037）定稿，本矩阵不预设实现。若 t7 最终选择在 JSONL 里额外记录 `channel.ingress` / `delivery.attempt` 等事件，判定仍以 `runId` 关联为准。

### 2.3 通用前置条件（所有真实场景判据共同要求）

| 前置 | 判定方式 | 当前状态 |
| --- | --- | --- |
| 企业微信机器人凭证与管理员配置（回调/长连接模式、接收消息权限、可见范围） | 进程启动日志出现 `wecom_channel_started` 且不含 secret | **待凭证（外部阻塞，需维护者提供）** |
| 真实模型凭证 | `npm run agent -- "ping"` exit 0 且输出含 `provider`/`model`/`duration` | 待凭证（本机主工作树有 `.env`，worktree 内无） |
| 真实 Cloud Auth 内部消费者凭证（Guanlan） | `npm run test:live` 中 MCP 用例通过 | 待能力（t8 GLN-013 / t9 AGT-038） |
| loopback 管理 API 可用 | `npm run api:smoke` → `{"event":"result","ok":true,...}` | **可执行（已实测 exit 0）** |

## 3. 场景 A：企业微信主动提问（单轮真实往返）

目标：真人/真机在企业微信里 @机器人 提问，机器人用真实模型回答，同一会话可读回。

> **凭证就绪后执行**：企业微信机器人当前既无凭证也无通道代码，A1–A5 全部记「未执行（阻塞：凭证）」，不得填「通过」或「不适用」。

| # | 判据 | 判定方式（命令 / 证据） | 证据要点 | 状态 |
| --- | --- | --- | --- | --- |
| A1 | 入站事件被接收并归一为可信字段（发送者、会话、消息 id、文本），且**未经模型**即完成路由判定 | 运行 `npm run wecom:live -- --expect reply`（**待新增**，t6 交付；类比现有 `npm run feishu:live`），检查 `poc/evidence/agt-036-live.jsonl` 中 `channel.ingress` 事件 | 事件数 ≥1；含 `runId`（t7 若另定 `traceId` 则同时要求）、脱敏发送者/会话、`messageId`（脱敏）、`at` | 凭证就绪后执行；待能力（t6） |
| A2 | 真实模型推理发生且 usage 来自 provider | 同一 JSONL 中 `agent.run` 事件 | `providerId`、`modelId`、`usage.input>0`、`usage.output>0`、`durationMs`、`status:"completed"` | 凭证就绪后执行；待能力（t6） |
| A3 | 回复真实回到企业微信，且被平台接受 | JSONL 中 `delivery.attempt`/`reply.sent` 事件 + 真人在客户端看到答案（截图归档为本地附件，不入库正文） | `status:"sent"`、`messageId`（脱敏）、`attempts:1` | 凭证就绪后执行；待能力（t6） |
| A4 | 单轮不越权：该轮 `allowedTools`/MCP 工具集合与策略一致 | 运行 `npm run test:feishu` 不应变绿/变红（回归），并检查 A1 事件里 `tools.exposed` 数组为空或仅为白名单 | `tools.exposed` 与 `docs/engineering/agt-036-*.md` 声明的白名单逐项相等 | 凭证就绪后执行；待能力（t6） |
| A5 | 同一请求的 A1→A2→A3 可由 `runId` 串起，并能从 Management API / run-store 读回同一 `runId` | 用 `runId` 过滤 JSONL 与 API：`GET /v1/runs/:runId`、`GET /v1/runs/:runId/delivery`，再读磁盘 `run.json` | 三处 `runId` 相等；事件时间单调递增；`run.status` 与投递状态自洽（若 t7 另记 `traceId`，则同一 `traceId` 亦须一致） | 凭证就绪后执行；待能力（t7：runId 贯穿 + API 读回） |

## 4. 场景 B：定时研究 + 主动投递

目标：Scheduler 按 cron 触发真实研究（真实模型 + 真实 Guanlan MCP），把结果主动投递到指定企业微信/飞书目标，并且可经 API 读回。

> **凭证就绪后执行**：凡依赖真实企业微信投递（B4/B5 的真实投递）或真实 Guanlan MCP 令牌（B2）的行，凭证/能力就绪前记「未执行（阻塞）」。离线可执行部分（B1 的 `scheduler:poc`、B3/B6/B7 的套件与 API 读回）照常在 §7 门禁里跑，但**不得**用于证明企业微信闭环。

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
| C3 | 全量 `npm test` 的失败集合不扩大 | `npm test` | 基线为 555 tests；Windows 上已知 2 项失败（`research-store.test.mjs:52`、`research-verify-adapter.test.mjs:162`，见基线 §4）。t7 首个 commit 修掉这 2 项前：**失败集合 ⊆ 已知 2 项**；t7 合并后本判据升级为 **Windows `npm test` fail 0**，且新增用例必须 pass | **可执行**（判据随 t7 首个 commit 升级） |
| C4 | 飞书真实往返仍可用（私聊 + 授权群 @） | `npm run feishu:live -- --expect reply`（真实凭证 + 真人发消息） | `poc/evidence/agt-029-live-p2p.jsonl` 形态的事件：`status:"sent"`、真实 `runId`、`usage` 非零 | **待凭证** |
| C5 | 飞书侧安全语义未被新通道改动 | `npm run test:feishu`（policy/dedupe 用例）+ 代码审阅 `src/channels/feishu/policy.mjs` 未被企业微信改动波及 | 未授权群/未 @/bot open_id 未验证 三类负例仍 fail closed | **可执行** |
| C6 | 飞书与企业微信共享同一 Agent 执行入口（不出现第二套 runtime） | 代码检查：企业微信 runner 必须调用 `src/runtime.mjs:createAgentRuntime().run()` 或 `src/research/runtime/agt-027.mjs` 的既有 port | 无新增 provider/session 装配实现。基线事实：`createAgentSession` 在 `src/` 中只出现在 `src/runtime.mjs`（import + 调用），`src/research/port.mjs` 仅注释提及 —— 接入后该集合不得扩大 | 待能力（t6 交付时审） |

## 6. 场景 D：故障与安全（未授权、无效凭证、重复消息、重启、投递失败）

> **凭证就绪后执行**：飞书侧负例与纯离线用例现在就能跑；标注为「企业微信」的负例（D1/D2/D3/D6 的企业微信部分）与需要真实注入的用例，凭证就绪前记「未执行（阻塞：凭证）」。

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
| A1–A5 | 企业微信通道不存在（`src/` 零代码，基线 §2.3） | **凭证就绪后执行**：t6（AGT-036）交付 + 维护者提供机器人凭证 |
| B2 | 无真实 Cloud Auth 令牌，无法接真实 Guanlan MCP | t8（GLN-013）签发 + t9（AGT-038）接入 |
| B4/B5 真实投递 | 企业微信投递 transport 不存在 | t7（AGT-037）组合根 |
| C4/D2/D3/D5 真实用例 | 飞书/企业微信凭证未注入本会话 | 维护者注入凭证（不写入仓库）→ **凭证就绪后执行** |
| A5 / B* 的 Trace 关联 | `src/` 中无 traceId/span 实现 | 已并入 t7（AGT-037），范围收紧为「runId 贯穿 + Management API/run-store 可读回」，不引入 OTel/span |
| T5 生产 smoke | 无 prod 环境与部署授权 | 另行授权 |

> 本表所有「无 X」结论都来自基线 §2.3 的代码检索，不是推测；凭证/能力到位后应逐行重测并把「未执行」替换为真实命令输出，而不是直接改成「通过」。
