# Ticket 04 本地恢复证据

## 证据范围

本记录仅是 **local-automated** 证据。所有来源均为隔离 Git 仓库、Node 测试和本地 fixture；`local-fixture`、`local:issue` 与 `feishu:targetDocumentToken123` 仅为受控模拟标识，不能视为真实宿主、GitHub、GitLab 或飞书 Connector/平台证据。

Foundation 基线为 `8b15381`。本次只增加 public-seam 测试与证据记录，不改动 Application Protocol、Workflow/Skill snapshot、Artifact 合同或运行时代码。

## 覆盖结果

`tests/e2e/governed-workflow.test.ts` 的 `Governed local automated recovery preserves frozen contracts through Review-Fix retry` 覆盖：

- `start -> acquire -> submit -> decide -> inspect` 五个生命周期操作，并在其间使用保持为 Attempt 作用域辅助能力的 `artifact create`。
- 来源与 Work Item 投影、specification/tasks Artifact 引用、可信 Red/Green TDD cycle、第一次 Review 拒绝后的 Fix 与第二次 Review 通过。
- Git commit、issue update、knowledge publish、issue close 的本地审批和回读 fixture，最终进入 Close。
- Review-Fix 的 `review-fix:1:fix` 处破坏 `runtime.json` 后，以新 Application 实例执行 `inspect + acquire`；恢复产生新 Attempt，并保留 TDD 证据与 Loop 状态。
- 恢复前后逐字节比较 `application.json`、`workflow.lock.json` 和 `skill.lock.json`，证明 Lease/Attempt 恢复不改变冻结的 Workflow、Skill、输出合同或既有 Artifact 引用。

## 执行证据

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test tests/e2e/governed-workflow.test.ts` | PASS，3/3。 |

首次刻意使用同一 reviewer 进行两轮审阅时，测试在第二轮被 active Lease actor 保护而阻断；将第二轮改为独立 reviewer 后通过。这是 fixture 对受治理独立审阅与 Lease 边界的确认，不是运行时缺陷，也未改变生产行为。

## 结论

Ticket 04 的三项 checklist 已由本地自动化证据闭合。真实宿主与真实平台验收仍必须按其独立 Evidence Tier 执行，本记录不提升这些状态。
