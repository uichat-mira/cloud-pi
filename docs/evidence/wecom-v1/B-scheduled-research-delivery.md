# 场景 B · 定时研究 + 主动投递 证据骨架

> 状态：**未执行**（真实模式尚未执行）。填写人：______ 填写时间：______
> 判据来源：[acceptance-matrix.md §B](../../engineering/acceptance-matrix.md)；脚本：`scripts/agt-03x/b-scheduled-research-delivery.mjs`

## 0. 执行元信息

| 项 | 值 |
| --- | --- |
| 命令 | `node scripts/agt-03x/b-scheduled-research-delivery.mjs --api <url> --schedule-id <id> --expect-target <targetType> --evidence poc/evidence/agt-03x-b.jsonl` |
| 开始 / 结束时间（含时区） | |
| 仓库 HEAD（cloud-pi） | |
| Guanlan Worker HEAD / migrations 版本（应为 **0005**，含 `guanlan_registration_receipts`） | |
| scheduleId | |
| runId | |
| P5 口径 | `registered`（GLN-015 真实投递） / `seed` |
| 若为 seed，是否已标注「seed 数据，非 A2 注册链能力」 | （必须「是」） |

## 1. 判据勾选

- [ ] **B1 只触发一次**：`triggers ≥ 1` 且 runId 唯一（出现第二个 runId = fail）
- [ ] **B2 真实 Guanlan 工具**：存在 `tool.end` 且 `name` 以 `mcp__guanlan__` 开头，`status=ok`，`durationMs>0`
- [ ] **B3 状态映射**：`trigger.status` 与 `mapResearchStatusToTriggerStatus` 镜像一致；`completed_with_errors` 必须显示为 `partial`（显示成 `succeeded` = fail）
- [ ] **B4 投递目标**：实际目标集合 == `--expect-target`；每个目标 `attempts == 1`，`failed=0`，`pending=0`
- [ ] **B6 有界重试**：`maxAttempts ≤ 3`
- [ ] **B7 API ↔ 磁盘一致**：`GET /v1/runs/:id` 与 `<RUNS_DIR>/<runId>/run.json` 的 `runId/status/createdAt/finishedAt` 相同

## 2. 判定输出（贴 result 行，勿手写）

```jsonl
（粘贴 poc/evidence/agt-03x-b.jsonl 中 event=result 的那一行）
```

## 3. 投递侧观测（脱敏）

| 项 | 值 |
| --- | --- |
| 目标类型（`targetType`） | |
| 投递条数 / 失败 / 待投递 | |
| 重试次数（`attempts`） | |
| 定时器是否在约定时间窗内触发（误差 ms） | |
| 研究摘要是否包含来源链接（只写「是/否」） | |

## 4. 结论

- 判定：`pass` / `fail` / `blocker`
- 若 fail/blocker，原因与责任方：
- 遗留风险：

## 5. 复现命令

```bash
node scripts/agt-03x/preflight.mjs --scenario B
node scripts/agt-03x/b-scheduled-research-delivery.mjs --api <url> --schedule-id <id> --expect-target <targetType> --evidence poc/evidence/agt-03x-b.jsonl
```
