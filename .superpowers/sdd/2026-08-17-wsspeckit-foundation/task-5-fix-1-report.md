# Task 5 Fix Round 1 Report

## 状态

DONE

## RED 证据

全部测试均在 `PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH` 下执行。

- 首轮新增 review 回归后，Task 5 聚焦测试共 25 个：19 passed、6 failed。失败分别证明 Project `.wsspec/skills` 根可越界、合法 fallback 转换被阻塞、fallback 漂移被接受、严格 Lock parser 缺失、畸形 Lock 被接受、伪造 `ResolvedSkill` 可进入构造入口。
- 第二轮 RED 证明已锁主项切换到 fallback 后重新生成 Lock 时，原主项摘要与候选会丢失。
- 自审追加三条边界 RED：主项命中时缺失的显式 fallback 被忽略；Lock parser 接受既无主项也无 fallback 的空解析条目；started Step 在没有既有 Lock 时可首次选择 fallback。三条分别以 `Missing expected rejection/exception` 失败。

## 修复摘要

- Project Resolver 先以 canonical `projectRoot` 校验 `.wsspec`，再以 canonical `.wsspec` 校验 `skills`，最后保留 Skill 目录和入口的逐级 lexical + realpath containment；现存及悬空根外链均 fail closed。
- `SkillResolverContext` 强制声明 `stepStatus: "not_started" | "started"`。Lock 固定 requested 主项身份，不再持久化首次 selected 状态；主项摘要、候选与 fallback 身份分别锁定。
- 主项消失时，仅 `not_started` Step 可从已锁主项切到完全匹配的 fallback；started Step 只能继续使用原本已锁定的 fallback，不能无 Lock 首次选择，也不能从已锁主项切换。
- 主项仍可用时也解析并校验 Workflow 声明的 fallback；声明漂移、摘要漂移或 fallback 不可解析均 fail closed。合法切换后重新生成 Lock 会保留原主项摘要和候选。
- 新增导出的 `parseSkillLock(value: unknown)`：严格校验 v1 版本、递归未知字段、URI、Provider、来源、sha256、逻辑 rootId、候选一致性、主项/fallback 状态和重复 requested；不加入旧 Task 5 Lock 结构兼容读取。
- `resolveSkill()` 在消费 Lock 前统一调用严格 parser；`createSkillLock()` 严格校验公开 `ResolvedSkill` 输入，并对生成结果再次调用 parser，拒绝绝对/环境 rootId、正文、entrypoint 持久化和不一致状态。

## Findings 对照

| Finding | 状态 | 证据 |
|---|---|---|
| Critical 1：Project Skill 搜索根可整体越界 | CLOSED | `.wsspec` / `skills` x 现存/悬空外链真实文件系统矩阵通过。 |
| Important 2：Lock 阻塞合法 fallback 转换且不检查 fallback 漂移 | CLOSED | 主项锁定后消失、未开始/已开始分支、fallback 声明/摘要漂移、重新锁定保留主项测试通过。 |
| Important 3：公开 Lock 无严格运行时边界 | CLOSED | parser 递归负例、Resolver 输入解析、伪造构造输入与无效空状态测试通过。 |

## 验证结果

- Task 5 聚焦测试：27 passed，0 failed，0 skipped。
- `npm run typecheck`：passed。
- `npm test`：182 passed，0 failed，0 skipped。
- `npm run build`：passed。
- `git diff --check`：passed（无输出）。

## 范围审计

- 仅修改 Task 5 的 Skill types、Resolver、Lock、两份对应测试和本报告。
- 保留 Task 4 的 `WorkflowPackage` 正式接口与 loader，不修改 Task 6。
- Global Lock 不写 HOME 路径、环境值、Skill entrypoint 或正文。

## Commit

独立提交信息：`fix: harden skill locks and fallback transitions`。

## 未解决项

无已知 Task 5 未解决项。Work Item、事件与最终持久化路径的端到端集成属于后续任务，本轮只验证 Skill Lock DTO、Resolver 与构造/解析边界。
