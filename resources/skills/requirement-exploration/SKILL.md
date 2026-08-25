---
name: requirement-exploration
description: 探索代码与需求。用于 explore/clarify：grill 未决决策、从仓库取事实、写出规格。
---

# 探索代码与需求

事实从仓库取；决策问用户。未证实的业务当缺口，不当规格。

## 步骤

1. **读 Work Package**
   记下 `requiredOutputs`、允许路径、已有 Artifact。完成：能复述本步要交的 `outputId`。

2. **取事实**
   顺着调用链读现有模块、配置、测试和 Issue/规格原文。完成：每条约束都能指到文件或原文，没有猜的 API。

3. **摊 frontier**
   一次列出所有已解锁、必须人答的决策。完成：没有「先假设再继续」的开放问题。

4. **交产物**
   - explore：写 `exploration-report`（现状、约束、缺口、风险信号）。
   - clarify：只把已确认事实写成 `specification`。
   完成：产物覆盖 `requiredOutputs`，缺口标成阻塞而不是默认值。

## 规则

- 一轮问完当前 frontier，等答复再写规格。
- 风险信号（外部写入、密钥、跨仓、破坏兼容）写进报告，供 Profile 升级，不在这里改档。
- 缺授权、缺原文或路径越界：停止并报告阻塞。
