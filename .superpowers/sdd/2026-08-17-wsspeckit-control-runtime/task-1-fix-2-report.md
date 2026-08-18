# Task 1 修复轮次 2：Snapshot 边界与嵌套条件作用域

## 结论

本轮关闭 `task-1-fix-1-rereview.md` 中的 1 个 P1 和 2 个 P2。Task 1 的有限表达式、条件执行、snapshot 读取和嵌套静态作用域在当前候选树上保持同一有限语言合同。

本轮明确采用项目既定边界：不为 `${review-result.*}` 增加兼容 Parser，不迁移或内存规范化旧公开协议。携带旧 Artifact 简写的 Application Snapshot 会在读取时立即以 `WSSPEC_APPLICATION_SNAPSHOT_INVALID` fail closed，不能读取成功后才在运行时条件求值失败。

未开始 Task 2 有界循环运行时，未 merge、push、publish 或执行外部平台验收。

## RED / GREEN

### P1：旧 snapshot 表达式在读取边界拒绝

- RED：将真实新建 snapshot 的 `review-fix.until` 改回 `${review-result.approved}` 并同步 manifest/anchor 摘要后，`parseApplicationSnapshot()` 仍接受；损坏投影后 `recoverControlPlane()` 也成功，直到运行时求值才可能抛出 Parser 错误。
- GREEN：`parseSnapshotStep()` 对 `when` 与 `until` 调用正式 `parseExpression()`；任一 Parser 失败都转换为稳定的 `WSSPEC_APPLICATION_SNAPSHOT_INVALID`。
- 回归：直接读取旧简写 snapshot 与同步摘要后的恢复均拒绝；没有为旧根路径添加兼容逻辑。

### P2：嵌套 Step 的声明集与可达集分离

- RED：嵌套 `fix.when = ${steps.verify-green.status == 'succeeded'}` 中，父 control Step 的依赖已在可达集合内，却因递归层只传入兄弟 Step 声明集而被报为 `WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNKNOWN`。
- GREEN：Compiler 在表达式校验开始时构造递归 `flatten(compiledSteps)` 的全局声明 Step 集；每层保留单独的 `availableSteps` 进行可达性判断。
- 回归：父级可达依赖可编译，嵌套 future Step 稳定报 `WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNAVAILABLE`，未知 Step 稳定报 `WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNKNOWN`。

### P2：权威设计规格条件与 Parser 保持一致

- RED：规格中的 4 个 `${review-result.approved}` / `${review-result.approved == false}` 示例被正式 Parser 拒绝。
- GREEN：功能交付和文档交付的四处示例统一为 `artifacts.review-result.approved`。
- 回归：需求追踪合同测试提取权威设计规格中的全部 `${...}` 条件，并逐一交给正式 Parser；旧根路径再出现会导致合同失败。

## 最终验证

以下门禁在本报告对应的未提交候选树执行：

| 门禁 | 结果 |
| --- | --- |
| RED：`node --import tsx --test tests/unit/compiler.test.ts tests/integration/application-flow.test.ts tests/contract/requirements-traceability.test.ts` | 106 tests，5 个预期失败：旧规格、旧 snapshot 读取/恢复、嵌套父依赖 |
| GREEN：同一聚焦命令 | PASS，106 passed，0 failed |
| `npm run typecheck` | PASS，exit 0 |
| `npm run build` | PASS，exit 0 |
| `npm test` | PASS，358 passed，0 failed，0 skipped，71.4s |
| `git diff --check` | PASS |
| `rg -n '\\$\\{review-result\\.approved' docs/reference docs/superpowers/specs resources src tests` | 仅两个明确的旧 snapshot 拒绝测试夹具命中 |

## 残余边界

- 本地自动化、类型检查和构建通过，不等于生产、跨版本升级或外部宿主验收通过。
- 已存在旧简写 snapshot 不迁移且不能继续执行，这是显式 fail-closed 策略；操作者需新建符合当前有限表达式合同的 Work Item。
- `artifacts.review-result.approved` 的循环运行时结构化投影仍属于 Task 2，本轮未开始实现。
