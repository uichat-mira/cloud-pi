# AGT-03x 验收执行包 · 企业微信 V1 证据目录

本目录是**验收执行的入口与证据落点**，不存放任何结论性「已通过」材料。
现在这里的一切都是**执行骨架**：脚本可跑、判定可自测、真实链路**尚未执行**。

> 真实模式尚未执行。缺凭证/缺能力时每个脚本都返回 `blocker`（exit 3），
> 绝不会返回 `pass`。任何「pass」只能来自真实链路产生的 JSONL 证据。

- 验收判据来源：[docs/engineering/acceptance-matrix.md](../../engineering/acceptance-matrix.md)（§0 前置清单 + 场景 A–D）
- 证据 schema：[scripts/agt-03x/lib/harness.mjs](../../../scripts/agt-03x/lib/harness.mjs) 的白名单
- 自测留证：[offline-selftest.txt](offline-selftest.txt)（`node scripts/agt-03x/self-test.mjs` 生成，真实输出）

## 1. 脚本一览

| 场景 | 脚本 | 离线可执行 | 缺凭证时 |
| --- | --- | --- | --- |
| 前置 | `scripts/agt-03x/preflight.mjs` | `--json` / `--check-network` | exit 3（blocker） |
| A 企微主动提问 | `scripts/agt-03x/a-wecom-live-reply.mjs` | `--offline` 跑 6 条内置判定用例 | exit 3（capability + pre-P*） |
| B 定时研究 + 主动投递 | `scripts/agt-03x/b-scheduled-research-delivery.mjs` | `--offline` 跑 7 条内置判定用例 | exit 3（pre-P*） |
| C 飞书回归 | `scripts/agt-03x/c-feishu-regression.mjs` | 默认跑真实离线套件（C1/C2/C5/C6）；`--full` 追加全量；`--live` 真实往返 | exit 3（C3/C4 未执行） |
| D 故障与权限 | `scripts/agt-03x/d-failure-modes.mjs` | 真实跑 TAP/runner/扫描 | exit 3（企微负例待 t6） |
| 汇总自测 | `scripts/agt-03x/self-test.mjs` | 全部离线用例 + 落盘 transcript | 期望就是 exit 3 |

退出码约定：`0` pass / `1` fail / `2` 用法错误 / `3` blocker。
判定优先级：**fail 高于 blocker**；blocker 表示「无法判定」，永不等于 pass。

## 2. 环境变量契约（harness 侧）

脚本只检查**存在性**，从不读取、打印或转发值；只有 P7 是人工声明。

| 前置 | 变量 | 说明 |
| --- | --- | --- |
| P1 | `WECOM_BOT_ID` `WECOM_SECRET` | 企微机器人（API 模式 + 长连接）；缺能力时 t6 未交付 |
| P2 | `CLOUD_AUTH_ISSUER_URL` `CLOUD_AUTH_JWKS_URL` `CLOUD_AUTH_ENV` | 非生产实例；含 `prod` 直接判 unmet |
| P3 | `CLOUD_PI_SESSION_TOKEN` | 必须 `mcs_v1.` 前缀（设备绑定会话，过期需重新登录） |
| P4 | `GUANLAN_MCP_URL` `MIRA_GUANLAN_REGISTRATION_SECRET` | 隔离环境 + migrations 到 **0005**（含收据表）+ 注册密钥（≥32 字符） |
| P5 | `AGTX_P5_CONSUMER` = `registered` \| `seed` | 有 consumer 行 + ≥1 已批准源与新闻行 |
| P6 | `CLOUD_PI_MODEL_BASE_URL` `CLOUD_PI_MODEL_API_KEY` `CLOUD_PI_MODEL_ID` | 模型网关 |
| P7 | `AGTX_P7_SECRET_MATCH` = `byte-identical` | 注册密钥两侧逐字节一致（人工确认；接收端对带空白值直接 503） |
| P8 | `CLOUD_AUTH_PUBLIC_JWKS_URL` | 非生产 **https** 公网 JWKS（仅公钥），Guanlan Worker 能取到 |

场景依赖：A = P1,P3,P6；B = P1–P8；C = 无（另有 `FEISHU_APP_ID/SECRET` 仅 C4 用）；D = P1。

## 3. 证据白名单（唯一允许写入 JSONL 的字段）

`runId`、`scheduleId`、`channel`、`targetType`、`status`、`code`、`durationMs`、
`usage{input,output,total}`、`counts{total,sent,failed,pending,attempts}`、`tools{exposed}`、
`check`、`event`、`kind`、`mode`、`detail`、`note`、`at`、`scenario`。

**禁止**：message id、原始 userid/chatid、消息正文、token、secret、绝对路径。

写入前 `createEvidence` 做两道校验，任一命中即抛错拒绝落盘：

1. **字段白名单**（上面的键），嵌套对象只允许 `usage/counts/tools` 的既定子键；
2. **值形态**（外审 F-28-1 后新增）：`ou_`/`oc_`/`om_`/`on_`/`wm…` 前缀 id、JWT、`sk-`、PEM、
   `Bearer …`、`app_secret=`、绝对路径、混合大小写 32+ 位随机 token（git SHA 与 `call_…` 工具调用 id
   不受影响）、**非 ASCII 文本**、以及超过 160 字符的自由文本。

自由文本（`detail`/`note`）因此是**机器摘要**，不是聊天记录：只写 `tests=642 fail=0` 这类投影。
中文只允许一个白名单标签（`scripts/agt-03x/lib/harness.mjs` 的 `APPROVED_TEXT_LABELS`，当前只有 §6 的
seed 标注原文）；其余中文一律拒绝——需要中文解释时写到 stdout/文档，不要写进证据。

合成夹具使用 `om_local_*` / `om_fixture_*` / `wm_local_*` 命名空间，扫描器不对其报警。

## 4. 拿到凭证后 10 分钟内跑完 A / C

```bash
# 0) 一次性：把凭证放进本地 .env（不要提交），然后
node scripts/agt-03x/preflight.mjs                 # 期望 P1-P8 中 A/C 所需项全 [x]

# 1) 场景 C（飞书回归，不需要企微凭证；先证明没退化）
node scripts/agt-03x/c-feishu-regression.mjs --full --evidence poc/evidence/agt-03x-c.jsonl

# 2) 场景 A（企微主动提问）：先用 t6 的驱动产生真实 JSONL，再判定
npm run wecom:live                                  # t6 交付后存在；会真的发一条消息
node scripts/agt-03x/a-wecom-live-reply.mjs \
  --evidence-in poc/evidence/agt-036-live.jsonl \
  --api http://127.0.0.1:4073/v1 \
  --allowed-tool mcp__guanlan__guanlan_news_recent \
  --evidence poc/evidence/agt-03x-a.jsonl
```

C 约 40 秒（`--full` 30 秒是全量测试）；A 的判定本身 1 秒内完成，时间都花在
`npm run wecom:live` 的真实往返上。两条命令的 `--evidence` 就是本目录
[A-wecom-live-reply.md](A-wecom-live-reply.md) / [C-feishu-regression.md](C-feishu-regression.md)
里要填的证据来源。

## 5. 场景 B 的额外要求

B 需要一个**已经跑过一次定时研究**的实例（`--api` + `--schedule-id` 或 `--run-id`）：

```bash
node scripts/agt-03x/b-scheduled-research-delivery.mjs \
  --api http://127.0.0.1:4073/v1 --schedule-id <id> \
  --expect-target <targetType> --evidence poc/evidence/agt-03x-b.jsonl
```

脚本会读 `GET /v1/schedules/:id`、`GET /v1/runs?scheduleId=…`、`GET /v1/runs/:id`、
`GET /v1/runs/:id/delivery`，并与磁盘 `run.json` 交叉比对（B7）——**不重新实现业务逻辑**。

## 6. seed 标注规则（硬性）

若 P5 走 `AGTX_P5_CONSUMER=seed`，证据与结论里必须**原样**标注：

> seed 数据，非 A2 注册链能力（证据必须原样标注）

脚本已在 `preflight` 与场景 B 的 blocker/note 中输出这句话；人工填写证据时也必须保留，
不得删改成「已注册」。

## 7. 判定器自身的硬约束（外审 F-28-1/2 后）

- **C3 从 TAP 输出读计数，不写死基线**（t11 G13 后修订）：`scripts/agt-03x/lib/judge.mjs#fullSuiteVerdict`
  的输入是 `{tests, fail, failing}`（由 `parseTestSummary` / `failingTests` 从 TAP 解析），规则只有三条：
  1. `tests` 必须是正数、`fail` 必须是 `>= 0` 的有限数，且 `fail <= tests`（摘要不自相矛盾）；
  2. `fail === 0` 直接 `pass`；
  3. `fail > 0` 时，**仅当** `KNOWN_FAILURES`（显式已知失败清单，当前为空）非空且**每个**失败行都命中清单才 `pass`；
     否则 `fail`。
  旧实现断言 `tests >= 555 && fail === 2`——那是 `dev@8efc250` 的历史快照；t7 修掉两个 Windows 缺陷后
  基线变成 642/0，判定器反而把**健康的**测试套件判成失败。绝对基线记录的是历史，不是健康度；现在的规则
  只对「出现未声明失败」报警，所以既不会随套件增长误报，也不会在失败被掩盖时放过。
  放宽清单意味着**加模式 + 在提交信息与本文件记录原因**，不允许用环境变量开关（那等于给了静默放宽的旋钮）。
- **D8 按值扫描，覆盖 `docs/**` + `poc/**`**：结构化证据（`.jsonl`/`.json`）先解析再扫字符串值，避免把
  `…_after_sdk_…` 这类键值边界误判为长 token；`.md` 才整篇扫描。形如 `chat_id=0f3b9e…a9b6` 的
  **掩码**是允许的投影，未截断的完整 id 一律拒。**占位词**（`chatid=userid`、`chatid=chatid`、
  `chat_id=redacted`、`chat_id=<chatid>` 等说明文里解释映射的写法）不算命中（t11 G12：`t6-answers.md`
  的一段散文曾把干净的工作树变成 1 个假阳性）。`tests/` **不在**范围内（合成夹具会把扫描器调成噪音）。
- 两者都有进程内回归用例（`self-test.mjs` 的「判定器本身的内建回归」表，**27 条**）：
  G12 由 `scan/placeholder-chatid-allowed`、`scan/placeholder-chatid-group-allowed`、
  `scan/placeholder-redacted-allowed`（占位放行）与 `scan/full-chat-id-detected`、
  `scan/placeholder-does-not-hide-real-id`（完整 id 仍拒）守住；G13 由
  `judge/dev-actual-642-0-pass`（给定 dev 实际输出 → pass）、`judge/small-suite-pass`、
  `judge/failure-without-known-list`、`judge/known-list-does-not-hide-stranger` 等守住。
  注意分层：**掩码/占位规则属于扫描器**（D8 读的是人写的文档，允许 `…` 与占位词），而**生成的证据必须 ASCII**，
  所以证据里的掩码用 `...`（`writer/ascii-mask` 用例），占位词同样不能替真实 id 开脱。
- **跑一次自检会重写已跟踪的证据文件**（t11 附录 D.1）：`self-test.mjs --full` 默认写
  `docs/evidence/wecom-v1/offline-selftest.txt`，`d-failure-modes.mjs` 会写 `poc/evidence/agt-03x-scenario-*.jsonl`。
  这两类都是 **tracked** 文件，`.gitignore` 对已跟踪文件**无效**，所以"加忽略规则"防不住。
  复核时请用 `--out %TEMP%\selftest-<ts>.txt`（脚本原生支持）或 `--no-write`；已经跑脏了就
  `git checkout -- docs/evidence/wecom-v1/offline-selftest.txt poc/evidence/*.jsonl`。
  要**留**新证据就单独开分支/PR 提交，让 diff 可见——证据可以更新，但不能在别人看不见的地方被悄悄改掉。

## 8. 证据卫生与更正记录

2026-11-04。两次真实标识符的发现与更正，**属于纠正纪律 3（证据不得含原始用户/消息 id）的违规，不是改分**。
判定结论、计数、时间戳与证据语义均未改变。

| # | 位置 | 原值形状（脱敏后表述） | 引入处 | 发现者 | 修复 commit | 处理 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `poc/evidence/agt-033-live-delivery.jsonl` | `om_x1…`，2 处 `personalTarget/groupTarget.messageId` | `d6ee2ae`（PR #18） | verifier（F-28-1 收紧扫描） | `a9cd3ba` | → `om_<redacted>` |
| 2 | `poc/evidence/agt-033-live-final-head.jsonl` | 同上，1 处 | `d6ee2ae`（PR #18） | verifier | `a9cd3ba` | → `om_<redacted>` |
| 3 | `poc/evidence/agt-033-live-status.md` | 同上，3 行 | `d6ee2ae`（PR #18） | verifier | `a9cd3ba` | → `om_<redacted>` |
| 4 | `docs/engineering/agt-033-scheduler-delivery.md` §10 | 同上，1 处正文引用的 messageId | `1933de1`（PR #18） | **lead 抽查** | `0b5b41e` | → `om_<redacted>` + 该节「证据卫生」说明 |
| 5 | `tests/agt-035-targets.test.mjs:24` | 维护者**完整** `ou_…` open_id（与第 4 项掩码同源） | `05c4d78`（PR #20，**已合入 dev**） | verifier（全仓复扫） | `0b5b41e` | → 合成常量 `ou_000…0001`，该文件 21/21 仍通过 |

**第 5 项单独说明（已合入 dev 的测试文件，不是文档笔误）**：该 open_id 是维护者本人的真实 open_id，
随 PR #20 进入 `dev`，影响面仅限本仓测试文件（未外发、未进入运行时代码或证据 JSONL）。
`git log -S` 确认历史 commit 原样保留——**历史里仍然含这个 id**，本次只改当前树；
是否重写历史（filter-repo 等）或轮换凭据属**维护者决定**，本卡不做、也不宣称已清除。

**未做什么（逐项，便于复核）**

- 未改任何 `counts` / `attempts` / `sentAt` / `checks` / `runId` / `delivery` 状态 / 判定结论；
- 未改 `correction.originalSha256`（它记录的正是脱敏前那版 JSONL 的哈希，保留即保留可审计链）；
- 未重写 git 历史，未 force-push，未改 `dev`；
- 未动 `om_local_*` / `om_fixture_*` / `wm_local_*` 合成夹具命名空间；
- 未把 D8 扩到 `tests/`（会因合成夹具产生噪音），也未把扫描结果当作「已无泄漏」的证明——
  它只覆盖 `docs/**` + `poc/**` 的文本文件。

**脱敏后验证**：`git ls-files` 全量复扫无真实 `om_x*` / 完整 `ou_` / `oc_` / `wm…`；
D8 在 `docs/**` + `poc/**` 全量（见 `self-test --full` 输出的 `files=` 计数）零命中；JSONL 仍逐行可解析。
