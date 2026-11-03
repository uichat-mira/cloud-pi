# AGT-038 真实 Guanlan MCP 接入（Pi SDK 原生 MCP Extension）

本卡把 Cloud Pi 的运行时从「P0 的本地 fixture 桥」推进到**真实 Guanlan MCP 服务**：真实
Cloud Auth 签发的服务令牌、真实 `https://…workers.dev/mcp` 端点、真实 `tools/list` 与
`tools/call`。Issue：[#25](https://github.com/uichat-mira/cloud-pi/issues/25)。

## 1. 结论

| 项 | 状态 |
| --- | --- |
| Pi SDK 原生 MCP Extension（非自写 JSON-RPC、非 stdio） | ✅ 已验证（真实端点） |
| 真实 `tools/list` → 模型可见工具 | ✅ `mcp__guanlan__guanlan_whoami`、`mcp__guanlan__guanlan_news_recent` |
| 真实只读调用（whoami + news_recent） | ✅ 一次真实模型运行内完成 |
| 令牌现签现用（TTL 300s）+ 每次请求 re-read | ✅ 单测覆盖「单次运行跨 TTL」并用可注入时钟验证 |
| 令牌不进日志/提示/工具参数/run 记录 | ✅ 日志只有 `tokenFingerprint`(sha256[:12])/`exp`/`kid`；单测断言序列化后不含令牌 |
| 缺失/过期/错 audience/伪造签名 | ✅ 四种负例均 fail-closed，无伪造成功 |
| 工具调用可追溯（名字/参数摘要/结果摘要/耗时） | ✅ 在 run 记录的 `toolCalls` 中 |
| 写工具（`guanlan_news_decide`） | ⛔ 本卡只读；留 `GUANLAN_MCP_ALLOW_WRITE` 显式开关，未做真实写验收 |

## 2. 实现

新增 `src/mcp/guanlan.mjs`，一个绑定对象：

- **注册**：`pi.registerMcpServer("guanlan", entry)`（与 P0 相同的路径），`entry` 只含 `url`、
  `exposure: "direct"`、`toolExposure`、`timeout`、`description`，**不含令牌**。
- **扩展**：`createMcpExtension({ loadConfig, createTransport, logPath, startupWaitMs })`。
  `loadConfig` 固定返回空列表，运行期不接受仓库里的 `mcp.json`：端点与能力只由进程环境决定。
- **传输**：`StreamableHttpTransport`（SDK 自带），`openGetStream: false`；每次 HTTP 请求在
  `authorizedFetch` 里现取令牌并写入 `Authorization`。
- **最小暴露**：`toolExposure` 默认 `"*": "hidden"`，只把本卡的两个读工具设为 `direct`。运行期
  `allowedTools` 是精确名，`exposedTools` 是 `mcp__guanlan__*`（MCP 工具在扩展连接后才注册，
  会话白名单必须是模式；究竟哪些工具能出现仍由 `toolExposure` 决定）。
- **接线**：`src/research/runtime/agt-027.mjs` 在 `GUANLAN_MCP_URL` 存在时加载绑定（动态 import，
  未启用时不依赖该模块），并在 `createAgentRuntime({ extensionFactories, allowedTools, exposedTools })`
  注入。

## 3. 令牌

- **现签现用**：令牌由 Cloud Auth 的非生产实例按需签发，TTL 300s，写入权限 600 的文件；
  绑定只读文件，不落任何副本。
- **每次请求前 re-read**：`createGuanlanTokenProvider` 用 `mtime:size` 作为文件指纹，指纹不变则复用
  内存副本（不做每请求 IO），指纹变化立刻重读。**缓存命中也会重新校验 `exp`**，过期即抛错——
  否则单次运行超过 TTL 时会继续使用旧令牌。
- **本地校验**：`iss` 不作信任依据；客户端只做「能用/不能用」的判定——`exp`（含 30s 提前量）、
  `aud === mira:cloud-guanlan`（可配 `GUANLAN_MCP_AUDIENCE`）、`scope` 含 `guanlan.read`。签名验证
  仍是服务端职责，伪造签名会在服务端 401（见 §4 负例）。
- **fail-closed**：缺失/不可读/过期/错 audience/缺 scope → `mcp_credential_unavailable`；
  配置问题 → `guanlan_mcp_config_error`；服务端 401 或传输失败且本次没有任何成功 MCP 调用 →
  `mcp_server_unavailable`（研究端口在 `runtime.run` 之后判定，未启用 Guanlan 时不影响既有行为）。
  任何一条都**不会**回退到 fixture、不会静默跳过工具、不会用旧令牌重试。
- **日志投影**：只记 `tokenFingerprint`（sha256 前 12 位）、`exp`、`kid`、`scope`。单测断言日志
  序列化后不含令牌原文、不含 `Bearer`、不含 JWT 载荷段。

## 4. 证据

真实端点：`https://cloud-guanlan-gln014-3c872be6.dangjingtao.workers.dev/mcp`；
JWKS 由 Cloudflare Pages 静态发布（`kid=gln013-t23-1`）；出网经 `GUANLAN_MCP_PROXY` 显式代理。

### 4.1 真实短链路（真实模型 + 真实 MCP，一次令牌生命周期内）

```text
initialize → 200  (serverInfo cloud-guanlan 0.1.0-gln-004)
tools/list → 200  → 声明 mcp__guanlan__guanlan_whoami / mcp__guanlan__guanlan_news_recent
guanlan_whoami        args {}          → {"accountId":"<uuid>","consumerId":"<uuid>","scopes":["guanlan.read"]}  419ms
guanlan_news_recent   args {"limit":2} → "0 item(s) … No news items match this authorized query."            1126ms
run: status=succeeded  durationMs=9926  usage{input:596,output:364}
日志：{"event":"guanlan_mcp_credential","tokenFingerprint":"fee3818053f8","exp":1793732286,"kid":"gln013-t23-1","scope":"guanlan.read"}
```

`accountId === consumerId`（`consumerEqualsAccount: true`），与 guanlan-dev 的真实令牌自测一致。
`news_recent` 返回 0 条是**真实结果**（默认未读+pending 过滤下该账户无条目），模型如实报告"没有可
报告的条目"，未编造。

### 4.2 负例（都跑在真实端点上）

| 模式 | 触发 | 结果 |
| --- | --- | --- |
| 令牌过期 | 本地构造 `exp` 已过期的 JWT | 预检即拒绝：`mcp_credential_unavailable: token is expired…`，**未调用模型** |
| audience 不符 | 绑定要求 `mira:cloud-shiyan`，令牌 `aud=mira:cloud-guanlan` | 客户端拒绝：`token audience "mira:cloud-guanlan" is not mira:cloud-shiyan` |
| 伪造签名 | 本地 JWT（claims 正确、签名伪造） | 真实服务端 **401**；零工具调用；按产品规则判 `mcp_server_unavailable`，不产生"查询成功" |
| 离线：未授权工具 | 本地 MCP 服务额外声明 `guanlan_internal_debug` | 该工具保持 hidden，模型看不到 |

> 说明：`--audience=mira:shiyan` 的签名令牌本机已过期（Cloud Auth 也拒绝对该 audience 现签），
> 因此「别的服务签发的真令牌」用「绑定 audience 不符」等价覆盖，并在证据里如实标注。

## 5. 运维手册

- **谁签**：Cloud Auth 非生产实例（`POST /v1/service-credentials`，服务身份 `aud=mira:cloud-guanlan`）。
  Cloud Pi 不自造令牌、不自建账号/权限体系。
- **怎么签**：`node "%TEMP%\gln013-t23\mint.mjs" "%TEMP%\gln013-t23" guanlan.read [guanlan.write]`，
  只打印 `aud/scope/ttl/exp/kid/consumer_eq_sub/sha256_12`，令牌写入 `token-for-t10.txt`（TTL 300s）。
  运行侧把该文件路径给 `GUANLAN_MCP_TOKEN_FILE`；本项目只用副本 `t9-token.txt`，避免与其它任务抢同一文件。
- **过期怎么办**：重跑签发命令即可——绑定按文件指纹自动重读，不需要重启进程。签不出来（会话过期 →
  401）时，运行会以 `mcp_credential_unavailable` 失败，不会静默降级。
- **环境变量**：`GUANLAN_MCP_URL`（必填，https）、`GUANLAN_MCP_TOKEN_FILE` 或 `GUANLAN_MCP_TOKEN`
  （二选一）、`GUANLAN_MCP_AUDIENCE`、`GUANLAN_MCP_TIMEOUT_SEC`、`GUANLAN_MCP_ALLOW_WRITE`、
  `GUANLAN_MCP_PROXY`（显式出网代理；**不**继承 `RESEARCH_HTTPS_PROXY`）。
- **排障顺序**：`401` → 先看令牌是否过期（重签），再确认 Worker 的 JWKS 变量指向当前发布地址；
  `503` → Worker 变量非法（如 issuer 非 https），不是令牌问题；`UND_ERR_CONNECT_TIMEOUT` → 出网路径，
  检查 `GUANLAN_MCP_PROXY`。

## 6. 未覆盖与风险

1. **写工具未验收**：`guanlan_news_decide` 仅在 `GUANLAN_MCP_ALLOW_WRITE=1` 时暴露，未做真实读+写
   +CAS 的端到端验证（本卡只读范围）。
2. **真实长 run 跨 TTL**：用可注入时钟的单测覆盖，没有在真实网关上跑几分钟去"顺便验证"（避免把
   TTL 失败与网络失败混在一起）。
3. **runId 形态**：本分支继承 `dev`，运行时自生成 UUID；`r-…` 形态来自另一分支的改动，合并后一致。
4. **`dev` 上两条 Windows-only 既有失败**（`resolveRunsRoot` 的 POSIX 路径、`REPO_ROOT` 跨盘
   `relative`）与本卡无关，修复在另一分支；Linux CI 不受影响。
5. **模型在无工具时会输出伪工具标记**（如 `||DSML|| invoke bash`）：本卡用 `mcp_server_unavailable`
   把这种运行判为失败，但"模型自己编造工具调用文本"属于模型行为，长期需在提示词/供应商层面收敛。

## 7. 验证命令

```bash
npm test                     # 全仓；本卡新增 18 条（15 单测 + 3 集成）
npm run test:mcp             # 仅 AGT-038
npm run mcp:probe            # 真实端点：连接 + tools/list（不调模型）
npm run mcp:live             # 真实模型 + 真实 MCP：--mode=happy|expired|forged|audience-mismatch
```

`mcp:live` 需要 `GUANLAN_MCP_URL`、`GUANLAN_MCP_TOKEN_FILE`（或 `GUANLAN_MCP_TOKEN`）、
`GUANLAN_MCP_PROXY`（如需代理）与模型环境变量；证据只输出指纹与脱敏投影，uuid 一律 `<uuid>`。
