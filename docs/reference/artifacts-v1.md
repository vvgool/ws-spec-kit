# Artifacts v1 参考

本文定义内置 Artifact 的语义和最低内容。Artifact 可以使用 Markdown 表达，但必须带有可由同一 JSON Schema 校验的 front matter；仅创建同名文件不能满足 Stage 输出。

## 1. 通用封装

```yaml
artifactType: specification
schemaVersion: 1
workItemId: WSK-20260816-001
stageId: define
attemptId: attempt-1
revision: 1
contentHash: sha256:...
```

以上字段全部必填，未知字段失败。内置 Schema ID 由 `artifactType + schemaVersion` 确定，例如 `builtin.specification.v1`，不在 front matter 中重复保存。正文规范化、附件引用和 `contentHash` 计算以 `docs/reference/execution-contracts-v1.md` 为准。Artifact Reference 必须记录 `artifactType`、`schemaVersion`、路径、媒体类型、`revision` 和 `contentHash`。

## 2. `specification`

必须包含：目标与背景、范围、编号需求、可验证验收条件、约束、明确排除项、开放问题。每条验收条件必须能映射到至少一个后续验证项；未解决且影响实现的开放问题阻止批准。

## 3. `design`

必须包含：上下文与架构、组件职责和边界、接口与数据契约、安全与权限、失败与恢复、兼容或迁移、测试策略、已知权衡。设计必须引用其消费的 `specification` 内容摘要。

## 4. `plan` 与 `tasks`

`plan` 必须包含：有序交付任务、任务依赖、精确文件范围、每项验证方式、人工检查点和回滚方式。`tasks` 是可选的结构化拆分，其“任务”章节必须包含一个 fenced YAML 块，顶层为 `tasks` 数组；每项必须有 `id`、`dependencies`、`completion` 和 `status`，状态仅允许 `pending`、`in_progress`、`completed`、`blocked`。二者存在时不得矛盾。

## 5. `implementation-result`

必须包含：实际完成的改动、修改文件、与批准计划的偏差、执行过的验证摘要、未完成项和残余风险。它是 Agent 声明，不替代 Engine 产生的可信 Evidence。

## 6. `review-result`

“Findings”章节必须包含一个 fenced YAML 块，顶层为 `findings` 数组。每项包含稳定 `id`、`severity`（`P0`、`P1`、`P2`、`P3`）、`description`、`evidence`、仓库相对 `path`、可选 `line`，以及 `disposition`（`open`、`fixed`、`accepted`、`false-positive`）。P0/P1 未处置时不能进入验证。

## 7. `verification-result`

“Gate/Evidence 矩阵”章节必须包含一个 fenced YAML 块，顶层为 `gates` 数组；每项包含 `gateId`、`required`、`expectedLevel`、`evidenceId`、`workspaceTreeDigest`、`result` 和 `occurredAt`。正文另含未通过项、覆盖限制和残余风险。此处 `workspaceTreeDigest` 等于被验证 Stage Result 的 `outputWorkspaceTreeDigest`。只有 Engine-owned verify 可以生成具有成功语义的该工件。

## 8. `knowledge-entry`

必须包含：背景、需求或 Bug 表现、原因或约束、关键决策、实现摘要、验证证据、适用范围、限制和相关 Issue/Work Item 引用。它是知识沉淀，不承担任务状态同步；发布前必须绑定精确内容摘要并经过 External Action 审批。

## 9. 版本与失效

- v1 内置 Schema ID 固定为 `builtin.<type>.v1`，项目不能覆盖内置 Schema。
- M3 扩展只能增加命名空间工件类型，不能放宽内置字段。
- 上游 Artifact 内容摘要变化时，所有消费它的 Artifact、Approval、Claim 和 Evidence 失效。
- Schema 主版本变化必须显式迁移；迁移产生新内容摘要，不能继承旧审批。
- 缺少章节、引用断裂或 Schema 不匹配分别返回 `WSPEC_ARTIFACT_INCOMPLETE`、`WSPEC_ARTIFACT_REFERENCE_INVALID`、`WSPEC_ARTIFACT_SCHEMA_MISMATCH`。
