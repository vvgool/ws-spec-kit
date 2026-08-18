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

输入：`SubmitInput`，对应 `builtin.application-submit-input.v1`，包含 `root`、`workItemId`、`stepId`、`attemptId`、`leaseToken` 和 `result`。输出：`AgentAction`。`submit` 没有 `actor` 字段；CLI 的 `--actor` 仅为适配层可选上下文，不能写入协议 JSON。`attemptId` 与 `leaseToken` 必须对应仍活动的租约。

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
| `builtin.application-start-input.v1` | 需求来源、可选 Workflow 和 Profile。 |
| `builtin.application-submit-input.v1` | Attempt、租约和 `builtin.submit-result.v1`。 |
| `builtin.artifact.v1` | 可版本化 Artifact 的身份、路径和摘要。 |
| `builtin.evidence.v1` | Gate 的可信 Evidence 记录。 |
| `builtin.submit-result.v1` | Step 的状态、修改文件、Artifact、命令和风险。 |
| `builtin.work-item.v1` | Work Item 身份、来源、绑定和快照执行信息。 |
| `builtin.work-package.v1` | Agent 执行所需的目标、Skill、约束、输出和 Gate。 |
| `builtin.workflow-selection.v1` | 当前启用 Workflow 与 Profile。 |

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

以下错误码由当前 CLI、Application 操作和 Schema 公开边界产生或透传：

- `WSSPEC_APPROVAL_EXPIRED`、`WSSPEC_APPROVAL_NOT_PENDING`、`WSSPEC_ARGUMENT_INVALID`、`WSSPEC_ARGUMENT_REQUIRED`
- `WSSPEC_ARTIFACT_REFERENCE_INVALID`、`WSSPEC_ATTEMPT_NOT_ACTIVE`、`WSSPEC_COMMAND_UNKNOWN`、`WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`
- `WSSPEC_INTERACTIVE_TTY_REQUIRED`、`WSSPEC_INTERNAL_ERROR`、`WSSPEC_MODIFIED_FILES_MISMATCH`、`WSSPEC_PROJECT_CONFIG_MISSING`、`WSSPEC_PROJECT_GATE_POLICY_INVALID`
- `WSSPEC_REQUIRED_ARTIFACT_MISSING`、`WSSPEC_SCHEMA_INVALID_VALUE`、`WSSPEC_SCHEMA_REQUIRED_FIELD`、`WSSPEC_SCHEMA_UNKNOWN_FIELD`、`WSSPEC_SCHEMA_UNSUPPORTED_VERSION`
- `WSSPEC_SOURCE_TYPE_UNSUPPORTED`、`WSSPEC_STAGE_ALREADY_CLAIMED`、`WSSPEC_STAGE_NOT_FOUND`、`WSSPEC_START_ROLLBACK_FAILED`、`WSSPEC_STEP_FAILED`、`WSSPEC_STEP_RETRY_EXHAUSTED`
- `WSSPEC_UNDECLARED_ARTIFACT`、`WSSPEC_WORKFLOW_BLOCKED`、`WSSPEC_WORKFLOW_TRUST_RECORDED`、`WSSPEC_WORKFLOW_TRUST_REJECTED`、`WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID`、`WSSPEC_WORKFLOW_TRUST_REQUIRED`

错误对象不应回显凭据、完整外部响应或未授权读取的 Artifact 正文。
