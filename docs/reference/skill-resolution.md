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

若同一 Global URI 在多个逻辑根中解析为不同摘要，解析失败 `WSSPEC_SKILL_AMBIGUOUS`；找不到必需 Skill 返回 `WSSPEC_SKILL_NOT_FOUND`。不合法 URI、路径或脱离根的符号链接分别返回 `WSSPEC_SKILL_REF_INVALID`、`WSSPEC_SKILL_PATH_INVALID`、`WSSPEC_SKILL_PATH_ESCAPE`。Global 主项可以有 Builtin fallback，其他来源不可降级。

## 3. Lock 与恢复

Skill Lock v1 固定 requested/resolved URI、source、provider、逻辑 root、摘要、候选集、required 标记与 primary/fallback 选择。恢复或后续 `acquire` 必须重新计算这些事实；已选摘要或候选集漂移时返回 `WSSPEC_SKILL_LOCK_CHANGED`，不得静默选择新内容。无效 Lock 返回 `WSSPEC_SKILL_LOCK_INVALID`。

Workflow Package 自身的 `workflow.lock` 还锁定 Package 文件和 `package://skills/<name>` 内容。它与 Skill Lock 共同保证新 Agent 会话读取的是同一份已批准的执行说明，而不是将旧公开协议转换到新格式。
