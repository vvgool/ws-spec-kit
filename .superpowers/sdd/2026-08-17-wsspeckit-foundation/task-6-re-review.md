# Task 6 修复后第二次定向复审

## Verdict

- **Ready: Yes**
- **Spec compliance: PASS（限 Task 6 当前范围）**
- **Code quality: PASS**
- **前三项 open finding：全部 CLOSED**
- **新增 open finding：无**

审查绑定基准 `314d8b346f6fa59b5be69a84a4773566f4ccf1f1` 与最终当前未提交工作树。复审重新检查了 Task 6 brief、设计规格第 9 节、Builtin Profile 绝对矩阵、遗留编译器基准实现和当前修复，并独立重跑三个既有行为探针、Review-Fix 上界反例、聚焦测试、扩展测试及 typecheck。除本报告外，复审未修改实现、测试、索引或提交。

当前没有阻止 Task 6 进入下一阶段的 Critical 或 Important finding。此结论只表示 Workflow Compiler 与风险 Profile 任务在所审范围内 Ready，不等同于完整产品、真实 Runtime/E2E 或生产发布 GO。

## Finding Closure

| Finding | 状态 | 独立结论 |
|---|---|---|
| C1：Standard/Governed 可整体降级 | **CLOSED** | `validateProfileSafety()` 保留跨 Profile 单调校验，`validateBuiltinProfileMatrix()` 又对两个 Builtin Workflow 固定绝对语义：Standard/Governed 必需 Step、Artifact/审批、Governed 发布回读和完整审计均不可协同降级。联合降级探针以 `WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE` 拒绝。 |
| I1：遗留 `new/new-file` 预检语义不完整且无稳定错误码 | **CLOSED** | `validateLegacyWorkflowSnapshot()` 与基准旧编译器逐项对照后，已恢复 Executor 契约、Artifact producer closure、实现前交互审批、Review 路径、已知/required Gate 和 Verify-before-Close；`LegacyWorkflowError` 暴露稳定 `code/path`。CLI 在 `createWorkItem()` 前同时读取 Workflow/Config 并执行预检。五类反例全部 fail before side effects。 |
| N1：Profile 安全修复误禁合法可选 Step | **CLOSED** | Builtin 绝对矩阵只在 `packageRef === builtin://workflows/{workflowId}` 时生效；Documentation Quick 只固定九个核心 Step，允许关闭可选 `update-wiki`；Project Workflow 不继承 Builtin-only 默认。两个合法禁用正例均编译成功。 |

## Builtin Profile Matrix Review

- **作用域没有过宽：** 绝对矩阵只约束两个 canonical Builtin ref；eject 后的 `project://` Workflow 仍保留 Profile v1 的合法 `enabled` overlay 能力。
- **Feature Quick：** 必须且只能跳过独立 `design`，保留 compact specification、compact tasks/plan、TDD Red/Green 内核与 trusted `test` Gate。
- **Feature Standard/Governed：** Standard 固定规格/设计审批和完整 specification/design/tasks；Governed 再固定计划审批、独立 Review Actor、Issue/Knowledge/read-back、complete/extended 审计和四类完整记录。
- **Documentation：** Quick 固定核心交付链和 compact specification/tasks，但发布 Step 可选；Standard/Governed 保留全部 Step，Governed 固定规格/计划审批、独立 Review、发布回读和完整审计。每个 Profile 仍由 `validateDocumentationSafety()` 保证 trusted `docs.integrity` Gate。
- **Review-Fix 上界：** Quick 必须恰为 1 轮，Builtin Standard/Governed 必须恰为 5 轮。复审期间补充验证了 Standard/Governed 同步提高到 `1,000,000` 也会被拒绝，避免“单调更强”绕过设计中的有限循环上界。

未发现矩阵对 Project Workflow 或 Documentation 可选发布 Step 的误限制，也未发现设计第 9.3 节所列 Builtin 绝对要求仍可通过协同修改绕过。

## Independent Verification

### Automated Tests

- `node --import tsx --test tests/unit/compiler.test.ts tests/unit/profile-policy.test.ts`
  - **35 passed, 0 failed**
- `node --import tsx --test tests/unit/compiler.test.ts tests/unit/profile-policy.test.ts tests/contract/schemas.test.ts tests/contract/builtin-resources.test.ts tests/unit/workflow-package.test.ts`
  - **79 passed, 0 failed**
- `npm run typecheck`
  - **PASS**

### Behavior Probes

```text
joint Standard/Governed downgrade:
  REJECTED code=WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE
  path=/profiles/standard/steps/clarify/approval

Documentation Quick optional Step disable: ACCEPTED value=false
Project Workflow optional Step disable: ACCEPTED value=false

Builtin oversized Review-Fix:
  REJECTED code=WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE
  path=/profiles/standard/steps/review-fix/maxIterations

legacy artifact:
  REJECTED code=WSSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER path=/stages/3
legacy approval:
  REJECTED code=WSSPEC_COMPILE_APPROVAL_REQUIRED path=/stages/3
legacy review:
  REJECTED code=WSSPEC_COMPILE_REVIEW_PATH_REQUIRED path=/stages/5
legacy gate:
  REJECTED code=WSSPEC_COMPILE_REQUIRED_GATE_MISSING path=/stages/5
legacy close:
  REJECTED code=WSSPEC_COMPILE_VERIFY_PATH_REQUIRED path=/stages/6
```

## Assessment

**Ready: Yes.** 前次复审的 C1、I1、N1 均已有实现、回归测试和独立反例证据支持关闭；最终 Builtin 绝对矩阵同时保持安全底线、规范规定的有限 Review 上界，以及 Project/Documentation 可选 Step 的合法扩展能力。Task 6 可以进入下一阶段。
