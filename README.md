# Mira Cloud Agent · cloud-pi

> **状态：产品设计基线 / 尚未实现运行时（2026-11-01）。** 仓库由空白工程起步；本文不是已上线、已测试或已部署声明。

**Mira Cloud Agent** 是面向日常研究与团队协作的轻量、常驻云端智能体，定位为 **Hermes Agent 的轻量替代品**，也是未来「云 Mira」可以逐步生长的前身。首版先让一只 Agent 真正能工作：**定时研究、读取观澜、飞书双向对话、原生 MCP 工具连接**。

## 产品目标

- **定时研究**：用户在 Cloud Auth 服务控制台管理研究任务、计划、执行历史及多目标成果投递；Agent 可做《见π》《气数》与其他自定义主题的资料研究。
- **飞书双向交互**：私聊可持续对话；已授权群中仅被 @ 才响应；群成员可私聊，数据与能力按可信授权隔离。
- **观澜新闻**：作为 Mira Cloud Account 内建服务，通过受限内部凭证和标准 MCP 调用；**用户不需要为观澜再次登录、单独 OAuth 授权或填写 Token**。
- **MCP**：优先 Pi 原生 MCP Extension，支持标准 stdio / Streamable HTTP；可按任务收窄工具，不能以群聊权限代替工具授权。
- **运行与部署**：DSH 在本地开发验证；合适时才部署到广州 Linux 服务器 Docker，控制资源占用。

## 文档导航

| 文件 | 权威范围 |
| --- | --- |
| [docs/product-design.md](docs/product-design.md) | **产品目标、已确认用户决定与 V1 范围** |
| [docs/architecture.md](docs/architecture.md) | 技术边界、候选模块划分、内部服务信任模型 |
| [docs/engineering/p0-mcp-poc.md](docs/engineering/p0-mcp-poc.md) | **只读 Pi SDK → Guanlan MCP** 的最小 POC 及验收清单 |
| [AGENTS.md](AGENTS.md) | 仓库工程协作约束 |

跨服务协议参考：[Mira Cloud MCP 互操作讨论稿](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud-mcp.md)。该文件仍属组织级架构提案，尚非正式凭证签发合同。

## 目前已经确定与尚未证明

**已确定的产品方向**：Pi SDK 优先；插件优先、薄适配；飞书私聊与已授权群 @；授权群成员可私聊；定时计划在 Cloud Auth 控制台管理，任务投递可配置多个接收目标；使用 Mira 统一身份，观澜不额外登录；本地 DSH 开发后评估广州 Docker 部署。

**尚未证明**：仓库的 Pi SDK 锁定版本和实际 Session 实现、调度/飞书插件兼容性、多目标飞书投递、云端无人值守委托凭证、观澜生产 MCP 接通、Docker 资源占用。**不得把产品决定、上游文档支持和运行验证混为一谈。**

## 开发起点

先按 [P0 MCP 方案](docs/engineering/p0-mcp-poc.md) 验证一条真实 Pi SDK ↔ 隔离观澜 workerd/D1 的只读协议链路。P0 **不需要**搭建完整控制台、飞书机器人、定时器、云账号委托或生产环境；通过后再按业务价值递进。

## OpenCode 付费 Worker（工程施工）

本仓库使用 [Organization 共享 Mira External Worker](https://github.com/uichat-mira/.github/blob/main/.github/workflows/mira-external-worker.yml)，由 `.github/workflows/mira-external-worker.yml` 作为**受信任的轻量派工入口**。运行时采用 OpenCode Go，默认模型 `deepseek-v4.1-flash`，**每次最多 90 分钟**（包含施工与可信验证）。这只是运行时间上限，不是固定消费额度。

- 仅适用于**已有明确施工授权且仍 OPEN 的工程 Issue**；Issue 关闭、PR、空合同不能派工。必须由拥有当前仓库写权限的**真人维护者**在对应 Issue 留下**完整且未编辑的单行评论 `/worker run`**；也可从 Actions 手动输入 Issue 编号启动。
- Worker 在独立 `feat/worker-*` 分支执行，以 `dev` 为唯一交付目标，使用仓库现有 `npm ci --no-audit --no-fund && npm test` 进行可信验证，交付 **Draft PR**。**不允许**自行合并、关闭 Issue、部署或变更生产权限。
- 密钥通过 GitHub Actions Secret `AI_PROVIDER_OPENCODE_GO_KEY` 提供给共享工作流，**不写入仓库、PR、Issue、日志或用户对话**。新仓库能否使用组织密钥须由实际 Actions 运行或组织密钥访问策略确认；仅有 YAML 引用不构成可用性证据。
- **GitHub 默认分支须为 `dev`**：评论事件和手动 Dispatch 只会从默认分支发现 Caller，实际 Workflow 和 Worker 交付目标均在 `dev`；保留的 `main` 不是生产分支。修改默认分支不会触发产品部署。

该入口只负责工程施工，不是 Cloud Agent 产品自身的运行时。

本仓库遵守 [Mira Organization AGENTS](https://github.com/uichat-mira/.github/blob/main/AGENTS.md) 和 [环境分支规范](https://github.com/uichat-mira/.github/blob/main/docs/engineering/environment-model.md)。当前 main 仅保留初始引导，开发集成以 dev 为目标；任何生产部署均应另行评审并走正式环境晋级。
