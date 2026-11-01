# P0 · Pi SDK → Guanlan MCP 只读 POC

> **状态：待派卡的最小验证设计（2026-11-01）。未执行、无验收记录。**
>
> 维护者裁决：**A（Pi 原生 MCP Extension）优先**。P0 可以先行；不重复 GLN-007 消费账本施工，不扩 Cloud Auth 正式权限，不部署生产。

## 目标与边界

用**实际锁定版本的 Pi SDK Session**，通过官方 MCP Extension 连接 Guanlan 现有的**隔离 workerd/Miniflare + D1 fixture**，只暴露两个只读工具：guanlan_news_recent、guanlan_whoami。

P0 回答一个问题：**Pi 嵌入式运行时能否在任务级权限、短期测试凭证、取消与重连条件下，正确使用一个 Mira 内建 MCP 服务？**

不是完整 Agent 应用，不需要定时器、飞书、Cloud Auth 真实签发、控制台、生产 Cloudflare Worker、广州 Docker、模型配置页面或 MCP 写工具。

## 可用现状（2026-11-01 检查）

- cloud-pi 在文档初始化前只有 LICENSE，尚无 package/lock、SDK、Session 或测试脚本，因此不能填“当前 Pi 版本”。
- Guanlan dev 使用 @modelcontextprotocol/server 2.4.0，已有 /mcp、受验证 JWT/JWKS、scope/audience、现代及 legacy stateless、tools/list 与 tools/call。
- 只读工具返回 Markdown content 和 structuredContent；错误显式 isError。新闻 query 包括 sourceId、status、keyword、日期区间、cursor；默认 unread/pending。
- Guanlan 领域层已有 GLN-007 expectedVersion + operationId 账本，不应重复实现；**当前 MCP 服务尚无写工具**。
- Cloud Auth 只支持已实施的 Shiyan/Relay service credentials，不能冒充 Guanlan/Agent 身份。
- 组织 MCP 通用文档为 Architecture Proposal，用户无感的内建服务产品体验已确定，但无人值守签发合同未冻结。

## 候选装配步骤（不是未经验证的可运行代码）

1. 选定并锁定可获取的官方 Pi SDK 包和版本，记录 package.json、锁文件、Node 运行时、Extension API 导出及源代码/声明位置。
2. 在 SDK ResourceLoader 显式装配 MCP Extension；按实际工具曝光选择 codemode / tool-search（P0 两工具可先 direct）。Session 创建后执行所需的扩展绑定；不能用 CLI 的 pi mcp add 结果替代 SDK 装配测试。
3. 在可信测试配置侧固定一个测试 Guanlan 服务地址及测试凭证提供器；**不允许模型参数设置 token、accountId、consumerId**。不写假 Cloud Auth 生产签发器。
4. 调用真实官方 MCP transport；让真实 Pi Session 发起并观察 tool call/response；工具执行权限钩子应在实际调用时拦截，不只检查配置文件。
5. 捕获脱敏的协议版本、工具名、请求 ID、错误码、toolResult 的结构化内容、取消/重连状态；避免日志保存凭证、私有源或整份对话。
6. 使用现有 Guanlan workerd/D1 fixture 及其测试前置数据，按需要加**独立的 Pi 消费者测试**；不修改 Guanlan 生产服务合同。

## 验收矩阵

| Case | 真实测试内容 | 必须有的证据 |
| --- | --- | --- |
| SDK load | 锁定包 + ResourceLoader + 扩展绑定，实际列表仅两只读工具 | Session active tool / MCP tools/list、锁文件和调用路径 |
| Positive | consumer A 可读授权新闻及 whoami，保留 content/structuredContent/isError/URL | 具体 fixture URL、scope、consumer 和结果断言 |
| Isolation | A/B 账户与同账户 A1/A2 消费者隔离；模型参数试图冒用 consumer 失败 | 真实 MCP 调用的正反例，不是领域函数直接调用 |
| Auth negatives | 缺 token、错误 audience/scope、过期、无账号/consumer 或无订阅 | 401/403/明确空授权结果的正确区别；不泄漏私人数据 |
| Pagination | 多页稳定分页；**items=[] 但 nextCursor 非空仍继续**；上限和无重复 | 每页 URL 与 cursor，最终结束条件和上限 |
| Error semantics | 数据库故障为 isError/业务错误，不能变成无新闻成功；URL、游标不截断 | 错误类型和 structuredContent/原始内容对照 |
| Permission gate | 未授予的 MCP 工具调用被运行时拒绝，组权限无法抬升为内部服务权限 | Pi 工具执行管道的拒绝证据 |
| Lifecycle | MCP 超时/取消/中断，Session 不悬挂；重连后可再次调用 | 取消耗时、资源关闭、重连和错误轨迹 |
| Credentials | 测试凭证失效/更新后重新授权；确认安全刷新与连接生命周期 | 旧凭证拒绝、新凭证成功，说明是否须重建会话 |
| Version | 现代 2026-07-28 协商；必要时测 legacy stateless | 实际协商值，不靠规范版本号作推断 |

**重点：** 测试凭证来自隔离 fixture，仅用于证明传输和权限边界，不能宣称 Cloud Auth 真实用户委托已接通。无真实签发，不做线上 E2E 声明。

## A/B 技术选择门槛

**A 默认**：Pi 原生 MCP Extension，复用现有工具与权限管线、按需工具发现、结果保真。

只有在锁定版本和可复现环境中证明 A 无法满足**安全的动态凭证更新、身份隔离、取消/超时或结构化结果保真**，才把最小复现提交维护者决定是否用 **B 官方 MCP Client 薄桥接**。

不得双装、不得手写 JSON-RPC 或 HTTP 协议规则、不得为 Guanlan 特例复制工具 Schema 到 Cloud Agent。

## 不属于 P0

- **不**实现 guanlan 消费状态写回；GLN-007 已验证领域层 CAS/幂等，后续正式 MCP 写工具在 Guanlan 仓库另行决策。
- **不**添加 Cloud Agent 服务身份、续签 API、群成员委托或 Guanlan audience 正式签发；这些属于 Cloud Auth × Guanlan × Agent 的 P2 跨仓库工作。
- **不**添加飞书机器人、定时调度、持久化管理后台、Agent 运行时平台、观澜部署或公网回调服务。
- **不**修改生产数据、凭证或权限。

## 交付要求

实施时应提交一张经授权、具备准确范围与可复现验收的 Issue；DSH 在本地用最小代码完成 POC，交付 Draft PR 到 dev（如授权），明确记录：

- 精确 head SHA、Pi SDK 与 Node 锁定版本、观澜 fixture/workerd 版本；
- 一键可重跑的安装与测试命令（实际运行之后记录），真实通过/失败/跳过清单；
- 测试数据与负例、每种异常恢复行为、MCP 版本协商；
- A 路线是否足够，未解决的客户端限制及是否需跨仓库技术裁决。

**当前仅文档阶段**：没有 package.json、没有运行结果、没有自动化 gate，不得写“测试通过”。

## 参考

- [Pi 官方 SDK](https://pi.dev/docs/latest/sdk)
- [Pi 官方 MCP](https://pi.dev/docs/latest/mcp)
- [组织 Mira Cloud MCP 基线](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud-mcp.md)
- [Guanlan MCP Server](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/src/mcp/server.ts)
- [Guanlan workerd/D1 MCP 测试](https://github.com/uichat-mira/cloud-mcp-guanlan/blob/dev/tests/mcp-workerd.test.mjs)
- [Cloud Auth credential contract](https://github.com/uichat-mira/cloud-auth/blob/dev/docs/service-credentials-v0.md)
