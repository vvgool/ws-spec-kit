# Task 3 Fix Round 2 报告

## 结论

- `task-3-fix-1-rereview.md` 的唯一 P1 已按严格 TDD 修复。
- failed Attempt 的当前 Step 即使属于 Profile 升档失效集合，也会在同一事件中持久化 Profile、累计风险、failed Stage、Retry 最终状态、Attempt Context 与 Claim 释放。
- 未开始 Task 4，未 merge、push 或 publish。

## 根因与修复

Round 1 在失败分支前执行 Profile 升档。`applyProfileDecision()` 先删除 affected Step 下的 Retry，失败分支随后才读取当前 Retry，因此抛出 `WSSPEC_RETRY_PROJECTION_INVALID`，整个 `mutateControlPlane()` 回滚。

Round 2 明确调整顺序：

1. 可信 Result 校验完成并写入 Attempt Context。
2. 在任何 Profile 失效传播前捕获并校验当前 running Retry。
3. 评估并持久化累计 `riskSignals` 与 Profile 决策。
4. 升档时失效其他 affected state，但保留当前失败顶层 Step 的 Stage、Loop、Context 与 Retry；Loop 的 `maxIterations` 同步到新 Profile snapshot。
5. 失败分支使用先前捕获的 Retry，按可信 failureCode 写入最终状态：retryable 为 ready/exhausted，non-retryable 删除 Retry；Stage 为 failed，Claim 已释放。

`applyProfileDecision()` 新增窄化的 `preserveCurrentStep` 选项。该选项只由 failed Submit 的 Profile 激活路径传入；成功 Submit 仍执行完整失效传播，其他 affected Steps 也不被保留。

## TDD 证据

RED：先新增两个真实流程测试，均稳定失败于：

```text
WSSPEC_RETRY_PROJECTION_INVALID: 步骤 review-fix:1:review 缺少重试投影
```

- retryable：Quick `review-fix:1:review` 修改 `src/auth/session.ts` 后失败，当前 `review-fix` 属于 Governed invalidation 集合。
- non-retryable：同一 Loop 内 `review-fix:1:verify` 经可信 `quality.verify` Executor 分类为 `WSSPEC_STEP_INPUT_INVALID`。

GREEN：

- Retryable failure 原子持久化 Governed、`riskSignals.modifiedPaths`、failed Stage、ready Retry、failed Context、Claim 释放。
- 相同并发 Submit 返回原结果且只产生一个 `profile.upgraded`；同 Attempt 不同输入返回 `WSSPEC_IDEMPOTENCY_CONFLICT`。
- Retry Acquire 使用 Governed Loop 参数，无新 diff 再失败后仍保持 Governed/ready；损坏 `runtime.json` 后事件恢复一致。
- Non-retryable failure 原子持久化 Governed、风险、failed Stage 与可信 failureCode，最终无 Retry、无 Claim；损坏投影恢复一致。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| 新增 P1 RED 测试 | FAIL as expected，2 项均命中 `WSSPEC_RETRY_PROJECTION_INVALID` |
| Profile Runtime 聚焦套件 | PASS，16 passed，0 failed |
| Profile/Recovery/Approval/Retry/Loop/Compiler 六文件矩阵 | PASS，85 passed，0 failed |
| `npm test` | PASS，390 passed，0 failed，0 skipped |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

## 证据边界

- 结论绑定 `e4b236d` 之后的当前修复工作树。
- 未执行真实外部宿主、发布或生产验收；这些不属于 Task 3 Fix Round 2 范围。
- Task 4 的审批、可信 Gate 与 Close 收口未纳入本轮实现。
