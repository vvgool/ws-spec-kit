# Task 5 修复报告（第 1 轮）：外部动作并发、恢复与发布顺序

## 状态

完成 `task-5-review.md` 的 1 个 Critical、6 个 Important 和 1 个 Minor finding 的本地修复。
没有开始 Task 6，没有调用真实 GitHub、GitLab 或飞书账号/网络。独立复审完成前，Task 5
真实平台与生产 readiness 仍为 NO-GO。

基线：`5b8ce31`

## TDD 证据

### RED

- 并发 Application `submit` 使用 barrier 同时到达 Provider；旧实现观测到两次 `execute`，违反同一
  Request 只写一次的合同。
- 五操作 Application 路径无法触发 `reconcileExternalAction`；发送后未知状态只能永久 blocked。
- Lease 过期后，`not_sent` 动作保留旧 Attempt 而无法继续；已 dispatch/verified 动作又会丢失
  原 Claim/Attempt 并与替代 Attempt 的 canonical key 冲突。
- 删除有效 `runtime.json` 的任一 external-action 投影字段后，旧实现会静默补为空 map。
- Provider 抛出的 Authorization/Cookie/Token 文本会进入错误；协调失败 reason 会进入事件、投影和
  后续公开 blocked message。
- optional Knowledge 的 `missing` 状态错误地允许 Close；省略 `knowledge.publish` 的自定义 Governed
  Workflow 可以完成 `issue.close`。
- canonical idempotency key 额外绑定 Provider/action，不符合指定的四字段身份；同一逻辑写入可绕过冲突。
- `await_approval` 的 `step`/`workflow_trust` Schema 可以携带 external-only 字段。

### GREEN

- 原子持久化唯一 `executionOwner`；非 owner 返回可重试的
  `WSSPEC_EXTERNAL_EXECUTION_IN_PROGRESS`，barrier 用例证明 Provider 调用严格为一次。dispatch 前
  Provider 失败释放 owner，允许受控重试。
- 新增 `DecisionInput.kind = external_reconciliation`，通过公开 `decide` 执行只读回查，再由
  `acquire` 恢复原 Attempt；完整 Application 路径通过。
- 过期 Lease 的 `prepared/approved/executing-not_sent` 动作、canonical index 和拒绝证据一并失效，
  创建替代 Attempt；dispatch 后、reconciled、verified 或 failed 状态保留原 Attempt，并续租 Claim
  和 Work Package Lease。工作区快照比较改为固定 `TreeEntry` 语义 tuple，避免事件 canonicalization
  改变对象键顺序后产生假的 `modifiedFiles`。
- `readControlPlane` 和 `recoverControlPlane` 对缺失或畸形 external-action 投影字段统一返回
  `WSSPEC_RUNTIME_PROJECTION_INCOMPATIBLE`；本版本明确不做隐式迁移。
- dispatch 前 Provider 错误与协调调用错误分别折叠为固定安全错误码；failed/unknown 回查只持久化
  Runtime 时间与固定 bounded metadata。Authorization/Cookie/Token 对抗用例确认错误、事件和投影
  都不含原文。
- `issue.close` 在生产 `submit` 状态转换中调用 delivery ordering：required Knowledge 必须 verified；
  optional Knowledge 只能 verified、明确 absent/skipped，或已有持久化 warning。缺失发布 Step 的
  Governed 自定义 Workflow 现在 fail closed。
- 幂等键精确由 `workItemId`、`stepId`、`targetStableId`、`payloadDigest` 导出；Provider/action 仍保留在
  Request/Grant binding，变化时与现有逻辑写入冲突。
- `await_approval.approval` 改为三个 exact `oneOf` variant；`step` 和 `workflow_trust` 拒绝外部字段。

## 验证

以下命令均在当前 checkout 上执行，退出码均为 0：

```sh
node --import tsx --test \
  tests/integration/external-authorization.test.ts \
  tests/integration/idempotency.test.ts \
  tests/integration/reconciliation.test.ts \
  tests/integration/recovery.test.ts \
  tests/contract/application-protocol.test.ts \
  tests/contract/schemas.test.ts
npm test
npm run lint
npm run typecheck
npm run build
npm run schemas:generate
node --import tsx --test tests/contract/schemas.test.ts
node --import tsx --test tests/contract/documentation-baseline.test.ts
git diff --check
```

- Task 5 聚焦：78/78 PASS，0 fail。
- 全量：709/709 PASS，0 fail，0 skipped。
- 协议、Schema 与文档 targeted：27/27 PASS；其中 Schema 9/9、文档 12/12。
- lint、typecheck、build、Schema 生成与 diff whitespace 检查全部 PASS。

## 协议与文档

- 生成并纳入 `external_reconciliation` Decision Schema 与 exact `await_approval` union。
- Application Protocol 参考补充只读协调、原子 execution owner、固定 Provider 错误和
  Knowledge-before-close 约束。
- public error catalog 与文档双向登记新增 external/runtime/delivery 状态码；文档基线验证生产调用图、
  逐路由合同与公开表格一致。

## 证据边界与剩余风险

- 已验证：本地受控 Fixture、Application 协议、并发协调、事件/投影重放、过期 Lease 恢复、错误机密性、
  Schema 和发布顺序。
- 未验证：真实 `gh`、`glab`、`lark-cli` 账号写入与只读回查，平台权限/限流/并发语义，真实网络失败，
  部署拓扑、生产恢复和回滚。
- 本轮未产生真实外部副作用；本地全绿不等于真实平台或生产 GO。
- Task 5 仍需对本提交进行独立 adversarial re-review；通过前不得开始 Task 6。

## Commit

独立修复轮提交信息：`fix: harden external action coordination`。
