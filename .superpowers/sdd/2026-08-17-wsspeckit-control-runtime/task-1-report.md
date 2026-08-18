# Task 1 报告：有限表达式与条件执行

## 范围

基线为 `cfef24c`。本任务只实现有限表达式和顶层条件步骤跳过：未开始循环执行、Profile 迭代、merge、push 或发布。

## 实现

- 新增 `ExpressionAst`、手写 tokenizer/parser 和求值器。仅接受字面量、`artifacts`/`bindings`/`steps` 静态路径、`==`、`!=`、`&&`、`||`、括号及工作流 `${...}` 包装。
- 拒绝未知根、函数调用、赋值、`__proto__`/`constructor`/`prototype` 和超过 1024 字符的表达式；实现中没有 `eval`、`Function` 或由输入决定的属性访问。
- 从运行投影构造 Artifact、Binding 和 Step scope；缺失 Binding 解析为 `false`。
- 首个带条件的 Step 启动为 `pending`，由 acquire 统一求值。条件为 false 时，原子投影事件记录为 `step.skipped`，携带 `stageId` 与 `skippedStepIds`；事件快照由既有回放机制恢复相同的 `skipped` 状态。
- 新增表达式错误码公开合同及中文参考登记，`acquire` 路由可机器识别这些 typed error。

## TDD 证据

- RED：`node --import tsx --test tests/unit/expressions.test.ts tests/integration/conditional-step.test.ts` 先因新模块不存在失败；创建模块后，集成测试又确认旧实现把 `when: false` 的 `intake` 错误地作为 `execute` 返回。
- GREEN：聚焦表达式、条件回放和公开错误码测试通过。补充 `step.skipped.stageId` 断言后先得到 `null !== "intake"` 的预期失败，再实现动态事件 stage metadata 并转绿。

## 验证

- `node --import tsx --test tests/unit/expressions.test.ts tests/integration/conditional-step.test.ts tests/contract/documentation-baseline.test.ts`：15 passed，0 failed。
- `npm run typecheck`：通过。
- `npm test`：352 passed，0 failed（最后一次完整运行，约 72s）。
- `git diff --check`：通过。

## 自审

- 路径读取在求值器中使用 own-property 检查；Artifact view 使用无原型字典。
- 条件跳过和下一动作写在同一 `mutateControlPlane` 事务事件中，投影写入失败后仍能通过追加事件回放。
- 本任务没有修改循环控制、Profile 策略或外部 Connector 行为。
