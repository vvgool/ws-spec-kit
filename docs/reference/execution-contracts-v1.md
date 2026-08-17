# Execution Contracts v1 参考

本文定义 Executor Manifest、Artifact、Stage Context、Stage Result、Evidence 和 External Action 的规范性结构。对应 JSON Schema 是 CLI、宿主 Skill 和内置执行器之间的唯一数据契约。内置工件内容见 `docs/reference/artifacts-v1.md`，仓库与 Work Item 身份见 `docs/reference/work-item-v1.md`。

## 1. Executor Manifest

内置执行器随 WiesenSpecKit 发布。Manifest 示例：

```yaml
version: 1
id: engineering.implement
owner: agent
kinds: [implement]
inputs: [specification, design, plan]
outputs: [implementation-result]
permissions:
  read: [worktree, artifacts]
  write: [worktree, artifacts]
  command: true
  network: false
sideEffects: local
contextTemplate: builtin/engineering-implement-v1
resultSchema: builtin/stage-result-v1
```

### Manifest 字段

- `version`：整数，必填，v1 仅允许 `1`。
- `id`：执行器 ID，必填，格式与 Workflow Language 的 `uses` 一致。
- `owner`：`agent` 或 `engine`，必须与 Stage `owner` 相同。
- `kinds`：非空 Stage kind 数组；执行器只能用于其中一种 kind。
- `inputs`：执行器支持读取的工件类型数组；Workflow 声明必须是其子集或精确匹配内置契约。
- `outputs`：执行器能够产生的工件类型数组；Workflow 要求的输出必须全部包含。
- `permissions.read/write`：`worktree`、`artifacts`、`evidence` 的允许集合。
- `permissions.command`：是否需要执行本地命令。Agent-owned 时只用于上下文披露，不授予额外系统权限。
- `permissions.network`：是否需要网络。M1 内置 Agent Executor 默认为 `false`。
- `sideEffects`：`none`、`local`、`external`。`external` 仅允许 Engine-owned publish Executor。
- `contextTemplate`：版本化内置模板 ID，用于生成 Stage Context；不接受项目任意代码路径。
- `resultSchema`：Stage Result JSON Schema ID。

未知字段、owner/kind 不匹配、输入输出不兼容或权限超过项目策略时，工作流编译失败。Workflow Language v1 只允许内置 Executor；第三方注册从 M3 的 v1.1 开始。

## 2. Artifact 契约

工件是带 YAML Frontmatter 的 UTF-8 Markdown 文件：

```markdown
---
artifactType: design
schemaVersion: 1
workItemId: WSK-20260816-001
stageId: design
attemptId: attempt-2
revision: 3
contentHash: sha256:example
---

# Design
```

### Artifact 字段

- `artifactType`：工件类型 ID，必须与 Stage `output` 和工件 Schema 一致。
- `schemaVersion`：该工件类型的 Schema 主版本。
- `workItemId`、`stageId`、`attemptId`：产生工件的精确执行身份。
- `revision`：同一 Work Item 和工件类型内单调递增的正整数。
- `contentHash`：规范化内容的 SHA-256。

所有字段必填，禁止未知 Frontmatter 字段。审批状态、审批人和审批时间不写入工件，而保存在共享事件日志和只读审计快照中，避免修改审批元数据导致工件哈希自引用。

### 工件 Schema

- 内置类型 Schema 位于 `.wsspec/schemas/artifacts/<artifact-type>/v<schema-version>.schema.json`。
- Schema 校验 Frontmatter，并可声明正文必需标题、章节和机器可读块。
- Stage 成功前，引擎校验文件路径、Frontmatter、Schema、生产者身份和内容哈希。
- 未注册类型返回 `WSPEC_ARTIFACT_SCHEMA_NOT_FOUND`。
- 内置类型的最低内容和版本规则以 `docs/reference/artifacts-v1.md` 为准，项目配置不能覆盖或放宽。

### 内容规范化与哈希

`contentHash` 按以下确定性步骤计算：

1. 将文件解码为严格 UTF-8，拒绝无效字节和 BOM。
2. 解析 Frontmatter，移除 `contentHash`。
3. 将剩余 Frontmatter 转为 JSON 数据模型，并严格按 RFC 8785 序列化为规范 JSON。
4. 将正文换行统一为 LF，去除行尾空格，并保证恰好一个末尾换行。
5. 对 `canonical-json + "\n" + canonical-body` 的 UTF-8 字节计算 SHA-256。

任何规范化输入变化都会产生新 revision，并使绑定旧哈希的审批和下游证据失效。

## 3. Stage Context

`wspec context --format json` 只为 Agent-owned Stage 返回：

```json
{
  "version": 1,
  "workItemId": "WSK-20260816-001",
  "stageId": "build",
  "attemptId": "attempt-3",
  "claimToken": "opaque-random-token",
  "claimExpiresAt": "2026-08-16T18:00:00+08:00",
  "workflowDigest": "sha256:...",
  "configDigest": "sha256:...",
  "baselineTreeDigest": "sha256:...",
  "inputWorkspaceTreeDigest": "sha256:...",
  "contextDigest": "sha256:...",
  "objective": "Implement the approved plan",
  "inputs": [],
  "expectedOutputs": [],
  "allowedPaths": ["src/**", "tests/**", ".wsspec/work-items/WSK-.../artifacts/**"],
  "gates": ["test", "lint", "typecheck", "build"],
  "resultSchema": "builtin/stage-result-v1"
}
```

- `inputs` 是 Artifact Reference 数组，包含 `artifactType`、`schemaVersion`、仓库相对 `path`、`revision` 和 `contentHash`。
- `expectedOutputs` 使用相同结构，但未产生前不包含 revision、path 和 hash。
- `allowedPaths` 是用于完成后差异校验的仓库相对 glob，不是针对恶意本地 Agent 的 OS 沙箱。
- `baselineTreeDigest` 是创建 Work Item 时固定的基线树摘要；`inputWorkspaceTreeDigest` 是签发 Context 时重新计算的 Stage 输入工作区摘要。
- `contextDigest` 覆盖除 `claimToken` 和到期时间外的完整规范 JSON；Claim 续租不改变上下文摘要。
- 上下文不得包含凭据、隐藏推理或未批准的敏感来源。

## 4. Stage Result

Agent-owned Stage 通过 JSON 文件提交：

```json
{
  "version": 1,
  "workItemId": "WSK-20260816-001",
  "stageId": "build",
  "attemptId": "attempt-3",
  "workflowDigest": "sha256:...",
  "contextDigest": "sha256:...",
  "baselineTreeDigest": "sha256:...",
  "inputWorkspaceTreeDigest": "sha256:...",
  "outputWorkspaceTreeDigest": "sha256:...",
  "status": "completed",
  "summary": "Implemented retry policy",
  "modifiedFiles": ["src/retry.ts", "tests/retry.test.ts"],
  "artifacts": [],
  "commands": [],
  "evidence": [],
  "externalWrites": [],
  "remainingRisks": []
}
```

### Result 字段

- 身份字段：`version`、`workItemId`、`stageId`、`attemptId`、`workflowDigest`、`contextDigest`、`baselineTreeDigest`、`inputWorkspaceTreeDigest` 均必填并必须与活动 Claim 和 Context 匹配。
- `outputWorkspaceTreeDigest`：Agent 完成修改后的工作区摘要声明。允许与输入摘要不同；引擎在接受 Result 前独立重算并要求精确相等。
- `status`：`completed` 或 `failed`；决定进入 validating 还是 failed。
- `summary`：非空短文本，不参与成功判定。
- `modifiedFiles`：规范化仓库相对路径数组。引擎必须通过 Git 状态独立重算并要求精确相等；越出 `allowedPaths` 时拒绝结果。该字段用于展示和权限检查，不证明完整工作区身份。
- `artifacts`：Artifact Reference 数组。引擎重新读取文件、执行 Schema 校验并计算哈希，不能信任 Agent 提交值。
- `commands`：Agent 报告的命令、工作目录、退出码和输出摘要，只产生 `reported` 证据。
- `evidence`：已有 Evidence Reference 数组；引擎验证其来源、`workspaceTreeDigest`、配置摘要、输入工件和 Attempt。实现后证据必须绑定 `outputWorkspaceTreeDigest`。
- `externalWrites`：Agent 报告的外部操作，仅用于审计，不能满足 Engine-owned publish Stage。M1 Agent-owned Executor 默认禁止计划外外部写入。
- `remainingRisks`：结构化风险数组，每项包含 `severity`、`description` 和可选 `mitigation`。

所有数组必填，空值使用 `[]`。禁止绝对路径、`..`、NUL、重复路径和未知字段。Result 文件本身存入当前 Attempt 的 evidence 目录并记录哈希。

## 5. Evidence Reference

Evidence Reference 至少包含：

```json
{
  "evidenceId": "evidence-01",
  "level": "trusted",
  "gateId": "test",
  "codeRevision": "abc123",
  "baselineTreeDigest": "sha256:...",
  "workspaceTreeDigest": "sha256:...",
  "configDigest": "sha256:...",
  "attemptId": "attempt-3",
  "result": "passed",
  "recordHash": "sha256:..."
}
```

- `reported` 由 Agent Result 产生，不能单独满足 Gate。
- `trusted` 只能由 WiesenSpecKit 直接启动并捕获 Project Config 中的 argv 命令产生。
- `attested` 从 M2 开始，由配置的 CI 验证器产生并包含可校验外部运行身份。
- 代码修订保留为可读定位信息；Gate 的有效身份以完整 `workspaceTreeDigest` 为准。
- 工作区摘要、配置摘要、输入工件或 Attempt 不匹配时，证据立即失效。

### 完整工作区摘要

引擎按规范化仓库相对路径排序，对每个 tracked 文件和非 ignored untracked 文件记录路径、对象类型、可执行位或符号链接目标、内容 SHA-256，并显式记录 tracked 文件的删除。最终对规范 JSON 计算 SHA-256。摘要不包含 `.git`、Git common-dir 控制面、Work Item 运行日志和明确声明的临时输出；排除集合由版本化引擎契约固定，项目不能自行扩大。

Claim 时计算 `inputWorkspaceTreeDigest`。Result 提交时，引擎先确认 Context 中的输入摘要仍对应该 Attempt 的起点，再计算当前工作区并与 `outputWorkspaceTreeDigest` 精确比较；输入与输出允许不同。Artifact 审批、Gate 执行、External Action 审批及执行前都重新计算当前摘要，并绑定已经接受的输出摘要。Stage 完成后发生额外变化则返回 `WSPEC_WORKSPACE_CHANGED`，使相关 Approval、Evidence 和尚未执行的 External Action 失效。每次计算和失效均写入事件，事件包含 `baselineTreeDigest`、`inputWorkspaceTreeDigest` 与 `outputWorkspaceTreeDigest`；尚无输出时后者为 `null`。

## 6. External Action 协议

配置启用 Target 只允许引擎准备操作，不构成远端写入授权。每个写入必须先持久化精确请求：

```json
{
  "version": 1,
  "requestId": "action-001",
  "workItemId": "WSK-20260816-001",
  "stageId": "sync-issue",
  "attemptId": "attempt-1",
  "target": {"type": "issue", "stableId": "github:12345678"},
  "action": "update",
  "plannedDiff": {"labelsAdded": ["done"], "comment": "Verification passed"},
  "baselineTreeDigest": "sha256:...",
  "workspaceTreeDigest": "sha256:...",
  "actionDigest": "sha256:...",
  "idempotencyKey": "sha256:...",
  "expiresAt": "2026-08-16T18:00:00+08:00"
}
```

`actionDigest` 覆盖请求中除自身以外的完整规范 JSON。`plannedDiff` 必须是适配器将要发送的最终语义操作，不允许批准后再由模板或 Agent改变。读取和准备可以自动执行；创建或修改 Issue、评论、标签、状态、Knowledge 页面及其他远端对象都必须进入：

```text
prepared -> awaiting_action_approval -> approved -> executing -> succeeded
                                   \-> rejected -> skipped|failed
executing -> reconciliation_required -> succeeded|failed
```

批准只能通过真实 TTY 的 `wspec action approve <request-id>` 完成，界面必须展示远端稳定身份、URL、动作、完整差异、工作区摘要、过期时间和幂等键。禁止 `--yes`、管道、环境变量预授权和 CI 批准。批准记录绑定 `requestId`、`actionDigest`、`workspaceTreeDigest`、终端会话标识和时间。

执行前重新计算 action 与工作区摘要并检查到期时间；任一不匹配都使批准失效。执行后必须回读并保存远端稳定 ID、响应摘要和内容摘要。进程中断、超时或无法判断写入是否发生时必须进入 `reconciliation_required`，不得用同一幂等键盲目重试。可选 Target 被用户拒绝时为 `skipped`；必需 Target 被拒绝时为 `failed` 并阻止关闭。

## 7. Engine-owned Executor

Engine-owned `verify`、`publish` 和 `close` 不接受 Agent Stage Result：

- `verify` 从快照配置读取 Gate，直接执行 argv 并产生 `trusted` 证据。
- `publish` 每次只处理一个固定 Target。`issue-sync` 只同步任务状态和摘要；`knowledge` 使用版本化模板把已批准工件组装为 `knowledge-entry` 并发布到稳定页面。两者使用独立 Attempt、External Action Request、幂等键和回读证据。
- Target 禁用或 Issue Binding 缺失时结果为 `skipped`。可选 Target 确定失败时结果为 `succeeded_with_warnings`；必需 Target 确定失败时为 `failed`。外部结果未知时无论是否必需都进入 `reconciliation_required`。
- `close` 检查安全不变量、导出最终审计快照并将控制面转为只读。

所有 Engine-owned 结果由引擎内部 Schema 校验并写入事件日志。宿主 Skill 只能观察其状态，不能伪造或覆盖其结果。
