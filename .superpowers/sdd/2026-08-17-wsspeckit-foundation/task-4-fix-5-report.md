# Task 4 Fix Round 5 Report

## 状态

DONE

## RED 证据

- Project Loader 使用设计稿原始完整 Workflow 时，因缺少设计未声明的 `gates/changePolicy` 返回 `WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID`。
- Project Loader 拒绝 Artifact 策略、`independentReviewActor`、发布回读和审计策略字段；Builtin Catalog 同时放过 Workflow/Profile 的顶层与递归 unknown/type。
- Builtin Catalog 放过 `catalog.yaml` 顶层 unknown；内嵌 Skill unknown 和 workflows 错误类型没有稳定 Catalog 运行时边界。
- Project 的 `.wsspec` 或 `workflows` 链接到项目外现存目录时，Package 被成功加载；Builtin Catalog 的 `workflows` 外链同样被接受。
- stale 空/半写 final lock 永久拒绝恢复；fresh dead owner lock 被立即清除，没有 stale 阈值。

## 修复摘要

- 新增唯一导出的 `parseWorkflowV1()` / `parseProfileV1()`，Project Loader 与 Builtin Catalog 共用；Catalog 自身也逐层严格解析，不再使用 TypeScript `as` 作为运行时协议。
- Workflow v1 只要求 `version/workflow/inputs/steps`，省略 `gates` 时规范化为 `[]`，省略 `changePolicy` 时保持 `undefined`。
- Profile v1 补齐按 Artifact id 的 `required/contentLevel`、`independentReviewActor`、发布回读和审计 retention/decision/approval/actor/publishing 策略；六份内置 Profile 均显式声明。
- 新增共享 canonical path boundary，逐级验证 Project root、`.wsspec`、`workflows`、Package，以及 Builtin resources、workflows/skills；现存或悬空越界符号链接均 fail closed。
- Workflow trust lock 改为同目录唯一 temp `open("wx")`、写 owner、fsync、`link(temp, final)` 原子争抢，final 不再先以空文件出现；正常与并发路径清理自身 temp。
- 显式恢复仅处理 mtime 超过 30 秒的锁；两次比较 bigint `dev/inode/mtimeNs/size`，fresh 损坏锁拒绝，本机 live owner 不抢，stale dead/远端不可验证/损坏 owner 可恢复；owner schema 精确匹配，无旧格式迁移读取。

## 历史 Findings 自审

| Finding | 状态 | 本轮证据 |
|---|---|---|
| C1-C2 | CLOSED | Builtin 完整快照、Map 篡改和 Package Skill 递归摘要原测试继续通过。 |
| I1 | CLOSED | 单 journal、actor/channel、时间、幂等、冲突和跨进程测试继续通过。 |
| I2 | CLOSED | 两条入口共用唯一 v1 parser，并运行相同正反例矩阵。 |
| I3 | CLOSED | 可选根与递归 ENOENT、Skill 入口测试继续通过。 |
| I4 | CLOSED | 设计原始完整 fixture、Catalog nested unknown/type、根 symlink、锁中断与并发可见性矩阵均已覆盖。 |
| M1 | CLOSED | Manifest/Workflow/Profile 缺失稳定错误码测试继续通过。 |
| M2 | CLOSED | final lock 原子发布；fresh/stale 空锁、半写锁、dead/remote/live owner 和并发发布测试通过。 |
| N1 | CLOSED | 可选 Workflow 顶层策略与完整 Profile 策略均由正式 v1 parser/types/resources 表达。 |
| N2 | CLOSED | Project 与 Builtin 每级 lexical/realpath containment 覆盖现存和悬空外链。 |

## 验证结果

全部在 `PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH` 下执行：

- Task 4 专项：48 passed，0 failed。
- `npm run typecheck`：passed。
- `npm test`：145 passed，0 failed。
- `npm run build`：passed。
- `git diff --check`：passed（无输出）。

## Commit

本报告与 Task 4 fix round 5 的代码、正式资源和测试位于同一个独立提交。

## 未解决项

无。未修改 Task 5+，未加入旧格式兼容或迁移读取。
