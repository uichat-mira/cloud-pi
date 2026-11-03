# AGT-029 · 飞书 Live POC 证据（脱敏）

> 状态：**待执行 / 尚未通过**（2026-11-03，Asia/Shanghai）。
> 被测实现：`feat/agt-029-feishu-channel`，基线 `dev@9a8bf1f`（PR 创建后以 PR head 为准）。
> 原始 JSONL：[poc/evidence/agt-029-live.jsonl](../../poc/evidence/agt-029-live.jsonl)。
> 本文不包含 App Secret、token、模型 Key 或私人消息正文。

## 1. 当前结论

真实飞书往返（`Feishu event → Channel → Cloud Pi Pi SDK → real model → Feishu reply`）
**尚未完成**，原因是开发者本机没有可用的既有飞书应用运行配置。没有用 mock/fixture 冒充
Live 证据。

本机只读排查结果（只记录名称和存在性）：

| 来源 | 结果 |
| --- | --- |
| 进程环境 `FEISHU_*` / `LARK_*` | 无 |
| shell profiles（`~/.zshrc` 等） | 无 Feishu 变量 |
| `launchctl getenv` / LaunchAgents | 无 Feishu 配置 |
| `~/.pi/agent/feishu/`、`~/.dsh/feishu/` | 不存在 |
| 工作区 `.env*` | 无 `FEISHU_*` 键 |
| Keychain 服务名探测 | 无 `feishu` / `lark` / `ax-feishu-bridge` |
| 运行中的 bridge / 端口 3001/3002 | 无 |

## 2. 已执行的失败证据

```bash
node scripts/feishu-live-poc.mjs --timeout-ms 3000
# exit 2
# feishu live start failed:
# Invalid Feishu channel configuration:
# FEISHU_APP_ID must be a Feishu app id starting with "cli_";
# FEISHU_APP_SECRET is required and must not contain whitespace
```

`poc/evidence/agt-029-live.jsonl` 记录了 `session_start`（commit / Node / Pi / SDK 版本）
与 `start_failed`（仅字段名），没有 secret。该失败只证明配置校验 fail closed，
**不证明**真实链路。

## 3. Feishu API 可达性负向探测

用**非真实**的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（仅本地临时环境，未写入仓库）加载真实
模型配置后运行 Live 驱动，确认官方 SDK 真实到达飞书并 fail closed：

```text
exit 1
feishu live start failed: failed to get tenant_access_token, code: 10003, msg: invalid param
```

这只证明网络、SDK 与 token 路径真实可达，并证明无效凭证不会继续启动；它不是 Live 成功证据。

## 4. 执行 Live 的最小步骤

1. 使用**已有**飞书机器人应用（不新建），注入进程环境：

   ```bash
   FEISHU_APP_ID=cli_... \
   FEISHU_APP_SECRET=... \
   FEISHU_ALLOWED_CHAT_IDS=oc_... \
   npm run feishu:live -- --chat-type p2p
   ```

2. 应用侧：机器人能力、`im.message.receive_v1` 长连接事件、发送消息权限。
3. 真人在飞书私聊机器人发送一句话；脚本等待 `reply` 并写入证据后退出。
4. 群验证：
   - 授权群 @bot：`--chat-type group --expect reply`
   - 授权群非 @：`--chat-type group --expect ignored:group_without_mention`
   - 未授权群：`--chat-type group --expect ignored:unauthorized_group`
5. 证据需补齐：PR head SHA、Node/Pi/飞书 SDK 版本、脱敏 message id、run id、模型、耗时、
   成功/失败原因。

## 4. 不可用作 Live 证据的内容

- `tests/agt-029-runtime.test.mjs` 的 faux provider 只证明 Adapter 到真实 Runtime 的装配。
- 任何本地 fixture、HTTP mock 或手工构造事件都不能替代真实飞书事件与真实模型调用。
