# Application Protocol 参考

本文是 `wspec` 的公开 Application Protocol 真源。面向用户的解释使用中文；字段名、Schema ID、URI、命令名和错误码保持英文。客户端只通过稳定 JSON 调用 Application，不直接修改控制面。

## 1. 命令与操作

| CLI 命令 | Application 操作 | 输入 Schema | 说明 |
|---|---|---|---|
| `init` | repository initialization | 无 | 初始化当前 Git 仓库的 `.wsspec` 配置。 |
| `start` | `start` | `builtin.application-start-input.v1` | 从 Prompt 或仓库内文件创建 Work Item，并快照 Workflow、Skill、配置和来源。 |
| `acquire` | `acquire` | `builtin.application-acquire-input.v1` | 取得下一可执行 Step 的 `AgentAction`。 |
| `submit` | `submit` | `builtin.application-submit-input.v1` | 提交本次 Attempt 的结果、Artifact 和 Evidence 引用。 |
| `decide` | `decide` | `builtin.application-decision-input.v1` | 对步骤审批、外部动作授权或 Workflow 信任作出明确决定，或触发只读外部协调回查。 |
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

### `submit`

输入：`SubmitInput`，对应 `builtin.application-submit-input.v1`，包含 `root`、`workItemId`、`stepId`、`attemptId`、`leaseToken` 和 `result`。输出：`AgentAction`。`submit` 没有 `actor` 字段；CLI 的 `--actor` 仅为适配层可选上下文，不能写入协议 JSON。`attemptId` 与 `leaseToken` 必须对应仍活动的租约。Agent 的失败结果只提交 `status: "failed"`、执行摘要、Artifact 等执行事实，不能提交 `failureCode` 或 `retryable`。默认 Executor 将普通失败归类为可重试的 `WSSPEC_STEP_FAILED`；失败分类只由受信 Executor 或 Runtime 内部产生并持久化，例如 `WSSPEC_STEP_INPUT_INVALID` 或 `WSSPEC_STEP_CONFIGURATION_INVALID`，Runtime 据此决定是否消耗重试预算。

`external-write` Step，以及 `action: git.commit` 的 `local-write` Step，成功时必须精确提交一个受治理的 `external-action` 意图，包含 Provider、动作、稳定目标、payload 和副作用说明。第一次 `submit` 只持久化 `builtin.external-action-request.v1` 的摘要身份并返回 `await_approval`，不会调用 Provider。批准后重复提交同一 Attempt 才可执行；Runtime 以原子 owner 保证同一 Request 只有一个协调者调用 Provider，并在 Provider 调用前持久化 `executing/not_sent`。Executor 必须在发送边界调用 `markDispatched()` 持久化 `sent_or_unknown`。其他并发提交返回可重试的 `WSSPEC_EXTERNAL_EXECUTION_IN_PROGRESS`。发送后结果未知时进入 `reconciliation_required`，只允许只读回查，不自动重发。Provider 执行或回查异常只返回固定的 `WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED` 或 `WSSPEC_EXTERNAL_PROVIDER_RECONCILIATION_FAILED`，不回显 Provider 文本。确认成功后 Agent 的原始意图由严格的 `builtin.external-write-receipt.v1` 替换，事件、投影和公开视图不持久化 payload 或凭据。`issue.close` 还要求 `issue.update` 已验证，且 Knowledge 按 Profile 已验证、明确 absent/skipped，或已持久化 optional warning；否则以 `WSSPEC_EXTERNAL_ORDER_INVALID` fail closed。除上述 `external-write` 与本地 `git.commit` 外，其他 Step 禁止携带 `externalWrites`。

### `decide`

输入：`DecisionInput`，对应 `builtin.application-decision-input.v1`。步骤审批和 `external_action` 决定需要 `workItemId`、`expectedDigest` 与 `actor`；Workflow 信任需要 Package/能力摘要与 `actor`；`external_reconciliation` 需要 `workItemId`、`requestId`、`expectedDigest` 与 `actor`。输出：`AgentAction`。Workflow 信任与外部动作决定只接受真实交互式 TTY。外部批准形成与当前 Request、Attempt、actor、Profile、workspace 和 config 摘要绑定的 `builtin.external-action-grant.v1`；拒绝决定持久化与 Request 摘要绑定的证据，后续 `acquire` 继续 fail closed。`external_reconciliation` 精确支持三种决定：`reconcile` 仅调用对应 Provider 的只读回查，不要求交互式 TTY；`mark_failed` 由真实交互式 TTY 提交审计证据，将未知结果标记为失败；`adopt_verified` 由真实交互式 TTY 提交外部稳定 ID、内容摘要和审计证据，并且仍须通过 Provider 的权威只读回查后才能采纳 verified Receipt。三者都不批准或重发写入，完成后通过 `acquire` 恢复原 Attempt。

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
| `builtin.application-decision-input.v1` | 步骤审批、外部动作授权、Workflow 信任决定或只读外部协调回查。 |
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
| `builtin.workflow-selection.v1` | 当前启用 Workflow 与 Profile。 |

完整 `builtin.application-project-config.v1` 属于当前宿主，附加 Global 根必须同时提供稳定 `id` 与本机 `path`。Work Item 的 `snapshot/config.yaml` 改用 `builtin.application-project-config-snapshot.v1`，只持久化逻辑 `id`，恢复时再由当前宿主配置重绑定路径。

需求来源先转换成 `builtin.source-artifact.v1`。当前 `start` 接受 `user.prompt` 和仓库内 `local.file`；Provider 后续可提交已经规范化的 `github.issue`、`gitlab.issue` 或 `feishu.document`。正文最多为 1 MiB 严格 UTF-8 和 262144 个 Unicode code point；捕获时移除一个开头 BOM，把 CRLF 或 CR 统一为 LF，并规范化为 NFC。NUL、二进制控制字符、空正文和超限内容 fail closed。本地文件必须是规范的仓库相对 POSIX `.md` 或 `.txt` 路径，路径任一组件都不能是符号链接，打开和读取前后的文件身份必须保持一致。

Source Artifact 使用 canonical JSON 存放在 `.wsspec/work-items/<workItemId>/source/<digest>.json`。`contentDigest` 只绑定规范化正文；`artifactId` 和引用的 `contentHash` 绑定除 `artifactId` 外的完整规范 Artifact，因此来源类型、稳定身份、标题、允许的 metadata 和正文任一变化都会得到新文件，旧文件不会被覆盖。并发捕获相同来源只能收敛到逐字节相同的既有 Artifact。Provider metadata 使用按来源类型固定的字段白名单，拒绝自定义 prototype、凭据样式 key/value。统一 secret detector 还识别 GitHub、GitLab、Slack 和飞书 `t-`、`u-`、`a-` 高熵访问令牌；短前缀、低熵占位值和合法飞书文档 token 不视为凭据。`canonicalUrl` 只接受 HTTP(S)。Runtime 对 raw URL 以及解析后的 username、password、hostname、Unicode domain、每个 path segment、raw query key/value、`URLSearchParams` key/value 和 fragment 共用有界 decoder：最多严格执行 4 轮 `decodeURIComponent`，每个中间值都先做长度和 secret scan，query 同时保留 raw `+` 与 form-decoded 空格语义。非法 percent encoding 立即以 `WSSPEC_SOURCE_INVALID` 失败；4 轮后仍有合法 percent escape 则以 `WSSPEC_SOURCE_METADATA_INVALID` 失败，不能把任意深度或合法 `%25` 当作安全输入。所有错误使用固定消息且不回显输入。

Source 的恢复权威由控制面中的 `application-anchor.json`、其绑定的 Application Snapshot 和唯一有效的 `source.captured` 事件共同组成。恢复必须先读取固定 `snapshot/application.json` 字节，验证 anchor 绑定的 manifest，再验证 Application 摘要并严格解析 Application；只有之后才能读取唯一 Source 事件、比较事件/Application/manifest 的完整 Source Artifact 引用，并跟随路径验证磁盘 Artifact。恢复、Application 加载和 Close 使用同一权威入口，因此 Application 摘要或结构错误总是先于缺失、恶意或不可读的 Source 路径报告，且不会在 Application 认证前访问 Source 文件系统。缺少锚点、Application Snapshot 或唯一 Source 事件的旧版 Work Item 不兼容且不迁移，统一 fail closed 为 `WSSPEC_SOURCE_SNAPSHOT_CHANGED`。

只有在 Step 的 `inputs` 中声明 `requirement-source`，Work Package 的 `artifacts` 才获得可读取的完整 Source 引用；正文和 metadata 不复制进 Work Package。`requiredOutputs` 仅描述 Agent 应产出的 `artifactType`、`schemaVersion` 和可选 `contentLevel`，不携带现有 Artifact 的 ID、路径、摘要或其他读取授权。仅声明 Source output 不能借此读取已有 Source。

首版 trusted TDD runner 只支持当前 Node.js 的 `node:test`。项目必须在不可变配置快照中声明 `testing.pathRules`，并为 `quality.gates.test` 声明 `reporter: { type: node-test, version: 1 }`；引擎解析 `argv[0]` 的绝对可执行文件、绑定继承环境和可执行文件摘要，并注入受控 reporter 目标。`java`、`ruby`、`dotnet` 当前只提供测试路径识别规则，不表示对应 runner adapter 已实现；非 `node:test` runner fail closed 为 `WSSPEC_TDD_REPORTER_UNSUPPORTED`，不能由明文 TAP 输出或 Agent 报告升级为 trusted Evidence。

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
| `connectorRegistry` | `WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE`、`WSSPEC_CONNECTOR_CAPABILITY_NOT_FOUND`、`WSSPEC_CONNECTOR_MANIFEST_INVALID`、`WSSPEC_CONNECTOR_PROVIDER_DUPLICATE`、`WSSPEC_GIT_PATH_INVALID`、`WSSPEC_GIT_REPOSITORY_MISMATCH`、`WSSPEC_GIT_REQUEST_INVALID` |
| `connectorProvider` | `WSSPEC_FEISHU_CONFIGURATION_INVALID`、`WSSPEC_FEISHU_FORBIDDEN`、`WSSPEC_FEISHU_MANIFEST_INVALID`、`WSSPEC_FEISHU_MISSING_BINARY`、`WSSPEC_FEISHU_NOT_FOUND`、`WSSPEC_FEISHU_PAGINATION_INVALID`、`WSSPEC_FEISHU_RATE_LIMITED`、`WSSPEC_FEISHU_REQUEST_FAILED`、`WSSPEC_FEISHU_RESPONSE_INVALID`、`WSSPEC_FEISHU_RESPONSE_TOO_LARGE`、`WSSPEC_FEISHU_TARGET_INVALID`、`WSSPEC_FEISHU_UNAUTHENTICATED`、`WSSPEC_ISSUE_ACTION_INVALID`、`WSSPEC_ISSUE_CONFIGURATION_INVALID`、`WSSPEC_ISSUE_FORBIDDEN`、`WSSPEC_ISSUE_IDENTITY_MISMATCH`、`WSSPEC_ISSUE_MANIFEST_INVALID`、`WSSPEC_ISSUE_MISSING_BINARY`、`WSSPEC_ISSUE_NOT_FOUND`、`WSSPEC_ISSUE_RATE_LIMITED`、`WSSPEC_ISSUE_READBACK_MISMATCH`、`WSSPEC_ISSUE_REQUEST_FAILED`、`WSSPEC_ISSUE_RESPONSE_INVALID`、`WSSPEC_ISSUE_TARGET_INVALID`、`WSSPEC_ISSUE_UNAUTHENTICATED`、`WSSPEC_KNOWLEDGE_BINDING_INVALID`、`WSSPEC_KNOWLEDGE_CONTENT_INVALID`、`WSSPEC_KNOWLEDGE_READBACK_FAILED`、`WSSPEC_KNOWLEDGE_READBACK_MISMATCH`、`WSSPEC_KNOWLEDGE_TARGET_INVALID`、`WSSPEC_KNOWLEDGE_WRITE_FAILED`、`WSSPEC_PROCESS_CLEANUP_FAILED`、`WSSPEC_PROCESS_EXECUTABLE_CHANGED`、`WSSPEC_PROCESS_EXECUTABLE_INVALID`、`WSSPEC_PROCESS_EXIT_NONZERO`、`WSSPEC_PROCESS_INVALID_JSON`、`WSSPEC_PROCESS_OUTPUT_LIMIT`、`WSSPEC_PROCESS_REQUEST_INVALID`、`WSSPEC_PROCESS_SPAWN_FAILED`、`WSSPEC_PROCESS_TIMEOUT` |
| `gitCommit` | `WSSPEC_GIT_BASELINE_CHANGED`、`WSSPEC_GIT_COMMIT_FAILED`、`WSSPEC_GIT_DIFF_MISMATCH`、`WSSPEC_GIT_EMPTY_COMMIT`、`WSSPEC_GIT_EXECUTABLE_INVALID`、`WSSPEC_GIT_FILE_SET_MISMATCH`、`WSSPEC_GIT_PATH_INVALID`、`WSSPEC_GIT_PROCESS_FAILED`、`WSSPEC_GIT_READBACK_MISMATCH`、`WSSPEC_GIT_REAPPROVAL_REQUIRED`、`WSSPEC_GIT_REPOSITORY_MISMATCH`、`WSSPEC_GIT_REQUEST_INVALID`、`WSSPEC_GIT_STATE_UNSAFE`、`WSSPEC_GIT_UNAUTHORIZED_DIRTY_FILES` |
| `source` | `WSSPEC_CONNECTOR_PROVIDER_NOT_FOUND`、`WSSPEC_KNOWLEDGE_TARGET_REQUIRED`、`WSSPEC_KNOWLEDGE_TARGET_UNAVAILABLE`、`WSSPEC_SOURCE_ARTIFACT_CONFLICT`、`WSSPEC_SOURCE_BINARY`、`WSSPEC_SOURCE_CHANGED_DURING_READ`、`WSSPEC_SOURCE_EMPTY`、`WSSPEC_SOURCE_INVALID`、`WSSPEC_SOURCE_METADATA_INVALID`、`WSSPEC_SOURCE_NOT_REGULAR_FILE`、`WSSPEC_SOURCE_PATH_INVALID`、`WSSPEC_SOURCE_SNAPSHOT_CHANGED`、`WSSPEC_SOURCE_SNAPSHOT_INVALID`、`WSSPEC_SOURCE_TOO_LARGE`、`WSSPEC_SOURCE_TYPE_UNSUPPORTED` |
| `snapshot` | `WSSPEC_APPLICATION_ANCHOR_INVALID`、`WSSPEC_APPLICATION_SNAPSHOT_CHANGED`、`WSSPEC_APPLICATION_SNAPSHOT_INVALID`、`WSSPEC_CONFIG_SNAPSHOT_CHANGED`、`WSSPEC_SCHEMA_SNAPSHOT_CHANGED`、`WSSPEC_SKILL_SNAPSHOT_CHANGED`、`WSSPEC_WORKFLOW_SNAPSHOT_CHANGED`、`WSSPEC_WORK_ITEM_MANIFEST_CHANGED` |
| `workItem` | `WSSPEC_CONTROL_PLANE_INVALID`、`WSSPEC_WORK_ITEM_ID_CONFLICT`、`WSSPEC_WORK_ITEM_INVALID`、`WSSPEC_WORK_ITEM_LOCATION_INVALID`、`WSSPEC_WORK_ITEM_NOT_FOUND`、`WSSPEC_WORK_ITEM_ROLLBACK_FAILED`、`WSSPEC_WORK_ITEM_ROLLBACK_REFUSED` |
| `runtime` | `WSSPEC_CONTROL_PLANE_LOCKED`、`WSSPEC_CONTROL_PLANE_READ_ONLY`、`WSSPEC_CONTROL_PLANE_STALE_LOCK`、`WSSPEC_EVENT_CHAIN_INVALID`、`WSSPEC_EVENT_INVALID`、`WSSPEC_IDEMPOTENCY_CONFLICT`、`WSSPEC_INDEPENDENT_REVIEW_REQUIRED`、`WSSPEC_PROFILE_DECISION_STALE`、`WSSPEC_PROFILE_DOWNGRADE_FORBIDDEN`、`WSSPEC_PROJECTION_WRITE_FAILED`、`WSSPEC_RISK_RULE_INVALID`、`WSSPEC_RISK_WORKFLOW_INVALID`、`WSSPEC_RUNTIME_PROJECTION_INCOMPATIBLE`、`WSSPEC_LOOP_PROJECTION_INVALID`、`WSSPEC_RETRY_PROJECTION_INVALID`、`WSSPEC_STAGE_NOT_FOUND`、`WSSPEC_STATE_TRANSITION_FORBIDDEN` |
| `close` | `WSSPEC_CLOSE_CHECKLIST_INCOMPLETE` |
| `evidenceIngestion` | `WSSPEC_EVIDENCE_ATTEMPT_MISMATCH`、`WSSPEC_EVIDENCE_HASH_MISMATCH`、`WSSPEC_EVIDENCE_INVALID`、`WSSPEC_EVIDENCE_LEVEL_INSUFFICIENT`、`WSSPEC_EVIDENCE_STALE`、`WSSPEC_GATE_NOT_REQUIRED` |
| `tdd` | `WSSPEC_TDD_EVIDENCE_INVALIDATED`、`WSSPEC_TDD_GATE_CONFIGURATION_INVALID`、`WSSPEC_TDD_GATE_EXECUTION_FAILED`、`WSSPEC_TDD_GREEN_NOT_OBSERVED`、`WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE`、`WSSPEC_TDD_RED_NOT_OBSERVED`、`WSSPEC_TDD_RED_REQUIRED`、`WSSPEC_TDD_RED_SCOPE_INVALID`、`WSSPEC_TDD_RED_SYNTAX_FAILURE`、`WSSPEC_TDD_RED_TIMEOUT`、`WSSPEC_TDD_REPORT_INVALID`、`WSSPEC_TDD_REPORTER_UNSUPPORTED`、`WSSPEC_TDD_STEP_INVALID`、`WSSPEC_TDD_TEST_PATH_INVALID` |
| `start` | `WSSPEC_START_ROLLBACK_FAILED` |
| `acquire` | `WSSPEC_LOOP_CONFIGURATION_INVALID`、`WSSPEC_LOOP_MAX_ITERATIONS_REACHED`、`WSSPEC_REQUIRED_INPUT_ARTIFACT_MISSING`、`WSSPEC_STAGE_ALREADY_CLAIMED`、`WSSPEC_STEP_RETRY_EXHAUSTED`、`WSSPEC_WORKFLOW_BLOCKED` |
| `artifact` | `WSSPEC_ARTIFACT_ENCODING_INVALID`、`WSSPEC_ARTIFACT_HASH_MISMATCH`、`WSSPEC_ARTIFACT_INCOMPLETE`、`WSSPEC_ARTIFACT_SCHEMA_MISMATCH`、`WSSPEC_ARTIFACT_SCHEMA_NOT_FOUND`、`WSSPEC_LOOP_ARTIFACT_INVALID` |
| `submit` | `WSSPEC_ARTIFACT_REFERENCE_INVALID`、`WSSPEC_ATTEMPT_NOT_ACTIVE`、`WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`、`WSSPEC_LOOP_STEP_APPROVAL_UNSUPPORTED`、`WSSPEC_MODIFIED_FILES_MISMATCH`、`WSSPEC_REQUIRED_ARTIFACT_MISSING`、`WSSPEC_STEP_CONFIGURATION_INVALID`、`WSSPEC_STEP_FAILED`、`WSSPEC_STEP_FAILURE_CLASSIFICATION_INVALID`、`WSSPEC_STEP_INPUT_INVALID`、`WSSPEC_UNDECLARED_ARTIFACT` |
| `approval` | `WSSPEC_APPROVAL_DIGEST_INVALID`、`WSSPEC_APPROVAL_DIGEST_MISMATCH`、`WSSPEC_APPROVAL_EXPIRED`、`WSSPEC_APPROVAL_NOT_EXPIRED`、`WSSPEC_APPROVAL_NOT_PENDING`、`WSSPEC_APPROVAL_NOT_READY`、`WSSPEC_INTERACTIVE_TTY_REQUIRED` |
| `externalAction` | `WSSPEC_EXTERNAL_ACTION_REJECTED`、`WSSPEC_EXTERNAL_ADOPTION_NOT_VERIFIED`、`WSSPEC_EXTERNAL_ADOPTION_UNSUPPORTED`、`WSSPEC_EXTERNAL_ATTEMPT_MISMATCH`、`WSSPEC_EXTERNAL_BINDING_INVALID`、`WSSPEC_EXTERNAL_DISPATCH_EVIDENCE_MISSING`、`WSSPEC_EXTERNAL_GRANT_EXPIRED`、`WSSPEC_EXTERNAL_GRANT_INVALID`、`WSSPEC_EXTERNAL_GRANT_MISMATCH`、`WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT`、`WSSPEC_EXTERNAL_IDEMPOTENCY_INVALID`、`WSSPEC_EXTERNAL_INTENT_INVALID`、`WSSPEC_EXTERNAL_EXECUTION_IN_PROGRESS`、`WSSPEC_EXTERNAL_ISSUE_CLOSE_NOT_VERIFIED`、`WSSPEC_EXTERNAL_ISSUE_UPDATE_NOT_VERIFIED`、`WSSPEC_EXTERNAL_ORDER_INVALID`、`WSSPEC_EXTERNAL_PAYLOAD_ARTIFACT_INVALID`、`WSSPEC_EXTERNAL_PAYLOAD_INVALID`、`WSSPEC_EXTERNAL_PAYLOAD_MISMATCH`、`WSSPEC_EXTERNAL_PROJECTION_INVALID`、`WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED`、`WSSPEC_EXTERNAL_PROVIDER_RECONCILIATION_FAILED`、`WSSPEC_EXTERNAL_READBACK_MISMATCH`、`WSSPEC_EXTERNAL_RECONCILIATION_EVIDENCE_INVALID`、`WSSPEC_EXTERNAL_RECONCILIATION_FAILED`、`WSSPEC_EXTERNAL_RECONCILIATION_NOT_REQUIRED`、`WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED`、`WSSPEC_EXTERNAL_REJECTION_INVALID`、`WSSPEC_EXTERNAL_REQUEST_DIGEST_MISMATCH`、`WSSPEC_EXTERNAL_REQUEST_EXPIRED`、`WSSPEC_EXTERNAL_REQUEST_INVALID`、`WSSPEC_EXTERNAL_REQUEST_NOT_FOUND`、`WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID`、`WSSPEC_EXTERNAL_TARGET_INVALID`、`WSSPEC_OPTIONAL_KNOWLEDGE_FAILED`、`WSSPEC_OPTIONAL_KNOWLEDGE_NOT_SETTLED`、`WSSPEC_REQUIRED_KNOWLEDGE_NOT_VERIFIED` |
| `workflowEject` | `WSSPEC_WORKFLOW_EJECT_SOURCE_INVALID`、`WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS` |
| `agentInstall` | `WSSPEC_SKILL_INSTALL_CONFLICT` |

### CLI 路由错误合同

| Route | 错误分组 |
|---|---|
| `dispatch` | `internal`、`dispatch` |
| `workflow` | `internal`、`dispatch` |
| `agent` | `internal`、`dispatch` |
| `init` | `internal`、`arguments`、`repository` |
| `start` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`workflowTrust`、`skill`、`projectConfig`、`compiler`、`executor`、`connectorRegistry`、`connectorProvider`、`source`、`workItem`、`runtime`、`start` |
| `acquire` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`expression`、`acquire`、`close`、`tdd`、`externalAction` |
| `submit` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`acquire`、`artifact`、`submit`、`approval`、`tdd`、`externalAction`、`gitCommit` |
| `decide` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`runtime`、`skill`、`projectConfig`、`executor`、`source`、`acquire`、`artifact`、`submit`、`approval`、`workflowPackage`、`workflowTrust`、`externalAction` |
| `inspect` | `internal`、`arguments`、`repository`、`schema`、`snapshot`、`workItem`、`externalAction` |
| `workflow list` | `internal`、`arguments`、`builtin`、`connectorRegistry`、`connectorProvider` |
| `workflow show` | `internal`、`arguments`、`builtin`、`connectorRegistry`、`connectorProvider`、`workflowPackage` |
| `workflow eject` | `internal`、`arguments`、`builtin`、`connectorRegistry`、`connectorProvider`、`workflowPackage`、`workflowEject` |
| `workflow validate` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`skill`、`projectConfig`、`compiler`、`executor`、`connectorRegistry`、`connectorProvider` |
| `workflow use` | `internal`、`arguments`、`repository`、`schema`、`builtin`、`workflowPackage`、`skill`、`projectConfig`、`compiler`、`executor`、`connectorRegistry`、`connectorProvider`、`workflowTrust` |
| `agent install` | `internal`、`arguments`、`agentInstall` |
| `doctor connectors` | `internal`、`arguments`、`builtin`、`connectorRegistry`、`connectorProvider` |

`WSSPEC_INTERNAL_ERROR` 是 CLI 对未建模失败的公开兜底 code，不是允许透传原始内部消息的业务错误。无论异常显式携带该 code，还是来自未知 `WSSPEC_` code、普通 Error、非 Error 抛出值或 JSON parser 等底层组件，CLI 都只返回固定消息 `发生未预期的内部错误。`。其他已注册 public code 保留其中文消息。此规则只约束 CLI 输出适配层，不改变 Application 直接 API 的异常类型、code 或 message。

错误对象不应回显凭据、完整外部响应或未授权读取的 Artifact 正文。
