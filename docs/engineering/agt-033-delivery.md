# AGT-033 · 定时研究的多目标飞书主动投递

Status: 实现与自动化验证完成；Draft PR target `dev`；**Live 待真人窗口**（见 §10）。
Owning Issue: [#15](https://github.com/uichat-mira/cloud-pi/issues/15)。
Base: `origin/dev` at `fad03f8`（AGT-028/029/030 已合入）。Branch:
`feat/agt-033-scheduler-delivery`。

本文是 AGT-033 的设计、合同、测试与证据索引。它不声称已合并、已部署或已具备生产
多实例 exactly-once；尚未执行的 Live 项在 §10 明确标注。

## 1. 目标与边界

Scheduler 触发的一次 AGT-028 research run 到达终态后，把结果主动投递到该任务可信
配置中的一个或多个飞书个人/群目标，并 **为每个 `runId + destination` 持久记录投递
结果**。研究状态（research status）与投递状态（delivery status）是两份独立事实。

本卡负责：

- 在现有 `createFeishuTransport()` 之上增加最薄的主动发送（官方 SDK
  `client.im.message.create`，`receive_id_type=open_id|chat_id`）；
- Scheduler 任务的 `deliveryTargets` 可信配置合同；
- 终态后的独立 Delivery 阶段、幂等键、持久结果、有界重试、长报告有界分段；
- 单目标失败隔离与可审查的 per-destination 视图。

本卡不负责（Issue Non-goals）：Cloud Auth 控制台/任务 API（AGT-034）、飞书身份到
Cloud Account 映射、跨渠道 Delivery 平台/事件总线/消息队列、持久会话、多实例分布式
exactly-once、博客发布或其它外部副作用。**`src/scheduler/scheduler.mjs` 的研究执行
职责未被修改；`src/api/`、`src/research/`、`.env`、`docs/product-design.md`、
`docs/architecture.md` 未改动。**

## 2. 先读的当前事实

实现前按当前远程/代码事实而不是聊天记忆决策：

- [Mira Organization AGENTS](https://github.com/uichat-mira/.github/blob/main/AGENTS.md)
  （policy `2026-09-16.2`，Constitution v1.1）；
- 本仓 `AGENTS.md`、`docs/product-design.md`（多目标投递与“重复触发/通知必须可识别”）、
  `docs/architecture.md`（收件人映射只在可信配置侧决定；网络失败不能默认为成功，
  也不能无限重复发送）；
- Issue [#15](https://github.com/uichat-mira/cloud-pi/issues/15) 全文与 Scope 1–8；
- `dev@fad03f8` 源码：`src/scheduler/{scheduler,store,contracts,schedule,index}.mjs`、
  `src/channels/feishu/{transport,config,service,channel,runtime,events}.mjs`、
  `src/research/{index,run-store,contracts,execute}.mjs`、`tests/scheduler-*.mjs`、
  `tests/agt-029-*.mjs`、`tests/helpers/*`；
- 锁定 SDK `@larksuiteoapi/node-sdk@1.76.0` 的实际类型定义：
  `client.im.message.create({ data: { receive_id, msg_type, content, uuid? },
  params: { receive_id_type: "open_id"|"user_id"|"union_id"|"email"|"chat_id" } })`
  返回 `{ code, msg, data: { message_id, ... } }`。实现与测试按该签名，不按记忆猜。

## 3. 架构落点

```
src/scheduler/（既有，不改执行职责）
  schedule.mjs / contracts.mjs ── 新增可信 deliveryTargets 合同
        │
        ▼  终态 trigger（runId/researchStatus/status/error）
src/delivery/scheduler.mjs  createDeliveringScheduler()
        │  包装 scheduler.tick()/runNow()/start() 的公开结果 + 启动 reconcile
        ▼
src/delivery/coordinator.mjs  createDeliveryCoordinator()
        │  planDelivery → 读 AGT-028 run/report → buildDeliveryMessage
        │  per-destination 幂等记录 → sendMessage（transport.send）
        ▼
src/channels/feishu/transport.mjs  send() → im.message.create（唯一 transport）
```

### 为什么用组合根包装而不是 `startResearchFn`

任务合同优先建议包装 `startResearchFn`（`startResearch → await done → Delivery`）。
实际读码后有两条硬约束：

1. Scheduler 只把 `schedule.request` 传给 `startResearch()`，executor 包装器看不到
   schedule 上的可信 `deliveryTargets`；把 recipient 放进 research request 会混淆两份
   合同，并给模型/报告文本影响 recipient 留下路径。
2. 进程重启后的终态 run 由 scheduler 的恢复逻辑直接落库，**不会再经过
   `startResearchFn`**；只包装 executor 无法恢复“研究完成但投递未发生”的运行。

因此 `createDeliveringScheduler()` 包装 scheduler 已有的公开结果（`tick()` 返回的
terminal trigger、`runNow()` 返回值、`start()` 的恢复结果），在 **scheduler 终态之后**
调用 coordinator。`src/scheduler/scheduler.mjs` 未改；`tick` 包装的 promise 也进入
scheduler 的 `_background`，所以 `settle()`/`stop()` 会等待投递阶段结束。投递异常被
捕获，不会把研究成功改成失败。

### 触发与恢复

- `tick()`：每个 terminal trigger（succeeded/partial/failed/cancelled/timeout）→
  `deliverTrigger()`；
- `runNow()`：立即执行后的 terminal trigger → 同上；
- 构造 `createDeliveringScheduler()` 时与 `start()` 后各执行一次 `reconcile()`：只重放
  每个 schedule **最近 1 个**带 `runId` 的 terminal trigger（`reconcilePerSchedule=1`），
  已 `sent`/`failed` 的目标由 coordinator 跳过。避免把历史运行一次性补发/轰炸；
- 无 `runId` 的 trigger（例如 executor 在创建 run 前就失败）没有稳定幂等键，**不投递**；
  该失败已由 scheduler 的 trigger 审计记录，不会被伪装成投递成功。

## 4. `deliveryTargets` 合同（可信配置）

```js
await scheduler.createSchedule({
  kind: "recurring",
  timezone: "Asia/Shanghai",
  cron: "0 9 * * *",
  request: { topic: "研究最近 48 小时 AI Agent 工程进展" },
  deliveryTargets: [
    { type: "open_id", id: "ou_…", label: "维护者私聊" },
    { type: "chat_id", id: "oc_…", label: "测试群" },
  ],
});
```

- 位置：schedule 顶层字段，**不进** `request`；旧记录缺少该字段仍可读（视为无目标）。
- `type` 只接受 `open_id` / `chat_id`（与 SDK `receive_id_type` 同名）；
  `id` 必须分别以 `ou_` / `oc_` 开头；`label` 可选、≤80 字符。
- 未知字段直接拒绝（例如 `receive_id`、`open_id`、`nested`），避免“猜一个字段名就
  成为 recipient”；同一 `type+id` 去重；最多 10 个目标。
- 收件人只从持久化 schedule 的 `deliveryTargets` 读取。报告/模型/网页/入站消息中的
  任何“转发给 ou_…”文本都只是文本：coordinator 不解析报告来选 recipient（T1/T2/T3
  均有注入负例）。

## 5. 研究状态 → 投递行为合同

| research status（优先） | trigger status | 投递行为 |
| --- | --- | --- |
| `completed` | `succeeded` | 投递已有 `report.md` 全文（有界分段） |
| `completed_with_errors` | `partial` | 明确写“部分完成（有错误 N 项）”并投递**已有报告**；不写成成功 |
| `failed` | `failed` | 只发简短状态通知，声明“未生成可投递的成功报告”，带错误码/详情 |
| `cancelled` | `cancelled` | 只发取消状态通知 |
| `timeout` | `timeout` | 只发超时状态通知 |
| 无 research status | `failed/cancelled/timeout` | 同对应状态通知 |
| — | `interrupted` / `missed` | 不投递（`deliveryStatus=none`，有 reason） |

`triggerStatus` 只在 research 记录不可读时兜底；`succeeded` 但读不到 run 时也只发状态
通知，不声称报告。`succeeded` 且报告缺失时，每个目标记为 `failed/report_missing`
（0 次网络调用），绝不伪造成功。

## 6. 幂等、持久化与重启

- 稳定键：`deliveryKey = "${runId}#${type}:${id}"`（同时持久化 `runId`、
  `destination`，重启可恢复）。
- 存储：`<deliveryStateDir>/runs/<runId>/<sha256(deliveryKey)[0..32]>.json`，默认
  `.work/delivery`（可用 `DELIVERY_STATE_DIR` 覆盖）。每个目标一份记录，字段含
  `status=pending|sent|failed`、`attempts`、`segmentsSent[{index,messageId,sentAt}]`、
  `lastError{code,message,retryable,feishuCode?,at}`、`sentAt`、`messageId`、
  `researchStatus`、`triggerStatus`、`deliveryKind`、`scheduleId`、`dedupeKey`。
- 写入顺序：**先**把 `pending/attempts+1` 原子落盘，再发网络；每成功一段立即落盘。
  因此崩溃后会留下可审查的 pending/部分段，而不是“看不见的已发送”。
- 重放：记录已 `sent`/`failed` 的目标直接返回，不再调用 transport；同一进程内按
  `runId` 串行化重复 callback。T2 的重复回调/新 coordinator 重启/T3 的 restart 重放
  都断言发送计数不增加、messageId 不变。
- `uuid`：每段使用 `sha256(deliveryKey:segment:i)` 的稳定 32 位十六进制作为飞书
  `uuid`，作为平台侧去重的**第二道**保险（飞书去重窗口有限，本地记录才是主保证）。

单进程/本地持久化边界：不承诺多实例跨进程锁；这是 Issue Non-goals。

## 7. 多目标隔离与最终视图

- coordinator 逐个目标执行，每个目标独立 try/catch、独立记录；一个目标失败不会回滚
  其它目标已 `sent` 的记录。
- `getRunDelivery(runId)` 返回：

```js
{
  runId,
  researchStatus: "completed",      // 研究事实，与投递无关
  triggerStatus: "succeeded",
  deliveryStatus: "partial",        // none|pending|sent|partial|failed
  counts: { total: 2, sent: 1, failed: 1, pending: 0 },
  targets: [{
    destination: { type: "open_id", maskedId: "ou_abc…1234" }, // 证据/视图脱敏
    status: "sent", attempts: 1, deliveryKind: "report",
    sentAt: "…", messageId: "om_…", messageIds: ["om_…"], lastError: null
  }, …]
}
```

因此“研究成功但部分投递失败”是可直接判读的：`researchStatus=completed` +
`deliveryStatus=partial` + per-target 明细。

## 8. 长报告与失败重试（有界）

- 每段最多 4000 Unicode code point，最多 3 段；每段带 `（i/n）` 前缀。超长报告在第 3
  段截断并附加 `…（报告超出单次投递上限，已截断；完整报告见 run <runId>）`。
  分段在段落边界优先，绝不拆 surrogate pair；同一个 run 不会产生无限消息。
- 每个目标总尝试次数 `maxAttempts=3`（可配置），重试间隔默认 250ms；仅当错误标记
  `retryable=true` 才重试：
  - 飞书网络/协议异常 → `feishu_network_error`（可重试）；
  - 飞书业务码 `99991400`（请求频率限制）→ 可重试；
  - 其它业务码（无效 receive id、无权限等）→ 终态，避免对坏目标刷 API；
  - 未知错误 → 终态 `internal_error`；
  - 没有 `message_id` 的“成功”响应 → 终态 `missing_message_id`（不能再重试制造不可识别
    的重复消息）。
- 重试从第一个未确认段继续；已确认段不会重发。`attempts` 落盘，重放不会突破总预算。

## 9. 测试与本地证据

新增测试（`node --test tests/agt-033-*.test.mjs`，55 tests）：

| 文件 | 覆盖 |
| --- | --- |
| `tests/agt-033-contracts.test.mjs` | destination schema/未知字段拒绝/去重/上限；schedule 持久化与篡改 fail-closed；旧记录兼容；`runId+destination` 幂等键；五态策略；长文本段数/码点/截断标识/surrogate；接收人不可由额外字段注入 |
| `tests/agt-033-transport.test.mjs` | 官方 SDK `im.message.create` 参数形状（open_id/chat_id）；`reply` 回归；业务码可重试分类；网络错误；缺 `message_id`；无效 destination 在网络前失败 |
| `tests/agt-033-delivery.test.mjs` | pending 先落盘；sent 持久字段；重复 callback/重启/并发 callback 不重发；记录篡改 fail-closed；单目标失败隔离；report missing；有界 retry/exhausted/non-retryable/unknown error；长报告分段与段级续传；报告文本无法改 recipient；无目标/interrupted/no-runId 不投递 |
| `tests/agt-033-integration.test.mjs` (T3) | **真实** `createScheduler` → 真实 AGT-028 `startResearch()` → 真实 run store/`readResearchRun` → 真实 coordinator/store → 假 Feishu transport；completed/partial/failed/cancelled 全链路；重启/重复回调不重发；崩溃后启动 reconcile 只补发一次未投递的终态 run；失败隔离（research 仍 succeeded）；报告注入不改目标；executor 在 runId 前失败不投递 |

本地可复现证据：`node scripts/agt-033/local-delivery-evidence.mjs` 输出
[`poc/evidence/agt-033-local-delivery.jsonl`](../../poc/evidence/agt-033-local-delivery.jsonl)
（真实 scheduler/executor/run store/coordinator/store；模型/网络为确定性 fixture，
Feishu 为 fake sendMessage，无真实网络）。覆盖 4 个场景：双目标成功 + 重复回调/重启
零新增发送；单目标失败隔离；有界 retry 与耗尽；长报告 3 段且重放零新增。

回归：`npm test` 从基线 399 tests 增至 454 tests（+55），0 fail；AGT-029/030 的
scheduler 与 Feishu 测试全部保留。

## 10. Live（T4）与未验证项

Live 脚本：`scripts/agt-033/live-delivery-evidence.mjs`。真实发送使用锁定 SDK
`im.message.create`；研究 run 使用确定性 runtime fixture（本卡证明投递路径，不把
fixture 研究冒充真实模型研究）。

脚本行为（每个目标只发 1 条）：

1. 个人目标：`FEISHU_TEST_OPEN_ID`，或在同一 live 会话内由维护者发一条普通私聊，
   从事件取 `sender_open_id`（仅内存，证据只写 masked）；
2. 群目标：`.env` `FEISHU_ALLOWED_CHAT_IDS` 中唯一授权测试群；
3. 幂等：同一 `runId+destination` 再触发 2 次 completion callback，并用新 coordinator
   模拟重启；断言发送计数与 messageId 都不增加；
4. 失败隔离：用一个格式合法但不可达的 `open_id` 作为可信配置的额外目标，真实调用失败、
   不产生消息；断言个人/群已 sent 不被回滚，最终 `research=completed` /
   `delivery=partial`、sent=2/failed=1；
5. 证据写到 `poc/evidence/agt-033-live-delivery.jsonl`：masked destination、run id、
   message id、attempts、最终状态；不含正文、topic、raw id、secret。

运行命令（`.env` 只读，不提交）：

```bash
node --env-file-if-exists=.env scripts/agt-033/live-delivery-evidence.mjs --append
```

**当前状态：未执行（等待维护者私聊窗口）。** 尚未拿到真人窗口，本文与 PR 不声称
真实个人/群主动投递已验证；自动化 T1/T2/T3 已全部通过。执行后会把脱敏 JSONL 与
`poc/evidence/agt-033-live-status.md` 更新为真实结果（成功或失败均如实记录）。

仍未证明/明确不在本卡范围：

- 生产多实例/distributed exactly-once（单进程本地幂等）；
- 飞书 `uuid` 去重窗口之外、且“已发送但记录未落盘”的极端崩溃窗口，仍可能 at-least-once
  （记录先 pending 后发送降低了窗口，但不是分布式事务）；
- 未做真实模型/网络研究触发主动投递的样本（Live 研究的 runtime 是 fixture）；
- 未部署、未合并、未关闭 Issue。

## 11. 安全

- 不发消息正文、topic、raw open_id/chat_id、app secret/token 到日志或证据；日志只写
  masked destination 与错误码。
- 只有 schedule 的可信 `deliveryTargets` 能决定 recipient；模型/网页/报告/入站消息文本
  不能新增或改写目标。
- `.env` 只读；未提交任何 secret；delivery store 内保存 raw id 仅用于重启后重发，
  位于本地 `.work/` 且不入库。
- 失败 fail closed：无效 target、无效 runId、缺失 message_id 都记录失败而不是成功；
  未知错误不默认重试无限。
