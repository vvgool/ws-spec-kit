# Task 3 Fix Round 1 报告

## 结论

- `task-3-review.md` 的 2 项 P1 与 1 项 P2 已按严格 TDD 修复。
- 修复限定在 Task 3 的 Profile 运行时选择、风险持久化与 Governed Review 独立 Actor 约束；未开始 Task 4，未实现其审批、可信 Gate 或 Close 收口。
- 本轮验证基于 `fa9b23c` 之后的当前工作树；提交前所有必需门禁均通过。

## Finding 映射

### P1：失败 Submit 丢失风险信号

- 风险评估移到可信 Result 校验和 Attempt 记录之后、成功/失败分支之前。
- 每次已验证 Submit 都合并并持久化规范化风险信号；Profile 决策、失败 Stage、Retry 预算与返回 Action 在同一个 `mutateControlPlane()` 事件中原子提交。
- 真实 workspace 修改 `src/auth/session.ts` 后提交 retryable failure，会立即升为 Governed。相同 Submit 并发重复返回同一结果且仅产生一个 `profile.upgraded` 事件。
- 随后的 Retry 不产生新 diff 时仍保持 Governed；破坏 `runtime.json` 后从事件链恢复仍保持 Governed。
- 永久失败与可重试失败均经过同一前置风险评估，之后分别保持原有的阻塞与 Retry 预算语义。

### P1：Governed Review 只检查单个 Actor

- Review Acquire 从当前 Profile 中识别适用的顶层实现 Step，并收集其 completed Actor。
- 同时解析当前轮之前所有 `review-fix:<iteration>:fix`，收集每个 completed Fix Actor；跳过未完成或 skipped Fix。
- 任一适用顶层实现记录未完成、任一 completed 实现/Fix 缺少非空 Actor，均 fail closed，返回 `WSSPEC_INDEPENDENT_REVIEW_REQUIRED`。
- 当前 reviewer 命中原实现者、较早 Fix Actor 或最近 Fix Actor均被拒绝；独立 reviewer 可获得当前 Review Work Package。破坏投影并从事件恢复后，矩阵结果不变。

### P2：Auto 在 Explore 前结束 provisional

- Runtime Profile 新增持久化 `riskSignals`，累计 risk level、受影响路径、实际修改路径、Issue label、文件类型与计划动作。
- Auto + provisional 在非 Explore Submit 只累计信号，不产生正式 Profile 决策，继续以 provisional Quick 执行。
- Explore Submit 合并此前 Intake 与本次信号后完成首次正式选档；Intake high + Explore low 仍选择 Governed，不允许风险被后续低信号覆盖。
- 显式 Profile 不受 provisional 边界限制，Intake high 仍可立即单向升级。
- 普通读取与事件链重放都会为旧版 Profile 投影补齐空 `riskSignals`，保证向后兼容。

## TDD 证据

RED 阶段新增回归测试后，观察到审查中的反例按预期失败：

- 失败敏感 Attempt 后 Profile 仍为 Quick，而非 Governed。
- Intake low 在 Explore 前错误结束 provisional。
- 第三轮 Review 错误放行原实现者。
- completed 历史 Fix 缺少 Actor 时未能 fail closed。

GREEN 阶段：

- `node --import tsx --test tests/integration/profile-runtime.test.ts`：14 passed，0 failed。
- 其中覆盖失败 Submit 原子性/并发/恢复、Auto Intake low/high 累计与恢复、显式 Profile、完整 Actor 集合、缺失 Actor fail closed，以及旧事件投影兼容。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| Profile Runtime 聚焦套件 | PASS，14 passed，0 failed |
| Profile/Recovery/Approval/Retry/Loop/Compiler 六文件矩阵 | PASS，83 passed，0 failed |
| `npm test` | PASS，388 passed，0 failed，0 skipped |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

## 证据边界

- 未执行真实外部宿主、发布或生产验收；这些不属于本轮 Task 3 修复范围。
- 未 merge、push、publish，也未开始 Task 4。
