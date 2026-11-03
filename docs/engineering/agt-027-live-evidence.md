# AGT-027 · 真实模型调用证据（脱敏）

> 采集时间：2026-11-02 18:32（Asia/Shanghai）
> 被测代码 commit：`401f38af9162c038774811d73bd8682d5d447f22`（`feat/agt-027-live-agent`；证据文档 commit 在其后，仅文档变更）
> 原始 TAP 输出：[poc/evidence/agt-027-live-test.txt](../../poc/evidence/agt-027-live-test.txt)
> 性质：**开发者本地真实付费调用**，独立于 CI。本文不包含 API Key、Authorization 头或完整敏感正文。

## 环境

| 项 | 值 |
| --- | --- |
| OS / CPU | Darwin arm64（macOS） |
| Node.js | v22.23.2 |
| Pi SDK | `@earendil-works/pi-coding-agent@1.4.0`、`@earendil-works/pi-ai@1.4.0`（lockfile 锁定） |
| 运行方式 | `node scripts/run-live-tests.mjs`（真实 `AgentSession`，非 faux） |
| Provider | `mira-ai`（开发者本机 `.env` 注入） |
| API 形态 | OpenAI-compatible `openai-completions`，`https://mira-ai.tomzlab.cn/v1` |
| 模型 | `deepseek-v4.1-flash-od` |
| 凭证 | `CLOUD_PI_MODEL_API_KEY` 由宿主环境注入，仅存于内存；未写入仓库、日志或证据 |
| 命令 | `CLOUD_PI_ENV_FILE=../cloud-pi/.env npm run test:live` |

`cost` 字段来自 provider 返回，均为 `0`（该网关未给出可核对定价），因此本文**不估算费用**；token 数为真实返回值。

## 结果

| # | 场景 | 状态 | 耗时 | Token（in/out/cacheRead/total） | 工具调用 | 关键观察 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 纯文本 | succeeded | 1315 ms | 170 / 7 / 1280 / 1457 | — | 真实模型返回 `CLOUD_PI_OK` |
| 2 | 模型自主 Tool Call | succeeded | 2958 ms | 381 / 65 / 3328 / 3774 | `local_read_text` **ok**（2 ms） | 模型自行选择工具，读取 `notes/welcome.md`，回答 `alpha` |
| 3 | 可见但未授权工具 | succeeded | 3605 ms | 412 / 144 / 3200 / 3756 | `local_read_text` **blocked**（`tool_not_granted`） | 模型发起调用，运行时拒绝，**未读取文件内容** |
| 4 | 错误 API Key | failed | 50 ms | 0 / 0 / 0 / 0 | — | `auth_error`；错误消息已脱敏，记录中不含 Key |
| 5 | 超时 | timeout | 55 ms | 0 / 0 / 0 / 0 | — | `timeout`；真实请求被中止 |
| 6 | 调用方取消 | cancelled | 504 ms | 0 / 0 / 0 / 0 | — | `cancelled`；`AbortSignal` 生效 |

runId（可追溯）：`7355fb74…`、`6ac35232…`、`4fec75fa…`、`f28bc9d1…`、`2a16cf2f…`、`c7d95648…`（完整值见 TAP 文件）。

## 真实调用路径

```text
CLI / run-live-tests
  → src/runtime.mjs:createAgentRuntime
  → src/provider.mjs:ModelRuntime.registerProvider + setRuntimeApiKey (memory only)
  → @earendil-works/pi-coding-agent:createAgentSession
  → pi-ai openai-completions adapter
  → POST https://mira-ai.tomzlab.cn/v1/chat/completions
  → deepseek-v4.1-flash-od
  → tool_call: local_read_text
  → src/runtime.mjs permission gate (allowedTools) → src/tools.mjs 执行
  → tool_result 回到 Pi 管线 → 最终文本
```

## 失败与排除记录

- 首次尝试使用开发者本机 OpenCode `coding-plan` 配置：网关返回 `400 InvalidSubscription`（订阅过期），未产生有效模型响应。
- 随后尝试另一 Anthropic-compatible 端点：HTTP 404，未产生有效响应。
- 上述失败均未用作验收；最终证据全部来自上表 `mira-ai / deepseek-v4.1-flash-od` 的真实调用。
- 未验证：Anthropic 协议、生产模型路由、限流/余额不足的真实错误体、长上下文/大工具结果。

## 复现

```bash
git switch feat/agt-027-live-agent
git rev-parse HEAD     # 应为 401f38a… 或其后仅含文档变更的 commit
npm ci
cp .env.example .env   # 填入开发者自己的 Provider / Key / Model
CLOUD_PI_ENV_FILE=.env npm run test:live
npm test               # 54 项确定性回归（P0 25 + AGT-027 29）
```

live 套件会真实消费 token；普通 `npm test` 与 CI 不会。

## 与 P0 的区别

P0 用 `fauxProvider` 证明 SDK → Guanlan MCP fixture 的确定性工具链；本证据是**真实模型 + 真实 token + 模型自主工具选择**。两者不可互相替代，P0 回归仍随 `npm test` 运行。

## 未覆盖 / 验证缺口

- 组织 OC Review：cloud-pi 当前没有 `.github/workflows/mira-ai-review.yml` caller，Control Room 发布白名单与本仓库 enrollment 未确认；组织 caller 还会跳过 Draft PR。本证据不冒充 OC Review，需维护者触发/接入。
- 成本：provider 未返回可核对定价。
- 生产并发、广州 Docker、飞书、调度、Cloud Auth 委托不在本卡范围。
