# WSSpecKit 控制流与 Profile Runtime 实施计划

> **Agent 执行要求：** 使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，在基础计划全部门禁通过后逐任务执行。

**目标：** 实现 `when`、重试、有界 Review-Fix 循环、Profile 运行时升级、审批、可信 Gate 和 Close，使功能/文档两个内置 Workflow 在纯本地环境完整运行。

**架构：** Compiler 生成不可变执行图，Runtime 只通过事件推进 Step/Loop/Work Item 投影。Profile Policy 返回决策与影响集合，Runtime 负责失效传播；表达式引擎只解释有限 AST，不执行任意代码。

**技术栈：** 延续基础计划；不新增表达式或工作流第三方运行库。

## 全局约束

- 继承基础计划全部约束和接口。
- 循环必须有 `maxIterations`，重试必须有 `maxAttempts`。
- Profile 自动变化只能 `quick -> standard -> governed`。
- 所有用户文案和内置 Skill 使用中文。
- 每项任务按失败测试、最小实现、验证、提交顺序执行。

---

### Task 1：有限表达式与条件执行

**文件：**
- 创建：`src/engine/expressions/{ast,parser,evaluate}.ts`
- 创建：`src/engine/control/condition.ts`
- 创建：`tests/unit/expressions.test.ts`
- 创建：`tests/integration/conditional-step.test.ts`

**接口：**
- 输入：基础计划的 `CompiledWorkflow` 和 Runtime Artifact/Binding 视图。
- 输出：`parseExpression(source): ExpressionAst`、`evaluateExpression(ast, scope): boolean`。

```ts
export type ExpressionAst =
  | { kind: "literal"; value: string | boolean | number | null }
  | { kind: "path"; root: "artifacts" | "bindings" | "steps"; segments: string[] }
  | { kind: "binary"; op: "==" | "!=" | "&&" | "||"; left: ExpressionAst; right: ExpressionAst };
```

- [ ] 编写失败测试，覆盖布尔值、相等/不等、属性读取、缺失 Binding、未知标识、函数调用、赋值、原型属性和超长表达式。

```ts
assert.equal(evaluateExpression(parseExpression("bindings.issue.exists"), scope), false);
assert.throws(() => parseExpression("process.exit()"), /WSSPEC_EXPRESSION_FORBIDDEN/);
```

- [ ] 运行：`node --import tsx --test tests/unit/expressions.test.ts tests/integration/conditional-step.test.ts`；预期模块缺失失败。
- [ ] 实现手写有限 Parser，只允许字面量、声明路径、`==`、`!=`、`&&`、`||` 和括号；禁止 `eval`、`Function` 和动态属性。
- [ ] 条件为 false 时原子写入 `step.skipped` 事件；恢复回放必须得到相同结果。
- [ ] 运行聚焦测试和 `npm run typecheck`，预期通过。
- [ ] 提交：`git commit -m "feat: evaluate bounded workflow conditions"`。

### Task 2：重试与有界 Review-Fix 循环

**文件：**
- 创建：`src/engine/control/{retry,loop}.ts`
- 修改：`src/storage/control-plane.ts`
- 修改：`src/domain/states.ts`
- 创建：`tests/integration/retry-runtime.test.ts`
- 创建：`tests/integration/review-fix-loop.test.ts`

**接口：**
- 输入：条件引擎和 Application `acquire/submit`。
- 输出：`LoopProjection`、`RetryProjection` 和下一可执行内部 Step。

```ts
export interface LoopProjection {
  loopId: string;
  iteration: number;
  maxIterations: number;
  status: "running" | "succeeded" | "blocked";
}

export interface RetryProjection {
  stepInstanceId: string;
  attemptsUsed: number;
  maxAttempts: number;
  status: "ready" | "running" | "exhausted";
}
```

- [ ] 编写失败测试：失败后重试、非可重试错误、恢复后次数不重置、Review 通过退出、Fix 后进入下一轮、达到上限阻塞、旧轮次 Attempt 拒绝。

```ts
assert.deepEqual(projection.loops["review-fix"], { iteration: 2, maxIterations: 5, status: "running" });
```

- [ ] 运行聚焦测试，预期缺少 Loop/Retry 投影失败。
- [ ] 实现循环实例 ID `loopId:iteration:stepId`；每轮 Artifact 和 Attempt 独立，外层 Step 只在 `until` 为 true 时成功。
- [ ] 实现重试预算和稳定错误分类；进程重启不得恢复预算。
- [ ] 运行聚焦测试、恢复测试和类型检查。
- [ ] 提交：`git commit -m "feat: run bounded review and retry control flow"`。

### Task 3：Profile 运行时选择、升级与失效传播

**文件：**
- 创建：`src/application/profile.ts`
- 修改：`src/application/submit.ts`
- 修改：`src/engine/results.ts`
- 修改：`src/storage/control-plane.ts`
- 创建：`tests/integration/profile-runtime.test.ts`

**接口：**
- 输入：基础计划的 `evaluateProfileUpgrade`。
- 输出：`applyProfileDecision(projection, decision): RuntimeProjection`。

```ts
export interface ProfileDecision {
  previous: "quick" | "standard" | "governed";
  selected: "quick" | "standard" | "governed";
  reasonRuleIds: string[];
  invalidatedStepIds: string[];
}
```

- [ ] 编写失败测试：provisional quick 只允许 intake/explore、low/unknown/high 分流、路径规则升级、禁止自动降级、升级补回 Step、下游结果/Claim/审批/Evidence 失效。
- [ ] 运行：`node --import tsx --test tests/integration/profile-runtime.test.ts`；预期缺少运行时应用失败。
- [ ] 实现 `profile.selected`、`profile.upgraded`、`projection.invalidated` 事件；升级先编译新 overlay，再一次性写入影响集合。
- [ ] Governed Review 校验 `reviewActor !== implementationActor`；无法提供独立 Actor 时返回 `WSSPEC_INDEPENDENT_REVIEW_REQUIRED`。
- [ ] 运行 Profile、恢复、Evidence 测试和类型检查。
- [ ] 提交：`git commit -m "feat: enforce runtime risk profile upgrades"`。

### Task 4：审批、可信 Gate 与 Close

**文件：**
- 修改：`src/engine/approvals.ts`
- 修改：`src/engine/verification.ts`
- 修改：`src/engine/archive.ts`
- 修改：`src/application/decide.ts`
- 创建：`tests/integration/profile-approval.test.ts`
- 创建：`tests/integration/workflow-close.test.ts`

**接口：**
- 输入：Resolved Profile、循环结果和现有 Evidence 服务。
- 输出：按 Profile 执行的审批、Gate、Close 判定。

```ts
export interface CloseDecision {
  allowed: boolean;
  missing: Array<{
    category: "step" | "artifact" | "approval" | "evidence" | "external-receipt";
    id: string;
  }>;
}
```

- [ ] 编写失败测试：Quick 无 Artifact 默认审批、Standard 规格/设计审批、Governed 规格/设计/计划审批、Gate 集合差异、独立 Review、缺失必需发布目标阻止关闭。
- [ ] 运行聚焦测试，预期旧固定阶段规则不匹配。
- [ ] 将审批和 Gate 判定改为读取 Compiled Step/Profile，不再识别固定阶段名。
- [ ] Close 逐项输出缺失 Step、Artifact、Approval、Evidence 和发布回读，不返回模糊失败。
- [ ] 运行审批伪终端、验证、归档和关闭测试。
- [ ] 提交：`git commit -m "feat: enforce profile approvals and close gates"`。

### Task 5：可信 TDD Red/Green Evidence

**文件：**
- 创建：`src/engine/tdd/{types,red-gate,green-gate}.ts`
- 修改：`src/engine/verification.ts`
- 修改：`src/application/submit.ts`
- 创建：`tests/integration/tdd-evidence.test.ts`

**接口：**
- 输入：Compiled `write-tests/verify-red/implement/verify-green` Step、项目固定 Test Gate 和当前 workspace digest。
- 输出：`recordRedEvidence(input): TrustedEvidence`、`recordGreenEvidence(input): TddCycleEvidence`。

```ts
export interface TddCycleEvidence {
  taskId: string;
  testPaths: string[];
  commandId: string;
  redEvidenceId: string;
  greenEvidenceId: string;
  refactorEvidenceId?: string;
}
```

- [ ] 编写失败测试：Red 只修改测试路径、同一 commandId 的预期测试失败、语法错误/缺依赖/超时不算 Red、无 Red 不能 acquire implement、修改或删除 Red 测试使 Evidence 失效、Green 必须同命令零退出、Profile 不能跳过两个 Gate；Review-Fix 修改生产代码后追加 Green Evidence，修改测试后路由回 `write-tests`。
- [ ] 运行：`node --import tsx --test tests/integration/tdd-evidence.test.ts`；预期缺少 TDD Evidence 模块失败。
- [ ] 实现失败分类和 Evidence 绑定；引擎直接运行固定 argv，记录 exit code、失败测试标识、test file digest、workspace digest 和脱敏摘要，Agent 报告不得升级为 trusted。
- [ ] 在 `submit` 后重算测试路径和摘要；Red 测试被删除、改成无断言通过或命令变化时返回 `WSSPEC_TDD_EVIDENCE_INVALIDATED`。Review-Fix 的 verify 使用同一 commandId 扩展 Evidence 链，测试摘要变化则重新开始当前 TDD Cycle。
- [ ] 运行：`node --import tsx --test tests/integration/tdd-evidence.test.ts tests/integration/profile-runtime.test.ts tests/integration/recovery.test.ts && npm run typecheck`；预期全部通过。
- [ ] 提交：`git commit -m "feat: require trusted TDD red green evidence"`。

### Task 6：三 Profile 本地 E2E

**文件：**
- 创建：`tests/e2e/quick-workflow.test.ts`
- 创建：`tests/e2e/standard-workflow.test.ts`
- 创建：`tests/e2e/governed-workflow.test.ts`
- 创建：`tests/e2e/profile-upgrade.test.ts`
- 创建：`tests/e2e/documentation-workflow.test.ts`

**接口：**
- 输入：本计划全部 Runtime 能力。
- 输出：无新接口；形成控制流完成门禁。

- [ ] 编写 Quick E2E：Prompt -> explore -> compact spec -> compact single-task plan -> write failing test -> trusted Red -> minimal implementation -> trusted Green -> 单轮 review -> close；断言 design skipped、tasks 和 `TddCycleEvidence` 存在。
- [ ] 编写 Standard E2E：完整规格/设计/计划、审批、Review-Fix 两轮、required Gates、close。
- [ ] 编写 Governed E2E：独立 Review Actor、完整 Gate、完整审计；外部目标使用可回读本地 Fixture。
- [ ] 编写运行中由 Quick 升级到 Governed 的 E2E，验证新增前置 Step 和失效传播。
- [ ] 编写 Documentation E2E：显式选择 `builtin://workflows/documentation-delivery`，完成紧凑规格/计划、文档编辑、trusted `docs.integrity`、Review-Fix 和 Close；断言不存在 `write-tests/verify-red/implement/verify-green` Step 与 `TddCycleEvidence`。再尝试修改生产代码、脚本、依赖和构建配置，分别断言 `WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`，且不能在原 Work Item 内切换到功能交付绕过 TDD。
- [ ] 对五条 E2E 分别在 `acquire` 后、循环 submit 后和 Profile 升级事件后终止进程，再由 `inspect + acquire` 恢复，断言 Workflow 引用、循环预算、Profile、Attempt 和审批不重置。
- [ ] 运行：`npm run lint && npm run typecheck && npm test && npm run build`，预期全部通过。
- [ ] 提交：`git commit -m "test: cover all workflow risk profiles"`。

## 完成门禁

两个内置 Workflow 和三个 Profile 必须由同一 Runtime 执行；崩溃恢复后 Workflow 引用、循环次数、重试预算、Profile、Evidence 和审批保持一致；功能交付不存在跳过 Red/Green 的路径，文档交付不存在越过文档路径边界或缺少 trusted 文档 Gate 的路径；不存在无界循环、自动降级或 Agent 自报 trusted Evidence 的路径。
