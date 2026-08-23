# 02: 固化 Attempt 作用域 Artifact authoring 闭环

**What to build:** Agent 从 `acquire` 返回的 `execute` Work Package 取得 Artifact authoring 合同，在受限草稿目录创建正式 `ArtifactRef`，随后由 `submit` 仅消费该引用并验证所需输出；该流程在恢复后仍保持同一 Attempt 语义。

**Blocked by:** 01: 冻结五操作 Application Protocol.

**Status:** ready-for-agent

- [ ] Artifact authoring 仅接受与活动 Claim、Attempt、Lease、Work Package 和输出合同完全匹配的请求。
- [ ] 路径逃逸、符号链接、非普通文件、读取中变化、错误输出身份或失效 Lease 均被拒绝，成功结果为不可变 `ArtifactRef`。
- [ ] `submit` 不读取草稿或正文，只接受符合 `requiredOutputs` 的 Artifact 引用，并支持 author 成功后提交失败的安全重试。
