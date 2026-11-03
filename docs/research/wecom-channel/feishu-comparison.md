# 飞书 vs 企业微信：能力矩阵、Channel Port 判断、Scheduler 投递

> 飞书一侧事实取自本仓库已交付的 AGT-029/AGT-033/AGT-035 文档与代码
> （`docs/engineering/agt-029-feishu-channel.md`、`src/channels/feishu/*`、`src/delivery/*`）。
> 企业微信一侧取自 `capabilities.md` 引用的官方文档与本机实验。访问/核对日期 2026-11-04。

## 1. 能力矩阵

| 能力 | 飞书（AGT-029 现状） | 企业微信智能机器人（本卡结论） | 差异性质 |
| --- | --- | --- | --- |
| 长连接 | ✅ 官方 SDK `@larksuiteoapi/node-sdk@1.76.0` `WSClient` | ✅ `@wecom/aibot-node-sdk@1.0.7`，`wss://openws.work.weixin.qq.com` | 同构 |
| 连接并发 | SDK 允许多实例（事件按 app 分发） | **每机器人仅 1 条**，新连接踢旧连接 | **企业微信更严**，必须主备 |
| 私聊 | ✅ p2p | ✅ `chattype=single`（注意：无 `chatid`） | 同构 |
| 群聊 @ | ✅ 依赖 `mentions[].id.open_id` 与 bot open_id 匹配；未 @ 的群消息平台不下发 | ✅ 群里 @ 机器人；**无结构化 mentions**，@ 只在 `text.content` 文本里 | **企业微信更弱**：@ 判定要解析文本 |
| 流式回复 | ⚠️ 当前 Adapter 只发文本；飞书支持卡片更新但未实现 | ✅ 原生 `stream`（全量 content，10 min，≤20480 字节） | **企业微信更强** |
| 主动推送 | ✅ `im/v1/messages` 发到 `open_id`/`chat_id`，无需前置互动 | ⚠️ `aibot_send_msg` **要求用户先给机器人发过消息** | **企业微信是硬约束** |
| 发送者 ID | `open_id`（应用内唯一），`sender_type` | `from.userid`：超管创建=明文 userid，否则**加密 open_userid** | 企业微信身份更复杂 |
| 会话 ID | `chat_id`（`oc_...`），私聊也有 | `chatid` **仅群聊**；单聊用 userid 充当 | 企业微信字段更少 |
| 消息 ID / 去重 | `header.event_id` / `message_id`；进程内 TTL 24 h、上限 2048 | `msgid`；**重投窗口官方未公布** | 同构（企业微信更缺文档） |
| 重连 | SDK 自带重连 | SDK 自带指数退避；`disconnected_event` 后**不自动重连** | 企业微信要自己补 |
| 取消 / 停止 | `/stop` → `AbortSignal`（已实现） | 协议层**无取消原语**；只能停止后续流式刷新（`finish=true`）或不再回复 | **企业微信更弱**：不能在用户侧撤回/停止已开始的生成 |
| 媒体 | ❌ 未实现 | ✅ 分片上传/下载解密（SDK 支持），但有大小与频率限制 | 企业微信更强（本轮不实现） |
| 卡片 | ❌ 按钮回调未实现 | ✅ 5 种模板卡片 + 5 s 事件响应 | 企业微信更强（本轮不实现） |
| 持久会话 | ❌ 每条消息独立 Session | ❌ 同（由 Cloud Pi 决定，不是 Channel 能力） | 同 |
| 自带 Agent Runtime | ❌（官方 SDK 不含） | ❌（官方 SDK 不含） | 同 |
| License | MIT（`@larksuiteoapi/node-sdk`） | MIT（`@wecom/aibot-node-sdk`） | 同 |
| 单条长度 | 文本上限未在本卡核实 | **20480 字节**（UTF-8） | 企业微信按字节 |
| 频控 | 99991400 可重试（已实现分类） | 30 条/分、1000 条/时（回复+主动合计） | 企业微信更严 |

**结论**：两个平台在"长连接 + 单聊/群聊 + 消息 ID 去重 + 回复"上确实同构，但在
**连接并发、@ 判定、主动推送前置条件、身份字段、取消语义、长度单位**上都有实质差异。
同构的部分已经在"两个独立 adapter + 同一个 Runtime"里被复用；差异部分无法用一个薄抽象同时表达。

## 2. 是否抽极薄 Channel Port

**判断：不抽通用 Channel Port。维持两个独立 adapter，只固定三个最小共享合同。**

理由（逐条对应证据）：

1. **抽象会漏**：`@` 判定（飞书 `mentions` vs 企业微信文本解析）、取消（飞书有 `/stop` + AbortSignal，
   企业微信无原语）、主动推送前置条件（企业微信要求先有用户消息）——这三件事没有共同形状，
   硬抽会把差异塞进 `if (channel === ...)`，比两个 adapter 更难读。
2. **连接并发模型不同**：企业微信必须主备，飞书不需要。把它抽成"Channel 连接"合同会误导部署。
3. **现有代码已经在正确的层面复用**：`createAgentRuntime().run()`（AGT-027）是唯一执行入口；
   `src/delivery/`（AGT-033）已经用 `deliveryTargets` + 每目标独立结果 + `${runId}#${type}:${id}` 幂等键
   表达"投递"，这与平台无关。再抽一层 Channel Port 只会复制这一层。
4. 与仓库边界一致：AGENTS.md 要求 "Pi first / plugin first / thin glue"，反对为架构整齐强行抽象。

**三个最小共享合同（建议 t4 ADR 固化）**：

| 合同 | 内容 | 现有落点 |
| --- | --- | --- |
| 投递目标描述 | `{ type, id, label }`，类型词表按平台扩展（W1：`wecom_user`/`wecom_chat`） | `src/scheduler/contracts.mjs` + `src/delivery/targets.mjs` |
| 投递结果 | `sent` / `failed` / `pending` + 每目标独立记录，不改研究结论 | `src/delivery/contracts.mjs` |
| 幂等键 | `${runId}#${type}:${id}` 持久化，重放不再发 | `src/delivery/store.mjs` |

> 这与 lead 已定的 t4 输入一致：`deliveryTargets` 采用 W1（扩展类型词表 +
> `SCHEDULER_CONTRACT_VERSION 1→2` 兼容读），且 deny `userid` 直接映射 Cloud Account。

## 3. 主动投递是否可作为 Scheduler 的交付通道

**结论：可以，但只能作为"已有会话"的投递通道，且必须先有真实入站消息。**

链路：`Scheduler → executeResearch() → report → WeCom destination`。

### 3.1 destination 模型

| destination | 协议字段 | 前置条件 | 来源 |
| --- | --- | --- | --- |
| `wecom_user` | `chatid = userid`，`chat_type = 1` | 该用户**曾给机器人发过消息** | 真实 `aibot_msg_callback`（`chattype=single`，`from.userid`） |
| `wecom_chat` | `chatid = 回调里的 chatid`，`chat_type = 2` | 该群内**曾有人 @ 过机器人** | 真实 `aibot_msg_callback`（`chattype=group`） |

- 两者都**不能**由报告、模型输出或手打 id 生成——与 AGT-035 的飞书 target 解析原则一致：
  target 只能来自平台自己返回的事实（入站事件 / 会话列表）。
- `[未验证]` "曾发过消息"的有效期：官方未写。建议在本地记录 `lastInboundAt`，并对
  "从未入站"的目标直接判 `not_deliverable: no_prior_inbound`，不要盲目试发。
- `[未验证]` 群聊是否也要求"该群曾有人 @ 过"（文档只说"用户先在会话中给机器人发送过消息"）。
  POC 必须各测一次。

### 3.2 长报告分段

- 单位是**字节**：`markdown.content ≤ 20480 字节`（UTF-8）。中文约 6800 字/段。
- 分段策略建议：按段落边界切，先算 `Buffer.byteLength`，保证每段 ≤ 20000 字节留余量；
  段间加"（续 N/M）"；**不要**在 UTF-8 多字节中间截断。
- 每段是一条独立 `aibot_send_msg`（`markdown`），不是流式；因此每段都受
  **30 条/分、1000 条/时** 限制。100 KB 报告 ≈ 5–6 段，远低于限流。
- 与飞书相比：企业微信没有"卡片 + 折叠长文"路径（本轮不实现卡片），长报告只能多段 markdown。

### 3.3 失败与重试

| 情况 | 建议处理 | 依据 |
| --- | --- | --- |
| 协议层 5 s 无回执 | **不要**立即重发；记录 `unknown`，等待服务端迟到回执或下次幂等检查 | `[SDK源码]` 5 s 硬编码；`[社区]` #27 证明"超时但服务端已接受"会发生 |
| `errcode != 0` 且是鉴权类（如 853000） | 终止该目标，标记 `failed: auth`，不重试 | `[实验]` 853000 |
| 频控（30/分） | 可重试，但必须退避到下一分钟窗口 | `[文档]` 62157/62158 |
| 目标无前置入站 | 终态 `not_deliverable`，提示人工先发起会话 | `[文档]` 62158 + `[社区]` #23 |
| 媒体发送 | 本轮不做；若做，先 `uploadMedia` 取 `media_id`（3 天） | `[文档]` 62159 |

**重试的总原则**：企业微信没有公布发送接口的错误码表（`[未验证]`），所以只对**明确的**
服务端拒绝（`errcode != 0` 且非鉴权）做有界重试；对"超时/无回执"按**至多一次**处理，
宁可漏投也不重复投——重复投递在 IM 里是更严重的体验事故。

### 3.4 重复投递风险

- 已有防线：AGT-033 的 `${runId}#${type}:${id}` 幂等键持久化，重放不会再发。
- 新增风险：企业微信侧"回执超时但实际已送达"。因此适配层必须在**发送前**持久化
  `attempting` 状态，发送后写 `sent/failed`；超时写 `unknown` 并**不**自动重发。
- 另一个风险：单连接被踢（新连接订阅成功）时正在发送的帧可能丢失。主备切换期间应停止新投递，
  等 `authenticated` 后再继续（`[文档]` 62156 `disconnected_event`）。

### 3.5 与 Scheduler 的接口建议（不实现，只给形状）

```jsonc
// schedule.deliveryTargets（W1）
[
  { "type": "wecom_user", "id": "<userid>", "label": "张三" },
  { "type": "wecom_chat", "id": "<chatid>", "label": "研究群" }
]
```

- `wecom_user` 的 `id` 是**明文 userid**（超管创建场景）或"已通过绑定流程解析出的 userid"；
  **不得**把 `open_userid` 直接塞进 destination 当身份（它只是加密标识，且需要自建应用转换）。
- `type` 必须显式，不允许"按 id 前缀猜平台"（飞书 `ou_`/`oc_` 有前缀，企业微信 userid/chatid 没有
  稳定前缀，猜不出来）。
