---
name: bugfix-diagnosis
description: 用于 bugfix-delivery 的只读 explore：从故障原文定位根因，将最小修复与回归验证合成 tasks。
---

# 故障诊断与修复计划

输入为 `requirement-source` 和当前仓库，交付物只有 `tasks`。独立 PRD、`specification`、`design` 和 `exploration-report` 不是此流程的前置或输出。

1. **确认故障**
   读取原文、相关调用链、配置和已有测试，区分预期行为与实际行为。记录复现条件、证据路径和影响范围。只读检查现有日志或已有运行结果；需要修改文件、安装依赖或产生测试产物的复现留给后续 write-tests / verify-red。
2. **定位根因**
   说明证据支持的故障机制和最小修复位置。未证实的根因明确标为假设并记录如何验证；预期行为或授权不明确时列出具体阻塞，不编造复现成功。
3. **合并计划**
   把回归测试和最小修复作为同一任务，列明文件范围、依赖、失败断言、可信 Test Gate 与完成条件。只读阶段记录计划，后续 write-tests / verify-red 产生真实 Red，再由 implement / verify-green 验证 Green。
4. **交付 tasks**
   使用下方结构化格式，将示例占位文字替换成项目事实。每项保留 id、status、dependencies、completion；初始状态为 pending 或 blocked。任务包括已确认预期行为及证据，使后续实现和审查无需额外规格文档。风险同时写入 SubmitResult.remainingRisks 的结构化对象，供引擎收敛 Profile。

此步仅可写 Work Package 授权的 Artifact 草稿，保持项目文件不变。缺少真正影响修复的事实才列阻塞，不为不存在的流程产物制造前置条件。

## 任务

```yaml
tasks:
  - id: fix-reported-behavior
    status: pending
    dependencies: []
    symptom: "实际行为及触发条件（替换为故障原文）"
    expectedBehavior: "预期行为及其确认来源"
    evidence: ["仓库相对路径和关键符号，或已有复现结果"]
    rootCause: "已证实机制；未证实时标明假设及验证办法"
    affectedPaths: ["需要新增回归测试及最小修复的路径"]
    regression: "Given/When/Then；原问题应触发的失败断言"
    verification: "项目已配置的 Test Gate 和必要的相关回归"
    completion: "回归测试先由 verify-red 证实断言失败，最小修复后同一 Gate 通过，预期行为恢复且相关回归通过"
```
