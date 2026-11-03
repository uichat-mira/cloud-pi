# AGT-029 · 飞书 Live POC 证据（脱敏）

> 状态：**私聊与授权群 @ 真实往返通过**（2026-11-03，Asia/Shanghai）。
> 被测实现：`feat/agt-029-feishu-channel`，基线 `dev@9a8bf1f`；PR #12。
> Live 运行 commit：`722236f`；发布时 PR head 见 PR（此后仅 Sonar/文档修复，运行路径不变）。
> 原始 JSONL：
> [私聊](../../poc/evidence/agt-029-live-p2p.jsonl) ·
> [群 @](../../poc/evidence/agt-029-live-group.jsonl) ·
> [群未授权负例](../../poc/evidence/agt-029-live.jsonl)。
> 本文不包含 App Secret、token、模型 Key、私人消息正文或完整飞书 id。

## 1. 结论

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 真实飞书私聊 → Cloud Pi Runtime → 真实模型 → 私聊回复 | **通过** | `agt-029-live-p2p.jsonl` |
| 真实飞书授权群 @bot → Cloud Pi Runtime → 真实模型 → 群回复 | **通过** | `agt-029-live-group.jsonl` |
| 授权群非 @ 消息 | **忽略，未产生 run/reply** | 私聊 JSONL 中的 `group_without_mention` |
| 未授权群 @bot（授权前） | **忽略，未产生 run/reply** | `agt-029-live.jsonl` 中的 `unauthorized_group` |
| 重复投递只产生一次 run | 自动化通过；Live 未人为触发飞书重投 | T1/T2 测试 |
| 真实飞书 `/stop` | 自动化通过；Live 未稳定复现长任务窗口 | T2/T3 测试 |

环境：macOS arm64，Node `v22.23.2`，`@earendil-works/pi-coding-agent@1.4.0`，
`@larksuiteoapi/node-sdk@1.76.0`，应用 `cli_aa6…dc0e`，机器人 `ou_57b…2a00`，域 `feishu`。
群授权为本地 `.env` 的单群 allowlist（`allowedChatCount=1`），未写入仓库。

## 2. 私聊真实往返

- 事件：`event_id=26c2df…a196`，`message_id=om_x10…5535`，`chat_id=oc_3d5…a9b6`
- 路由：`private_chat`
- Run：`9c3af8e2-b565-45a3-b488-6d818c706df8`
- 状态：`succeeded`
- 模型：`deepseek-v4.1-flash-od`
- 耗时：`1474 ms`；usage：`203 in / 8 out / 595 total`
- 回复：`reply_message_id=om_x10…e065`，`replyDelivered=true`
- 证据时间：`2026-11-03T05:16:29Z` 接收，`05:16:31Z` 回复

## 3. 授权群 @ 真实往返

- 事件：`event_id=2dd0f7…02b9`，`message_id=om_x10…c3b3`，`chat_id=oc_09e…5daf`
- 路由：`group_mention`（授权群 + 明确 @bot，mention `open_id` 与机器人一致）
- Run：`28b1e677-4af9-4224-9b12-51d18ceb1f2a`
- 状态：`succeeded`
- 模型：`deepseek-v4.1-flash-od`
- 耗时：`2921 ms`；usage：`589 in / 152 out / 741 total`
- 回复：`reply_message_id=om_x10…1b46`，`replyDelivered=true`
- 证据时间：`2026-11-03T05:15:03Z` 接收，`05:15:06Z` 回复

## 4. 负向证据

1. **授权群非 @**：`event_id=73e2ba…894d`、`message_id=om_x10…9207` 到达后判定
   `group_without_mention`，`action=ignored`，没有 run、没有回复。该事件真实到达说明
   应用已能收到群内非 @ 消息，因此这个忽略是适配器策略结果，而不是平台没投递。
2. **未授权群 @bot**：在把测试群加入 allowlist 之前，`event_id=14ccf1…55c8`、
   `message_id=om_x10…26d2` 到达后判定 `unauthorized_group`，没有 run、没有回复。
3. **无效凭证**：用临时假 App ID/Secret 调真实飞书 token 接口，返回
   `code: 10003, msg: invalid param`，进程 fail closed；证明 SDK/网络路径真实，且无效凭证不会启动。

## 5. 未在 Live 中执行的部分

- **重复投递**：飞书未对同一条消息重投，无法在不伪造事件的前提下制造；已由
  `tests/agt-029-channel.test.mjs` 的顺序重投、并发重投和 `tests/agt-029-dedupe.test.mjs` 覆盖。
- **`/stop`**：模型在 1.5–3 秒内完成，人工发送 `/stop` 的窗口不稳定；已由
  `tests/agt-029-channel.test.mjs`（Adapter abort）与 `tests/agt-029-runtime.test.mjs`
  （真实 Pi Session + 慢工具 + AbortSignal）覆盖。未把自动化结果写成 Live 结果。
- 图片/富文本/卡片、跨消息会话、多实例去重、群成员身份映射不在本卡范围。

## 6. 复现

```bash
# 凭证由进程环境注入，禁止写进仓库
FEISHU_APP_ID=cli_... FEISHU_APP_SECRET=... npm run feishu:live -- --chat-type p2p

# 群验证需要该群 oc_... 在 FEISHU_ALLOWED_CHAT_IDS 中；未列出的群 fail closed
FEISHU_ALLOWED_CHAT_IDS=oc_... npm run feishu:live -- --chat-type group
```

`npm run feishu:live` 只等待真人发送的真实事件；脚本不构造入站消息。PASS 条件是收到
`action=replied` 且 `replyDelivered=true`（负例则匹配 `ignored:<reason>`）。
