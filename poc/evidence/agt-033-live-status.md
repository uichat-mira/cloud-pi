# AGT-033 · 飞书主动投递 Live 证据（脱敏）

> 状态：**真实个人 + 真实授权群主动投递通过；重复 callback / coordinator 重启零新增；
> 不可达 destination 失败隔离通过（修复 SDK 抛错分类后复测）。**
> 时间：2026-11-03 17:01 Asia/Shanghai。
> 被测实现：`feat/agt-033-scheduler-delivery`，PR #18（实际 head 以 PR 页面为准，
> 不在证据文档里写死，避免每次提交后过期）；主 Live 运行 commit `93aacb7`，
> 失败分类修复/复测 commit `350666f`（基线 `dev@fad03f8`）。
> 原始 JSONL：[`agt-033-live-delivery.jsonl`](agt-033-live-delivery.jsonl)。
> 本文与 JSONL 不含 App Secret、token、模型 Key、消息正文、完整 open_id/chat_id。

## 1. 结论

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 个人 `open_id` 真实主动发送 | **通过**：`attempts=1`，`messageId` 已记录 | JSONL `personalTarget` |
| 授权测试群 `chat_id` 真实主动发送 | **通过**：`attempts=1`，`messageId` 已记录 | JSONL `groupTarget` |
| 2 次重复 completion callback | **零新增消息**：发送计数 2，messageId 未变 | JSONL `sendCount`/`idempotency` |
| 重启 coordinator 后重放同一 run | **零新增消息**：发送计数仍 2 | JSONL `sendCount`/`idempotency` |
| 不可达但格式合法的 `open_id` | **失败隔离**：终态 failed、`attempts=1`、`createdMessages=0`；个人/群保持 sent，最终 `research=completed / delivery=partial` | JSONL `failureIsolation` + 复测行 |
| 有界 retry | 复测目标 1 次终态拒绝；预算 `maxAttempts=3` 未触发无界重试 | 复测 JSONL `attempts=1` |

## 2. 主 Live 运行（commit `93aacb7`）

- Run：`r-20261103T090100-8f53d7`（研究状态 `completed`，trigger `succeeded`）
- 个人目标：`ou_f7a…81a5`（来自维护者在同一会话发来的普通私聊，仅内存使用），
  `status=sent`，`attempts=1`，`messageId=om_x100b61ae6215c0acdf690efe9f0bfc8`，
  `sentAt=2026-11-03T09:01:01.394Z`
- 群目标：`oc_09e…5daf`（`.env` 唯一授权测试群），`status=sent`，`attempts=1`，
  `messageId=om_x100b61ae622e1ec8c0e8c857c6ea1e6`，
  `sentAt=2026-11-03T09:01:02.079Z`
- 真实消息数：2（每个目标恰好 1 条）
- 幂等：重复 completion callback ×2 后发送计数仍 2；新 coordinator 重启后仍 2；
  两个真实目标的 messageId 均未变化 → **没有第二条消息**
- 研究内容边界：run 由确定性 runtime fixture 产生（本卡验证投递路径），不是真实模型研究样本。

主运行随后追加了一个可信但不可达的 `open_id` 目标。旧代码把 SDK 抛出的 HTTP 400
业务拒绝误判为可重试网络错误，因此该目标被尝试 3 次后终态失败（未创建消息，个人/群
记录未回滚，最终 `research=completed / delivery=partial`，sent=2 / failed=1）。
这是有界重试，但分类不正确；已修复并复测。

## 3. 失败分类修复与复测（commit `350666f`）

- 修复：SDK 对 HTTP 400 业务错误会 `throw`（AxiosError，`response.data.code` 存在），
  transport 先提取业务码再分类；`99991400` 可重试，其它业务码终态，并保留
  `feishuCode` 到 delivery `lastError`；持久化错误文本不回显 raw id。
- 复测只针对失败路径，不向任何真人/群发送消息：
  - 不可达 `open_id`：`ou_000…0000`
  - `status=failed`，`attempts=1`，`sendCalls=1`，`createdMessages=0`
  - `feishuCode=99992351`，`retryable=false`
  - `codeCommit=350666f`
- 因此最终代码的失败隔离为“一次 API 尝试即终态”，不会对坏目标刷重试。

## 4. 仍未验证 / 不在本卡范围

- 多实例/distributed exactly-once（本卡是单进程本地持久化幂等）；
- “已发送但记录尚未落盘”的极端崩溃窗口仍可能 at-least-once（先 pending 落盘已缩小窗口）；
- 真实模型/联网研究触发主动投递的样本（Live 研究 runtime 为 fixture）；
- 授权群以外的群、个人目标以外的用户；
- 未部署、未合并、未关闭 Issue。

## 5. 复现

```bash
# 主 Live（需要维护者私聊窗口；每个目标 1 条）
node --env-file-if-exists=.env scripts/agt-033/live-delivery-evidence.mjs --wait-dm-seconds 240

# 失败路径复测（不产生真实消息）
node --env-file-if-exists=.env scripts/agt-033/live-failure-probe.mjs
```
