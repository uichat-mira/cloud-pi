# AGT-029 · 飞书双向通道 POC（Pi SDK / Cloud Pi Runtime）

> 状态（2026-11-03）：本地实现、T1/T2/T3 离线回归已通过；真实飞书 Live POC 见
> [agt-029-live-evidence.md](agt-029-live-evidence.md)。本文不把“代码可运行”写成“Live 已通过”。

## 1. 范围与结论

本卡只验证一条单轮链路：

```text
真实飞书消息
  → 飞书长连接（WebSocket）事件
  → Cloud Pi Channel Adapter（授权 / 去重 / 取消）
  → createAgentRuntime().run()（真实 Pi SDK Session + 真实模型）
  → 飞书回复原消息
```

不做持久会话、Cloud Auth 身份、群成员资格核验、调度、多目标投递、私有 MCP 或生产部署。

**核心结论：不引入第二套 Agent Runtime。** Channel Adapter 只负责飞书事件与路由；
Agent 执行唯一入口仍是 `src/runtime.mjs:createAgentRuntime().run()`。

## 2. 候选插件结论：`ax-feishu-bridge@0.4.9`

调查基于 npm tarball 与仓库源码（`gitHead af56acb`），不是 README 声明。

| 项 | 结论 |
| --- | --- |
| 版本 / 许可证 | `0.4.9`；`package.json` 声明 MIT，但 tarball 与仓库根目录**没有 LICENSE 文件** |
| 模块形态 | ESM-only；engines `^22.19.0 \|\| >=24.0.0` |
| 公开导出 | 仅 `./pi`、`./harness`、`./cordis.patch.yml` |
| `./pi` 可用性 | 指向 `src/adapters/pi/index.ts`；Node 22.23.2 从 `node_modules` 导入报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |
| 深层导入 | `exports` 禁止 `lib/feishu/transport.js` 等子路径（`ERR_PACKAGE_PATH_NOT_EXPORTED`） |
| 硬耦合 | 传输层内部读取 `~/.pi/agent/feishu`（配置、debug 日志、去重文件）；Pi adapter 会 spawn daemon 并创建 `PiConversationRuntime` |
| 依赖代价 | 安装会拉入 196 个包 / 约 233 MB，包括 `pi-coding-agent@1.5.0`、DSH 全家桶与 `sharp → libvips`（LGPL-3.0-or-later，非 GPL/AGPL） |

**判定：不能在不带入平行 Agent Runtime 的前提下薄复用。**

- 传输类 `FeishuTransport` 未导出；即使深层导入也违反包边界，且会读写 `~/.pi`。
- `./pi` 本身就是 Pi extension：构造 `PiConversationRuntime`、daemon、gateway lock。
- `./harness` 是 Cordis/DSH 插件，构造 `HarnessConversationRuntime`，同样是第二套运行时。
- 其内部 `src/feishu/*` 分层确实清晰，但只能 fork/vendor 10 个文件并改路径，属于“复制插件”，本卡不采用。

**采用路径：** 直接使用官方 MIT `@larksuiteoapi/node-sdk@1.76.0` 的长连接 `WSClient` +
`EventDispatcher`，自己实现最薄 transport。该 SDK 只有 7 个直接依赖，不包含任何 Agent Runtime。
它提供 WS 自动重连、事件分发、`im/v1/messages/:id/reply` 与 `bot/v3/info`；群 @、去重、
停止语义由本仓库 Channel Adapter 明确实现并可测试。

## 3. 模块与边界

```text
src/channels/feishu/
  config.mjs    环境配置校验（app id/secret/allowlist）；只输出安全摘要
  events.mjs    raw webhook / SDK flattened event → 可信字段；@ key 剥离
  policy.mjs    p2p / 授权群 @ / 未授权群 / 未 @ 的路由判定（fail closed）
  dedupe.mjs    进程内 TTL + 上限的事件去重
  channel.mjs   路由 → 去重 → 单轮运行 → 回复；/stop → AbortSignal
  runtime.mjs   唯一的 createAgentRuntime() 装配；无工具；临时 cwd
  transport.mjs 官方 SDK 薄封装：WS、bot open_id、reply
  service.mjs   组装并暴露启动/停止
  server.mjs    常驻进程入口（JSONL 日志）
```

- `channel.mjs` 不 import 网络或 Pi SDK，可用假 `runTurn` / `reply` 做 T1/T2。
- `runtime.mjs` 每次 `run()` 由 AGT-027 建立独立 Session；不跨消息保留历史。
- 会话 cwd 是私有临时目录，仓库 `AGENTS.md`、`notes/` 和其他本地文件不会进入模型上下文。
- `allowedTools` / `exposedTools` / `customTools` 全为空：飞书消息无法触发任何本地或 MCP 工具。

## 4. 授权与安全（fail closed）

| 场景 | 行为 |
| --- | --- |
| 私聊 | 允许进入 POC |
| `FEISHU_ALLOWED_CHAT_IDS` 内群 + 明确 @bot | 允许 |
| 授权群未 @ | 忽略，不调用 Runtime |
| 未授权群（即使 @） | 忽略，不调用 Runtime |
| bot open_id 未验证 | 群消息忽略（无法证明 @ 的是 bot） |
| 非 user sender / 非文本 / 空文本 | 忽略 |
| 群成员身份 | **不**映射为 Cloud Account / Guanlan / 管理权限；本卡不实现成员核验 |

- 群授权是本地可信 POC 配置，不是 Cloud Auth 授权。
- 模型文本不能改变上述判定；判定发生在模型调用之前，且模型没有工具。
- 固定 channel system prompt 说明“无工具、无授权”，但安全不依赖模型自觉。
- 日志与证据只记录脱敏消息 id、run id、状态、模型、耗时；不记录正文、secret、token。

## 5. 去重与取消

**去重**

- key 优先 `event:${header.event_id}`，缺失时回退 `message:${message_id}`；两者都缺失则忽略。
- key 在任何异步 run 开始前**同步**预留；并发重投只产生一个 run。
- 进程内 TTL 24h、上限 2048；重启或多实例共享投递不在本卡范围（见缺口）。

**取消 / 停止**

- 命令：`/stop`、`/cancel`、`停止`、`取消`（文本精确匹配）。
- `/stop` 立即 abort 当前 chat 的 `AbortController`；AGT-027 将信号传入 Pi Session 与工具执行。
- 同一 chat 的运行串行队列；`/stop` 会递增 epoch，停止前已排队的消息不会再执行。
- 被 /stop 中止的 run 不再发送第二条错误/结果消息；只有 `/stop` 自己回复一次。
- 没有活动运行时的 `/stop` 回复“当前没有正在运行的任务”，不调用 Runtime。

## 6. 配置

凭证只由宿主环境注入，禁止写入 `.env` 提交、Issue/PR、提示词、工具参数或日志。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 是 | `cli_...`；允许的现有飞书应用，不新建机器人 |
| `FEISHU_APP_SECRET` | 是 | 仅进程环境；不打印 |
| `FEISHU_ALLOWED_CHAT_IDS` | 否 | 逗号/空格分隔的 `oc_...`；空 = 只允许私聊 |
| `FEISHU_BOT_OPEN_ID` | 否 | `ou_...`；缺省时启动调用 `/open-apis/bot/v3/info` 获取 |
| `FEISHU_DOMAIN` | 否 | `feishu`（默认）或 `lark` |

飞书应用侧需要：机器人能力、`im.message.receive_v1` 事件、事件投递方式为**长连接**、
发送消息权限（至少 `im:message:send_as_bot`）。群 @ 依赖 `mentions[].id.open_id` 与 bot
open_id 匹配；未开启“获取群组中所有消息”时，未 @ 的群消息不会到达，这是平台过滤，
不是本适配器漏判。

## 7. 命令与本地验证

```bash
npm ci
npm run test:feishu        # AGT-029 T1/T2/T3 离线回归（无网络、无 Key）
npm test                   # 全仓回归

# 常驻通道（凭证按进程注入，不要写进仓库）
FEISHU_APP_ID=cli_... FEISHU_APP_SECRET=... \
FEISHU_ALLOWED_CHAT_IDS=oc_... npm run channel:feishu

# 一次性 Live POC，等待一条匹配事件后写脱敏证据
FEISHU_APP_ID=cli_... FEISHU_APP_SECRET=... npm run feishu:live
```

`npm run feishu:live` 支持 `--expect reply|ignored:<reason>`、`--chat-type p2p|group`、
`--timeout-ms`、`--evidence`。脚本不能伪造入站消息：必须由真人在飞书发送。

## 8. 验证矩阵（离线部分）

| 卡片 | 证据 |
| --- | --- |
| T1 配置 / 路由 / 事件 / 去重 | `tests/agt-029-config.test.mjs`、`events`、`policy`、`dedupe`：23 项 |
| T2 Adapter → Runtime 调用边界、AbortSignal、错误回复、负例 | `tests/agt-029-channel.test.mjs`：15 项；`tests/agt-029-service.test.mjs`：2 项 |
| T3 真实 `createAgentRuntime().run()` + Pi faux 管线 | `tests/agt-029-runtime.test.mjs`：5 项 |
| 全仓回归 | `npm test`：362 项通过，0 失败（含 P0/AGT-027/AGT-028） |

T3 的 faux 模型只替代模型边界，Session 组装、extension、工具权限门、取消与错误分类均为
生产代码；它不是真实模型调用，真实调用证据单独记录。

## 9. 已知缺口（不在本卡扩张）

1. 不保留跨消息会话/历史；每条消息独立 Session。
2. 不核验群成员资格，也不把飞书身份映射到 Cloud Account / Guanlan consumer。
3. 去重只在单进程内；多实例或重启后的共享幂等需要持久化去重存储。
4. 仅文本消息；图片/富文本/卡片、文件与 reaction 未实现。
5. 回复没有应用级重试；依赖 SDK 连接重连，投递失败只记录 outcome。
6. 卡片按钮回调（webhook/card action）未实现。
7. `FEISHU_ALLOWED_CHAT_IDS` 是 POC 本地允许列表，不是 Cloud Auth 正式群授权管理。
8. 群聊不读取非 @ 消息作为上下文（隐私边界待产品另行决定）。
