# Task 7 报告：Application Facade 与原子 Acquire/Submit

## 交付结果

- 新增 `createApplication()`，提供 `start / acquire / submit / decide / inspect` 五个 Application Protocol 入口。
- 新增 Executor Registry 与本地 Requirement Connector；Work Package 只携带工作流事实、Artifact 引用、约束、Gate、Attempt 和 Lease，不携带 Agent 对话上下文。
- `start` 固化 Workflow Package、Profile、Skill、Lock、Schema、Config、来源与 Change Policy 快照；显式 Workflow 和项目 `activeWorkflow` 均受验证与信任边界约束。
- `acquire / submit` 在 control-plane owner lock 内原子创建或校验 Attempt、Lease、Work Package 和结果；幂等重试返回原事件结果，旧 Attempt fail closed。
- `decide` 保留真实 TTY 边界，并在同一 owner lock 临界区重查 pending 状态、调用方摘要、workspace 摘要和 Artifact 绑定，再追加 decision event。
- Application 恢复使用 manifest + Application anchor + immutable snapshot；已锚定 Work Item 缺失 `application.json` 时拒绝降级到 legacy `workflow.yaml`。

## Review Findings 闭环

1. `createWorkItem` 内部失败不再泄漏 branch/worktree。创建期和 post-publication 失败均执行身份约束补偿；owner token 同时绑定本次 locator 与 Application anchor。
2. locator/control-plane 使用排他创建。并发出现的 foreign locator 文件、locator 目录或 control-plane 文件不会被覆盖或删除；仅删除严格匹配本次 repository/workItem/owner/branch/worktree/baseline 的资源。
3. 审批等待锁期间 workspace、Artifact 或 expected digest 变化不会批准；请求会 expired 或 fail closed，且 stale expiration 不能覆盖已完成决定。
4. 已锚定 Application 删除快照并伪造 legacy Workflow 的 reviewer probe 返回 `WSSPEC_APPLICATION_SNAPSHOT_CHANGED`，不会重写 runtime 为 forged stages。

## Fresh Verification

环境：Node `v22.16.0`。

- 原子回滚、审批锁、anchored recovery focused：6/6。
- `tests/integration/application-flow.test.ts`：27/27。
- `tests/integration/recovery.test.ts` + `tests/integration/lock-recovery.test.ts`：13/13。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm test`：245/245，0 fail；包含 CLI TTY、跨 worktree 恢复、clean-consumer pack/install E2E。
- `git diff --check`：通过。

## 独立审查

Node/TypeScript 业务逻辑与竞态 diff review：Critical 0，Important 0，Minor 0。Task 7 范围内未发现未关闭 finding。

## 残余边界

- 本任务只持久化首次 Profile 选择；运行时风险升级属于后续计划。
- GitHub、GitLab、飞书来源和真实外部写入 Connector 不在 Task 7 范围。
- owner-aware 补偿优先保护并发 foreign 资源；如果本次身份在回滚期间被替换，会 fail closed 并报告 `WSSPEC_START_ROLLBACK_FAILED`，不会猜测性删除。
