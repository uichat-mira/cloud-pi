# 场景 C · 飞书回归（不得退化）证据骨架

> 状态：**离线部分已可执行**；C4 真实往返**未执行**。填写人：______ 填写时间：______
> 判据来源：[acceptance-matrix.md §C](../../engineering/acceptance-matrix.md)；脚本：`scripts/agt-03x/c-feishu-regression.mjs`

## 0. 执行元信息

| 项 | 值 |
| --- | --- |
| 命令 | `node scripts/agt-03x/c-feishu-regression.mjs --full [--live] --evidence poc/evidence/agt-03x-c.jsonl` |
| 开始 / 结束时间（含时区） | |
| 仓库 HEAD（cloud-pi） | |
| Node / 平台 | |
| 基线对照 | baseline §4：总 555 / pass 553 / fail 2（两个 Windows 已知缺陷）；feishu 48、api 26、scheduler 31、targets 29 |

## 1. 判据勾选

- [ ] **C1 飞书套件**：`tests/agt-029-*.test.mjs` 全绿且 `tests ≥ 48`
- [ ] **C2 API**：`tests/agt-034-*.test.mjs` 全绿且 `tests ≥ 26`
- [ ] **C2 调度**：`tests/scheduler-t*.test.mjs` 全绿且 `tests ≥ 31`
- [ ] **C2 targets**：`tests/agt-035-*.test.mjs` 全绿且 `tests ≥ 29`
- [ ] **C5 策略 + 去重**：`tests ≥ 11`
- [ ] **C6 运行时面收敛**：`createAgentSession` 只出现在 `src/runtime.mjs` / `src/research/port.mjs`
- [ ] **C3 全量**（`--full`）：`tests ≥ 555`，失败集合 ⊆ 两个已知 Windows 缺陷
- [ ] **C4 真实飞书往返**（`--live`）：`poc/evidence/agt-029-live.jsonl` 同时含 `message.received` 与 `reply.sent`

## 2. 判定输出（贴 result 行与各 suite 行，勿手写）

```jsonl
（粘贴 poc/evidence/agt-03x-c.jsonl 中的 suite 行与 event=result 行）
```

## 3. 已知缺陷（不得用来掩盖新增失败）

| 用例 | 位置 | 归属 |
| --- | --- | --- |
| `resolveRunsRoot: explicit > env > default` | `tests/research-store.test.mjs:52` | Windows 路径语义，t7 修 |
| `adapter: system prompt and cwd isolation through Pi` | `tests/research-verify-adapter.test.mjs:162`（子测试 202） | 同上 |

新增任何一条不属于上表的失败，C3 判 `fail`，不因「基线也有 2 条失败」而放行。

## 4. 真实飞书观测（C4，脱敏）

| 项 | 值 |
| --- | --- |
| 群聊是否为白名单内（是/否） | |
| 是否 @ 机器人（是/否） | |
| 回复条数 / 是否重复 | |
| 未授权成员提问是否被忽略（是/否） | |

## 5. 结论

- 判定：`pass` / `fail` / `blocker`
- 若 fail/blocker，原因与责任方：
- 遗留风险：

## 6. 复现命令

```bash
node scripts/agt-03x/c-feishu-regression.mjs --full --evidence poc/evidence/agt-03x-c.jsonl
FEISHU_APP_ID=... FEISHU_APP_SECRET=... node scripts/agt-03x/c-feishu-regression.mjs --live --evidence poc/evidence/agt-03x-c-live.jsonl
```
