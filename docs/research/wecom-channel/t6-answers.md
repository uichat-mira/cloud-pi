# 给 t6 / pi-dev 的六项答复

> 直接回答 lead 转达的 t6 六个问题。每项给"实现取值"与证据标签；不确定的一律写 `[未验证]`，
> 不要用估计值填坑。

## 1. 连接模式

**取值：WebSocket 长连接。**

| 项 | 值 |
| --- | --- |
| 端点 | `wss://openws.work.weixin.qq.com` |
| 订阅 | 首帧 `{"cmd":"aibot_subscribe","headers":{"req_id":"..."},"body":{"bot_id":"...","secret":"..."}}` |
| 成功判定 | 回执 `{"headers":{"req_id":"..."},"errcode":0,"errmsg":"ok"}` |
| 心跳 | `{"cmd":"ping","headers":{"req_id":"..."}}`，间隔 **30 s**（官方建议值） |
| 连接数 | **每机器人同时仅 1 条**；新连接订阅成功即踢掉旧连接，旧连接收到 `disconnected_event` |
| 并发部署 | 必须主备，不能两个进程同时连；`disconnected_event` 后旧实例应停止接单 |
| 断线重连 | 由应用实现：指数退避（1s→2s→…→30s 上限），需要上限与抖动 |
| 公网要求 | **无**（无需公网 IP / 域名 / 备案） |

证据：`[文档]` 62154、62131、62132；`[SDK源码]` `src/ws.ts`；`[实验]` 本机握手 155 ms + `853000`。

## 2. ACK 超时值

要区分**协议层回执**与**业务层时限**，两者不是一回事：

| 层 | 超时 | 说明 | 证据 |
| --- | --- | --- | --- |
| 协议层：每帧回执 | **5 s** | SDK 硬编码 `replyAckTimeout = 5000`，**不可配置**；超时抛 `Reply ack timeout (5000ms)`，之后的迟到成功回执会被当未知帧 | `[SDK源码]` `ws.ts:67`；`[社区]` #27 实测分片回执 6–8 s 才到导致误重试 |
| 业务层：欢迎语 | 5 s | `enter_chat` 后 5 s 内必须发 `aibot_respond_welcome_msg` | `[文档]` 62157 |
| 业务层：卡片事件 | 5 s | 卡片点击后 5 s 内响应，否则断连并丢弃事件 | `[文档]` 62156 |
| 业务层：消息回复窗口 | **24 h** | 收到 `aibot_msg_callback` 后 24 h 内可向该会话回复 | `[文档]` 62157 |
| 业务层：流式总时长 | **10 min** | 首帧 `stream.id` 起 10 min 内必须 `finish=true`，否则自动结束 | `[文档]` 62157 |
| URL 回调异步回复 | 1 h / 一次 | `response_url` 只能调用一次 | `[文档]` 62166 |

**实现建议**：ACK 等待按 5 s 设计（不要假设可调），但**不要**用 5 s 去预算"整个 Agent 生成"——
业务窗口是 24 h / 10 min。若 t6 需要发送媒体，必须接受"5 s 回执可能超时"的现实，并避免把超时
直接当失败重试（参考 #27 的教训：重试会造成重复分片）。

## 3. 事件重投窗口

**结论：官方未公布。** `[文档]` 62155 只写 `msgid` 是"本次回调的唯一性标志，用于事件排重
（**可能因网络等原因重复回调**）"。

- 重投次数、时间窗口、是否有上限：`[未验证]`。
- 工程取值（与飞书侧对齐）：以 `msgid` 为幂等 key，**同步预留 → 再异步执行**；进程内 TTL **24 h**、
  上限 2048；重启/多实例需要持久化去重（飞书侧当前也只有进程内，见 AGT-029 §9）。
- 不要假设"不会重投"，也不要把 5 s 无响应当成会重投（URL 回调下 5 s 无响应是**丢弃**事件，
  不是重投，`[文档]` 62156）。

## 4. 单条消息长度单位

**单位是字节（UTF-8），不是字符/码点。**

| 字段 | 上限 | 证据 |
| --- | --- | --- |
| 流式 `stream.content` | **20480 字节** | `[文档]` 62157 |
| 主动推送 `markdown.content` | **20480 字节** | `[文档]` 62158 |
| `filename` / `req_id` / `feedback.id` | 256 字节 | `[文档]` 62159 / 62157 |
| 视频 title / description | 64 / 512 字节 | `[SDK源码]` `types/api.ts` 注释；`[文档]` 62158 只写"不超过 64/512 字节" |

**实现要求**：分段必须用 `Buffer.byteLength(str, 'utf8')`，不能 `str.length`。中文 3 字节/字，
20480 字节约等于 6800 个汉字——长报告必须分段（见 `feishu-comparison.md` §5）。

## 5. destination 命名

**协议层字段（企业微信侧）**：

| 用途 | 字段 | 取值 |
| --- | --- | --- |
| 主动推送目标 | `body.chatid` | **单聊 = 用户 userid；群聊 = 回调里的 chatid** |
| 主动推送类型 | `body.chat_type` | `1` 单聊 / `2` 群聊（文档：0/缺省**优先按群聊处理**） |
| 回复（非主动） | 不用 `chatid` | 用回调里的 `headers.req_id` 透传 |

证据：`[文档]` 62158 / 62157。

**Cloud Pi 侧建议（W1，供 t4 ADR 落地）**：

```jsonc
// deliveryTargets 条目（示例形状，最终以 ADR 为准）
{ "type": "wecom_user", "id": "<userid>",  "label": "张三" }   // 单聊 → chatid=userid, chat_type=1
{ "type": "wecom_chat", "id": "<chatid>",  "label": "研究群" }   // 群聊 → chatid=chatid,  chat_type=2
```

**必须注意的 SDK 缺陷**：`WSClient.sendMessage(chatid, body)` 只发 `{chatid, ...body}`，
body 类型里**没有 `chat_type`**（`[SDK源码]` `client.ts:347-352`、`types/api.ts`）。
所以 W1 的 `wecom_user` 目标**不能直接用 SDK 的 `sendMessage`**——要么按协议自己拼
`aibot_send_msg` 帧（SDK 的 `wsManager.sendReply` 未导出，需在适配层用 `reply()` 或补丁），
要么向上游提补丁。这一点必须在 t4/t6 的实现说明里显式写出来，否则会出现"私聊消息被当群聊处理"。

## 6. 身份字段

| 身份 | 字段 | 说明 |
| --- | --- | --- |
| 发送者 | `body.from.userid` | 机器人**创建者是企业超级管理员** → 明文 `userid`；否则 → 企业主体下的**加密 userid（open_userid）** |
| 会话 | `body.chatid`（**仅群聊**）+ `body.chattype`（`single`/`group`） | 单聊没有 `chatid`，主动推送时用 userid 当 chatid |
| 群成员标识 | **没有** | 回调不带群成员列表，也不带结构化 `mentions`；`@机器人` 只出现在 `text.content` 文本里（如 `"@RobotA hello robot"`） |
| 事件触发者 | `body.from.userid` | 同名规则（超管创建则明文） |
| 来源标记 | `body.compat_info.source` | `ai_assistant` / `channel`；**有该字段即非普通用户消息**，首版应直接丢弃 |

证据：`[文档]` 62155 / 62156；`[SDK源码]` `types/message.ts`。

**安全结论（与 t4 ADR 一致）**：企业微信 `userid` / `open_userid` **不得**直接映射为 Mira Cloud
Account 身份，也不得据此授予 Guanlan / 管理权限。若要把它当身份用，必须先做成"显式的、可审计的
绑定流程"，且 `open_userid` 需要自建应用 `access_token` 才能转明文（`[文档]` 61328）——那是新的
权限面，不在本 Channel 的首版范围内。

**未验证的坑**：`@` 判定依赖解析正文中的显示名；机器人改名、群昵称、`@所有人`、文本含控制字符
（`[社区]` #15）都会影响判定。首版建议：群里只处理"文本以 @<机器人名> 开头/mixed 首项为 text 且含
@<机器人名>"这一类可解释的形态，其余记 `ignored:mention_unparsed`，不要猜。
