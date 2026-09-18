# ADR 0006：统一恢复建议与独立中断预算

状态：已采纳（2026-09-18，用户确认修复流程卡点）

## 决定

inspect 在现有恢复语义上增加当前步骤、预算和 nextAction，不产生新 Claim。recover 选择已有 retry-test-gate/revalidate-red 操作，内部仍核对绑定的 Attempt/Evidence ID；完成后返回 inspect 视图。无可自动恢复的情况明确返回 blocked/await_approval/reconcile 等建议，不自动批准、修改配置或重发外部请求。配置迁移仍要求明确的配置输入。

领取时保留现有 attemptsUsed 预占语义，真正执行失败结算为已用次数。running Attempt 因租约中断时仅退回本次预占，累加 interruptions；重复恢复不能重复退款。中断采用独立累计 20 次上限，达到后阻塞，不重置失败预算。旧事件没有该字段时按 0 读取；不推测历史失败是否曾为中断，不自动解锁已耗尽任务。完整审计事件仍保留真实领取次数。

## 验证

覆盖中断预算和失败预算独立计数、重复恢复、有限中断上限、旧投影兼容、公开 recover 自动重验、实现文件保留、耗尽状态不重置及原有恢复/审批合同。nextAction 只给建议，后续 acquire/恢复操作重新验证状态；不承诺建议等于可执行授权。
