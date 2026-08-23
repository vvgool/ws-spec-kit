# Artifact Authoring 协议边界

Status: ready-for-agent

## 问题陈述

WSSpecKit 需要将 Agent 写出的草稿内容转换为可校验、不可变、可被后续 Step 引用的正式 Artifact。当前实现以 `artifact create` 完成草稿路径约束、文件身份校验、内容合同校验、规范化、内容寻址存储和 `ArtifactRef` 生成。

该能力不应被合并到 `submit`：`submit` 的职责是验证当前 Attempt 的结果并推进 Workflow 状态；Artifact authoring 的职责是安全吸收草稿文件。若两者合并，`submit` 将同时承担草稿读取、TOCTOU 防护、内容持久化和状态转换，协议与恢复语义都会变得不清晰。

同时，Artifact authoring 也不应被视为与 `start`、`acquire`、`submit`、`decide`、`inspect` 并列的第六个 Work Item 生命周期操作。它只服务于当前已 Claim 的 Attempt，不独立推进 Workflow。

## 解决方案

将 Application Protocol 的生命周期主循环固定为五操作：

```text
start -> acquire -> submit -> decide -> inspect
```

保留独立的 Artifact authoring 实现和 `wspec artifact create` CLI 命令，但把它定义为 `execute` Work Package 下的 Attempt 作用域辅助能力。Agent 在拿到 Work Package 后，按其中的 `artifactAuthoring` 合同写入受限草稿，调用 Artifact authoring 能力取得不可变 `ArtifactRef`，再由 `submit` 仅消费该引用并验证必需输出。

## 用户故事

1. 作为执行当前 Step 的 Agent，我希望从 Work Package 获得 Artifact authoring 约束，以便只创建当前 Attempt 被授权的产物。
2. 作为执行当前 Step 的 Agent，我希望在提交结果前取得稳定的 `ArtifactRef`，以便将正式产物引用交给 `submit`。
3. 作为 Workflow 作者，我希望以 `outputId`、`artifactType`、`schemaVersion` 和内容级别声明必需输出，以便下游 Step 消费确定的产物身份。
4. 作为维护者，我希望主 Application Protocol 只有五个生命周期操作，以便协议面保持稳定、易于为不同 Agent 宿主实现。
5. 作为维护者，我希望 `artifact create` 不推进 Workflow 状态，以便 Artifact 持久化和 Step 完成具有清晰、可独立恢复的语义。
6. 作为安全审查者，我希望草稿只能在当前 Work Package 授权的目录中读取，以便拒绝路径逃逸和越权读取。
7. 作为安全审查者，我希望 Artifact authoring 拒绝符号链接、非普通文件和读取期间发生变化的草稿，以便避免 TOCTOU 与替换攻击。
8. 作为审计者，我希望 Artifact 内容通过规范化与内容摘要冻结，以便后续引用可验证且不可被静默篡改。
9. 作为恢复后的新 Agent 会话，我希望仍只能使用当前 Claim 对应的 Artifact authoring 合同，以便恢复不改变 Attempt 语义。
10. 作为 `submit` 调用方，我希望只提交 `ArtifactRef`，而不提交草稿路径或正文，以便控制面、事件与结果 JSON 不泄露或复制未授权内容。
11. 作为 Workflow Runtime，我希望在必需 Artifact 引用缺失、身份不匹配或合同不匹配时拒绝 `submit`，以便不会推进不完整的 Step。
12. 作为 CLI 用户，我希望继续使用 `wspec artifact create`，以便在不扩大主生命周期协议的情况下完成受控产物写入。
13. 作为包消费者，我希望公开文档将 `artifact create` 描述为 `execute` Work Package 的辅助能力，以便不会误以为它是独立的状态推进操作。
14. 作为测试维护者，我希望通过一条端到端 Attempt seam 验证 author、引用和提交，以便测试关注可观察行为而非内部实现细节。

## 实现决策

- `WSSpecApplication` 只公开 `start`、`acquire`、`submit`、`decide`、`inspect` 五个生命周期操作。
- Artifact authoring 以独立的 Attempt 作用域服务暴露。其输入必须绑定 `root`、`workItemId`、`stepId`、`attemptId`、`leaseToken`、`artifactType`，并在需要消除输出歧义时要求 `outputId`。
- CLI 保留 `wspec artifact create`。CLI adapter 调用 Attempt Artifact authoring 服务，而不是向主 `WSSpecApplication` 增加 `artifact()` 方法。
- `acquire` 返回 `execute` 时，Work Package 必须携带 Artifact authoring 合同，包括允许的草稿根、最大正文大小、可写 Artifact 类型、输出身份及其 Schema/内容级别约束。
- Artifact authoring 只在活动 Claim、Attempt、Lease 与 Work Package identity 完全匹配时执行；恢复或重新获取 Lease 不得改变已绑定的合同。
- Artifact authoring 负责草稿路径边界、常规文件与链接检查、稳定读取、严格 UTF-8、内容合同、规范化、摘要计算、不可变内容寻址写入与幂等冲突处理。
- `submit` 不读取草稿文件，也不接收 Artifact 正文或草稿路径；它只验证 `ArtifactRef` 是否满足当前 Step 的 `requiredOutputs`，然后执行结果校验与状态推进。
- Artifact 持久化成功但 `submit` 后续失败时，Artifact 可以保留为不可变内容；它不表示 Step 成功，且不能由其他 Attempt 或未授权输出冒用。
- 公共 Schema、CLI 帮助和参考文档必须将 Artifact authoring 归入 `execute` Work Package 的辅助能力，不能将其列为第六个 Application Protocol 生命周期操作。
- 不引入兼容别名或双版本 Application Protocol；若当前未提交实现含有顶层 `artifact()`，应移除该公开接口并调整调用方。

## 测试决策

- 最高验证 seam 是端到端 Attempt 流程：`acquire` 返回 `execute` Work Package，Agent 在授权 draft root 写草稿，`wspec artifact create` 返回 `ArtifactRef`，`submit` 使用该引用成功推进或返回下一条 `AgentAction`。
- 测试应验证外部行为：主 Application Protocol 只公开五操作；CLI 可创建 Artifact；`submit` 只接受引用；正确引用可被接受；错误、缺失、越权或过期引用被拒绝。
- 测试不得断言私有存储函数、内部锁顺序或具体临时文件名；应通过命令结果、公开错误码、ArtifactRef、事件恢复结果和 Work Item 投影验证行为。
- 复用现有 Application flow、Artifact 合同、CLI、恢复和 Driver contract 测试的 fixture 约定；新增测试应覆盖协议边界，而不是重复文件系统实现细节。
- 必须覆盖：草稿路径逃逸、符号链接、内容变化、失效 Lease、错误 `outputId`、缺少必需输出、引用身份不匹配、author 成功但 submit 失败后重试，以及跨会话恢复后的合同不变性。
- 契约测试必须确认公开 Application Protocol、Schema 和中文参考文档不再把 `artifact create` 表述为第六个同层生命周期操作。

## 非目标

- 不将 Artifact authoring 合并进 `submit`。
- 不让 `artifact create` 单独推进、跳过或完成 Workflow Step。
- 不新增模型调用、会话存储、daemon 或无人值守 Agent Runner。
- 不允许 Artifact authoring 写入任意本地路径、外部平台或未在 Work Package 中声明的产物。
- 不以 fixture 或模拟 Driver 验收替代真实 Agent 宿主或外部平台的发布验收。
- 不在本规格中决定 GitHub、GitLab、飞书等 Connector 的真实发布状态。

## 补充说明

本决策的重点是收紧公开协议边界，而不是删除 Artifact authoring 能力。Artifact authoring 是治理平面吸收 Agent 输出的安全边界；`submit` 是 Workflow Runtime 对执行结果进行验证和状态推进的边界。两者必须保持分离。

## 里程碑

### 里程碑一：冻结 Foundation 协议

目标是冻结可移植的 Agent 交付治理基础，而不是继续扩展功能范围。

- Application Protocol 固定为 `start`、`acquire`、`submit`、`decide`、`inspect` 五操作。
- `artifact create` 作为 Attempt 作用域辅助能力保留，不作为第六个生命周期操作，也不合并到 `submit`。
- Workflow、Profile、Skill、Schema、配置、需求来源、Work Package 与 ArtifactRef 的快照和身份绑定可被本地自动化验证。
- 关闭当前 Foundation 收尾问题，完成协议、Schema、CLI、参考文档和自动化门禁的一致性检查。
- 将 Foundation 冻结点与后续 Runtime/Connector 工作明确分离；冻结后不得因验收便利而无决策地扩大公开协议。

完成定义：从隔离 Git 仓库可执行本地 `init -> start -> acquire -> artifact create -> submit -> decide -> inspect` 闭环；其中主生命周期协议仍为五操作，Artifact 创建只在有效 Attempt 内可用，所有本地契约、类型检查、测试、构建和打包预检通过。

### 里程碑二：验证本地交付闭环并管理集成线

目标是让功能交付和文档交付 Workflow 在真实本地项目中可恢复地完成，不将该工作混入 Foundation 的协议冻结判断。

- 在独立的 Runtime/Connector/Release 集成线上推进条件、重试、有界 Review-Fix 循环、Profile 升级、可信 Gate、Close 和 Connector 实现。
- 在隔离仓库中验证功能 Workflow 和文档 Workflow：需求捕获、Work Package、Artifact、TDD 或文档 Gate、Review-Fix、审批、恢复和 Close 都产生可审计结果。
- 将 Artifact authoring 端到端 seam 固化为 `acquire -> artifact create -> submit`，验证恢复、Lease、输出身份和不可变引用语义。
- 将 Git、GitHub、GitLab、飞书 Connector 的 fixture 与集成测试明确归为实现证据，而非真实平台发布证据。

完成定义：至少一个功能交付 Fixture 和一个文档交付 Fixture 能在新进程恢复后闭环完成；Artifact、Evidence、审批和 Work Item 投影可回读并符合冻结的协议边界；Runtime/Connector 的所有自动化门禁通过。

### 里程碑三：取得发布级真实验收证据

目标是验证 WSSpecKit 在真实宿主和真实外部平台上可用，而不是仅证明代码和 fixture 自洽。

- Codex、Claude、Cursor 分别完成可审计的 Driver 发现或显式调用、`inspect + acquire` 跨会话恢复、`submit` 及最终 verifier 证据。
- GitHub、GitLab、飞书分别完成专用测试目标上的认证预检、精确授权写入、幂等、回读和失败路径验证。
- 完成 clean tarball 安装、中文使用指南、需求追踪矩阵与 release gate；任何 `not_run` 或失败都降低相应层级结论。
- 发布报告必须分开陈述自动化实现证据、真实宿主证据和真实平台证据；不得用任一低层证据替代高层结论。

完成定义：所有首版声明为必需的真实 Host 与外部平台验收均有可重复、脱敏、可回读的 PASS 证据；clean consumer 安装、发布门禁和追踪矩阵通过；总体发布结论才可标记为 GO。

该规格发布后，后续实现任务应以此为唯一接口决策来源，并使用 `Status: ready-for-agent` 标记。
