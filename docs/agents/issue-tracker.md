# Issue 追踪器：本地 Markdown

本仓库的 Issue 和规格以 Markdown 文件形式存放在 `.scratch/` 中。

## 约定

- 每个功能使用一个目录：`.scratch/<feature-slug>/`。
- 功能规格位于 `.scratch/<feature-slug>/spec.md`。
- 实现任务在 `.scratch/<feature-slug>/issues/<NN>-<slug>.md` 中一任务一文件，从 `01` 开始编号。
- 分诊状态记录在每个 Issue 文件顶部的 `Status:` 行中；角色字符串见 `triage-labels.md`。
- 评论和沟通历史追加在 `## Comments` 标题下。

## 发布

当技能要求发布到 Issue 追踪器时，在 `.scratch/<feature-slug>/` 下创建所需的 Markdown 文件。
