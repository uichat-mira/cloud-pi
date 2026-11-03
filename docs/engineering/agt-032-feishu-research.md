# AGT-032 · 飞书临时研究委托（`/research` → AGT-028 → 原会话回复）

> 状态（2026-11-03）：实现、T1/T2 自动化、T3 真实 `startResearch()` 回归与
> **T4 真实飞书私聊 Live 往返**均已执行；Live 研究终态为 **partial（`completed_with_errors`）**，
> 回复成功送达（见 §8）。不合并、不关 Issue、不部署。
> 被测实现：`feat/agt-032-feishu-research`，基线 `dev@fad03f8`；Live 运行 commit `03e4f89`，
> 最终 PR head SHA 见 Draft PR。
> 环境：macOS arm64，Node `v22.23.2`，`@earendil-works/pi-coding-agent@1.4.0`，
> `@earendil-works/pi-ai@1.4.0`，`@larksuiteoapi/node-sdk@1.76.0`。

## 1. 范围与结论

本卡在既有 AGT-029 飞书通道上增加一条**显式命令**入口：

```text
真实飞书消息（私聊 / 授权群 @）
  → AGT-029 Channel Adapter（路由 / 去重 / 同 chat 串行 / /stop）
  → 命令判定：只有 /research <topic> 或 /研究 <topic> 进入研究
  → AGT-032 Research Runner（独立装配，跨 chat 并发上限）
  → 现有 AGT-028 startResearch()（真实 run store / 报告 / 来源）
  → readResearchRun() 读取报告
  → 终态映射 → 有界回复原消息
```

**核心结论：没有第二套 Research 执行器、没有意图识别平台。**
普通聊天仍走 `createAgentRuntime().run()`；研究只走 AGT-028 公开入口；飞书通道不新增
Cloud Account、私有观澜、模型密钥或任何 MCP/工具权限。

对应 Issue #14 Scope 1–7：

| Scope | 落点 |
| --- | --- |
| 1 显式命令合同 | `channel.mjs:parseResearchCommand()`；仅首个 token 精确匹配 |
| 2 调用现有 `startResearch()` | `runtime.mjs:createFeishuResearchRunner()`；未复制 execute/tool/store/report |
| 3 授权边界沿用 AGT-029 | 命令判定在 `decideFeishuRoute()`、sender/text/dedupe 之后 |
| 4 可取消 chat→run 关联 | channel 每 chat 的 `AbortController` 直接传给研究执行 |
| 5 终态→回复映射 | `buildResearchReply()`；五态互不混淆 |
| 6 长度上限与降级 | `MAX_RESEARCH_REPLY_CHARS=1800` 码点；截断不改 run 状态 |
| 7 安全边界 | 仅 AGT-028 默认 Research 工具层；无账户/MCP/密钥能力 |

## 2. 命令合同

- 支持 `/research <topic>` 与等价中文 `/研究 <topic>`（大小写不敏感：`/RESEARCH` 也可）。
- **只有消息首个 token 精确等于命令**才算研究：后面必须是空白或消息结束。
  - 是命令：`/research AI Agent 工程进展`、`/研究 48 小时 AI 新闻`
  - 不是命令：`research AI`、`please /research AI`、`/researchfoo`、`/研究主题`
    （这些继续走普通聊天，不会触发高成本研究）
- 空 topic（`/research`、`/research   `）只回复用法，不创建 run、不调用模型。
- 纯文本、`/stop`、`/cancel`、`停止`、`取消` 语义保持不变。

命令判定发生在路由、sender、消息类型、去重之后，因此以下情况不会产生 research run：
未授权群、授权群未 @bot、非 `user` sender、非文本消息、重复投递。

## 3. 终态 → 回复映射

| 真实 research status | outcome.status | 回复开头 | 说明 |
| --- | --- | --- | --- |
| `completed` | `succeeded` | `研究完成 · run <id>` | 附报告正文的有界版本 |
| `completed_with_errors` | `partial` | `研究部分完成（部分来源或工具失败） · run <id>` | 永不伪装成“研究完成” |
| `failed` | `failed` | `研究失败（<error_code>） · run <id>` | 仅错误码，无栈/凭证/正文 |
| `cancelled` | `cancelled` | `研究已取消 · run <id>` | `/stop` 场景由 stop 回复代替，且不再发成功结果 |
| `timeout` | `timeout` | `研究超时 · run <id>` | 研究预算到期 |
| 未知/缺失 | `failed` | `研究失败（unknown）` | fail closed，不猜成功 |

- `runId` 固定在回复头部，任何截断都不会丢失。
- 部分完成、失败、取消、超时四种文案互不相同（T1 单测逐个断言且断言集合大小）。
- 报告读取失败（`readResearchRun` 抛错）只会降级为“报告读取失败”提示，
  **不会**把 run 改写成 failed；回复发送失败同样只影响 `replyDelivered`。

## 4. 长度上限与降级

- 硬上限 `MAX_RESEARCH_REPLY_CHARS = 1800` 个 Unicode 码点（含 run id 行）。
- 超出时截断正文并追加“报告已截断，完整内容见运行记录”，只截正文，不截 run id。
- 截断发生在回复构建层，run 记录、报告、来源均已由 AGT-028 持久化，不因回复长度失败。
- 极小的自定义 `maxChars` 也保证 run id 保留（T1 断言 240 码点场景）。

## 5. 运行时装配与并发

```text
createFeishuAgentRunner()     聊天：1 个 createAgentRuntime()，无工具，临时 cwd
createFeishuResearchRunner()  研究：惰性 loadAgentRuntimePort()，每次 startResearch()
```

- 两条路径独立装配：研究 runtime 未就绪时只影响 `/research`，不阻断普通聊天。
- 研究 runner 只调用 `startResearch({ topic })` + `readResearchRun(runId)`；
  `request` 仅含 `topic`，不携带 chat id/群 id/发送者身份，避免把会话身份塞进研究请求。
- deps 不注入 `allowedTools`/`customTools`/`mcp`/账户信息；工具层沿用 AGT-028 默认实现。
- 跨 chat 并发上限 `FEISHU_RESEARCH_MAX_CONCURRENT`（默认 1，硬上限 4）：
  超限的运行排队等待；排队期间被 `/stop` 的运行直接取消且**不会**启动。
- 同一 chat 仍由 channel 队列串行；`/stop` 只 abort 当前 chat 的 signal，其它 chat 不受影响。
- `AbortSignal` 始终传入 `startResearch` 的 `deps.signal`，executor 落库为真实 `cancelled`
  （`errors[].code=aborted`），随后 channel 不再发送成功结果。

## 6. 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `FEISHU_RESEARCH_MAX_CONCURRENT` | `1` | 跨 chat 同时运行的研究数；>4 截断为 4，非法值启动失败 |
| `RESEARCH_RUNS_DIR` | `.work/research-runs` | run 产物根（沿用 AGT-028，不在本卡写死） |
| `RESEARCH_AGENT_RUNTIME_MODULE` | 自动发现 AGT-027 | 研究 runtime 模块（沿用 AGT-028） |

`FEISHU_*` 应用凭证、群 allowlist 语义未改动；研究不可用不影响聊天启动。

## 7. 自动化证据（本机真实执行）

命令与结果：

```text
$ cd .work/agt-032 && node --test tests/agt-032-*.test.mjs
# tests 39
# suites 9
# pass 39
# fail 0

$ cd .work/agt-032 && npm test
# tests 438
# suites 65
# pass 438
# fail 0
```

（`dev@fad03f8` 基线为 399 tests pass；本卡新增 39 条，未破坏 AGT-027/028/029/030。）

| 文件 | 覆盖 |
| --- | --- |
| `tests/agt-032-channel.test.mjs` | 命令解析边界（空 topic / 非命令 / 中文命令 / 全角空格）、普通聊天不被误判、私聊与群 @ 路由、未授权群/未 @/非 user/重复投递、五态映射互不混淆、失败回复不泄漏栈/凭证、长度降级与 run id 保留、`/stop` 取消与不再发成功结果、跨 chat 隔离、同 chat 串行、不同 chat 并发、reply 失败不改状态、未装配 runner 时 fail closed |
| `tests/agt-032-runner.test.mjs` | `startResearch` 仅调用一次且 `request={topic}`、deps 无 allowedTools/MCP/account、`AbortSignal` 传播与预先取消、报告读取失败不改状态、runtime 未就绪 fail closed（`runtime_unavailable`）、跨 chat 并发上限与排队取消、上限钳制、dispose 后 fail closed |
| `tests/agt-032-service.test.mjs` | service 把 `/research` 接到独立 research runner，聊天仍走 agent；stop 依次 dispose |
| `tests/agt-032-live-path.test.mjs` | **T3**：真实 `startResearch()` + 真实 run store + 假 Feishu reply 的 completed / completed_with_errors / cancelled / reply-failure / 跨 chat 排队 + `/stop` 集成 |

T3 只把模型与网络边界替换为确定性 fixture（AGT-027 port + research tool layer），
`startResearch`、executor、报告/来源生成、run store、`readResearchRun` 均为真实代码。

## 8. T4 Live（真实飞书私聊）— 已执行，研究终态 partial

执行时间：2026-11-03 16:27–16:32（Asia/Shanghai，UTC 08:27–08:32）。
环境：真实飞书长连接（`@larksuiteoapi/node-sdk@1.76.0` WSClient）+ 真实 AGT-027 聊天/研究 runtime
+ 真实 AGT-028 工具层与 run store；应用 `cli_aa…dc0e`，bot `ou_57b…2a00`，
`allowedChatCount=1`，`botOpenIdResolved=true`。运行前确认无其它通道进程占用同一 app。
Live 运行 commit `03e4f89`（驱动脚本修复仅影响证据元数据，不在研究执行路径上）。

真人从飞书私聊发送一条 `/research <短话题>` 后：

| 项 | 值 |
| --- | --- |
| run id | `r-20261103T083122-a94e86` |
| 持久化终态 | `completed_with_errors`（partial） |
| 状态历史 | `running → completed_with_errors` |
| 耗时 | `68198 ms`（研究 runtime `68192 ms`） |
| 回复 | **已送达原消息**（`replyDelivered=true`，reply `om_x10…e4bc`） |
| 来源 | `46` 条；报告 `7878` 字符；工具调用 `15`（search 6 / page 9），预算拒绝 1 |
| 模型用量 | `deepseek-v4.1-flash-od` / `mira-ai`，23831 in / 6185 out / 127936 total |
| masked ids | event `88b940…d09e`，message `om_x10…ee3c`，chat `oc_3d5…a9b6` |

partial 的真实原因（run.json `errors[]`，非通道失败）：
`model_error/citations`（11 条引用未读、0 unknown）、2 个来源 HTTP 403、
2 次 `research_read_page` 工具失败、1 次 search 因 run 预算耗尽被拒绝。
因此该 run 被 AGT-028 正确判为 `completed_with_errors`，飞书侧按合同回复
“研究部分完成（部分来源或工具失败）”，**没有**伪装成 `研究完成`。

证据（脱敏，已提交）：`poc/evidence/agt-032-live.jsonl`

- 原始条目 `result.ok=false, reason=research_not_completed`：驱动脚本的严格 PASS 判据是
  `persistedStatus=completed`；本次研究是 partial，所以该判据为 false，
  **不代表**通道/run/reply 失败（`roundtrip=verified`，回复已送达）。
- `run_readback` 条目记录真实 run 状态、耗时、sources、usage、工具计数与错误码；
- `metadata_correction` 条目修正 `session_start.commit=null`：linked worktree 的
  `refs/heads/*` 位于 common git dir，旧 `gitHead()` 只读 worktree git dir；
  驱动已修复并支持 `--print-metadata`，用同一运行 HEAD 复核为 `03e4f89`。
- 证据不含消息正文/topic、App Secret、token、模型 Key 或完整飞书 id。

复现命令（需真人从飞书发消息）：

```bash
node --env-file-if-exists=.env scripts/agt-032/research-live-evidence.mjs \
  --chat-type p2p --timeout-ms 900000
```

仍未执行的 Live 场景：授权群 @bot 的 `/research`（自动化 T1/T2 已覆盖路由与回复）。

## 9. 未证明 / 已知限制

- 真实飞书授权群 @ 的 `/research` 往返：**未执行**（私聊已通过；群路径自动化覆盖）。
- 真实研究“完整成功（`completed`）”的 Live 样本：本次为 partial，尚无全绿样本。
- 真实飞书文本消息长度上限未实测；本卡用 1800 码点主动限流，不依赖平台上限。
- 长研究（分钟级）期间的用户体验、飞书 reply 窗口与网络重连：仅有自动化取消/排队证据。
- `/stop` 在真实飞书长任务中的时序（回复后立即取消 vs 取消后回复）仅 T2/T3 覆盖。
- 未做 Cloud Account 身份映射、私有观澜委托、Scheduler 主动投递、部署与管理员配置变更。
