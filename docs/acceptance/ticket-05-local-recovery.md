# Ticket 05 文档 Workflow 本地恢复证据

## 证据范围

本记录仅是 **local-automated** 证据。所有执行均在隔离 Git 仓库、Node 测试和本地 fixture 中完成；没有调用外部宿主、Provider 或平台，不能视为真实宿主、GitHub、GitLab 或飞书 Connector/平台证据。

Foundation 基线为 `8b15381`。本次不改动 Application Protocol、Workflow/Skill snapshot、Artifact authoring 合同、文档路径策略或运行时代码；仅补齐 public-seam 本地恢复断言与其可观测的 fixture 结果。

## 覆盖结果

`tests/e2e/documentation-workflow.test.ts` 的 `Documentation stays inside its immutable path, records trusted integrity, and resumes without TDD state` 覆盖：

- `start -> acquire -> submit -> inspect` 生命周期，以及需求来源、探索、编辑、验证和 Review 的 Artifact 引用；Artifact 由 Attempt-scoped helper 写入并由 Work Package 的 required output 绑定。
- `verify-document:gate:docs.integrity` 的 trusted、passed 证据，并在 Close 后确认 Work Item 已关闭。
- Review-Fix 后损坏 `runtime.json`，再以新 Application 实例执行 `inspect + acquire`；恢复继续 commit Attempt，并保留快速 Profile 与 Review-Fix 状态。
- 恢复前后逐字节比较 `application.json`、`workflow.lock.json` 和 `skill.lock.json`，证明冻结 Workflow、Skill、输出与 Artifact authoring 合同没有变化。
- 文档路径策略继续拒绝 production、script、dependency 和 build 修改；恢复投影不含功能 `write-tests`、`verify-red`、`implement`、`verify-green` stage 或 `tdd:` evidence。

## 执行证据

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test tests/e2e/documentation-workflow.test.ts` | PASS，1/1。 |

## 结论

Ticket 05 的三项 checklist 已由 local-automated 证据闭合。真实宿主或真实平台验收仍需按各自 Evidence Tier 独立执行，不能由本记录替代。
