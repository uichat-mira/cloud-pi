# 首轮外审记录 — Draft PR cloud-auth#134 / cloud-mcp-guanlan#27 / cloud-pi#21

- 审阅人：`verifier`（团队任务 t16）
- 时间：2026-11-04
- 对象快照（各 PR 当前 head）：

| 仓库 | PR | 分支 | head SHA | base |
| --- | --- | --- | --- | --- |
| `uichat-mira/cloud-auth` | [#134](https://github.com/uichat-mira/cloud-auth/pull/134) | `feat/gln-013-guanlan-consumer-credential` | `17b33c19` | `dev` @ `481767f` |
| `uichat-mira/cloud-mcp-guanlan` | [#27](https://github.com/uichat-mira/cloud-mcp-guanlan/pull/27) | `feat/gln-014-real-token-mcp` | `5ff6bf5c` | `dev` @ `fbaecaa` |
| `uichat-mira/cloud-pi` | [#21](https://github.com/uichat-mira/cloud-pi/pull/21) | `docs/agt-03x-acceptance-baseline` | `80a28d1` → `7765f92` | `dev` @ `8efc250` |

## 0. 方法与边界

- **不改任何代码、不合并、不关闭 Issue**。本轮只读：`git clone --depth 1 -b <head>` 到仓库外的临时目录，逐条比对文档里的 `path:line`，并独立重跑文档声称已跑过的命令。
- 六项检查：①Draft / 目标分支 / Issue 关联 / dsh badge；②变更面是否越界；③`file:line` 是否真实（每份文档抽 ≥10 条，实际 56 与 58 条）；④证据是否脱敏；⑤CI 宣称与实际是否一致；⑥跨仓库断言（`consumer_id` / `audience` / `scope`）两侧是否一致。
- 「可复核」的含义：本文每条判定都附命令或行号，第三方按 §4 重跑即可得到同样结果。复核脚本与检查清单随本次提交入库（`scripts/review/file-line-check.mjs`、`scripts/review/*-claims.json`），**不被任何产品代码或测试引用**。

## 1. 判定汇总

| PR | 判定 | 阻断项 | 依据 |
| --- | --- | --- | --- |
| cloud-auth **#134** | **needs_revision** | 1 项 medium（F-134-1：一条标【事实】的绝对化断言与仓库事实不符） | §2、§3 |
| cloud-mcp-guanlan **#27** | **pass** | 无（1 项 low 建议） | §2、§3 |
| cloud-pi **#21** | **pass**（自查，非独立复审） | 无（1 项 low 已在本轮修复） | §2、§3 |

三份交付的**共同优点**：都把「未跑」「无真实凭证」「不能证明什么」写在显眼位置，没有把 fixture 或离线结果冒充真实链路；两份契约盘点文档的 `path:line` 抽样**零错误引用**。

## 2. 六项检查逐项结果

### 2.1 纪律面（Draft / 目标分支 / Issue / badge / 越界）

| PR | Draft | 目标分支 | Issue 关联 | dsh badge | 变更文件 | 越界 |
| --- | --- | --- | --- | --- | --- | --- |
| #134 | 是 | `dev` | 正文「Issue #129 / #128 参考」（无 `Closes`/`Refs` 关键词，见 F-134-3） | 有 | 1 个：`docs/engineering/gln-013-auth-readiness.md` | 无（未动 `src`、迁移、配置） |
| #27 | 是 | `dev` | 正文显式「关联 Issue：#26 [GLN-014]」 | 有 | 3 个：`docs/engineering/gln-014-contract-recon.md`、`scripts/gln-014-contract-probe.mjs`、`tests/gln014-contract-entry.ts` | 无（未动 `src/**`、`package.json`、`wrangler.jsonc`、`migrations/**`）；探针与打包入口是卡内「契约盘点 + 探针」的一部分，PR 正文已声明 |
| #21 | 是 | `dev` | 无（`cloud-pi` 没有本卡对应的 Issue，PR 正文说明理由；措辞已按 F-21-1 更新） | 有 | 2 个：两份 markdown | 无（未动 `src/**`，`git diff --stat` 仅 `+` 文档） |

### 2.2 CI 宣称与实际

| PR | 实际 run / 结论 | 与文档宣称是否一致 |
| --- | --- | --- |
| #134 | run `41674544974`：T1 Unit / T2 Contract / T3 Runtime / Static / Docker Runtime / Mira Gate 全 `success`；SonarCloud `success`；CodeRabbit `skipped` | 一致。正文与文档都没有宣称产品测试通过是本卡的证据（文档 §9 明写「未执行任何测试，引用测试文件只是现状覆盖」） |
| #27 | run `41674550969`：`Repository Contract`（job 内执行 `bash scripts/check.sh`）/ `Branch Policy` / `Mira Gate` 全 `success` | 一致。文档 §0 明确写 `bash scripts/check.sh` **本机未执行**、CI 是权威环境 —— 而 CI 确实跑了并绿 |
| #21 | `80a28d1` 上 `test` job `success`、SonarCloud `success`；`7765f92`（本轮校准）CI 另行重跑，判定以最终 head 为准 | 一致。PR 正文只列本机实测数字，未把 CI 当验收 |

> 没有任何一份交付把「未跑的测试」写成通过。

### 2.3 `file:line` 抽样（机器核对 + 人工复核）

| PR | 机器核对 | 结果 | 人工复核 |
| --- | --- | --- | --- |
| #134 | 56 条 | 55 pass / 1 fail | 唯一 fail（`A50`）是断言口径问题：文档引用 `apps/api/tests/unit/service-credential-contracts.test.ts:36`，该行是 `describe("service credential shared contract", () => {`，作为「参照该契约测试」的锚点**成立**。→ **0 处错误引用** |
| #27 | 58 条 | 52 pass / 6 fail | 6 条全部是正则过窄，人工逐条核对后**位置与含义都成立**：`config.ts:41-43`（`issuer`/`tokenIssuer` 类型注释正是「发现 URL ≠ JWT iss」）、`config.ts:98-103`（`scopes = MCP_REQUIRED_SCOPES ?? GUANLAN_REQUIRED_SCOPE`）、`auth.ts:77-79`（`catch { throw invalidToken() }`）、`server.ts:313`（`maxRequestBodySize: MAX_REQUEST_BODY_BYTES`）、`server.ts:136-246`（3 次 `registerTool`，工具名走常量 `NEWS_TOOL_NAME` 等）、canary 文档 `:4,20,127`（Cron 关闭 / 只暴露 `/health` / 只执行 `0001`+`0002` 分别在第 4、20、127 行）。→ **0 处错误引用** |
| #21 | 自查 | 文档引用的两处失败断言（`tests/research-store.test.mjs:52`、`research-verify-adapter.test.mjs:202`）与实跑输出一致；`/v1` 路由数 15 与 `src/api/router.mjs` 一致 | — |

复核命令见 §4.1，可对任意 checkout 重跑。

### 2.4 脱敏

对三份交付做了严格模式扫描（`eyJ` 开头的 JWT、`sk-` 长串、`-----BEGIN`、`Bearer ` 后接 20+ 字符、`ou_`/`oc_`/`om_`/`on_`/`cli_` 长值、完整 UUID）：**零命中**。

- #27 新增的探针在**运行时**用 `generateKeyPair("EdDSA", { crv: "Ed25519" })` 生成密钥对（`scripts/gln-014-contract-probe.mjs:130`），仓库内没有私钥材料；打印的 `account-probe` / `consumer-probe` 是合成标识。
- #134、#21 均只含文档，无任何标识或密钥。
- 备注：#21 的矩阵与基线文档里出现本机路径（`D:\cloud-pi-wt\*`、`%TEMP%`）；这不是凭证，但按「证据只写白名单投影」的口径，后续证据文件建议改写成相对路径。

### 2.5 【事实】/【拟变更】/【未验证】三分是否诚实

| 交付 | 结论 |
| --- | --- |
| #134 | 基本诚实：全文没有把未核实的东西标成【事实】，第 9 节明确「未执行任何测试」。**但**第 16 行一条【事实】是绝对化断言且不成立（F-134-1）。另：第三档用的是【待确认】而非【未验证】，全文无一处【未验证】（F-134-2） |
| #27 | 诚实：每行带「已验证 / 未验证」，第 8 节专列「本文没有证明什么」，fixture 与真实链路分得很清。仅第 28–30 行的「探针实测拒绝」高估了探针覆盖面（F-27-1） |
| #21 | 诚实：§0 写清能/不能证明什么，§6 逐项列未执行项与原因，验收矩阵新增 §0 执行闸门把依赖凭证的行统一标「凭证就绪后执行」 |

### 2.6 跨仓库断言（`consumer_id` / `audience` / `scope`）

以下为两侧**实际代码**对照（不是两份文档互相引用）：

| 字段 | cloud-auth 现状 | Guanlan 验证器实际行为 | 一致？ |
| --- | --- | --- | --- |
| `iss` | `mira:cloud-auth`（`packages/contracts/src/service-credential.ts:8`） | `jwtVerify({ issuer })` 精确匹配 `mira:cloud-auth`（`src/mcp/auth.ts:69`、`src/mcp/config.ts:23`） | 一致 |
| `aud` | 封闭枚举两值（`:13-16`）；无 guanlan audience | 只接受 `mira:cloud-guanlan` 或精确等于 `/mcp` 资源 URL（`src/mcp/config.ts:88-96`）；Shiyan/Relay audience 被拒（探针第 3、4、7、12 条） | 一致（GLN-013 需新增） |
| `scope` | `z.tuple` 单值数组（`:92-114`） | 接受数组或空格分隔串，逐项校验；读 `guanlan.read`、写 `guanlan.write`（`src/mcp/auth.ts:41-55`、`config.ts:10,18`） | 一致（形状兼容，无需改编码） |
| `consumer_id` | **缺失**，且 `.strict()` 会拒绝额外 claim（`:60-114`） | 必需，默认 claim 名 `consumer_id`，缺失或非字符串即 401（`auth.ts:82-86`、`config.ts:105-106`） | 已知缺口，两份文档都单列为待裁决项 |
| `device_id` | 必需 | 不读 | 兼容（Guanlan 忽略额外 claim） |

结论：两份契约盘点文档在三个关键字段上**互相一致且与两侧代码一致**；`consumer_id` 的取值语义（账号 / 设备 / 新建归属表）两侧都标记为「待维护者裁决」，没有任何一侧私自扩张 audience 或 scope —— 符合组织纪律第 8 条。文档层面还标注了「交叉核对：未验证（待回执）」，与实际状态相符。

## 3. Findings

### F-134-1（medium，阻断）— cloud-auth#134 `docs/engineering/gln-013-auth-readiness.md:16`

- **问题**：`【事实】Cloud Auth 完全没有 consumer 概念：全仓库 `consumer` 只出现在一处测试注释。`
- **事实**：`\bconsumer\b` 在 `17b33c1` 的命中为 —— 产品侧注释 `apps/web/src/lib/auth/store.ts:30`、测试注释 `apps/api/tests/unit/service-credential-keyring.test.ts:128`，以及既有文档 `docs/service-credentials-v0.md:5,227,229,231,256,260,263,265,267,276,280`、`docs/host-grants-v0.md:11,272,275`、`README.md:105`、`docs/ui/current-ui-audit.md:60`。
- **影响**：这是唯一一条被标为【事实】的绝对化断言，而它不成立。更要紧的是 `docs/service-credentials-v0.md:227-231` 已有面向 consumer 的验证规则章节 —— 这正是 GLN-013 应当对接的既有口径；断言「完全不存在」会把读者导向「重新设计」，而实际是「沿用并扩一个 claim」。
- **修复要求**：改成可核对表述，例如「无 `consumer_id` claim、无 consumer 表、无服务端 consumer 逻辑；`consumer` 一词仅出现在 1 处产品注释（`apps/web/src/lib/auth/store.ts:30`）、1 处测试注释与既有文档的 consumer 规则章节（`docs/service-credentials-v0.md:227-231`）」，并在 §5 引用该章节。
- **不影响**：实质结论（缺 claim / 缺表 / 需裁决语义）成立，修复成本是一段话。

### F-134-2（low）— 同文档第 6–7 行「阅读方式」

- **问题**：团队口径的三分是【事实】/【拟变更】/【未验证】，文档用【待确认】替代第三档，全文没有一处【未验证】。
- **影响**：【待确认】既可读成「已核实、待裁决」，也可读成「尚未核实」，跨仓库断言上容易误读。
- **修复要求**：保留【待确认】用于「事实已核实、取值待裁决」的条目，另给「无法本地核实」的条目补【未验证】；或在阅读约定里一句话说明二者区别。

### F-134-3（low）— PR #134 正文首段

- **问题**：Issue 关联写作「Issue #129 / #128 参考」，没有 `Closes`/`Refs` 关键词。GitHub 会自动链接，但机械校验（grep `Refs|Closes`）识别不到，也让「PR 是否关联 Issue」无法自动判定。
- **修复要求**：改为 `关联 Issue: #129（GLN-013 契约）；背景: #128（GLN-012）`。

### F-27-1（low，不阻断）— cloud-mcp-guanlan#27 `docs/engineering/gln-014-contract-recon.md:28-30`

- **问题**：「今天**不存在**任何 Cloud Auth 签出的令牌能通过 Guanlan 验证器（探针实测拒绝）」把两类证据合在一起：探针实测的是「用本地 Ed25519 密钥伪造的 Shiyan 形状 claims 被拒」，不是真实 Cloud Auth 令牌。
- **影响**：结论本身由 claims 形状可推断成立，但「实测」二字让证据强度看起来高于实际；这正是外审要抓的「声明 > 证据」类型，只是程度轻微。
- **修复要求**：改为「由 claims 形状推断成立：Cloud Auth 无 guanlan audience 签发路径；探针进一步验证 Shiyan/Relay audience 与缺 `consumer_id` 的令牌被拒」。§0 与第 8 节「无真实令牌」的表述已正确，无需改。

### F-21-1（low，已在本轮修复）— cloud-pi#21 正文「关联 Issue」段

- **问题**：原文「`cloud-pi` 当前没有对应 Issue（open 仅 #13 AGT-031、#10 AGT-030）」已过时：现有 4 个 open issue（#10、#13、#22 AGT-036、#24 AGT-037）。
- **修复**：更新正文，说明 #22/#24 属实现卡、不是本卡的 Issue；本卡仍无对应 Issue。

## 4. 可复现证据

### 4.1 `file:line` 抽样

```bash
# 取各 PR head（只读，仓库外临时目录）
git clone --depth 1 -b feat/gln-013-guanlan-consumer-credential https://github.com/uichat-mira/cloud-auth.git
git clone --depth 1 -b feat/gln-014-real-token-mcp            https://github.com/uichat-mira/cloud-mcp-guanlan.git

node scripts/review/file-line-check.mjs <cloud-auth checkout>         scripts/review/cloud-auth-claims.json
# → {"summary":{"total":56,"pass":55,"fail":1}}   ← 1 条为 F/§2.3 所述的锚点口径问题，人工复核成立
node scripts/review/file-line-check.mjs <cloud-mcp-guanlan checkout>  scripts/review/cloud-mcp-guanlan-claims.json
# → {"summary":{"total":58,"pass":52,"fail":6}}   ← 6 条为正则过窄，逐条人工核对位置与含义均成立
```

### 4.2 独立重跑 #27 声明的命令

| 命令 | 本轮结果 | 与 #27 文档宣称 |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | `added 181 packages in 5s` | 一致（文档写 `added 181 packages`） |
| `npm run typecheck` | exit `0`，1.9 s | 一致 |
| `node scripts/gln-014-contract-probe.mjs` | **18 PASS**，末尾 `18/18 contract expectations held.`，exit `0`，0.2 s | 一致（文档写「18/18」） |

探针 18 项覆盖：常量、配置默认值、Shiyan/Relay audience 被拒、缺 JWKS 失败、`/mcp` 资源 URL 作 audience、Shiyan 形状令牌被拒、缺 `consumer_id` 被拒、带 `consumer_id` 被接受、数组/空格串 scope、空 `sub`/空 consumer/畸形 scope/过期/未知签名密钥被拒。

### 4.3 脱敏扫描

```bash
node -e "…eyJ|sk-|-----BEGIN|ou_|oc_|cli_|Bearer+20… 严格模式扫描三份交付…"
# → 三份均 CLEAN
```

### 4.4 CI 与元数据

- #134 check runs：`41674544974`（T1 Unit / T2 Contract / T3 Runtime / Static / Docker Runtime / Mira Gate）、SonarCloud —— 全 `success`。
- #27 check runs：`41674550969`（Repository Contract / Branch Policy / Mira Gate）—— 全 `success`；`Repository Contract` 的 job 内执行 `bash scripts/check.sh`。
- 三个 PR 均为 `draft: true`、`base.ref = dev`、`mergeable_state = clean`。

## 5. 未覆盖与局限

1. 只覆盖三个 PR 的**当前 head**；后续 commit 需要重审（尤其 #134 修复后）。
2. 机器核对验证的是「引用行存在且内容与断言同类」，**语义级判断仍是人工抽样**（每份文档 10 条以上，但非全量逐行）。
3. 未审 SonarCloud 告警明细；未在本地跑 cloud-auth 的 `pnpm` 测试（该仓库本轮只读，且 CI 已跑 T1/T2/T3）。
4. 未把 #134 的 GLN-013 草案与 Issue #129 正文逐条对照（只核对了与代码有关的事实）；Issue 文本一致性属于 auth-dev 与维护者的契约责任。
5. #21 是我自己的 PR，**自查不等于独立复审**，建议 lead 或另一名成员在合并前做一次独立确认。

## 6. 后续动作

| 对象 | 动作 | 责任人 |
| --- | --- | --- |
| F-134-1（medium） | 修改 `gln-013-auth-readiness.md:16` 的表述并引用既有 consumer 规则章节 | auth-dev |
| F-134-2 / F-134-3（low） | 标签体系统一 + PR 正文 `关联 Issue:` 写法 | auth-dev |
| F-27-1（low） | 「探针实测拒绝」措辞收敛 | guanlan-dev |
| F-21-1（low） | 已在本轮更新 PR 正文 | verifier |
| 复审 | #134 修复后重审该文档 §1/§5 | verifier（待 lead 派单） |
