# 真实链路冒烟证据：企业微信长连接（订阅 + 入站 + 回复）

> **状态：真实链路已执行（非 fixture / 非 mock）。** 执行时间 2026-11-04 01:15–01:18（UTC+8）。
> 凭证由维护者提供，仅在进程内注入；本文件只记录**存在性与投影值**。
> 字段白名单：时间、耗时、`errcode`、事件类型、`chattype`、脱敏发送者（白名单允许首尾各 2 字符；
> 本次发送者 id 仅 5 位，**主动收紧为首尾各 1 字符**）、
> 回复是否被平台接受、错误码。**未记录** message id、完整 `userid`/`chatid`、消息正文（除本卡固定文案）、
> 任何凭证值、客户端 IP。
> 关联：Issue #13、PR #23、[研究总览](README.md)、[SDK 分析](sdk.md)。

## 0. 结论与时间线（先看这里）

**结论：企业微信长连接假设成立。** 真实凭证下订阅 `errcode 0`、真实单聊入站可收、真实回复被平台接受
（`errcode 0`）；第一条回复曾失败（`846605 invalid req_id`），失败证据与根因**按要求保留**在第 4.1 节，
不隐藏。

```text
01:15:07.442  ws 建连
01:15:07.630  连接建立（192 ms）
01:15:07.775  aibot_subscribe 被接受 → errcode 0（认证 +333 ms）
01:16:19.345  event.enter_chat（进入会话）
01:16:22.249  aibot_msg_callback（+2.9 s，chattype=single / text / 明文 userid）
01:16:22.344  ❌ 回复失败 846605 invalid req_id（我方传参错误，见 4.1）
--- 修正传参后重连 ---
01:17:26.169  第二次 ws 建连（160 ms 连接 / +301 ms 认证，errcode 0）
01:18:23.184  第二条 aibot_msg_callback（单聊 / 明文 userid / req_id len=24）
01:18:23.652  ✅ 回复被接受 errcode 0 / errmsg ok（467 ms）
01:18:25.167  主动 disconnect，进程退出（无残留连接）
```

四条必须记住的事实：① 订阅 `errcode 0`；② `enter_chat` → 约 3 s → `aibot_msg_callback`；
③ 回复用 **callback** 的 `req_id`，且要传**整个 frame**；④ 发送者 `from_is_open_userid=false`（明文 userid，
因机器人由企业超管创建）。

## 1. 环境与凭证投影

| 项 | 值 |
| --- | --- |
| 端点 | `wss://openws.work.weixin.qq.com`（直连，无代理） |
| SDK | `@wecom/aibot-node-sdk@1.0.7`（npm 安装，非仓库源码） |
| 运行时 | Node `v24.9.0` |
| BotID | 存在，`len=35`，`sha256[:12]=687f6eb2b9fc` |
| Secret | 存在，`len=43`，`sha256[:12]=6c8595cf3a07` |
| 凭证注入方式 | 维护者提供的本地文件 → 进程环境变量；未打印、未写入仓库/日志/PR |

> 投影值只用于"同一条凭证"的比对，不能还原出凭证。

## 2. 订阅（`aibot_subscribe`）

| 轮次 | 时间 | WS 建连 | 认证（订阅被接受） | 结果 |
| --- | --- | --- | --- | --- |
| 第 1 次 | 01:15:07.442 | 192 ms | 01:15:07.775（+333 ms） | `Authentication successful`，**errcode 0** |
| 第 2 次 | 01:17:26.169 | 160 ms | 01:17:26.470（+301 ms） | `Authentication successful`，**errcode 0** |

**结论**：真实凭证 + 长连接可用，`aibot_subscribe` 被平台接受（`errcode: 0`）；
两次均在 **350 ms 内**完成"连接 + 认证"。这与研究阶段"本机可直连"的探测一致，**无需公网入口**。

## 3. 入站消息（`aibot_msg_callback`）

| 项 | 第 1 条 | 第 2 条 |
| --- | --- | --- |
| 到达时间 | 01:16:22.249 | 01:18:23.184 |
| 连接建立后 | +75 s | +57 s |
| 前置事件 | 01:16:19 `enter_chat`（进入会话），**+2.9 s** 后到达消息 | —（无 `enter_chat`，消息照常到达） |
| `chattype` | `single` | `single` |
| `msgtype` | `text` | `text` |
| `req_id` | 存在 | 存在（`len=24`） |
| `aibotid` | 存在 | 存在 |
| 发送者（脱敏） | `d****o`（`len=5`，**短 id 收紧为 1+1**） | `d****o`（`len=5`，同上） |
| 是否 `open_userid` | **否**（明文 userid） | **否**（明文 userid） |
| 正文长度 | 6 字节 | 3 字节 |

**结论**：
1. 真实入站链路成立（`aibot_msg_callback` → SDK `message.text`）；
2. `enter_chat` 事件真实可收，但**不是**收消息的前置条件（第 2 条没有它也能收到）；
3. 发送者是**明文 `userid`**，不是加密 `open_userid` → 说明该机器人由**企业超级管理员**创建，
   ADR-002 X4 的前提成立（若改为普通管理员创建，这里会变成 `open_userid`）。

## 4. 回复（`aibot_respond_msg`）

固定文案：`Cloud Agent 冒烟：已收到你的消息`（42 字节）。

### 4.1 第 1 次：失败（我方调用错误，已定位）

- 01:16:22.344 返回 **`errcode 846605` / `invalid req_id`**。
- 根因：SDK 的 `WsFrameHeaders = Pick<WsFrame,'headers'>`，`replyStream(frame, ...)` 内部读
  `frame.headers.req_id`；我第一次传的是 `frame.headers`，该对象没有 `.headers` → `req_id` 为空 →
  平台按"invalid req_id"拒绝。
- 判断依据：同一次日志里入站帧 `req_id` 存在，其余参数未变，仅改传参对象后即成功（见 4.2）。

> 附带结论：平台对 `req_id` 的校验是**严格**的，空 `req_id` 会明确拒绝——这反过来说明本证据
> 不是宽松 mock 或本地环回。

### 4.2 第 2 次：成功

| 项 | 值 |
| --- | --- |
| 入站 → 回复回执 | 01:18:23.185 → 01:18:23.652（**467 ms**） |
| 回执 | **`errcode 0` / `errmsg: ok`** |
| 回复长度 | 42 字节（UTF-8） |

**结论**：真实回复被平台接受；在 SDK 硬编码的 5 s 回执超时内（467 ms）完成，余量充足。

## 5. 连接生命周期

- 两次运行都在结束时主动 `disconnect()`，进程退出（第 1 次 exit 6，第 2 次 exit 0），**未留后台连接**。
- 遵守"同一机器人只允许一条长连接"：上一轮完全关闭后才发起下一轮。
- 断开时本地 `ws` 报 `code: 1006` 属**客户端主动关闭**的正常表现，不是平台异常。

## 6. 给实现卡（t6/t8）的注意事项

> 以下 1–2 条已同步写入 **[t6-answers.md §7](t6-answers.md)**（pi-dev 交接段），两处内容一致。

1. **回复必须传整个 frame**：`client.replyStream(frame, streamId, content, true)`；
   传 `frame.headers` 会得到 `846605 invalid req_id`。类型名 `WsFrameHeaders` 有误导性，
   它指的是"带 headers 的对象"（`Pick<WsFrame,'headers'>`）。
2. **回执超时 5 s**（SDK 硬编码）：真实链路上 467 ms 完成，但流式多帧/媒体上传场景仍要留预算。
3. **明文 `userid` 依赖超管创建**：换成普通管理员创建即变 `open_userid`；不要写死"一定有明文 userid"。
4. **`enter_chat` 可选**：不要把它当作"必须等待"的前置；直接按 `aibot_msg_callback` 处理即可。
5. **单连接**：调试/重启时必须先关闭旧进程，否则新订阅会踢掉旧连接（`disconnected_event`）。

## 7. 明确未验证（本卡边界）

- 群聊 `@`（`chattype=group`、正文内 `@名称` 解析）
- 主动推送 `aibot_send_msg`（需"已有入站会话"前提 + Scheduler 投递链路）
- 24 h 回复窗口、10 min 流式上限、长文本分段（>20480 字节）
- 媒体上传、模板卡片、`msg_item`
- 多实例主备切换
- **模型推理**：本卡只验证传输通道，未接模型、未跑 Pi SDK Session

## 8. 结论

**企业微信长连接假设成立**：真实凭证下 `aibot_subscribe` 返回 `errcode 0`，真实单聊入站可收，
真实回复被平台接受（`errcode 0`）。本轮唯一失败（`846605`）由本卡调用参数错误引起，修正后即通过，
不构成平台能力问题。V1 的传输与回复链路从"未验证假设"变为"已真实验证"；
身份（ADR-002 X1–X4 Deferred）与 Scheduler 主动投递仍按既有裁决边界执行。
