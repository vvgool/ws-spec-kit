# Project Config v1 参考

本文定义 `.wsspec/config.yaml` 的规范性字段。配置在 Work Item 创建时完整复制到 `snapshot/config.yaml` 并记录 SHA-256；活动 Work Item 不读取随后变化的项目全局配置。

## 1. 完整示例

```yaml
version: 1

trigger:
  mode: suggest

git:
  worktrees:
    enabled: true
    root: .worktrees
    branchPrefix: wspec/

runtime:
  claimTtlSeconds: 1800
  maxStageRetries: 3

quality:
  gates:
    test:
      command: [npm, test]
      cwd: worktree
      timeoutSeconds: 900
      required: true
      evidence: trusted
      inheritEnv: [PATH, CI]
      env:
        NODE_ENV: test

```

这是可直接用于 M1 的完整配置。M2 项目可追加 `publishing.targets`，字段见第 4 节。

M2 示例：

```yaml
publishing:
  targets:
    issue:
      type: issue-sync
      adapter: builtin.git-issue
      enabled: true
      required: false
      readBack: true
      settings:
        updateState: true
        commentMode: summary
    knowledge:
      type: knowledge
      adapter: builtin.wiki
      enabled: true
      required: false
      readBack: true
      settings:
        stableKeyStrategy: work-item
        titleTemplate: "{{workItemId}} {{title}}"
```

## 2. 顶层字段

### `version`

- 类型：整数；必填；v1 仅允许 `1`。
- 语义：Project Config 的主版本。
- 失败：不支持时返回 `WSPEC_CONFIG_UNSUPPORTED_VERSION`。

### `trigger`

- 类型：对象；必填；只允许 `mode`。
- 语义：控制宿主 Skill 是否建议或自动续接 WiesenSpecKit；不能授予审批或外部写权限。

### `trigger.mode`

- 类型：枚举；必填。
- 允许值：`off`、`suggest`、`active-only`。
- `off`：只响应显式命令。
- `suggest`：仓库首次匹配任务时建议创建 Work Item。
- `active-only`：不建议创建新 Work Item，只自动续接已经激活的 Work Item。
- 默认方案：`suggest`，但字段仍必须显式写入，避免宿主默认值漂移。

### `git`

- 类型：对象；必填；只允许 `worktrees`。

### `git.worktrees`

- 类型：对象；必填。
- 允许字段：`enabled`、`root`、`branchPrefix`。
- M1 约束：`enabled` 必须为 `true`；非 Git 项目必须先初始化 Git，不能静默退化为无隔离模式。

### `git.worktrees.enabled`

- 类型：布尔值；必填；M1 仅允许 `true`。
- 失败：为 `false` 时返回 `WSPEC_GIT_WORKTREE_REQUIRED`。

### `git.worktrees.root`

- 类型：仓库相对路径字符串；必填。
- 约束：必须规范化后仍位于仓库父目录或项目策略允许的位置；禁止绝对路径、`..` 和符号链接逃逸。
- 语义：创建 Work Item worktree 的根目录。

### `git.worktrees.branchPrefix`

- 类型：字符串；必填。
- 格式：合法 Git ref 前缀，默认示例为 `wspec/`。
- 语义：分支名为 `<branchPrefix><work-item-id>`；创建前必须检查精确目标不存在。

### `runtime`

- 类型：对象；必填。
- 允许字段：`claimTtlSeconds`、`maxStageRetries`。

### `runtime.claimTtlSeconds`

- 类型：整数；必填；范围 `60..86400`。
- 语义：Agent-owned Stage Claim 的租期；续租必须显式产生事件。

### `runtime.maxStageRetries`

- 类型：整数；必填；范围 `0..10`。
- 语义：单个 Stage 在一个 Work Item 中允许自动或人工创建的最大重试次数；不可重试错误不消费后继续尝试。

### `quality`

- 类型：对象；必填；只允许 `gates`。

### `quality.gates`

- 类型：以 Gate ID 为键的非空对象；必填。
- Gate ID 格式：`^[a-z][a-z0-9-]{0,62}$`。
- 语义：供 Workflow Language 的 `stages[].gates` 引用。
- 失败：重复、非法或空定义返回 `WSPEC_CONFIG_INVALID_GATE`。

### `publishing`

- 类型：对象；选填；只允许 `targets`。
- 默认值：`{ targets: {} }`。

### `publishing.targets`

- 类型：以 Target ID 为键的对象。
- 语义：供 Workflow Language 的 `stages[].publish` 引用。
- M1：只校验空对象；内置 Issue/Wiki 目标从 M2 开始可用。

## 3. Gate 字段

### `quality.gates.<id>.command`

- 类型：非空字符串数组；必填。
- 语义：直接传给 `spawn` 的可执行文件和 argv，不经过 Shell 拼接。
- 约束：首元素不能包含 NUL；所有元素长度受限；v1 不接受单字符串命令、重定向、管道或命令替换。
- 失败：可执行文件不存在返回 `WSPEC_GATE_COMMAND_NOT_FOUND`。

### `quality.gates.<id>.cwd`

- 类型：枚举；必填；v1 仅允许 `worktree`。
- 语义：命令在 Work Item 的规范 worktree 根目录执行。

### `quality.gates.<id>.timeoutSeconds`

- 类型：整数；必填；范围 `1..86400`。
- 语义：超时后先终止进程组，再记录 `WSPEC_GATE_TIMEOUT`；超时结果不能作为通过证据。

### `quality.gates.<id>.required`

- 类型：布尔值；必填。
- 语义：为 `true` 时必须通过才能产生 Work Item `verified` 状态。

### `quality.gates.<id>.evidence`

- 类型：枚举；必填。
- M1 允许值：`trusted`。
- M2 增加：`attested`。
- 语义：规定满足该 Gate 的最低证据等级。

### `quality.gates.<id>.inheritEnv`

- 类型：环境变量名称数组；选填；默认 `[]`。
- 语义：只继承明确列出的变量。名称匹配 `^[A-Z_][A-Z0-9_]*$`。
- 安全：检测为凭据的变量禁止继承；需要凭据的外部适配器必须使用官方 CLI 或凭据代理。

### `quality.gates.<id>.env`

- 类型：字符串到字符串的对象；选填；默认 `{}`。
- 语义：固定的非敏感环境变量，值写入配置快照并参与 `configDigest`。
- 安全：疑似 Token、密码、私钥和证书内容校验失败，不能通过此字段注入。

## 4. Publish Target 字段（M2）

### `publishing.targets.<id>.type`

- 类型：枚举；必填；允许 `issue-sync`、`knowledge`。
- `issue-sync`：任务来源和执行协同，只处理 Issue 状态、评论、标签及验证摘要。
- `knowledge`：需求或 Bug 的知识沉淀，生成稳定页面并回读验证。

### `publishing.targets.<id>.adapter`

- 类型：执行器 ID 字符串；必填。
- M2 只允许随包发布的 `builtin.*` 适配器；第三方适配器从 M3 开始按 `unsandboxed` 扩展处理。

### `publishing.targets.<id>.enabled`

- 类型：布尔值；必填。
- `false`：引用该 Target 的 Engine-owned publish Stage 进入 `skipped`，不执行外部写入。
- `true`：Stage 正常执行并使已验证 Work Item 进入 `pending_publish`。`issue-sync` 还要求 Work Item 存在 `bindings.issue`，否则同样 `skipped`。
- 安全：该字段只允许引擎准备 External Action Request，不代表用户已经授权任何远端写入。

### `publishing.targets.<id>.required`

- 类型：布尔值；必填。
- 语义：为 `true` 时确定失败会阻止关闭；为 `false` 时确定失败产生 `succeeded_with_warnings`，不阻止关闭。
- 交互拒绝：可选 Target 为 `skipped`；必需 Target 为 `failed` 并阻止关闭。
- 安全：外部结果未知不受此字段放宽，始终进入 `reconciliation_required`。

### `publishing.targets.<id>.readBack`

- 类型：布尔值；必填；M2 必须为 `true`。
- 语义：写入后重新读取远端对象并校验稳定标识和内容摘要。

### `publishing.targets.<id>.settings`

- 类型：对象；选填；默认 `{}`。
- `issue-sync` 允许 `updateState`（布尔值）和 `commentMode`（`none`、`summary`、`detailed`）。
- `knowledge` 允许 `space`、`parent`、`titleTemplate` 字符串，以及 `stableKeyStrategy`（允许 `work-item`、`source-issue`）。选择 `source-issue` 但没有 Issue Binding 时校验失败，不静默退回其他策略。
- 所有设置由对应内置 Adapter Schema 校验，禁止未知字段和凭据值。

## 5. CI Policy

`.wsspec/ci-policy.yaml` 只授权非交互验证，不得批准工件、外部写入或高风险 Git 操作：

```yaml
version: 1
allowGates: [test, lint, typecheck, build]
```

- `version`：整数，v1 仅允许 `1`。
- `allowGates`：Gate ID 数组，只能引用快照配置中 `evidence: trusted` 的 Gate。
- 未列出的 Gate、任何交互式审批、发布、push、合并和删除操作在 CI 模式中默认拒绝。

## 6. 通用规则

- 所有对象默认 `additionalProperties: false`。
- 配置中的路径先规范化，再检查是否位于允许边界内。
- 配置不能包含凭据值；错误必须指出字段路径但不能回显疑似秘密。
- 质量命令、固定环境、工作目录和超时共同参与 `configDigest`；任一变化都会使旧证据失效。
- M2/M3 字段在对应能力尚未安装时返回 `WSPEC_FEATURE_NOT_AVAILABLE`，不能静默忽略。
