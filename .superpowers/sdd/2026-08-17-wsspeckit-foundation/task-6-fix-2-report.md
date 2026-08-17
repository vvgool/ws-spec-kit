# Task 6 Parent Review Fix Round 2 Report

## 状态

DONE

修复基线：`66421be fix: enforce workflow compiler policy guarantees`。

## Finding Closure

### Important 1：显式 Workflow 必须决定失效图

- `RiskEvaluationInput.workflow` 从可选字段改为必填的 `feature | documentation-only`。
- 风险评估入口在处理规则前执行运行时校验；缺失或未知值以 `WSSPEC_RISK_WORKFLOW_INVALID` 和 `/workflow` fail closed。
- 文档路径启发式只保留为 low/quick 风险证据，不再覆盖显式 Workflow kind。
- feature 始终使用 feature 失效图，documentation-only 始终使用 documentation 失效图；内置与自定义规则只能决定风险、最低 Profile 和匹配证据。

## TDD Evidence

- RED：profile-policy suite `10 passed / 4 failed`。
  - feature + 文档路径的 quick、内置 governed、自定义 governed 三个用例错误返回 documentation 失效图。
  - 缺失或未知 Workflow 未抛出稳定错误。
  - documentation-only + 敏感路径对照用例保持通过，确认风险提升与 Workflow kind 可以独立变化。
- GREEN：profile-policy suite `14 passed / 0 failed`。

## Final Verification

全部命令使用：

```sh
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH
```

- focused profile-policy：`14 passed / 0 failed`。
- focused compiler/profile：`50 passed / 0 failed`。
- `npm run typecheck`：passed。
- `npm test`：`223 passed / 0 failed / 0 skipped`；包含 packed clean-consumer 与 CLI E2E。
- `npm run build`：passed。
- `git diff --check`：无输出。

## Scope Boundary

本报告仅关闭 `task-6-parent-re-review-1.md` 的 round 2 单项 Important finding。它证明风险评估不会再由路径启发式替换显式 Workflow 失效图；不扩大到 Runtime 的 Profile 升级装配或完整产品/生产 GO。
