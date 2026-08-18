# Task 4 报告：审批、可信 Gate 与 Close

## 范围

基线为 `3e515b8`。本任务实现按 Resolved Profile 执行的审批、Gate Evidence 与 Close checklist，并补齐关闭事件、归档恢复和公开错误合同；未开始 Task 5 的 TDD Red/Green Evidence，也未执行 merge、push、publish 或真实外部平台验收。

## 需求映射

| 需求 | 实现与证据 |
| --- | --- |
| Profile 审批矩阵 | Profile 快照继续作为审批真源；集成测试验证 Quick、Standard、Governed 分别要求无规格类审批、规格/设计审批、规格/设计/计划审批，不依赖固定阶段名。 |
| 零 Artifact 审批 | `prepareArtifactApproval()` 接受空 Artifact 数组，以 Step、Attempt 和空集合生成稳定 digest，并绑定 workspace 与 requester actor；TTY 决定持久化 decider actor。 |
| 审批精确绑定 | Close 同时校验 approved 状态、Step、Attempt、requester/decider、规范化后的完整 Artifact 数组和绑定 digest；多 Artifact 顺序不会产生伪差异。 |
| Gate Evidence | 新增 `recordGateEvidence()`，验证正式 Schema、record hash、Gate 声明、信任级别、Attempt、baseline/config/workspace；进入控制面锁后再次计算 workspace freshness。 |
| Profile Gate 集合 | Quick 使用有效 Step Gate，Standard 追加项目 required Gates，Governed 追加全部 configured Gates；Close 只接受达到快照信任级别且 result 为 passed 的 fresh Evidence。 |
| Close checklist | 新增分类、去重且稳定排序的 `step`、`artifact`、`approval`、`evidence`、`external-receipt` 缺失项；条件跳过的顶层或循环 Step 不再被误判为缺失。 |
| 独立 Review 防御 | Governed Close 重新核对实现 Actor、历史 completed Fix Actor 与每轮 Review Actor；Actor 缺失或复用时 fail closed。 |
| 关闭与恢复 | Close 被阻塞时持久化 `evidence.recorded` 与完整 decision；成功时持久化 `work-item.closed`、只读终态和归档重建数据，损坏投影可由事件链恢复。 |
| 公开错误合同 | 新增 `verification` 错误分组，并为 `acquire`、`submit`、`decide` 登记 Close/Evidence typed errors；公开协议文档与 CLI 生产依赖图保持双向覆盖。 |

## 测试与缺陷闭环

- `profile-approval.test.ts` 覆盖三档审批矩阵、零 Artifact 审批以及 requester/decider 的事件恢复。
- `workflow-close.test.ts` 覆盖五类缺失项、Profile Gate 差异、完整 Artifact 绑定、条件跳过、去重、attested Evidence、独立 Review、Close RED/GREEN、workspace 失效和锁内 freshness 复检。
- 全量测试首次运行得到 `405/406`：唯一 RED 是 CLI typed-error 双向覆盖，明确缺少 `WSSPEC_CLOSE_CHECKLIST_INCOMPLETE`、五个 `WSSPEC_EVIDENCE_*` 和 `WSSPEC_GATE_NOT_REQUIRED`。
- 补齐公开分组、三条 route 与协议文档后，同一聚焦合同变为 `1/1` GREEN，整份文档合同为 `11/11` GREEN。

## 最终验证

以下门禁均在当前候选树上新鲜执行：

| 门禁 | 结果 |
| --- | --- |
| Approval + Close 聚焦测试 | PASS，16 passed，0 failed |
| Application/Recovery/Profile/Loop/Close 相关回归 | PASS，154 passed，0 failed |
| `tests/contract/documentation-baseline.test.ts` | PASS，11 passed，0 failed |
| `npm test` | PASS，406 passed，0 failed，0 skipped |
| `npm run lint` | PASS，exit 0 |
| `npm run typecheck` | PASS，exit 0 |
| `npm run build` | PASS，exit 0 |
| `npm run schemas:generate` | PASS，exit 0；生成前后 Schema diff SHA-256 均为 `434b639938eacd1da90882d6a1df36bf8fe16f24dbd46db0b8619720200bbfda` |
| `git diff --check` | PASS，exit 0 |

## 证据边界

- 本报告只证明当前 checkout 的本地审批、Gate、Close、事件恢复、Schema 和公开合同门禁。
- Task 5 的可信 TDD Red/Green Evidence、Task 6 的三 Profile 完整 E2E，以及真实 issue/knowledge 写入与回读均未执行。
- 独立代码审查由协调层在本提交后派发；本报告不把实现者自审当作独立审查结论。
- 未执行 merge、push、publish、真实宿主发现或生产验收。
