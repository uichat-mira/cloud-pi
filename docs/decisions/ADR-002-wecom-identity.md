# ADR-002 · 企业微信身份到 Mira Cloud 的绑定与授权

> **状态：已采纳（Accepted），2026-11-04；X1–X4 为 Deferred（推迟，附撤销条件）。**
> 裁决：team lead（按维护者授权的团队裁决流程记录）。已采纳的是 **D1 / D2 / D6** 与 §5 的
> **V1 单租户委托凭证范围**；D3 作为约束继续有效；D4/D5 的"多租户/个人化"能力**不在 V1**，
> 其冲突项 X1–X4 标 Deferred 并保留撤销条件。**"已采纳"不等于已实现**：本 ADR 不含任何代码、
> 凭证或 Cloud Auth 改动。
> 关联：[WeCom Channel 架构](../architecture/wecom-channel.md)、[ADR-001 传输](ADR-001-wecom-transport.md)。
> Cloud Auth 合同取自本机 checkout `D:\codespace\cloud-auth`（**落后 dev 61 个提交**，核对时间
> 2026-11-04）；本 ADR 采用"不新增 audience/scope"的保守裁决，因此不依赖更新的合同也可能成立，
> 但任何涉及多租户的重评（X1–X4）都必须先以 Cloud Auth 最新 dev 复核，冲突以其维护者为准。

## 1. 背景

企业微信只提供"会话内身份"：

| 事实 | 值 | 证据 |
| --- | --- | --- |
| 发送者 | `from.userid`：机器人创建者是**企业超级管理员**时为明文 `userid`，否则为企业主体下的加密 `open_userid` | `[文档]` 62155 |
| 群标识 | `chatid`（仅群聊）；单聊用 userid 充当 | `[文档]` 62155/62158 |
| 群成员 | **没有**成员列表、没有结构化 `mentions`；`@机器人` 只在正文文本里 | `[文档]` 62163 + `[SDK源码]` |
| 身份权威 | 企业微信的 userid 只在其企业内唯一；`open_userid` 是该企业主体下的加密形式 | `[文档]` 62155 |

Mira 侧的身份权威在 **Cloud Auth**，其 V0 合同（`docs/auth-v0.md`、`docs/service-credentials-v0.md`、
`docs/oauth-authorization-v0.md`、`docs/host-grants-v0.md`）目前是：

- issuer `mira:cloud-auth`；**恰好两个 audience**：`mira:cloud-shiyan`（scope `shiyan:authenticate`）
  与 `mira:cloud-relay-transport`（scope `relay:transport`）。两者**故意不可互换**，
  一个 audience 的凭证在另一个服务验证必然失败。
- 每个 audience 只有**一个** V0 最小权限 scope；scope 只断言"Cloud Auth 已把该账号/设备认证给该服务"，
  **不授予**业务资源权限。
- 服务凭证必须用**设备绑定的 Cloud Session** 换取；`device_id IS NULL` 的旧 Web 会话返回
  `403 SERVICE_CREDENTIAL_DEVICE_REQUIRED`。账号/设备/issuer/scope 全部由服务端推导，
  不信任客户端传的 identity/audience。
- 服务端离线用公开 Ed25519 公钥验签；普通业务请求不回调 Cloud Auth。
- OAuth 授权码 + PKCE 只对两个**已注册的原生客户端**（`mira-desktop`、`mira-mobile`）开放，
  redirect URI 精确匹配；新增/修改客户端要改共享注册表，**不是部署配置**。
- Host→Mobile 能力授权是独立账本（`host-grants-v0.md`），有自己的 scope 词表与
  revision/TTL/Portal 收窄/撤销；文档明确：`relay:transport` **不是** Host scope，
  且"永远不能变成" Host scope。

Cloud Pi 不拥有账号身份（仓库 `AGENTS.md`：Cloud Pi owns channels/runtime，**不** own Cloud Auth
account identity；"A Feishu group being authorized for chat never grants its members the owner's
private Cloud data、model keys、Guanlan consumer identity or privileged MCP tools"）。

## 2. 决策

### D1（lead 已定）禁止把企业微信身份当 Cloud 账号

`from.userid` / `open_userid` **不得**被当作 Cloud Account id、Mira Device id、Guanlan consumer，
也不得据此授予任何工具、数据或管理权限。它只是"会话路由键"。

### D2 Channel 以**服务身份**运行，不以聊天者身份运行

- 模型 Key、MCP/Guanlan 凭证都由部署环境注入，属于 Cloud Pi 服务本身；
- 聊天者的一条消息只能触发"这个服务已被允许做的事"，不能借消息扩大权限；
- 模型输入（消息正文、报告、网页内容）**永远不能**选择或声称身份（仓库 AGENTS.md §3/§4）。

### D3 不新增 audience、不复用其它凭证

- **禁止**为 Agent/Channel 新建 `mira:cloud-agent` 或类似 audience（V0 只有两个，新增属于
  Cloud Auth 的 scope 扩张，必须由 Cloud Auth 走授权工作项，不能由 Cloud Pi 自行决定）。
- **禁止**复用 `relay:transport` 票据做 Agent 授权（它只是传输准入，文档明确它不能变成能力 scope）。
- **禁止**复用 Desktop/Mobile 的 OAuth 客户端或设备绑定会话（客户端注册表是审过的静态表）。
- **禁止**用企业微信通讯录/手机号/邮箱去"匹配"出一个 Cloud Account（既不可靠，也绕过了账号权威）。

### D4（V1 不做 → **Deferred**）"以用户身份访问其 Mira 数据"

V1 **不实现**任何"用聊天用户自己的 Mira 身份去读他的数据"的能力，也**不新增 audience/scope**。
将来若产品确实需要（例如"用户让我看他的 Guanlan 订阅"），路径只能是：

1. 由**用户在 Mira 已认证的界面**（Desktop/Portal 等）发起绑定，不是在聊天里；
2. 绑定结果是一条 **Cloud Auth 拥有的 grant 记录**：明确 audience、scope、TTL、可撤销；
3. Agent 侧只持有**短期凭证**，并在每次使用时校验 scope；
4. 企业微信消息**不能**创建、扩大或续期该 grant；模型输出更不能。

> 该 grant 类型在当前 Cloud Auth V0 **不存在**（现有 audience 只有 Shiyan/Relay，Host grant 只覆盖
> Host→Mobile 的 Remote 能力）。因此 D4 标 **Deferred**：V1 不触碰，撤销条件见 §7 第 1 条（产品明确
> 要求"个人化 Agent"时重评 X1）。

### D5（V1 采用单租户委托 → 冲突 **Deferred**）后台任务的授权连续性

问题：Scheduler 在服务端长期运行，**没有设备**，因此拿不到"设备绑定的 Cloud Session"，
也就无法走现有 `/v1/service-credentials` 换取带用户身份的凭证。

**V1 裁决：不做新的委托凭证类型，改用"单租户委托"。** Cloud Pi 在服务器上使用**维护者本人
Cloud Account** 的、设备绑定在服务器上的 Cloud Session，去换取**短期的 Guanlan 令牌**
（consumer_id = 该 account id）。因此：

- Scheduler 能读到的，只有**该委托账号本身可见**的 Guanlan 数据，不存在"代表任意用户"的能力；
- **不新增**后台委托凭证类型，**不新增** audience/scope，**不修改** Cloud Auth；
- 委托账号的登录/设备绑定由维护者在服务器上完成（凭证只进进程环境或受控存储，不入库、不入日志）；
- 会话失效/被撤销时，后台任务必须**失败并降级**（不静默重试、不换别的账号），记录
  `authorization_revoked` / `session_expired`。

> 这解决了"V1 能不能跑定时研究"的工程问题，但**没有**解决"多用户后台任务"。后者标 **Deferred**（X2），
> 撤销条件见 §7 第 2 条：需要多用户/多租户后台任务时重评。
> 另注：服务器持有维护者会话是**有意接受的高权限部署选择**，其边界写在 §5。

### D6 `open_userid` 转换不是身份方案

`[文档]` 61328 的 `openuserid_to_userid` 需要**自建应用** `access_token` + 可见范围，属于新增权限面。
即使将来为了展示/客服需要对上号，也只能：

- 作为**绑定流程**中的一步（用户已知情），而不是后台静默批量转换；
- 不把转换结果写成 Cloud Account 映射表；
- 首版**不做**（研究 `capabilities.md` §5）。

## 3. 被否方案

| # | 方案 | 否决理由 |
| --- | --- | --- |
| R1 | 用 `userid` 当账号主键 / 直接开账号 | 违反 D1；userid 只在其企业内唯一，`open_userid` 还是加密值；跨企业/跨主体会碰撞；等于把外部目录当身份权威 |
| R2 | 在聊天里做 OAuth 授权（发一个链接让用户点） | Cloud Auth 的 OAuth 只对 `mira-desktop`/`mira-mobile` 的精确 redirect URI 开放；聊天里的链接无法完成 PKCE 原生回调；且"点链接即授权"不可审计 |
| R3 | 复用 Relay ticket 当 Agent 授权 | `relay:transport` 是传输准入，文档明确不能变成能力 scope |
| R4 | 复用 Desktop/Mobile 的会话或客户端凭证 | 客户端注册表静态受审；设备绑定会话属于那台设备，不能搬到服务端 |
| R5 | 现在就为 Agent 新增 audience | V0 只有两个 audience、各一个 scope；新增是 Cloud Auth 的 scope 扩张，须其授权工作项 + 维护者裁决；Cloud Pi 无权单方面改 |
| R6 | 用通讯录 API 把 userid 匹配到手机号/邮箱再找账号 | 不可靠、违反最小权限、绕过账号权威；且需要额外通讯录权限 |

## 4. 与现有合同的冲突：V1 全部 Deferred

| # | 冲突点 | 双方合同 | V1 裁决 | 撤销/重评条件 |
| --- | --- | --- | --- | --- |
| X1 | Agent 若要"以用户身份"访问 Mira 数据，需要新 audience/scope；Cloud Auth V0 明确只有两个 audience 且各一个 scope | Cloud Auth `service-credentials-v0.md`；本 ADR D3/D4 | **Deferred**：V1 不做，**不新增 audience、不扩大 scope**，不要求 Cloud Auth 改动 | 产品明确要求"个人化 Agent"（用用户自己的 Mira 数据）时重评；届时需 Cloud Auth 授权工作项 + 维护者裁决 |
| X2 | Scheduler 无设备 → 拿不到设备绑定会话；Cloud Auth 服务凭证要求设备绑定 | Cloud Auth `auth-v0.md`/`service-credentials-v0.md`；本 ADR D5 | **Deferred**：V1 用**单租户委托**（维护者账号 + 服务器设备绑定会话），**不新增**后台凭证类型（见 §5） | 需要多用户/多租户后台任务，或需要"代表他人跑定时任务"时重评 |
| X3 | 绑定流程若要在企业微信内置浏览器完成，需要新的 OAuth 客户端/redirect URI；注册表是静态受审的 | Cloud Auth `oauth-authorization-v0.md` | **Deferred**：V1 不做绑定流程 | V1 之后要做用户绑定（X1 获批）时重评；届时需 Cloud Auth 评审新客户端 |
| X4 | `open_userid` 转换需要自建应用凭证（新权限面），与本项目"最小权限"目标冲突 | 企业微信 `[文档]` 61328；本 ADR D6 | **Deferred**：V1 要求机器人由**企业超级管理员**创建以拿明文 `userid`；若实际拿不到，记录"无法对上明文 userid"并**保持不映射** | 需要在不引入自建应用的前提下对上明文 userid，或必须用 `open_userid` 做展示/客服时重评 |

> 按团队纪律：跨仓库契约冲突只能提方案交维护者裁决，**不得自行迁移数据或扩张 audience**。
> 本 ADR 不包含任何 Cloud Auth 代码改动；X1–X4 的 Deferred 状态**不是**"已解决"，只是"V1 不触碰"。
> 任何一条的撤销条件被触发时，必须先重开裁决，再动代码。

## 5. V1 单租户委托凭证范围

> 裁决日期 2026-11-04，状态 **Accepted**。这一节是 V1 的身份/授权**产品边界**，
> 不是实现说明；若维护者改选"企微用户绑定 Cloud Account"方案，本节**作废并重写**（当前不预先实现）。

1. **企业微信用户身份只决定"回复给谁"，不决定"能看什么"。**
   `from.userid` / `open_userid` 只是会话路由键；V1 **未绑定** Cloud Account，也不据此授予任何
   工具、数据或管理权限（= D1/D2）。
2. **Guanlan 读取使用维护者本人 Cloud Account 的 consumer 令牌**，`consumer_id = account id`。
   因此 V1 只能读取**该账号可见**的数据；不存在"代表消息发送者"去读其私有数据的能力。
3. **未绑定/未授权用户不获得任何私有数据。** 无论单聊还是群里 @，聊天内容只能触发"该委托账号
   可见范围内"的研究与回答；Scheduler 后台任务同样**只能**使用这一条委托账号的数据面。
4. **这条范围是产品限制，不是安全漏洞。** 它的后果是"V1 只有一个人（维护者）的数据视角"，
   这是有意的单租户选择；多租户/个人化需要 X1/X2/X3 重评后再设计，而不是在 Channel 层临时扩展。

**由此推出的运维边界（不是新决策，是 D2/D5 的直接后果）**：

- 服务器上持有维护者会话属于**高权限部署选择**：只允许在受控机器、受控进程环境内使用；
  不写入仓库、不入日志、不进模型上下文。
- 委托会话失效 → 后台任务失败并降级，**不得**静默换账号或重试到成功。
- 审计只需要回答"哪个 run 用了委托账号"，不需要、也不允许记录企业微信用户身份到 Cloud Account。

## 6. 后果

**正面**

- Channel 可以在**不触碰** Cloud Auth 的前提下上线：不新增 scope、不迁移数据、不引入第二套登录。
- 身份边界清晰：企业微信消息只决定"回复给谁"，不决定"能看什么"。
- 与仓库 AGENTS.md 的"no ambient superuser rights"一致，也避免把飞书侧已有的安全模型在
  WeCom 侧打破。

**负面 / 成本**

- V1 **没有**"个人化"能力：聊天者不会因为"我登录过 Mira"就让 Agent 读自己的数据；这是 §5 的
  单租户范围。要做个人化必须走 D4 + X1 重评。
- 所有研究与后台任务共享维护者一个数据视角；不同用户问同一个问题会得到同一个数据面的答案。
- 如果产品坚持"企业微信里直接授权"，那就是 X3 的跨仓库工作，会显著拉长交付。

## 7. 撤销/重评条件

| # | 触发条件 | 需要重评 | 重评前不得做什么 |
| --- | --- | --- | --- |
| 1 | 产品明确要求"个人化 Agent"（用聊天用户自己的 Mira 数据） | X1 + D4（绑定/委托授权设计） | 不得先在 Channel 里加身份映射或缓存用户数据 |
| 2 | 需要多用户/多租户后台任务，或"代表他人跑定时任务" | X2 + D5（委托凭证类型） | 不得用维护者账号冒充多用户，也不得共享凭证 |
| 3 | 需要在企业微信内完成绑定授权 | X3（新 OAuth 客户端） | 不得私自注册客户端或放宽 redirect URI |
| 4 | 机器人必须由普通管理员创建，`from.userid` 恒为 `open_userid` | X4 + D6 | 不得引入自建应用静默批量转换，也不得把 `open_userid` 当账号 |
| 5 | Cloud Auth 正式发布第三个 audience 或后台委托凭证类型 | D3/D4/D5 | 不得因为"合同有了"就默认授权范围；仍需产品裁决 |
| 6 | 组织安全策略变化（例如要求聊天身份可追溯到 Cloud Account） | D2 | 不得自行把 userid 写进 Cloud Account 映射表 |

## 8. 开放问题（V1 之后）

1. 绑定入口放哪里（Desktop/Portal/企业微信内置浏览器）？需要 Cloud Auth 先确认 X3。
2. 委托授权的 TTL、撤销传播延迟、审计字段由谁定义？
3. 企业微信侧"用户已离职/账号停用"如何让 grant 失效？企业微信没有对应事件回调（`[未验证]`）。
4. 一个企业多个机器人、多个 Mira 账号并存时，绑定的唯一性约束是什么？
5. 是否需要一个"服务身份"在 Cloud Auth 注册（而非匿名服务），以便审计"哪个部署实例发的请求"？
6. V1 的"委托会话失效即降级"是否需要主动告警（谁收到、多久一次）？
