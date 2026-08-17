# Task 5 Fix Round 2 Report

## 状态

DONE

## RED 证据

全部测试均在 `PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH` 下执行。

第一轮先扩展真实 Resolver/Lock 生命周期测试并运行 `tests/integration/skill-lock.test.ts`：16 个测试中 12 passed、4 failed。

- `started` 主项命中且无 Lock 时没有拒绝，失败为 `Missing expected rejection`。
- 主项 Lock 和 fallback Lock 均没有 `selection`，实际值为 `undefined`。
- 包含合法 `selection/selected` 的新 Lock 被旧 parser 作为 unknown entry 字段拒绝。

第一轮 GREEN 后，单独增加合法字段重组篡改测试。当前 parser 接受了 selected ref、digest、provider/rootId 或 selection 与 baseline 不一致的 Lock，定向测试以 `Missing expected exception` 失败，证明组合校验尚未存在。

## 修复摘要

- `SkillLockEntry` 新增必填 `selection: "primary" | "fallback"` 和严格 `selected` 子对象；selected 记录实际执行项的 `ref/source/provider/rootId/digest`，同时保留 top-level requested 主项摘要/候选基线和 fallback 基线。
- `parseSkillLock()` 递归白名单解析 selection/selected，校验 URI、source、provider、逻辑 rootId 和 sha256；selection primary 必须有主项 baseline 且 selected 全字段匹配，selection fallback 必须有 fallback baseline 且 selected 全字段匹配，嵌套 unknown 字段拒绝。
- `createSkillLock()` 根据 `ResolvedSkill.usedFallback` 持久化 selection，并从实际执行项生成 selected；primary -> not_started fallback 的 re-resolved 结果重新锁定后会明确变成 selection fallback，同时保留历史主项 baseline。
- `resolveSkill()` 对 started Step 一律要求 Lock。selection primary 只恢复并校验主项；selection fallback 只恢复并校验 fallback，即使 Global 主项重新出现也不静默切回。
- 仅 `not_started` 且 Lock selection primary 的主项缺失时允许切换到已锁 fallback；切换后的 Lock 可在 started 状态稳定恢复。

## Finding 对照

| Finding | 状态 | 证据 |
|---|---|---|
| Important 1：relock 丢失 fallback 选择，started 恢复失败；started 主项可无 Lock 启动 | CLOSED | primary -> not_started fallback -> relock -> started 正例通过；started 主项/fallback 无 Lock 均拒绝；selection fallback 在主项恢复后仍执行 fallback；selected 组合篡改全部拒绝。 |

## 验证结果

- Task 5 聚焦测试：29 passed，0 failed，0 skipped。
- `npm run typecheck`：passed。
- `npm test`：184 passed，0 failed，0 skipped。
- `npm run build`：passed。
- `git diff --check`：passed（无输出）。

## 范围审计

- 仅修改 Task 5 的 Skill types、Lock、Resolver、Skill Lock 集成测试和本报告。
- 保留 Task 4 的 `WorkflowPackage` 接口与 loader，不修改 Task 6。
- Lock 继续不持久化 HOME 路径、环境值、entrypoint 或 Skill 正文。

## Commit

独立提交信息：`fix: persist active skill selection`。

## 未解决项

无已知 Task 5 未解决项。Work Item、事件与最终持久化路径的端到端集成仍属于后续任务。
