# 07: 取得真实 Connector 平台验收证据

**What to build:** 发布维护者能够在专用 GitHub、GitLab 和飞书测试目标上证明受治理 Connector 的真实行为：认证预检、精确授权写入、幂等、回读与失败处理均留下脱敏、可审计证据。

**Blocked by:** 04: 验证功能 Workflow 的本地可恢复闭环; 05: 验证文档 Workflow 的本地可恢复闭环.

**Status:** blocked-no-go

- [ ] 每个可用平台独立记录只读预检、授权写入、稳定目标、幂等键、回读摘要和失败路径；Fixture 不能代替真实平台结果。**NO-GO：** GitHub 与飞书仍为 `available-unverified`、未运行；GitLab 已确认 host-scoped authentication 并运行至 `reconciliation_required`，但没有回读或回执，不能通过。
- [x] 未安装、未认证或无测试目标的平台明确记录为 NO-GO，不切换到未建模的 Provider 或绕过授权。**已记录：** GitHub 与飞书为 `not-run-no-go`；GitLab 的 Doctor 默认 `gitlab.com` 检查是非 host-scoped false negative，实际 host auth 已确认，但稳定目标/回读/回执尚未完成。
- [x] 外部未知结果进入协调回查或显式处理，不自动重发可能已发生的写入。**已核对：** `WSS-01M0S8S3CXJ1Q7M9TWMG3WE03A` 的首次 submit 为 `await_approval`、精确审批后第二次 submit 为 `reconciliation_required`，公开 reconcile 后仍为 `reconciliation_required`；`receiptCount: 0`，不记录 effect ID、原始正文或载荷。
