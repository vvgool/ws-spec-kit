# Application Protocol 参考

本文是 `wspec` 的公开 Application Protocol 真源。面向用户的解释使用中文；字段名、Schema ID、URI、命令名和错误码保持英文。客户端只通过稳定 JSON 调用 Application，不直接修改控制面。

## 1. 命令与操作

| CLI 命令 | Application 操作 | 输入 Schema | 说明 |
|---|---|---|---|
| `init` | repository initialization | 无 | 初始化当前 Git 仓库的 `.wsspec` 配置。 |
| `start` | `start` | `builtin.application-start-input.v1` | 从 Prompt 或仓库内文件创建 Work Item，并快照 Workflow、Skill、配置和来源。 |
| `acquire` | `acquire` | `builtin.application-acquire-input.v1` | 取得下一可执行 Step 的 `AgentAction`。 |
| `submit` | `submit` | `builtin.application-submit-input.v1` | 提交本次 Attempt 的结果、Artifact 和 Evidence 引用。 |
| `decide` | `decide` | `builtin.application-decision-input.v1` | 对步骤审批或 Workflow 信任作出明确决定。 |
| `inspect` | `inspect` | `builtin.application-inspect-input.v1` | 读取已快照的 Work Item 状态，不创建新 Attempt。 |
| `workflow` | workflow management | 无 | 支持 `list`、`show`、`validate`、`eject`、`use`。 |
| `agent install` | Driver installation | 无 | 安装 `codex`、`claude`、`cursor` 或 `generic` Driver Skill。 |

### `start`

输入：`StartInput`，对应 `builtin.application-start-input.v1`。必须提供 `root` 和 `source`；`source` 为 `prompt` 的 `text` 或 `file` 的 `path`，可选 `workflowRef` 与 `profile`。输出：`StartResult`，含新建的 `workItemId`、实际 `workflowRef` 和非 `auto` 的 `profile`。

```json contract=schema:builtin.application-start-input.v1
{
  "root": "/workspace/demo",
  "source": { "type": "prompt", "text": "补充登录错误文档" },
  "workflowRef": "builtin://workflows/documentation-delivery",
  "profile": "standard"
}
```

### `acquire`

输入：`AcquireInput`，对应 `builtin.application-acquire-input.v1`，包含 `root`、`workItemId` 与必填 `actor`。输出：`AgentAction`。客户端必须按 `execute`、`await_approval`、`blocked` 或 `completed` 的动作类型继续处理，不能自行推进控制面。

### `submit`

输入：`SubmitInput`，对应 `builtin.application-submit-input.v1`，包含 `root`、`workItemId`、`stepId`、`attemptId`、`leaseToken` 和 `result`。输出：`AgentAction`。`submit` 没有 `actor` 字段；CLI 的 `--actor` 仅为适配层可选上下文，不能写入协议 JSON。`attemptId` 与 `leaseToken` 必须对应仍活动的租约。Agent 的失败结果只提交 `status: "failed"`、执行摘要、Artifact 等执行事实，不能提交 `failureCode` 或 `retryable`。默认 Executor 将普通失败归类为可重试的 `WSSPEC_STEP_FAILED`；失败分类只由受信 Executor 或 Runtime 内部产生并持久化，例如 `WSSPEC_STEP_INPUT_INVALID` 或 `WSSPEC_STEP_CONFIGURATION_INVALID`，Runtime 据此决定是否消耗重试预算。

### `decide`

输入：`DecisionInput`，对应 `builtin.application-decision-input.v1`。步骤审批需要 `workItemId`、`expectedDigest` 与 `actor`；Workflow 信任需要 Package/能力摘要与 `actor`。输出：`AgentAction`。Workflow 信任决定只接受真实交互式 TTY。

```json contract=schema:builtin.application-decision-input.v1
{
  "kind": "workflow_trust",
  "root": "/workspace/demo",
  "requestId": "trust-01",
  "decision": "trusted",
  "expectedPackageDigest": "sha256:package",
  "expectedCapabilityDigest": "sha256:capability",
  "actor": "maintainer"
}
```

### `inspect`

输入：`InspectInput`，对应 `builtin.application-inspect-input.v1`，包含 `root` 与 `workItemId`。输出：`WorkItemView`，含当前 `workItemId`、状态、`workflowRef` 和已选择的 Profile；它不创建新 Attempt。

## 2. 公开 Schema

所有对象拒绝未知字段，Schema 版本只接受当前 v1。`builtin.work-package.v1` 只传递执行引用和约束，不嵌入会话历史、模型或 Prompt 正文。

| Schema ID | 用途 |
|---|---|
| `builtin.agent-action.v1` | `execute`、`await_approval`、`blocked`、`completed` 四种下一步动作。 |
| `builtin.application-acquire-input.v1` | `acquire` 的 root、Work Item 和 actor。 |
| `builtin.application-decision-input.v1` | 步骤审批或 Workflow 信任决定。 |
| `builtin.application-inspect-input.v1` | `inspect` 的 root 与 Work Item。 |
| `builtin.application-project-config.v1` | `.wsspec` 的 Workflow、Profile、Gate 和全局 Skill 配置。 |
| `builtin.application-project-config-snapshot.v1` | Work Item 中可移植的配置快照；附加 Global 根只保留逻辑 ID。 |
| `builtin.application-start-input.v1` | 需求来源、可选 Workflow 和 Profile。 |
| `builtin.application-submit-input.v1` | Attempt、租约和 `builtin.submit-result.v1`。 |
| `builtin.artifact.v1` | 可版本化 Artifact 的身份、路径和摘要。 |
| `builtin.evidence.v1` | Gate 的可信 Evidence 记录。 |
| `builtin.external-binding.v1` | 将外部目标稳定身份绑定到当前发布 Step、Attempt、输入与预期内容摘要。 |
| `builtin.external-receipt.v1` | 绑定外部目标身份、发布内容摘要与回读结果的严格回执。 |
| `builtin.submit-result.v1` | Step 的状态、执行摘要、修改文件、Artifact、命令和风险。 |
| `builtin.tdd-trusted-evidence.v1` | 引擎执行 Red 或 Green Gate 后形成的单次可信 TDD Evidence。 |
| `builtin.tdd-cycle-evidence.v1` | 绑定同一命令、测试路径和 Red/Green Evidence 的完整 TDD Cycle。 |
| `builtin.tdd-node-test-report.v1` | 引擎注入的 `node:test` reporter 产生的受限结构化结果。 |
| `builtin.work-item.v1` | Work Item 身份、来源、绑定和快照执行信息。 |
| `builtin.work-package.v1` | Agent 执行所需的目标、Skill、约束、输出和 Gate。 |
| `builtin.workflow-selection.v1` | 当前启用 Workflow 与 Profile。 |

完整 `builtin.application-project-config.v1` 属于当前宿主，附加 Global 根必须同时提供稳定 `id` 与本机 `path`。Work Item 的 `snapshot/config.yaml` 改用 `builtin.application-project-config-snapshot.v1`，只持久化逻辑 `id`，恢复时再由当前宿主配置重绑定路径。

首版 trusted TDD runner 只支持当前 Node.js 的 `node:test`。项目必须在不可变配置快照中声明 `testing.pathRules`，并为 `quality.gates.test` 声明 `reporter: { type: node-test, version: 1 }`；引擎解析 `argv[0]` 的绝对可执行文件、绑定继承环境和可执行文件摘要，并注入受控 reporter 目标。`java`、`ruby`、`dotnet` 当前只提供测试路径识别规则，不表示对应 runner adapter 已实现；非 `node:test` runner fail closed 为 `WSSPEC_TDD_REPORTER_UNSUPPORTED`，不能由明文 TAP 输出或 Agent 报告升级为 trusted Evidence。

```yaml contract=schema:builtin.application-project-config-snapshot.v1
version: 1
skills:
  additionalGlobalRoots:
    - id: team-skills
```

## 3. 返回动作与错误

`acquire`、`submit` 和 `decide` 返回 `AgentAction`。`execute` 携带 Work Package；`await_approval` 携带审批摘要；`blocked` 必须给出可机器识别的问题；`completed` 只表示当前 Work Item 已结束，不代表真实外部平台验收已经完成。

```json contract=schema:builtin.agent-action.v1
{
  "action": "blocked",
  "problems": [
    { "code": "WSSPEC_WORKFLOW_TRUST_REQUIRED", "message": "需要明确确认 Workflow Package。", "retryable": false }
  ]
}
```

以下目录由 CLI 入口的生产依赖图与逐路由合同共同校验。分组用于减少重复；某 route 只透传它声明分组中的 typed error，其他异常进入固定 internal 兜底。

### 错误码分组

| 分组 | 公开错误码 |
|---|---|
| `internal` | `WSSPEC_INTERNAL_ERROR` |
| `dispatch` | `WSSPEC_COMMAND_UNKNOWN` |
| `arguments` | `WSSPEC_ARGUMENT_INVALID`、`WSSPEC_ARGUMENT_REQUIRED` |
| `repository` | `WSSPEC_GIT_REPOSITORY_REQUIRED`、`WSSPEC_REPOSITORY_ID_INVALID`、`WSSPEC_REPOSITORY_ID_MISMATCH`、`WSSPEC_REPOSITORY_NOT_INITIALIZED` |
| `schema` | `WSSPEC_SCHEMA_INVALID_VALUE`、`WSSPEC_SCHEMA_REQUIRED_FIELD`、`WSSPEC_SCHEMA_UNKNOWN_FIELD`、`WSSPEC_SCHEMA_UNSUPPORTED_VERSION` |
| `builtin` | `WSSPEC_BUILTIN_CATALOG_INVALID`、`WSSPEC_BUILTIN_PROFILE_ID_MISMATCH`、`WSSPEC_BUILTIN_PROFILE_WORKFLOW_MISMATCH`、`WSSPEC_BUILTIN_RESOURCE_PATH_ESCAPE`、`WSSPEC_BUILTIN_RESOURCE_PATH_INVALID`、`WSSPEC_BUILTIN_WORKFLOW_ID_MISMATCH` |
| `workflowPackage` | `WSSPEC_WORKFLOW_PACKAGE_BUILTIN_PROVENANCE_INVALID`、`WSSPEC_WORKFLOW_PACKAGE_FILE_INVALID`、`WSSPEC_WORKFLOW_PACKAGE_FILE_MISSING`、`WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID`、`WSSPEC_WORKFLOW_PACKAGE_LOCK_MISSING`、`WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID`、`WSSPEC_WORKFLOW_PACKAGE_MANIFEST_MISSING`、`WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND`、`WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE`、`WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID`、`WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID`、`WSSPEC_WORKFLOW_PACKAGE_PROFILE_MISSING`、`WSSPEC_WORKFLOW_PACKAGE_SKILL_MISSING`、`WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED`、`WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED`、`WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID`、`WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_MISSING` |
| `workflowTrust` | `WSSPEC_WORKFLOW_TRUST_ACTOR_INVALID`、`WSSPEC_WORKFLOW_TRUST_BUILTIN_MANAGED`、`WSSPEC_WORKFLOW_TRUST_CHANGED`、`WSSPEC_WORKFLOW_TRUST_CHANNEL_INVALID`、`WSSPEC_WORKFLOW_TRUST_DECISION_CONFLICT`、`WSSPEC_WORKFLOW_TRUST_JOURNAL_INVALID`、`WSSPEC_WORKFLOW_TRUST_LOCKED`、`WSSPEC_WORKFLOW_TRUST_RECORDED`、`WSSPEC_WORKFLOW_TRUST_REJECTED`、`WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID`、`WSSPEC_WORKFLOW_TRUST_REQUIRED`、`WSSPEC_WORKFLOW_TRUST_STALE_LOCK` |
| `skill` | `WSSPEC_GLOBAL_ROOT_NOT_CONFIGURED`、`WSSPEC_SKILL_AMBIGUOUS`、`WSSPEC_SKILL_CONTEXT_INVALID`、`WSSPEC_SKILL_FALLBACK_INVALID`、`WSSPEC_SKILL_LOCK_CHANGED`、`WSSPEC_SKILL_LOCK_INVALID`、`WSSPEC_SKILL_NOT_FOUND`、`WSSPEC_SKILL_PATH_ESCAPE`、`WSSPEC_SKILL_PATH_INVALID`、`WSSPEC_SKILL_REF_INVALID` |
| `projectConfig` | `WSSPEC_PROJECT_CONFIG_INVALID`、`WSSPEC_PROJECT_CONFIG_MISSING`、`WSSPEC_PROJECT_GATE_POLICY_INVALID` |
| `compiler` | `WSSPEC_CHANGE_POLICY_EXPANSION`、`WSSPEC_CHANGE_POLICY_OVERRIDE_FORBIDDEN`、`WSSPEC_CHANGE_POLICY_PATH_INVALID`、`WSSPEC_COMPILE_CONFIGURED_GATE_MISSING`、`WSSPEC_COMPILE_CYCLE`、`WSSPEC_COMPILE_DISABLED_OUTPUT_REQUIRED`、`WSSPEC_COMPILE_DOCUMENTATION_GATE_REQUIRED`、`WSSPEC_COMPILE_DOCUMENTATION_TDD_FORBIDDEN`、`WSSPEC_COMPILE_DUPLICATE_GATE`、`WSSPEC_COMPILE_DUPLICATE_STEP`、`WSSPEC_COMPILE_EXPRESSION_INVALID`、`WSSPEC_COMPILE_EXPRESSION_PROPERTY_UNKNOWN`、`WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNAVAILABLE`、`WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNKNOWN`、`WSSPEC_COMPILE_EXPRESSION_TYPE_MISMATCH`、`WSSPEC_COMPILE_GATE_POLICY_INVALID`、`WSSPEC_COMPILE_GATE_POLICY_UNKNOWN`、`WSSPEC_COMPILE_MANIFEST_CAPABILITY_MISSING`、`WSSPEC_COMPILE_MANIFEST_CONNECTOR_MISSING`、`WSSPEC_COMPILE_MANIFEST_SIDE_EFFECT_MISSING`、`WSSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER`、`WSSPEC_COMPILE_NESTED_LOOP_UNSUPPORTED`、`WSSPEC_COMPILE_OUTPUT_NOT_GUARANTEED`、`WSSPEC_COMPILE_PLAN_REQUIRED`、`WSSPEC_COMPILE_PROFILE_ARTIFACT_UNKNOWN`、`WSSPEC_COMPILE_PROFILE_MISMATCH`、`WSSPEC_COMPILE_PROFILE_NOT_FOUND`、`WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN`、`WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE`、`WSSPEC_COMPILE_PROFILE_STEP_UNKNOWN`、`WSSPEC_COMPILE_QUICK_PROFILE_INVALID`、`WSSPEC_COMPILE_REQUIRED_GATE_MISSING`、`WSSPEC_COMPILE_REQUIRED_SKILL_MISSING`、`WSSPEC_COMPILE_SECURITY_OVERRIDE`、`WSSPEC_COMPILE_SKILL_AMBIGUOUS`、`WSSPEC_COMPILE_SKILL_MISMATCH`、`WSSPEC_COMPILE_SKILL_POLICY_OVERRIDE`、`WSSPEC_COMPILE_STEP_INVALID`、`WSSPEC_COMPILE_TDD_REQUIRED`、`WSSPEC_COMPILE_UNKNOWN_DEPENDENCY`、`WSSPEC_COMPILE_UNKNOWN_GATE` |
| `expression` | `WSSPEC_EXPRESSION_FORBIDDEN`、`WSSPEC_EXPRESSION_INVALID`、`WSSPEC_EXPRESSION_LIMIT_EXCEEDED`、`WSSPEC_EXPRESSION_TYPE_INVALID` |
| `executor` | `WSSPEC_EXECUTOR_ACTION_NOT_FOUND`、`WSSPEC_EXECUTOR_CONTEXT_INVALID`、`WSSPEC_EXECUTOR_DUPLICATE`、`WSSPEC_EXECUTOR_NOT_FOUND`、`WSSPEC_EXECUTOR_SECURITY_MISMATCH` |
| `source` | `WSSPEC_SOURCE_EMPTY`、`WSSPEC_SOURCE_PATH_INVALID`、`WSSPEC_SOURCE_SNAPSHOT_CHANGED`、`WSSPEC_SOURCE_SNAPSHOT_INVALID`、`WSSPEC_SOURCE_TYPE_UNSUPPORTED` |
| `snapshot` | `WSSPEC_APPLICATION_ANCHOR_INVALID`、`WSSPEC_APPLICATION_SNAPSHOT_CHANGED`、`WSSPEC_APPLICATION_SNAPSHOT_INVALID`、`WSSPEC_CONFIG_SNAPSHOT_CHANGED`、`WSSPEC_SCHEMA_SNAPSHOT_CHANGED`、`WSSPEC_SKILL_SNAPSHOT_CHANGED`、`WSSPEC_WORKFLOW_SNAPSHOT_CHANGED`、`WSSPEC_WORK_ITEM_MANIFEST_CHANGED` |
| `workItem` | `WSSPEC_CONTROL_PLANE_INVALID`、`WSSPEC_WORK_ITEM_ID_CONFLICT`、`WSSPEC_WORK_ITEM_INVALID`、`WSSPEC_WORK_ITEM_LOCATION_INVALID`、`WSSPEC_WORK_ITEM_NOT_FOUND`、`WSSPEC_WORK_ITEM_ROLLBACK_FAILED`、`WSSPEC_WORK_ITEM_ROLLBACK_REFUSED` |
| `runtime` | `WSSPEC_CONTROL_PLANE_LOCKED`、`WSSPEC_CONTROL_PLANE_READ_ONLY`、`WSSPEC_CONTROL_PLANE_STALE_LOCK`、`WSSPEC_EVENT_CHAIN_INVALID`、`WSSPEC_EVENT_INVALID`、`WSSPEC_IDEMPOTENCY_CONFLICT`、`WSSPEC_INDEPENDENT_REVIEW_REQUIRED`、`WSSPEC_PROFILE_DECISION_STALE`、`WSSPEC_PROFILE_DOWNGRADE_FORBIDDEN`、`WSSPEC_PROJECTION_WRITE_FAILED`、`WSSPEC_RISK_RULE_INVALID`、`WSSPEC_RISK_WORKFLOW_INVALID`、`WSSPEC_LOOP_PROJECTION_INVALID`、`WSSPEC_RETRY_PROJECTION_INVALID`、`WSSPEC_STAGE_NOT_FOUND`、`WSSPEC_STATE_TRANSITION_FORBIDDEN` |
| `close` | `WSSPEC_CLOSE_CHECKLIST_INCOMPLETE` |
| `evidenceIngestion` | `WSSPEC_EVIDENCE_ATTEMPT_MISMATCH`、`WSSPEC_EVIDENCE_HASH_MISMATCH`、`WSSPEC_EVIDENCE_INVALID`、`WSSPEC_EVIDENCE_LEVEL_INSUFFICIENT`、`WSSPEC_EVIDENCE_STALE`、`WSSPEC_GATE_NOT_REQUIRED` |
| `tdd` | `WSSPEC_TDD_EVIDENCE_INVALIDATED`、`WSSPEC_TDD_GATE_CONFIGURATION_INVALID`、`WSSPEC_TDD_GATE_EXECUTION_FAILED`、`WSSPEC_TDD_GREEN_NOT_OBSERVED`、`WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE`、`WSSPEC_TDD_RED_NOT_OBSERVED`、`WSSPEC_TDD_RED_REQUIRED`、`WSSPEC_TDD_RED_SCOPE_INVALID`、`WSSPEC_TDD_RED_SYNTAX_FAILURE`、`WSSPEC_TDD_RED_TIMEOUT`、`WSSPEC_TDD_REPORT_INVALID`、`WSSPEC_TDD_REPORTER_UNSUPPORTED`、`WSSPEC_TDD_STEP_INVALID`、`WSSPEC_TDD_TEST_PATH_INVALID` |
| `start` | `WSSPEC_START_ROLLBACK_FAILED` |
| `acquire` | `WSSPEC_LOOP_CONFIGURATION_INVALID`、`WSSPEC_LOOP_MAX_ITERATIONS_REACHED`、`WSSPEC_REQUIRED_INPUT_ARTIFACT_MISSING`、`WSSPEC_STAGE_ALREADY_CLAIMED`、`WSSPEC_STEP_RETRY_EXHAUSTED`、`WSSPEC_WORKFLOW_BLOCKED` |
| `artifact` | `WSSPEC_ARTIFACT_ENCODING_INVALID`、`WSSPEC_ARTIFACT_HASH_MISMATCH`、`WSSPEC_ARTIFACT_INCOMPLETE`、`WSSPEC_ARTIFACT_SCHEMA_MISMATCH`、`WSSPEC_ARTIFACT_SCHEMA_NOT_FOUND`、`WSSPEC_LOOP_ARTIFACT_INVALID` |
| `submit` | `WSSPEC_ARTIFACT_REFERENCE_INVALID`、`WSSPEC_ATTEMPT_NOT_ACTIVE`、`WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`、`WSSPEC_LOOP_STEP_APPROVAL_UNSUPPORTED`、`WSSPEC_MODIFIED_FILES_MISMATCH`、`WSSPEC_REQUIRED_ARTIFACT_MISSING`、`WSSPEC_STEP_CONFIGURATION_INVALID`、`WSSPEC_STEP_FAILED`、`WSSPEC_STEP_FAILURE_CLASSIFICATION_INVALID`、`WSSPEC_STEP_INPUT_INVALID`、`WSSPEC_UNDECLARED_ARTIFACT` |
| `approval` | `WSSPEC_APPROVAL_DIGEST_MISMATCH`、`WSSPEC_APPROVAL_EXPIRED`、`WSSPEC_APPROVAL_NOT_EXPIRED`、`WSSPEC_APPROVAL_NOT_PENDING`、`WSSPEC_APPROVAL_NOT_READY`、`WSSPEC_INTERACTIVE_TTY_REQUIRED` |
| `workflowEject` | `WSSPEC_WORKFLOW_EJECT_SOURCE_INVALID`、`WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS` |
| `agentInstall` | `WSSPEC_SKILL_INSTALL_CONFLICT` |

### CLI 路由错误合同

| Route | 错误分组 |
|---|---|
| `dispatch` | `internal`、`dispatch` |
| `workflow` | `internal`、`dispatch` |
| `agent` | `internal`、`dispatch` |
| `init` | `internal`、`arguments`、`repository` |
| `start` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`workflowTrust`、`skill`、`projectConfig`、`compiler`、`executor`、`source`、`workItem`、`runtime`、`start` |
| `acquire` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`expression`、`acquire`、`close`、`tdd` |
| `submit` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`acquire`、`artifact`、`submit`、`approval`、`tdd` |
| `decide` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`acquire`、`artifact`、`submit`、`approval`、`workflowPackage`、`workflowTrust` |
| `inspect` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem` |
| `workflow list` | `internal`、`arguments`、`builtin` |
| `workflow show` | `internal`、`arguments`、`builtin`、`workflowPackage` |
| `workflow eject` | `internal`、`arguments`、`builtin`、`workflowPackage`、`workflowEject` |
| `workflow validate` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`skill`、`projectConfig`、`compiler`、`executor` |
| `workflow use` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`skill`、`projectConfig`、`compiler`、`executor`、`workflowTrust` |
| `agent install` | `internal`、`arguments`、`agentInstall` |

`WSSPEC_INTERNAL_ERROR` 是 CLI 对未建模失败的公开兜底 code，不是允许透传原始内部消息的业务错误。无论异常显式携带该 code，还是来自未知 `WSSPEC_` code、普通 Error、非 Error 抛出值或 JSON parser 等底层组件，CLI 都只返回固定消息 `发生未预期的内部错误。`。其他已注册 public code 保留其中文消息。此规则只约束 CLI 输出适配层，不改变 Application 直接 API 的异常类型、code 或 message。

错误对象不应回显凭据、完整外部响应或未授权读取的 Artifact 正文。
