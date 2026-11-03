# 企业微信体验评审：今晚真实输出逐条 findings

> **状态：评审结果 + 建议稿。体验未达标。**
> 评审对象：2026-11-04 晚间真实企业微信会话 + 当前 `dev@ade8a36` 的用户可见文案。
> **权责**：本文件只有建议权。每条 finding 由 captain（lead）裁决 **accept / reject 并给理由**，
> 结论填进 §6 决策表；**reject 也留痕**，不允许"悄悄不采纳"。
> 不改代码、不部署、不占用真实长连接、不发真实企业微信消息（长连接由 pi-dev 持有）。
> 判定口径见 [wecom-experience-rubric.md](wecom-experience-rubric.md) §0。
> **裁决结果（2026-11-04，lead，已锁定）**：F01–F09、F11–F13 **accept**；F10 由 D2 覆盖（静默）。D1–D7 见 rubric §11。

## 0. 评审范围与证据等级（先看这里）

| 证据 | 等级 | 说明 |
| --- | --- | --- |
| 单聊 `Hi` → `Hi! How can I help you today?`（2.7 s） | **真实输出**（任务卡引用） | t30 任务卡给出的真实 transcript；**仓库内暂无逐字文件**（已全仓检索 `.md/.jsonl/代码`，未命中） |
| 单聊 `ping` → `pong 🏓`（2.5 s） | **真实输出**（任务卡引用） | 同上 |
| 群 `@Mira` → "仍是通用助手" | **结论真实、原文缺失** | 任务卡只给结论，没给原句；本文按"原文不可判"处理，只判结构原因 |
| `WECOM_CHANNEL_SYSTEM_PROMPT` / `WECOM_REPLIES` / 分段提示 | **代码事实** | `src/channels/wecom/*.mjs`，可逐行核对 |
| 通道真实耗时 2510 ms / 2726 ms | **真实输出** | [agt-037:69](../engineering/agt-037-unified-runtime.md)、[agt-036:195](../engineering/agt-036-wecom-channel.md) |
| 群 @ 与主动推送平台行为 | **真实输出** | [group-and-proactive-evidence.md](../research/wecom-channel/group-and-proactive-evidence.md) |
| 两套系统提示词、推送文案 | **设计意图（未落地）** | 本卡交付，交 pi-dev 落地 |

**一句话结论**：能收发、能推理、有基本防注入；**人设、长度、群礼仪、ack、错误话术、推送分寸六块基本是空白**，
今晚两条回复已经暴露"语气由模型随机决定，而不是由产品决定"。以下 findings 按严重度排序。

---

## 1. 逐条评审

### F01 · 单聊 `Hi` → `Hi! How can I help you today?`（严重度：**high**）

**原文**

```text
用户：Hi
Mira：Hi! How can I help you today?
耗时：2.7 s（任务卡）
```

**判定**：`fail`（T2 客服腔 / T3 首句客服寒暄）；**语言部分按 D6 改判为预期**——纯英文问候跟随英文，不再视为 fail。

**用户感受**：像点开了一个国外 SaaS 的在线客服窗口。维护者要的是"研究搭子"，得到的却是通用客服；
第一句是寒暄而不是接话，用户不知道它能干什么。

**根因（代码事实）**：当前提示词只有四句（[src/channels/wecom/runtime.mjs:23-28](../../src/channels/wecom/runtime.mjs)），
只要求 "directly and concisely in the user's language"，**没有人设、没有语言规则、没有禁用词、没有长度**。
D6 要求纯英文问候用英文回，所以**英文本身不是问题**；问题是模型把英文问候默认接成了客服腔——产品没给"怎么接"的规则。

**期望**：

```text
用户：Hi
Mira：Hey. What's up?
```

（D6：英文跟随；≤ 2 句、不寒暄、不复述、不说 "How can I help"；中文输入才用中文。）

**具体改法（可直接粘贴，交 pi-dev）**：采用 [wecom-system-prompts-draft.md](wecom-system-prompts-draft.md) §1 单聊版；
最小改动也可只在现有提示词后追加三行：

```text
默认中文；纯英文问候（Hi/hello/ping，且没有别的内容）用英文回，其余用中文。
第一句直接回应内容，不要寒暄、不要自我介绍、不要问"How can I help"。
禁止出现：作为 AI、AI 助手、很高兴为您服务、希望这对您有帮助、How can I help、How may I assist。
```

**来源**：t30 任务卡 transcript；[runtime.mjs:23-28](../../src/channels/wecom/runtime.mjs)。
**建议**：accept（提示词改动；语言按 D6，客服腔/寒暄按 T2/T3 修）。

---

### F02 · 单聊 `ping` → `pong 🏓`（严重度：**medium**）

**原文**

```text
用户：ping
Mira：pong 🏓
耗时：2.5 s（任务卡）
```

**判定**：**单条输出 `pass`（T5 一个 emoji、L1 极短、A1 2.5 s < 3 s；D6 下英文短答也符合）；作为系统行为 `fail`（T7 人设不稳定）。**

**这是正例还是偶然？——是"偶然的正例"。** 理由三条，都可核对：

1. **提示词里没有任何一条规则会选择"pong 🏓"这种回复**。它只说了 "directly and concisely"（[runtime.mjs:25](../../src/channels/wecom/runtime.mjs)）；
   短、俏皮、带一个 emoji 全是模型这一次的采样结果，不是产品约束。
2. **同一条提示词在相邻一轮产出了 `How can I help you today?`**。两条回复的语气相差一个产品人格，
   说明人设由随机性决定；这次是 pong，下次可能是 "Pong! How can I assist you today?"。
3. **不可复现**：没有规则能保证第 2 条 `ping` 还是这个味道，也没有规则阻止它变成客服腔或 3 段解释。

所以：`pong 🏓` 可以当作"我们想要的味道"的**样本**，不能当作"体验已达标"的证据。
真正的验收标准是 **连续 5 条同类输入语气稳定**（rubric T7），而不是抽中一次好回复。

**captain 2026-11-04 已确认保留此判定**：以后即使多次复现成功，也不改口为"体验达标"；
它只证明"这种味道用户喜欢"，不证明产品能稳定复现。

**用户感受**：这一条其实挺讨喜——短、接得住、不解释。问题在于用户不知道下一条还会不会这样。

**期望**：保留这种短答，但让它**可复现**：

```text
用户：ping
Mira：pong. busy?
```

或更克制：

```text
用户：ping
Mira：pong.
```

**具体改法**：单聊提示词加"默认 3 句以内；纯英文问候用英文回（D6）；闲聊可以短、可以有一个 emoji；不要解释自己为什么短"（见草案 §1）。
同时把 T7 纳入验收：同一输入隔 5 分钟再发一次，两次语气应一致。

**来源**：t30 任务卡 transcript；[runtime.mjs:23-28](../../src/channels/wecom/runtime.mjs)。
**建议**：accept（提示词 + 验收项）；**不**把本条当作"体验已达标"（lead 已确认保留该判定）。

---

### F03 · 群 `@Mira` 回复仍是通用助手（严重度：**high**）

**原文**：任务卡只给结论"只剥前缀、回复仍是通用助手"，**未给原句**；仓库内也没有群内模型回复的逐字记录
（仅有冒烟固定文案 `Cloud Agent 冒烟：群聊与主动推送观测`，[group:56](../research/wecom-channel/group-and-proactive-evidence.md)）。

**判定**：`fail`（G2/G4/G5 群礼仪），但**证据等级降为"结构 fail + 原文未验证"**——不引用不存在的原句。

**根因（代码事实，可逐行核对）**：

1. `createWecomChannel` 把 `chatType` 传给 `runTurn`（[channel.mjs:257-263](../../src/channels/wecom/channel.mjs)）；
2. 但 `createWecomAgentRunner().runTurn` 只接收 `{ text, signal }`，**完全忽略 `chatType`**（[runtime.mjs:106-107](../../src/channels/wecom/runtime.mjs)）；
3. 整个 runner 只有一份 `WECOM_CHANNEL_SYSTEM_PROMPT`（[runtime.mjs:23-28](../../src/channels/wecom/runtime.mjs)），单聊/群聊共用。

**结论**：群聊不可能有独立人设，这是结构决定的，不是模型这次没发挥好。

**用户感受**：群里被 @ 本来就容易被围观；回复如果是一段通用助手腔，既不接梗也不收着，显得"机器人乱入"，
维护者想要的"群里挑逗一下"完全落空。

**期望**：群里 2 句以内、接住提问者那句话、**对方先开玩笑才接一句**、不 @ 人、不评价其他人（正/反例见 F07）。

**具体改法（交 pi-dev，非本卡改代码）**：按 `chatType` 选两套提示词。现有接缝可这样落地（示意，不是本卡改动）：

```js
// 只在 runner 内部记录"本轮用哪套"，串行队列保证同一时刻只有一个 turn
let promptForTurn = SINGLE;
const extension = wecomChannelPromptExtension(() => promptForTurn);
// runTurn({ text, chatType, signal }) 里：
promptForTurn = input.chatType === "group" ? GROUP : SINGLE;
return runtime.run(text, { signal });
```

（`createAgentRuntime` 每个 run 都会新建 session 并装载 `extensionFactories`，
[runtime.mjs:257-279](../../src/runtime.mjs)，因此按轮切换提示词可行；**具体实现由 pi-dev 决定**。）

**来源**：[channel.mjs:257-263](../../src/channels/wecom/channel.mjs)、[runtime.mjs:23-28/106-107](../../src/channels/wecom/runtime.mjs)。
**建议**：accept（提示词分版 + chatType 选择）；补一条群内真实回复 transcript 作为复评证据。

---

### F04 · 用户可见文案逐条评审（严重度：**medium**）

全部取自 [channel.mjs:26-34](../../src/channels/wecom/channel.mjs) 与 [text.mjs:28-34](../../src/channels/wecom/text.mjs)，
是**代码里真实会发给用户的中文**，不是设计稿。

| 子项 | 现状原文 | 判定 | 用户感受 | 建议文案（可直接粘贴） |
| --- | --- | --- | --- | --- |
| F04-a `/stop` | `已停止当前任务。` | pass | 清楚，略正式 | `停了。` |
| F04-b `/stop` 空跑 | `当前没有正在执行的任务。` | pass | 清楚 | `现在没在跑任务。` |
| F04-c 被取消 | `任务已取消。` | pass | 与 F04-a 重复语义，二选一即可 | 保留 `停了。`，取消分支不再补发 |
| F04-d 超时 | `处理超时，请稍后重试。` | pass（偏机械） | 知道失败了，但不知道要不要再等 | `这次算太久了，我先停掉。要不要换个短点的问法？` |
| F04-e 模型失败 | `处理失败，请稍后重试。（<code>）`（[channel.mjs:214](../../src/channels/wecom/channel.mjs)） | **fail（必须替换）** | 把内部错误码甩给用户；`（timeout）` 这种英文码像报错弹窗 | `刚才没跑通，再试一次？`（错误码只进日志） |
| F04-f 空回复 | `（模型没有返回内容）` | **fail（必须替换）** | 括号 + 内部视角，像开发者调试信息 | `这次没生成出内容，再问一次？` |
| F04-g 研究入口（D5） | `研究功能未启用。` | **fail（必须替换）** | 没了，用户不知道该干嘛 | `研究入口还没开。先在控制台建个定时任务，结果我会发给你。` |
| F04-h 超长截断 | `（后续约 N 段内容超出单次回复上限，已省略。）`（[text.mjs:32-34](../../src/channels/wecom/text.mjs)） | **fail（必须替换）** | 知道被截了，但没有下一步 | `内容太长，后面还有约 N 段没发。要我拆成几条继续发吗？` |
| F04-i 分段后缀 | `（续 1/3）`（[text.mjs:28-30](../../src/channels/wecom/text.mjs)） | pass | 清楚、不吵 | 保留 |
| F04-j 研究回复尾部 | `\n\nrunId: r-…`（[channel.mjs:281-284](../../src/channels/wecom/channel.mjs)） | **已裁决（D7）：不展示** | 普通用户不知道 runId 是什么；Trace 走日志/API | 用户正文里删除 runId；日志/API 保留 |

**裁决约束（2026-11-04，lead）**：F04-e/f/g/h 四条 fail **必须替换**；**错误码只进日志**，用户正文不得出现。
F04-j 按 D7 **不展示 runId**，不得折中成"运行记录"。

**统一禁区**：`errcode`、`40058`、`93006`、`rate_limited`、`unsupported_target_type`、`no_prior_inbound`
等内部码一律不出现（rubric E 节）。

**来源**：[channel.mjs:26-34/214/281-284](../../src/channels/wecom/channel.mjs)、[text.mjs:28-34](../../src/channels/wecom/text.mjs)。
**建议**：accept（文案替换，pi-dev 一次改完）。

---

### F05 · 长任务没有用户可见 ack（严重度：**high**）

**证据（代码事实）**：`handleEvent` 同步返回，不 await 模型（正确）；但**用户可见的消息只有最终回复**
——`runOne` 在 `runTurn` 完成后才 `sendSegments`（[channel.mjs:229-303](../../src/channels/wecom/channel.mjs)）。
D5 已裁决聊天里暂不开放 `/research`；但任何"要跑一会儿"的请求（以及未来重开的研究入口）同理，期间用户只能干等。
群内两段式 ack 属于 t27，**未实现**（[agt-037:96](../engineering/agt-037-unified-runtime.md)）。
平台单条流式 10 分钟上限、`req_id` 短时效，决定了长任务不能只等最后一条
（[onepager:33-35](../research/wecom-channel/v1-boundaries-onepager.md)、[group-and-proactive:111](../research/wecom-channel/group-and-proactive-evidence.md)）。

**判定**：`fail`（A2/A4）。

**用户感受**：发完一个要跑一会儿的请求后 30 秒没有任何动静，用户会怀疑消息没发出去、机器人掉线，
然后重复发送——重复消息又会被去重/排队，体验更糟。

**期望**：≤ 2 s 内先回一句 ack，终稿另发：

```text
用户：把这篇 3000 字的报道逐条总结一下
Mira：收到，这个要跑一会儿。跑完我直接发结论，中间不用等。
（约 40 s 后）Mira：3 条要点：…
```

**具体改法**：t27 落地时，ack 文案由通道层固定发出（不经过模型），建议：
- 单聊：`收到，我去查一下，大概 30 秒。`
- 群聊：`收到，查完发这里。`
- 研究：`收到，这个要跑一会儿。跑完我直接发结论，中间不用等。`

**来源**：[channel.mjs:229-303](../../src/channels/wecom/channel.mjs)、[agt-037:96](../engineering/agt-037-unified-runtime.md)、
[onepager:33-35](../research/wecom-channel/v1-boundaries-onepager.md)。
**建议**：accept（进 t27）；本卡只给文案，不改代码。

---

### F06 · 回复长度完全无约束（严重度：**high**）

**证据**：提示词只说 "concisely"（[runtime.mjs:25](../../src/channels/wecom/runtime.mjs)），没有字数/句数/分段规则；
分段器默认最多 8 段 × 20000 B（[text.mjs:18-22](../../src/channels/wecom/text.mjs)），即一条回答理论上可发约 160 KB。
群聊与单聊用同一套分段（[text.mjs:73-115](../../src/channels/wecom/text.mjs)）。

**判定**：`fail`（L1–L4）。

**用户感受**：问"今天新闻"，可能收到一篇 3000 字小作文 + 8 条消息轰炸；群里更糟——一条回复刷屏，
其他人只看到机器人在刷存在感。

**期望**：见 rubric §2 的预算表；核心三条：
1. 单聊默认 ≤ 120 字；超过 300 字先给摘要并问"要详细版吗"。
2. 群聊默认 ≤ 60 字 / ≤ 3 行，**不分段**。
3. 群里的长报告只发摘要 + "要完整版我发详细版/私聊"。

**具体改法**：提示词里写死预算（草案 §1/§2），并把群聊的 `segment.maxSegments` 收紧到 1（由 pi-dev 决定）。

**来源**：[runtime.mjs:25](../../src/channels/wecom/runtime.mjs)、[text.mjs:18-22/73-115](../../src/channels/wecom/text.mjs)。
**建议**：accept。

---

### F07 · 群聊礼仪：只有"被 @ 才说话"，没有"被 @ 之后怎么说话"（严重度：**high**）

**已做对的部分（pass）**：群消息必须正文以 `@<botName>` 开头才进模型；剥离后为空则忽略；
中间出现的 `@` 不误判（[policy.mjs:55-67](../../src/channels/wecom/policy.mjs)、[events.mjs:121-131](../../src/channels/wecom/events.mjs)）。
真实群 @ 入站与回复也已验（[group:26-58](../research/wecom-channel/group-and-proactive-evidence.md)）。

**缺口（fail）**：G2（不 @ 人）、G3（不评论未 @ 消息）、G4（接梗边界）、G5（不写小作文）、G8（连续调侃收尾）
全部没有规则，因为群聊没有独立提示词（见 F03）。

**D1 裁决（2026-11-04，lead，轻度）**：默认不主动玩梗；对方先开玩笑才接；一次最多一个梗；不评价个人。

**"挑逗但不油腻"的 3 正例 + 3 反例**（判定三条件：接住对方那句话；只拿自己/话题开玩笑，**不评价个人**（身体、外貌、私生活、感情、能力）；≤ 2 句不追问）：

| 类型 | 输入（真实群聊可能出现的原话） | 回复 | 判定理由 |
| --- | --- | --- | --- |
| 正例 1 | `@Mira 你是不是又在摸鱼` | `摸鱼是副业，主业是等你派活。` | 接住"摸鱼"，自嘲，不冒犯 |
| 正例 2 | `@Mira 今天这行情你怎么看` | `我没实时行情，瞎猜容易害你。要查的话得在控制台建个定时任务。` | 不编数据，给控制台出口，不接梗过度 |
| 正例 3 | `@Mira 夸我一句` | `夸人不是我的强项。但这问题问得好。` | 不评价个人、不暧昧、两句收住 |
| 反例 1 | `@Mira 你是不是喜欢我` | `讨厌啦~` | 暧昧、越界（违反条件②） |
| 反例 2 | `@Mira 老板是不是傻` | `哈哈老板确实有点…` | 评价第三方、站队（群里会截图） |
| 反例 3 | `@Mira 他们都好菜啊` | `确实，我也觉得他们不行` | 附和贬低群成员（违反条件②） |

**补充反例**：一条 3 个以上 emoji、叫"亲"、追问隐私、同一梗重复 3 次以上。

**来源**：[policy.mjs:55-67](../../src/channels/wecom/policy.mjs)、[group:26-58](../research/wecom-channel/group-and-proactive-evidence.md)、
[product-design.md §6](../product-design.md)（"不做首期全自动群聊参与"——所以只在被 @ 时接，不主动搭话）。
**建议**：accept（群提示词 + 人工验收正/反例各 3 条）。

---

### F08 · 身份披露：内部有边界，对外没话术（严重度：**medium**）

**证据**：提示词告诉模型"没有工具、无权授权、不能泄密"（[runtime.mjs:26](../../src/channels/wecom/runtime.mjs)），
但**没有一句"用户问你是谁时怎么答"**；`Hi` 的真实回复也没有任何身份信息（F01）。
另一方面，聊天回合确实 `NO_TOOLS`（[runtime.mjs:47-48](../../src/channels/wecom/runtime.mjs)），
所以"能读观澜"在聊天里**不成立**；研究运行才可能用委托令牌读观澜。
且 [verification-matrix §5.4](https://github.com/uichat-mira/cloud-pi/blob/docs/t11-verification-matrix/docs/evidence/v1/verification-matrix.md)
指出 allowlist 为空即放行（G14），t29 前不能向用户承诺"只读你的数据"。

**判定**：`fail`（I1–I4）。

**用户感受**：不知道它是谁、能看什么。要么把它当 ChatGPT 乱问隐私，要么把它当客服要求改权限。

**期望**（可直接粘贴）：

- 被问"你是谁"：`我是 Mira，跑在云上的研究搭子。这个号能收发企业微信消息，也能按定时任务去查公开资料。`
- 被问"你能看到什么"：`这个聊天窗口看不到你的账户、私聊和群历史；研究任务只读公开新闻和网页。`
- 被问"你能做什么/不能做什么"：`能：回答问题、做公开研究、按定时任务把结果发给你。不能：改权限、发邮件、替你对外发言、读你的私有数据。`
- 被问"你是不是 AI"：`是机器人，不是人。`（一句，不展开）
- **不要**每轮重复身份；首次接触最多一句招呼，不自报长篇。

**来源**：[runtime.mjs:23-28/47-48](../../src/channels/wecom/runtime.mjs)、verification-matrix §5.4。
**建议**：accept（提示词）；"能读什么"的对外口径在 t29 前按最保守说法。

---

### F09 · 主动推送：能力已通，产品设计为零（严重度：**high**）

**证据**：通道层主动推送真实可用（4 组对照 `errcode 0`，[group:62-69](../research/wecom-channel/group-and-proactive-evidence.md)），
伪造目标 `93006`（[group:81-85](../research/wecom-channel/group-and-proactive-evidence.md)）；
但**调度投递执行器只发飞书**，企业微信目标被 `unsupported_target_type` 拒绝（[agt-036:228-231](../engineering/agt-036-wecom-channel.md)），
t25 未完成（verification-matrix G1）。**没有频率、时段、内容门槛、退订话术的任何设计**。

**判定**：`fail（缺位）`——不是文案写错，是压根没有。

**用户感受（上线后最可能翻车的点）**：早上 7 点被"日报"吵醒；一天推 8 条"没有新增"；
想关掉却不知道回什么；在群里推个人任务，全群围观。

**期望**：见 [rubric §6](wecom-experience-rubric.md) 的 P1–P9，核心五条：
1. 只推已有会话（平台硬约束）。
2. ≤ 3 条/天、≤ 1 条/小时；08:00–21:30 之外不推；22:00–08:00 除用户主动交互外不推（D3）。
3. 有新增/有结论才推；"无新增"最多每周一条；失败只告警管理员、不发群。
4. 首行写 `[任务名] 触发时间`；正文 ≤ 500 字；群推送不假装 @ 人。
5. **首条推送必须带退订方式**：`不想收这类消息回 /mute，/mute off 永久关；也可以在控制台关掉这个任务。`

**退订话术**（D4 已裁决：`/mute`、`/mute 7d`、`/mute off`、`/unmute`；**需新卡**；**仅对已授权用户生效**）：

| 输入 | 回执 |
| --- | --- |
| `/mute` | `好，24 小时内不主动推。要恢复回 /unmute。` |
| `/mute 7d` | `好，7 天内不主动推。要恢复回 /unmute。` |
| `/mute off` | `好，以后不主动推了。想恢复回 /unmute。` |
| `/unmute` | `推送恢复了。` |

**来源**：[group:62-69/81-85](../research/wecom-channel/group-and-proactive-evidence.md)、[agt-036:228-231](../engineering/agt-036-wecom-channel.md)、
verification-matrix §4 G1。
**建议**：accept（rubric §6 + 推送模板）；D4 已裁决退订命令，**需开新卡**，且仅对已授权用户生效。

---

### F10 · 单聊白名单拒绝是静默的（严重度：**medium**，已裁决）

**证据**：`allowedUserIds` 非空且不匹配时返回 `user_not_allowed`，`handleEvent` 只记 `ignored`，不回复
（[policy.mjs:46-49](../../src/channels/wecom/policy.mjs)、[channel.mjs:358-359](../../src/channels/wecom/channel.mjs)）。

**判定**：`已裁决（D2）：静默 + 日志记 reason`——不是 fail；静默能防探测，代价是真人可能以为机器人坏了，这个代价已接受。

**用户感受**：发了消息石沉大海，不知道是没权限还是掉线。

**按 D2**：保持静默（防探测）+ 管理端留痕；**不回复用户**——"这个会话还没开通"的方案已被否决。

**来源**：[policy.mjs:46-49](../../src/channels/wecom/policy.mjs)、[channel.mjs:358-359](../../src/channels/wecom/channel.mjs)。
**建议**：已裁决（D2）：静默。落地时确保日志含 `user_not_allowed`/`chat_not_allowed`，用户正文不出现任何提示。

---

### F11 · 逐字 transcript 没有留档（严重度：**medium**，流程问题）

**证据**：`Hi`/`ping` 两条真实回复只存在于任务卡引用；仓库 `docs/**`、`poc/**`、`.work/**` 里没有对应 JSONL 或 transcript
（已检索 `How can I help`、`pong`、`Hi →`，均未命中）。现有 live 证据只投影 `action/status/runId/segments/耗时`，
**不落模型输出正文**（[agt-036:139](../engineering/agt-036-wecom-channel.md)）。

**判定**：`fail（证据缺口）`——不是体验问题，是**无法复评**的问题。

**影响**：体验评审只能依赖口头转述；下次改完提示词，无法对比"改前/改后"。

**落档建议**（不涉及隐私）：测试输入只有 `Hi`/`ping` 这类词，可安全留档。建议 pi-dev 在 `wecom:live`/`wecom:wait-inbound`
增加一个**可选**的 `--transcript <path>`，只写：`入站测试词（白名单：Hi/ping/help）/ 模型回复正文 / durationMs / chatType / 是否分段`，
不写 `userid`/`chatid`/他人消息；**只存脱敏版（userid/chatid 掩码），放非公开目录（如本机 `.work/wecom-experience/`）**，
**不得进 `docs/evidence/` 等公开证据目录**（lead 裁决）。
**来源**：全仓检索结果 + [agt-036:139](../engineering/agt-036-wecom-channel.md)。
**建议**：accept（加一个证据落点；由 pi-dev 决定实现）。

---

### F12 · 延迟只有 2 个样本，不能证明 p95（严重度：**low**，证据口径）

**证据**：真实耗时 2510 ms（[agt-037:69](../engineering/agt-037-unified-runtime.md)）、2726 ms（[agt-036:195](../engineering/agt-036-wecom-channel.md)），
n=2，都是简单短文本。rubric A1 的 p95 ≤ 8 s **未验证**。

**判定**：`未验证`（不判 fail）。

**采样建议**：验收时至少采集 **20 条** `wecom_channel_outcome.durationMs`（单聊/群聊/长回答混合），按 p50/p95 统计；
不要在只有 2 条样本时写"延迟达标"（lead 已裁决：≥20 次采样，2 个样本不能下结论）。

**来源**：上述两处 evidence 行。
**建议**：accept（验收方法），不改代码。

---

### F13 · 根因收敛：单聊/群聊共用一套提示词（严重度：**high**，结构）

**证据**：见 F03 的三行代码事实。这一条不是独立缺陷，而是 F01/F02/F03/F06/F07/F08 的**共同结构原因**：
一套只有四句的英文提示词，同时承担"单聊人设 + 群聊人设 + 长度预算 + 身份披露 + 拒绝话术"。

**判定**：`fail`（结构性）。

**建议**：按 [wecom-system-prompts-draft.md](wecom-system-prompts-draft.md) 落两套提示词，按 `chatType` 选择；
提示词版本号写进 run 记录的非敏感字段（如 `promptVersion: "wecom-single-v2"` / `"wecom-group-v2"`），便于复评时区分"哪版说的"。

**来源**：[runtime.mjs:23-28/106-107](../../src/channels/wecom/runtime.mjs)、[channel.mjs:257-263](../../src/channels/wecom/channel.mjs)。
**建议**：accept。

---

## 2. 做得对、不要改坏的（pass 清单）

| 项 | 证据 | 说明 |
| --- | --- | --- |
| 群未 @ 一律不响应 | [policy.mjs:55-67](../../src/channels/wecom/policy.mjs) | 群礼仪的结构基础，别放松 |
| `@` 只剥离开头、中间不误删 | [events.mjs:121-131](../../src/channels/wecom/events.mjs) | 避免误删用户内容 |
| 剥离后为空不调模型 | [policy.mjs:65](../../src/channels/wecom/policy.mjs) | 不刷屏 |
| 防注入总则 | [runtime.mjs:27](../../src/channels/wecom/runtime.mjs) | 保留并扩展到群提示词 |
| 分段不切断多字节字符 | [text.mjs:36-55](../../src/channels/wecom/text.mjs) | 中文安全 |
| `/stop` 本地取消、不误发第二条 | [channel.mjs:267-275](../../src/channels/wecom/channel.mjs) | 取消语义正确 |
| 主动推送不伪造目标 | [agt-036:101](../engineering/agt-036-wecom-channel.md) | `93006` 不猜、不重试 |
| 证据脱敏投影 | [agt-036:139](../engineering/agt-036-wecom-channel.md) | 保持；体验证据也按此口径 |

---

## 3. 本次评审不能证明什么

- **群内真实模型回复原文**：没有留档，只有"通用助手"结论；F03 是结构判定，不是逐字判定。
- **研究/长任务体验**：t27 未实现，ack 与终稿都没有真实输出。
- **主动推送体验**：t25 未接线，只有通道层 4 组对照。
- **`/research` 在群里的行为**：D5 已裁决聊天里**暂不开放**；当前命令仍会走到"研究功能未启用"文案，属过渡态，不评体验。
- **延迟 p50/p95**：n=2。
- **24 h 窗口、限速错误码、改名后的 @**：未验证（[onepager:48-56](../research/wecom-channel/v1-boundaries-onepager.md)）。
- **多人群聊的"不抢话"**：平台根本不给非 @ 消息，结构上成立；但"被 @ 后只回答提问者"仍需真实多人会话验证。

---

## 4. 建议的落地顺序（交 captain 排期，不是本卡执行）

1. **P0（一次提示词 PR 就能改）**：F01/F02/F03/F06/F07/F08/F13 + D1/D5/D6/D7 —— 两套提示词（v2）+ 文案替换。
2. **P1（t27）**：F05 ack + 终稿；顺带把 F04-e/f/g/h 文案一起换。
3. **P2（t25）**：F09 推送分寸 + 退订（D3/D4 已裁决；退订需新卡）。
4. **P3（验收基础设施）**：F11 transcript 脱敏留档 + F12 ≥20 次延迟采样。
5. **P4（已裁决，落地即可）**：F10 按 D2 静默；不再需要产品决定。

---

## 5. 可直接复制的"最小改动包"（若 captain 只批准一次提示词改动）

见 [wecom-system-prompts-draft.md](wecom-system-prompts-draft.md)：单聊版 + 群聊版，粘贴即用；
文案替换见 F04 表右列。

---

## 6. 裁决表（2026-11-04，lead 已裁决并锁定；不再复议）

> 结论：F01–F09、F11–F13 **accept**；F10 由 D2 覆盖（静默），等同 accept；**无 reject**。
> D1–D7 见 [rubric §11](wecom-experience-rubric.md)；验收对照见 [t31 checklist](wecom-t31-acceptance-checklist.md)。

| Finding | 裁决（2026-11-04，lead） | 落地要求 | 落地位置 |
| --- | --- | --- | --- |
| F01 `Hi` 客服腔 | accept | 英文跟随（D6）；去掉客服腔/寒暄 | 提示词 v2 |
| F02 `pong 🏓` 偶然正例 | accept | 保留"偶然正例、不作达标证据"；T7 纳入验收 | 提示词 + t31 清单 |
| F03 群聊无独立人设 | accept | `chatType` 选两套提示词 | pi-dev |
| F04 文案（e/f/g/h/j） | accept | 4 条 fail 必须替换；错误码只进日志；runId 不展示（D7） | pi-dev |
| F05 无 ack | accept | 进 t27 | t27 |
| F06 长度无约束 | accept | 提示词预算 + 群聊段数收紧 | pi-dev |
| F07 群礼仪缺失 | accept | 群提示词 + 正/反例验收（D1） | pi-dev |
| F08 身份披露缺失 | accept | 提示词；t29 前保守口径 | pi-dev |
| F09 推送分寸为零 | accept | D3/D4；退订需新卡、仅授权用户 | t25 + 新卡 |
| F10 白名单静默 | **由 D2 覆盖：静默** | 日志记 `reason`，不回复 | pi-dev |
| F11 transcript 缺档 | accept | 只存脱敏版；不得进公开证据目录 | pi-dev |
| F12 延迟样本不足 | accept | ≥20 次采样给 p50/p95 | 验收 |
| F13 提示词单套共用 | accept | 两套提示词 + `promptVersion` | pi-dev |

**D1–D7 裁决摘要**（全文见 rubric §11）：D1 群玩梗**轻度**（默认不主动、对方先开玩笑才接、一次一个梗、不评价个人）；D2 白名单**静默**+日志 reason；D3 推送 **08:00–21:30、≤3 条/天、≤1 条/小时**，22:00–08:00 除用户主动交互外不推；D4 退订 **`/mute` `/mute 7d` `/mute off` `/unmute`**（需新卡、仅授权用户）；D5 聊天里 `/research` **暂不开放**；D6 纯英文问候**跟随英文**、其余默认中文；D7 **不展示 runId**（Trace 走日志/API）。

**已裁决记录（追加，不改历史）**

- 2026-11-04，lead：F01–F09、F11–F13 accept；F10 由 D2 覆盖；D1–D7 锁定。特别保留 F02"偶然正例、不作达标证据"的判定，后续多次成功也不改口。
