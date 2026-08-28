# Skill 解析与锁定参考

Skill Resolver 按显式 URI 解析可执行说明，并将选择结果快照到 Work Item。它不持有 Agent 的上下文、Token、模型或对话历史。

## 1. URI 与四类来源

支持 `builtin`、`package`、`global`、`project` 四类来源。除 `global` 外，URI 必须是 `<source>://skills/<name>`；路径段只允许小写字母、数字和连字符。内置 Skill 包括：

- `builtin://skills/requirement-exploration`
- `builtin://skills/solution-design`
- `builtin://skills/task-planning`
- `builtin://skills/tdd-implementation`
- `builtin://skills/code-review`
- `builtin://skills/bug-fixing`
- `builtin://skills/documentation-exploration`
- `builtin://skills/documentation-editing`
- `builtin://skills/documentation-review`

```yaml contract=skill-lock-v1
version: 1
skills:
  - requested: builtin://skills/tdd-implementation
    resolved: builtin://skills/tdd-implementation
    source: builtin
    provider: codex
    rootId: builtin
    digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    candidates:
      - rootId: builtin
        digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    required: true
    selection: primary
    selected:
      ref: builtin://skills/tdd-implementation
      source: builtin
      provider: codex
      rootId: builtin
      digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

## 2. Provider 根目录与选择

`codex` 的默认 Global 根为 `.agents/skills`，`claude` 为 `.claude/skills`，`cursor` 依次检查 `.agents/skills`、`.cursor/skills`、`.claude/skills`、`.codex/skills`，`generic` 不预设 Global 根。项目根固定为 `.wsspec/skills`；Package 根固定为 Package 声明的 `skills/`。所有文件在真实路径规范化后必须留在所属根内。

当前宿主在工作树的 `.wsspec/config.yaml` 中以稳定 `id` 和本机 `path` 绑定附加 Global 根：

```yaml contract=schema:builtin.application-project-config.v1
version: 1
skills:
  additionalGlobalRoots:
    - id: team-skills
      path: ~/company/skills
```

`id` 必须在项目配置中唯一且跨宿主保持不变；`path` 可以随 HOME 或机器布局变化。Resolver 将该绑定规范化为 `<provider>:additional:<id>`，例如 `codex:additional:team-skills`。这个逻辑 root ID 进入候选集和 Skill Lock，本机路径只用于当次解析。

若同一 Global URI 在多个逻辑根中解析为不同摘要，解析失败 `WSSPEC_SKILL_AMBIGUOUS`；找不到必需 Skill 返回 `WSSPEC_SKILL_NOT_FOUND`。不合法 URI、路径或脱离根的符号链接分别返回 `WSSPEC_SKILL_REF_INVALID`、`WSSPEC_SKILL_PATH_INVALID`、`WSSPEC_SKILL_PATH_ESCAPE`。Global 主项可以有 Builtin fallback，其他来源不可降级。

## 3. Lock 与恢复

Skill Lock v1 固定 requested/resolved URI、source、provider、逻辑 root、摘要、候选集、required 标记与 primary/fallback 选择。`start` 写入 Work Item 时，配置快照只保留附加根 `id`，Application Snapshot 只保留 `additionalGlobalRootIds`；Skill Lock、事件和其他快照也不得持久化 HOME、本机绝对路径或 `path` 绑定。

恢复或后续 `acquire` 会从当前宿主 checkout 的 `.wsspec/config.yaml` 按快照中的 `id` 重新绑定 Global `path`，并从 Work Item worktree 重新解析 Builtin、Package 与 Project Skill，再重算候选集和摘要。当前宿主缺少某个绑定时返回 `WSSPEC_GLOBAL_ROOT_NOT_CONFIGURED`；任一已选来源、摘要或候选集漂移时返回 `WSSPEC_SKILL_LOCK_CHANGED`，不得静默选择新内容。无效 Lock 返回 `WSSPEC_SKILL_LOCK_INVALID`。

Workflow Package 自身的 `workflow.lock` 还锁定 Package 文件和 `package://skills/<name>` 内容。后续 `acquire` 从 Work Item worktree 重新加载 Package 并比对 Workflow Lock；来源缺失或漂移时返回 `WSSPEC_WORKFLOW_SNAPSHOT_CHANGED`。它与 Skill Lock 共同保证新 Agent 会话只在已批准的执行说明仍可验证时继续，而不是将旧公开协议转换到新格式。
