# Task 6 Parent Review Fix Round 1 Report

## 状态

DONE

修复基线：`aaef569 feat: compile workflows with risk profiles`。

## Finding Closure

### Important 1：必需 Artifact producer 保证性

- `producedArtifacts()` 现在同时传播祖先启用状态、条件执行状态与 `ArtifactDeclaration.required`。
- required consumer 只接受启用、无条件且 `required:true` 的依赖闭包 producer。
- 条件 producer 与可选 output 统一返回 `WSSPEC_COMPILE_OUTPUT_NOT_GUARANTEED`；全部 disabled producer 保留原 `WSSPEC_COMPILE_DISABLED_OUTPUT_REQUIRED`。
- 递归 control Step 使用同一保证性传播；存在另一条无条件 required producer 时允许编译。

### Important 2：项目 Gate policy 绝对集合

- 正式接口变为 `compileWorkflow(pkg, profile, projectGatePolicy)`。
- `ProjectGatePolicy` 显式携带 `requiredGateIds` 与 `configuredGateIds`；拒绝未知字段、非法/重复 ID、Workflow Gate registry 外 ID，以及 required 不属于 configured 的策略。
- Standard 的有效验证集合必须覆盖全部 required Gate；Governed 必须覆盖全部 configured Gate。
- 只有启用、非 Red 预期的 `command.execute quality.*` Step 计入有效验证集合，不能把 Gate 挂到普通 Step 充数。
- Builtin `test` / `docs.integrity` 最小 Gate 仍先由既有专用安全校验执行，保留稳定错误优先级。

### Important 3：custom risk rule Step 注入

- `RiskRule` 不再公开 `affectedSteps`。
- custom rule 只决定匹配条件与最低 Profile；未知字段在运行时以 `WSSPEC_RISK_RULE_INVALID` 和绝对 path 拒绝。
- `affectedSteps` 由最终 minimum 和 Workflow kind 的固定失效映射生成并排序。
- documentation governed custom rule 只返回 `clarify/plan/review-fix/verify-document/commit/close`，不会出现功能 Workflow 的 `verify-green`。

### Normal 1：legacy preflight strict v1 structure

- `validateLegacyWorkflowSnapshot()` 在任何语义检查前依次执行 `builtin.workflow.v1` 与 `builtin.project-config.v1` 校验。
- `SchemaValidationError` 原样传播，不丢失 `WSSPEC_SCHEMA_INVALID_VALUE` / `WSSPEC_SCHEMA_UNKNOWN_FIELD` 及 `/version`、根、Stage、approval、config 的精确 path。
- 既有 legacy Artifact、审批、Review、Gate、Close 语义错误码保持不变。

## TDD Evidence

### Artifact

- RED：compiler suite `29 passed / 2 failed`；顶层 optional/conditional producer 与 loop optional producer 都因“未抛异常”失败。
- GREEN：compiler suite `31 passed / 0 failed`；替代 required producer 正例同时通过。

### Gate policy

- RED：compiler suite `32 passed / 3 failed`；unknown policy ID、Standard required 缺失、Governed configured 缺失均因第三参数被忽略而失败。
- 首次 GREEN 暴露 Builtin 最小 Gate 错误优先级回归：`34 passed / 1 failed`。
- 调整校验顺序后 GREEN：`35 passed / 0 failed`，原 `WSSPEC_COMPILE_TDD_REQUIRED` 保持。

### Risk policy

- RED：profile-policy suite `6 passed / 3 failed`；feature/docs custom rule 返回空集合，且 `affectedSteps` 注入未拒绝。
- GREEN：profile-policy suite `9 passed / 0 failed`。

### Legacy strict schema

- RED：compiler suite `35 passed / 1 failed`；unsupported workflow version 因未抛异常失败。
- GREEN：compiler suite `36 passed / 0 failed`；workflow/config version 和 unknown root/Stage/approval/config 均返回预期 code/path。

## Final Verification

全部命令使用：

```sh
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH
```

- focused compiler/profile：`45 passed / 0 failed`。
- compiler/profile/schema/Builtin/loader：`89 passed / 0 failed`。
- `npm run typecheck`：passed。
- `npm test`：`218 passed / 0 failed / 0 skipped`；包含 packed clean-consumer 与 CLI E2E。
- `npm run build`：passed。
- `npm run schemas:generate`：passed。
- `git diff --exit-code -- schemas`：无差异。
- `git diff --check`：无输出。

## Scope Boundary

本报告仅关闭 `task-6-parent-review.md` 的 round 1 四项 finding。正式 Runtime 对 Gate policy 的项目配置装配、Profile 升级后的原子失效传播、真实 Gate/Connector 执行和生产发布仍属于后续任务，本结论不等同于完整产品或生产 GO。
