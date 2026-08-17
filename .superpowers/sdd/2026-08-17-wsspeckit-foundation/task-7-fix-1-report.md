# Task 7 Parent Review Fix Round 1 Report

## 状态

DONE

修复基线：`3a8f48a feat: add the WSSpecKit application facade`。

## Parent Review Finding Closure

### P1 1：Global Skill Lock 在签发 Work Package 前复验

- Application Snapshot 记录初始解析时的 provider 和附加 Global Skill roots。
- 每次 `acquire` 在创建 Attempt、Lease 和 Work Package 前，按持久化 Skill Lock 重新解析全部 Global Skill。
- 当前选择被修改、删除或出现摘要不一致的新增候选时，以既有稳定 Skill Resolver 错误 fail closed，不会签发引用漂移 Skill 的 Work Package。

### P1 2：Submit 复用完整 Artifact Contract 验证

- `submit` 改为通过 `verifyArtifact()` 验证仓库边界、Artifact 类型、生产者身份、必需章节、结构化正文和内容摘要。
- 完整验证通过后再比对提交引用中的 schema version、规范路径、revision、content hash，以及调用方明确提供的 media type。
- 所有内置 Artifact 类型都有 malformed-body Application Submit 反例，不再只验证 metadata 和 hash 自洽。

### P1 3：Inspect 保持严格只读

- `inspect` 不再隐式调用控制面恢复，只读取并验证 Application 状态及当前投影。
- pending approval、未过期 active lease、事件日志和 runtime 文件不会因观察动作而变化。
- 中断恢复保留为显式 `recoverControlPlane()` 路径；终态 archive 重建测试也先显式恢复，再只读 inspect。

### P1 4：Application Snapshot 无损保留编译执行语义

- 新增严格 `ApplicationSnapshot` 解析器，递归保留 `steps`、`until`、`maxIterations`、`independentReviewActor`、`retry`、`artifactLevel` 和输出 `contentLevel`。
- 解析器递归拒绝未知字段、非法类型、重复 Step id 和不一致的顶层执行顺序。
- Start、恢复和 Acquire 共用这份严格快照；恢复后的 Work Package 延续 Compiler 已确定的内容级别和执行约束。

### P2 1：Baseline Digest 从新建 Worktree 计算

- `createWorkItem()` 在从 `baselineRevision` 创建 worktree 后，从该 worktree 计算 `baselineTreeDigest`。
- 调用方存在 tracked content、untracked file、executable mode 或 symlink 变化时，manifest baseline 仍与 Work Item 的实际起点一致。

### P2 2：Project Config 与 Workflow Selection 严格公开 Schema

- `start` 在语义映射前通过公开 Schema 校验 `config.yaml` 和 Workflow selection。
- `builtin.project-config.v1` 与最小 `wspec init` 配置兼容，同时严格覆盖 Application 已消费的 documentation 和 skills 字段。
- 新增 `builtin.workflow-selection.v1`，根级和嵌套未知字段、非法 runtime/profile 值均按稳定 schema code/path 拒绝，不再静默忽略或回退。

## Cold Review Finding Closure

### Work Package 丢失编译后的 `artifactLevel`

- RED：Quick profile 的 `plan` 已在 Snapshot 中保存 `artifactLevel: "compact"`，但实际 Acquire 返回的 Work Package 为 `undefined`。
- GREEN：`WorkPackage` 类型、公开 Schema、Acquire 映射和生成 Schema 均携带可选 `artifactLevel`；真实 Start/Acquire 集成断言返回 `"compact"`，focused regression `1 passed / 0 failed`。

### Submit 把可选 `mediaType` 意外变为必填

- RED：Artifact 已通过正式验证，但提交引用省略可选 `mediaType` 时错误返回 `WSSPEC_ARTIFACT_REFERENCE_INVALID`。
- GREEN：只有调用方明确提供 `mediaType` 时才比较该字段；真实 Application flow 的省略字段回归用例 `1 passed / 0 failed`。

## TDD Evidence

- Global Skill RED：Start 后修改、删除或新增内容冲突候选，旧实现仍签发 `execute`；GREEN：三种漂移均在 Work Package 签发前 fail closed。
- Artifact body RED：metadata、revision 和 content hash 自洽但缺失必需正文结构的 Artifact 被接受；GREEN：所有内置 Artifact malformed-body 子用例均被正式 Contract 拒绝。
- Inspect RED：只调用 inspect 就把 pending approval 改成 expired，并将 stage 退回 ready；GREEN：第二 Git worktree inspect 前后投影、runtime bytes 和 event bytes 完全一致。
- Snapshot RED：Review-Fix 子 Step、5 轮上限、结束条件、独立 Reviewer、retry、输出内容级别和 Quick plan Artifact 级别在快照或 Work Package 中丢失；GREEN：递归快照、恢复及 Acquire 逐字段断言通过。
- Baseline RED：dirty caller 的摘要被写入从 clean HEAD 创建的 Work Item；GREEN：tracked、untracked、mode 和 symlink 四类 dirty caller 均验证 manifest digest 等于新 worktree digest。
- Schema RED：根级未知配置仍可 Start，非法配置还会静默回退；GREEN：公开 Schema 对根级、嵌套级未知字段和非法 runtime/profile 值全部 fail closed。
- 冷审两项 RED/GREEN 见上一节，均先复现原行为，再完成实现与 focused regression。

## Final Verification

环境：Node `v22.16.0`。

- `npm run schemas:generate`：通过，checked-in Schema 已同步。
- schema contract：`7 passed / 0 failed`。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm test`：`278 passed / 0 failed / 0 cancelled / 0 skipped / 0 todo`；耗时 `53339 ms`。
- `git diff --check`：通过。

## Cold Review Result

在六项父审查 finding 闭环后，对完整变更继续检查 Snapshot 必填/可选字段一致性、递归解析、最小 `wspec init` 配置兼容性、Artifact identity 与 `contentLevel`、Submit media type、控制面恢复 import/cycle、baseline 来源、生成 Schema 漂移和 TypeScript 风险。除上述两项已修复问题外，没有发现第三项未关闭 finding。

## Residual Boundaries

- 本轮只关闭 Task 7 Application Facade 审查 finding，不声明 Task 8 已开始或可交付。
- 运行时 Profile 风险升级、GitHub/GitLab/飞书来源、真实外部写入与回读仍属于后续任务。
- 当前验证不等于多进程压力/故障注入、真实 `SIGKILL`、长时间 lease/审批竞争、Windows 路径或生产环境验收。
