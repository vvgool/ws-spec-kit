# Task 4 Fix Round 1 报告

## 结论

- `task-4-review.md` 的 3 项 Important finding 已按 TDD 修复。
- 修复限定在条件执行后的 Close requirement、Gate Evidence 的 Step/Attempt 绑定，以及独立 Review 的语义角色识别；按要求忽略 Minor typed-error finding。
- 未开始 Task 5，未执行 merge、push、publish 或真实外部平台验收。

## Finding 映射

### 条件跳过传播到完整 Close requirement

- `closeChecklist()` 以同一份运行时有效 Step-instance 遍历统一生成 Artifact、Approval 和 Gate requirement。
- 被禁用或运行时跳过的父 Step 会豁免全部后代；顶层或循环内自身被跳过的 Step 也不会产生伪 requirement。
- 循环子 Step 保留 `loopId:iteration:stepId` 具体实例身份；同名 Gate 出现在多个 Step instance 时，每个实例都必须有自身 Evidence，不能跨 Step 复用。

### Gate Evidence 精确绑定当前 Step 与 Attempt

- Close 只从 `evidenceProjectionKey(stepInstanceId, gateId)` 读取对应 Evidence，不再遍历任意同名 Gate 记录。
- `isFreshGateEvidence()` 增加当前 `attemptId` 输入，并与 Evidence 的 `attemptId` 精确比较。
- 当前 Context 尚未 completed、没有 Attempt，或 Evidence 属于旧 Attempt 时均 fail closed。

### 独立 Review 使用显式语义角色

- Workflow Step 新增可选 `actorRole: implementation | review | fix`，并贯通严格 YAML parser、编译结果、Application Snapshot 序列化/解析、两个内置 Workflow、公开语言文档与合同测试。
- `acquire` 与 `close` 共用 `src/engine/actor-roles.ts` 推导实现、历史 Fix 和 Review Actor，不再识别 `implement`、`edit-document`、`review`、`fix` 等固定 Step ID。
- 重命名实现 Step、Review-Fix loop 和 Review child 后，Acquire 与 Close 仍按角色执行独立 Actor 约束；非法 Snapshot 角色 fail closed。

## TDD 证据

新增四个审查反例后，先运行：

`node --import tsx --test tests/integration/workflow-close.test.ts`

RED 阶段为 13 passed、4 failed：

- `PARENT_SKIP`：错误报告 `artifact:child-output`、`approval:child-requirements`、`evidence:child-gate`。
- `STEP_GATE_SKIP`：错误报告 `evidence:test`。
- `OLD_ATTEMPT`：旧 Attempt Evidence 被错误接受。
- `RENAMED_REVIEW`：语义不变但重命名后的 Workflow 被错误拒绝。

GREEN 阶段同一 Close 聚焦套件为 18 passed、0 failed，并新增同名 Gate 不得跨 Step instance 复用的回归。

## 最终验证

| 验证 | 结果 |
| --- | --- |
| Close 聚焦套件 | PASS，18 passed，0 failed |
| Profile Runtime 聚焦套件 | PASS，17 passed，0 failed |
| 相关十文件矩阵 | PASS，210 passed，0 failed |
| `npm test` | PASS，412 passed，0 failed，0 skipped |
| `npm run lint` | PASS，exit 0 |
| `npm run typecheck` | PASS，exit 0 |
| `npm run build` | PASS，exit 0 |
| `npm run schemas:generate` | PASS，exit 0 |
| `git diff --exit-code -- schemas` | PASS，生成 Schema 无差异 |
| `git diff --check` | PASS，exit 0 |

## 证据边界与兼容性

- 本报告只证明当前 checkout 的本地静态、单元与集成门禁；没有真实外部服务、宿主发现或生产验收证据。
- `actorRole` 属于 Workflow/Application Snapshot 结构，不修改 `src/schemas/definitions.ts` 生成的公共 JSON Schema。
- 修复前已经创建且仍处于活动状态的 Governed Snapshot 不含 `actorRole` 时，运行时无法安全推断语义角色，会按 fail-closed 拒绝独立 Review；这类 Work Item 需要重新创建符合当前 Workflow 的 Snapshot。
- 未处理审查中的 Minor typed-error finding，也未开始 Task 5。
