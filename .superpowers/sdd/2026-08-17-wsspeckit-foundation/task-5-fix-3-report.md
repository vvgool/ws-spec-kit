# Task 5 Fix Round 3 Report

## 状态

DONE

## RED 证据

全部测试均在 `PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH` 下执行。

- 先扩展 `tests/integration/skill-lock.test.ts`：从主项缺失时创建 `selection: fallback` 的 Lock，再让两个 Global 根恢复不同摘要的同名主项。旧实现运行该集成测试时为 17 passed、1 failed，失败码为 `WSSPEC_SKILL_AMBIGUOUS`，栈定位到 `resolveSkill()` 在应用 selection 前解析主项。
- 同一用例补充非法相对 Global 根后，临时撤掉 Resolver 修复并定向重跑，旧实现稳定失败为 `WSSPEC_SKILL_PATH_INVALID`。恢复修复后该用例通过，证明已锁 fallback 不再进入 primary 根解析或校验。
- 新增 `selection: primary` 控制用例在旧实现和修复后均返回 `WSSPEC_SKILL_AMBIGUOUS`，确认修复没有放宽已锁主项的恢复约束。

## 修复摘要

- `resolveSkill()` 先完成 Lock 的严格解析和绑定身份校验，再仅对 `started + locked.selection === "fallback"` 建立恢复分支。
- 该分支跳过未选中 primary 的 `resolveReference()`，仍解析并验证 Workflow 声明的 fallback，因此 Global 主项缺失、恢复、根路径错误或不同摘要歧义都不会污染已锁 fallback。
- 其他状态继续解析 primary：`started + selection: primary` 仍会暴露 Global 歧义；`not_started + selection: primary` 仍允许主项缺失后切换到完全匹配的已锁 fallback。
- fallback 声明漂移和 fallback/selected 同步伪造摘要仍由 `assertFallbackLock()` 拒绝为 `WSSPEC_SKILL_LOCK_CHANGED`。

## Finding 对照

| Finding | 状态 | 证据 |
|---|---|---|
| Important 1：selection 已锁为 fallback 时，未选中的 Global primary 解析异常阻断恢复 | CLOSED | fallback selection 在非法 Global 根和两个不同摘要 Global 候选下均恢复声明 fallback；primary selection 在相同歧义条件下仍拒绝；fallback 声明及摘要漂移仍拒绝。 |

## 验证结果

- Task 5 聚焦测试：30 passed，0 failed，0 skipped。
- `npm run typecheck`：passed。
- `npm test`：185 passed，0 failed，0 skipped。
- `npm run build`：passed。
- `git diff --check`：passed（无输出）。

## 范围审计

- 仅修改 Task 5 的 Skill Resolver、Skill Lock 集成测试和本报告。
- 未修改 Lock schema、Workflow Package、Work Item、事件或 Task 6 文件。
- 未改变 `not_started` 的 fallback 转换规则，也未改变 `started + selection: primary` 的 fail-closed 行为。

## Commit

独立提交信息：`fix: isolate locked fallback resolution`。

## 未解决项

无已知 Task 5 未解决项。Work Item、事件与最终持久化路径的端到端集成仍属于后续任务。
