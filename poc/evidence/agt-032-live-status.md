# AGT-032 Live 证据状态（脱敏）

> 状态：**未验证（NOT RUN）**。本文件不是 Live 结果，只是证据位置的显式占位说明。

- 被测实现：`feat/agt-032-feishu-research`（基线 `dev@fad03f8`）。
- 期望的真实证据文件：`poc/evidence/agt-032-live.jsonl`（由真人 Live 运行写入）。
- 驱动脚本：`scripts/agt-032/research-live-evidence.mjs`。
- 执行步骤与脱敏字段：见 [docs/engineering/agt-032-feishu-research.md §8](../../docs/engineering/agt-032-feishu-research.md)。

尚未执行的原因：T4 需要真人从飞书发送 `/research <topic>` 并使用真实模型/Web Research；
本次实现窗口未安排真人操作。自动化证据（T1/T2/T3）见工程文档 §7。

通过标准（Live 运行后应写入的字段）：

- `kind=result, ok=true, reason=research_completed`
- outcome：`kind=research, action=replied, status=succeeded, replyDelivered=true`
- run 读回：`persistedStatus=completed`，包含 `sourcesCount` 与 `durationMs`

禁止写入：消息正文/topic、App Secret、token、模型 Key、完整飞书 id。
