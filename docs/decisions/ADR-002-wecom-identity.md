# ADR-002 · 企业微信身份到 Mira Cloud 的绑定与授权

> **状态：提议（Proposed），待维护者裁决。** 其中两项已由 lead 在 2026-11-04 的 t4 任务输入中确定
> （W1 目标词表、deny `userid → Cloud Account`），其余均为提议，**不是已实现能力**。
> 关联：[WeCom Channel 架构](../architecture/wecom-channel.md)、[ADR-001 传输](ADR-001-wecom-transport.md)。
> Cloud Auth 合同取自本机 checkout `D:\codespace\cloud-auth`（**落后 dev 61 个提交**，核对时间
> 2026-11-04）；正式裁决前须以 Cloud Auth 最新 dev 复核，冲突以该仓库维护者为准。

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

### D4 未来若需"以用户身份访问其 Mira 数据"：必须显式绑定 + 委托授权

如果产品确实需要"用户让我（Agent）看他的 Guanlan 订阅"这类能力，路径只能是：

1. 由**用户在 Mira 已认证的界面**（Desktop/Portal 等）发起绑定，不是在聊天里；
2. 绑定结果是一条 **Cloud Auth 拥有的 grant 记录**：明确 audience、scope、TTL、可撤销；
3. Agent 侧只持有**短期凭证**，并在每次使用时校验 scope；
4. 企业微信消息**不能**创建、扩大或续期该 grant；模型输出更不能。

> 该 grant 类型在当前 Cloud Auth V0 **不存在**（现有 audience 只有 Shiyan/Relay，Host grant 只覆盖
> Host→Mobile 的 Remote 能力）。因此 D4 是**待裁决的产品/跨仓库议题**，不是本卡能落地的实现。

### D5 后台任务（Scheduler）的授权连续性——未解决，标"待裁决"

问题：Scheduler 在服务端长期运行，**没有设备**，因此拿不到"设备绑定的 Cloud Session"，
也就无法走现有 `/v1/service-credentials` 换取带用户身份的凭证。

决策（保守默认）：

- 首版 Scheduler **只用服务身份**：研究公开信息、写报告、投递给已配置的会话；
  **不**访问任何"属于某个用户"的私有数据。
- 若将来需要"定时任务代表某用户访问其私有数据"，必须：
  a) 在创建 schedule 时由该用户**显式授权**（同一套 grant 机制，含 scope/TTL）；
  b) 授权到期后任务**停跑或降级**，不得静默续期；
  c) 用户撤销后，后续触发立即失败并记录 `authorization_revoked`。
- 上述机制依赖 Cloud Auth 提供"非设备绑定的委托凭证/后台授权"，**当前不存在** →
  列为跨仓库待裁决项（见 §4）。

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

## 4. 与现有合同的冲突（列此待裁决，不自行解决）

| # | 冲突点 | 双方合同 | 需要谁裁决 |
| --- | --- | --- | --- |
| X1 | Agent 若要"以用户身份"访问 Mira 数据，需要新 audience/scope；Cloud Auth V0 明确只有两个 audience 且各一个 scope | Cloud Auth `service-credentials-v0.md`；本 ADR D3/D4 | Cloud Auth 维护者 + 组织架构裁决 |
| X2 | Scheduler 无设备 → 拿不到设备绑定会话；Cloud Auth 服务凭证要求设备绑定 | Cloud Auth `auth-v0.md`/`service-credentials-v0.md`；本 ADR D5 | Cloud Auth 维护者（是否提供后台委托凭证） |
| X3 | 若绑定流程要在企业微信内置浏览器完成，需要新的 OAuth 客户端/redirect URI；注册表是静态受审的 | Cloud Auth `oauth-authorization-v0.md` | Cloud Auth 维护者（是否新增客户端） |
| X4 | `open_userid` 转换需要自建应用凭证（新权限面），与本项目"最小权限"目标冲突 | 企业微信 `[文档]` 61328；本 ADR D6 | 维护者（是否引入自建应用） |

> 按团队纪律：跨仓库契约冲突只能提方案交维护者裁决，**不得自行迁移数据或扩张 audience**。
> 本 ADR 不包含任何 Cloud Auth 代码改动，也不假设 X1–X4 已被批准。

## 5. 后果

**正面**

- Channel 可以在**不触碰** Cloud Auth 的前提下上线：不新增 scope、不迁移数据、不引入第二套登录。
- 身份边界清晰：企业微信消息只决定"回复给谁"，不决定"能看什么"。
- 与仓库 AGENTS.md 的"no ambient superuser rights"一致，也避免把飞书侧已有的安全模型在
  WeCom 侧打破。

**负面 / 成本**

- 首版无法做"个人化"能力（例如"用我的 Guanlan 订阅做研究"），需要 D4 的绑定机制。
- 定时任务只能做公开信息研究；私有数据的定时任务要等 X2 有结论。
- 如果产品坚持"企业微信里直接授权"，那就是 X3 的跨仓库工作，会显著拉长交付。

## 6. 撤销/重评条件

1. Cloud Auth 正式发布第三个 audience 或委托凭证类型 → 重评 D3/D4/D5。
2. 产品明确要求"个人化 Agent" → 启动 D4 的绑定流程设计（跨仓库），本 ADR 相应修订。
3. 机器人创建者改为普通管理员导致 `from.userid` 恒为 `open_userid` → 仍需维持 D1/D6，
   但要在运维文档里写明"无法对上明文 userid"。
4. 组织安全策略变化（例如要求聊天身份必须可追溯到 Cloud Account）→ 重评 D2。

## 7. 开放问题

1. 绑定入口放哪里（Desktop/Portal/企业微信内置浏览器）？需要 Cloud Auth 先确认 X3。
2. 委托授权的 TTL、撤销传播延迟、审计字段由谁定义？
3. 企业微信侧"用户已离职/账号停用"如何让 grant 失效？企业微信没有对应事件回调（`[未验证]`）。
4. 一个企业多个机器人、多个 Mira 账号并存时，绑定的唯一性约束是什么？
5. 是否需要一个"服务身份"在 Cloud Auth 注册（而非匿名服务），以便审计"哪个部署实例发的请求"？
