# Task 7 Fix Round 2 Report

## 状态

DONE

修复基线：`f7ad87c fix: close Task 7 application review findings`。

本轮只处理 Fix Round 1 定向复审中的两个授权 finding：durable pending approval 恢复语义，以及公开 Project Config v1 必填契约。未进入 `control.loop` Runtime、Task 8、合并或推送。

## Finding Closure

### P1：恢复保留合法 durable pending approval

- `recoverControlPlane()` 现在只把同时满足以下三项的请求视为 durable：Approval 为 `pending`、Work Item 为 `awaiting_approval`、绑定 Stage 为 `awaiting_approval`。
- durable 请求、Stage 和 Work Item 在 runtime 投影损坏、第二 Git worktree 恢复、重复恢复，以及同时恢复无关 stale Claim 时保持不变；仅重建 `runtime.json`，不追加无意义失效事件。
- 没有完整 durable 三态的 orphan pending approval 仍会过期；没有 Approval 记录的 orphan `awaiting_approval` Stage 仍恢复为 `ready`，既有中断恢复语义不变。
- 旧 approval 集成测试中“合法 pending approval 必须在恢复时过期”的相反契约已改为 durable 保留断言。

### P2：恢复公开 `builtin.project-config.v1` 严格必填契约

- 公开 Schema 顶层 `required` 恢复为 `version`、`trigger`、`git`、`runtime`、`quality`，所有既有嵌套 required、未知字段和范围约束保持不变。
- 新增独立 `builtin.application-project-config.v1`：只要求顶层 `version`；一旦提供 `trigger`、`git`、`runtime`、`quality`、`publishing`、`documentation` 或 `skills`，其内部仍按同一严格结构校验。
- Application Start 改用独立 Schema，`wspec init` 继续生成 `{ version: 1 }`。这保留了按 Workflow 选择默认 Gate 的边界，避免在初始化时把 feature 的 `test` 或 documentation 的 `docs.integrity` 固化进共享文件。
- legacy preflight 继续使用公开 `builtin.project-config.v1`；不完整配置现在稳定返回 `WSSPEC_SCHEMA_REQUIRED_FIELD` 和 `/trigger`，不再落入 `TypeError`。
- 已生成并纳入 `schemas/builtin-application-project-config-v1.schema.json`。

## TDD Evidence

### RED

- durable approval：显式恢复把合法 `pending` 请求改为 `expired`，将 Work Item 从 `awaiting_approval` 改为 `active`、Stage 改为 `ready`，并追加 `projection.invalidated` 事件。
- mixed recovery：恢复一个无关 stale Claim 时，旧逻辑同时使合法 durable approval 过期。
- public config：`validate("builtin.project-config.v1", { version: 1 })` 被接受，缺少 `/trigger` 未 fail closed。
- legacy preflight：不完整公开配置越过 Schema 后抛出 `TypeError: Cannot read properties of undefined (reading 'gates')`。
- independent Schema：Application 第一次切换到新 Schema ID 时返回 `WSSPEC_SCHEMA_UNSUPPORTED_VERSION`，证明注册与生成边界尚未接通。

### GREEN

- durable approval 主回归：`1 passed / 0 failed`；覆盖投影损坏、第二 worktree、事件字节不变和重复恢复。
- public required、最小 init 边界、legacy preflight 三个聚焦回归：各 `1 passed / 0 failed`。
- durable approval 与无关 stale Claim 组合回归：`2 passed / 0 failed`。
- Application + recovery 最终聚焦套件：`68 passed / 0 failed`。
- Schema + repository + compiler 最终聚焦套件：`52 passed / 0 failed`。
- 首次全量门禁发现一条旧相反预期，结果为 `281 passed / 1 failed`；确认 fixture 满足 durable 三态后，仅更新测试契约，聚焦复验为 `1 passed / 0 failed`，最终全量为 `282 passed / 0 failed`。

## `control.loop` Scope Ruling

Fix Round 1 已经把递归 `steps`、`until`、`maxIterations`、`independentReviewActor`、`retry`、`artifactLevel` 和 `contentLevel` 无损写入并恢复 Application Snapshot。这些字段是后续 Runtime 的充分编译输入，但当前 Application 仍未执行内部 Review-Fix 子 Step、iteration、结束条件、轮次耗尽或独立 Reviewer 约束。

该执行语义明确属于 `docs/superpowers/plans/2026-08-17-wsspeckit-control-runtime.md` 的 Task 2“重试与有界 Review-Fix 循环”。本轮不实现、不声称关闭该 Runtime finding，也不提前进入 Task 8；后续必须按该计划通过失败测试、持久化 Loop/Retry 投影、跨恢复预算和 actor 隔离验收单独交付。

## Final Verification

最终树上重新执行：

- `npm run schemas:generate`：通过。
- `npm run test:contract`：`39 passed / 0 failed / 0 cancelled / 0 skipped / 0 todo`。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm test`：`282 passed / 0 failed / 0 cancelled / 0 skipped / 0 todo`；耗时约 `56.7 s`。
- `git diff --check`：通过。

## Cold Review Result

项目类型为 Node.js / TypeScript。对恢复分支组合、审批三态一致性、公开与 Application Schema 的 required 差异、可选对象内部严格性、Schema 注册/生成漂移、legacy 消费者和测试契约进行逐文件复核；除首次全量门禁暴露并已修正的旧相反测试外，没有发现新的未关闭 finding。

## Residual Boundaries

- 本报告只声明 Task 7 Fix Round 2 的两个授权 finding 已闭环。
- 不声明 `control.loop` Runtime、后续控制流计划、Task 8 或完整产品已完成。
- 当前证据是本地静态、构建和自动化测试证据，不等于多进程压力、真实 `SIGKILL`、长时间审批竞争、Windows 路径或生产环境验收。
- 未合并、未推送、未执行真实外部写入。
