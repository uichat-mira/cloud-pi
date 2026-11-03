# 下一张最小 POC 卡草案（≤60 分钟，独立可验收）

> 用途：本卡只是**草案**，不实现。编号由维护者分配（**不要占用 AGT-036/037/038**，
> 维护者已授权这些号给实施卡）。
> 目标链路：`真实企业微信单聊消息 → 长连接 → Cloud Pi 已有 createAgentRuntime().run() → 流式回复`。

## 1. 目标与成功判据（一句话）

维护者用手机给机器人发一句真实消息，机器人在企业微信里**流式**回出**真实模型**的回答；
全过程有一个不含密钥的脱敏证据文件。**不允许用 fixture / mock 冒充**。

## 2. 范围

**做：**
- 一个常驻/一次性脚本，连 `wss://openws.work.weixin.qq.com`，`aibot_subscribe` 认证。
- 收到 `aibot_msg_callback`（`chattype=single`，文本）→ 调用**现有** `createAgentRuntime().run()`。
- 用 `replyStream` 先发一帧"正在处理…"（`finish=false`），最终以 `finish=true` 发送真实回答。
- 写脱敏证据 JSON（SDK 版本、Node 版本、masked botid/msgid/userid、时间线、帧数、状态）。
- 正常退出：`disconnect()`，进程 0 退出码。

**不做（明确 out of scope）：**
- 不做主动推送（`aibot_send_msg`）、不做 Scheduler、不做媒体/卡片、不做群聊、不做多轮会话。
- 不做身份映射（userid → Cloud Account）、不做 open_userid 转换、不引入自建应用。
- 不改 `src/channels/feishu/*`、不改 `src/delivery/*`、不改 Runtime。
- 不部署、不改企业微信管理配置（除本卡依赖的机器人创建，见 §3）。

## 3. 依赖（阻塞项）

| 依赖 | 提供者 | 状态 |
| --- | --- | --- |
| 智能机器人已创建 + API 模式 + 长连接 | 维护者（`admin-setup.md`） | **未提供** |
| `BotID` / `Secret` | 维护者，经安全通道 | **未提供** |
| 机器人创建者是超级管理员（否则 `from.userid` 为 open_userid） | 维护者决策 | 待确认（本 POC 不需要明文 userid，但需要知道实际拿到什么） |
| 维护者手机端能搜到并给机器人发消息 | 维护者 | 未知（可见范围待界面确认） |

> 没有第 1、2 项，本卡**不能开始 Live**。可以先把离线部分（脚本 + 单测 + 证据 schema）做完，
> 但验收必须等 Live。

## 4. 步骤与时间预算（合计 ≤60 min）

| # | 步骤 | 预算 | 产出 |
| --- | --- | --- | --- |
| 1 | 分支 + `npm i --save-exact @wecom/aibot-node-sdk@1.0.7` | 5 min | `package.json` 精确版本 |
| 2 | 写 `scripts/wecom-live-probe.mjs`（连接/认证/等一条消息/调 Runtime/流式回复/写证据） | 20 min | 脚本 |
| 3 | 离线自检：无凭证时构造 client、事件订阅、证据 writer、分段/字节长度函数单测 | 10 min | `node --test` 通过 |
| 4 | Live：维护者发一条消息 | 10 min | 证据 JSON + 维护者截图（客户端里看到流式回答） |
| 5 | 断线重连自检：重启进程 → 重新订阅成功 | 5 min | 证据里两次 `authenticated` |
| 6 | 文档 `docs/engineering/agt-0xx-wecom-poc.md` + Draft PR | 10 min | PR（关联 Issue + dsh badge） |

## 5. 验收标准（可独立判定）

| # | 判据 | 证据 |
| --- | --- | --- |
| A1 | `aibot_subscribe` 返回 `errcode: 0`，`authenticated` 在 20 s 内触发 | 证据 JSON 的 `subscribe` 段 |
| A2 | 收到**真实** `aibot_msg_callback`：`chattype=single`，`msgid` 存在，`from.userid` 存在（masked 记录） | 证据 JSON 的 `inbound` 段 |
| A3 | 企业微信客户端里看到**流式**更新（至少 1 帧 `finish=false` + 1 帧 `finish=true`） | 证据 JSON 的 `frames[]` + 维护者截图 |
| A4 | 回答来自**真实模型**（证据记录 model id 与 token/耗时，不记录正文全文） | 证据 JSON 的 `model` 段 |
| A5 | 证据文件不含 Secret / BotID 全量 / userid 全量 / 正文 | 人工 grep + `maskId()` |
| A6 | 进程重启后重新订阅成功（旧连接被服务端断开不导致卡死） | 两条 `authenticated` 时间戳 |
| A7 | `npm test` 全仓回归通过（新增离线用例计入） | CI/本地输出 |

**不满足 A2/A3/A4 任一项 = Live 未通过**，不得用"离线 fixture 通过"替代。

## 6. 已知风险（必须先写在 PR 里）

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| SDK 5 s 回执超时 | 流式帧可能被判超时，但服务端可能已展示 | 用 `replyStreamNonBlocking` 跳过积压帧；超时只记 `unknown`，不重发 |
| 单连接被踢 | 本地重启/另一个进程会踢掉当前连接 | 只跑一个实例；证据里记录 `disconnected_event` |
| `from.userid` 是 open_userid | 不影响回复（回复靠 `req_id`），但不能当身份 | 证据只记 masked 值，不建映射 |
| 机器人收不到消息 | 可能是可见范围/客户端版本 | 按 `admin-setup.md` §7 逐条排查；记录 blocker，不绕过 |
| 群聊/主动推送未验证 | 产品判断有缺口 | 本卡不做；留给后续卡（Scheduler 投递另开） |

## 7. 本卡不解决的、必须留给后续卡的问题

1. 群聊 @ 的可靠判定（文本解析 vs 结构化 mentions）。
2. 主动推送（Scheduler 交付）与"必须先有入站消息"的产品方案。
3. 身份绑定（userid/open_userid ↔ Cloud Account）、可见范围治理。
4. 媒体与卡片。
5. 主备切换与多实例部署。

## 8. 结论

本卡是"能否在真实企业微信里跑通一次 Agent 回合"的**最小可验收切片**，60 分钟内可完成，
且失败点全部可归因（凭证 / 可见范围 / 网络 / SDK 超时）。它不证明产品可用，只证明链路可达。
