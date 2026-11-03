# Cloud Agent V1 独立验证矩阵（t11）

> 关联 Issue：[#24 AGT-037 统一运行入口](https://github.com/uichat-mira/cloud-pi/issues/24)（主）、
> [#22 AGT-036 企业微信 Channel](https://github.com/uichat-mira/cloud-pi/issues/22)、
> [#13 AGT-031 平台研究](https://github.com/uichat-mira/cloud-pi/issues/13)、
> [#25 AGT-038 真实 Guanlan MCP](https://github.com/uichat-mira/cloud-pi/issues/25)（PR #30，未合并）。
> 撰写：verifier（2026-11-04）。基线：cloud-pi `dev@ade8a36`、cloud-auth `dev@dbac1c0`、cloud-mcp-guanlan `dev@e3aefe0`。
> 本文件**只做验证与判定**，不改实现；所有"未验证"项都单列，不用 CI 绿灯替代真实验收。

## 0. 一句话结论

企业微信「单聊收发 / 群 @ 入站与回复 / 主动推送」、真实模型推理、真实 Guanlan 读写、Cloud Auth 签发闸门、
统一入口 + runId 读回，**都已有 L3 真实执行证据**；但**没有任何一条链路是"部署态 + 多实例 + 全天候"**：
全部 L3 都是单实例本机进程或单次真实会话，且定时投递到企业微信（t25）、群内两段式回复（t27）仍未接线。
**进入真实企业微信长期运行前的唯一外部阻塞仍是企微管理员配置与机器人凭证的正式提供**（见 §4 G0）。
另有两条**工具侧**待修（不影响上面各条 L3 结论）：G12（D8 脱敏扫描 1 个假阳性命中）、G13（判定器基线漂移）。

## 1. 分层口径（先看这里，后文所有判定按此解释）

| 层 | 定义 | 能证明 | **不能**证明 |
| --- | --- | --- | --- |
| **L1 设计/契约** | 文档、ADR、schema、Issue 验收条款 | 设计意图与边界自洽 | 任何运行时行为 |
| **L2 本地 fixture/workerd** | 本地进程、workerd、D1 local/合成数据、单测 | 代码路径正确、负例拒绝、幂等与恢复语义 | 真实平台行为、真实凭证、真实数据 |
| **L3 真实服务/真实部署** | 真实企微长连接 / 真实 Cloud Auth 签发 / 真实公网 Worker + 真实 D1 / 真实模型 | 在该次执行范围内产品可用 | 未执行的部分（逐条见 §4） |

**L3 必须带"环境"限定**（否则读者会把"本机跑通"读成"已上线"）：

| 环境取值 | 含义 |
| --- | --- |
| `真实平台` | 对端是真实企业微信 / 真实模型服务 / 真实 Cloudflare 资源 |
| `本机进程` | 真进程、真 HTTP、真 run store，但**未部署**、只有一份实例 |
| `部署` | 资源在云端持续存在（本矩阵里只有 Guanlan 隔离环境与 Cloud Auth 的静态 JWKS） |

**三条硬规则**（写本文时逐条自查过）：

1. **证据落点必须是实际产物**（文档行号、JSONL 行、run 记录、CI/检查页），只有"命令 + 口头结果"的行一律降为 L2；
2. **一条行里混层要拆开写**（例：第 3 项"通道 L3 / 接线 L2"），不许整行标 L3；
3. **L3 的行必须在 §4 缺口表里有对应项或明确写"无缺口"**，反向也要查（§7 交叉核对）。

## 2. 结论 → 证据 → 复现命令

| # | 覆盖项 | 结论 | 层 | 环境 | 证据落点（实际产物） | 复现命令 + 前置 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 企微单聊收发 | ✅ 实测通过 | L3 + L2 | 真实平台 | `docs/research/wecom-channel/live-smoke-evidence.md:48-56`（订阅 errcode 0 ×2）、`:60-71`（两帧入站）、`:94-101`（回复 errcode 0，467 ms）；实现侧真实回合 `docs/engineering/agt-037-unified-runtime.md:65-76` | `npm run wecom:wait-inbound`（前置：`WECOM_BOT_ID/SECRET`，或 `~/.mira-secrets/wecom.env`；维护者手机发一条单聊） |
| 2 | 企微群 @ | ✅ 入站/回复实测；⚠️ @ 判定只有 L2 | L3 入站 + L2 实现 | 真实平台 | `docs/research/wecom-channel/group-and-proactive-evidence.md:26-46`（`chattype=group`、`chatid` len=32、无 mention 字段）、`:52-58`（群回复 483 ms errcode 0）；剥离/路由实现 `tests/agt-036-*.test.mjs`（71 条） | 同上命令 + 测试群内 `@Mira 内容` |
| 3 | 主动推送 | ✅ 通道 4 组对照实测；❌ 定时投递未接线（t25） | L3 通道 + L2 接线 | 真实平台 | `group-and-proactive-evidence.md:62-69`（群/单聊 × 带/不带 `chat_type` 全部 errcode 0）、`:83-85`（伪造 chatid → `93006`）；未接线证据 `docs/engineering/agt-036-wecom-channel.md:228-231`、`agt-037-unified-runtime.md:97` | 通道侧**无入库脚本**（t26 用临时脚本，G9）：仅能 `npm run wecom:wait-inbound` 建立真实连接后由脚本主动发；接线侧无命令可跑（功能不存在，t25） |
| 4 | 模型推理 | ✅ 真实 provider 真实模型 | L3 | 真实平台 | `docs/engineering/agt-027-live-evidence.md:16-18`（provider `mira-ai`、模型 `deepseek-v4.1-flash-od`）、`:35`（6 个 runId）；经企微的真实回合 `agt-037-unified-runtime.md:65-76`（usage 200/6/718） | 前置：本机 `.env` 注入 provider/key/model；`npm run agent -- "用一句话总结欢迎页"` |
| 5 | Guanlan 真实令牌读写 | ✅ 读 + CAS 写 + 重读 + 负例 | L3 | 部署（真实 Worker + 真实 D1）+ 本机现签 | guanlan `docs/engineering/gln-014-real-token-acceptance.md:40-50`（whoami/CAS/幂等/版本冲突/读回）、`:62-65`（真实 D1 不变量）、`:80`（过期 401）、`:82`（跨账户隔离） | 文档 `:155-166` 的脚本序列（前置：Cloud Auth 现签令牌 + `HTTPS_PROXY`） |
| 6 | Cloud Auth 签发闸门 | ✅ 真实 `pending→delivered→签发` | L3 | 本机进程 + 真实投递 | cloud-auth `docs/engineering/gln-013-nonprod-runbook.md:16-18`（loopback `127.0.0.1:8788`、真实投递 attempts=2）、`:65-87`（`delivered 0/1/1 → 1/0/0`） | 文档 §2–§5 的命令序列（前置：非生产实例 + Guanlan 接收端 URL + 管理员令牌） |
| 7 | 管理 API run 读回 | ✅ 本机真实进程读回 | L3 | **本机进程 / 未部署** | 本次复跑：`entry-smoke` 输出 `chatRun.runId=r-20261103T191512-8761a9 … sameRunId:true, httpStatus:200`（附录 B.3）；路由契约 `docs/engineering/agt-034-local-management-api.md:26`、`:115-118` | `npm run api:smoke`、`node scripts/agt-037/entry-smoke.mjs` |
| 8 | Trace（runId 贯穿） | ✅ 通道 → run store → API 同一 id | L3 | **本机进程 / 未部署** | `agt-037-unified-runtime.md:65-76`（真实企微单聊 `r-20261103T182348-e476ad` → `GET /v1/runs/<id>` 200，含 chat 投影）；本次复跑同附录 B.3 | 同 7；真实企微侧需第 1 项凭证 |
| 9 | 证据脱敏 | ⚠️ 机器扫描**有 1 命中**（经核为散文占位词，非真实 id） | **L2** | 本机扫描 | `docs/evidence/wecom-v1/README.md:110-125`（§7 两层校验 + D8 范围）、`:126-154`（§8 脱敏台账）；本次复跑 D8 `files=64 hits=1`（附录 B.4），命中点 `docs/research/wecom-channel/t6-answers.md:81-82` | `node scripts/agt-03x/d-failure-modes.mjs`（无需凭证） |

> **与 captain 口径的一处差异（按"拿不准往低标"处理）**：第 6 项 captain 建议标 `真实平台`；但 Cloud Auth 实例跑在
> `127.0.0.1:8788`（**本机进程**），只有投递对端是真实部署，所以我标 `本机进程 + 真实投递`。若按"对端真实即算真实平台"
> 的标准，可升为 `真实平台` —— 升级理由写在行内，不需要改判定。

> 第 9 项**故意保持 L2**：机器扫描只能证明"`docs/**` + `poc/**` 的文本里没有命中已知 id 形态"，
> **0 命中 ≠ 全仓无泄漏**（二进制/未扫描目录/历史 commit 都不在范围内；`tests/` 因合成夹具被显式排除）。

## 3. 逐项展开（结论 / 证据 / 复现 / 边界）

### 3.1 企微单聊收发（L3 真实平台）

- **结论**：真实凭证下 `aibot_subscribe` 返回 `errcode 0`（两次均 <350 ms），真实单聊入站可收，回复被平台接受
  （`errcode 0 / 467 ms`）。实现侧（统一入口 + 通道 + 真实模型）跑出真实回合。
- **证据**：`live-smoke-evidence.md:48-56`、`:60-71`、`:94-101`；实现真回合 `agt-037-unified-runtime.md:65-76`。
- **复现**：`npm run wecom:wait-inbound`；前置 = `WECOM_BOT_ID`/`WECOM_BOT_SECRET`（本地文件注入，不入库），
  维护者用手机给机器人发一条单聊；成功标志 = 终端出现 `wecom_channel_outcome action=replied`
  + 手机收到回复。
- **边界**：只验证了单实例、单会话、短文本；首条失败（`846605 invalid req_id`）的记录保留在 `:83-92`，不隐藏。

### 3.2 群 @（L3 入站 + L2 实现）

- **结论**：群里 `@Mira` 的消息真实到达（`chattype=group`、`chatid` 32 位），群内回复被接受（483 ms）；
  但**平台不提供结构化 mention**，"是否被 @"只能靠正文前缀 —— 实现层的剥离与路由只有 L2 单测覆盖。
- **证据**：`group-and-proactive-evidence.md:26-46`、`:52-58`；实现 `tests/agt-036-events.test.mjs` 等（`npm run test:wecom` 71/71）。
- **复现**：同 3.1，在群里 @ 机器人；成功后 `chattype=group` 且回复进入群。
- **边界**：@ 判定是产品约束而非缺陷，见 §5.3；改名/群昵称/`@所有人` 未验证。

### 3.3 主动推送（L3 通道 + L2 接线）

- **结论**：`aibot_send_msg` 对群（`chatid`）与单聊（`userid`）在带/不带 `chat_type` 的 4 组对照中全部 `errcode 0`；
  伪造 `chatid` 被 `93006` 即时拒绝；**但调度投递执行器目前只发飞书**，WeCom 目标会被显式拒绝而不是误投。
- **证据**：`group-and-proactive-evidence.md:62-69`、`:83-85`；未接线 `agt-036-wecom-channel.md:228-231` + `agt-037-unified-runtime.md:97`。
- **复现**：通道侧**没有入库脚本**（t26 的脚本在 `%TEMP%`，见 G9），当前只能用 `npm run wecom:wait-inbound`
  建立真实连接后由临时脚本发；**接线侧没有可复现命令，因为功能不存在**（t25 进行中，附录 A）。
- **边界**：「必须先有会话」是平台约束（§5.2）；冷启动投递不可用。

### 3.4 模型推理（L3 真实平台）

- **结论**：`mira-ai` provider + `deepseek-v4.1-flash-od` 的真实调用成功，token 数为 provider 真实返回值（cost 未给出，不估算）；
  经企微单聊的真实回合也带真实 usage。
- **证据**：`agt-027-live-evidence.md:16-18`、`:35`、`:56`；`agt-037-unified-runtime.md:65-76`。
- **复现**：`.env` 注入 provider/key/model 后 `npm run agent -- --prompt "…"`；或直接 3.1。
- **边界**：L3 只覆盖单轮/短会话；上下文长度、并发、成本未评估。

### 3.5 Guanlan 真实令牌读写（L3 部署 + 本机现签）

- **结论**：真实 Cloud Auth 现签令牌（`scopes:["guanlan.read"]`）在真实 Worker + 真实 D1 上完成
  `initialize → tools/list（3 工具）→ whoami → news_recent（读前）→ news_decide（CAS，adopted@1）→ 同 operationId 重放（replayed）
  → 过期版本（版本冲突，不覆盖）→ news_recent（读后 adopted@1）→ 再判（ignored@2）`。
- **证据**：`gln-014-real-token-acceptance.md:40-50`、`:62-65`、`:80`、`:82`。
- **复现**：文档 `:155-166` 的脚本序列；前置 = 非生产 Cloud Auth 现签令牌（300 s TTL）+ 本机 `HTTPS_PROXY`。
- **边界**：内容是合成夹具（`poc_sources` 1 行）；**写工具只在合成账本上验过**，真实新闻账本未验（§4 G6）。

### 3.6 Cloud Auth 签发闸门（L3 本机 + 真实投递）

- **结论**：非生产 Cloud Auth 在 `127.0.0.1:8788` 起真实实例；真实 HMAC 投递到隔离 Guanlan 接收端后
  `pending → delivered`（第 1 次因未走代理 8 s 超时，`attempts=2`），随后 Guanlan 令牌签发 200；
  未投递账号被闸门拒绝（409 `SERVICE_CREDENTIAL_PRINCIPAL_NOT_READY`）。
- **证据**：`gln-013-nonprod-runbook.md:16-18`、`:65-87`。
- **复现**：runbook §2–§5（login → device → schedule → outbox → delivered → 签发）。
- **边界**：loopback + 本机进程；多实例、密钥轮换常态化未验。

### 3.7 管理 API run 读回（L3 本机进程，未部署）

- **结论**：真实进程 + 真实 run store + 真实 HTTP，run 详情读回 200，聊天 run 与 run 研究共用 `/v1/runs/:id`。
- **证据**：本次复跑附录 B.3（`sameRunId:true`、`httpStatus:200`）；契约 `agt-034-local-management-api.md:26`、`:115-118`。
- **复现**：`npm run api:smoke`（18 个请求、`drained:true`）、`node scripts/agt-037/entry-smoke.mjs`。
- **边界**：`127.0.0.1`/`::1` only；无鉴权（本机信任模型）；未部署。

### 3.8 Trace（runId 贯穿）

- **结论**：同一个 `runId` 可从通道结果行 → run store → 管理 API 读出，研究 run 与聊天 run 同一路由。
- **证据**：`agt-037-unified-runtime.md:65-76`；本次复跑附录 B.3。
- **复现**：同 3.7；真实企微侧还可 3.1 的 `runId` 直接 `curl /v1/runs/<runId>`。
- **边界**：没有 OTel/span；只保证 id 贯通，不保证跨进程因果图。

### 3.9 证据脱敏（L2，**本轮发现 1 个待修问题**）

- **结论**：验收执行包对证据写入做两层校验（键白名单 + 值形态扫描）；但 D8 在今天合并 PR #23 之后
  **不再通过**：`files=64 hits=1`，命中 `docs/research/wecom-channel/t6-answers.md:81-82`。
- **命中分析**：两行是**文档散文里的占位写法**——`chatid ← userid` 与 `chatid ← chatid`
  （原文用等号把占位词和字段名连起来；本文件为避免自己也触发同一条规则，引用时写作 `←`）。
  `wecom_chat_id` 规则（`/\b(?:chatid|chat_id)=(?![A-Za-z0-9_-]*(?:…|\.\.\.))[A-Za-z0-9_-]{4,}/i`）
  把 `userid`/`chatid` 这两个**占位词本身**当成了 id 值。**不是真实 id 泄漏**（已逐字核对：文件中没有 32 位 `chatid`、
  没有明文 `userid`），但**扫描结果不能当作"0 命中"上报**。
- **证据**：附录 B.4 原文、`docs/evidence/wecom-v1/README.md:110-125`（§7）、`:126-154`（§8 台账）。
- **复现**：`node scripts/agt-03x/d-failure-modes.mjs`（在 `dev@ade8a36` 上 exit 3）。
- **建议修法（二选一，交维护者/作者定）**：
  1. **改文档措辞**（推荐，零风险）：把 `chatid` 与占位词之间的等号改成箭头（`chatid ← userid`、`chatid ← chatid`）
     （不触发规则、可读性更好）；或
  2. **改规则**：给 `wecom_chat_id` 的正则加占位词白名单（`(?!(?:userid|chatid|open_userid)\b)`），
     但这会稍微放宽真实 id 检测，须同时补一个"真实 32 位 id 仍被抓"的回归用例。
- **边界**：机器扫描只覆盖 `docs/**` + `poc/**` 的文本；**0 命中 ≠ 全仓无泄漏**（`tests/` 合成夹具、二进制、
  历史 commit 都不在范围内）。
- **连带影响**：`node scripts/agt-03x/self-test.mjs --full` 因此从 11/11 退化到 **8/11**
  （`D/offline`、`D/wecom-absent` 因 D8 fail 而 exit 1；`C/full` 因基线漂移而 exit 1，见 G13）。
  验收执行包**当前不能在 dev 上整体通过**，这是矩阵里唯一"工具自身不绿"的项。

## 4. 缺口表（每条：为什么没验 / 要验需要什么）

| ID | 缺口 | 为什么没验 | 要验需要什么 |
| --- | --- | --- | --- |
| **G0** | **真实企业微信长期运行（t12）** | 维护者尚未提供正式管理员配置与机器人凭证文件；现有凭证为临时注入、单次使用 | 维护者提供 `WECOM_BOT_ID`/`WECOM_BOT_SECRET` + 测试群 `chatid` + 机器人显示名；这是**唯一外部阻塞项** |
| G1 | 定时投递到企业微信目标（t25） | 投递执行器当前只发飞书，WeCom 目标被显式拒绝（设计如此，不是 bug） | t25 接线完成后：真实 schedule → 到点 → 群里收到主动推送 |
| G2 | 群内两段式回复（t27：ack + `aibot_send_msg` 终稿） | 未实现；`req_id` 有时限，长任务不能只靠流式 | t27 完成后：群内 @ → 立即 ack → 模型跑完推终稿 |
| G3 | Windows 系统级 SIGTERM 优雅排空 | Windows 无法向 Node 投递可处理的 SIGTERM（`taskkill` 硬终止）；进程内 `stop()` 已验（`drained:true`） | Linux/macOS/容器内跑 `entry-smoke` / `live-drain` 的真实信号测试 |
| G4 | 24 h 回复窗口真实边界 | 需要等过一个真实窗口，成本高且不可控 | 记录一条入站时间，>24 h 后尝试回复并记录错误码 |
| G5 | 限速错误码（30/分、1000/时） | 有意未打满，避免触发封禁 | 维护者书面同意后，在测试群刻意打满并记录错误码 |
| G6 | 写工具在**真实新闻账本**上验收 | 维护者未批准真实新闻源，`poc_sources/poc_news` 为合成夹具 | 批准源清单 + 真实采集一轮后重跑 3.5 |
| G7 | 静态 JWKS 是测试期措施 | `mira-auth-jwks-test.pages.dev` 是 Pages 静态托管，不是授权服务器 | 生产 Cloud Auth 的 JWKS 端点；轮换流程需同步更新 |
| G8 | Guanlan 负例 N9/N10/N11（无空间 / 禁用账户 / 第二身份令牌） | 实例无禁用 API，且只有一个真实 `delivered` 身份；`consumer_id ≡ sub` 结构上不可构造 | 多身份 + 管理 API；或维护者提供第二个真实账号 |
| G9 | 复现脚本未入库 | 3.5 的验收脚本放在 `%TEMP%` 临时目录（文档 `:155-166` 仅记录命令） | 把 `mcp-acceptance.mjs` 等纳入仓库（需先脱敏），否则他人只能照文档重写 |
| G10 | 多实例 / 水平扩容 | 企微单连接约束 + 单实例锁，双活会互踢 | 主备切换流程验证（§5.1） |
| G11 | 企微群 @ 改名的判定 | 机器人改名后 `@` 前缀会变，未测 | 改名后重跑 3.2，确认剥离规则是否需放宽 |
| **G12** | **D8 脱敏门禁在 dev 上不再通过**（`files=64 hits=1`） | 合并后的 `t6-answers.md:81-82` 用散文把占位词写成 `chatid ← userid` / `chatid ← chatid`，规则把占位词当 id 值；**非真实泄漏**（已逐字核对） | 二选一（§3.9）：改文档措辞（推荐）或给规则加占位词白名单并补回归用例；修好后 D8 才能重新作为合并门禁 |
| **G13** | **验收判定器基线漂移**：`judge` 仍假定 `tests≥555 且 fail===2`，dev 实际 **642/0** | 那两个 Windows 已知失败已被 PR #27/#29 修掉，基线与 `self-test` 的 3 个用例没同步更新 | 由 harness 作者把基线改成"当前全绿"形态（或把已知失败清单置空），同时更新 `self-test` 的期望；这是**工具维护缺口**，不是产品缺陷 |
| **G14 / X4 前提** | **「超管创建的机器人只服务受控会话」目前靠配置纪律，不靠代码** | `src/channels/wecom/policy.mjs:46-58`：`allowedUserIds`/`allowedChatIds` 为空时**不拒绝**；配合单租户委托令牌，任何能给机器人发消息的人都会触发一次"用维护者身份"的 Guanlan 读取 | t29 完成后改为"启用外部工具时 allowlist 必须显式配置，否则启动失败"；届时把本行改成 `已强制` 并附测试名 |
| **G15** | **验收执行包偶发失败（已观测、未定位）** | 2026-11-04 03:33 复跑 `self-test --full` 时 `C2-api` 出现 1 次失败（`T1 create returns 201 with Location…`，26 条中 1 失败）；随后同一命令**连续 8 次全过**（`test:api` 5/5、`c-feishu-regression --full` 3/3） | 用 `--test-concurrency=1` 或端口/临时目录隔离实验定位；**不得加重试掩盖**（重试会把偶发真失败一起吞掉） |
| **G16** | **工具不可用时的投递纪律未强制**（§5.5） | 真实 401 后模型输出 `<||DSML|| invoke bash>` 伪工具文本，run 记录仍 `succeeded`，通道会把原文发给用户；已派 pi-dev | t27 + PR #30 修复落实四条（不投原文 / 一句人话 / 记录失败 / 失败态可查）；验收时用 forged 负例复检 |

## 5. 平台约束（产品边界，不是实现缺陷）

### 5.1 明文 `userid` 依赖"超管创建机器人"

- 实测：单聊/群聊入站 `from.userid` 都是**明文**，`from_is_open_userid=false`
  （`live-smoke-evidence.md:76-77`、`group-and-proactive-evidence.md:36-37`）。
- 原因：机器人由企业**超级管理员**创建；若改由普通管理员创建，同一字段会变成 `open_userid`（加密且企业外不可解析）。
- 产品含义：① V1 的身份映射**不能假设永远能拿到明文 userid**；② ADR-002 的 X4 前提需要随创建方式一起记录；
  ③ 换创建方式等于换身份源，属于**产品决策**，不是代码调整。
- 现状：`WECOM_ALLOWED_USER_IDS` 是通道侧白名单，**不是** Cloud Auth 授权（`agt-036-wecom-channel.md:42`）。

### 5.2 单连接 ⇒ 不可水平扩容

- 实测/文档：新连接会踢掉旧连接（`disconnected_event`），SDK 不自动重连；同一机器人只能一条长连接。
- 实现对策：`instance.lock` 单实例锁，第二个进程**启动失败**而不是把第一个踢掉（`agt-037-unified-runtime.md:48`）。
- 产品含义：**不能靠加副本扩容**；吞吐上限取决于单进程 + 平台限速（30 条/分/会话）。
  发布顺序必须是"停旧 → 起新"，期间不可用。

### 5.3 群 `@` 只是正文前缀

- 实测：群消息 `body` 无 `mention`/`mentions` 字段，只有正文以 `@Mira` 开头（`group-and-proactive-evidence.md:34-39`）。
- 实现对策：只剥离开头的 `@<WECOM_BOT_NAME>`，中间出现的 `@` 视为普通文本；剥离后为空则不调模型。
- 产品含义：**机器人改名/群昵称/`@所有人` 都会影响判定**；这是平台不提供结构化 mention 的必然代价，
  需要在运营手册里写清"改名要同步配置"。

### 5.4 会话授权 ≠ 数据授权（V1 合规边界，**尚未代码强制**）

- **代码事实**（本轮逐行核对）：`src/channels/wecom/policy.mjs:46-58`，`allowedUserIds`（单聊）与
  `allowedChatIds`（群聊）**为空时不做任何拒绝**——即"没配白名单 = 放行所有能给机器人发消息的人"。
- **叠加风险**：Guanlan 读取用的是维护者**单一委托 consumer 令牌**（单租户）。两者叠加的后果是：
  **任何能给机器人发消息的人，都能触发一次"用维护者身份"的 Guanlan 读取，并在会话里拿到内容**。
- **冲突**：组织 AGENTS 硬边界第 3 条——「一个群被授权聊天，不代表群成员获得 owner 的私有数据」。
  allowlist 只决定"**谁能触发**"，不决定"**能读什么**"；V1 的"能读什么"完全由那一个委托令牌决定。
- **处置**：已派 t29（「启用外部工具时 allowlist 必须显式配置，否则启动失败」）。
  **在 t29 完成前，这条边界只靠配置纪律，不算已解决**；矩阵不会把它写成"已修复"。
- 缺口表对应行：G14 / X4 前提。

### 5.5 工具/数据源不可用时，不得把模型原文投递给用户（跨场景通用规则）

- **规则**（对 A/B/C/D 全部场景生效，不只企微）：一次运行若依赖的工具或数据源不可用、或本次**零工具连接成功**，则
  1. **不得**把模型输出作为答复投递——尤其是 `<||DSML|| invoke …>` 这类伪工具标记文本；
  2. 必须用**一句人话**说明"研究能力暂不可用"，并给出可操作下一步（何时重试 / 找谁）；
  3. run 记录必须记为**失败**（不是 `succeeded`），带 `error.code`（如 `mcp_server_unavailable`）；
  4. 投递记录必须能查到该失败态：不静默重试、不死循环。
- **实测依据（L3，2026-11-04 04:15 前后）**：cloud-pi PR #30 `--mode=forged` 打真实端点得到真实 **401** 后，
  模型输出 `<||DSML|| invoke name="bash">ls -a; …` 的伪工具文本；运行被规则判 `mcp_server_unavailable`，
  但 ① `run.status` 仍是 `succeeded`（该 PR 的 F-30-2），② 这段文本在企微通道里会**原样发给用户**。
- **为什么是产品边界而不是实现细节**：工具不可用是**常态**（令牌 300 s 过期、JWKS 轮换、限速、断网）。
  用户看到的第一句话决定他是否信任这个机器人；把模型原文投出去等于把"内部失败"变成"对外事故"。
- **状态：未强制**。归属 pi-dev（t27 两段式回复 + PR #30 修复）。缺口表 G16。

### 5.6 体验维度不在本矩阵判定范围内

- 本矩阵只判两件事：**功能是否成立**、**证据属于哪一层**（L1/L2/L3 + 环境限定）。语气、文案、回复长度、
  交互节奏、错误话术是否"像人说的"——**一律不判**。
- 产品体验标准另立：`docs/product/wecom-experience-rubric.md`（t30 / PR #34，**尚未合并**；
  合并后才成为权威。合并前不得当作已生效标准，也不得拿来当验收依据）。
- 两个方向都写死：① 矩阵里的 "✅" 永远不等于"用户会觉得好用"；
  ② 体验评审也不能替代 L3 证据——文笔再好，没有真实平台证据就是没验。
- 为什么需要这条：t12 的 A 场景会同时产出"功能通过"和"体验很差"（例如工具不可用时只回一句人话）。
  两张表混用，"通过"就变成一句没有信息量的话。

## 6. 跨仓库判定汇总

| 仓库 | 基线 | 门禁结果（本次复跑） | 判定 |
| --- | --- | --- | --- |
| cloud-pi | `dev@ade8a36`（含 PR #27/#28/#29/#23） | `npm test` **642/642 pass**（80 suites，27.9 s）；`test:wecom` 71、`test:app` 16、`test:api` 26、`test:targets` 29、`test:scheduler` 31、`test:p0` 12 全 pass；`api:smoke` 18 请求 ok；`entry-smoke` ok；`wecom:check` 无凭证 → **exit 2**（fail-closed）；**`d-failure-modes` D8 → exit 3，1 命中**（G12，假阳性）；**`self-test --full` → 8/11，exit 1**（G12+G13） | 代码与契约一致，**不构成部署验收**；D8 门禁需先修 G12 才能重新作为合并门槛 |
| cloud-auth | `dev@dbac1c0`（PR #134 已合并） | `pnpm run check` → api **204/204**、web **136/136**，exit 0 | 与 t8 的 201/136 一致（+3 为新用例），通过 |
| cloud-mcp-guanlan | `dev@e3aefe0`（PR #27 已合并） | `npm run check` exit 0（含真实调度三模式 profiler 用例）；`bash scripts/check.sh` 本机不可执行（WSL 25 s 无响应，Ubuntu CI 为权威） | 通过（Windows 限制见 G3 同类问题） |
| cloud-pi PR #30（AGT-038 真实 Guanlan MCP） | 未合并 | 本轮**未验** | **待评审**（真实工具调用 / 令牌不进模型 / fail-closed 三条为重点） |

## 7. 纪律自查

1. **未合并、未部署、未关 Issue、未改 `dev`**：本文件只新增文档；三个仓库的门禁都是只读运行。
2. **无凭证/无原始 id**：文中出现的都是脱敏投影（`id:`/前缀）与公开端点；凭证只在维护者侧文件。
3. **未用 fixture 冒充真实链路**：第 1/2/3/4/5/6 项的证据分别来自真实企微、真实模型、真实 Worker+D1；
   合成数据（`t10-fixture-source`）都**显式标注**。
4. **CI 绿灯 ≠ 产品验收**：§6 的门禁结果只说明代码契约，不代表部署可用；判定见 §0 与 §4。
5. **L3 ↔ 缺口表交叉核对**（本轮结果）：
   - 第 1、2、4、6 项标 L3 → 缺口表对应 G0（长期运行/凭证正式化）、G3（信号）、G11（改名），**对得上**；
   - 第 3 项拆为"通道 L3 + 接线 L2" → G1 对应接线部分，**对得上**；
   - 第 5 项标 L3（部署） → G6/G8，**对得上**；
   - 第 7、8 项标 L3（本机进程/未部署） → G0 + "未部署"已写进环境列，**对得上**；
   - 第 9 项标 L2 → 不适用 L3 规则；但其**判定已下调**（从"0 命中"改为"1 命中 + 假阳性"），见 G12。
   **结论：没有"标了 L3 但缺口表里对不上"的行。**
6. **本次自查中新发现的问题**：G12（D8 在 dev 上 fail，1 个假阳性）、G13（判定器基线 555/2 与 dev 642/0 漂移）、
   G14（allowlist 为空即放行的合规缺口，已派 t29）。它们都不是本文档引起的：G12 来自合并后的
   `t6-answers.md` 与扫描规则冲突，G13 来自 Windows 已知失败被修掉后基线未更新，G14 是既有实现事实。
   我按"宁多勿少"全部记进缺口表，**没有**为了让矩阵好看而改规则、改他人文档或改动实现。
7. **自限声明**：本矩阵只覆盖列出的 9 项；未列出的能力（媒体、卡片、群成员、`response_url` 回复通道）既未验证也未宣称。

## 附录 A：待补行（t25 / t27 完成后必须更新）

> 规则：t25/t27 完成时**只能追加**本表行并在 PR 里追加 commit，**不得修改既有判定**；若与新证据冲突，另开一条 finding。

| 预留行 | 触发条件 | 完成时要补的字段 |
| --- | --- | --- |
| A-1 定时投递到企业微信 | t25 接线完成 + 真实 schedule 触发一次 | 结论 / 层（预计 L3 真实平台）/ 环境 / 证据落点（真实群消息或 `run.json` + delivery 记录）/ 复现命令 / 未验证边界 |
| A-2 群内两段式回复（ack + 终稿） | t27 完成 + 群里长任务跑一次 | 同上 + ack 延迟、终稿延迟、`req_id` 失效后兜底路径 |
| A-3 cloud-pi PR #30（AGT-038）评审 | PR #30 转 ready 或合并后 | 三条重点：真实工具调用、令牌不进模型、fail-closed；每条给 L3 证据或标缺口 |
| A-4 t12 真实端到端验收重派 | **四个条件同时满足**才可派单：a) t25 投递接线已验证；b) t27 两段式已验证；c) 维护者在线；d) 令牌注入步骤写死（现签命令 + TTL + 轮换点） | 场景 A/B/C/D 各自：结论 / 层（预计 L3）/ 环境 / 证据落点 / 复现命令 / 未验证边界；外加 G16 复检（工具不可用时用户侧只收到一句人话、run 记录为失败）。**任一条件缺失即记 blocker，不得用 fixture 顶替** |

## 附录 B：本次复跑的命令与原始输出摘录

> 机器：Windows Server，Node v24.9.0；时间 2026-11-04 03:14–03:20（UTC+8）。以下输出为原文摘录，未改写。

**B.1 cloud-pi 全量**

```text
$ npm test            # dev@ade8a36
ℹ tests 642
ℹ suites 80
ℹ pass 642
ℹ fail 0
ℹ duration_ms 27850.6263
```

**B.2 cloud-pi 定向门禁**

```text
npm run test:wecom    -> exit 0 | ℹ tests 71; ℹ pass 71; ℹ fail 0
npm run test:app      -> exit 0 | ℹ tests 16; ℹ pass 16; ℹ fail 0
npm run test:api      -> exit 0 | ℹ tests 26; ℹ pass 26; ℹ fail 0
npm run test:targets  -> exit 0 | ℹ tests 29; ℹ pass 29; ℹ fail 0
npm run test:scheduler-> exit 0 | ℹ tests 31; ℹ pass 31; ℹ fail 0
npm run test:p0       -> exit 0 | ℹ tests 12; ℹ pass 12; ℹ fail 0
npm run api:smoke     -> exit 0 | {"event":"result","ok":true,"requests":18}
npm run wecom:check   -> exit 2 | wecom_config_error: WECOM_BOT_ID and WECOM_BOT_SECRET must be set
```

**B.3 统一入口装配 + 聊天 run 读回（本机真实进程）**

```text
$ node scripts/agt-037/entry-smoke.mjs
{"event":"agt037_entry_smoke", …,
 "checks":{"checkExitCode":0,"apiUrl":"http://127.0.0.1:9179/v1",
  "health":{"httpStatus":200,"ok":true,"phase":"running"},
  "chatRun":{"runId":"r-20261103T191512-8761a9","httpStatus":200,"sameRunId":true,"topic":"chat message"},
  "shutdown":{"drained":true,"schedulerDrained":true,"apiStopped":true,"exitCode":0},
  "missingCredentialExitCode":2},"ok":true}
```

**B.4 证据扫描（D8，本轮结果：1 命中）**

```text
$ node scripts/agt-03x/d-failure-modes.mjs        # dev@ade8a36
{"scenario":"D","at":"2026-11-03T19:18:59.840Z","event":"scan","check":"D8","status":"fail","detail":"files=64 hits=1"}
{"scenario":"D","at":"2026-11-03T19:18:59.843Z","event":"scan","check":"D8","status":"fail","detail":"secret-shaped hits: t6-answers.md:wecom_chat_id","mode":"offline"}
```

命中原文（`docs/research/wecom-channel/t6-answers.md:81-82`）——为**避免本文件自身触发同一条规则**，
下引时把等号写成 `←`，逐字原文里的连接符是 `=`：

```text
L81: { "type": "wecom_user", "id": "<userid>",  "label": "张三" }   // 单聊 → chatid ← userid, chat_type=1
L82: { "type": "wecom_chat", "id": "<chatid>",  "label": "研究群" }   // 群聊 → chatid ← chatid,  chat_type=2
```

判定：**假阳性**（占位词被当成 id 值），无真实 id 泄漏；处理建议见 §3.9 与 G12。**不因此下调第 9 项之外的任何结论**。

**B.5 验收执行包自检（`--full`，本轮 8/11）**

```text
$ node scripts/agt-03x/self-test.mjs --full
offline self-test: 8/11 cases + 21/21 judge regressions behaved as expected
FAIL D/offline: exit=1 (expected 3)
FAIL D/wecom-absent: exit=1 (expected 3)
FAIL C/full: exit=1 (expected 3)
# 原因：D 的两个用例因 D8 fail 而 exit 1；C/full 因基线漂移（judge 期望 fail===2，dev 实际 0）而 exit 1
```

**B.6 cloud-auth / cloud-mcp-guanlan 门禁**

```text
# cloud-auth dev@dbac1c0（worktree 内容与 dev 一致）
$ pnpm run check
 Test Files  43 passed (43)
      Tests  204 passed (204)
 Test Files  12 passed (12)
      Tests  136 passed (136)

# cloud-mcp-guanlan dev@e3aefe0（--detach worktree）
$ npm run check
✔ real scheduled three-mode profiler uses bounded production fetch, parser and D1 (2635.8423ms)
ℹ pass 1 / ℹ fail 0   # 末个测试文件；整体 exit 0
```

## 附录 C：后续状态更新（append-only，追加于 2026-11-04 04:20 UTC+8）

> 规则同附录 A：本附录**只追加**，不修改 §2–§4 的既有判定。既有判定描述的是"当时测到的事实"；
> 修复后的新事实写在这里，若与旧判定冲突则另开 finding，不改分。

### C.1 G12 已修复（cloud-pi PR #33，commit `d4e2104`，合并 `776e6b9`）

- 处置：按"规则侧"修，**没有**改 `t6-answers.md` 的措辞——`wecom_chat_id` 规则在等号右侧放行占位词
  （`userid|chatid|open_userid|redacted|example|sample|…`），完整 id 与 `…`/`...` 掩码语义不变。
- 新证据（同一台机器，dev 合并后）：`node scripts/agt-03x/d-failure-modes.mjs` → D8 **`hits=0`**（原 `files=64 hits=1`）；
  `self-test --full` 的 `D/offline`、`D/wecom-absent` 恢复 pass。
- 新增回归：`scan/placeholder-chatid-allowed`、`scan/placeholder-chatid-group-allowed`、
  `scan/placeholder-redacted-allowed`（占位放行）、`scan/placeholder-does-not-hide-real-id`（完整 id 仍拒）。
- 对 §3.9 / 第 9 项的影响：**不改写**。第 9 项记的是修复前"1 命中（假阳性）"的事实；
  即使现在 0 命中，结论"**机器扫描 0 命中 ≠ 全仓无泄漏**"依然成立，边界未变。

### C.2 G13 已修复（同一 PR）

- 处置：`judge.mjs` 不再断言 `tests≥555 && fail===2`（那是 `dev@8efc250` 的快照），改为从 TAP 摘要读
  `tests`/`fail`：摘要必须自洽（`0 < tests`、`0 ≤ fail ≤ tests`）；`fail === 0` 直接 pass；
  `fail > 0` 仅当显式 `KNOWN_FAILURES`（当前为空）覆盖每一行失败才 pass。
- 新证据：判定器内建回归 **21 → 27 条**全过，含 `judge/dev-actual-642-0-pass`
  （给定 dev 实际 `tests=642 fail=0` → pass）与 `judge/small-suite-pass`（12 条小套件 → pass，证明不再依赖绝对值）。
- 整体：`node scripts/agt-03x/self-test.mjs --full` → **11/11 cases + 27/27 regressions，exit 0**（原 8/11、exit 1）。
- 对 §6 cloud-pi 行的影响：**不改写**。该行记的是修复前 `8/11、exit 1`；修复后的数字见本附录。

### C.3 G15 新增（已观测、未定位、未加重试掩盖）

- 现象：2026-11-04 03:33 一次 `self-test --full` 中 `C2-api` 失败 1 条
  （`T1 create returns 201 with Location, public target config and no internal fields`，`tests=26 fail=1`）。
- 之后的对照：`npm run test:api` 连跑 **5/5 通过**；`c-feishu-regression --full` 连跑 **3/3 通过**（C3 均为 642/0）。
- 判断：**偶发，未定位**。没有改动它、也没有在 harness 里加重试——重试会把"偶发的真失败"一起吞掉，
  这与本验收包"fail 必须可见"的立场冲突。定位方向见缺口表 G15。
- 对 §6 的影响：无（该次失败发生在修复前的那一轮，未计入 C.1/C.2 的新数字）。

### C.4 G16 新增（产品规则，未强制）

- 规则与依据见 **§5.5**：工具不可用时不得把模型原文（尤其 `<||DSML|| …>`）投递给用户，
  应以一句人话说明能力不可用，并在 run 记录标失败。
- 归属：pi-dev（t27 两段式回复 + PR #30 修复）。**验收方式**：用 `--mode=forged` 复检
  ——期望用户侧只收到一句人话、run 记录为失败、投递记录可查。

### C.5 guanlan #30 已合并（`ea85eff`）

- F-30-5..10 六点在我的复核里全部落实，结论 **pass**（cloud-mcp-guanlan PR 评论 `6613454022`），
  4 条 low 建议（UTC/本地日期混用、占位路径、"自包含"措辞、`Remove-Item` 守卫）未阻塞合并。
- 消歧：§6 表末行"cloud-pi PR #30（AGT-038）未验"指的是 **cloud-pi 的** #30，与本行 guanlan #30 无关；
  前者本轮已评审（结论 `needs_revision`：脱敏后门 F-30-1、Trace 判定矛盾 F-30-2），状态见 C.6。

### C.6 cloud-pi PR #30 评审结论（`ed5ffe0`）

- 我**独立复现**（自签令牌 + 真实 Worker + 真实模型）：runId `r-20261103T194511-3f8531` succeeded，
  `whoami` 580 ms、`news_recent` 1155 ms 返回 2 条真实新闻；`tools/list` 恰好 2 个读工具；`test:mcp` 19/19；
  expired → `mcp_credential_unavailable` 且**模型未被调用**；audience 不符客户端即拒；forged → 真实 401 + 零工具调用。
- 结论 **needs_revision**：F-30-1（`Next cursor` base64url 包着 account/consumer UUID，绕过 `sanitize()` 进了 run 记录）
  与 F-30-2（判失败时 run 记录仍 `succeeded`，管理 API 读回与 Trace 矛盾）为必修；另 3 条建议。
- 因此 A-3 行**仍待补**：等 pi-dev 修完两条必修、PR 合并后再按"真实工具调用 / 令牌不进模型 / fail-closed"
  三条给最终 L3 判定。

### C.7 追加后的交叉核对（重算）

- L3 行（1/2/4/6/8、第 5 项、第 3 项的通道部分）仍逐条对得上 G0–G11，**无失配**；
- 新增 G15（工具维护）、G16（投递纪律）不对应任何 L3 声明，也不下调任何既有判定；
- **结论：追加后依然没有"标 L3 但缺口表里对不上"的行**；也没有把任何 L2 行升成 L3。

### C.8 引用锚点复核（dev@776e6b9）

方法：把矩阵里所有 `path:line` 引用抽出来，对三个仓库 `origin/dev` 的当前文件做"存在性 + 行数 + 被引区间首末行内容"检查
（cloud-pi `776e6b9`、cloud-mcp-guanlan `ea85eff`、cloud-auth `481767f`），共 57 处引用。

- **命中且内容一致**：其余全部，包括 `live-smoke-evidence.md`、`group-and-proactive-evidence.md`、
  `agt-037-unified-runtime.md`、`agt-027-live-evidence.md`、`agt-036-wecom-channel.md`、
  `agt-034-local-management-api.md`、`src/channels/wecom/policy.mjs:46-58`、
  guanlan `gln-014-real-token-acceptance.md:40-50/62-65/80/82/155-166`、cloud-auth `gln-013-nonprod-runbook.md:16-18/65-87`。
- **1 处行号漂移**：`docs/evidence/wecom-v1/README.md` 的 §8（证据卫生与更正记录）原引用 `:126-154`。
  #33 让 §7 变长后，§8 现在从 **L136** 开始、文件共 164 行，正确引用应为 **`:136-164`**。
  按附录 A 的 append-only 规则**不原地改 §3.9**，以本行解释为准。
- **一个口径变化，别误读**：`d-failure-modes` 现在仍 **exit 3**，但原因已不同——D8 **pass**
  （`scanned 63 evidence files, zero secret-shaped hits`），exit 3 来自 `pre-P1` 检查"缺 `WECOM_BOT_ID`/`WECOM_SECRET`"
  （无凭证环境的必然结果）。**不要把 exit 3 读成"D8 还在失败"。**

### C.9 复现命令逐条执行（不含需要真实入站/凭证的）

| 命令 | 本次结果 | 说明 |
| --- | --- | --- |
| `npm run wecom:check` | exit 2，`wecom_config_error` | 与 B.2 一致，fail-closed |
| `npm run api:smoke` | exit 0，18 requests | |
| `node scripts/agt-037/entry-smoke.mjs` | exit 0，`ok:true`，runId `r-20261103T195336-06b1c1` | 含 `missingCredentialExitCode=2` |
| `node scripts/agt-03x/d-failure-modes.mjs` | exit 3；D8 **pass**、`pre-P1` blocker | 见 C.8 口径说明 |
| `node scripts/agt-03x/self-test.mjs --full` | **11/11 + 27/27，exit 0** | 会重写 `offline-selftest.txt`（生成物，已还原，不入 PR） |
| `npm run test:wecom` / `test:app` / `test:api` / `test:targets` / `test:scheduler` / `test:p0` | 71 / 16 / 26 / 29 / 31 / 12 全 pass，exit 0 | `test:api` 为本轮**第 6 次连续通过**（G15 仍只是偶发） |
| `npm test` | 642/642，80 suites，exit 0 | dev@776e6b9 |
| `npm run agent`、`npm run wecom:wait-inbound` | **未执行** | 需真实模型 key / 真实凭证 + 真实入站；命令本身存在（已核 `package.json`） |
| guanlan `npm run check`、cloud-auth `pnpm run check` | **本轮未重跑** | 两仓自 B.6 无改动；本机 guanlan 无 `node_modules`（G3/G9 同类限制） |

> 判读提醒：命令"能跑通"只证明**工具链可用**，不证明产品验收；判定仍以 §0 / §4 为准。
