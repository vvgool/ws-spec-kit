# Task 3 报告：Profile 运行时选择、升级与失效传播

## 范围

基线为 `a9c4272`。本任务实现 Application Runtime 的 Profile 初选、风险驱动单向升级、失效传播、事件恢复和 Governed 独立 Review Actor 约束；未实现 Task 4 的审批、可信 Gate 与 Close 收口，也未执行 merge、push、publish 或外部宿主验收。

## 需求映射

| 需求 | 实现与证据 |
| --- | --- |
| Auto provisional Quick | `start` 持久化 `mode/selected/provisional/reasonRuleIds`；Auto 在 intake/explore 期间使用 provisional Quick，并写入 `profile.selected`。 |
| Explore 后分流 | Explore Submit 后根据 low/unknown/high 选择 Quick/Standard/Governed；显式 Profile 不因 unknown 或较低风险降级，但确定的更高风险仍可升档。 |
| 风险规则 | 汇总 requirement risk、Issue label、受影响路径、实际修改路径、文件类型和计划动作；敏感路径、文件类型与外部动作可触发 Governed 下限。Agent 提交的风险文本只能提高强度，`modifiedFiles` 仍由实际 workspace diff 校验。 |
| 单向升级 | `applyProfileDecision()` 拒绝 stale decision 和 Profile 降级，稳定错误码为 `WSSPEC_PROFILE_DECISION_STALE`、`WSSPEC_PROFILE_DOWNGRADE_FORBIDDEN`。 |
| Overlay 与补回 Step | 启动时编译并快照 Quick/Standard/Governed 三套 overlay；升级只比较已验证、已锚定的快照，不重新读取可变 Workflow。原 Quick 中被跳过而在新 Profile 必需的 Step 会回到新图的初始可执行状态。 |
| 失效传播 | 一次性清理受影响 Context、Claim、Approval、Evidence、Loop 与 Retry；失效 pending Approval 时 Work Item 从 `awaiting_approval` 回到 `active`。已成功或取消的不可逆 Step 状态不倒退。 |
| 原子事件与恢复 | `profile.selected` / `profile.upgraded` 事件携带完整运行投影；升级的 `invalidatedStepIds` 与 Submit 结果在同一 control-plane 锁和同一追加事件中提交。这里不为同一次升级再追加第二个 `projection.invalidated`，避免 crash 后只落一半状态。损坏 `runtime.json` 时可从事件恢复 Profile、Loop 与 Retry。 |
| 并发幂等 | Profile 决策和 Submit 共用 `submit:<attemptId>` 幂等键；两个并发重复 Submit 只追加一个升级事件并返回相同动作。 |
| 独立 Review Actor | Governed Review 拒绝与顶层 `implement` / `edit-document` 相同的 Actor；第 2+ 轮还会拒绝上一轮 `fix` Actor，缺少独立 Actor 时返回 `WSSPEC_INDEPENDENT_REVIEW_REQUIRED`。 |
| Runtime-selected Profile | `acquire`、`submit`、`inspect` 与恢复均以运行投影中的 selected Profile 覆盖初始快照选择。 |

## TDD 证据

- 初始 RED：`profile-runtime.test.ts` 因缺少 `src/application/profile.ts` 和运行时应用而失败；随后实现 Profile 投影、策略应用、原子事件和恢复路径。
- 原始 GREEN 覆盖 provisional Quick、low/unknown/high 分流、显式 Profile 不降级、敏感路径升档、失效传播、并发 Submit、事件恢复和首轮独立 Review。
- 自审 RED：Governed 第 2 轮 Review 由上一轮 Fix Actor 获取时，新增测试稳定报 `Missing expected rejection`，其余 7 个 Profile 用例通过。
- 自审 GREEN：独立 Review 校验优先读取上一轮 `review-fix:<iteration>:fix` Actor；Profile 用例 8/8、Profile + Review-Fix 用例 17/17 通过。

## 自审结论

- Node.js/TypeScript 暂存差异自审后，Critical 0、Important 0。
- 已修复一项 Important：独立 Review 原先只追踪顶层实现者，未追踪上一轮 Fix Actor，可能允许同一 Actor 修复后立即自审。
- `remainingRisks` / `evidence` 中的风险信号属于 Agent 输入，但只能导致保持或升档，不能放宽策略；实际修改文件仍由 Git diff 与声明列表精确比对。
- Profile 升级复用现有 control-plane 锁、事件先于投影和幂等回放机制；失效集不拆成独立第二事件。

## 最终验证

以下门禁已在当前未提交候选树上新鲜执行：

| 门禁 | 结果 |
| --- | --- |
| `node --import tsx --test tests/integration/profile-runtime.test.ts` | PASS，8 passed，0 failed |
| Profile + Recovery + Approval/Evidence + Retry/Loop 聚焦测试 | PASS，40 passed，0 failed |
| `npm test` | PASS，382 passed，0 failed，0 skipped |
| `npm run typecheck` | PASS，exit 0 |
| `npm run build` | PASS，exit 0 |
| `git diff --cached --check` | PASS |

## 证据边界

- 本任务只证明当前 checkout 的本地 Profile Runtime、Application Protocol、事件恢复和并发幂等行为。
- Task 4 的审批关闭、可信 Gate 和最终 Close 判定仍未实现；本任务不能作为完整控制流或生产就绪结论。
- 未执行真实 Codex/Claude/Cursor 宿主发现、真实外部写入、发布或生产验收。
