# Mira Cloud Agent · 技术架构与信任边界 v0.1

> **状态：技术候选 / 不是已实现架构（2026-11-01）。** 本仓库尚无运行时代码和依赖锁文件；正式技术合同须由实际源码、Issue 和验证结果承接。
>
> 产品决定以 [product-design.md](product-design.md) 为准；内建服务互操作以 [组织 MCP 约定](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud-mcp.md) 为跨仓库讨论基线。

## 1. 最薄运行拓扑

~~~text
Cloud Auth /account/services
  └── 云 Agent 服务入口与控制台（同一登录体验）
             │ 管理配置（业务 API 由 Cloud Agent 拥有）
             ▼
     Mira Cloud Agent · Node.js / Pi SDK（候选）
        ├── Agent Session 与工具权限
        ├── 任务触发 / 状态与研究成果
        ├── 飞书 IM 入口 / 多目标投递
        ├── 模型 Provider 与成本约束
        └── MCP Client（Pi 原生扩展优先）
             │
             ├── Cloud Guanlan /mcp（内建 / 只读 P0）
             └── 受控其它 MCP（未来按需）
 
Cloud Auth：身份、服务授权与受限委托凭证
Guanlan：新闻采集、来源授权、消费账本和 MCP 工具合同
~~~

Cloud Auth 不是每次工具请求的代理，也不是存放 Agent 研究任务、模型 Key、飞书会话和观澜业务状态的数据库。Agent 不接管观澜或拾言的领域服务。

## 2. 候选模块（先遵循现有插件，避免平台化）

| 边界 | 所有权 / 推荐方式 | 仍需验证 |
| --- | --- | --- |
| Agent Runtime | Pi 官方 SDK Session / ResourceLoader | 包和锁定版本、扩展绑定、会话恢复 |
| Scheduler | 优先成熟插件；宿主只提供任务触发和运行审计薄胶水 | 定时准确性、时区、重复触发、取消与重启 |
| Research | Pi 工具 + 搜索/阅读能力，使用标准 MCP | 实际工具权限、来源引用和防提示词注入 |
| Feishu | 优先适配现成插件；消息收发/群 @/多目标投递 | 用户/群身份核验、消息去重、断线恢复 |
| MCP | Pi 原生 Extension 优先，stdio / Streamable HTTP | SDK 真实装配、动态凭证、工具结果保真 |
| Persistence | SQLite（首选候选）+ Pi Session 持久化，避免重复保存整份模型上下文 | 持久化一致性、备份、重启后的任务归属 |
| API/UI | Cloud Auth 服务入口 + Agent 业务 API 与控制台 | 路由、同源反代或独立子服务的实际代码 |
| Deployment | 本地 DSH → 广州 Linux Docker（后续） | 2C2G 共存的内存、CPU、网络、数据卷与重启恢复 |

不要把上述候选自动变成新增常驻服务。优先一个轻量进程及必要的数据文件；确有可靠性/安全要求才分离进程。

## 3. Pi SDK 与 MCP

官方最新文档参考：[Pi SDK](https://pi.dev/docs/latest/sdk)、[Pi MCP](https://pi.dev/docs/latest/mcp)。

- 嵌入式 SDK **不自动装载** CLI 的内建 MCP/codemode/tool-search 扩展。候选路径为使用 DefaultResourceLoader 的 extensionFactories 显式注册并完成 Session 扩展绑定；具体导出、签名、生命周期必须以**实际锁定版本**验证。
- 官方 MCP Client / Extension 负责协议、工具注册和结果，不自行重写 JSON-RPC 或复制观澜的工具 Schema。
- 优先 **2026-07-28 + Stateless Streamable HTTP**；协商能力以实际 Pi SDK 与 Guanlan 测试为准。stdio MCP 用于明确授权的本地工具，禁止不受控执行。
- 优先**按任务暴露少量工具**。先验证 direct / deferred / codemode 的工具可见性、模型成本与权限覆盖，再决定默认。
- 保留 MCP 的 content、structuredContent、isError、URL 与 nextCursor；空 items 且 nextCursor 非空时继续有界分页。
- **A / B 二选一**：A = Pi 原生 MCP Extension，首选；只有拿到无法满足动态凭证/权限/取消的实证才评估 B = 官方 MCP Client 薄桥接。不能同时建两套。

## 4. 身份分层与用户无感接入

### 4.1 已批准的产品体验

用户只登录 **Mira Cloud Account**。观澜、拾言等属于 Mira 内建服务，不需要用户额外登录、打开通用 MCP OAuth 同意页面或手工填观澜 Token。MCP 是工具协议；内部凭证安全是服务器实现细节，**不是第二次用户授权旅程**。

### 4.2 尚需跨仓库冻结的后台委托

Agent 以无人值守方式执行时，必须区分：

1. **服务身份**：这是哪个可信 Agent 实例？
2. **业务委托**：代表哪个 Cloud Account 与稳定 consumer，具有哪些最小 read/write 权限？

Cloud Auth 负责可信签发/续期/撤销；Guanlan 负责业务账户、消费者、来源和状态的最终判断；Cloud Agent 保管短期目标服务凭证并对工具施加执行策略。

当前 Cloud Auth 已有设备绑定 Cloud Session → Shiyan/Relay 短期 audience 凭证，但**尚无已验证的 Guanlan / Cloud Agent 无人值守委托签发**。不能用设备 Session 冒充后台 Agent、不能挪用 Relay ticket、不能在长期存储里放用户 Cloud Session。观澜目前验证期望的 audience 为 mira:cloud-guanlan、只读 scope 为 guanlan.read、消费者声明为 consumer_id；这些**不是 Cloud Auth 已支持签发的事实**。

撤销后的续签需被拒绝；已签凭证在到期前如何失效、消费者如何注册/切换，必须由 Cloud Auth 与 Guanlan 的正式合同决定。

### 4.3 飞书身份绝不默认为 Cloud Account 主人

飞书群权限只允许参加群聊/私聊对话。被授权群成员并不自动拥有群主的私有观澜消费者、Cloud Account 资料或管理员工具。

云服务消费许可必须来自**可信的账号/任务绑定及明确委托**；模型、群消息内容或工具参数不能自行声称另一个账户/consumer。没取得委托时，Agent 可做获准的公开研究，但访问私有内建服务必须 fail closed。

管理员在 Cloud Auth 控制台维护授权群；群成员关系的核验与失效时效应实测飞书 API 可行性。用户私聊会话、群会话、定时任务分别隔离；工具清单与持久缓存不得跨身份泄漏。

## 5. 执行与安全边界

- **任务状态**：queued / running / succeeded / failed / cancelled 等仅为候选状态；实现时固定合法流转、持久记录与去重键。
- **执行时限**：每次运行有取消信号、超时和并发上限；取消要传递到 Pi Session、MCP 调用与投递阶段；未知最终状态显式记录。
- **投递**：每个任务有一个或多个目的地，收件人映射只在可信配置侧决定；网络失败不能默认为成功，也不能无限重复发送。
- **权限**：MCP readOnly 等注解仅提供提示，服务器按业务域校验，客户端按调用场景再收窄；远程服务来源受控，stdio 不得开放任意命令入口。
- **不可信内容**：网页、新闻摘要、群消息可能包含提示词注入，不得通过文本让 Agent 调用高权限工具或改写配置。
- **日志**：只保留必要的 trace ID、任务 ID、耗时、错误分类及成本；不打印凭证、私有正文或模型 Key。
- **资源**：广州 2C2G 仍需与其他服务共存，默认串行/小并发与有界记录，实际内存和费用通过测量确定。

## 6. 技术先后关系

1. P0：独立 Pi SDK + 真实 Guanlan workerd/D1 fixture，只读 MCP（**不需要飞书、Cloud Auth 或 Docker**）。
2. 后续：选定可用的 Pi/飞书/定时插件并验证最小 Agent 研究→投递闭环；不要提前把插件能力写成已验收。
3. 后续：Cloud Auth 服务入口与 Agent 控制台；后台任务授权合同单独跨仓库收敛。
4. 再后：受控 MCP 写回、真实 Cloud Account E2E、成本/资源验收，按正式晋级流程部署。

## 7. 跨仓库事实和参考

- [Cloud Auth service credentials V0](https://github.com/uichat-mira/cloud-auth/blob/dev/docs/service-credentials-v0.md)：现有支持 Shiyan/Relay，非 Agent 无人值守服务身份合同。
- [Guanlan MCP Server](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/src/mcp/server.ts)：只读工具与验证边界。
- [Guanlan 消费账本](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/src/consumption.ts)：CAS/idempotency 已有领域实现，**不在此重造**。
- [Guanlan 产品设计](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/docs/product-design.md)：内建服务边界，不应被 Agent 覆盖。
