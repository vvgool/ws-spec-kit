# WSSpecKit 协议与工作流基础实施计划

> **Agent 执行要求：** 实施本计划时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务执行并使用复选框跟踪进度。

**目标：** 直接替换当前 alpha 协议，建立 WSSpecKit 首个正式协议基线，包括新产品标识、Application Protocol、完整内置资源、四类 Skill 解析、Workflow Package 和风险分级 Profile。

**架构：** 复用已经验证的摘要、原子文件、事件存储、锁、审批和 Evidence 实现，删除旧公开 Workflow 与 CLI 协议。CLI 和 Driver Skill 只调用 Application Protocol；Application 层组合 Workflow、Skill、Profile 和 Runtime 服务，不感知当前由 Codex、Claude 还是 Cursor 驱动。

**技术栈：** Node.js 22、TypeScript 5.9 严格模式、ESM、npm、YAML、JSON Schema 2020-12、AJV、RFC 8785 规范 JSON、Node Test Runner。

## 全局约束

- 产品名为 `WSSpecKit`，npm 包为 `ws-spec-kit`，CLI 保持 `wspec`，项目目录保持 `.wsspec/`。
- Work Item ID 使用 `WSS-...`，公开错误码使用 `WSSPEC_...`。
- 直接替换旧协议：不保留旧 Schema、公开命令、别名、迁移命令或双版本读取。
- 所有用户文档、CLI 文案、内置 Workflow 说明、模板和内置 Skill 正文使用中文。
- 协议字段、命令、URI、Schema ID、类型名和错误码使用英文标识。
- WSSpecKit 不选择或调用模型，不管理 Agent 的对话、Token 或上下文。
- Builtin、Package、Global、Project Skill 必须使用显式 URI，不允许同名隐式覆盖。
- Profile 不得削弱 Executor 安全类别、可信验证或外部写入精确授权。
- 所有公开对象拒绝未知字段和不支持的版本。
- 每项任务先写失败测试，再写最小实现，最后单独提交。

## 计划边界

本计划交付可本地验证的 `init -> start -> acquire -> submit -> decide -> inspect` 基础链路，以及 Prompt/本地文件需求采集和 Workflow 管理命令。以下能力拆分为后续独立计划：有界循环运行、真实 GitHub/GitLab/飞书 Connector、完整交付动作和最终发布。后续计划只能依赖本计划冻结的四组接口：

1. Task 2 的 `WSSpecApplication`、`AgentAction` 和 `WorkPackage`。
2. Task 4-5 的 `WorkflowPackage`、`ResolvedSkill` 和 `SkillLock`。
3. Task 6 的 `CompiledWorkflow` 和 `ResolvedProfile`。
4. Task 7 的 `StepExecutor` Registry。

后续按顺序执行：

1. `2026-08-17-wsspeckit-control-runtime.md`
2. `2026-08-17-wsspeckit-connectors.md`
3. `2026-08-17-wsspeckit-release-acceptance.md`

---

### Task 1：产品标识与中文输出基线

**文件：**
- 修改：`package.json`
- 修改：`src/cli/main.ts`
- 修改：`src/domain/ids.ts`
- 创建：`tests/contract/identity.test.ts`
- 修改：`tests/e2e/package-install.test.ts`

**接口：**
- 输入：无。
- 输出：`WorkItemId = \`WSS-${string}\``、`ErrorCode = \`WSSPEC_${string}\`` 和新包元数据。

- [ ] **步骤 1：编写失败的产品标识测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import packageJson from "../../package.json" with { type: "json" };
import { isWorkItemId } from "../../src/domain/ids.js";

test("发布 WSSpecKit 产品标识", () => {
  assert.equal(packageJson.name, "ws-spec-kit");
  assert.equal(packageJson.bin.wspec, "./dist/cli/main.js");
  assert.equal(isWorkItemId("WSS-login"), true);
  assert.equal(isWorkItemId("WSK-login"), false);
});
```

- [ ] **步骤 2：运行测试，确认旧产品标识导致失败**

运行：`node --import tsx --test tests/contract/identity.test.ts tests/e2e/package-install.test.ts`

预期：失败，指出包名仍为 `wiesen-spec-kit` 或缺少 `isWorkItemId`。

- [ ] **步骤 3：实现新 ID 与错误码类型**

```ts
export type WorkItemId = `WSS-${string}`;
export type ErrorCode = `WSSPEC_${string}`;

const workItemIdPattern = /^WSS-[A-Za-z0-9-]+$/;
export const isWorkItemId = (value: string): value is WorkItemId => workItemIdPattern.test(value);
```

将包名和 CLI 产品名改为 WSSpecKit。CLI 帮助、错误说明和终端提示全部使用中文，不增加旧名称别名。

- [ ] **步骤 4：运行标识、类型和安装测试**

运行：`npm run typecheck && node --import tsx --test tests/contract/identity.test.ts tests/e2e/package-install.test.ts`

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add package.json src/cli/main.ts src/domain/ids.ts tests/contract/identity.test.ts tests/e2e/package-install.test.ts
git commit -m "refactor: establish WSSpecKit identity"
```

### Task 2：Application Protocol 与 Schema

**文件：**
- 修改：`src/schemas/definitions.ts`
- 修改：`src/schemas/index.ts`
- 创建：`src/protocol/application.ts`
- 创建：`src/protocol/work-package.ts`
- 创建：`tests/contract/application-protocol.test.ts`
- 重新生成：`schemas/*.schema.json`

**接口：**
- 输入：Task 1 的 `WorkItemId`。
- 输出：`WSSpecApplication`、`AgentAction`、`WorkPackage`、五类 Application 输入类型和 `DecisionInput`。

- [ ] **步骤 1：编写四类 AgentAction 的失败契约测试**

覆盖 `execute`、`await_approval`、`blocked`、`completed`，验证 `StartInput.workflowRef` 可以显式选择 Workflow、缺省时使用项目 `activeWorkflow`，验证 `DecisionInput` 只能是 Step/外部动作审批或 Workflow Package 信任决定，并验证 Work Package 拒绝 `conversationHistory`、`prompt` 和未知字段。

```ts
test("Work Package 拒绝 Agent 对话上下文", () => {
  assert.throws(
    () => validate("builtin.work-package.v1", { ...fixture, conversationHistory: [] }),
    /WSSPEC_SCHEMA_UNKNOWN_FIELD/,
  );
});
```

- [ ] **步骤 2：运行测试，确认新 Schema 尚不存在**

运行：`node --import tsx --test tests/contract/application-protocol.test.ts`

预期：以“不支持的 Schema ID”失败。

- [ ] **步骤 3：定义公开 TypeScript 协议**

```ts
export type AgentAction =
  | { action: "execute"; workPackage: WorkPackage }
  | { action: "await_approval"; approval: ApprovalSummary }
  | { action: "blocked"; problems: Problem[] }
  | { action: "completed"; summary: CompletionSummary };

export interface WSSpecApplication {
  start(input: StartInput): Promise<StartResult>;
  acquire(input: AcquireInput): Promise<AgentAction>;
  submit(input: SubmitInput): Promise<AgentAction>;
  decide(input: DecisionInput): Promise<AgentAction>;
  inspect(input: InspectInput): Promise<WorkItemView>;
}

export interface StartInput {
  source: RequirementSourceInput;
  workflowRef?: string;
  profile?: "auto" | "quick" | "standard" | "governed";
}

export type DecisionInput = ApprovalDecision | WorkflowTrustDecisionInput;

export interface WorkflowTrustDecisionInput {
  kind: "workflow_trust";
  requestId: string;
  decision: "trusted" | "rejected";
  expectedPackageDigest: string;
  expectedCapabilityDigest: string;
  actor: string;
}
```

Work Package 只包含执行身份、目标、已解析 Skill、Artifact 引用、修改约束、必需输出、Gate 和 Result Schema。

- [ ] **步骤 4：新增 Schema 并删除旧 Stage Context/Result Schema**

运行：`npm run schemas:generate`

预期：生成 Application、AgentAction、WorkPackage 和 SubmitResult Schema；发布目录不再包含旧 Stage Context/Result Schema。

- [ ] **步骤 5：运行协议、Schema 漂移和类型检查**

运行：`node --import tsx --test tests/contract/application-protocol.test.ts tests/contract/schemas.test.ts && npm run typecheck`

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add src/protocol src/schemas schemas tests/contract/application-protocol.test.ts tests/contract/schemas.test.ts
git commit -m "feat: define WSSpecKit application protocol"
```

### Task 3：中文内置资源与完整初始化

**文件：**
- 创建：`resources/catalog.yaml`
- 创建：`resources/workflows/{feature-delivery,documentation-delivery}/{manifest.yaml,workflow.yaml}`
- 创建：`resources/workflows/{feature-delivery,documentation-delivery}/profiles/{quick,standard,governed}.yaml`
- 创建：`resources/skills/*/SKILL.md`
- 创建：`src/resources/catalog.ts`
- 创建：`src/engine/docs-integrity.ts`
- 修改：`src/storage/repository.ts`
- 创建：`tests/contract/builtin-resources.test.ts`
- 创建：`tests/unit/docs-integrity.test.ts`
- 修改：`tests/integration/repository.test.ts`

**接口：**
- 输入：Task 2 的 Workflow/Profile Schema。
- 输出：`loadBuiltinCatalog(): Promise<BuiltinCatalog>` 和完整 `.wsspec/` 初始化。

- [ ] **步骤 1：编写失败的资源与中文约束测试**

验证每个 Builtin Skill 均有 `id`、`version`、中文 `description` 和中文正文；两个内置 Workflow 引用的 Skill 必须全部存在；功能交付包含可信 Red/Green Gate，文档交付包含 `documentation-exploration`、`documentation-editing`、`documentation-review` 和包内固定 argv 的 `docs.integrity` trusted Gate，且禁止生产代码路径；`wspec init` 必须创建 `repository.yaml`、`config.yaml`、`workflow.yaml`。

```ts
assert.equal(parseYaml(await read(root, ".wsspec/workflow.yaml")).profile, "auto");
assert.match(skillBody, /[\u4e00-\u9fff]/u);
```

- [ ] **步骤 2：运行测试，确认资源和完整初始化缺失**

运行：`node --import tsx --test tests/contract/builtin-resources.test.ts tests/unit/docs-integrity.test.ts tests/integration/repository.test.ts`

预期：失败，因为当前 init 只生成仓库身份且没有资源目录。

- [ ] **步骤 3：创建两个内置基础 Workflow、三种 Profile 和 Skill Catalog**

创建 `feature-delivery` 与 `documentation-delivery`。后者只允许文档路径，使用文档探索、文档编辑、文档 Review 和确定性文档 Gate，不生成 `TddCycleEvidence`。发布包内置 `docs.integrity` 固定命令，检查 UTF-8、非空正文、冲突标记和允许路径，确保未安装 Markdown 工具时仍可执行 Quick；Standard/Governed 可以叠加项目 Gate。每个 Skill 必须用中文明确目标、输入、输出、停止条件和禁止副作用。Builtin Skill 不得依赖用户额外安装 Superpowers。

- [ ] **步骤 4：使用原子写入完成 init**

```yaml
version: 1
activeWorkflow:
  ref: builtin://workflows/feature-delivery
  version: 1
profile: auto
```

已有项目文件不得被静默覆盖。

- [ ] **步骤 5：运行资源、初始化和安装包测试**

运行：`node --import tsx --test tests/contract/builtin-resources.test.ts tests/unit/docs-integrity.test.ts tests/integration/repository.test.ts tests/e2e/package-install.test.ts`

预期：全部通过，安装后的包能定位 `resources/`。

- [ ] **步骤 6：提交**

```bash
git add resources src/resources src/engine/docs-integrity.ts src/storage/repository.ts tests/contract/builtin-resources.test.ts tests/unit/docs-integrity.test.ts tests/integration/repository.test.ts
git commit -m "feat: bundle Chinese builtin workflows and skills"
```

### Task 4：Workflow Package 加载与锁定

**文件：**
- 创建：`src/workflow-package/{types,loader,lock}.ts`
- 创建：`src/workflow-package/trust.ts`
- 创建：`src/storage/workflow-trust.ts`
- 创建：`tests/unit/workflow-package.test.ts`
- 创建：`tests/integration/workflow-package-trust.test.ts`

**接口：**
- 输入：Task 3 的 Builtin Catalog。
- 输出：`loadWorkflowPackage(input): Promise<WorkflowPackage>`、`lockWorkflowPackage(pkg): WorkflowPackageLock`、`evaluateWorkflowTrust(input): WorkflowTrustDecision`、`recordWorkflowTrust(input): Promise<WorkflowTrustRecord>`。

- [ ] **步骤 1：编写失败的 Package 测试**

覆盖 Builtin/Project URI、Package 自带 Skill 清单、路径逃逸、符号链接逃逸、缺少 Manifest、不支持版本、锁文件未知内容和确定性摘要。

```ts
await assert.rejects(
  loadWorkflowPackage({ root, ref: "project://workflows/../../outside" }),
  /WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID/,
);
```

同时覆盖 Project/第三方 Package 首次使用返回 `approval_required`、明确拒绝后保持 blocked、确认后相同摘要可复用、Package 内容或副作用能力变化使信任失效、仅搬迁相同摘要 Package 不失效，以及非交互环境不得默认接受。Builtin Package 必须通过明确的内置信任来源进入，不得复用用户信任记录伪装 Builtin。

- [ ] **步骤 2：运行测试，确认 Loader 尚不存在**

运行：`node --import tsx --test tests/unit/workflow-package.test.ts`

预期：模块不存在导致失败。

- [ ] **步骤 3：实现 URI、真实路径边界和内容摘要**

禁止绝对路径；同时校验词法路径和 `realpath`。按规范相对路径排序，对 Manifest、Workflow、Profile、Skill、Schema 和 Template 统一计算摘要。

```ts
export interface WorkflowPackage {
  ref: string;
  root: string;
  manifest: WorkflowManifest;
  workflow: WorkflowDefinition;
  profiles: Map<string, ProfileDefinition>;
  packageSkills: Map<string, { entrypoint: string; digest: string }>;
  contentDigest: string;
}

export interface WorkflowTrustRecord {
  packageRef: string;
  packageDigest: string;
  capabilityDigest: string;
  decision: "trusted" | "rejected";
  actor: string;
  decidedAt: string;
}

export interface WorkflowTrustSummary {
  packageRef: string;
  packageDigest: string;
  capabilityDigest: string;
  fileDigests: Array<{ path: string; digest: string }>;
  skillDigests: Array<{ ref: string; digest: string }>;
  capabilities: string[];
}

export type WorkflowTrustDecision =
  | { status: "trusted"; record: WorkflowTrustRecord }
  | { status: "approval_required"; summary: WorkflowTrustSummary }
  | { status: "rejected"; record: WorkflowTrustRecord };
```

- [ ] **步骤 4：实现信任摘要、决策和失效规则**

能力摘要必须由 Manifest 中规范化的执行能力和外部副作用集合生成；展示内容包含逻辑来源、文件清单摘要、Skill 摘要和能力，不包含本机绝对路径或正文。信任记录追加到 Git common-dir 的 `.git/wsspec/trust/workflow-packages.ndjson` 并使用文件锁保护，不能授予 Step 或外部动作权限。未提供交互决策通道时返回 `WSSPEC_WORKFLOW_TRUST_REQUIRED`，不能通过配置全局跳过。

- [ ] **步骤 5：运行 Package、信任与类型测试**

运行：`node --import tsx --test tests/unit/workflow-package.test.ts tests/integration/workflow-package-trust.test.ts && npm run typecheck`

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add src/workflow-package src/storage/workflow-trust.ts tests/unit/workflow-package.test.ts tests/integration/workflow-package-trust.test.ts
git commit -m "feat: load and lock workflow packages"
```

### Task 5：四类 Skill Resolver 与 Skill Lock

**文件：**
- 创建：`src/registry/skills/{types,resolver,lock}.ts`
- 创建：`tests/unit/skill-resolver.test.ts`
- 创建：`tests/integration/skill-lock.test.ts`

**接口：**
- 输入：Task 4 的 `WorkflowPackage`。
- 输出：`resolveSkill(binding, context): Promise<ResolvedSkill>`、`createSkillLock(resolved): SkillLock`。

- [ ] **步骤 1：编写失败的四类解析测试**

覆盖 Builtin、Package、Project、四种 Provider 默认 Global 根、附加 Global 根、显式 fallback、
可选缺失、必需缺失、相同摘要重复项、不同摘要歧义、摘要变化、路径逃逸和符号链接逃逸。

```ts
const result = await resolveSkill(
  { ref: "global://superpowers/tdd", fallback: "builtin://skills/tdd-implementation", required: true },
  context,
);
assert.equal(result.usedFallback, true);
```

- [ ] **步骤 2：运行测试，确认 Resolver 尚不存在**

运行：`node --import tsx --test tests/unit/skill-resolver.test.ts tests/integration/skill-lock.test.ts`

预期：模块不存在导致失败。

- [ ] **步骤 3：实现显式解析和锁定**

```ts
export interface ResolvedSkill {
  requestedRef: string;
  ref: string;
  source: "builtin" | "package" | "global" | "project";
  provider: "codex" | "claude" | "cursor" | "generic";
  rootId: string;
  entrypoint: string;
  digest: string;
  candidates: Array<{ rootId: string; digest: string }>;
  required: boolean;
  usedFallback: boolean;
}
```

Builtin/Package/Project Skill 可进入 Work Item 快照；Global Skill 只记录逻辑引用、Provider 和摘要。不得搜索同名替代品。

`package://skills/<name>` 只相对当前 `WorkflowPackage.root` 解析，并要求 Skill 出现在
Manifest 文件清单。增加测试证明同一 Package 从 Builtin 位置 eject 到 Project 位置后解析结果
摘要不变；`package://../other`、跨 Package 符号链接和未声明 Skill 分别 fail closed。

实现固定默认根：Codex 为 `~/.agents/skills`，Claude 为 `~/.claude/skills`，Cursor
为 `~/.agents/skills`、`~/.cursor/skills`、`~/.claude/skills`、`~/.codex/skills`，
Generic 无默认根。再追加 `skills.additionalGlobalRoots`。测试使用临时 HOME，验证多个候选
摘要不同时返回 `WSSPEC_SKILL_AMBIGUOUS`，摘要相同时按根顺序选择但保留候选诊断。

- [ ] **步骤 4：实现摘要变化和 fallback 规则**

必需 Global Skill 内容变化返回 `WSSPEC_SKILL_LOCK_CHANGED`；缺失时只能使用 Workflow 已声明且已锁定的 fallback。
URI 逐段校验，真实路径必须保持在根内；Work Item、事件和 Lock 不得写入临时 HOME 绝对路径。

- [ ] **步骤 5：运行 Resolver、锁和类型测试**

运行：`node --import tsx --test tests/unit/skill-resolver.test.ts tests/integration/skill-lock.test.ts && npm run typecheck`

预期：全部通过，锁文件不包含环境变量值和不可移植绝对路径。

- [ ] **步骤 6：提交**

```bash
git add src/registry/skills tests/unit/skill-resolver.test.ts tests/integration/skill-lock.test.ts
git commit -m "feat: resolve and lock workflow skills"
```

### Task 6：Workflow Compiler 与风险 Profile

**文件：**
- 替换：`src/domain/workflow.ts`
- 替换：`src/engine/compiler.ts`
- 创建：`src/policy/{profile,risk}.ts`
- 替换：`tests/unit/compiler.test.ts`
- 创建：`tests/unit/profile-policy.test.ts`

**接口：**
- 输入：Task 4-5 的 Workflow Package 和 Skill。
- 输出：`compileWorkflow(pkg, profile): CompiledWorkflow`、`resolveChangePolicy(input): ResolvedChangePolicy`、`selectProfile(input): ResolvedProfile`、`evaluateProfileUpgrade(input): ProfileDecision`。

- [ ] **步骤 1：编写失败的编译器测试**

覆盖重复 ID、循环、未知依赖、非法表达式、未知 Executor、必需 Skill 缺失、启用 Step 消费已跳过必需输出，以及 Profile 修改 `uses`、依赖、安全类别、外部目标或关闭 TDD Red/Green Gate。文档 Workflow 必须编译 `documentation-only` Change Policy；空路径、绝对路径、父目录逃逸和生产代码兜底路径均失败，Profile 与 Skill 不能扩大范围。

- [ ] **步骤 2：编写失败的 Profile 选择测试**

```ts
assert.equal(selectProfile({ mode: "auto", phase: "intake", risk: null }).id, "quick");
assert.equal(selectProfile({ mode: "auto", phase: "post-explore", risk: null }).id, "standard");
assert.equal(evaluateProfileUpgrade({ current: "standard", minimum: "quick" }).profile, "standard");
assert.equal(evaluateProfileUpgrade({ current: "standard", minimum: "governed" }).profile, "governed");
```

同时断言 Quick 只跳过独立 `design`，仍启用 `plan` 并要求 `artifactLevel: "compact"`；
`implement` 缺少 `tasks` 时编译失败。

- [ ] **步骤 3：运行测试，确认旧固定 Kind 编译器失败**

运行：`node --import tsx --test tests/unit/compiler.test.ts tests/unit/profile-policy.test.ts`

预期：失败，因为旧编译器没有 Profile 和 Step Manifest。

- [ ] **步骤 4：实现 Step Manifest 和 overlay 编译**

```ts
export type SecurityClass = "agent" | "local-read" | "local-write" | "external-read" | "external-write" | "control";

export interface CompiledStep {
  id: string;
  uses: string;
  securityClass: SecurityClass;
  needs: string[];
  enabled: boolean;
  skills: ResolvedSkill[];
  inputs: ArtifactRequirement[];
  outputs: ArtifactDeclaration[];
}

export interface ResolvedChangePolicy {
  kind: "feature" | "documentation-only";
  allowedPaths: string[];
  digest: string;
}
```

安全类别由 Registry Manifest 决定，Workflow YAML 无权覆盖。文档路径从项目
`documentation.allowedPaths` 解析，缺省使用设计规格中的五类路径；结果写入 `CompiledWorkflow`，
后续 Profile、Workflow Step 和 Skill 均无权扩大。

- [ ] **步骤 5：实现确定性风险规则和单向升级结果**

规则读取 Issue 标签、需求风险、影响路径、实际修改路径、文件类型和计划动作；Policy 只返回 Profile 决策及受影响 Step，不直接修改 Runtime。

- [ ] **步骤 6：运行编译器、Profile、Schema 和类型测试**

运行：`node --import tsx --test tests/unit/compiler.test.ts tests/unit/profile-policy.test.ts tests/contract/schemas.test.ts && npm run typecheck`

预期：全部通过。

- [ ] **步骤 7：提交**

```bash
git add src/domain/workflow.ts src/engine/compiler.ts src/policy tests/unit/compiler.test.ts tests/unit/profile-policy.test.ts
git commit -m "feat: compile workflows with risk profiles"
```

### Task 7：Application Facade 与原子 Acquire/Submit

**文件：**
- 创建：`src/application/{application,start,acquire,submit,decide,inspect}.ts`
- 创建：`src/registry/executors/{types,registry}.ts`
- 创建：`src/registry/connectors/local-requirement.ts`
- 修改：`src/storage/{work-items,control-plane}.ts`
- 替换：`tests/integration/stage-execution.test.ts`
- 创建：`tests/integration/application-flow.test.ts`

**接口：**
- 输入：前六项任务的协议、Package、Skill、Compiler、Profile 和现有控制面。
- 输出：`createApplication(dependencies): WSSpecApplication` 与 `StepExecutor` Registry。

- [ ] **步骤 1：编写失败的本地 Application 流程测试**

```ts
const started = await app.start({ root, title: "增加登录", source: { type: "prompt", text: "增加登录" }, profile: "auto" });
const action = await app.acquire({ root, workItemId: started.workItemId, actor: "codex" });
assert.equal(action.action, "execute");
assert.equal(action.workPackage.stepId, "intake");
assert.equal("conversationHistory" in action.workPackage, false);
```

同时覆盖 Prompt/本地文件采集、显式 `workflowRef` 选择 `feature-delivery` 或 `documentation-delivery`、缺省读取 `activeWorkflow`、未知 Workflow 拒绝、文档 Workflow 实际 Git diff 越界拒绝、幂等重试、旧 Attempt 提交和第二个 Git worktree 恢复。Profile 运行时升级由下一份计划实现，本任务只持久化初始 Profile 决策。

- [ ] **步骤 2：运行测试，确认 Application Factory 缺失**

运行：`node --import tsx --test tests/integration/application-flow.test.ts`

预期：模块不存在导致失败。

- [ ] **步骤 3：实现 Executor Registry**

```ts
export interface StepExecutor {
  id: string;
  securityClass: SecurityClass;
  acquire(step: CompiledStep, runtime: RuntimeProjection): Promise<AgentAction>;
  validate(step: CompiledStep, result: SubmitResult, runtime: RuntimeProjection): Promise<ValidatedStepResult>;
}
```

本阶段注册 `agent.execute`、线性本地 Fixture 所需的 control executor，以及只支持 Prompt/仓库内 Markdown/TXT 的 `connector.execute / requirement.capture`。本地来源必须生成不可变 Source Artifact；GitHub、GitLab 和飞书来源在 Connector 计划实现。

- [ ] **步骤 4：实现 Start、快照、原子 Acquire/Submit 和 Decide**

Start 解析显式 `workflowRef` 或项目 `activeWorkflow`，并快照 Workflow Package、Builtin/Project Skill、Skill Lock、Profile、Schema、配置、来源、`ResolvedChangePolicy` 和基线摘要；创建后禁止切换 Workflow。Acquire 在一次控制面变更中创建 Attempt、内部 Lease 和 Work Package；Submit 独立校验身份、摘要、实际 Git diff 路径和 Artifact，文档范围越界返回 `WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`。新增 `src/application/decide.ts`，复用真实 TTY 审批边界，并在批准、拒绝和请求过期后返回下一条 `AgentAction`。

- [ ] **步骤 5：运行 Application、恢复、锁和类型测试**

运行：`node --import tsx --test tests/integration/application-flow.test.ts tests/integration/recovery.test.ts tests/integration/lock-recovery.test.ts && npm run typecheck`

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add src/application src/registry/executors src/registry/connectors/local-requirement.ts src/storage/work-items.ts src/storage/control-plane.ts tests/integration/application-flow.test.ts tests/integration/stage-execution.test.ts
git commit -m "feat: add the WSSpecKit application facade"
```

### Task 8：新 CLI Adapter 与中文 Driver Skill

**文件：**
- 替换：`src/cli/{main.ts,commands/core.ts}`
- 创建：`src/adapters/cli/output.ts`
- 创建：`src/adapters/cli/workflow.ts`
- 创建：`src/adapters/skills/{install,codex,claude,cursor,generic}.ts`
- 替换：`tests/contract/integrations.test.ts`
- 创建：`tests/contract/chinese-guidance.test.ts`
- 创建：`tests/e2e/{driver-install,application-cli}.test.ts`
- 创建：`tests/e2e/workflow-cli.test.ts`

**接口：**
- 输入：Task 7 的 `WSSpecApplication` 和 Task 3 的中文 Driver Skill。
- 输出：公开 CLI 与各 Agent 的 Driver Skill 安装器。

- [ ] **步骤 1：编写失败的 CLI 与安装测试**

验证帮助只暴露 `init/start/acquire/submit/decide/inspect/workflow/agent install`；`start --workflow` 能显式选择两个内置 Workflow；旧命令和不存在的 `resume` 返回 `WSSPEC_COMMAND_UNKNOWN`；`workflow list/show/eject/validate/use` 均有正反例；首次 `workflow use` 非 Builtin Package 返回信任摘要并要求通过 `decide` 明确确认，拒绝或非交互执行保持 blocked，摘要变化后要求重新确认；所有帮助、错误和 Driver Skill 正文为中文。测试必须使用临时 HOME，不能写入真实用户 Skill 目录。

- [ ] **步骤 2：运行测试，确认旧 CLI 仍存在**

运行：`node --import tsx --test tests/e2e/application-cli.test.ts tests/e2e/driver-install.test.ts tests/e2e/workflow-cli.test.ts tests/contract/integrations.test.ts tests/contract/chinese-guidance.test.ts`

预期：失败，因为旧命令仍存在且没有安装器。

- [ ] **步骤 3：实现薄 CLI Adapter**

每个命令只解析参数、调用一个 Application 方法并输出稳定 JSON；CLI 模块不得包含业务状态转换。

`workflow eject` 必须原子复制 Builtin Package，目标存在时拒绝覆盖；`workflow use` 必须先完成 Package、Profile 和 Skill 编译校验，再调用 Task 4 的信任判定。只有摘要匹配的 trusted 决策才能更新 `.wsspec/workflow.yaml`；`start` 必须重复校验信任，防止启用后 Package 被修改。

- [ ] **步骤 4：实现中文 Driver Skill 生成与原子安装**

所有客户端共享同一中文循环说明：

```text
新任务判断功能/文档 Workflow 并显式 start / 已有任务 inspect -> acquire -> 读取绑定 Skill -> 当前 Agent 执行 -> submit -> 重复
```

Driver 仅在需求明确为纯文档或无代码变更时建议 `documentation-delivery`，其余默认
`feature-delivery`；必须传递 `workflowRef`，允许用户覆盖，不能在创建后自动切换。

安装时展示精确目标，拒绝覆盖无关 Skill，并支持 `--dry-run`。

安装目标必须与宿主官方目录一致：Codex 安装到 `~/.agents/skills/wsspeckit-driver`，
Claude 安装到 `~/.claude/skills/wsspeckit-driver`，Cursor 默认安装到
`~/.cursor/skills/wsspeckit-driver`，Generic 使用显式 `--target`。安装器不向
`~/.cursor/rules` 写入 `.mdc`；Driver Skill 的触发描述和手动调用示例都使用中文。

Driver Skill 必须提示 Agent：面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。WSSpecKit 不静态分析任意 TypeScript 文案，也不检查用户输入或用户安装的 Global/Project Skill 语言。

- [ ] **步骤 5：运行完整基础门禁**

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

预期：全部退出码为 0；发布资源中不存在旧公开 Schema、旧命令、旧产品名或中文静态分析器。

- [ ] **步骤 6：提交**

```bash
git add src/cli src/adapters tests/contract/integrations.test.ts tests/contract/chinese-guidance.test.ts tests/e2e/application-cli.test.ts tests/e2e/driver-install.test.ts tests/e2e/workflow-cli.test.ts
git commit -m "feat: expose the Chinese WSSpecKit driver protocol"
```

### Task 9：删除旧协议文档并建立新文档真源

**文件：**
- 删除：`docs/specs/2026-08-16-wiesen-spec-kit-{requirements,design}.md`
- 删除：`docs/reference/{artifacts-v1,execution-contracts-v1,project-config-v1,state-transitions-v1,work-item-v1,workflow-language-v1}.md`
- 删除：`docs/plans/2026-08-16-{m1-control-plane-hardening-plan,m1-implementation-plan,protocol-hardening-plan}.md`
- 创建：`docs/reference/{application-protocol,workflow-language,skill-resolution,connector-contracts}.md`
- 创建：`tests/contract/{documentation-baseline,requirements-traceability}.test.ts`

**接口：**
- 输入：本计划已实现的公开 Schema、CLI 和资源。
- 输出：与生成物一致的中文公开参考文档；仓库中不存在可被误认为有效的旧协议。

- [ ] **步骤 1：编写失败的文档基线测试**

测试断言旧文件清单全部不存在、四份新参考文档存在；从生成 Schema 提取命令、协议操作、
Skill URI 和错误码，逐项断言参考文档包含对应标识。另用 `rg` 断言旧产品名、旧命令和
旧 Schema ID 只允许出现在负例测试夹具中。

需求追踪测试读取设计规格中的 `REQ-01` 至 `REQ-20`，断言 ID 唯一且连续，每项都包含设计落点、
实施 Task 和验收证据；计划中引用的 Task 标题必须真实存在。

- [ ] **步骤 2：运行测试，确认旧文档造成失败**

运行：`node --import tsx --test tests/contract/documentation-baseline.test.ts tests/contract/requirements-traceability.test.ts`

预期：FAIL，输出仍存在的旧文档路径和缺失的新参考文档。

- [ ] **步骤 3：删除旧文档并写入中文参考文档**

四份参考文档分别覆盖五个 Application 操作、Workflow Language v1、四类 Skill 解析、
Workflow Package 信任与锁定、Connector/Provider/审批/回读契约。文档中的 JSON/YAML 示例必须通过契约测试解析，
不复制已经失效的旧类型。

- [ ] **步骤 4：运行文档与完整基础门禁**

运行：`node --import tsx --test tests/contract/documentation-baseline.test.ts tests/contract/requirements-traceability.test.ts && npm test && npm run build`

预期：全部通过；`docs/specs`、`docs/reference`、`docs/plans` 中不存在旧协议文件。

- [ ] **步骤 5：提交**

```bash
git add -A docs/specs docs/reference docs/plans tests/contract/documentation-baseline.test.ts tests/contract/requirements-traceability.test.ts
git commit -m "docs: replace legacy protocol documentation"
```

## 基础阶段完成门禁

```bash
rg -n 'WiesenSpecKit|wiesen-spec-kit|WSK-|WSPEC_|builtin\.stage-context|builtin\.stage-result|command === "(next|claim|context|complete)"' package.json src schemas resources tests
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

`rg` 只允许命中用于证明旧名称和命令被拒绝的负例测试。所有验证命令必须退出 0。文档、模板、CLI 文案和内置 Skill 的中文扫描必须作为契约测试通过。
