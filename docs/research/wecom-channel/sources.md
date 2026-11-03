# 企业微信智能机器人 Channel 研究 · 资料来源与证据等级

> 分支：`docs/agt-031-wecom-research`　｜　关联 Issue：[#13 AGT-031](https://github.com/uichat-mira/cloud-pi/issues/13)
> 全部在线资料访问日期：**2026-11-04**（Asia/Shanghai）。企业微信文档与 SDK 变化快，引用时必须重新核对。

## 1. 证据标签

本文档目录内所有事实陈述都带以下标签之一，便于审查时直接判定证据强度：

| 标签 | 含义 | 可采信程度 |
| --- | --- | --- |
| `[文档]` | 企业微信官方开发者文档正文（含文档 ID 与链接） | 平台合同，可作为实现依据 |
| `[SDK源码]` | `WecomTeam/aibot-node-sdk` 仓库源码或已发布 npm 包内容 | 客户端行为事实，不代表服务端合同 |
| `[实验]` | 本机实际执行的命令与输出（无凭证或占位凭证） | 只证明被测路径，不外推到未测路径 |
| `[社区]` | SDK 仓库 Issue 中的用户报告 | 风险线索，**不是**平台合同 |
| `[未验证]` | 官方文档未写、源码未体现、也未能实测 | 必须在 POC 中补证，不得当作已确认 |

## 2. 官方文档地图（2026-11-04 抓取）

当前「智能机器人」正文位于 **`智能机器人开发`** 顶层目录（category `101705`），入口是 `开发指南`。
注意：`智能机器人`（category `100718`，含"智能机器人长连接" `60904`）这一套**已不在导航树中**，
其正文与当前文档冲突且端点已 404（见 §3），不要用它做实现依据。

| 文档 | doc_id | 链接 | 用于 |
| --- | --- | --- | --- |
| 开发前必读 | 62131 | https://developer.work.weixin.qq.com/document/path/62131 | 控制台配置步骤、凭证形态 |
| 基本概念 | 62132 | https://developer.work.weixin.qq.com/document/path/62132 | 普通/API 模式、长连接 vs URL 回调、高可用边界 |
| 智能机器人 概述（快速入门） | 61964 | https://developer.work.weixin.qq.com/document/path/61964 | 产品定位、三部分形态、单聊/群聊/主动推送 |
| 消息接收与发送 概述 | 62153 | https://developer.work.weixin.qq.com/document/path/62153 | 两种接收方式总览 |
| 使用长连接 · 概述 | 62154 | https://developer.work.weixin.qq.com/document/path/62154 | **长连接端点、订阅、心跳、单连接限制、官方 SDK 入口** |
| 使用长连接 · 接收消息 | 62155 | https://developer.work.weixin.qq.com/document/path/62155 | 消息回调字段、`from.userid` 明文/加密规则、媒体 `aeskey` |
| 使用长连接 · 接收事件 | 62156 | https://developer.work.weixin.qq.com/document/path/62156 | `enter_chat` / `template_card_event` / `feedback_event` / `disconnected_event` |
| 使用长连接 · 回复消息 | 62157 | https://developer.work.weixin.qq.com/document/path/62157 | 回复命令、流式消息、20480 字节、24h、10min、5s、频率限制 |
| 使用长连接 · 主动推送消息 | 62158 | https://developer.work.weixin.qq.com/document/path/62158 | `aibot_send_msg`、`chatid`/`chat_type`、前置条件、频率限制 |
| 使用长连接 · 上传临时素材 | 62159 | https://developer.work.weixin.qq.com/document/path/62159 | 分片上传、大小上限、30min 会话、3 天 media_id |
| 使用长连接 · 模板卡片类型 | 62160 | https://developer.work.weixin.qq.com/document/path/62160 | 卡片结构（本轮不实现，仅记录） |
| 使用 URL 回调 · 概述 | 62161 | https://developer.work.weixin.qq.com/document/path/62161 | URL 回调形态 |
| 使用 URL 回调 · 加解密方案 | 62162 | https://developer.work.weixin.qq.com/document/path/62162 | Token / EncodingAESKey / 签名 |
| 使用 URL 回调 · 接收消息 | 62163 | https://developer.work.weixin.qq.com/document/path/62163 | 公网 URL、加密回调、**同时最多 3 条消息交互** |
| 使用 URL 回调 · 接收事件 | 62164 | https://developer.work.weixin.qq.com/document/path/62164 | 事件回调 |
| 使用 URL 回调 · 被动回复消息 | 62165 | https://developer.work.weixin.qq.com/document/path/62165 | 响应包回复、`stream_with_template_card` |
| 使用 URL 回调 · 主动回复消息 | 62166 | https://developer.work.weixin.qq.com/document/path/62166 | `response_url`（一次、1 小时） |
| 自建应用与智能机器人的对接 | 61328 | https://developer.work.weixin.qq.com/document/path/61328 | `open_userid → userid` 转换 API |
| 访问频率限制 | 10785 | https://developer.work.weixin.qq.com/document/path/10785 | 平台级频控基线 |
| 企业微信客户端 FAQ | 58634 | https://developer.work.weixin.qq.com/document/path/58634 | 客户端 ≥4.1.32 才能看到智能机器人 |
| 发送应用消息（自建应用） | 10167 | https://developer.work.weixin.qq.com/document/path/10167 | 对比：自建应用推送能力 |
| 官方帮助：如何获取 Bot ID 和 Secret | — | https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21677 | 控制台入口（正文为前端渲染，仅确认标题） |

### 2.1 官方 SDK

| 项 | 值 | 证据 |
| --- | --- | --- |
| 包名 | `@wecom/aibot-node-sdk` | `[文档]` 62154 的 SDK 表 |
| npm latest | `1.0.7`（`beta` 同为 `1.0.7-beta.0`） | `[实验]` `npm view` |
| 仓库 | https://github.com/WecomTeam/aibot-node-sdk | `[文档]` 62154 |
| 仓库 HEAD（抓取时） | `80615b9`（`main`，9 个提交） | `[实验]` `git ls-remote` + clone |
| License | MIT | `[SDK源码]` package.json + npm `license`；GitHub API 的 `license` 字段为空，佐证见 SDK Issue #30 |

## 3. 关键发现：两代长连接文档并存，旧端点已失效

`[实验]` 用 SDK 分别连两个端点（占位凭证，仅验证握手与认证路径）：

| 端点 | 来源 | 结果 |
| --- | --- | --- |
| `wss://openws.work.weixin.qq.com` | `[SDK源码]` `src/ws.ts` 默认值 + `[文档]` 62154 | 155 ms 完成 WS 握手；订阅被服务端以 `errcode 853000 invalid bot_id or secret` 拒绝（符合预期：占位凭证） |
| `wss://open.work.weixin.qq.com/ws/aibot` | `[文档]` 旧版 60904（category 100718） | WS 握手即 `Unexpected server response: 404` |

结论：**实现必须以 62154 的端点与命令字为准**；旧文档 `60904` 的命令名（`aibot_callback` /
`aibot_response_msg` / `aibot_response_wecome_msg`）与现行命令（`aibot_msg_callback` /
`aibot_respond_msg` / `aibot_respond_welcome_msg`）系统性不同，照旧文档实现会连不上。
`60904` 仍有一条有效信息：API 模式在"长连接"与"设置接收消息回调地址"之间**只能二选一**，
切换会使另一形态失效；当前文档 62131 表述为"选择其一配置"，未明写互斥后果，故该点标
`[文档]`（旧）+ `[未验证]`（现行界面是否仍强制互斥）。

## 4. 抓取方法（可复现）

企业微信文档是前端渲染，直接 GET 页面只有导航树。正文通过其内部接口取回：

```powershell
Invoke-WebRequest -Method POST -Uri 'https://developer.work.weixin.qq.com/docFetch/fetchCnt' `
  -ContentType 'application/x-www-form-urlencoded' -Body 'doc_id=62154'
# 返回 JSON: { data: { id, title, content_md, content_html, ... } }
```

- 必须 `application/x-www-form-urlencoded`；JSON body 返回 `errCode -30001 参数异常`。
- 需要普通浏览器 UA，否则 403。
- 文档树：`POST https://developer.work.weixin.qq.com/docFetch/categories`（返回 4493 个节点）。
- 本机可直连 `developer.work.weixin.qq.com` 与 `openws.work.weixin.qq.com`；研究期未启用
  `RESEARCH_HTTPS_PROXY`。GitHub 直连不稳定时改走 `http://127.0.0.1:1080`。

## 5. 本机实验环境

| 项 | 值 |
| --- | --- |
| OS | Windows（本机开发机） |
| Node | `v24.9.0`（npm `11.6.0`） |
| SDK | `@wecom/aibot-node-sdk@1.0.7`，装在本仓库外的临时目录 |
| 凭证 | **无**（维护者尚未创建智能机器人） |
| 产品代码 | 未修改；实验目录为 `%TEMP%` 级临时目录，不入库 |

Node 22 未在本机实测（只装了 24.9.0）；SDK 无 `engines` 约束，语法为常规 ES2020+，故
Node 22 兼容性只能标 `[未验证]`，不作为结论依据。
