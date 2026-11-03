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
写入前 `createEvidence` 会做字段白名单 + 密钥形状扫描，命中即抛错拒绝落盘。

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
