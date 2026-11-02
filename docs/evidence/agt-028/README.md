# AGT-028 · 真实联网研究证据（脱敏）

> 采集时间：2026-11-02 18:01–18:04（Asia/Shanghai）
> 被测代码：`feat/agt-028-live-research`（本目录所在提交）
> 模型运行时：`feat/agt-027-live-agent` 的 `src/index.mjs`（AGT-027 正式 Agent Runtime，未复制）
> 性质：**开发者本地真实模型 + 真实联网调用**，独立于 CI；本文与 `runs/` 不含 API Key、Authorization 头或私有数据。

## 环境

| 项 | 值 |
| --- | --- |
| OS | Darwin arm64（macOS） |
| Node.js | v22.23.2 |
| Pi SDK | `@earendil-works/pi-coding-agent@1.4.0`、`@earendil-works/pi-ai@1.4.0`（lockfile 锁定） |
| Provider / 模型 | `mira-ai` / `deepseek-v4.1-flash-od`（由 AGT-027 运行时读取宿主 `.env`，仅存内存） |
| 网络 | 本机直连受限；HTTPS 经宿主代理 `http://127.0.0.1:1080`（`HTTPS_PROXY`/`HTTP_PROXY`），属环境配置，不入库 |
| 运行入口 | `scripts/research.mjs` → `executeResearch` → `runtime/agt-027.mjs` 适配器 → AGT-027 `createAgentRuntime().run()` |

## 三次独立运行（同一主题，不同预算，各自新 runId）

主题：`研究最近 48 小时值得《见π》关注的 AI Agent 工程进展`，时间窗 `48h`。

| # | runId | 状态 | 耗时 | 搜索/读取 | Token 总量 | 来源（已读/总） | 报告 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `r-20261102T100143-1198d5` | completed | 37.8 s | 3 / 3 | 23,909 | 3 / 21 | [report.md](runs/r-20261102T100143-1198d5/report.md) |
| 2 | `r-20261102T100227-07f7be` | completed_with_errors | 36.7 s | 4 / 4 | 27,804 | 3 / 32 | [report.md](runs/r-20261102T100227-07f7be/report.md) |
| 3 | `r-20261102T100311-480125` | completed_with_errors | 48.1 s | 5 / 3 | 46,861 | 2 / 39 | [report.md](runs/r-20261102T100311-480125/report.md) |

每次运行的 `run.json` 记录：真实 `usage`（input/output/total，`source: "provider"`）、工具调用计数（发起/拒绝）、来源账本摘要、引用解析结果与分类错误；`sources.json` 是独立来源清单（fetched / failed / not_fetched，含 finalUrl、httpStatus、accessedAt、发布日期与置信度、摘要）。

三次运行的选题、来源与结论明显不同（MCP 评测 / PHP 现代化论文 / Minecraft agent swarm），说明不是同一结果的重放。

`completed_with_errors` 是**如实**结果：模型引用的 `bloomberg.com` 页面返回 403，记为 `http_error`，报告在“失败项”中说明未读取，未编造内容。

## 来源真实性抽查（人工复核，`curl` 直取页面）

| 来源 | 报告中的关键主张 | 复核结果 |
| --- | --- | --- |
| `m3.sineframe.com/blog/same-model-different-agent` (S13) | 同模型换 Agent，21 个 MCP Server 成功率 82.0% / 65.4%，忽略率 44.5%，3,717 次试验 | HTTP 200；页面同时出现 `82.0`、`65.4`、`44.5`、`3,717` ✔ |
| `arxiv.org/abs/2610.40269` (S20) | 遗留 PHP 单文件现代化：83 个文件原本通过、最好模型改后剩 59；5 个 LLM、630 项隐藏检查、511 条 Rector 问题 | HTTP 200；标题与 `83/59/630/511` 均在页面 ✔ |
| `paulfwalsh.substack.com/p/metas-muse-ai-agent-is-a-commercial` (S34) | Meta Muse 被指为“监控网络”、默认用于训练、SEV 2 云漏洞 | HTTP 200；标题即 “Muse AI agent is a commercial surveillance network…” ✔ |
| `tomshardware.com/.../ai-agent-swarms-unleashed-in-minecraft...` (S35) | 50-agent Minecraft 团队因“官僚流程”失败；基于 Mindcraft/Mineflayer | HTTP 200；URL 标题与正文主张一致 ✔（页面元数据日期 2026-11-01 已核验） |

结论：抽查的 4 条关键来源均可打开，关键数字/主张与页面一致；没有发现伪造 URL。

## 引用审计（工具自动生成，非人工）

`report.md` 末尾附 `## Citation audit`：

- 未解析引用（`[S<n>]` 指向不存在的来源）：三次均为 **0**。
- 引用了“仅搜索命中、未读取”的来源：运行 1 有 10 条，但报告在同一行明确标注“仅搜索命中、**未读取**故未作为事实引用的线索”，属于透明披露而非事实引用；运行 2/3 的未读引用集中在失败来源。
- 账本只收录工具真实返回的来源；模型在正文里手写的 URL 不会进入 `sources.json`。

## 复现

```bash
# 1) 需要 AGT-027 的运行时模块（其分支 feat/agt-027-live-agent）
# 2) 宿主注入模型配置（CLOUD_PI_MODEL_*），本命令不读取、不打印凭据
HTTPS_PROXY=http://127.0.0.1:1080 HTTP_PROXY=http://127.0.0.1:1080 \
node --env-file=../cloud-pi/.env scripts/research.mjs \
  --topic "研究最近 48 小时值得《见π》关注的 AI Agent 工程进展" \
  --time-range 48h --max-searches 3 --max-pages 3 --max-runtime-ms 240000 \
  --runtime-module ../cloud-pi-agt-027/src/index.mjs \
  --runs-dir /tmp/agt028-final

# 3) 离线读回（不联网、不需要模型）
node scripts/research.mjs --read <runId> --runs-dir /tmp/agt028-final
```

## 已知限制

- **数字抄录**：早期探索运行中出现过一次把页面上的 `21,489` 写成 `21,577` 的抄录偏差（该运行未纳入本证据集）。引用具体数字前必须人工复核，本目录的抽查即为此设置。
- **检索召回**：Bing 对泛词常返回导航页/概念页；HN 对多词长句常返回 0。prompt 已内置检索策略，但仍可能出现“证据不足”的报告——这属于如实结果。
- **Bing 日期不可信**：搜索侧日期标为 `dateConfidence: "unverified"`，只有页面元数据为 `verified`；报告已按此区分。
- **未证明**：生产部署、Scheduler 定时触发、飞书推送；本证据只覆盖“研究执行 + 产物 + 按 runId 读回”。

## 不包含

- 任何 API Key、Authorization 头、Cookie、私有 URL。
- 完整模型 transcript（只保留工具名/状态/耗时/错误码的脱敏台账）。
