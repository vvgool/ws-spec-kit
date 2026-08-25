---
name: code-review
description: 审查实现。用于 review：同时看 Standards 与 Spec，按严重级别列出问题。
---

# 审查代码实现

两条轴一起看：代码是否符合本仓标准，以及是否兑现当前规格。

## 步骤

1. **钉范围**
   读 `specification`、`design`、`tasks` 和本次 diff。完成：审查边界等于 Work Package 允许路径。

2. **Spec 轴**
   规格里的行为在 diff 里有没有落地；有没有多做没要的。完成：每条规格要么已兑现，要么是一条 finding。

3. **Standards 轴**
   看 seam 是否变浅、测试是否钉行为、错误是否 fail closed、有没有密钥或越权写入。完成：每个问题都能指到文件。

4. **交 `review-result`**
   按严重级别排序；能合并的合并。完成：`approved` 仅在两条轴都无必须修的问题时为真。

## 规则

- 风格偏好不是 finding。缺证据的怀疑标成问题，不当批准。
- 不改代码。修复走 bug-fixing。
- 证据不足：停止并报告阻塞。
