# Workflow Language v1 参考

Workflow Language v1 描述可审计的交付步骤。它不执行任意脚本或表达式；运行时仅接受加载器、编译器和 Application 已验证的结构。

## 1. Package 结构

每个 Workflow Package 包含 `manifest.yaml`、`workflow.yaml`、声明的 Profile 文件，以及可选的 `skills/`、`schemas/`、`templates/`。引用可为 `builtin://workflows/<id>` 或 `project://workflows/<id>`；`builtin://workflows/feature-delivery` 与 `builtin://workflows/documentation-delivery` 是当前两个内置 Package。

```yaml
version: 1
id: documentation-delivery
description: 仅交付文档变更
entry: workflow.yaml
profiles: [quick, standard, governed]
skills: []
capabilities: [agent-execution, command-execution, connector-execution, control-flow]
externalSideEffects: [git-commit, issue-update, knowledge-publish, issue-close]
connectors: [requirement, git, issue, knowledge]
```

`manifest.yaml` 只允许声明文件中实际存在的 Profile 和 Package Skill。加载时会收集全部文件摘要，生成 `contentDigest`；可选 `workflow.lock` 必须精确匹配内容摘要、文件摘要和 `package://skills/<name>` 摘要。

## 2. Workflow 定义

顶层字段为 `version`、`workflow`、`inputs`、`steps`、`gates` 和可选 `changePolicy`。`version` 必须为 `1`。每个 Step 有唯一 `id`，以 `uses` 指定执行器，可声明 `action`、`needs`、`skills`、`outputs`、`approval`、`when` 和子 `steps`。Gate 有唯一 `id`，并声明 `action`、`evidence` 和 `required`。

```yaml
version: 1
workflow:
  id: documentation-delivery
inputs:
  requirement:
    accepts: [user.prompt, local.file]
steps:
  - id: write-document
    uses: agent.execute
    skills:
      - ref: builtin://skills/documentation-editing
        required: true
    outputs: [documentation-result]
  - id: verify-document
    uses: control.verify
    needs: [write-document]
    gates: [docs.integrity]
gates:
  - id: docs.integrity
    action: quality.docs.integrity
    evidence: trusted
    required: true
changePolicy:
  kind: documentation
  allowedPaths: [docs/**]
```

`needs` 必须指向已知 Step，图中不得形成环。文档 Workflow 只能修改 `changePolicy.allowedPaths` 中的文档路径，范围越界返回 `WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`。功能 Workflow 的实现步骤必须在可验证的 Red Evidence 后使用 `builtin://skills/tdd-implementation`。

## 3. Profile、审批与信任

Profile 为同一 Workflow 提供 `quick`、`standard`、`governed` 覆盖。覆盖只能收紧 Gate、Artifact、审批和审计要求，不能绕过 Package 声明的能力或安全等级。

```yaml
version: 1
profile:
  id: governed
  workflow: documentation-delivery
steps:
  write-document:
    approval: true
publishing:
  issueRequired: true
  knowledgeRequired: true
  readBackRequired: true
audit:
  level: complete
```

Builtin Package 只在可验证的内置来源中自动信任。非 Builtin Package 首次使用、内容摘要变化或能力摘要变化时必须创建信任请求；非交互环境不能默认信任，返回 `WSSPEC_WORKFLOW_TRUST_REQUIRED`。拒绝返回 `WSSPEC_WORKFLOW_TRUST_REJECTED`，摘要不匹配返回 `WSSPEC_WORKFLOW_TRUST_CHANGED`。`decide` 记录的 actor、Package 摘要和能力摘要必须与请求完全一致。

当前 Foundation 只实现本地 Application 流程。Git commit、Issue 更新、知识发布和 Issue Close 的真实 Provider 执行、回读和平台验收属于后续 Connector 计划，不能把 Package 中的能力声明误认为已经完成了真实外部验收。
