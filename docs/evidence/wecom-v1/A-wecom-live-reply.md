# 场景 A · 企业微信主动提问（单轮真实往返）证据骨架

> 状态：**未执行**（真实模式尚未执行）。填写人：______ 填写时间：______
> 判据来源：[acceptance-matrix.md §A](../../engineering/acceptance-matrix.md)；脚本：`scripts/agt-03x/a-wecom-live-reply.mjs`

## 0. 执行元信息

| 项 | 值 |
| --- | --- |
| 命令 | `node scripts/agt-03x/a-wecom-live-reply.mjs --evidence-in poc/evidence/agt-036-live.jsonl --api <url> --evidence poc/evidence/agt-03x-a.jsonl` |
| 开始时间（含时区） | |
| 结束时间（含时区） | |
| 仓库 HEAD（cloud-pi） | |
| 通道驱动 HEAD / `npm run wecom:live` 是否可用 | |
| 模型 `providerId` / `modelId`（可公布部分） | |
| runId | |
| 证据文件 | `poc/evidence/agt-03x-a.jsonl`（另加 `poc/evidence/agt-036-live.jsonl`） |

## 1. 判据勾选

- [ ] **A1 入站**：`channel.ingress` 存在，`channel=wecom`，带 `runId`，且 `senderMasked`/`chatMasked` 已脱敏
- [ ] **A2 真实模型**：`agent.run` `status=completed`，`providerId` ≠ `fixture`，`usage.input>0` 且 `usage.output>0`
- [ ] **A3 回复被接受**：`reply.sent`/`delivery.attempt` `status` ∈ {sent, delivered}，`attempts == 1`
- [ ] **A4 工具面**：`tools.exposed` ⊆ 声明的 `--allowed-tool` 白名单
- [ ] **A5 API 读回**：`GET /v1/runs/:runId` 与 `GET /v1/runs/:runId/delivery` 返回同一 runId

## 2. 判定输出（贴脚本 result 行，勿手写）

```jsonl
（粘贴 poc/evidence/agt-03x-a.jsonl 中 event=result 的那一行）
```

## 3. 通道侧观测（脱敏）

| 项 | 值 |
| --- | --- |
| 企业微信侧是否显示机器人已回复（是/否） | |
| 首字延迟（ms，取自 evidence `durationMs`） | |
| 是否出现重复回复 / 多次投递 | |
| 是否有任何明文正文进入日志或证据（必须为「无」） | |

## 4. 结论

- 判定：`pass` / `fail` / `blocker`
- 若 fail/blocker，原因与责任方：
- 遗留风险：

## 5. 复现命令

```bash
node scripts/agt-03x/preflight.mjs --scenario A
node scripts/agt-03x/a-wecom-live-reply.mjs --evidence-in poc/evidence/agt-036-live.jsonl --api <url> --evidence poc/evidence/agt-03x-a.jsonl
```
