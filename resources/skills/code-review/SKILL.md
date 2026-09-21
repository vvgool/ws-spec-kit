---
name: code-review
description: 审查实现。用于 review：同时看 Standards 与 Spec，按严重级别列出问题。
---

# 审查代码实现

两条轴一起看：代码是否符合本仓标准，以及是否兑现当前规格。

## 步骤

1. **钉范围**
   先读当前 Workflow、`tasks` 与本次 diff。feature-delivery 对照已有 `specification` 及启用时的 `design`；bugfix-delivery 对照 `requirement-source`、诊断 `tasks` 中的预期行为、根因和回归证据。未在当前 Workflow 产生的规格或设计文档不作为审查前置。完成：审查边界等于 Work Package 允许路径。

2. **Spec 轴**
   对照当前流程已确认的行为检查 diff：功能实现是否兑现规格，故障修复是否恢复 tasks 中的预期行为并有回归证据；有没有多做没要的。完成：每条验收行为要么已兑现，要么是一条 finding。

3. **Standards 轴**
   看 seam 是否变浅、测试是否钉行为、错误是否 fail closed、有没有密钥或越权写入。完成：每个问题都能指到文件。

4. **交 `review-result`**
   按严重级别排序；能合并的合并。完成：`approved` 仅在两条轴都无必须修的问题时为真。

## 规则

- 风格偏好不是 finding。缺证据的怀疑标成问题，不当批准。
- 不改代码。修复走 bug-fixing。
- 证据不足：停止并报告阻塞。
