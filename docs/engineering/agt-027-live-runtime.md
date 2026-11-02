# AGT-027 · 真实模型 Agent Runtime

> 状态：**已实现并在开发者本地用真实模型完成验证**（2026-11-02）。这不是生产部署、不是定时研究、不是飞书接入。
>
> Issue：[uichat-mira/cloud-pi#5](https://github.com/uichat-mira/cloud-pi/issues/5)

本文说明 Cloud Pi 的基础 Agent 运行入口：用开发者本机的环境变量配置一个 OpenAI-compatible（New API）模型，装配**真实 Pi SDK Session**，让模型自主选择并执行受限工具，并给出可审计的运行记录。

## 1. 范围

已实现：

- 环境变量配置 Provider / Base URL / Model / API Key / 超时 / 工具预算 / 输出上限；
- OpenAI-compatible（`openai-completions`）真实请求；
- 每次 run 一个真实 Pi `AgentSession`，运行结束清理；
- 工具执行权限闸门（声明可见 ≠ 允许执行）；
- 超时、调用方取消、错误分类与脱敏；
- 本地只读工具 `local_read_text`（限制目录、扩展名、大小、防路径穿越/符号链接逃逸）；
- 单次 prompt CLI、`.env.example`、T1/T2/T3 回归与独立 live 套件。

不在本卡范围：研究报告持久化、搜索平台、定时器、飞书、Cloud Auth 正式委托、Guanlan 写回、Docker/生产部署。MCP 研究工具由 AGT-028 通过 `extensionFactories` 接入，本卡只提供装配点。

## 2. 配置

复制 `.env.example` 为 `.env`（已 gitignore），填写：

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `CLOUD_PI_MODEL_BASE_URL` | 是 | — | OpenAI-compatible 基础地址，不含 `/chat/completions`、query 或内嵌凭证 |
| `CLOUD_PI_MODEL_API_KEY` | 是 | — | 只读入内存；不落盘、不打印、不进模型上下文 |
| `CLOUD_PI_MODEL_ID` | 是 | — | 供应商真实模型 ID |
| `CLOUD_PI_MODEL_API` | 否 | `openai-completions` | 目前只支持并验证了这一种 |
| `CLOUD_PI_MODEL_PROVIDER_ID` | 否 | `cloud-pi-live` | Pi 内部 provider 标签 |
| `CLOUD_PI_MODEL_CONTEXT_WINDOW` | 否 | `131072` | 上下文统计口径 |
| `CLOUD_PI_MODEL_MAX_OUTPUT_TOKENS` | 否 | `4096` | 单次输出上限 |
| `CLOUD_PI_RUN_TIMEOUT_MS` | 否 | `120000` | 单次 run 超时 |
| `CLOUD_PI_MAX_TOOL_CALLS` | 否 | `8` | 单次 run 允许执行的工具调用数 |
| `CLOUD_PI_TOOL_ROOT` | 否 | `./notes` | CLI 暴露的只读目录 |

校验失败时 `ConfigError.fields` 与错误文本只包含**变量名**，不包含值。`describeConfig()` 是唯一的可序列化配置视图，**不包含 API Key**。

## 3. 本地命令

```bash
npm ci

# 单次真实运行
npm run agent -- "Use local_read_text to read welcome.md and reply with the fixture key"

# 机器可读输出（run record + 脱敏配置）
npm run agent:json -- "..."

# 确定性回归（不需要 Key / 不联网 / 不跑 Guanlan fixture）
npm run test:agent

# 真实模型 + 真实工具 + 错误凭证/超时/取消/未授权工具（会产生少量真实 token）
CLOUD_PI_ENV_FILE=../cloud-pi/.env npm run test:live

# 仓库既有验证（含 P0 25 项）
npm test
```

`npm test` 仍会先执行 `pretest` 准备隔离 Guanlan fixture；live 套件不在 `npm test` / CI 中自动运行。

## 4. 对外接口（AGT-028 复用）

```js
import { createAgentRuntime, createLocalReadTool } from "cloud-pi/src/index.mjs";

const runtime = await createAgentRuntime({
  // 不传 config 时从 process.env 读取
  cwd: process.cwd(),
  // 研究工具：原生 MCP extension 或任意 Pi extension factory
  extensionFactories: [createMcpExtension({ logPath })],
  // 只允许这些工具执行；支持 `mcp__guanlan__*` 通配
  allowedTools: ["mcp__guanlan__guanlan_news_recent", "mcp__guanlan__guanlan_whoami"],
});

try {
  const record = await runtime.run("Find recent Guanlan items about …", {
    signal,          // AbortSignal，可选
    timeoutMs: 90_000, // 整个 run 的硬截止时间（含 session 装配）
    onEvent(event) { /* 只含工具名/状态，不含正文 */ },
  });
  // record.status: succeeded | failed | timeout | cancelled
  // record.error:  { code, message, retryable } | null
} finally {
  runtime.dispose();
}
```

### 工具策略

- `allowedTools`：**执行**白名单，默认空（fail closed）。空值表示任何工具都不能执行。
- `exposedTools`：模型**可见**的工具；默认与 `allowedTools` 相同。二者分开时，可见但未授权的调用会在 `tool_call` 钩子被拒绝，返回 `tool_not_granted`，且**不会**进入工具执行体。
- `maxToolCalls`：超过预算的调用返回 `tool_budget_exhausted` 并拒绝执行；是否终止当前批次由 Pi 对同一批全部工具结果的处理决定。
- 内置 `read` / `bash` / `edit` / `write` 默认不暴露（`tools: []`），除非调用方显式允许。

### Run record（稳定契约）

```json
{
  "runId": "uuid",
  "status": "succeeded",
  "startedAt": "ISO-8601",
  "durationMs": 1234,
  "model": { "providerId": "mira-ai", "modelId": "…", "api": "openai-completions" },
  "limits": { "timeoutMs": 120000, "maxToolCalls": 8, "maxOutputTokens": 4096 },
  "text": "final assistant text",
  "stopReason": "stop",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0, "cost": 0 },
  "toolCalls": [
    { "name": "local_read_text", "toolCallId": "…", "status": "ok", "durationMs": 1, "resultPreview": "…" }
  ],
  "error": null
}
```

`status`：`succeeded | failed | timeout | cancelled`。超时是**整个 run 的硬截止时间**（含 session 装配）；到期后中止并在有界等待后返回 `timeout`，即使工具忽略 AbortSignal。调用方在 run 开始前已取消时不会启动模型或工具。错误分类：`config_error`、`auth_error`、`model_not_found`、`rate_limit`、`invalid_request`、`provider_unavailable`、`network_error`、`timeout`、`cancelled`、`tool_denied`、`tool_budget_exhausted`、`tool_error`、`provider_error`。消息在写出前统一脱敏并截断。

## 5. 安全边界

- API Key 通过 `ModelRuntime.setRuntimeApiKey()` 只存在内存；运行目录是私有临时目录，不读写 `~/.pi`。
- 会话默认 `SessionManager.inMemory()`，不把对话写盘。
- 错误、run record（含最终文本与工具结果预览）、CLI 输出都经过 `redactSecrets()`；证据文件只记录脱敏摘要。
- 从 `process.env` 读取 Key 后会立即从进程中删除，避免 extension 派生的子进程（如 MCP stdio）继承；调用方注入 `config` 时由 `normalizeConfig()` 重新校验并补默认值。
- `local_read_text` 只读显式根目录；拒绝绝对路径、`..`、逃逸 root 的符号链接、非白名单扩展名、二进制和超限文件。默认根目录 `./notes` 不含 `.env`。
- 网页/新闻/群消息等不可信内容只能作为数据；工具授权由 `allowedTools` 在执行时强制，不因模型文本或工具参数改变。
- P0 的 `fauxProvider` 只存在于测试；`src/` 有回归断言禁止导入 faux。

## 6. 验证分层

| 层 | 内容 | 是否付费 |
| --- | --- | --- |
| T1 | 配置默认/缺项/非法 URL/限额、脱敏、错误分类、工具通配符 | 否 |
| T2 | 权限闸门、工具预算、超时、取消、供应商错误分类、只读工具负例 | 否 |
| T3 | 真实 Pi Session + 真实工具管线 + 确定性 faux 模型 | 否 |
| T4 | 真实 Provider 文本、真实自主 Tool Call、错误凭证、超时、取消、未授权工具拒绝 | **是** |

T4 证据见 [agt-027-live-evidence.md](agt-027-live-evidence.md)。CI/普通 `npm test` 不要求 Key，也不做付费调用；T4 结果不能由 T3 或 P0 代替。

## 7. 已知限制

- 只实现 OpenAI-compatible API；Anthropic/其它协议未接入。
- `reasoning` 固定关闭；不使用 `store` / `developer` 字段，`max_tokens` 走兼容模式。
- 单 provider、单模型；没有故障转移、成本预算或速率限制（由宿主后续按任务追加）。
- 每次 run 新建 session；结束后向 extension 发送 `session_shutdown` 再 dispose，MCP 连接/子进程随 session 关闭。跨 run 上下文由调用方显式管理。
- 同一 runtime 实例不要并发调用 `run()`（共享运行目录）；并发任务请为每个任务创建独立 runtime，或串行执行。
- OC Review：当前 cloud-pi 没有 `mira-ai-review.yml` caller，Control Room 发布白名单也未包含本仓库；组织 caller 还会跳过 Draft PR。因此本 PR 的 OC Review 需要维护者触发/接入，不能由 DSH 伪造。
