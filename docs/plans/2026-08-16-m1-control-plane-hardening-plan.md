# WiesenSpecKit M1 控制面可靠性修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让审批、Evidence、Claim、Context、状态和关闭记录在并发、投影损坏及进程异常后仍可完整恢复，并形成可安装的 M1 CLI 包。

**Architecture:** `events.jsonl` 保存全部持久业务事实，`runtime.json` 仅作为可丢弃投影。所有控制面修改通过一个锁内事务入口提交完整事件组、重放投影和保存幂等结果；关闭归档由关闭事件确定性生成。M1 保持文件协议，不引入数据库，Issue/Knowledge 继续属于 M2。

**Tech Stack:** Node.js 22、TypeScript 5.9、Node test runner、Git worktree、RFC 8785 canonical JSON、npm tarball。

## Global Constraints

- 遵循 `REQ-M1-001..015`，尤其是 `AC-009-1..3`、`AC-011-1..3`、`AC-012-1..3`。
- 所有业务事实必须可由不可变 Work Item 快照和完整已提交事件组重建。
- 业务模块不得直接调用 `writeProjection()` 保存持久事实。
- 事件组、投影和归档写入必须支持进程中断后的确定性恢复。
- interactive 审批仍只防止误操作，不扩大为强身份认证。
- M1 不实现 Issue、Knowledge 或远程外部写入。
- 先写失败测试，再写最小实现；未经用户明确要求不提交、不 push、不发布。

---

### Task 1: 可重放的领域事件与控制面事务

**Files:**
- Modify: `src/storage/events.ts`
- Modify: `src/storage/control-plane.ts`
- Modify: `src/engine/scheduler.ts`
- Modify: `tests/integration/recovery.test.ts`

**Interfaces:**
- Produces: `mutateControlPlane<T>(input, operation): Promise<MutationResult<T>>`
- Produces: `replayEvents(metadata, events): RuntimeProjection`
- Produces: `RuntimeProjection.idempotency: Record<string, IdempotencyRecord>`

- [x] **Step 1: 写失败测试：投影损坏后恢复审批、Evidence、Claim 历史和 Context。**

  在 `recovery.test.ts` 构造对应领域事件，破坏 `runtime.json`，断言重放后的已完成历史完整；活动 Claim 和待处理审批被明确标为过期或取消，而不是静默删除。

- [x] **Step 2: 写失败测试：原操作后发生其他事件，重复幂等键仍返回原始结果。**

  首次提交 `active`，再提交 Stage 事件，最后重试首次 key；断言无新事件且返回首次操作保存的规范结果。相同 key 配不同输入必须返回 `WSPEC_IDEMPOTENCY_CONFLICT`。

- [x] **Step 3: 运行定向测试确认失败。**

  Run: `node --import tsx --test tests/integration/recovery.test.ts`

- [x] **Step 4: 扩展 `DomainEvent`。**

  将 `eventType` 扩展为状态、Claim、Context、审批、Evidence、失效和关闭事件；增加 `operationId`、`operationIndex`、`operationLength`、`inputDigest` 和 `result`。实现事件组完整性校验，拒绝不完整的已提交组。

- [x] **Step 5: 实现统一事务入口和纯重放器。**

  `mutateControlPlane` 必须在锁内重新读取事件和投影、校验幂等输入、让回调生成领域事件及返回值、追加完整事件组、重放并原子写入投影。`transitionRuntime` 改用该入口。

- [x] **Step 6: 运行恢复、状态机和现有并发测试。**

  Run: `node --import tsx --test tests/integration/recovery.test.ts tests/unit/state-transitions.test.ts tests/integration/stage-execution.test.ts`

### Task 2: Claim、Context、审批和 Evidence 全部事件化

**Files:**
- Modify: `src/engine/claims.ts`
- Modify: `src/engine/results.ts`
- Modify: `src/engine/approvals.ts`
- Modify: `src/engine/verification.ts`
- Modify: `tests/integration/stage-execution.test.ts`
- Modify: `tests/integration/approval.test.ts`
- Modify: `tests/integration/verification.test.ts`

**Interfaces:**
- Consumes: `mutateControlPlane`, typed domain-event payloads
- Produces: 原子 `claimStage`、`buildStageContext`、`requestArtifactApproval`、`decideArtifactApproval`、`recordEvidence`

- [x] **Step 1: 写失败的并发测试。**

  使用独立 Promise/进程并发提交审批与状态转换、Evidence 与状态转换；断言两边数据均保留，事件序号连续且投影等于重放结果。

- [x] **Step 2: 写失败的审批崩溃恢复测试。**

  分别模拟请求和决定事件组提交前失败、提交后投影失败；断言不会出现无请求的 `awaiting_approval`，已提交决定可恢复。

- [x] **Step 3: 运行三个定向测试文件确认失败。**

  Run: `node --import tsx --test tests/integration/stage-execution.test.ts tests/integration/approval.test.ts tests/integration/verification.test.ts`

- [x] **Step 4: 将 Claim 与 Context 改为领域事件。**

  Claim 创建、续期、释放、过期以及 Context 创建/失效都在单次 `mutateControlPlane` 内提交；移除这些模块中的直接 `writeProjection`。

- [x] **Step 5: 将审批和 Evidence 改为领域事件。**

  审批请求同时提交 Stage/Work Item 状态与 `approval.requested`；决定同时提交两层状态和 `approval.decided`。Gate 执行在锁外完成，记录时在锁内重新校验工作区摘要并提交 `evidence.recorded`。

- [x] **Step 6: 将失效传播改为一个事件组。**

  下游状态、Claim、Context、审批和 Evidence 的失效必须在一次事务内生成完整事件组。

- [x] **Step 7: 运行 Claim、审批、验证及完整测试。**

  Run: `npm test`

### Task 3: 可识别所有者的 crash-safe 锁

**Files:**
- Modify: `src/storage/events.ts`
- Modify: `src/storage/control-plane.ts`
- Modify: `src/cli/commands/core.ts`
- Create: `tests/integration/lock-recovery.test.ts`

**Interfaces:**
- Produces: `inspectControlPlaneLock(path): Promise<LockStatus>`
- Produces: `recoverStaleControlPlaneLock(path): Promise<boolean>`

- [x] **Step 1: 写失败测试：持锁子进程被 `SIGKILL`。**

  子进程取得锁并输出 ready，父进程 `SIGKILL` 后断言普通修改返回 `WSPEC_CONTROL_PLANE_STALE_LOCK`，显式 recover 清理后可继续。

- [x] **Step 2: 写失败测试：活跃 PID 和未知主机锁不可被抢占。**

  断言 recover 对活跃本机 PID 和其他 hostname 的锁返回 `WSPEC_CONTROL_PLANE_LOCKED`，且锁文件保持不变。

- [x] **Step 3: 实现带 owner token 的锁文件。**

  锁内容包含 `version`、`ownerToken`、`pid`、`hostname`、`createdAt`；释放前重新读取并匹配 token。普通获取发现已死亡本机 PID 时只报告 stale，不自动删除。

- [x] **Step 4: 把 stale lock 清理接入显式 `recover`。**

  `recover` 先检查锁所有者，只清理可证明已死亡的本机进程，再执行事件恢复；清理结果写入恢复审计事件。

- [x] **Step 5: 运行锁、恢复和跨 worktree E2E。**

  Run: `node --import tsx --test tests/integration/lock-recovery.test.ts tests/integration/recovery.test.ts tests/e2e/resume-cross-host.test.ts`

### Task 4: 原子关闭、可重建归档和安全 CLI DTO

**Files:**
- Modify: `src/engine/archive.ts`
- Modify: `src/storage/control-plane.ts`
- Modify: `src/cli/commands/core.ts`
- Modify: `tests/integration/archive.test.ts`
- Modify: `tests/e2e/resume-cross-host.test.ts`

**Interfaces:**
- Produces: `rebuildArchive(projection): Promise<ArchiveResult>`
- Produces: `toStatusResponse(projection): StatusResponse`

- [x] **Step 1: 写失败测试：关闭事件后、归档写入前崩溃。**

  模拟投影/归档写入失败，断言事件重放仍得到只读 closed；`recover` 可生成字节一致的 `audit.json`。

- [x] **Step 2: 写失败测试：status 不包含内部路径或 token。**

  从仓库根和 worktree 调用 JSON status，递归断言不存在 `controlPlane`、绝对路径、`claimToken`、`ownerToken`。

- [x] **Step 3: 实现 `work-item.closed` 事件和确定性归档。**

  关闭事件 Payload 固定 `closedAt`、workspace digest、最终投影摘要和末端事件锚点；只读由事件派生。归档原子写入失败时，恢复依据事件重建。

- [x] **Step 4: 实现显式 CLI DTO。**

  status/recover/verify/close 不再直接返回 `RuntimeProjection`；仅输出协议公开字段和裁剪后的 Claim 元数据。

- [x] **Step 5: 运行归档、CLI 和 E2E 测试。**

  Run: `node --import tsx --test tests/integration/archive.test.ts tests/e2e/resume-cross-host.test.ts tests/e2e/approval-tty.test.ts`

### Task 5: 可安装 M1 发布包

**Files:**
- Modify: `package.json`
- Modify: `src/cli/main.ts`
- Create: `tests/e2e/package-install.test.ts`
- Modify: `docs/specs/2026-08-16-wiesen-spec-kit-requirements.md` only if acceptance wording needs alignment

**Interfaces:**
- Produces: installable `wiesen-spec-kit` tarball with `wspec` executable

- [x] **Step 1: 写失败的干净安装测试。**

  构建并 pack 到临时目录，在另一个空目录执行 `npm install <tarball>`，调用安装后的 `wspec --help`，并在临时 Git 仓库完成最小 `init/new/status` 流程。

- [x] **Step 2: 收敛 M1 CLI 帮助和版本。**

  设置首个可用预发布版本；M2 命令不出现在 M1 可用命令列表，显式调用仍返回 `WSPEC_FEATURE_NOT_AVAILABLE`。

- [x] **Step 3: 修复 tarball 安装和可执行入口问题。**

  保证 shebang、`bin`、`files`、构建产物及运行时 Schema 均包含在包中；测试不能依赖源码目录或开发依赖。

- [x] **Step 4: 运行安装测试。**

  Run: `node --import tsx --test tests/e2e/package-install.test.ts`

### Task 6: 最终门禁与完成度复审

**Files:**
- Modify: `docs/plans/2026-08-16-m1-control-plane-hardening-plan.md`
- Modify: release documentation only when verified evidence exists

- [x] **Step 1: 扫描直接投影写入。**

  Run: `rg -n "writeProjection\\(" src/engine src/cli`

  Expected: 业务模块无直接调用，仅控制面存储/事务层可写投影。

- [x] **Step 2: 运行全部静态和动态门禁。**

  Run: `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build`

- [x] **Step 3: 校验 Schema 与包内容。**

  Run: `npm run schemas:generate && git diff --check && npm pack --dry-run`

- [x] **Step 4: 对照 `REQ-M1-001..015` 重新审查。**

  将本地自动测试、安装测试和仍缺失的真实环境证据分开报告；Issue/Knowledge 明确标记为 M2，不宣称完成。

- [x] **Step 5: 使用 `superpowers:verification-before-completion` 做最终证据核验。**

  只有上述命令的最新运行全部通过，且没有 P0/P1 未解决问题，才能声明 M1 可投入受支持环境使用。
