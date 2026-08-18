# Task 2 报告：重试与有界 Review-Fix 循环

## 范围

基线为 `29d1a3d`。本任务实现 Application `acquire/submit` 上的持久重试与单层有界 `control.loop` 运行时；未开始 Task 3、Profile 动态升级、merge、push、publish 或外部宿主验收。

## 实现

- 新增 `RetryProjection` 与 `LoopProjection`，随控制平面事件持久化并在投影损坏、进程中断或 Lease 过期后恢复；重试预算不会因重启重置。
- 每个内部 Step 使用 `loopId:iteration:stepId` 实例 ID。循环内按 `needs` DAG 调度，成功或跳过的依赖均可解锁后继；每轮 Attempt、Artifact、状态与幂等 Submit 相互隔离。
- `until` 只在当前轮至少一个内部 Step 完成后求值；满足条件时外层 Step 成功，否则继续下一轮，达到 `maxIterations` 后以 `WSSPEC_LOOP_MAX_ITERATIONS_REACHED` 稳定阻塞。
- 失败分类保持可信边界：公开 `SubmitResult` 与生成 Schema 拒绝 Agent 提交 `failureCode`/`retryable`；默认 Executor 将失败归类为可重试的 `WSSPEC_STEP_FAILED`，只有可信 Executor 校验结果可返回永久失败码。
- Compiler 在任意后代深度拒绝嵌套 `control.loop`，返回 `WSSPEC_COMPILE_NESTED_LOOP_UNSUPPORTED` 和稳定 JSON Pointer 路径。
- Loop/Retry 查找使用 own-property 语义，`constructor` 等原型属性名称不会被误判为已有投影。
- 同步公开 Application Protocol、TypeScript 合同与生成 Schema，并加入合同测试，防止文档重新把可信失败分类描述为 Agent 字段。

## TDD 与复审证据

- RED/GREEN 覆盖失败后重试、永久失败、恢复后预算、Review 通过退出、Fix/Verify 后新轮次、上限阻塞、旧轮次 Submit 幂等、内部 `needs`、原型命名、Agent 伪造失败分类和任意深度嵌套 Loop。
- 针对伪造 `failureCode`、深层嵌套 Loop 和矛盾协议文档，均先观察到目标失败，再实现约束并转绿。
- 最终独立范围复审：Critical 0、Important 0；Spec verdict `GO`，Quality verdict `GO`。

## 最终验证

以下门禁在当前未提交候选树上重新执行：

| 门禁 | 结果 |
| --- | --- |
| `node --import tsx --test tests/integration/retry-runtime.test.ts tests/integration/review-fix-loop.test.ts tests/contract/application-protocol.test.ts tests/unit/compiler.test.ts tests/contract/documentation-baseline.test.ts` | PASS，66 passed，0 failed |
| `npm test` | PASS，374 passed，0 failed，0 skipped |
| `npm run lint` | PASS，exit 0 |
| `npm run typecheck` | PASS，exit 0 |
| `npm run build` | PASS，exit 0 |
| `npm run schemas:generate` | PASS，exit 0 |
| `node --import tsx --test tests/contract/schemas.test.ts` | PASS，8 passed，0 failed；检入 Schema 与重新生成定义一致 |
| `git diff --check` | PASS |

## 证据边界

- 上述证据证明当前 checkout 的本地 Application Control Runtime、协议合同、恢复路径和生成产物一致性，不构成生产、跨版本升级或 Codex/Claude/Cursor 真实宿主发现与执行验收。
- 本任务没有执行 merge、push、publish，也没有清理隔离 worktree。
