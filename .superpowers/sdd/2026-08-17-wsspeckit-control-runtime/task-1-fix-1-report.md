# Task 1 修复轮次 1：有限表达式与条件执行

## 结论

本轮关闭独立审查 `task-1-review.md` 中的 3 个 P1：编译与运行时表达式语法不一致、零事件恢复绕过条件根 Step、以及缺失路径参与 `!=` 时错误启用 Step。

本提交只覆盖 Task 1 的表达式、初始状态和恢复语义。未启动 Task 2 的有界循环运行时，未 merge、push、publish 或执行外部平台验收。

## RED / GREEN

### P1-1：Compiler 与 Runtime Parser 复用同一有限 AST

- RED：新增复合条件测试后，旧 Compiler 正则拒绝 `${bindings.issue.exists && (bindings.knowledge.exists == false)}`；旧的 `${review-result.approved}` 也与 Runtime 允许的根路径不兼容。
- GREEN：Compiler 改用 `parseExpression()` 和 `ExpressionAst`，递归校验 `bindings`、`artifacts`、`steps` 引用可达性、属性及逻辑/比较类型。内置 Workflow、公开参考和夹具统一使用 `${artifacts.review-result.approved}`。
- 回归：Compiler 可接受复合 Binding/Artifact 条件，并继续拒绝未知、未来、禁用或类型错误的引用。

### P1-2：零事件恢复与 start 共享初始状态派生

- RED：损坏零事件 `runtime.json` 后恢复，会把带 `when: false` 的根 Step 从初始状态重建为 `ready`，从而绕过条件。
- GREEN：新增 `deriveInitialStages(profile)`，由 `startApplication()` 与 `recoverControlPlane()` 共用；无依赖且带条件的 Step 一律初始化为 `pending`。
- 回归：恢复后条件根 Step 仍为 `pending`；首次 `acquire` 原子写入 `step.skipped`，并调度下一个可执行 Step。

### P1-3：缺失路径在所有条件上下文 fail closed

- RED：当 Binding 路径缺失时，旧实现将其解析为 `undefined`，`${bindings.issue.exists != false}` 会得到 `true`。
- GREEN：表达式求值引入内部 `missing` sentinel。缺失值参与 `==`、`!=` 或逻辑表达式时向外传播，最终解析为 `false`；`false && rhs` 与 `true || rhs` 仍保持短路行为。
- 回归：bare、`==`、`!=`、`&&`、`||` 的缺失路径组合都 fail closed，同时已有真实布尔条件继续正常计算。

## 最终验证

以下命令针对本报告对应的未提交候选树执行：

| 门禁 | 结果 |
| --- | --- |
| `node --import tsx --test tests/unit/expressions.test.ts tests/unit/compiler.test.ts tests/integration/conditional-step.test.ts` | PASS，42 passed，0 failed |
| `npm run typecheck` | PASS，exit 0 |
| `npm run build` | PASS，exit 0 |
| `npm test` | PASS，355 passed，0 failed，0 skipped，69.4s |
| `git diff --check` | PASS |
| `rg -n '\\$\\{review-result\\.approved' docs/reference resources src tests` | PASS，无旧路径命中 |

## 残余边界

- 本地静态与自动化门禁通过，不构成生产或外部宿主验收结论。
- `artifacts.review-result.approved` 的结构化运行时产出供后续 Task 2 循环投影实现；本轮仅统一语言合同并验证当前顶层条件调度，不提前实现循环运行时。
