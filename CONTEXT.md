# WSSpecKit

Agent 驱动的软件交付工作流引擎。控制面把需求、Workflow、Skill 和执行状态绑到 Work Item。

## Language

**Test Gate**:
Project Config 里声明的、用于产生可信 TDD Evidence 的固定测试命令与 `node-test` reporter。
_Avoid_: test command, npm test, quality gate

**Application Snapshot**:
Work Item 创建时冻结的编译后 Workflow、Skill 选择、配置和来源执行合同。Workflow 与 Skill 正文由 Lock 绑定当前来源，不随 Work Item 复制。
_Avoid_: live config, current config

**Work Item**:
可恢复的交付执行单元，先独立记录需求、执行合同和 Artifact；是否拥有 Git Worktree 取决于后续 Step 是否需要隔离写入。
_Avoid_: worktree, branch

**Read-only Step**:
只读取当前项目上下文并产出 Artifact、不修改仓库的 Workflow Step。它不要求为 Work Item 创建 Git Worktree。
_Avoid_: exploration worktree

**Worktree Materialization**:
Work Item 首次进入需要隔离写入的 Step 时，在控制面锁内创建专属 branch 和 Git Worktree，并固定后续写入与恢复边界。
_Avoid_: lazy checkout, shared workspace
