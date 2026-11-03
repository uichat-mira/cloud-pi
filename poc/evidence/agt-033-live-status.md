# AGT-033 · 飞书主动投递 Live 状态（脱敏）

> 状态：**未执行 / 未验证**（截至本 commit 生成时）。
> 被测实现：`feat/agt-033-scheduler-delivery`（基线 `dev@fad03f8`）。
> 驱动脚本：`scripts/agt-033/live-delivery-evidence.mjs`。
> 证据目标文件：`poc/evidence/agt-033-live-delivery.jsonl`。

## 1. 当前事实

- T1/T2/T3 自动化全部通过（55 个新增测试；`npm test` 454 pass / 0 fail）。
- 本地可复现证据 [`agt-033-local-delivery.jsonl`](agt-033-local-delivery.jsonl) 使用真实
  scheduler/executor/run store/coordinator/store；模型与网络为确定性 fixture，飞书发送
  为 fake transport。**它不是 Live 证据。**
- 真实飞书个人/群主动投递尚未执行：需要真人维护者窗口提供个人 `open_id`
  （`FEISHU_TEST_OPEN_ID` 或从一条普通私聊事件捕获）并确认测试群可用。
- 未发送任何真实主动消息，因此没有可记录的 message id；不把 dry-run 或自动化结果写成
  Live 成功。

## 2. 执行计划（拿到窗口后）

1. 维护者用目标账号给 Mira 机器人发一条任意普通私聊（不含敏感信息）；
2. 运行：
   `node --env-file-if-exists=.env scripts/agt-033/live-delivery-evidence.mjs --append`
3. 脚本真实发送：个人 `open_id` 1 条、授权测试群 `chat_id` 1 条；随后同一
   `runId+destination` 重放 2 次 completion callback + 重启 coordinator，验证发送计数与
   messageId 不增加；
4. 用格式合法但不可达的 `open_id` 作为可信配置的额外目标，验证失败不产生消息、不回滚
   个人/群已发送记录，最终 `research=completed` / `delivery=partial`；
5. 将脱敏 JSONL（masked destination、run id、message id、attempts、状态）写入
   `poc/evidence/agt-033-live-delivery.jsonl`，并把本文件的 §1 更新为实际结果。

## 3. 脱敏约束

- 不记录消息正文、研究 topic、完整 open_id/chat_id、app secret/token、模型 key；
- 所有 destination 使用 `ou_abc…1234` / `oc_abc…1234` masked 形式；
- message id（`om_…`）仅用于证明真实发送与幂等重放，不含凭证。
