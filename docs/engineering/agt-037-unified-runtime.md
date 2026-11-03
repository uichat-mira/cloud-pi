# AGT-037 — Cloud Agent 统一运行入口

状态：已实现（本地真实进程验证；群 `@` 与企业微信主动推送的真实链路验证见 AGT-036 后续修正）
Issue：[#24](https://github.com/uichat-mira/cloud-pi/issues/24)
上游：AGT-027 运行时长、AGT-028 研究执行与 run store、AGT-030/033 调度与投递、AGT-034 管理 API、AGT-029 Feishu 通道、AGT-036 企业微信通道

## 1. 为什么需要它

在 AGT-037 之前，每个能力都有自己的进程入口：`npm run research`、`npm run channel:feishu`、`npm run channel:wecom`、`npm run api:smoke`。它们各自可用，但没有任何一个命令能回答「Cloud Agent 现在活着吗、它的调度在跑吗、它挂在哪条通道上」。本卡只做**装配**：把已有接缝按依赖顺序组合成一个进程，并提供可被外部检查的健康行与明确的生命周期语义。

## 2. 一条命令

```bash
npm run start              # 凭据齐备的通道全部启用（auto）
npm run start:feishu-only  # 只启用飞书
npm run start:wecom-only   # 只启用企业微信
npm run start:api-only     # 调度 + 投递 + 管理 API，不接通道
npm run start:check        # 只校验配置，不启动任何东西
```

`npm run start` 通过 `node --env-file-if-exists=.env` 读取本地 `.env`（模型配置），并在企业微信凭据文件存在时（默认 `~/.mira-secrets/wecom.env`，可用 `CLOUD_AGENT_WECOM_SECRETS` 覆盖）把它读入**进程环境**。凭据只存在于内存：不写回文件、不进日志、不进 run 记录。

## 3. 装配顺序（可观测）

```
config → run store 目录 → 单实例锁 → 研究依赖 → scheduler(+delivery) → 管理 API → 通道 → tick 循环
```

每一步都写一行 JSON 事件（`cloud_agent_phase`），因此「卡在哪一步」是可查的，不是猜的。两个顺序决定是有意的：

1. **调度器先创建、tick 后启动**：`createDeliveringScheduler()` 在构造时会 `reconcile()` 重放未完成投递；此时通道还没起来，所以真正的投递发送函数在调用时才解析 `feishuSender`。tick 循环最后启动，保证恢复的投递有活的发送方。
2. **关闭反序**：通道 → 调度器（`stop({abortActive:false})` + `settle()`）→ 管理 API → 释放锁。API 最后关，所以 `Ctrl+C` 之后短时间内仍可查询状态。

失败即回滚：`start()` 中途抛错会调用 `stop()` 把已启动的部分关掉并释放锁，不会留下半持有的进程（测试 `assembly: a failure mid-start unwinds everything already started`）。

## 4. 通道降级策略

| `CLOUD_AGENT_CHANNELS` | 行为 |
| --- | --- |
| 未设置 / `auto` | 启用**凭据存在**的通道，缺凭据的记一行 `cloud_agent_channel_skipped`（`reason: credentials_missing`） |
| `none` | 只跑调度 + 投递 + API（用于纯服务形态或排障） |
| `feishu` / `wecom` / `feishu,wecom` | 契约式：缺凭据直接 **exit 2**，不静默降级 |

「auto 降级」与「显式要求」被刻意区分开：运维说「我要飞书」时静默跑成无通道是最坏的失败模式，所以显式列表 fail closed。

## 5. 生命周期

- **单实例**：`<stateDir>/instance.lock`。第二个进程拿不到锁会启动失败（exit 1），不会两个进程共用同一个调度目录。
- **优雅关闭**：SIGINT/SIGTERM → 停通道（`stop({timeoutMs})`）→ 调度器 `stop({abortActive:false})` 后 `settle()`，超时则 `cancelAll()` → 关 API → 释放锁。返回 `{drained}`。
- **退出码**：`0` 干净退出；`1` 运行时失败或 drain 未完成（有 in-flight 被强制取消 / 端口占用 / 锁冲突）；`2` 配置错误（含缺凭据的显式通道、非法端口/间隔、未知通道名）。
- **存活**：调度 tick 定时器是 `unref()` 的，所以入口额外持有一个 keep-alive interval。没有它，一个「看起来在跑」的进程可能在调度器计时器到期前就静默退出。
- **Windows 限制**：Windows 上无法从另一个进程向 Node 投递可处理的 SIGTERM（`taskkill` 是硬终止），「关窗口」也不是优雅停止。因此优雅 drain 的退出码路径由 `scripts/agt-037/entry-smoke.mjs` 在进程内调用 `stop()` 验证；系统级信号投递需在 Linux/macOS 或容器里验收（已知风险，见第 9 节）。

## 6. runId 贯穿：通道 → run → 调度触发 → 投递

AGT-037 的「全链路 Trace」只有一个要求：**同一个 `runId` 能从每个环节读出来**，不引入 OTel/span/追踪后端。

- 研究运行天然有 run-store 形态的 `runId`（`r-YYYYMMDDTHHMMSS-xxxxxx`），调度触发（`trigger.runId`）、run 记录（`run.json`）、投递记录共享它。
- **聊天回合现在也写入同一个 run store**：`src/runs/chat-runs.mjs` 把一次通道回合投影成 run 记录，`request.topic` 是固定串 `chat message`，只带 `channel`、`chatType`、脱敏 `chatIdMasked`、token 用量、回复投递结果等**加法字段**；不存消息正文、不存发送者 ID、不存原始 chat id。
- 为了让聊天 `runId` 能被 run store 寻址，`createAgentRuntime()` 接受可注入的 `generateRunId`（默认仍是 `randomUUID()`），通道运行器把它透传下去。**这没有新增存储平台，也没有第二个 id 空间**：`GET /v1/runs/<id>` 对研究与聊天 run 是同一个路由。
- 研究与聊天共用 `/v1/runs/:id` 的既有视图；研究响应字段不变（`toRunView` 对缺失字段容错），因此既有调用方无需改动。

真实链路证据的配对方式（t12 场景 A）：`npm run wecom:live` 打印的结果行里带 `runId`，紧接着 `curl /v1/runs/<同一个 runId>` 能取到记录。

**已验证（2026-11-04，真实企业微信单聊）**：统一入口以真实凭证启动（`--channels wecom`），维护者发一条单聊消息 →

```text
wecom_channel_outcome action=replied runId=r-20261103T182348-e476ad status=succeeded
  durationMs=2510 segments=1 segmentsDelivered=1 replyDelivered=true platformErrcode=0
GET /v1/runs/r-20261103T182348-e476ad → 200
  {runId:"r-20261103T182348-e476ad", status:"completed", durationMs:2510,
   request:{topic:"chat message"},
   chat:{channel:"wecom", chatType:"single", chatIdMasked:"id:2365fc21",
         usage:{inputTokens:200,outputTokens:6,totalTokens:718},
         reply:{delivered:true,segments:1,segmentsDelivered:1}}}
```

同一 `runId` 从通道结果行到 run store 到管理 API 全程一致，且聊天字段可读。原始 WeCom `userid` 从不落盘（只存 `hashId` 后的 `id:…`）。

**投影是加法的**：`toRunView()` 新增 `chat` 字段，仅当记录带 `channel` 时填充；研究 run 的 `chat` 为 `null`，既有研究字段与响应不变。

## 7. 幂等

- 调度：同一 occurrence 的 `dedupeKey`（`<scheduleId>@<scheduledFor>`）只会触发一次；重复 tick 不再触发（测试 `a second tick at the same instant fires nothing`）。
- 投递：`deliverTrigger()` 对同一个终态触发重复调用不会二次发送（`duplicate terminal callbacks stay idempotent`）。
- 通道回合：进程内按会话串行（AGT-027/036 的既有契约）；跨进程去重不在本卡范围（单实例锁已排除并发进程）。

## 8. 健康与状态

启动完成后打印一行 `cloud_agent_started`，含非敏感投影：`stateDir`、`runsDir`、`pid`、`phase`、`channels{enabled,skipped,running}`、`api{url,host,port}`、`scheduler{schedules,tickIntervalMs}`、`delivery{enabled,feishuSender}`。没有任何 token、chat id、用户 id 或消息内容。

管理 API 仍是 loopback-only（`127.0.0.1` / `::1`），`/v1/health`、`/v1/status` 只暴露既有非敏感字段。

## 9. 已知边界（不夸大）

1. **群 `@` 与企业微信主动推送**：真实观测表明群消息没有结构化 mention，只有正文前缀 `@<bot 显示名>`；且 `req_id` 限时，长任务必须「ack + 最终推送」两段式。这是 AGT-036 的修正范围，已派为独立工作项（t27）：ack 由通道层立即发（不等 runtime），最终结果用 `aibot_send_msg` 主动推送，目标只能来自已有入站会话。本卡入口无需改动即可承载该形态。
2. **调度投递到企业微信目标**：当前投递协调器只支持飞书目标（AGT-036 W1 已让 WeCom 目标被明确拒绝而不是误投）。WeCom 目标的投递接线是后续卡（t25）。
3. **真实机器人凭据**：已由维护者提供并用于第 6 节的真实单聊验证；群 `@` 仍需测试群与 `WECOM_BOT_NAME`（已配置 `Mira`）。
4. **Windows 信号投递**：见第 5 节。真实运行时的 drain 用 `scripts/agt-037/live-drain.mjs`（同一 `app.stop()`，真 WeCom 连接 + 真 API）验证：`drained:true, channels:{wecom:true}, exitCode:0`。

## 10. 验证

```bash
npm test                  # 642 tests / 642 pass（含新增 16 条 AGT-037 用例）
npm run test:app          # 仅 AGT-037 用例
node scripts/agt-037/entry-smoke.mjs   # 真实进程装配 + 真实 HTTP + 优雅停止
```

`entry-smoke.mjs` 的结果是**本地真实进程证据**：真 socket、真 run store、真调度器；被替换的只有模型调用与平台发送（无凭据时不可能也不允许打真实平台）。它不是「企业微信真实收发」的证据。
