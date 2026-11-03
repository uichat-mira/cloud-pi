# AGT-035 · 真实飞书协作场景下的目标识别与多目标汇报

> 状态（2026-11-03）：目标识别层、离线测试与真实飞书 Live 证据已完成；
> 三轮真实研究/投递证据已归档；证据脚本随后补强了私聊 challenge、报告成功判据与消息 ID 脱敏。**未合并、未部署、未关 Issue。**
> 基线 `dev@1a584e4`；本轮改动全部落在新文件（`src/delivery/targets.mjs`、
> `tests/agt-035-*.mjs`、`scripts/agt-035/`、本文件、`poc/evidence/`），
> 未修改 `src/scheduler/`、`src/api/`、`src/channels/`、`src/research/` 任何已合并模块。
> 环境：Windows 11（Build 26100）、Node `v24.9.0`、`@larksuiteoapi/node-sdk@1.76.0`。

## 1. 范围

AGT-033 已能"把一次研究的终态投递到一个或多个 `deliveryTargets`，并为每个
`runId + destination` 独立记录结果"，AGT-034 已能通过本地管理 API 按目标读回投递
事实。两张卡都刻意不回答一个问题：**这些 target 是谁、从哪来**。

AGT-035 只补这一层，并且不碰任何已合并合同：

```text
真实飞书事件（谁真的私聊过机器人）
机器人已有会话（im/v1/chats，只读）
受控允许名单（FEISHU_ALLOWED_CHAT_IDS）
        → resolveTargets()
        → { type, id, label } → schedule.deliveryTargets（既有合同）
        → AGT-033 coordinator 投递并逐目标落盘
        → AGT-034 GET /v1/runs/:runId/delivery 逐目标读回
```

裁决要求的六点对应关系：

| 裁决 | 落点 |
| --- | --- |
| 1 不再限制单一私聊/单收件人 | 复用 AGT-033，一次运行 2 个目标 |
| 2 维护者企业 + 老会长实际协作会话 | 机器人已在「东热战神」群，平台会话列表实证 |
| 3 个人私聊与群聊 | `open_id` 与 `chat_id` 两类目标并列解析 |
| 4 不要求手工提供 id | 群来自会话列表、私聊来自真实事件；无手工输入 |
| 5 用真实事件/已有会话/授权配置识别 | 三者同时参与，且各有 provenance |
| 6 机器人不在群 → 提示邀请 | `bot_not_in_chat` + `invite_bot`，绝不伪造 chat_id |

## 2. 目标解析规则（全部 fail closed）

`resolveTargets()` 是纯函数；唯一的 I/O 是 `listBotChats()` 的只读分页请求。

- **群目标**：必须同时满足「平台会话列表里有这个 chat」与「该 chat_id 在受控名单里」。
  名称只是检索键，**名称永远不会被当作 id**；把 `oc_…` 直接当群名会得到
  `bot_not_in_chat`，不会产生目标。
- **未入群**：`{ reason: "bot_not_in_chat", action: "invite_bot" }`，提示维护者邀请机器人。
- **重名群**：`chat_name_ambiguous`，不猜。
- **已入群但未授权**：`chat_not_authorized`，拒绝（不广播）。
- **私聊目标**：必须「真实 p2p 事件观察到该 sender」**且**「维护者显式确认」；
  只观察到未确认 → `open_id_not_confirmed`；只确认未观察到 → `open_id_not_observed`
  （不凭空造人）。Live 脚本还要求 `--confirm-dm` 操作者 opt-in，并让目标账号发送本次运行
  随机生成的一次性 challenge；任意窗口期私聊不会被误认成目标。
- 目标数量上限与 AGT-033 一致（10），重复目标按 `type:id` 去重。

`listBotChats()` 分页有界（默认 50/页、最多 5 页），业务错误直接抛出
（`chat_list_failed`），绝不把"读不到"当成"没有群"。

## 3. 配置

| 名称 | 作用 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书自建应用凭证 | `.env`，不入库、不打印 |
| `FEISHU_ALLOWED_CHAT_IDS` | 受控群允许名单 | 群目标必须命中 |
| `FEISHU_BOT_OPEN_ID` | 可选；运行时也可自动解析 | 群 @ 判定用 |
| `RESEARCH_HTTPS_PROXY` | **仅研究工具**的出网代理 | 未设置时研究工具直连 |

## 4. Live 证据（三轮，均为真实网络与真实飞书）

证据文件：`poc/evidence/agt-035-live-collaboration.jsonl`（脱敏；无原始 id、无凭证）。

### 4.1 第一轮：目标识别成立，研究被网络卡死

- 会话发现：机器人已加入 1 个群「东热战神」（`oc_09e…5daf`），`hasMore=false`。
- 真实私聊捕获：`observed=true`，等待 122.9s，事件 sender `ou_f7a…81a5`。
- 目标解析：2 个目标、0 unavailable、0 rejected，provenance 分别为
  `bot_chat+controlled_allowlist` 与 `p2p_event+explicit_confirmation`。
- 唯一一次研究：`timeout`，482,031ms（预算 480,000ms）。工具记录显示 2 次搜索、
  1 次读页成功后，第 4 次读页在截止时仍在飞行中；根因是**本机直连外网站点不稳定**
  （同机探测：`news.ycombinator.com` 直连 `CONNECT_TIMEOUT`）。
- 投递：2/2 `sent`，`deliveryKind=status`——只发「研究超时」通知，**没有伪装成报告**。

### 4.2 第二轮：真实研究报告投递到两个目标

- 研究层加 `RESEARCH_HTTPS_PROXY=http://127.0.0.1:1080`（只作用于研究工具，飞书直连）；
  预算收紧为 `maxSearches=5`、`maxPages=8`、`maxRuntimeMs=300000`。
- 研究：`completed_with_errors`（`partial`），85,938ms，13 次工具调用全部成功，
  报告 7,472 字符，用量 89,628 tokens，错误码 `model_error`（后续模型轮次失败）。
- 投递：2/2 `sent`，`deliveryKind=report_partial`；长报告按分段上限各发 2 段
  （本轮共 4 次发送调用），每目标 `attempts=1` 且各有独立消息回执；原始 Feishu message ID 不进入仓库证据。
- 幂等：同一终态重放两次，发送计数 `4 → 4`，零新增。
- 管理 API：`GET /v1/runs/:runId/delivery` 200，逐目标读回 `status/attempts/
  deliveryKind/messageId`；读回期间发送守卫触发 **0** 次。

### 4.3 第三轮：只投群、脚本自校验全绿

- 目标：`--group-only`，1 个目标（群），无需维护者再发私聊。
- 研究：`completed_with_errors`，86,076ms，报告 7,748 字符，114,923 tokens，
  错误码 `budget_exceeded`（token 预算到顶，不是网络或工具失败）。
- 投递：1/1 `sent`，`deliveryKind=report_partial`，2 段，`attempts=1`。
- 幂等：`2 → 2`；管理 API 读回 200 且 `ok=true`、`deliveryCapability=true`。

**触发方式边界**：这三轮 Live 使用一次性 schedule + `scheduler.runNow()` 手动启动，目的是验证真实研究后的多目标投递；它们不声称验证 Scheduler 的定时 tick。Scheduler 定时触发属于 AGT-030 已有运行时测试范围，不在 AGT-035 目标解析合同内。

**结论**：当前研究循环的稳定终态是 `partial`（模型持续研究直到预算/轮次边界，
而不是自行 finish），因此 `partial` 是这一路径的诚实常态，不是偶发异常；
要拿到 `completed` 全绿样本需要先改研究层的收尾指令，属 AGT-028 范围。

## 5. 复现

```bash
# 离线单测（目标解析与 Live 证据合同，无网络）
npm run test:targets

# 真实链路（如启用私聊目标，需从目标账号发送脚本打印的一次性验证码）
RESEARCH_HTTPS_PROXY=http://127.0.0.1:1080 \
  node --env-file-if-exists=.env scripts/agt-035/live-collaboration-evidence.mjs \
  --group-name 东热战神 --confirm-dm --wait-dm-seconds 300 \
  --max-searches 5 --max-pages 8 --max-runtime-ms 300000 \
  --topic "研究最近 48 小时 AI Agent 工程进展"
```

脚本只投递给解析出的目标；如果机器人不在该群，脚本在**不发送任何消息**的前提下
报 `bot_not_in_chat` 并中止。

## 6. 未证明 / 已知限制

- 本轮三份样本均为 `partial`（`model_error` / `budget_exceeded`），尚无 `completed`
  全绿样本；报告内容完整可读，状态标注如实反映失败轮次。
- 三轮 Live 早于一次性 challenge 加固；前两轮使用启动前 `--confirm-dm`，没有把确认绑定到特定 sender 的随机 challenge。新脚本已要求 challenge 精确匹配，离线测试覆盖该边界；为避免再次消耗真实研究预算/重复发送飞书消息，本轮不重跑 Live，故 challenge 的真实租户验证仍是明确的验证缺口。
- 出网依赖代理：直连外网会超时并把运行预算耗尽；这是环境事实，不是本卡代码路径，
  但复现 Live 研究时必须显式设置 `RESEARCH_HTTPS_PROXY`。
- 研究卡点未在 `src/research/` 侧定位（该模块已合并，本卡未修改）：需要单独缺口卡
  确认单请求 15s 上限为何会被一次读页越过。
- `GET /v1/schedules` 返回原始 `deliveryTargets` id（loopback、无鉴权），
  与 `/runs/:id/delivery` 的脱敏视图口径不一致；属证据卫生观察，未改 AGT-034。
- 未做生产多实例 exactly-once；未部署、未合并、未关闭 Issue。

## 7. 安全

- 事件文本、一次性 challenge、原始来源 id 与原始 Feishu message ID 不进入仓库证据；证据只保留 masked id、状态与计数。
- 私聊目标必须同时满足 `--confirm-dm` 操作者 opt-in、真实 p2p user 事件及本次运行的一次性 challenge 精确匹配；未匹配事件不会成为目标。未授权群一律拒绝。
- `.env` 只读；本轮仅向进程注入 `RESEARCH_HTTPS_PROXY`，未改写任何持久化环境变量。
