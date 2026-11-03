# 1C1G 小服务器运行手册（Cloud Agent V1）

> 状态：**装机手册，未部署**。本文件不含任何真实主机、域名、密钥；命令里的 `<...>` 需按实际环境替换。
> 编写日期 2026-11-04，代码基线 `origin/dev`（`d2c7c4b`，含本手册初版 PR #39）。
> 标注约定：**【本机已验证】** = 本次在 Windows + Node v24.9.0 上实际执行过；
> **【需 Linux 验证】** = 只能在上线机器上核对（systemd/logrotate/内核参数）；
> **【引用】** = 引用仓库既有文档或官方手册，未重复实测；**【估算】** = 没有实测数字，必须先测再用。

## 0. 结论

**1 vCPU / 1 GB 可以跑，但有四个前提**：不在服务器上装依赖/构建、只跑单实例、模型推理走远端、日志有上限。

不适用的情况：同一机器人开两个实例（长连接互踢，见 §2.5）、在本机跑模型、把 runs 目录无限增长（§4）。

## 1. 资源画像（真实数字）

测量环境：Windows 11 + Node **v24.9.0**，`process.memoryUsage().rss`，统一入口 `src/entry/main.mjs`
（`--channels none`，即 scheduler + delivery + 管理 API 都起来、无通道、无 run 在跑）。

| 项 | 数值 | 来源 |
| --- | --- | --- |
| 裸 Node 基线 RSS | **59.9 MB**（heap 3.9 MB） | 【本机已验证】空脚本 6 次采样稳定值 |
| Cloud Pi 统一入口 idle RSS | **156.4 MB**（heap 41.1 MB，external 4.1 MB） | 【本机已验证】启动后 8 次采样（4 s）稳定 |
| 生产依赖（`npm ci --omit=dev`） | **182 个包 / 146.3 MB**，本机 5.7 s 装完 | 【本机已验证】 |
| 含开发依赖的安装体积 | 196 包 / 约 233 MB | 【引用】[agt-029-feishu-channel.md](agt-029-feishu-channel.md):35 |
| 代码 + 文档（不含 `node_modules`） | **2.0 MB / 204 个文件** | 【本机已验证】`src doc scripts tests` 合计 |
| 单次真实 run 的 RSS 峰值 | **未实测**（需要真实模型调用，本轮未跑） | 见下方上界推算；装机后按 §7.1 测量 1 回填 |
| 每 run 归档大小 | **未实测**（本机无历史 runs 目录） | 按抓取页数增长，装机后按 §7.1 量 3 次 |

**上界推算（不是实测）**：默认 heap 上限取 `--max-old-space-size=320`，在 Node 24 上对应 V8
`heap_size_limit=512 MB`（【本机已验证】`require('v8').getHeapStatistics().heap_size_limit`；
作为对照，384 对应 576 MB），加上本机观测到的约 115 MB 非堆开销，理论 RSS 上界约 **630 MB**。
所以 `MemoryMax=768M` 留出约 **140 MB** 余量（OS、突发、日志缓冲），1 GB 机器 + 2 GB swap 仍然安全。

**触顶时的处理顺序（不要反过来）**：先把 heap 降到 256 MB 并观察一轮；仍然 OOM 才按 §4 升配。
**不要**为了让进程活下来先加大 `MemoryMax`——那只是把「确定性 OOM kill」换成「不确定的 swap 抖动」，
整机延迟会一起变差。

**这些不占本机**：
- **模型推理**：走远端 OpenAI 兼容网关（`CLOUD_PI_MODEL_BASE_URL`），本机只做 HTTP/SSE 客户端，无 GPU、无模型权重。
- **Guanlan**：Cloudflare Worker + D1，本机只是 HTTPS 客户端。
- **Cloud Auth**：独立服务，本机只做 JWKS/令牌校验的 HTTP 客户端。
- **状态存储**：文件（`CLOUD_AGENT_STATE_DIR` + `RESEARCH_RUNS_DIR`），**没有本地数据库进程**。

## 2. 1C1G 最小配置单

### 2.1 2 GB swap

```bash
# fallocate 更快；若文件系统不支持（如部分 overlayfs），改用注释里的 dd
sudo fallocate -l 2G /swapfile
# sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -m && swapon --show
```

【需 Linux 验证】`fallocate`/`mkswap`/`swapon` 语法与 fstab(5) 第四列 `sw` 取值为标准写法。

### 2.2 swappiness=10

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-cloud-agent.conf
sudo sysctl --system
sysctl vm.swappiness
```

【需 Linux 验证】1 GB 机器不要把 swappiness 设 0：完全禁用会让偶发峰值直接 OOM，而 10 足够让热数据留在内存。

### 2.3 systemd unit（`/etc/systemd/system/cloud-agent.service`）

```ini
[Unit]
Description=Cloud Pi Cloud Agent (WeCom channel + scheduler + delivery + management API)
After=network-online.target time-sync.target
Wants=network-online.target time-sync.target

[Service]
Type=simple
User=cloudagent
Group=cloudagent
WorkingDirectory=/opt/cloud-agent
EnvironmentFile=/etc/cloud-agent/agent.env
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=320
ExecStartPre=/usr/bin/node src/entry/main.mjs --check
ExecStart=/usr/bin/node src/entry/main.mjs --channels wecom
Restart=always
RestartSec=5
RestartPreventExitStatus=2
KillSignal=SIGTERM
TimeoutStopSec=30
MemoryHigh=640M
MemoryMax=768M
LimitNOFILE=4096
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/cloud-agent /var/log/cloud-agent
StandardOutput=append:/var/log/cloud-agent/agent.jsonl
StandardError=append:/var/log/cloud-agent/agent.err

[Install]
WantedBy=multi-user.target
```

要点（每条都有代码依据）：
- `--check` 是真实存在的入口开关，成功输出 `cloud_agent_config_ok` 且退出码 0（【本机已验证】，见 §7）。
- `RestartPreventExitStatus=2`：配置错误退出码是 **2**（`src/entry/main.mjs` 的 `exitCodeFor`），
  不加这行会变成"每 5 秒重启一次的崩溃循环"。
- `ProtectHome=true` 会屏蔽 `~/.mira-secrets/wecom.env` 默认路径，
  所以必须在 `agent.env` 里显式设 `CLOUD_AGENT_WECOM_SECRETS=/etc/cloud-agent/wecom.env`。
- `TimeoutStopSec=30` > `CLOUD_AGENT_SHUTDOWN_TIMEOUT_MS` 默认 20 s（`src/app.mjs` DEFAULTS），
  保证 drain 有机会跑完再被 SIGKILL。
- `Type=simple` + 前台 node 进程：应用把日志写 stdout（JSONL），由 systemd 收走，不要用 nohup/PM2 再包一层。
- 管理 API 默认 `127.0.0.1:8787`（`src/api/contracts.mjs` 的 `DEFAULT_API_HOST`/`DEFAULT_API_PORT`），
  **loopback-only**，不要改 host、不要做公网反代。
- `NODE_OPTIONS=--max-old-space-size=320` 与 `MemoryMax=768M` 是**配对**的：320 → V8 heap limit 512 MB，
  加上约 115 MB 非堆开销 ≈ 630 MB，768M 留约 140 MB（OS + 突发）。
  只改大 `MemoryMax` 而不动 heap 上限，只是把确定性 OOM 换成 swap 抖动——见 §1 的处理顺序。
- `MemoryHigh=640M` 是提前节流（超过后内核开始回收、给应用施压），`MemoryMax=768M` 才硬杀；
  两者都改大之前先降 heap。

【需 Linux 验证】整段 unit 未经 `systemd-analyze verify`（Windows 上无 systemd）。

### 2.4 环境文件（仓库外，`/etc/cloud-agent/agent.env`，`root:cloudagent 0640`）

只列**键名**，值由维护者填；不要把任何值写进仓库或 PR：

```ini
# 模型网关（推理在远端）
CLOUD_PI_MODEL_BASE_URL=
CLOUD_PI_MODEL_API_KEY=
CLOUD_PI_MODEL_ID=
# 状态与运行记录（放 /var/lib，别放 /opt 代码目录）
CLOUD_AGENT_STATE_DIR=/var/lib/cloud-agent/state
RESEARCH_RUNS_DIR=/var/lib/cloud-agent/runs
# 通道与凭据
CLOUD_AGENT_CHANNELS=wecom
CLOUD_AGENT_WECOM_SECRETS=/etc/cloud-agent/wecom.env
# 可选：研究抓取、搜索 provider 等，沿用仓库 .env.example
```

`wecom.env` 同样放 `/etc/cloud-agent/`，权限 `0640`，只含 `WECOM_BOT_ID` / `WECOM_BOT_SECRET` / `WECOM_BOT_NAME`。

### 2.5 单实例锁（一个机器人一条长连接）

- 平台侧：同一机器人**只允许一条长连接**，新连接会把旧连接踢下线（`disconnected_event`），SDK 不会自动重连。
- 本机侧：WeCom 通道在 `stateDir` 写 `wecom-channel.lock`（内容是 owner pid）；
  pid 还活着 → **拒绝启动**；pid 已死 → 视为陈旧锁并接管（`src/channels/wecom/instance.mjs`）。
- 操作要求：**只允许一个 systemd 实例**；扩容/发布时先 `systemctl stop` 再起新进程，不要滚动重启；
  日志里出现 `cloud_agent_lock_acquired` 才算拿到锁。

### 2.6 研究并发 = 1

- tick 间隔默认 30 s（`CLOUD_AGENT_TICK_INTERVAL_MS`，最小值 250 ms），每次 tick 只 claim 一个到期 occurrence
  （`src/scheduler/scheduler.mjs` 的 `_claimNextDue`），**天然串行**。
- 不要为了"快一点"在同一机器人上开第二个进程：既违反 §2.5，也会触发平台 30 条/分/会话的限流。
- 推送频率与时段的产品口径见 [wecom-experience-rubric §6](../product/wecom-experience-rubric.md)
  （P2 每会话 ≤3 条/天、≤1 条/小时；P3 默认 08:00–21:30）；本手册只管主机侧手段，不重复产品规则。

### 2.7 日志上限

系统侧（推荐，因为应用日志走 stdout）：

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nSystemMaxFileSize=50M\n' | \
  sudo tee /etc/systemd/journald.conf.d/cloud-agent.conf
sudo systemctl restart systemd-journald
journalctl --disk-usage
```

若坚持写文件（§2.3 已用 `StandardOutput=append:`），加 `/etc/logrotate.d/cloud-agent`：

```text
/var/log/cloud-agent/*.jsonl /var/log/cloud-agent/*.err {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su cloudagent cloudagent
}
```

`copytruncate` 是给"进程一直持有 fd、不会自己重开文件"的写法；代价是切换瞬间可能丢极少量日志——
本场景可接受（应用不按文件切割，由外部轮转）。

【需 Linux 验证】logrotate 语法与 `su`/`copytruncate` 组合按 logrotate.conf(5)。

### 2.8 时钟（NTP 必须开）

```bash
sudo timedatectl set-ntp true
timedatectl status          # 期望 System clock synchronized: yes
```

也可以用 chrony（`chronyd` + `makestep`）。原因不是"建议"：
- Cloud Auth / Guanlan 的 JWT 有 `exp`/`iat`；
- Guanlan 注册接收端有 **±300 s** 时间窗（HMAC 重放保护）；
- 平台事件（`enter_chat`、`disconnected_event`）与日志时间线要靠本机时钟对齐。

【需 Linux 验证】`timedatectl` 是 systemd 自带；容器里没有 systemd 时改用 chrony。

## 3. 不要在服务器上构建

**规则：服务器只 `node`，不 `npm`。**

理由（保守口径）：`npm ci` 会拉起完整依赖树并做解压/校验，峰值内存远高于运行时；
本机 Windows 上未取得可信峰值（【估算】300–500 MB），但 1C1G + 2G swap 的机器上做这件事没有收益，
一旦被打挂还会留下半装状态。

做法：
1. 本机或 CI 上 `npm ci --omit=dev`（本机实测 **182 包 / 146.3 MB / 5.7 s**）；
2. 打包 `src package.json package-lock.json node_modules`（约 150 MB）→ `rsync`/`scp` 到 `/opt/cloud-agent`；
3. 服务器上只做 `node src/entry/main.mjs --check` 与 `systemctl restart cloud-agent`；
4. 需要回滚时保留上一版目录 + `node_modules`，切 `WorkingDirectory` 或软链即可。

不要在服务器上跑 `npm test` / `npm run build`：测试会加载真实 Pi 运行时与 fixture，内存与 CPU 都不合适。

## 4. 升级判据（可判定，不靠感觉）

| 触发条件 | 判定命令 | 动作 |
| --- | --- | --- |
| 发生 OOM kill | `dmesg -T \| grep -iE 'killed process\|out of memory'` 有 `node` 记录 | 先按本节顺序处理；连续 2 次/周才升内存 |
| 持续 swap | `vmstat 1 5`，`si`/`so` 列**持续 >0**（不是偶发 1 个采样） | 先把 heap 从 320 降到 256 再观察一轮，然后才考虑 2C2G |
| 磁盘 >80% | `df -h /var/lib/cloud-agent` | **先归档**（本节顺序）再扩盘 |
| 单小时多次排队 | `journalctl -u cloud-agent --since '-1h' \| grep -c 'wecom_run_failed'` 显著上升，或 `/v1/status` 显示 pending 堆积 | 升 2C2G（CPU 是瓶颈） |

**升级顺序（不要跳步）**：
1. **先加归档**：压缩/迁走 `runs` 历史、清理旧 journal（`journalctl --vacuum-size=200M`）；
2. **再加盘**：只扩 block storage，不动 CPU/内存；
3. **再升 2C2G**：CPU 型瓶颈（run 排队、tick 延迟）；
4. **最后 2C4G**：内存型瓶颈（OOM 反复出现，且 heap 已从 320 降到 256 仍不够）。

**不要做的事**：不要在没降 heap 的情况下先加大 `MemoryMax`。1C1G 上把内存上限抬到 1 GB 以上，
进程会拿 swap 当内存用，`si/so` 持续非零，整机响应时间崩掉——这比一次干脆的 OOM kill 更难排查。

理由：多数 1C1G 事故是磁盘/日志/runs 增长或泄漏，先升内存只会把问题推迟一周。

## 5. 运维动作（每条都在本机或代码里核对过）

```bash
# 存活
systemctl is-active cloud-agent

# 健康（loopback only；默认端口 8787；本机实测 200 + {"ok":true}）
curl -fsS -m 5 http://127.0.0.1:8787/v1/health

# 长连接被踢（收到即说明有第二个实例或平台侧重连）
journalctl -u cloud-agent --since '-24h' | grep -c wecom_transport_disconnected

# run 失败
journalctl -u cloud-agent --since '-1h' | grep -c wecom_run_failed

# 内存/磁盘
free -m; df -h /var/lib/cloud-agent

# 外部可达（4xx 也算"网络通"，关键是没有超时）
curl -o /dev/null -s -m 5 -w '%{http_code}\n' https://openws.work.weixin.qq.com
```

- `/v1/health` 与 `/v1/status` 都是 **loopback-only**，不要暴露到公网；要看就 SSH 端口转发。
- 日志事件名以代码为准：`cloud_agent_started` / `cloud_agent_stopped` / `cloud_agent_lock_acquired` /
  `wecom_transport_disconnected` / `wecom_run_failed`。
- 平台侧的失败码直接进日志（`93006` 目标无效、`40058` 超长），告警规则见 §6。

## 6. 可观测项清单（照抄即可）

| 监控项 | 采集方式 | 期望 | 告警阈值 |
| --- | --- | --- | --- |
| 进程存活 | `systemctl is-active cloud-agent` | `active` | 非 active 持续 2 min |
| 管理 API | `curl -fsS http://127.0.0.1:8787/v1/health` | `200` + `ok:true` | 连续 3 次失败 |
| 长连接 | `journalctl \| grep wecom_transport_disconnected` | 无 | 出现即告警（多半是双实例） |
| run 失败率 | `journalctl \| grep -c wecom_run_failed` | 低且平稳 | 1 h 内 >3 或突增 |
| 磁盘 | `df -h /var/lib/cloud-agent` | <80% | ≥80% 预警，≥90% 严重 |
| 内存 | `free -m` + `dmesg` OOM 检查 | 无 OOM | 出现 OOM kill |
| swap 活动 | `vmstat 1 5` | si/so 偶发 | 持续 >0 |
| 外部端点 | `curl -m 5` 到平台与模型网关 | 有 HTTP 响应 | 连续超时 |
| 计划数 | `/v1/status` | 与预期一致 | 突然归零（调度未加载） |

## 7. 验证状态（本次实际做了什么）

| 内容 | 状态 | 证据 |
| --- | --- | --- |
| 裸 Node 与统一入口 RSS | ✅ 本机实测 | 59.9 MB / 156.4 MB（§1） |
| `--max-old-space-size=320` 生效 | ✅ 本机实测 | heap_limit **512 MB** |
| `NODE_OPTIONS=--max-old-space-size=320` 生效 | ✅ 本机实测 | 同上（另测 384 → 576 MB 作对照） |
| `node --env-file-if-exists` 可用 | ✅ 本机实测 | Node v24.9.0 接受该参数 |
| `src/entry/main.mjs --check` | ✅ 本机实测 | 退出码 0 + `cloud_agent_config_ok` |
| 用 `--channels none --api-port` 起进程并访问 `/v1/health` | ✅ 本机实测 | 200 + `{"ok":true,...}`；`/v1/status` 200 |
| `npm ci --omit=dev` 体积/耗时 | ✅ 本机实测 | 182 包 / 146.3 MB / 5.7 s |
| systemd unit / logrotate / sysctl / swapon | ⚠️ 需 Linux 验证 | 按 systemd、logrotate、procps 手册写，未执行 |
| 单 run 峰值、每 run 归档大小、`npm ci` 峰值 | ⚠️ 未实测 | 装机后按 §7.1 的三次测量回填再定磁盘预算 |
| 真实部署 | ❌ 未做 | 本文是手册，不代表已上线 |

### 7.1 首次装机后的三次测量（回填本表，再定磁盘预算）

装完、`systemctl start` 正常之后，**先做三次测量再定磁盘和是否升配**。
前提：2 GB swap 已生效（`swapon --show` 有输出）、`free -m` 看过。三条都在服务器上执行。

**测量 1 — 单 run 峰值 RSS**（研究任务跑起来的那段时间采样，取最大值）：

```bash
# 另开一个 SSH 会话，run 进行中执行；Ctrl-C 停止采样（采样结果落到文件，不会被 SIGINT 冲掉）
: > /tmp/rss.log
while systemctl is-active -q cloud-agent; do
  pgrep -f 'src/entry/main.mjs' | head -1 | xargs -r ps -o rss= -p >> /tmp/rss.log
  sleep 2
done
sort -n /tmp/rss.log | tail -1        # 单位 KB，除以 1024 得 MB
```

**测量 2 — 每 run 归档大小**（连跑 3 次后看中位数）：

```bash
du -sm /var/lib/cloud-agent/runs/* | sort -n | tail -3
```

**测量 3 — `npm ci` 峰值（带 swap，只为验证「别在服务器上装依赖」）**：

```bash
mkdir -p /tmp/npm-probe && cd /tmp/npm-probe
cp /opt/cloud-agent/package.json /opt/cloud-agent/package-lock.json .
/usr/bin/time -v npm ci --omit=dev 2>&1 | grep 'Maximum resident set size'
cd / && rm -rf /tmp/npm-probe
```

填这张表（把「待实测」替换成数字）：

| 项 | 首次测量值 | 判读 |
| --- | --- | --- |
| 单 run 峰值 RSS | ___ MB | >614 MB（768M 的 80%）→ 先把 heap 降到 256 重测；仍超再按 §4 升 2C2G |
| 每 run 归档中位数 | ___ MB | 预算 = 中位数 × 每天 run 数 × 保留天数；`df` ≥80% 先归档再加盘 |
| `npm ci` 峰值 | ___ MB | 只用于验证判断，**不要**把 npm 装到 `/opt/cloud-agent` |

三次数据齐了才算装机完成；把结果回填 §1 的两行「未实测」和 §4 的判据，并删掉本节里对应的「待实测」。

【需 Linux 验证】三条命令依赖 `ps`/`du`/`/usr/bin/time -v`（GNU time）与 systemd；Windows 上无法执行。

## 8. 与既有文档的关系（不重复）

- 入口装配、生命周期、健康字段、已知边界：[agt-037-unified-runtime.md](agt-037-unified-runtime.md) §3/§8/§9。
- 推送时段与频率的产品口径：[wecom-experience-rubric.md](../product/wecom-experience-rubric.md) §6（P1–P5）。
- 企业微信侧的硬限制（单连接、20480 字节、`93006`）：[v1-boundaries-onepager.md](../research/wecom-channel/v1-boundaries-onepager.md)。
- 投递到企业微信目标的接线仍是 t25 范围；本手册不假设该能力已完成。
