# 06: 取得真实 Agent 宿主验收证据

**What to build:** 发布维护者能够分别为 Codex、Claude、Cursor 收集可审计的真实宿主证据，证明 Driver 发现或显式调用、跨会话恢复、提交和 verifier 均发生在独立真实会话中；无法执行的宿主明确保持 NO-GO。

**Blocked by:** 04: 验证功能 Workflow 的本地可恢复闭环; 05: 验证文档 Workflow 的本地可恢复闭环.

**Status:** blocked-no-go

- [ ] 每个可用宿主在隔离 fixture 上产生脱敏、可回读的真实会话证据，覆盖 Driver 调用、`inspect + acquire` 恢复、提交和 verifier 结果。**NO-GO：** 本次仅允许 `command -v`，Codex 和 Claude 缺失，未运行真实会话。
- [x] 证据将自动化 fixture、历史观察与发布级真实宿主结果明确分层，缺少客户端或认证时记录为 NO-GO 而不模拟通过。**已记录：** Cursor command 可用但未验证认证，且没有 signed auto/explicit/recovery receipts 或 verifier PASS。
- [x] 宿主验收不改变 Foundation 冻结的 Application Protocol 或 Artifact authoring 边界。**已核对：** 本次只更新脱敏验收记录和其矩阵校验，不修改 Protocol。
