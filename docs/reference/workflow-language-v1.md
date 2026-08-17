# Workflow Language v1 参考

本文是 `.wsspec/workflow.yaml` 的规范性字段契约。JSON Schema、TypeScript 类型、CLI 帮助和示例校验必须从同一字段定义生成；发生冲突时，以当前主版本的字段定义和本文语义为准。

## 1. 完整示例

```yaml
version: 1

workflow:
  id: verified-delivery

stages:
  - id: define
    kind: define
    owner: agent
    uses: artifact.generate
    needs: []
    input: [intent]
    output: [specification]
    approval:
      required: true
      provider: interactive

  - id: design
    kind: design
    owner: agent
    uses: artifact.generate
    needs: [define]
    input: [specification]
    output: [design]
    approval:
      required: true
      provider: interactive

  - id: plan
    kind: plan
    owner: agent
    uses: task.plan
    needs: [design]
    input: [specification, design]
    output: [plan]
    approval:
      required: true
      provider: interactive

  - id: build
    kind: implement
    owner: agent
    uses: engineering.implement
    needs: [plan]
    input: [specification, design, plan]
    output: [implementation-result]

  - id: review
    kind: review
    owner: agent
    uses: engineering.review
    needs: [build]
    input: [implementation-result]
    output: [review-result]

  - id: verify
    kind: verify
    owner: engine
    uses: quality.verify
    needs: [review]
    input: [review-result]
    output: [verification-result]
    gates: [test, lint, typecheck, build]

  - id: close
    kind: close
    owner: engine
    uses: work-item.close
    needs: [verify]

```

## 2. 顶层字段

### `version`

- 类型：整数。
- 必填：是。
- v1 允许值：`1`。
- 语义：选择工作流语言主版本，不代表 npm 包版本。
- 失败：缺失、非整数或不支持的值返回 `WSPEC_SCHEMA_UNSUPPORTED_VERSION`。
- 扩展：不能修改该字段；升级必须通过 `wspec migrate --dry-run` 预览。

### `workflow`

- 类型：对象。
- 必填：是。
- 允许字段：仅 `id`。
- 语义：声明工作流身份。
- 失败：未知字段返回 `WSPEC_SCHEMA_UNKNOWN_FIELD`。

### `workflow.id`

- 类型：字符串。
- 必填：是。
- 格式：`^[a-z][a-z0-9-]{0,62}$`。
- 作用域：项目内工作流模板。
- 语义：写入 Work Item 快照，用于恢复和审计；重命名视为新工作流。
- 失败：格式错误返回 `WSPEC_SCHEMA_INVALID_ID`。

### `stages`

- 类型：非空数组，元素为 Stage 对象。
- 必填：是。
- 默认值：无。
- 约束：`id` 唯一；`needs` 构成无环图；至少存在一个无依赖入口和一个可达终点。
- 失败：重复 ID 返回 `WSPEC_COMPILE_DUPLICATE_STAGE`，环依赖返回 `WSPEC_COMPILE_CYCLE`。
- 扩展：扩展可以注册新的 `uses`，不能增加未声明字段。

## 3. Stage 字段

### `stages[].id`

- 类型：字符串。
- 必填：是。
- 格式：`^[a-z][a-z0-9-]{0,62}$`。
- 作用域：当前工作流。
- 语义：Stage 的稳定身份，并参与 Attempt、事件和工件引用。
- 兼容性：活动 Work Item 中不能重命名；必须创建新快照并失效受影响阶段。

### `stages[].kind`

- 类型：枚举。
- 必填：是。
- 允许值：`define`、`design`、`plan`、`implement`、`review`、`verify`、`publish`、`close`。
- 语义：选择安全内核规则；不能根据 `id` 或 `uses` 推断。
- 约束：`implement` 必须可达已批准的 define/design/plan 工件；`close` 必须依赖满足必需验证的路径。
- 扩展：v1 扩展不能新增 `kind`。
- 失败：未知值返回 `WSPEC_COMPILE_UNKNOWN_KIND`。

### `stages[].uses`

- 类型：字符串。
- 必填：是。
- 格式：`<namespace>.<action>`，每段匹配 `^[a-z][a-z0-9-]*$`。
- 语义：选择生成执行上下文和校验结果的执行器，不代表 WiesenSpecKit 启动 Agent。
- 约束：执行器 Manifest 必须支持 Stage 的 `kind`、输入和输出契约。
- 失败：未注册返回 `WSPEC_EXECUTOR_NOT_FOUND`；能力不匹配返回 `WSPEC_EXECUTOR_CONTRACT_MISMATCH`。
- 扩展：v1 只允许内置 Executor；M3 的 v1.1 才允许通过锁定扩展注册。

### `stages[].owner`

- 类型：枚举。
- 必填：是。
- 允许值：`agent`、`engine`。
- 语义：决定 Stage 由宿主 Agent 执行，还是由 WiesenSpecKit 安全内核执行。
- 约束：`define`、`design`、`plan`、`implement`、`review` 必须使用 `agent`；`verify`、`publish`、`close` 必须使用 `engine`。
- 执行：`agent` Stage 通过 Claim、Context 和 Result 协议完成；`engine` Stage 由 `wspec next` 在内部执行，不签发 Claim 令牌，也不交给 Agent。
- 失败：owner 与 kind 不匹配返回 `WSPEC_COMPILE_OWNER_KIND_MISMATCH`。

### `stages[].needs`

- 类型：Stage ID 字符串数组。
- 必填：否。
- 默认值：`[]`。
- 语义：所有依赖 Stage 成功且未失效后，当前 Stage 才能进入 `ready`。
- 约束：不得引用自身、未知 Stage 或形成循环；数组不能重复。
- 失败：未知引用返回 `WSPEC_COMPILE_UNKNOWN_DEPENDENCY`。

### `stages[].input`

- 类型：工件类型 ID 字符串数组。
- 必填：否。
- 默认值：`[]`。
- 格式：`^[a-z][a-z0-9-]{0,62}$`。
- 语义：当前 Stage 执行上下文必须包含的最新有效工件类型。
- 约束：每个输入必须由依赖闭包产生或属于 Work Item 的内置 `intent` 来源。
- 失败：无生产者返回 `WSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER`；运行时缺失返回 `WSPEC_STAGE_INPUT_UNAVAILABLE`。

### `stages[].output`

- 类型：工件类型 ID 字符串数组。
- 必填：否。
- 默认值：`[]`。
- 语义：Stage 成功前必须提交并通过 Schema 校验的工件类型。
- 约束：同一 Stage 不能重复输出类型；执行器必须声明对应输出契约。
- 失败：缺失输出返回 `WSPEC_STAGE_OUTPUT_MISSING`。

### `stages[].approval`

- 类型：Approval 对象。
- 必填：否。
- 默认值：`{ required: false }`。
- 允许字段：`required`、`provider`。
- 语义：输出通过校验后是否进入 `awaiting_approval`。
- 约束：`define`、`design`、`plan` 在被 `implement` 消费时必须设置 `required: true`。

### `stages[].approval.required`

- 类型：布尔值。
- 必填：是。
- 默认值：无。
- 语义：是否需要批准当前 Attempt 产生的精确工件哈希。

### `stages[].approval.provider`

- 类型：枚举。
- 必填：当 `required: true` 时必填。
- v1 允许值：仅 `interactive`。
- 语义：用户必须通过连接真实 TTY 的交互流程批准；禁止 `--yes`、管道和非交互调用。
- 失败：非交互调用返回 `WSPEC_APPROVAL_INTERACTIVE_REQUIRED`。
- 扩展：v1 不支持第三方审批提供者。

### `stages[].gates`

- 类型：质量门禁 ID 字符串数组。
- 必填：否。
- 默认值：`[]`。
- 语义：引用 `.wsspec/config.yaml` 中已经确认并固定到 Work Item 快照的门禁定义。
- 约束：`verify` 至少包含一个必需门禁；ID 必须存在且唯一。
- 成功条件：每个必需门禁具有适用于当前代码、配置和 Attempt 的 `trusted` 或策略允许的 `attested` 通过证据。
- 失败：未知门禁返回 `WSPEC_COMPILE_UNKNOWN_GATE`；证据不足返回 `WSPEC_GATE_EVIDENCE_INSUFFICIENT`。

### `stages[].publish`

- 类型：发布目标 ID 字符串数组。
- 必填：否。
- 默认值：`[]`。
- 语义：引用 `.wsspec/config.yaml` 中相互独立的 `issue-sync` 或 `knowledge` Target。
- 约束：只允许用于 `publish` 或 `close`；目标必须定义是否必需、幂等键和回读验证。
- 执行：Target 禁用或 `issue-sync` 缺少 Issue Binding 时 Stage 为 `skipped`；可选 Target 确定失败时为 `succeeded_with_warnings`；必需 Target 失败时阻止关闭。
- 失败：未知目标返回 `WSPEC_COMPILE_UNKNOWN_PUBLISH_TARGET`；外部结果未知时无论是否必需都进入 `reconciliation_required`。
- M2 分别使用 `publish: [issue]` 和 `publish: [knowledge]`；不能把两者合并成一个共享 Target。

## 4. 通用校验与兼容规则

- 所有对象默认 `additionalProperties: false`，未知字段不得静默忽略。
- YAML Alias 展开后再校验，展开后的节点数和深度必须受限，防止资源耗尽。
- 字段错误包含稳定错误码、JSON Pointer 路径、实际值类型、期望结构和修复建议。
- Workflow Language v1 的新增可选字段只能使用向后兼容的次版本发布；删除字段、改变默认值或改变状态语义必须升级主版本。
- v1 不包含 `extensions` 顶层字段。扩展注册语法计划在 M3 以 Workflow Language v1.1 增加；v1 遇到该字段按未知字段拒绝。
- Work Item 创建后固定完整工作流、配置和 Schema 快照。迁移只通过 `wspec rebase-config` 显式执行，并使受影响的 Stage、审批和证据失效。
- 文档中的最小示例、完整示例和错误示例必须在 CI 中分别执行 Schema 与语义编译测试。
