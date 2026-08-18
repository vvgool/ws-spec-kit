# Task 6 报告：三 Profile 与双 Workflow 本地 E2E

## 结果

- Quick、Standard、Governed、Quick 升 Governed、Documentation 五条本地 E2E 均由同一 Application Runtime 完成并关闭 Work Item。
- 恢复入口统一为公开 `inspect + acquire`；恢复后 Workflow 引用、Profile、审批、循环预算、Attempt 重试和 Evidence 不重置。
- 功能交付保留 trusted Red/Green TDD 链；文档交付只接受文档路径、要求 trusted `docs.integrity`，且不存在 TDD Step 或 Evidence。

## E2E RED / GREEN 与恢复点

| 场景 | RED | GREEN | 中断与恢复 |
| --- | --- | --- | --- |
| Quick | 损坏 projection 后公开 `inspect` 不能恢复；运行期 `.wsspec/work-items` 文件还会污染 workspace digest。 | compact specification/tasks、design skipped、trusted Red/Green、单轮 Review、Close 全部完成。 | `intake` acquire 后损坏 projection；`inspect + acquire` 返回新 Attempt，`attemptsUsed=2`。Close 后再次损坏 projection，`inspect` 恢复 closed。 |
| Standard | TDD Evidence ID 与 Close 的结构比较依赖 JSON 属性顺序，无法稳定验证同一语义值。 | complete specification/design/tasks、全部审批、两轮 Review-Fix、required Gate、Close 全部完成。 | 第一轮 rejected Review submit 已进入 Fix 后损坏 projection；恢复为 `review-fix:1:fix`，审批与 trusted Red 保持，`attemptsUsed=2`。 |
| Governed | 独立 Reviewer 冲突抛异常，导致上一 submit 事务回滚，无法通过协议换 Actor 继续。 | 原实现者得到 retryable typed `blocked`；独立 Reviewer 完成 Review；归档审计与本地外部回执满足 Close。 | `commit` 审批后、`update-issue` Attempt 活动时损坏 projection；公开 `inspect + acquire` 恢复同 Step 的新 Attempt，`attemptsUsed=2`，Governed Profile、Review-Fix 上限和既有审批保持；Close 后再次恢复 closed。 |
| Quick -> Governed | 升档只清 Context，已成功的 compact Step 仍标为 succeeded，形成状态与上下文不一致。 | `write-tests` 前注入 high risk；clarify/plan 失效并按 complete 重做，design 新启用，循环上限升为 5，最终 Governed Close。 | `profile.upgraded` 后损坏 projection；恢复 Profile=Governed 和新 `clarify` Attempt，`attemptsUsed=2`，升级事件与新增前置 Step 保持。 |
| Documentation | 恢复后的旧 WorkPackage 被继续使用；WorkPackage schema 拒绝内置 `docs.integrity`；文档 Gate 不识别 `docs/**/*.md` 的零层目录匹配。 | 四类越界修改分别拒绝；现有 Work Item 不随项目 active Workflow 切换；合法文档产生 trusted `docs.integrity`，单轮 Review 后 Close；无 TDD 状态。 | `intake` acquire 后恢复；Review submit 已进入 `commit` 后损坏 projection，恢复 `commit` 且 `attemptsUsed=2`；Close 后再次恢复 closed。 |

## 边界验证

- Documentation 分别对 `src/feature.mjs`、`scripts/release.sh`、`package.json`、`tsconfig.json` 返回 `WSSPEC_DOCUMENTATION_SCOPE_VIOLATION`。
- 项目 active Workflow 切换为 feature-delivery 后，已开始 Work Item 的 immutable snapshot 仍为 documentation-delivery。
- trusted Red/Green 与 `docs.integrity` 均由本地受信 Executor 生成；Agent 提交结果不能自报 trusted Evidence。
- Governed 的 issue/knowledge 目标是本地 JSON fixture。测试先写入，再 read-back 校验 workItem/target/status，最后才投影 confirmed receipt；这不是 GitHub、GitLab、飞书或生产连接器验收。
- Governed 在 Close 后读取 `.wsspec/archive/<id>/audit.json`，核对五条审批决策的 requester/decider/time、独立 Review Actor，以及 issue/knowledge publishing receipt；这证明本地 complete-audit 投影内容，不证明外部审计系统。
- 本任务未执行真实 Codex/Claude/Cursor 宿主发现、真实账号或生产外部写入。

## 修复

- `inspect` 在读取 View 前恢复 control plane。
- workspace digest 仅排除严格列举的 Runtime 文件、归档输出和 Artifact；Artifact 进入独立 `artifactTreeDigest`，写入 Close Evidence 与归档。Close 前重新读盘验证每个 required/approved Artifact 的普通文件边界、producer、schema、path、revision、content hash 和 Approval binding。
- TDD Evidence ID、Close 结构比较使用 canonical serialization；旧的非 canonical Evidence 不提供兼容迁移，继续 fail closed。
- Governed 独立 Reviewer 冲突返回 retryable typed `blocked`。
- Profile 升档把受影响的已成功 Step 一并标记为 invalidated。
- WorkPackage gate schema 与 Evidence gate schema 统一允许 `docs.integrity`；compiler containment、submit scope 和文档 Gate 共用有界 repository-relative matcher。文档和 Artifact 文件使用 `lstat + realpath + canonical root containment`，拒绝 symlink 与非普通文件。

## Fresh Verification

- 五条聚焦 E2E：5/5，0 fail。
- 文档完整性单测：4/4，0 fail；共享 matcher 单测：2/2，0 fail；构建产物 symlink 对抗测试：1/1，0 fail。
- `npm run lint`：通过。
- `npm run typecheck`：通过。
- `npm test`：446/446，0 fail。
- `npm run build`：通过。
- `npm run schemas:generate`：通过；生成 Schema 纳入本次提交。

## 残余关注

- 以上结论只覆盖本地 Runtime、临时 Git worktree、本地命令和本地 read-back fixture。
- 真实宿主 Skill 发现、签名发布物、真实外部 Connector 与生产恢复仍需要各自的独立验收门禁。
