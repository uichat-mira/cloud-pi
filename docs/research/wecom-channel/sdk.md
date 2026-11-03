# 官方 Node SDK 事实清单（`@wecom/aibot-node-sdk`）

> 核对时间 2026-11-04。结论只基于 npm 实际发布物、仓库源码与本机运行结果，**不依据 README 声明**。

## 1. 发布物与仓库

| 项 | 值 | 证据 |
| --- | --- | --- |
| 包名 | `@wecom/aibot-node-sdk` | `[文档]` 62154；`[实验]` npm |
| npm latest | **1.0.7**（`dist-tags`: latest 1.0.7 / beta 1.0.7-beta.0；共 26 个版本 1.0.0→1.0.7） | `[实验]` `npm view` |
| 发布时间 | 首版 `1.0.0` 2026-03-07；最近发布 2026-05-12 | `[实验]` npm `time` |
| License | **MIT**（package.json + npm `license`） | `[SDK源码]`；注意 GitHub API `license` 为空，社区已就此提问（Issue #30） |
| 仓库 | https://github.com/WecomTeam/aibot-node-sdk | `[文档]` 62154 |
| 仓库 HEAD（抓取） | `80615b9`，仅 **9 个提交**，`main` | `[实验]` `git ls-remote` / `git log` |
| 仓库活跃度 | 117 stars / 18 forks / **25 open issues**；最近 push 2026-04-07 | `[实验]` GitHub API |
| 版本漂移 | 仓库 `package.json` 是 `1.0.6`，npm 已发 `1.0.7`；**源码与发布物不完全对应** | `[实验]` 对比两者 |
| 依赖 | `axios ^1.6.7`、`eventemitter3 ^5.0.1`、`ws ^8.16.0`；全新安装共 30 个包 | `[SDK源码]` + `[实验]` |
| `engines` | **未声明** | `[SDK源码]` |
| 模块入口 | `main: dist/index.cjs.js`、`module: dist/index.esm.js`、`types: dist/index.d.ts`；**无 `exports` 字段** | `[SDK源码]` |
| Node 24 | 实测可用（CJS/ESM/类型全部通过） | `[实验]` |
| Node 22 | **未实测**（本机只装 Node 24.9.0）；无 engines 约束 | `[未验证]` |

> 无 `exports` 字段意味着这是「main/module 双入口」的老式双包，不是条件导出。
> Node 的 CJS/ESM 各自解析不同文件，会出现**双实例**（同一进程 `instanceof` 不成立、
> 枚举/常量各一份）。Channel 适配器应固定用一种模块系统（本仓库是 `.mjs`，用 ESM 入口）。

## 2. 生命周期（源码事实）

| 项 | 值 | 位置 |
| --- | --- | --- |
| 端点 | `wss://openws.work.weixin.qq.com`（可用 `wsUrl` 覆盖） | `src/ws.ts:7` |
| 订阅 | `{cmd:'aibot_subscribe', headers:{req_id}, body:{bot_id, secret, scene?, plug_version?}}` | `src/types/api.ts` `WsCmd` + `ws.ts` |
| 心跳 | 默认 30 s（`heartbeatInterval`）；连续 **2** 次无 pong 判定连接失效 | `client.ts:50`、`ws.ts:47` |
| 重连 | 指数退避 1 s→2 s→…→30 s 上限；`maxReconnectAttempts` 默认 **10**，`-1` 无限 | `ws.ts:49-51`、`client.ts:47-48` |
| 认证失败重试 | `maxAuthFailureAttempts` 默认 **5**，`-1` 无限；超限抛 `Max auth failure attempts exceeded` | `client.ts:48`；`[实验]` 复现 |
| 回执超时 | **硬编码 5000 ms**，不可配置 | `ws.ts:67` |
| 回复队列 | 同一 `req_id` 串行发送；单 `req_id` 队列上限 **500**（`maxReplyQueueSize`） | `ws.ts:69`、`client.ts:54` |
| 请求超时 | `requestTimeout` 默认 10 s（仅 HTTP 侧，如文件下载） | `client.ts:51` |
| 被踢下线 | 收到 `disconnected_event` 后 SDK **不自动重连**，需业务决定 | `client.ts:110-115`；`[文档]` 62156 |
| 手动断开 | `disconnect()` 置 `isManualClose`、停心跳、清 pending、terminate socket | `ws.ts:614-630` |

## 3. 公开 API（实现时可直接依赖）

`new WSClient(options)`；`connect()` / `disconnect()`；`isConnected`；`api`（仅文件下载）。

| 方法 | 用途 |
| --- | --- |
| `reply(frame, body, cmd?)` | 通用回帧 |
| `replyStream(frame, streamId, content, finish?, msgItem?, feedback?)` | 流式回复（Markdown，`content` 全量） |
| `replyStreamNonBlocking(...)` | 上一条同 `req_id` 未回执时跳过中间帧，返回 `'skipped'` |
| `replyWelcome(frame, body)` | 欢迎语（事件 5 s 内） |
| `replyTemplateCard` / `replyStreamWithCard` / `updateTemplateCard` | 模板卡片 |
| `sendMessage(chatid, body)` | **主动推送**（`aibot_send_msg`） |
| `uploadMedia(buffer, {type, filename})` | 三步分片上传临时素材 |
| `replyMedia` / `sendMediaMessage` | 用 `media_id` 回复/主动发媒体 |
| `downloadFile(url, aesKey?)` | 下载并 AES-256-CBC 解密回调中的媒体 |

事件：`connected` / `authenticated` / `disconnected` / `reconnecting` / `error` / `message` /
`message.{text,image,mixed,voice,file,video}` / `event` / `event.{enter_chat,template_card_event,
feedback_event,disconnected_event}`。`client.ts:96-127`、`message-handler.ts:57-106`。

## 4. 本机实验（2026-11-04，Node v24.9.0，SDK 1.0.7，无真实凭证）

实验目录在仓库外临时目录，未修改产品代码。

| 实验 | 命令 | 结果 |
| --- | --- | --- |
| CJS 构造/导出/事件/方法面 | `node smoke-cjs.cjs` | **12/12 通过**，exit 0 |
| ESM 导入/构造/枚举 | `node smoke-esm.mjs` | **5/5 通过**，exit 0 |
| TypeScript 严格类型 | `npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext types-check.ts` | **0 error**（`WSClient`、`WsFrame`、`MessageType`、`ReplyMsgItem` 等类型均可用） |
| 真实端点握手（占位凭证） | `node lifecycle-probe.mjs` | `connected` 155 ms → `errcode 853000` 认证失败 → 重连 2 次 → 关闭 |
| 旧文档端点（占位凭证） | 同上，`wsUrl=wss://open.work.weixin.qq.com/ws/aibot` | WS 握手 `HTTP 404` |

CJS smoke 覆盖：默认/命名导出、`WsCmd`/`MessageType` 枚举值、`generateReqId` 唯一性、
无凭证构造、EventEmitter 订阅、README 方法表逐个存在性、`disconnect()` 空连接幂等。

> **没有**做的事：真实 `authenticate`、真实收发、真实流式、真实媒体上传。原因是没有 BotID/Secret，
> 不是被 SDK 阻塞。任何"Live 已通过"的说法都不成立（见 `poc-card.md` §Live 缺口）。

## 5. SDK 与平台文档的已知不一致（会直接变成 t4 的坑）

| # | 不一致 | 影响 | 证据 |
| --- | --- | --- | --- |
| 1 | 文档 62157 的流式消息**未列** `msg_item`（图片混排）；SDK 的 `replyStream` 带 `msgItem` 参数并会在 `finish=true` 时发送 | 按 SDK 传了可能被服务端忽略/报错；社区 Issue #26 明确"不支持 msg_item" | `[文档]` 62157 vs `[SDK源码]` `client.ts`；`[社区]` #26 |
| 2 | 文档要求分片 ≤4 MB、单文件 ≤20 MB（图 10 MB、语音 2 MB、视频 10 MB）；SDK 硬编码分片 **512 KB**、上限 **100 片 ≈50 MB** | SDK 允许的超大文件到服务端才失败；错误信息误导 | `[文档]` 62159 vs `[SDK源码]` `client.ts:369-374` |
| 3 | 文档 `aibot_send_msg` 支持 `chat_type`（1 单聊 / 2 群聊）；SDK `sendMessage(chatid, body)` 的 body 类型**不含** `chat_type`，只发 `{chatid, ...body}` | 单聊主动推送可能被服务端按"群聊优先"推断（文档：0/缺省优先按群聊处理） | `[文档]` 62158 vs `[SDK源码]` `client.ts:347-352`、`types/api.ts` |
| 4 | 回执超时 5 s 硬编码，而大文件分片回执在负载下可能 6–8 s 才到 | 成功分片被当超时重试，最终上传失败 | `[社区]` Issue #27（含复现步骤与 15 s 修复建议，PR #28 未合并） |
| 5 | `axios` 侧不读 `HTTPS_PROXY`/`NO_PROXY` 环境变量 | 需代理才能下载媒体文件的环境会静默失败 | `[社区]` Issue #12；`[SDK源码]` `api.ts` 无 proxy 配置 |
| 6 | 无 `chat_type`、无 `mentions` 结构、无群成员查询 | 群 @ 判定与"@ 了谁"只能从文本里解析 | `[SDK源码]` `types/message.ts` 无 mentions 字段；`[社区]` #9 |

## 6. 采用判断

- **可以薄复用**：SDK 只有连接/协议/媒体工具，不含任何 Agent Runtime 或状态机；依赖 3 个、可审计。
  与飞书侧"官方 MIT SDK + 最薄 transport"的做法一致。
- **但必须自建 3 层胶水**（不能直接拿 SDK 当 Channel）：
  1. 事件 → 可信字段（去 `@名称`、判群/单聊、判是否 @ 本机器人）；
  2. 去重（`msgid`）+ 路由 + 取消；
  3. 主动推送的 `chat_type` 兜底（必要时绕过 `sendMessage` 直接发原始帧）。
- **版本要钉死**：仓库与 npm 漂移、5 s 回执超时、`msg_item` 分歧都说明不能浮动版本；
  `package.json` 用精确版本 `"@wecom/aibot-node-sdk": "1.0.7"`。
- **升级策略**：升级前必须重跑"流式 + 长文本 + 媒体"三项 Live，因为 1.0.x 的兼容性没有声明。
