# 04: 验证功能 Workflow 的本地可恢复闭环

**What to build:** 在隔离项目中，功能交付 Workflow 可以从需求捕获走到 Close，包含 TDD 可信证据、Review-Fix、Artifact、审批和新进程恢复；恢复后的 Agent 获得的 Work Package 与 Artifact 合同不被改变。

**Blocked by:** 03: 完成 Foundation 冻结门禁.

**Status:** ready-for-human

- [x] 功能 Workflow 在隔离仓库中形成可回读的需求、Artifact、Evidence、审批和 Work Item 投影，并在 Close 前满足既定质量要求。
- [x] 中断后由新进程执行 `inspect + acquire` 能恢复正确 Attempt，Lease 轮换不改变已冻结的 Workflow、Skill、输出合同或 Artifact 引用。
- [x] 失败、重试和 Review-Fix 路径具有可验证的状态与证据，且不会绕过可信 TDD Gate。

## Local Evidence

详见 `docs/acceptance/ticket-04-local-recovery.md`。该记录仅为 local-automated 证据，不是任何真实宿主或外部 Connector/平台证据。
