# GitLab 真实 Connector 验收记录

## 当前状态

- Provider：GitLab CLI (`glab`)
- Host-scoped authentication：已由 `glab auth status` 确认；Doctor 的非 host-scoped 检查因默认 `gitlab.com` 未认证而误报失败。
- 受治理运行：`WSS-01M0S8S3CXJ1Q7M9TWMG3WE03A` / `external-request-9c05777fdc6844ab58698afe49db4e40aba632c32e5f8e5f42deaaf3122d10aa` 对 `gitlab:892` 请求 `issue.comment`，内容仅记录摘要 `sha256:2b3123f714d6cec7092fa66136b74333e9d1945a812b7f4557c7260a67715fef`。
- 生命周期：首次 submit 为 `await_approval`，精确审批为 `exact-approved`；同一请求的第二次 submit 为 `reconciliation_required`，公开 reconcile 后仍为 `reconciliation_required`。
- 回执：`absent-unverified`，`receiptCount: 0`；没有记录或声称任何 effect ID。
- 验收状态：**NO-GO，需对账**

该记录不包含原始 comment body、payload、凭据或 effect ID。未知效果不得自动重发，必须先完成可审计对账；不得改用未建模的 HTTP Provider，也不得绕过精确写入授权。

## 真实验收前置条件

安装并经批准后，仍必须先获得并脱敏记录：已验证认证、专用非生产 Issue/Project 稳定目标、针对该动作与内容摘要的明确写入授权、幂等键、写后回读摘要、未知结果时先对账再重试的证据，以及不含 Token、Cookie、路径或敏感正文的审计回执。

本地 GitLab fixture 仅覆盖 Connector 契约和恢复语义，不能提升为真实 GitLab PASS。
