# AGT-032 Live 证据状态（脱敏）

> 状态：**私聊 Live 已执行，研究终态 partial（`completed_with_errors`）**。
> 原始 JSONL：[agt-032-live.jsonl](agt-032-live.jsonl)（不含消息正文/topic、secret/token、完整飞书 id）。

## 结果

| 项 | 值 |
| --- | --- |
| 场景 | 真实飞书私聊 `/research <短话题>` |
| 时间 | 2026-11-03 16:31–16:32 Asia/Shanghai |
| 被测 commit | `03e4f89`（基线 `dev@fad03f8`） |
| run id | `r-20261103T083122-a94e86` |
| 持久化终态 | `completed_with_errors`（partial） |
| 回复 | 已送达原消息（`replyDelivered=true`） |
| 耗时 | `68198 ms`；来源 46；报告 7878 字符 |
| masked ids | event `88b940…d09e` / message `om_x10…ee3c` / chat `oc_3d5…a9b6` / reply `om_x10…e4bc` |
| partial 原因 | 引用未读 11、来源 403×2、read_page 失败×2、search 预算拒绝×1 |

## 说明

- `result.ok=false, reason=research_not_completed` 来自驱动脚本的严格判据
  （要求 `persistedStatus=completed`）；本次研究是 partial，不是通道/run/reply 失败。
- `run_readback` 记录真实 run.json 读回；`metadata_correction` 修正旧驱动在 linked
  worktree 下 `commit=null` 的元数据 bug（已修复，`--print-metadata` 复核 `03e4f89`）。
- 未执行：授权群 @ 的真实 `/research` Live；真实研究“完整成功”样本。
- 驱动脚本：`scripts/agt-032/research-live-evidence.mjs`。
