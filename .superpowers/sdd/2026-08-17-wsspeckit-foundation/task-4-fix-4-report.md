# Task 4 Fix Round 4 Report

## 状态

DONE

## RED 证据

- 正式 `workflow: { id, version }` 根结构、完整 Profile overlay 与六份内置 Profile 在旧 parser/资源上失败。
- `Map.prototype.set.call()` 可修改真实 Builtin Package，旧 trust 判定仍返回 `trusted`。
- 主 journal 不含 requested 事件，TrustRecord 不含 requestId；重复同决定、跨进程返回、actor/channel、严格时间和损坏 journal 契约均失败。
- 旧简化 Workflow/Profile 格式仍会被接受，递归嵌套 unknown/type 无法被完整拒绝。

## 修复摘要

- Builtin trust 每次从 canonical builtin root 重新加载，并对完整规范快照比较；两个 Map 均按 key 排序，任何 Map 原型改写都会使 provenance 失效。
- 信任持久化统一为 `.git/wsspec/trust/workflow-packages.ndjson` append-only journal，只包含严格 `requested` / `decided` 事件；请求绑定 actor、interactive channel、两个摘要和有效时间，决定按 requestId 重放派生 TrustRecord。
- 决定追加在 owner lock 内完成并 fsync；相同决定幂等，冲突决定 fail closed；无效 ISO、`createdAt >= expiresAt`、过期、actor 不匹配、半行、未知事件或字段均拒绝。
- 非交互评估不创建请求；交互评估必须提供 actor 和 `interactive` channel；record 必须消费匹配的有效请求。
- `collectTreeFiles()` 仅顶层允许可选根不存在，递归 ENOENT fail closed；Skill 入口文件始终与遍历结果合并去重后进入摘要。
- Loader 只接受唯一正式 Workflow/Profile v1，递归解析全部设计字段、对象 Skill binding 和 control 子步骤，逐层拒绝未知字段与错误类型。
- 两个内置 Workflow、六个 Profile 和 Task 3 内置资源契约已同步到正式结构；旧简化格式没有兼容读取或迁移分支。

## 验证结果

- 专项：`node --import tsx --test tests/unit/workflow-package.test.ts tests/integration/workflow-package-trust.test.ts tests/contract/builtin-resources.test.ts`，39 passed，0 failed。
- Typecheck：`npm run typecheck`，passed。
- 完整测试：Node 22/npm 10 正确 PATH 下 `npm test`，136 passed，0 failed。
- Build：`npm run build`，passed。
- `git diff --check`：passed。

## Commit

本报告与 Task 4 fix round 4 代码、资源和测试位于同一个独立提交。

## 未解决项

无。
