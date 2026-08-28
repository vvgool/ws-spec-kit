# 按需物化 Worktree

Work Item 默认不立即创建 Git Worktree；只读探索、澄清、设计和计划阶段使用当前项目上下文并禁止仓库写入，首次进入需要隔离写入的 Step 时才在控制面锁内物化专属 branch 和 Worktree。已有 Work Item 保持现有 Worktree 不迁移，纯只读任务关闭时不创建 Git 资源。这样可以避免探索任务承担实现任务的 checkout 成本，同时保留写入、并发、恢复和提交所需的隔离边界。

## Considered Options

- 创建 Work Item 时立即创建 Worktree：隔离边界简单，但纯探索任务成本过高。
- 复用当前 checkout：资源成本低，但无法可靠隔离并发修改、用户未提交内容和 Git 提交边界。
- 按需物化 Worktree：作为默认方案，按 Step 的 `read-only` 或 `isolated-worktree` 能力声明切换。

## Consequences

- Work Item 与 Worktree 不再是一一对应关系，执行合同必须能表示尚未物化的 Worktree。
- 只读 Step 的提交必须证明没有仓库修改；写入 Step 必须在物化后的 Worktree 中执行。
- 物化必须是控制面锁内的幂等操作，避免并发 Agent 创建多个 Worktree。
