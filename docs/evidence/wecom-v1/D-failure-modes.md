# 场景 D · 故障与权限（未授权 / 无效凭证 / 重复 / 重启 / 投递失败）证据骨架

> 状态：**离线部分已可执行**；企微侧负例（D1-wecom / D2-wrong-secret / D6）**未执行**
> （依赖 t6 的企微通道与凭证）。填写人：______ 填写时间：______
> 判据来源：[acceptance-matrix.md §D](../../engineering/acceptance-matrix.md)；脚本：`scripts/agt-03x/d-failure-modes.mjs`

## 0. 执行元信息

| 项 | 值 |
| --- | --- |
| 命令 | `node scripts/agt-03x/d-failure-modes.mjs --evidence poc/evidence/agt-03x-d.jsonl` |
| 开始 / 结束时间（含时区） | |
| 仓库 HEAD（cloud-pi） | |
| 证据文件 | `poc/evidence/agt-03x-d.jsonl` |

## 1. 判据勾选（离线部分，真实执行）

- [ ] **D1 飞书负例**：`tests/agt-029-policy.test.mjs` + `tests/agt-029-channel.test.mjs` 全绿（非 @ / 非文本 / 非 user 一律忽略，且不调用模型）
- [ ] **D2 配置 fail-closed**：空 `FEISHU_*` 启动 `src/channels/feishu/server.mjs` → 退出码 **2**，且无网络请求，耗时 < 10s
- [ ] **D3 去重**：`tests/agt-029-dedupe.test.mjs` 全绿（同一消息只产生一次运行）
- [ ] **D4 重启幂等**：`scripts/agt-034/api-smoke.mjs` exit 0 且输出 `{"event":"result","ok":true}`
- [ ] **D4 恢复**：`scripts/scheduler-poc-evidence.mjs` 出现 `interrupted` 恢复场景且 `POC evidence complete`
- [ ] **D5 有界重试**：`tests/agt-033-transport.test.mjs` 全绿（稳定错误码、不无限重试）
- [ ] **D8 证据不自泄**：扫描 `poc/evidence` + `docs/evidence` 的 `.jsonl/.md/.json`，零密钥形状命中

## 2. 判据勾选（企微侧，未执行 → 必须保持未勾选）

- [ ] **D1-wecom**：企微群内非 @ / 非文本 / 未授权成员提问被忽略（**blocker：t6 未交付**）
- [ ] **D2-wrong-secret**：真实 app id + 错误 secret → 明确失败且不重试风暴（**blocker：缺凭证**）
- [ ] **D6**：企微 `/stop` 取消语义（**blocker：t6 未交付**）

> 未执行项在矩阵里记为 `blocker`，**不得**为了「全绿」而勾选。

## 3. 判定输出（贴 result 行，勿手写）

```jsonl
（粘贴 poc/evidence/agt-03x-d.jsonl 中 event=result 的那一行）
```

## 4. 结论

- 判定：`pass` / `fail` / `blocker`
- 若 fail/blocker，原因与责任方：
- 遗留风险：

## 5. 复现命令

```bash
node scripts/agt-03x/d-failure-modes.mjs --evidence poc/evidence/agt-03x-d.jsonl
node scripts/agt-03x/d-failure-modes.mjs --dry-run     # 只打印将要做什么
```
