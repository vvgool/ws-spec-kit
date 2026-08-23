# 06: 取得真实 Agent 宿主验收证据

**What to build:** 发布维护者能够分别为 Codex、Claude、Cursor 收集可审计的真实宿主证据，证明 Driver 发现或显式调用、跨会话恢复、提交和 verifier 均发生在独立真实会话中；无法执行的宿主明确保持 NO-GO。

**Blocked by:** 04: 验证功能 Workflow 的本地可恢复闭环; 05: 验证文档 Workflow 的本地可恢复闭环.

**Status:** ready-for-agent

- [ ] 每个可用宿主在隔离 fixture 上产生脱敏、可回读的真实会话证据，覆盖 Driver 调用、`inspect + acquire` 恢复、提交和 verifier 结果。
- [ ] 证据将自动化 fixture、历史观察与发布级真实宿主结果明确分层，缺少客户端或认证时记录为 NO-GO 而不模拟通过。
- [ ] 宿主验收不改变 Foundation 冻结的 Application Protocol 或 Artifact authoring 边界。
