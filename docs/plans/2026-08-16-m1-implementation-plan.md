# WiesenSpecKit M1 实施计划

> **执行要求：** 按任务顺序实施，每项先写失败测试，再写最小实现。未经用户明确要求不提交 Git、不 push、不发布。

**目标：** 实现需求规格中 `REQ-M1-001..015` 的本地核心协议、CLI、Codex/Generic 集成和可验证发布包。

**架构：** 使用 TypeScript 构建单进程 CLI。`domain` 保持纯函数与不可变领域对象，`schemas` 是公开字段的事实来源，`storage` 负责 Git common-dir 控制面与原子事件，`engine` 编排状态但不调用 Agent，`cli` 只做参数和展示适配。外部协作接口保留类型边界，但 M1 不实现 Issue/Knowledge 写入。

**技术栈：** 当前工作区 Node.js 22、TypeScript、npm、JSON Schema、AJV、YAML；测试使用 Node 测试运行器或项目初始化时锁定的单一测试框架。

## 全局约束

- 所有用户文档和错误说明使用中文；协议字段、错误码和 CLI 命令使用英文标识。
- JSON Schema 默认 `additionalProperties: false`。
- 文件写入使用同目录临时文件、fsync 和原子 rename；事件先于投影写入。
- argv 命令直接 spawn，不经过 Shell 字符串。
- M1 不实现 Issue、Knowledge、attested Evidence、第三方扩展或专用 Claude/OpenCode/Cursor 集成。
- 每项完成必须运行自身测试；最终运行 lint、typecheck、全部测试、build 和 pack dry-run。

## 目标文件结构

```text
src/
├── cli/
│   ├── main.ts
│   ├── commands/
│   └── output.ts
├── domain/
│   ├── ids.ts
│   ├── digests.ts
│   ├── artifacts.ts
│   ├── workflow.ts
│   └── states.ts
├── schemas/
│   ├── definitions.ts
│   ├── generate.ts
│   └── generated/
├── storage/
│   ├── repository.ts
│   ├── work-items.ts
│   ├── control-plane.ts
│   └── events.ts
├── engine/
│   ├── compiler.ts
│   ├── scheduler.ts
│   ├── claims.ts
│   ├── results.ts
│   ├── approvals.ts
│   ├── verification.ts
│   └── archive.ts
└── integrations/
    ├── codex.ts
    └── generic.ts
tests/
├── unit/
├── contract/
├── integration/
├── e2e/
└── fixtures/
```

### Task 1：工程骨架与 Schema 单一事实来源

**需求：** REQ-M1-003、REQ-M1-007、REQ-M1-013、REQ-M1-015。

**文件：** 创建 `package.json`、`tsconfig.json`、`src/schemas/**`、`src/domain/ids.ts`、`src/cli/main.ts`、`tests/contract/schemas.test.ts`。

**产出接口：**

```ts
export type SchemaId = string;
export function getSchema(id: SchemaId): object;
export function validate<T>(id: SchemaId, value: unknown): T;
export function generatePublicSchemas(outputDir: string): Promise<void>;
```

- [x] 将 Workflow、Project Config、Work Item、Context、Result、Evidence 和 Artifact v1 转成定义对象及生成 Schema。
- [x] 先写正例、未知字段、缺失字段和不支持版本测试，确认失败。
- [x] 实现 `validate`，错误包含稳定错误码、JSON Pointer 和修复建议。
- [x] 增加生成物漂移测试：临时生成目录必须与发布目录 `schemas/` 字节一致。
- [x] 运行 Schema 契约测试、typecheck 和 build。

### Task 2：仓库初始化、Work Item 与完整摘要

**需求：** REQ-M1-001、REQ-M1-002、REQ-M1-006、REQ-M1-015。

**文件：** 创建 `src/domain/digests.ts`、`src/storage/repository.ts`、`src/storage/work-items.ts`、`tests/integration/repository.test.ts`、`tests/integration/work-item.test.ts`。

**产出接口：**

```ts
export function initRepository(root: string): Promise<RepositoryIdentity>;
export function loadRepository(root: string): Promise<RepositoryIdentity>;
export function computeWorkspaceTreeDigest(root: string): Promise<string>;
export function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem>;
```

- [x] 用临时 Git 仓库写初始化、重复初始化、缓存冲突、clone 和 worktree 测试。
- [x] 写 tracked、untracked、删除、mode、symlink、ignored 文件摘要测试。
- [x] 实现稳定 repositoryId、Git common-dir 解析和路径逃逸拒绝。
- [x] 实现 prompt/Markdown/TXT Source Snapshot、配置快照、分支和 worktree 创建。
- [x] 验证冲突场景不会覆盖现有分支、worktree 或 Work Item。

### Task 3：工作流编译器与 Artifact 契约

**需求：** REQ-M1-003、REQ-M1-007、REQ-M1-009。

**文件：** 创建 `src/domain/workflow.ts`、`src/domain/artifacts.ts`、`src/engine/compiler.ts`、`tests/unit/compiler.test.ts`、`tests/contract/artifacts.test.ts`。

**产出接口：**

```ts
export function compileWorkflow(input: Workflow, config: ProjectConfig): CompiledWorkflow;
export function readArtifact(path: string): Promise<Artifact>;
export function verifyArtifact(path: string, expected: ArtifactExpectation): Promise<ArtifactReference>;
```

- [x] 为环依赖、owner/kind、缺少生产者、审批绕过、Gate 缺失写失败测试。
- [x] 实现 DAG、依赖闭包、内置 Executor 能力和安全不变量编译。
- [x] 为七种内置 Artifact 与 `tasks` 写完整/缺失章节 Fixture。
- [x] 实现 flat front matter、revision 和 RFC 8785 内容哈希校验。
- [x] 运行编译器与 Artifact 全部契约测试。

### Task 4：事件存储、双层状态机与恢复

**需求：** REQ-M1-005、REQ-M1-009、REQ-M1-011、REQ-M1-012。

**文件：** 创建 `src/domain/states.ts`、`src/storage/events.ts`、`src/storage/control-plane.ts`、`src/engine/scheduler.ts`、`tests/unit/state-transitions.test.ts`、`tests/integration/recovery.test.ts`。

**产出接口：**

```ts
export function transitionStage(state: StageState, event: StageEvent): StageState;
export function transitionWorkItem(state: WorkItemState, event: WorkItemEvent): WorkItemState;
export function appendEvent(controlPlane: string, event: DomainEvent): Promise<void>;
export function recoverControlPlane(input: RecoveryInput): Promise<RuntimeProjection>;
```

- [x] 从规范表生成所有允许转换测试，并为每个未定义转换写统一拒绝断言。
- [x] 实现事件哈希链、幂等键、文件锁、原子投影和回放。
- [x] 模拟事件成功但投影失败，验证恢复不丢转换、不重复副作用。
- [x] 使用两个真实 worktree 验证读取同一状态和写入互斥。
- [x] 验证断链、身份冲突和未完成审批恢复全部 fail closed。

### Task 5：Claim、Context、Result 与失效传播

**需求：** REQ-M1-004、REQ-M1-005、REQ-M1-006、REQ-M1-009。

**文件：** 创建 `src/engine/claims.ts`、`src/engine/results.ts`、扩展 `src/engine/scheduler.ts`、创建 `tests/integration/stage-execution.test.ts`。

**产出接口：**

```ts
export function claimStage(input: ClaimInput): Promise<Claim>;
export function buildStageContext(claim: Claim): Promise<StageContext>;
export function completeStage(input: CompleteStageInput): Promise<StageResultRecord>;
export function invalidateFromArtifact(input: InvalidationInput): Promise<void>;
```

- [x] 写并发 Claim、续租、释放、到期、接管和旧 Attempt 提交测试。
- [x] 验证 Context 记录 `inputWorkspaceTreeDigest`。
- [x] 验证合法实现允许 output 与 input 摘要不同，且引擎重算 output。
- [x] 验证虚假 output、allowedPaths 越界、缺失 Artifact 和旧 context 全部拒绝。
- [x] 修改上游已批准工件，验证下游 Claim、状态、审批和 Evidence 传播失效。

### Task 6：真实 TTY 工件审批

**需求：** REQ-M1-008、REQ-M1-014。

**文件：** 创建 `src/engine/approvals.ts`、`src/cli/commands/approval.ts`、`tests/integration/approval.test.ts`、`tests/e2e/approval-tty.test.ts`。

**产出接口：**

```ts
export function requestArtifactApproval(input: ApprovalRequestInput): Promise<ApprovalRequest>;
export function decideArtifactApproval(input: InteractiveDecisionInput): Promise<ApprovalRecord>;
```

- [x] 用伪终端测试 approve/reject，用 pipe 和普通子进程测试非 TTY 拒绝。
- [x] 展示 Work Item、Stage、diff、contentHash、output digest 和失效范围。
- [x] 禁止 `--yes`、stdin 答案和环境变量预批准。
- [x] 审批前重算工件和工作区摘要；变化时使请求过期。
- [x] 扫描事件、日志、Context 和输出，验证不写入凭据或终端原始输入。

### Task 7：可信 Gate、关闭与归档

**需求：** REQ-M1-010、REQ-M1-012、REQ-M1-014。

**文件：** 创建 `src/engine/verification.ts`、`src/engine/archive.ts`、`src/cli/commands/verify.ts`、`src/cli/commands/close.ts`、`tests/integration/verification.test.ts`、`tests/integration/archive.test.ts`。

**产出接口：**

```ts
export function runTrustedGate(input: GateRunInput): Promise<EvidenceReference>;
export function verifyWorkItem(id: string): Promise<VerificationResult>;
export function closeWorkItem(id: string): Promise<ArchiveResult>;
```

- [x] 写 argv、cwd、环境白名单、超时、非零退出和输出截断测试。
- [x] 验证 Agent command 只能产生 reported Evidence。
- [x] Gate 后修改工作区，验证 trusted Evidence 和 verified 状态失效。
- [x] 对缺 Artifact、审批、Gate 的 close 分别写负例。
- [x] 实现审计快照、末端事件哈希、归档和归档后只读控制面。

### Task 8：CLI、Agent 集成与完整 E2E

**需求：** REQ-M1-004、REQ-M1-011、REQ-M1-013、REQ-M1-015 及 M1 完成定义。

**文件：** 完成 `src/cli/**`、创建 `src/integrations/codex.ts`、`src/integrations/generic.ts`、`tests/contract/integrations.test.ts`、`tests/e2e/verified-delivery.test.ts`、`tests/e2e/resume-cross-host.test.ts`。

- [x] 为 init/new/next/status/claim/context/complete/approve/reject/verify/close/recover 提供 text 与 JSON 输出。
- [x] 生成 Codex 和 Generic Skill，只允许通过 CLI Pull Loop 更新状态。
- [x] 在临时 Git 仓库跑通 prompt 与 Markdown 两条完整流程。
- [x] 中断第一个宿主会话，由第二个宿主从 `wspec next` 恢复并关闭 Work Item。
- [x] 验证 M2 命令返回 `WSPEC_FEATURE_NOT_AVAILABLE`，不暴露半成品能力。
- [x] 运行最终门禁：lint、typecheck、全部测试、E2E、build、Schema 漂移检查和 `npm pack --dry-run`。

## 实施检查点

- Task 1-3 完成后：审查公开 Schema 和编译器是否忠实实现规范。
- Task 4-6 完成后：审查并发、恢复、摘要和审批是否存在绕过路径。
- Task 7-8 完成后：执行完整 M1 验收矩阵，再决定是否进入 M2。
