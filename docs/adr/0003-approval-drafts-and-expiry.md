# ADR 0003：审批草稿隔离与明确过期恢复

状态：已采纳（2026-09-17，用户确认修复）

## 已验证问题

未物化 Worktree 的只读步骤在项目根目录执行，审批时创建 `.wsspec/work-items/<id>/drafts/decision.json` 被算作工作区变化，导致该审批自身过期。原 `decide` 自动获取新 Attempt 并返回 execute，Host 误认为批准成功，继而复用旧产物触发生产者身份不匹配。

## 决定

仅普通步骤审批使用版本 2 工作区摘要：排除当前 Work Item 自有 drafts 子文件。业务文件、配置、其他 Work Item 草稿和一般工作区摘要保持原规则；正式 Artifact 独立校验引用、生产者和内容摘要。旧请求缺少版本标记时继续使用原算法，不能自动重算历史绑定。

真正过期后标记原审批 expired，重置步骤并返回 blocked / WSSPEC_APPROVAL_EXPIRED，明确本次批准未生效。decide 不自动领取下一 Attempt；Driver v11 展示原因后通过 inspect -> acquire 恢复，在新 Attempt 下重新生成与提交产物，再请求新确认。外部动作恢复仍仅在 resumeSubmission 为 true 时复用原 SubmitResult。

## 验收

真实 CLI 从未物化 Worktree 的流程创建审批输入并批准后进入 design；业务修改触发明确过期，恢复和重新确认后也能进入 design。验证草稿排除只限当前 Work Item、一般工作区摘要不变、旧请求算法保留，原有 Artifact、权限及外部动作校验继续通过。
