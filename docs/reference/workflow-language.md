# Workflow Language v1 参考

Workflow Language v1 描述可审计的交付步骤。它不执行任意脚本或表达式；运行时仅接受加载器、编译器和 Application 已验证的结构。

## 1. Package 结构

每个 Workflow Package 包含 `manifest.yaml`、`workflow.yaml`、声明的 Profile 文件，以及可选的 `skills/`、`schemas/`、`templates/`。引用可为 `builtin://workflows/<id>` 或 `project://workflows/<id>`；`builtin://workflows/feature-delivery` 与 `builtin://workflows/documentation-delivery` 是当前两个内置 Package。

```yaml contract=builtin-documentation-manifest
version: 1
id: documentation-delivery
description: 纯文档交付工作流
entry: workflow.yaml
profiles: [quick, standard, governed]
capabilities: [agent-execution, command-execution, connector-execution, control-flow]
externalSideEffects: [git-commit, issue-update, knowledge-publish, issue-close]
connectors: [requirement, git, issue, knowledge]
```

`manifest.yaml` 只允许声明文件中实际存在的 Profile 和 Package Skill。加载时会收集全部文件摘要，生成 `contentDigest`；可选 `workflow.lock` 必须精确匹配内容摘要、文件摘要和 `package://skills/<name>` 摘要。

## 2. Workflow 定义

顶层字段为 `version`、`workflow`、`inputs`、`steps`、`gates` 和可选 `changePolicy`。外层 `version` 与 `workflow.version` 都必须为 `1`。每个 Step 有唯一 `id`，以 `uses` 指定执行器，可声明 `action`、`needs`、`skills`、`outputs`、`approval`、`when` 和子 `steps`。Gate 有唯一 `id`，并且只声明 `evidence`（`trusted` 或 `attested`）和 argv 形式的 `command`；Gate 不属于 Step 字段。`changePolicy.kind` 只能是 `feature` 或 `documentation-only`。

```yaml contract=workflow-v1
version: 1
workflow:
  id: documentation-delivery
  version: 1
inputs:
  requirement:
    accepts: [user.prompt, local.file, github.issue, gitlab.issue, feishu.document]
steps:
  - id: intake
    uses: connector.execute
    action: requirement.capture
    inputs: [requirement-source]
    outputs: [requirement-source]
  - id: explore
    uses: agent.execute
    needs: [intake]
    inputs: [requirement-source]
    skills:
      - ref: builtin://skills/documentation-exploration
        required: true
    outputs: [documentation-context]
  - id: clarify
    uses: agent.execute
    needs: [explore]
    inputs: [documentation-context]
    skills:
      - ref: builtin://skills/requirement-exploration
        required: true
    outputs: [specification]
  - id: plan
    uses: agent.execute
    needs: [clarify]
    inputs: [specification]
    skills:
      - ref: builtin://skills/task-planning
        required: true
    outputs: [tasks]
  - id: edit-document
    uses: agent.execute
    needs: [plan]
    inputs: [tasks]
    skills:
      - ref: builtin://skills/documentation-editing
        required: true
    outputs: [documentation-result]
  - id: verify-document
    uses: command.execute
    action: quality.docs.integrity
    needs: [edit-document]
    inputs: [documentation-result]
    outputs: [documentation-evidence]
  - id: review-fix
    uses: control.loop
    needs: [verify-document]
    inputs: [documentation-evidence]
    until: ${review-result.approved}
    maxIterations: 5
    steps:
      - id: review
        uses: agent.execute
        skills:
          - ref: builtin://skills/documentation-review
            required: true
        outputs: [review-result]
      - id: fix
        uses: agent.execute
        when: ${review-result.approved == false}
        skills:
          - ref: builtin://skills/documentation-editing
            required: true
      - id: verify
        uses: command.execute
        action: quality.docs.integrity
  - id: commit
    uses: connector.execute
    action: git.commit
    needs: [review-fix]
    approval: required
  - id: update-issue
    uses: connector.execute
    action: issue.update
    needs: [commit]
    when: ${bindings.issue.exists}
  - id: update-wiki
    uses: connector.execute
    action: knowledge.publish
    needs: [update-issue]
    when: ${bindings.knowledge.exists}
  - id: close-issue
    uses: connector.execute
    action: issue.close
    needs: [update-wiki]
    when: ${bindings.issue.exists}
    approval: required
  - id: close
    uses: control.close
    needs: [close-issue]
gates:
  - id: docs.integrity
    evidence: trusted
    command: [wspec, gate, docs.integrity]
changePolicy:
  kind: documentation-only
  allowedPaths: ["README*.md", "CHANGELOG*.md", "docs/**/*.md", "docs/**/*.mdx", "docs/**/*.txt"]
```

`needs` 必须指向已知 Step，图中不得形成环。文档 Workflow 只能修改 `changePolicy.allowedPaths` 中的文档路径，范围越界返回 `WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`。功能 Workflow 的实现步骤必须在可验证的 Red Evidence 后使用 `builtin://skills/tdd-implementation`。

## 3. Profile、审批与信任

Profile 为同一 Workflow 提供 `quick`、`standard`、`governed` 覆盖。覆盖只能收紧 Gate、Artifact、审批和审计要求，不能绕过 Package 声明的能力或安全等级。

```yaml contract=profile-v1
version: 1
profile:
  id: governed
  workflow: documentation-delivery
steps:
  clarify:
    approval: true
    artifacts:
      specification: { required: true, contentLevel: complete }
  plan:
    approval: true
    artifacts:
      tasks: { required: true, contentLevel: complete }
  edit-document:
    approval: true
  review-fix:
    maxIterations: 5
    independentReviewActor: true
  verify-document:
    gates: [docs.integrity]
publishing:
  issueRequired: true
  knowledgeRequired: true
  readBackRequired: true
audit:
  level: complete
  retention: extended
  recordDecisions: true
  recordApprovals: true
  recordActors: true
  recordPublishing: true
```

Builtin Package 只在可验证的内置来源中自动信任。非 Builtin Package 首次使用、内容摘要变化或能力摘要变化时必须创建信任请求；非交互环境不能默认信任，返回 `WSSPEC_WORKFLOW_TRUST_REQUIRED`。拒绝返回 `WSSPEC_WORKFLOW_TRUST_REJECTED`，摘要不匹配返回 `WSSPEC_WORKFLOW_TRUST_CHANGED`。`decide` 记录的 actor、Package 摘要和能力摘要必须与请求完全一致。

当前 Foundation 只实现本地 Application 流程。Git commit、Issue 更新、知识发布和 Issue Close 的真实 Provider 执行、回读和平台验收属于后续 Connector 计划，不能把 Package 中的能力声明误认为已经完成了真实外部验收。
