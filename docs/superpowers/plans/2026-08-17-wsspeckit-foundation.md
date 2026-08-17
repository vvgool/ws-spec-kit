# WSSpecKit 协议与工作流基础实施计划

> **Agent 执行要求：** 实施本计划时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务执行并使用复选框跟踪进度。

**目标：** 直接替换当前 alpha 协议，建立 WSSpecKit 首个正式协议基线，包括新产品标识、Application Protocol、完整内置资源、三层 Skill 解析、Workflow Package 和风险分级 Profile。

**架构：** 复用已经验证的摘要、原子文件、事件存储、锁、审批和 Evidence 实现，删除旧公开 Workflow 与 CLI 协议。CLI 和 Driver Skill 只调用 Application Protocol；Application 层组合 Workflow、Skill、Profile 和 Runtime 服务，不感知当前由 Codex、Claude 还是 Cursor 驱动。

**技术栈：** Node.js 22、TypeScript 5.9 严格模式、ESM、npm、YAML、JSON Schema 2020-12、AJV、RFC 8785 规范 JSON、Node Test Runner。

## 全局约束

- 产品名为 `WSSpecKit`，npm 包为 `ws-spec-kit`，CLI 保持 `wspec`，项目目录保持 `.wsspec/`。
- Work Item ID 使用 `WSS-...`，公开错误码使用 `WSSPEC_...`。
- 直接替换旧协议：不保留旧 Schema、公开命令、别名、迁移命令或双版本读取。
- 所有用户文档、CLI 文案、内置 Workflow 说明、模板和内置 Skill 正文使用中文。
- 协议字段、命令、URI、Schema ID、类型名和错误码使用英文标识。
- WSSpecKit 不选择或调用模型，不管理 Agent 的对话、Token 或上下文。
- Builtin、Global、Project Skill 必须使用显式 URI，不允许同名隐式覆盖。
- Profile 不得削弱 Executor 安全类别、可信验证或外部写入精确授权。
- 所有公开对象拒绝未知字段和不支持的版本。
- 每项任务先写失败测试，再写最小实现，最后单独提交。

## 计划边界

本计划交付可本地验证的 `init -> start -> acquire -> submit -> inspect` 基础链路。以下能力拆分为后续独立计划：有界循环运行、真实 GitLab/飞书/Wiki Connector、完整交付动作和最终发布。后续计划只能依赖本计划冻结的四组接口：

1. Task 2 的 `WSSpecApplication`、`AgentAction` 和 `WorkPackage`。
2. Task 4-5 的 `WorkflowPackage`、`ResolvedSkill` 和 `SkillLock`。
3. Task 6 的 `CompiledWorkflow` 和 `ResolvedProfile`。
4. Task 7 的 `StepExecutor` Registry。

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
- 输出：`WSSpecApplication`、`AgentAction`、`WorkPackage`、五类 Application 输入类型。

- [ ] **步骤 1：编写四类 AgentAction 的失败契约测试**

覆盖 `execute`、`await_approval`、`blocked`、`completed`，并验证 Work Package 拒绝 `conversationHistory`、`prompt` 和未知字段。

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
  decide(input: ApprovalDecision): Promise<AgentAction>;
  inspect(input: InspectInput): Promise<WorkItemView>;
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
- 创建：`resources/workflows/feature-delivery/{manifest.yaml,workflow.yaml}`
- 创建：`resources/workflows/feature-delivery/profiles/{quick,standard,governed}.yaml`
- 创建：`resources/skills/*/SKILL.md`
- 创建：`src/resources/catalog.ts`
- 修改：`src/storage/repository.ts`
- 创建：`tests/contract/builtin-resources.test.ts`
- 修改：`tests/integration/repository.test.ts`

**接口：**
- 输入：Task 2 的 Workflow/Profile Schema。
- 输出：`loadBuiltinCatalog(): Promise<BuiltinCatalog>` 和完整 `.wsspec/` 初始化。

- [ ] **步骤 1：编写失败的资源与中文约束测试**

验证每个 Builtin Skill 均有 `id`、`version`、中文 `description` 和中文正文；内置 Workflow 引用的 Skill 必须全部存在；`wspec init` 必须创建 `repository.yaml`、`config.yaml`、`workflow.yaml`。

```ts
assert.equal(parseYaml(await read(root, ".wsspec/workflow.yaml")).profile, "auto");
assert.match(skillBody, /[\u4e00-\u9fff]/u);
```

- [ ] **步骤 2：运行测试，确认资源和完整初始化缺失**

运行：`node --import tsx --test tests/contract/builtin-resources.test.ts tests/integration/repository.test.ts`

预期：失败，因为当前 init 只生成仓库身份且没有资源目录。

- [ ] **步骤 3：创建内置基础 Workflow、三种 Profile 和 Skill Catalog**

每个 Skill 必须用中文明确目标、输入、输出、停止条件和禁止副作用。Builtin Skill 不得依赖用户额外安装 Superpowers。

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

运行：`node --import tsx --test tests/contract/builtin-resources.test.ts tests/integration/repository.test.ts tests/e2e/package-install.test.ts`

预期：全部通过，安装后的包能定位 `resources/`。

- [ ] **步骤 6：提交**

```bash
git add resources src/resources src/storage/repository.ts tests/contract/builtin-resources.test.ts tests/integration/repository.test.ts
git commit -m "feat: bundle Chinese builtin workflows and skills"
```

### Task 4：Workflow Package 加载与锁定

**文件：**
- 创建：`src/workflow-package/{types,loader,lock}.ts`
- 创建：`tests/unit/workflow-package.test.ts`

**接口：**
- 输入：Task 3 的 Builtin Catalog。
- 输出：`loadWorkflowPackage(input): Promise<WorkflowPackage>`、`lockWorkflowPackage(pkg): WorkflowPackageLock`。

- [ ] **步骤 1：编写失败的 Package 测试**

覆盖 Builtin/Project URI、路径逃逸、符号链接逃逸、缺少 Manifest、不支持版本、锁文件未知内容和确定性摘要。

```ts
await assert.rejects(
  loadWorkflowPackage({ root, ref: "project://workflows/../../outside" }),
  /WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID/,
);
```

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
  contentDigest: string;
}
```

- [ ] **步骤 4：运行 Package 与类型测试**

运行：`node --import tsx --test tests/unit/workflow-package.test.ts && npm run typecheck`

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add src/workflow-package tests/unit/workflow-package.test.ts
git commit -m "feat: load and lock workflow packages"
```

### Task 5：三层 Skill Resolver 与 Skill Lock

**文件：**
- 创建：`src/registry/skills/{types,resolver,lock}.ts`
- 创建：`tests/unit/skill-resolver.test.ts`
- 创建：`tests/integration/skill-lock.test.ts`

**接口：**
- 输入：Task 4 的 `WorkflowPackage`。
- 输出：`resolveSkill(binding, context): Promise<ResolvedSkill>`、`createSkillLock(resolved): SkillLock`。

- [ ] **步骤 1：编写失败的三层解析测试**

覆盖 Builtin、Project、配置的 Global 目录、显式 fallback、可选缺失、必需缺失、摘要变化、路径逃逸和符号链接逃逸。

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
  source: "builtin" | "global" | "project";
  entrypoint: string;
  digest: string;
  required: boolean;
  usedFallback: boolean;
}
```

Builtin/Project Skill 可进入 Work Item 快照；Global Skill 只记录逻辑引用、Provider 和摘要。不得搜索同名替代品。

- [ ] **步骤 4：实现摘要变化和 fallback 规则**

必需 Global Skill 内容变化返回 `WSSPEC_SKILL_LOCK_CHANGED`；缺失时只能使用 Workflow 已声明且已锁定的 fallback。

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
- 输出：`compileWorkflow(pkg, profile): CompiledWorkflow`、`selectProfile(input): ResolvedProfile`、`evaluateProfileUpgrade(input): ProfileDecision`。

- [ ] **步骤 1：编写失败的编译器测试**

覆盖重复 ID、循环、未知依赖、非法表达式、未知 Executor、必需 Skill 缺失、启用 Step 消费已跳过必需输出，以及 Profile 修改 `uses`、依赖、安全类别或外部目标。

- [ ] **步骤 2：编写失败的 Profile 选择测试**

```ts
assert.equal(selectProfile({ mode: "auto", phase: "intake", risk: null }).id, "quick");
assert.equal(selectProfile({ mode: "auto", phase: "post-explore", risk: null }).id, "standard");
assert.equal(evaluateProfileUpgrade({ current: "standard", minimum: "quick" }).profile, "standard");
assert.equal(evaluateProfileUpgrade({ current: "standard", minimum: "governed" }).profile, "governed");
```

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
```

安全类别由 Registry Manifest 决定，Workflow YAML 无权覆盖。

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
- 创建：`src/application/{application,start,acquire,submit,inspect}.ts`
- 创建：`src/registry/executors/{types,registry}.ts`
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

同时覆盖幂等重试、旧 Attempt 提交、Profile 升级、第二个 Git worktree 恢复。

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

本阶段只注册 `agent.execute` 和线性本地 Fixture 所需的 control executor。

- [ ] **步骤 4：实现 Start、快照和原子 Acquire/Submit**

Start 快照 Workflow Package、Builtin/Project Skill、Skill Lock、Profile、Schema、配置、来源和基线摘要。Acquire 在一次控制面变更中创建 Attempt、内部 Lease 和 Work Package；Submit 独立校验身份、摘要、路径、Artifact 和 Profile。

- [ ] **步骤 5：运行 Application、恢复、锁和类型测试**

运行：`node --import tsx --test tests/integration/application-flow.test.ts tests/integration/recovery.test.ts tests/integration/lock-recovery.test.ts && npm run typecheck`

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add src/application src/registry/executors src/storage/work-items.ts src/storage/control-plane.ts tests/integration/application-flow.test.ts tests/integration/stage-execution.test.ts
git commit -m "feat: add the WSSpecKit application facade"
```

### Task 8：新 CLI Adapter 与中文 Driver Skill

**文件：**
- 替换：`src/cli/{main.ts,commands/core.ts}`
- 创建：`src/adapters/cli/output.ts`
- 创建：`src/adapters/skills/{install,codex,claude,cursor,generic}.ts`
- 替换：`tests/contract/integrations.test.ts`
- 创建：`tests/e2e/{driver-install,application-cli}.test.ts`

**接口：**
- 输入：Task 7 的 `WSSpecApplication` 和 Task 3 的中文 Driver Skill。
- 输出：公开 CLI 与各 Agent 的 Driver Skill 安装器。

- [ ] **步骤 1：编写失败的 CLI 与安装测试**

验证帮助只暴露 `init/start/acquire/submit/decide/inspect/workflow/agent install`；旧命令返回 `WSSPEC_COMMAND_UNKNOWN`；所有帮助、错误和 Driver Skill 正文为中文。测试必须使用临时 HOME，不能写入真实用户 Skill 目录。

- [ ] **步骤 2：运行测试，确认旧 CLI 仍存在**

运行：`node --import tsx --test tests/e2e/application-cli.test.ts tests/e2e/driver-install.test.ts tests/contract/integrations.test.ts`

预期：失败，因为旧命令仍存在且没有安装器。

- [ ] **步骤 3：实现薄 CLI Adapter**

每个命令只解析参数、调用一个 Application 方法并输出稳定 JSON；CLI 模块不得包含业务状态转换。

- [ ] **步骤 4：实现中文 Driver Skill 生成与原子安装**

所有客户端共享同一中文循环说明：

```text
启动或恢复 -> acquire -> 读取绑定 Skill -> 当前 Agent 执行 -> submit -> 重复
```

安装时展示精确目标，拒绝覆盖无关 Skill，并支持 `--dry-run`。

- [ ] **步骤 5：运行完整基础门禁**

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

预期：全部退出码为 0；发布资源中不存在旧公开 Schema、旧命令、旧产品名或未登记英文用户文案。

- [ ] **步骤 6：提交**

```bash
git add src/cli src/adapters tests/contract/integrations.test.ts tests/e2e/application-cli.test.ts tests/e2e/driver-install.test.ts
git commit -m "feat: expose the Chinese WSSpecKit driver protocol"
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
