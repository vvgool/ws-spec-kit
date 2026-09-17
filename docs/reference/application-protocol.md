# Application Protocol 参考

本文是 `wspec` 的公开 Application Protocol 真源。面向用户的解释使用中文；字段名、Schema ID、URI、命令名和错误码保持英文。客户端只通过稳定 JSON 调用 Application，不直接修改控制面。

## 1. 命令与操作

| CLI 命令 | Application 操作 | 输入 Schema | 说明 |
|---|---|---|---|
| `init` | repository initialization | 无 | 初始化当前 Git 仓库的 `.wsspec` 配置。 |
| `start` | `start` | `builtin.application-start-input.v1` | 从 Prompt 或仓库内文件创建 Work Item，冻结编译后的 Workflow、Skill Lock、配置和来源，不复制 Workflow 或 Skill 正文。 |
| `acquire` | `acquire` | `builtin.application-acquire-input.v1` | 取得下一可执行 Step 的 `AgentAction`。 |
| `artifact create` | Attempt 作用域辅助能力 | `builtin.application-artifact-create-input.v1` | 把活动 Work Package 授权的 draft 规范化为不可变 `ArtifactRef`；不属于五个 Application 生命周期操作。 |
| `submit` | `submit` | `builtin.application-submit-input.v1` | 提交本次 Attempt 的结果、Artifact 和 Evidence 引用。 |
| `decide` | `decide` | `builtin.application-decision-input.v2` | 对步骤审批、外部动作授权或 Workflow 信任作出明确决定，签发拒绝确认凭据，或触发只读外部协调回查。 |
| `inspect` | `inspect` | `builtin.application-inspect-input.v1` | 读取已快照的 Work Item 状态，不创建新 Attempt。 |
| `workflow` | workflow management | 无 | 支持 `list`、`show`、`validate`、`eject`、`use`。 |
| `agent install` | Driver installation | 无 | 安装 `codex`、`claude`、`cursor` 或 `generic` Driver Skill。 |
| `doctor connectors` | Connector Doctor | 无 | 分别诊断 `git`、`gh`、`glab` 与 `lark-cli`，不执行外部写入。 |

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

`execute.workPackage.workspace` 明确声明当前 Attempt 的执行边界：`read-only` 表示使用调用方当前 checkout，禁止仓库修改和持久化副作用；`isolated-worktree` 表示使用 Work Item 的隔离 Worktree。客户端不得根据 Step 名称、Actor 或意图推断或升级 workspace 模式。

若不存在活动 Claim，`acquire` 原子选择下一 Step 并创建 Attempt。若存在未过期 Claim，同一 `actor` 可用于
fresh-session 恢复：Runtime 在控制面锁内保留 Stage、Attempt 和 Work Package 身份，轮换 Lease token、
`claimedAt` 与到期时间，记录绑定前后 token digest 的 `attempt.reacquired`，并返回新的 `execute`；旧 token
随即失效。不同 actor 返回 `WSSPEC_STAGE_ALREADY_CLAIMED`。活动 Claim 与当前 Stage、Attempt、Context、
Work Package、允许路径或 workspace snapshot 任一绑定不一致时返回 `WSSPEC_ACTIVE_CLAIM_INVALID`，不得修补
或继续执行。该完整绑定在 actor 分支之前执行，并以事件链中最后一个可信投影为权威；Work Package 的
Skill、Artifact、约束、输出、Gate 与 result schema 都不能由恢复请求修改。`submit.execute` 已携带下一份已
claim 的 Work Package，同一会话必须直接消费；无故再次
`acquire` 会轮换 Lease 并使刚返回的 token 失效。

### `artifact create`（Attempt 作用域辅助能力）

`WSSpecApplication` 只暴露 `start`、`acquire`、`submit`、`decide` 与 `inspect` 五个生命周期操作。Artifact authoring 绑定当前 Claim、Attempt 与 Lease，由 CLI 的 `artifact create` 直接调用 Attempt 作用域服务，不推进 Workflow，也不将正文或 draft 路径交给 `submit`。

输入：`ArtifactCreateInput`，对应 `builtin.application-artifact-create-input.v1`，包含 `root`、`workItemId`、`stepId`、`attemptId`、`leaseToken`、`artifactType`、可选 `outputId` 和 `contentFile`。输出：`ArtifactReference`。CLI 使用 `wspec artifact create --work-item "<workItemId>" --step "<stepId>" --attempt "<attemptId>" --lease-token "<leaseToken>" --artifact-type "<artifactType>" [--output "<outputId>"] --content-file "<draftPath>"`；stdout 只返回统一 JSON envelope 中的 `ArtifactRef`，不返回正文、draft path、绝对路径或 Lease token。

```json contract=schema:builtin.application-artifact-create-input.v1
{
  "root": "/workspace/demo",
  "workItemId": "WSS-01H00000000000000000000000",
  "stepId": "explore",
  "attemptId": "attempt-01",
  "leaseToken": "lease-01",
  "artifactType": "exploration-report",
  "outputId": "exploration-report",
  "contentFile": ".acceptance/exploration-report.md"
}
```

只有活动 Claim、Attempt、未过期 Lease 和完整 Work Package digest 全部精确匹配时才能 author。`artifactAuthoring.version` 必须为 `1`；正文上限来自 `maxContentBytes`，draft 只允许位于 `draftRoots`。`.acceptance/` 下文件还必须被 Git ignore；Work Item 自有 drafts 根无需依赖仓库 ignore。`contentFile` 必须是 canonical NFC 仓库相对 POSIX 路径，任一组件不得是 symlink，末端必须是单链接普通文件。Runtime 以 `O_NOFOLLOW` 打开并在初读、控制面锁内复读及写入前后绑定 device、inode、size、mtime、ctime、link count 与 digest；变化时 fail closed。

`artifactType`、`outputId` 和 `schemaVersion` 必须匹配 `requiredOutputs`。同一 `artifactType` 对应多个输出时必须显式传 `outputId`；若输出声明了 `contentLevel`，该策略同时进入幂等身份、`artifact.authored` 摘要和返回的 `ArtifactRef`，`submit` 不接受被剥离或改写的值。正文按 Artifact 类型既有内容合同校验并规范化，随后写入 `.wsspec/work-items/<workItemId>/artifacts/<artifactType>/<contentHash>.md`。内容寻址文件不可变：并发命中既有路径时只能接受逐字节相同内容。`artifact.authored` 事件仅保存 Artifact 摘要身份，不保存正文、draft path、绝对路径或 Lease token；replay 将其作为不复制完整 projection 的幂等事件处理。

### `submit`

输入：`SubmitInput`，对应 `builtin.application-submit-input.v1`，包含 `root`、`workItemId`、`stepId`、`attemptId`、`leaseToken` 和 `result`。输出：`AgentAction`。`submit` 没有 `actor` 字段；CLI 的 `--actor` 仅为适配层可选上下文，不能写入协议 JSON。`attemptId` 与 `leaseToken` 必须对应仍活动的租约。Agent 的失败结果只提交 `status: "failed"`、执行摘要、Artifact 等执行事实，不能提交 `failureCode` 或 `retryable`。默认 Executor 将普通失败归类为可重试的 `WSSPEC_STEP_FAILED`；失败分类只由受信 Executor 或 Runtime 内部产生并持久化，例如 `WSSPEC_STEP_INPUT_INVALID` 或 `WSSPEC_STEP_CONFIGURATION_INVALID`，Runtime 据此决定是否消耗重试预算。

Artifact 正文先写入 Work Package 授权的 draft，再通过 `artifact create` 得到 `ArtifactRef`；`result.artifacts` 只提交这些引用，`result` JSON 不得包含 `contentFile` 或正文。完成状态必须逐项满足 `requiredOutputs` 的 `artifactType`、`outputId` 与 `schemaVersion`，不能用相同类型的另一个 output 冒充必需输出。

`external-write` Step，以及 `action: git.commit` 的 `local-write` Step，成功时必须精确提交一个受治理的 `external-action` 意图，包含 Provider、动作、稳定目标、payload 和副作用说明。第一次 `submit` 只持久化 `builtin.external-action-request.v1` 的摘要身份并返回 `await_approval`，不会调用 Provider。批准后重复提交同一 Attempt 才可执行；Runtime 以原子 owner 保证同一 Request 只有一个协调者调用 Provider，并在 Provider 调用前持久化 `executing/not_sent`。Executor 必须在发送边界调用 `markDispatched()` 持久化 `sent_or_unknown`。其他并发提交返回可重试的 `WSSPEC_EXTERNAL_EXECUTION_IN_PROGRESS`。发送后结果未知时进入 `reconciliation_required`，只允许只读回查，不自动重发。Provider 执行或回查异常只返回固定的 `WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED` 或 `WSSPEC_EXTERNAL_PROVIDER_RECONCILIATION_FAILED`，不回显 Provider 文本。确认成功后 Agent 的原始意图由严格的 `builtin.external-write-receipt.v1` 替换，事件、投影和公开视图不持久化 payload 或凭据。`issue.close` 还要求 `issue.update` 已验证，且 Knowledge 按 Profile 已验证、明确 absent/skipped，或已持久化 optional warning；否则以 `WSSPEC_EXTERNAL_ORDER_INVALID` fail closed。除上述 `external-write` 与本地 `git.commit` 外，其他 Step 禁止携带 `externalWrites`。

#### 受治理外部动作操作流程

外部写入固定遵循以下顺序，且只使用既有的五个生命周期操作 `start`、`acquire`、`submit`、`decide`、`inspect`。以下示例的 ID、摘要和租约均为占位符。

1. Agent 取得 `execute` 后，首次以完整结果调用 `wspec submit`。结果中的 `externalWrites` 是受治理意图，首次提交只创建 Request 并返回 `await_approval`，不会写入 Provider。
2. 人类以现有的 `wspec decide --input --actor` 提交 `external_action` 决定。Decision JSON 故意不包含 `root` 与 `actor`，因为 CLI 分别从当前仓库绑定 `root`，并从 `--actor` 绑定 actor。
3. 仅当决定批准后，Agent 才以**同一份、未修改的**结果再次调用 `wspec submit`。第二次提交才执行既有的受治理 Connector，并生成或核验回执。批准本身不调用 Provider，也不执行写入。
4. 用 `wspec inspect` 查看 Work Item 与外部动作状态。它只读取快照状态，不创建 Attempt，也不推进或重发外部动作。

首次与第二次提交使用同一个输入文件，避免重建、删减或改写结果：

`wspec submit` 的 `--result` 文件只承载 `builtin.submit-result.v1`。`root`、Work Item、Step、Attempt 和 Lease 由 CLI 参数绑定，因此不写入该文件。

```json contract=schema:builtin.submit-result.v1
{
  "version": 1,
  "status": "completed",
  "summary": "已准备更新 Issue 的受治理结果。",
  "modifiedFiles": [],
  "artifacts": [],
  "commands": [],
  "evidence": [],
  "externalWrites": [
    {
      "kind": "external-action",
      "provider": "gitlab",
      "action": "issue.update",
      "target": { "kind": "issue", "stableId": "gitlab:group/project#42" },
      "payload": { "target": { "host": "gitlab.example.com", "projectPath": "group/project", "iid": 42 }, "action": { "type": "body", "body": "已完成受治理更新。" } },
      "sideEffects": ["更新 Issue 正文"]
    }
  ],
  "remainingRisks": []
}
```

```sh
# 第一次提交，只建立外部动作 Request，预期返回 await_approval。
wspec submit WSS-01H00000000000000000000000 --step issue-update --attempt attempt-01 --lease lease-01 --result .acceptance/submit-result.json

# 人类批准。root 由当前仓库绑定，actor 由 --actor 绑定，二者不写入 decision.json。
wspec decide --input .acceptance/external-action-decision.json --actor maintainer

# 仅在批准后，提交完全相同、未经修改的结果，才进入既有 Connector 执行路径。
wspec submit WSS-01H00000000000000000000000 --step issue-update --attempt attempt-01 --lease lease-01 --result .acceptance/submit-result.json

# 只读检查状态，不会创建 Attempt 或重发写入。
wspec inspect WSS-01H00000000000000000000000
```

以下是 `wspec decide --input` 的 CLI 决定文件。它故意不是完整的 `builtin.application-decision-input.v1`：CLI 在调用 Application 前补入当前仓库的 `root` 与 `--actor` 的 actor。

```json contract=cli-bound-partial-decision-input
{
  "kind": "external_action",
  "workItemId": "WSS-01H00000000000000000000000",
  "requestId": "external-request-0000000000000000000000000000000000000000000000000000000000000000",
  "decision": "approved",
  "expectedDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

若发送后的结果未知，先用 `wspec inspect` 确认状态。只有状态为 `reconciliation_required` 时，才可通过现有 `decide` 的 `external_reconciliation` 和 `reconcile` 进行 Provider 只读回查。回查 verified 后，使用决定返回的原 Attempt 和原样未改的 SubmitResult 完成 Application 提交；Runtime 直接消费已持久化回执，绝不重发 Provider 写入。`reconciliation_required` 状态本身不是再次 `submit` 的条件，回查尚未 verified 时任何自动重提或重发均被禁止。

以下恢复决定同样是 CLI 决定文件，`root` 与 `actor` 仍由 CLI 绑定。

```json contract=cli-bound-partial-decision-input
{
  "kind": "external_reconciliation",
  "workItemId": "WSS-01H00000000000000000000000",
  "requestId": "external-request-0000000000000000000000000000000000000000000000000000000000000000",
  "decision": "reconcile",
  "expectedDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

```sh
# 仅在 inspect 显示 reconciliation_required 后执行。该操作只读回查，不写入 Provider。
wspec decide --input .acceptance/external-reconciliation.json --actor maintainer

# 仅在回查 verified 后，使用决定返回的同一 Attempt 重新提交原样未改的结果；不会重发 Provider。
wspec submit WSS-01H00000000000000000000000 --step issue-update --attempt attempt-01 --lease lease-01 --result .acceptance/submit-result.json
```

本地 `git.commit` 使用临时 index 构造并回读批准提交，不改写用户真实 index。HEAD 成功前移后，真实 index
仍可能相对旧 HEAD 使批准文件显示为 `MM`；这是保持 index identity 的预期权衡，不代表 verified commit
缺失。Runtime、Driver 和验收不得自动 refresh/reset 该 index，而应绑定单父 commit、批准的规范 diff digest
与 verified Receipt，并从 commit tree 的 clean checkout 验证行为。验收还必须在运行前签入真实 index 的
path、digest、device、inode、mode、uid、size 和组合 identity，并在运行后逐项保持一致。

### `decide`

输入：`DecisionInput`，对应 `builtin.application-decision-input.v2`。步骤审批和 `external_action` 决定需要 `workItemId`、`expectedDigest` 与 `actor`；步骤审批的 `rejected` 决定还可携带有界 `feedback`。Workflow 信任需要 Package/能力摘要与 `actor`；`external_reconciliation` 需要 `workItemId`、`requestId`、`expectedDigest` 与 `actor`。输出：`AgentAction`。普通步骤批准支持 TTY 或下述对话确认；未携带对话确认的步骤批准、无反馈拒绝、Workflow 信任与外部动作决定仍要求真实交互式 TTY。非 TTY Host 提交带 `feedback` 的步骤拒绝前，必须先由 WSSpecKit 本地真实 TTY 以 `confirm_rejection` 签发一次性 `rejectionToken`；TTY 直接拒绝不得携带该 token。该凭据绑定 `requestId`、`expectedDigest`、`actor` 和规范化 feedback digest，控制面只保存 token digest。跨请求、跨 actor、跨 feedback 或重复消费均 fail closed；同一完整决定的幂等重试返回首次决定产生的同一 AgentAction。`feedback` 先规范化换行并去除首尾空白，再按 8192 UTF-8 字节上限检查，同时拒绝 unpaired surrogate、私钥、AWS access key、JWT、密码连接串和通用凭据样式文本；普通自然语言中的 `%` 不按 URI 编码解析。拒绝后返回的 `builtin.work-package.v2` 通过必填的 `revisionRequest` 携带审批请求身份和修改意见，但不能扩大 `allowedPaths`、解除 `forbiddenActions` 或改变审批权限。审批决定与下一 Work Package 在同一控制面事务内提交，重复或并发决定不会旋转首次返回的 Lease。外部动作批准恢复原 Attempt 时，v1 `execute` 明确携带 `resumeSubmission: true`；该标记禁止与修订 v2 Work Package 组合，其他步骤批准、拒绝修订和审批过期替换均重新 author Artifact。外部批准形成与当前 Request、Attempt、actor、Profile、workspace 和 config 摘要绑定的 `builtin.external-action-grant.v1`；拒绝决定持久化与 Request 摘要绑定的证据，后续 `acquire` 继续 fail closed。`external_reconciliation` 精确支持三种决定：`reconcile` 仅调用对应 Provider 的只读回查，不要求交互式 TTY；`mark_failed` 由真实交互式 TTY 提交审计证据，将未知结果标记为失败；`adopt_verified` 由真实交互式 TTY 提交外部稳定 ID、内容摘要和审计证据，并且仍须通过 Provider 的权威只读回查后才能采纳 verified Receipt。自动回查先在短事务中认领带期限的持久化 owner，释放控制面锁后调用 Provider，再在短事务中按 owner、Request、Attempt 和完成时 Lease 做 CAS 提交；并发调用共享同一回查，过期 owner 可由后续调用接管。三者都不批准或重发写入；Runtime 会先恢复并绑定原 Attempt，verified 后返回 `resumeSubmission: true`，由 Host 原样重提 SubmitResult 以消费持久化 Receipt。

```json contract=schema:builtin.application-decision-input.v2
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

#### 审批工作区与过期恢复

新建普通步骤审批记录 `workspaceDigestVersion: 2`，仅在审批工作区摘要中排除当前 Work Item 的 `.wsspec/work-items/<workItemId>/drafts/` 子文件。协议草稿用于传递 Artifact 正文、结果和审批输入，不能因创建决定 JSON 就使该决定过期。一般工作区摘要、其他 Work Item 草稿、业务文件和配置的检查保持不变；正式 Artifact 仍按其引用、生产者身份和内容摘要独立验证。

旧审批没有版本字段，继续使用旧摘要算法，不自动重算或追认。它可能在升级后因已有草稿变化失效一次，随后重新提交产物创建 v2 审批即可恢复。

工作区真正变化时，`decide` 将旧审批标记为 expired 并重置该步骤，返回 `blocked`，问题码为 `WSSPEC_APPROVAL_EXPIRED` 且 `retryable: true`，明确告知“本次批准未生效”。此分支不自动领取新 Attempt。Driver 展示原因后执行 `inspect -> acquire`，按新 Work Package 重新 author / submit 并请求新确认，不重复决定旧请求或复用旧结果。`ok: true` 仅表示命令返回了有效 AgentAction，不能单独作为批准成功证据。

#### 普通步骤的对话批准

用户明确同意当前审批版本后，Host 可直接提交以下决定，无需另开终端。`confirmation` 仅允许出现在 `kind: approval` 的 `approved` 决定中；`external_action`、Workflow 信任和外部恢复不接受该字段。

```json contract=schema:builtin.application-decision-input.v2
{
  "kind": "approval",
  "root": "/workspace/demo",
  "workItemId": "WSS-20260817-001",
  "requestId": "approval-01",
  "decision": "approved",
  "expectedDigest": "sha256:current-approval",
  "actor": "codex",
  "confirmation": {
    "source": "conversation",
    "userMessage": "可以，按这个方案做。"
  }
}
```

CLI 仍使用 `wspec decide --input <decisionPath> --actor <agent>`。`requestId` 和 `expectedDigest` 必须取自当前 `await_approval`；示例中的身份和摘要不能直接复用。引擎继续检查 Artifact、工作区及审批版本，并将决定与下一 Work Package 原子提交。相同确认的重试返回同一结果；不同确认或 actor 不能覆盖已有决定。

审计记录保留 `decisionSource: agent_transcribed`、`confirmation`、代执行 Agent 的 `decidedBy`、时间和原审批绑定。`userMessage` 只保存当前确认原话，规范化换行与首尾空白，上限 8192 UTF-8 字节，沿用 feedback 的编码及凭据文本校验；不合法时返回 `WSSPEC_APPROVAL_CONFIRMATION_INVALID`。它是 Host 转录声明，不是签名凭证或独立身份验证。TTY 决定标为 `terminal`，经 TTY token 的拒绝标为 `terminal_token`；旧记录允许没有来源字段。

Driver 在用户确认前说明审批方式，对当前版本已明确批准则直接记录并继续；版本发生变化须重新展示，不能把旧确认用于新版本。仅 `execute.resumeSubmission: true` 可以原样重提，其他返回的 Work Package 必须重新执行。

现有 v2 决定兼容不带 `confirmation` 的输入，v1 Schema 保持不变。Driver 当前为 v11；已安装的 v9/v10 不会自动改变。当前安全安装器拒绝原地覆盖旧 Driver，升级时先备份并移走旧 `SKILL.md`，再使用新版 CLI 执行对应的 `wspec agent install`，让 Host 重新加载 Skill。

### `inspect`

输入：`InspectInput`，对应 `builtin.application-inspect-input.v1`，包含 `root` 与 `workItemId`。输出：`WorkItemView`，含当前 `workItemId`、状态、`workflowRef` 和已选择的 Profile；它不创建新 Attempt。

## 2. 公开 Schema

所有对象拒绝未知字段。旧 v1 Schema 保持原有严格含义；普通执行继续返回 `builtin.work-package.v1`，只有携带 `revisionRequest` 的修订执行使用 `builtin.work-package.v2`。AgentAction v2 可封装两种 Work Package，审批 feedback、拒绝确认凭据、修订 Work Package 和明确恢复提交信号只由 v2 Schema 承载。两种 Work Package 都只传递执行引用和约束，不嵌入会话历史、模型或 Prompt 正文。

| Schema ID | 用途 |
|---|---|
| `builtin.agent-action.v1` | `execute`、`await_approval`、`blocked`、`completed` 四种下一步动作。 |
| `builtin.agent-action.v2` | 在 v1 动作基础上支持 `rejection_confirmed`，并允许 `execute.resumeSubmission: true`。 |
| `builtin.application-acquire-input.v1` | `acquire` 的 root、Work Item 和 actor。 |
| `builtin.application-artifact-create-input.v1` | `artifact` authoring 的 Work Item、Attempt、Lease、输出身份与 draft 路径。 |
| `builtin.application-decision-input.v1` | 步骤审批、外部动作授权、Workflow 信任决定或只读外部协调回查。 |
| `builtin.application-decision-input.v2` | 在 v1 决定基础上支持 feedback、`confirm_rejection` 与一次性 `rejectionToken`。 |
| `builtin.application-inspect-input.v1` | `inspect` 的 root 与 Work Item。 |
| `builtin.application-project-config.v1` | `.wsspec` 的 Workflow、Profile、Gate 和全局 Skill 配置。 |
| `builtin.application-project-config-snapshot.v1` | Work Item 中可移植的配置快照；附加 Global 根只保留逻辑 ID。 |
| `builtin.application-start-input.v1` | 需求来源、可选 Workflow 和 Profile。 |
| `builtin.application-submit-input.v1` | Attempt、租约和 `builtin.submit-result.v1`。 |
| `builtin.artifact.v1` | 可版本化 Artifact 的身份、路径和摘要。 |
| `builtin.evidence.v1` | Gate 的可信 Evidence 记录。 |
| `builtin.external-action-grant.v1` | 将交互式批准绑定到外部 Request、actor、Attempt、Profile、workspace 与 config。 |
| `builtin.external-action-request.v1` | 外部写入的 payload-free 身份、摘要、稳定目标、幂等键和有效期。 |
| `builtin.external-binding.v1` | 将外部目标稳定身份绑定到当前发布 Step、Attempt、输入与预期内容摘要。 |
| `builtin.external-receipt.v1` | 绑定外部目标身份、发布内容摘要与回读结果的严格回执。 |
| `builtin.external-write-receipt.v1` | 绑定 Request、Grant、当前 Attempt、稳定目标、payload 摘要和回读摘要的写入回执。 |
| `builtin.source-artifact.v1` | 规范化且内容寻址的不可变需求来源；正文只存在于 Source Artifact 文件。 |
| `builtin.submit-result.v1` | Step 的状态、执行摘要、修改文件、Artifact、命令和风险。 |
| `builtin.tdd-trusted-evidence.v1` | 引擎执行 Red 或 Green Gate 后形成的单次可信 TDD Evidence。 |
| `builtin.tdd-cycle-evidence.v1` | 绑定同一命令、测试路径和 Red/Green Evidence 的完整 TDD Cycle。 |
| `builtin.tdd-node-test-report.v1` | 引擎注入的 `node:test` reporter 产生的受限结构化结果。 |
| `builtin.work-item.v1` | Work Item 身份、来源、绑定和快照执行信息。 |
| `builtin.work-package.v1` | Agent 执行所需的目标、Skill、约束、输出和 Gate。 |
| `builtin.work-package.v2` | 在 v1 执行信息基础上支持因果绑定的 `revisionRequest`。 |
| `builtin.workflow-selection.v1` | 当前启用 Workflow 与 Profile。 |

完整 `builtin.application-project-config.v1` 属于当前宿主，附加 Global 根必须同时提供稳定 `id` 与本机 `path`。Work Item 的 `snapshot/config.yaml` 改用 `builtin.application-project-config-snapshot.v1`，只持久化逻辑 `id`，恢复时再由当前宿主配置重绑定路径。

需求来源先转换成 `builtin.source-artifact.v1`。当前 `start` 接受 `user.prompt` 和仓库内 `local.file`；Provider 后续可提交已经规范化的 `github.issue`、`gitlab.issue` 或 `feishu.document`。正文最多为 1 MiB 严格 UTF-8 和 262144 个 Unicode code point；捕获时移除一个开头 BOM，把 CRLF 或 CR 统一为 LF，并规范化为 NFC。NUL、二进制控制字符、空正文和超限内容 fail closed。本地文件必须是规范的仓库相对 POSIX `.md` 或 `.txt` 路径，路径任一组件都不能是符号链接，打开和读取前后的文件身份必须保持一致。

Source Artifact 使用 canonical JSON 存放在 `.wsspec/work-items/<workItemId>/source/<digest>.json`。`contentDigest` 只绑定规范化正文；`artifactId` 和引用的 `contentHash` 绑定除 `artifactId` 外的完整规范 Artifact，因此来源类型、稳定身份、标题、允许的 metadata 和正文任一变化都会得到新文件，旧文件不会被覆盖。并发捕获相同来源只能收敛到逐字节相同的既有 Artifact。Provider metadata 使用按来源类型固定的字段白名单，拒绝自定义 prototype、凭据样式 key/value。统一 secret detector 还识别 GitHub、GitLab、Slack 和飞书 `t-`、`u-`、`a-` 高熵访问令牌；短前缀、低熵占位值和合法飞书文档 token 不视为凭据。`canonicalUrl` 只接受 HTTP(S)。Runtime 对 raw URL 以及解析后的 username、password、hostname、Unicode domain、每个 path segment、raw query key/value、`URLSearchParams` key/value 和 fragment 共用有界 decoder：最多严格执行 4 轮 `decodeURIComponent`，每个中间值都先做长度和 secret scan，query 同时保留 raw `+` 与 form-decoded 空格语义。非法 percent encoding 立即以 `WSSPEC_SOURCE_INVALID` 失败；4 轮后仍有合法 percent escape 则以 `WSSPEC_SOURCE_METADATA_INVALID` 失败，不能把任意深度或合法 `%25` 当作安全输入。所有错误使用固定消息且不回显输入。

Source 的恢复权威由控制面中的 `application-anchor.json`、其绑定的 Application Snapshot 和唯一有效的 `source.captured` 事件共同组成。恢复必须先读取固定 `snapshot/application.json` 字节，验证 anchor 绑定的 manifest，再验证 Application 摘要并严格解析 Application；只有之后才能读取唯一 Source 事件、比较事件/Application/manifest 的完整 Source Artifact 引用，并跟随路径验证磁盘 Artifact。恢复、Application 加载和 Close 使用同一权威入口，因此 Application 摘要或结构错误总是先于缺失、恶意或不可读的 Source 路径报告，且不会在 Application 认证前访问 Source 文件系统。缺少锚点、Application Snapshot 或唯一 Source 事件的旧版 Work Item 不兼容且不迁移，统一 fail closed 为 `WSSPEC_SOURCE_SNAPSHOT_CHANGED`。

只有在 Step 的 `inputs` 中声明 `requirement-source`，Work Package 的 `artifacts` 才获得可读取的完整 Source 引用；正文和 metadata 不复制进 Work Package。`requiredOutputs` 描述 Agent 应产出的 `outputId`、`artifactType`、`schemaVersion` 和可选 `contentLevel`，不携带现有 Artifact 的 ID、路径、摘要或其他读取授权；系统提供的 `requirement-source` 不带 Agent output id。`artifactAuthoring` 明确给出版本、正文上限和 draft roots，且属于 Claim 绑定的完整 Work Package identity。仅声明 Source output 不能借此读取已有 Source。

trusted TDD runner 支持当前 Node.js 的 `node:test` 和项目安装的 Vitest 3.2.4+（3.x）及 4.x。项目必须在不可变配置快照中声明 `testing.pathRules`，并为 `quality.gates.test` 声明与 runner 对应的 `reporter: { type: node-test | vitest, version: 1 }`。若编译后的 Profile 仍启用 `verify-red` 或 `verify-green`，`start` 与 `workflow validate` 在创建 Work Item 前按同一完整性规则 fail closed 为 `WSSPEC_TDD_GATE_CONFIGURATION_INVALID`，不得把缺 Gate 推迟到红绿验证。引擎解析 `argv[0]` 的绝对可执行文件、绑定继承环境和可执行文件摘要，并注入受控 reporter 目标。`java`、`ruby`、`dotnet` 当前只提供测试路径识别规则，不表示对应 runner adapter 已实现；其他不支持的 runner fail closed 为 `WSSPEC_TDD_REPORTER_UNSUPPORTED`，不能由明文 TAP 输出或 Agent 报告升级为 trusted Evidence。

`testing.testAssetPaths` 是测试入口选择器，不是可由项目任意收窄的可信边界。引擎使用不可配置的 stack ownership marker 将 pattern 归一化为 `testAssetRoots`：遇到最早的 `test`、`tests`、`spec`、`.NET Tests` 或 `*.Tests` 目录时，trusted root 固定截到该目录。于是 `tests/unit/*.test.mjs` 提升为 `tests`，`src/test/java/**/*Test.java` 提升为 `src/test`，`spec/models/**/*_spec.rb` 提升为 `spec`，`packages/Foo.Tests/Unit/**/*Tests.cs` 提升为 `packages/Foo.Tests`。nested `__tests__` 或 `__snapshots__` selector 则提升到 marker 的父 package root：`packages/a/__tests__/unit/*.test.ts` 与 `packages/a/__snapshots__/**` 都派生 `packages/a`，因此只声明任一 selector 也会自动扫描并绑定 sibling marker。多个 package 分别派生 roots，不会因选择 `packages/a` 扩大到 `packages/b`。若 pattern 没有已知 marker，引擎保守使用静态前缀的顶层目录；无静态前缀或根级 pattern 使用仓库根 `.`。这些 marker 与算法不受 `testing.pathRules` 或 selector 深度控制。

Red、Green、Implement、Review-Fix、recovery 与 Close 都扫描归一化 roots 下的全部 regular file，并将 roots 与测试所有的文件摘要写入 Evidence；root 或子级 symlink、非普通文件、路径逃逸、超过 4096 个文件或总计超过 1 MiB 都 fail closed。

扫描 root 内匹配 `testAssetPaths` 或位于引擎 ownership marker（`test`、`tests`、`spec`、`__tests__`、`__snapshots__`、`.NET Tests`、具体 `*.Tests`）下的文件始终归测试所有，即使 `testing.productPaths` 恶意或错误地同时匹配；修改或新增这些文件会使原 Red Evidence 失效并重启 TDD cycle。marker 外明确匹配 `testing.productPaths` 的 package 文件可作为 product-only：逐文件摘要仍记录在 `testAssets` 清单中，但不进入 TDD 测试资产聚合摘要，因此 `packages/a/src/**` 等正常产品实现可以在 Red 后变化。扫描 root 内既不匹配 product path、也不位于已知 marker 的未分类文件仍保守归测试所有。

External binding 与 receipt 只允许存入与自身 target 一致的规范 Evidence key：`external-binding:<target>` 与 `external-receipt:<target>`。append、event replay/recovery、archive 写入和 Close 使用同一 key/target、稳定身份、发布 Attempt、输入摘要及发布/回读内容摘要校验；错位 key 或陈旧 receipt 均 fail closed。

`issue.update` 的 comment 写入必须在 `ExternalActionRequest` 与 `ExternalActionGrant` 中绑定 `externalEffectKind: "issue.comment"`，该字段参与 canonical digest 和 Grant exact check。Provider 只有在按 POST 返回的对象 ID 重新 GET 权威 comment/note、核对父 Issue 与正文摘要后，才能生成 verified `ExternalWriteReceipt`：GitHub ID 格式为 `github-comment:<id>`，GitLab ID 格式为 `gitlab-note:<id>`，其中 `<id>` 是 1 到 16 位且不以 0 开头的十进制整数。comment Receipt 必须同时携带 `externalEffectKind` 与 `externalEffectId`；其他 Receipt 禁止携带 `externalEffectId`。该 effect identity 必须原样传播到 projection、event replay/recovery、`adopt_verified`、`inspect.externalActions`、legacy `external-receipt:<target>` Evidence 与 archive audit；任一层缺失、替换或错配均 fail closed。发送后、Receipt 持久化前结果未知时仍进入 `reconciliation_required`，只能通过权威只读回查或交互式 `adopt_verified` 采纳已核验的同一对象，不能自动重发 comment。

```yaml contract=schema:builtin.application-project-config-snapshot.v1
version: 1
skills:
  additionalGlobalRoots:
    - id: team-skills
```

## 3. 返回动作与错误

`acquire`、`submit` 和 `decide` 返回 `AgentAction`。`execute` 携带 Work Package，只有外部动作获批并恢复原 Attempt 时额外携带 `resumeSubmission: true`；`rejection_confirmed` 仅返回一次性拒绝确认 token 及 feedback digest；`await_approval` 携带审批摘要；`blocked` 必须给出可机器识别的问题；`completed` 只表示当前 Work Item 已结束，不代表真实外部平台验收已经完成。

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
| `connectorRegistry` | `WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE`、`WSSPEC_CONNECTOR_CAPABILITY_NOT_FOUND`、`WSSPEC_CONNECTOR_MANIFEST_INVALID`、`WSSPEC_CONNECTOR_PROVIDER_DUPLICATE`、`WSSPEC_GIT_PATH_INVALID`、`WSSPEC_GIT_REPOSITORY_MISMATCH`、`WSSPEC_GIT_REQUEST_INVALID` |
| `connectorProvider` | `WSSPEC_FEISHU_CONFIGURATION_INVALID`、`WSSPEC_FEISHU_FORBIDDEN`、`WSSPEC_FEISHU_MANIFEST_INVALID`、`WSSPEC_FEISHU_MISSING_BINARY`、`WSSPEC_FEISHU_NOT_FOUND`、`WSSPEC_FEISHU_PAGINATION_INVALID`、`WSSPEC_FEISHU_RATE_LIMITED`、`WSSPEC_FEISHU_REQUEST_FAILED`、`WSSPEC_FEISHU_RESPONSE_INVALID`、`WSSPEC_FEISHU_RESPONSE_TOO_LARGE`、`WSSPEC_FEISHU_TARGET_INVALID`、`WSSPEC_FEISHU_UNAUTHENTICATED`、`WSSPEC_ISSUE_ACTION_INVALID`、`WSSPEC_ISSUE_CONFIGURATION_INVALID`、`WSSPEC_ISSUE_FORBIDDEN`、`WSSPEC_ISSUE_IDENTITY_MISMATCH`、`WSSPEC_ISSUE_MANIFEST_INVALID`、`WSSPEC_ISSUE_MISSING_BINARY`、`WSSPEC_ISSUE_NOT_FOUND`、`WSSPEC_ISSUE_RATE_LIMITED`、`WSSPEC_ISSUE_READBACK_MISMATCH`、`WSSPEC_ISSUE_REQUEST_FAILED`、`WSSPEC_ISSUE_RESPONSE_INVALID`、`WSSPEC_ISSUE_TARGET_INVALID`、`WSSPEC_ISSUE_UNAUTHENTICATED`、`WSSPEC_KNOWLEDGE_BINDING_INVALID`、`WSSPEC_KNOWLEDGE_CONTENT_INVALID`、`WSSPEC_KNOWLEDGE_READBACK_FAILED`、`WSSPEC_KNOWLEDGE_READBACK_MISMATCH`、`WSSPEC_KNOWLEDGE_TARGET_INVALID`、`WSSPEC_KNOWLEDGE_WRITE_FAILED`、`WSSPEC_PROCESS_ABORTED`、`WSSPEC_PROCESS_CLEANUP_FAILED`、`WSSPEC_PROCESS_EXECUTABLE_CHANGED`、`WSSPEC_PROCESS_EXECUTABLE_INVALID`、`WSSPEC_PROCESS_EXIT_NONZERO`、`WSSPEC_PROCESS_INVALID_JSON`、`WSSPEC_PROCESS_OUTPUT_LIMIT`、`WSSPEC_PROCESS_REQUEST_INVALID`、`WSSPEC_PROCESS_SPAWN_FAILED`、`WSSPEC_PROCESS_TIMEOUT` |
| `gitCommit` | `WSSPEC_GIT_BASELINE_CHANGED`、`WSSPEC_GIT_COMMIT_FAILED`、`WSSPEC_GIT_DIFF_MISMATCH`、`WSSPEC_GIT_EMPTY_COMMIT`、`WSSPEC_GIT_EXECUTABLE_INVALID`、`WSSPEC_GIT_FILE_SET_MISMATCH`、`WSSPEC_GIT_PATH_INVALID`、`WSSPEC_GIT_PROCESS_FAILED`、`WSSPEC_GIT_READBACK_MISMATCH`、`WSSPEC_GIT_REAPPROVAL_REQUIRED`、`WSSPEC_GIT_REPOSITORY_MISMATCH`、`WSSPEC_GIT_REQUEST_INVALID`、`WSSPEC_GIT_STATE_UNSAFE`、`WSSPEC_GIT_UNAUTHORIZED_DIRTY_FILES` |
| `source` | `WSSPEC_CONNECTOR_PROVIDER_NOT_FOUND`、`WSSPEC_KNOWLEDGE_TARGET_REQUIRED`、`WSSPEC_KNOWLEDGE_TARGET_UNAVAILABLE`、`WSSPEC_SOURCE_ARTIFACT_CONFLICT`、`WSSPEC_SOURCE_BINARY`、`WSSPEC_SOURCE_CHANGED_DURING_READ`、`WSSPEC_SOURCE_EMPTY`、`WSSPEC_SOURCE_INVALID`、`WSSPEC_SOURCE_METADATA_INVALID`、`WSSPEC_SOURCE_NOT_REGULAR_FILE`、`WSSPEC_SOURCE_PATH_INVALID`、`WSSPEC_SOURCE_SNAPSHOT_CHANGED`、`WSSPEC_SOURCE_SNAPSHOT_INVALID`、`WSSPEC_SOURCE_TOO_LARGE`、`WSSPEC_SOURCE_TYPE_UNSUPPORTED` |
| `snapshot` | `WSSPEC_APPLICATION_ANCHOR_INVALID`、`WSSPEC_APPLICATION_SNAPSHOT_CHANGED`、`WSSPEC_APPLICATION_SNAPSHOT_INVALID`、`WSSPEC_CONFIG_SNAPSHOT_CHANGED`、`WSSPEC_SKILL_SNAPSHOT_CHANGED`、`WSSPEC_WORKFLOW_SNAPSHOT_CHANGED`、`WSSPEC_WORK_ITEM_MANIFEST_CHANGED` |
| `workItem` | `WSSPEC_CONTROL_PLANE_INVALID`、`WSSPEC_WORK_ITEM_ID_CONFLICT`、`WSSPEC_WORK_ITEM_INVALID`、`WSSPEC_WORK_ITEM_LOCATION_INVALID`、`WSSPEC_WORK_ITEM_NOT_FOUND`、`WSSPEC_WORK_ITEM_ROLLBACK_FAILED`、`WSSPEC_WORK_ITEM_ROLLBACK_REFUSED` |
| `runtime` | `WSSPEC_CONTROL_PLANE_LOCKED`、`WSSPEC_CONTROL_PLANE_READ_ONLY`、`WSSPEC_CONTROL_PLANE_STALE_LOCK`、`WSSPEC_EVENT_CHAIN_INVALID`、`WSSPEC_EVENT_INVALID`、`WSSPEC_IDEMPOTENCY_CONFLICT`、`WSSPEC_INDEPENDENT_REVIEW_REQUIRED`、`WSSPEC_PROFILE_DECISION_STALE`、`WSSPEC_PROFILE_DOWNGRADE_FORBIDDEN`、`WSSPEC_PROJECTION_WRITE_FAILED`、`WSSPEC_RISK_RULE_INVALID`、`WSSPEC_RISK_WORKFLOW_INVALID`、`WSSPEC_RUNTIME_PROJECTION_INCOMPATIBLE`、`WSSPEC_LOOP_PROJECTION_INVALID`、`WSSPEC_RETRY_PROJECTION_INVALID`、`WSSPEC_STAGE_NOT_FOUND`、`WSSPEC_STATE_TRANSITION_FORBIDDEN` |
| `close` | `WSSPEC_CLOSE_CHECKLIST_INCOMPLETE` |
| `evidenceIngestion` | `WSSPEC_EVIDENCE_ATTEMPT_MISMATCH`、`WSSPEC_EVIDENCE_HASH_MISMATCH`、`WSSPEC_EVIDENCE_INVALID`、`WSSPEC_EVIDENCE_LEVEL_INSUFFICIENT`、`WSSPEC_EVIDENCE_STALE`、`WSSPEC_GATE_NOT_REQUIRED` |
| `tdd` | `WSSPEC_TDD_EVIDENCE_INVALIDATED`、`WSSPEC_TDD_GATE_CONFIGURATION_INVALID`、`WSSPEC_TDD_GATE_EXECUTION_FAILED`、`WSSPEC_TDD_GREEN_NOT_OBSERVED`、`WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE`、`WSSPEC_TDD_RED_NOT_OBSERVED`、`WSSPEC_TDD_RED_REQUIRED`、`WSSPEC_TDD_RED_SCOPE_INVALID`、`WSSPEC_TDD_RED_SYNTAX_FAILURE`、`WSSPEC_TDD_RED_TIMEOUT`、`WSSPEC_TDD_REPORT_INVALID`、`WSSPEC_TDD_REPORTER_UNSUPPORTED`、`WSSPEC_TDD_STEP_INVALID`、`WSSPEC_TDD_TEST_PATH_INVALID` |
| `start` | `WSSPEC_START_ROLLBACK_FAILED` |
| `acquire` | `WSSPEC_ACTIVE_CLAIM_INVALID`、`WSSPEC_ATTEMPT_NOT_ACTIVE`、`WSSPEC_LOOP_CONFIGURATION_INVALID`、`WSSPEC_LOOP_MAX_ITERATIONS_REACHED`、`WSSPEC_REQUIRED_INPUT_ARTIFACT_MISSING`、`WSSPEC_STAGE_ALREADY_CLAIMED`、`WSSPEC_STEP_RETRY_EXHAUSTED`、`WSSPEC_WORKFLOW_BLOCKED` |
| `artifact` | `WSSPEC_ARTIFACT_AUTHORING_UNAVAILABLE`、`WSSPEC_ARTIFACT_CONFLICT`、`WSSPEC_ARTIFACT_DRAFT_CHANGED`、`WSSPEC_ARTIFACT_DRAFT_NOT_IGNORED`、`WSSPEC_ARTIFACT_DRAFT_PATH_INVALID`、`WSSPEC_ARTIFACT_DRAFT_TOO_LARGE`、`WSSPEC_ARTIFACT_ENCODING_INVALID`、`WSSPEC_ARTIFACT_HASH_MISMATCH`、`WSSPEC_ARTIFACT_INCOMPLETE`、`WSSPEC_ARTIFACT_OUTPUT_AMBIGUOUS`、`WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED`、`WSSPEC_ARTIFACT_OUTPUT_SCHEMA_UNSUPPORTED`、`WSSPEC_ARTIFACT_SCHEMA_MISMATCH`、`WSSPEC_ARTIFACT_SCHEMA_NOT_FOUND`、`WSSPEC_LOOP_ARTIFACT_INVALID` |
| `submit` | `WSSPEC_ARTIFACT_REFERENCE_INVALID`、`WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`、`WSSPEC_LOOP_STEP_APPROVAL_UNSUPPORTED`、`WSSPEC_MODIFIED_FILES_MISMATCH`、`WSSPEC_REQUIRED_ARTIFACT_MISSING`、`WSSPEC_STEP_CONFIGURATION_INVALID`、`WSSPEC_STEP_FAILED`、`WSSPEC_STEP_FAILURE_CLASSIFICATION_INVALID`、`WSSPEC_STEP_INPUT_INVALID`、`WSSPEC_UNDECLARED_ARTIFACT`、`WSSPEC_WORKSPACE_MODE_VIOLATION` |
| `approval` | `WSSPEC_APPROVAL_CONFIRMATION_INVALID`、`WSSPEC_APPROVAL_DIGEST_INVALID`、`WSSPEC_APPROVAL_DIGEST_MISMATCH`、`WSSPEC_APPROVAL_EXPIRED`、`WSSPEC_APPROVAL_FEEDBACK_INVALID`、`WSSPEC_APPROVAL_FEEDBACK_NOT_ALLOWED`、`WSSPEC_APPROVAL_NOT_EXPIRED`、`WSSPEC_APPROVAL_NOT_PENDING`、`WSSPEC_APPROVAL_NOT_READY`、`WSSPEC_INTERACTIVE_TTY_REQUIRED`、`WSSPEC_REJECTION_CONFIRMATION_INVALID`、`WSSPEC_REJECTION_CONFIRMATION_MISMATCH`、`WSSPEC_REJECTION_CONFIRMATION_USED` |
| `externalAction` | `WSSPEC_EXTERNAL_ACTION_REJECTED`、`WSSPEC_EXTERNAL_ADOPTION_NOT_VERIFIED`、`WSSPEC_EXTERNAL_ADOPTION_UNSUPPORTED`、`WSSPEC_EXTERNAL_ATTEMPT_MISMATCH`、`WSSPEC_EXTERNAL_BINDING_INVALID`、`WSSPEC_EXTERNAL_DISPATCH_EVIDENCE_MISSING`、`WSSPEC_EXTERNAL_GRANT_EXPIRED`、`WSSPEC_EXTERNAL_GRANT_INVALID`、`WSSPEC_EXTERNAL_GRANT_MISMATCH`、`WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT`、`WSSPEC_EXTERNAL_IDEMPOTENCY_INVALID`、`WSSPEC_EXTERNAL_INTENT_INVALID`、`WSSPEC_EXTERNAL_EXECUTION_IN_PROGRESS`、`WSSPEC_EXTERNAL_ISSUE_CLOSE_NOT_VERIFIED`、`WSSPEC_EXTERNAL_ISSUE_UPDATE_NOT_VERIFIED`、`WSSPEC_EXTERNAL_ORDER_INVALID`、`WSSPEC_EXTERNAL_PAYLOAD_ARTIFACT_INVALID`、`WSSPEC_EXTERNAL_PAYLOAD_INVALID`、`WSSPEC_EXTERNAL_PAYLOAD_MISMATCH`、`WSSPEC_EXTERNAL_PROJECTION_INVALID`、`WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED`、`WSSPEC_EXTERNAL_PROVIDER_RECONCILIATION_FAILED`、`WSSPEC_EXTERNAL_READBACK_MISMATCH`、`WSSPEC_EXTERNAL_RECONCILIATION_EVIDENCE_INVALID`、`WSSPEC_EXTERNAL_RECONCILIATION_FAILED`、`WSSPEC_EXTERNAL_RECONCILIATION_NOT_REQUIRED`、`WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED`、`WSSPEC_EXTERNAL_REJECTION_INVALID`、`WSSPEC_EXTERNAL_REQUEST_DIGEST_MISMATCH`、`WSSPEC_EXTERNAL_REQUEST_EXPIRED`、`WSSPEC_EXTERNAL_REQUEST_INVALID`、`WSSPEC_EXTERNAL_REQUEST_NOT_FOUND`、`WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID`、`WSSPEC_EXTERNAL_TARGET_INVALID`、`WSSPEC_OPTIONAL_KNOWLEDGE_FAILED`、`WSSPEC_OPTIONAL_KNOWLEDGE_NOT_SETTLED`、`WSSPEC_REQUIRED_KNOWLEDGE_NOT_VERIFIED` |
| `workflowEject` | `WSSPEC_WORKFLOW_EJECT_SOURCE_INVALID`、`WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS` |
| `agentInstall` | `WSSPEC_SKILL_INSTALL_CONFLICT` |

### CLI 路由错误合同

| Route | 错误分组 |
|---|---|
| `dispatch` | `internal`、`dispatch` |
| `workflow` | `internal`、`dispatch` |
| `agent` | `internal`、`dispatch` |
| `artifact` | `internal`、`dispatch` |
| `config` | `internal`、`arguments` |
| `config suggest` | `internal`、`arguments`、`repository`、`tdd` |
| `retry-test-gate` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`tdd` |
| `config migrate` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`tdd`、`source` |
| `init` | `internal`、`arguments`、`repository`、`tdd` |
| `start` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`workflowTrust`、`skill`、`projectConfig`、`compiler`、`executor`、`connectorRegistry`、`connectorProvider`、`source`、`workItem`、`runtime`、`start`、`tdd` |
| `acquire` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`expression`、`acquire`、`close`、`tdd`、`externalAction` |
| `artifact create` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`source`、`acquire`、`artifact` |
| `submit` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`acquire`、`artifact`、`submit`、`approval`、`tdd`、`externalAction`、`gitCommit` |
| `decide` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`acquire`、`artifact`、`submit`、`approval`、`workflowPackage`、`workflowTrust`、`externalAction` |
| `inspect` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`externalAction`、`tdd` |
| `workflow list` | `internal`、`arguments`、`builtin`、`connectorRegistry`、`connectorProvider` |
| `workflow show` | `internal`、`arguments`、`builtin`、`connectorRegistry`、`connectorProvider`、`workflowPackage` |
| `workflow eject` | `internal`、`arguments`、`builtin`、`connectorRegistry`、`connectorProvider`、`workflowPackage`、`workflowEject` |
| `workflow validate` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`skill`、`projectConfig`、`compiler`、`executor`、`connectorRegistry`、`connectorProvider`、`tdd` |
| `workflow use` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`skill`、`projectConfig`、`compiler`、`executor`、`connectorRegistry`、`connectorProvider`、`workflowTrust`、`tdd` |
| `agent install` | `internal`、`arguments`、`agentInstall` |
| `doctor connectors` | `internal`、`arguments`、`builtin`、`connectorRegistry`、`connectorProvider` |

`WSSPEC_INTERNAL_ERROR` 是 CLI 对未建模失败的公开兜底 code，不是允许透传原始内部消息的业务错误。无论异常显式携带该 code，还是来自未知 `WSSPEC_` code、普通 Error、非 Error 抛出值或 JSON parser 等底层组件，CLI 都只返回固定消息 `发生未预期的内部错误。`。其他已注册 public code 保留其中文消息。此规则只约束 CLI 输出适配层，不改变 Application 直接 API 的异常类型、code 或 message。

错误对象不应回显凭据、完整外部响应或未授权读取的 Artifact 正文。


### Vitest Test Gate 和测试前配置迁移

Vitest 使用 `reporter: { type: vitest, version: 1 }`，命令为 `node node_modules/vitest/vitest.mjs run`，子工作区追加 `--root apps/web`。固定命令不经过 pnpm/npm script；引擎注入 reporter 和临时报告路径，绑定 Node、Vitest 及已解析的运行依赖内容、环境及 reporter 摘要。断言 Red 必须命中声明的测试文件；语法错误、导入失败、suite/hook 错误、未处理异常、空测试与全跳过不能充当有效红绿证据。Vitest API 来源：<https://vitest.dev/api/advanced/reporters>。

`wspec config suggest [--test-root apps/web]` 只读输出建议配置。`init --test-root apps/web` 支持显式选择单个范围。`init` 对根项目和 apps/packages 中唯一的简单 `vitest run` 测试脚本生成直接命令，并识别产品目录。多个候选或复杂脚本必须显式配置，不静默选择；已有配置不覆盖。

`wspec inspect <id>` 返回 `testingConfigDigest`。先把审核后的完整配置写入当前 Work Item 的 drafts，然后运行：

```sh
wspec config migrate <id> --file .wsspec/work-items/<id>/drafts/config.yaml --expected-digest <testingConfigDigest> --actor <actor>
wspec inspect <id>
wspec acquire <id> --actor <actor>
```

迁移保留原始配置快照，在控制面事件中记录仅影响测试命令、报告器与路径的覆盖配置，`testingConfigDigest` 单独绑定该版本；基础配置摘要仍指向原始快照。只允许测试提交前（包括尚未提交的 write-tests Claim）迁移；拒绝任何待确认审批、后续已执行步骤、TDD Evidence 或外部动作。迁移回收旧 Claim/上下文，新 acquire 创建新 Attempt；禁止复用原 Lease。已经开始验证或产生副作用的任务必须重新建项，当前不提供隐式迁移或证据继承。旧 CLI 不支持覆盖配置，不可用于已迁移任务。

### 恢复已修复的 Red 路径故障

先运行 `wspec inspect <workItemId>`，从 `failedTestGate.attemptId` 获取失败 Attempt。

`wspec retry-test-gate <workItemId> --expected-attempt <失败 Attempt ID> --actor <操作者> --reason <修复原因>` 只用于已完成 write-tests、verify-red 因 `WSSPEC_TDD_TEST_PATH_INVALID` 不可重试失败的 active Work Item。它要求失败 Attempt 仍匹配、没有活动 Claim、待审批、TDD Evidence、外部动作或后续执行。控制面锁内保留失败记录和恢复原因，将 verify-red 重新置为 ready；相同请求幂等，随后 acquire 分配新 Attempt，submit 重新执行完整门禁。此操作不修改配置快照、不修改测试或生产文件、不生成成功证据。仍存在的路径或大小限制会再次阻塞，不能用恢复操作豁免门禁。

### 测试资产扫描范围与预算

Vitest Gate 使用完整默认测试资产规则时，规则相对于命令中唯一的仓库相对 `--root`（或 `-r`）生效；省略 root 或使用 `.` 时保持仓库范围。init/config suggest 会直接输出带子工作区前缀的规则；旧配置快照保持原字节，由引擎按同一规则计算有效范围。自定义 testAssetPaths 保持仓库相对含义，不隐式截断跨包的 fixture/helper。apps/<包> 与 packages/<包> 下的普通选择器以包为 ownership 边界，仍绑定该包中的测试目录与辅助资产。范围变化会使旧 Red Evidence 校验失效，不可沿用旧证据。

1 MiB 字节预算仅累计 trusted 测试资产，包括测试、测试目录中的 fixture/helper 及未声明为生产文件的辅助文件。生产文件仍计算摘要并保留在扫描清单中，但不占用测试资产字节预算；文件读取使用流式摘要。4096 个扫描文件限制与 canonical/symlink 校验继续生效，node_modules 不参与资产扫描。超限错误同时报告当前文件，便于定位配置范围或过大的测试资产。
