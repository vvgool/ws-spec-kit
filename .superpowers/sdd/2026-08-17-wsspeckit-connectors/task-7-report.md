# Task 7 Connector Fixture E2E 报告

## 状态

DONE（本地 Fixture E2E、Application 接线、恢复、契约、类型与构建门禁）。

基线：`70e91911787a90a5f82bf1df253e0a26bcbb2f1e`

本 Task 没有进入 Release Acceptance，没有访问真实 GitHub、GitLab 或飞书账号，也没有执行 push、merge、
release、publish 或部署。Fixture 绿色只证明当前 macOS checkout 的本地受控链路，不代表生产可用。

## 实现与覆盖

- GitHub Issue、GitLab Issue、飞书文档三种来源均通过真实 Connector Adapter 和受限子进程 Fixture 捕获，
  再走公开 `start -> acquire -> submit -> decide -> inspect` Application 协议；测试没有直接调用内部状态机
  helper 完成交付。
- Git commit 阶段调用 Task 6 的 `commitGitChanges`，使用真实临时 Git repository、独立 index、批准
  baseline/files/message/diff digest 和 commit readback；后续外部动作只有在该 commit 成功后才可发生。
- 外部顺序固定为 `git.commit -> issue.update -> knowledge.publish 或 skipped -> issue.close -> Work Item close`。
  三个外部阶段分别覆盖 pre-send、post-send 和 readback crash；远端 mutation timeline 逐项断言只写一次，
  sent-or-unknown 结果只能通过公开 `inspect + decide(external_reconciliation)` 只读协调采用。
- GitHub/GitLab 的 authenticated Source Snapshot 在可信 `source.captured` 事件中形成当前 Work Item 的
  `bindings.issue`；本地/飞书来源显式记录 `{ exists: false }`。E2E 不再由测试 Executor 伪造 Issue Binding。
- 只有 authenticated Issue Binding 存在时，`issue.update`/`issue.close` 才执行并强制 Issue receipt 与
  已授权、已回读验证的 close。无 Issue Binding 且两个 Issue 阶段都明确 `skipped` 时允许 Feishu-only
  Work Item close；存在 Binding 但缺少 verified close 时 close checklist 保持 blocked。
- GitLab close 的永久 readback failure 会保留已发生的一次远端 close mutation，但 Work Item 不会关闭，
  也不会自动重发未知结果。
- Builtin Catalog 精确注册 `git-native`、`github-cli`、`gitlab-cli`、`lark-cli` 四个 Manifest；
  `wspec doctor connectors` 分别报告 `git`、`gh`、`glab`、`lark-cli`，只执行受审计 Doctor probe。
- E2E 递归扫描 repository `.wsspec`、common Git dir `.git/wsspec` 和 Work Item worktree `.wsspec`，
  拒绝三个 Fixture token、Fixture HOME、真实 HOME、CLI 配置目录和配置字段内容进入持久化输出。

## TDD 证据

### 接管前记录

前序实现记录的初始 E2E RED 为 `0/3`：Builtin Catalog 尚无 Connector，外部 Source 尚未接线；随后三来源
主场景转为绿色。接管时这些改动仍未提交，因此本报告没有把该记录当作最终验证，而是重新运行全部 focused
与全量门禁。

### 接管后 RED -> GREEN

真实性审查发现 E2E 的自定义 `requirement.capture` Executor 手工写入 Issue Binding，掩盖了生产 `start`
没有从 authenticated GitHub/GitLab Source 建立 Binding 的缺口。先移除该测试伪造，再运行：

```sh
node --import tsx --test --test-name-pattern="GitHub Issue fixture" tests/e2e/external-delivery-fixture.test.ts
```

结果为预期 RED：`0/1 PASS`，交付在 close 阶段以 `WSSPEC_CLOSE_CHECKLIST_INCOMPLETE` blocked。随后仅在
可信 `source.captured` 事件中初始化 Source-derived Issue Binding，GitHub 与 Feishu focused 复跑
`2/2 PASS`。

故障矩阵审查另发现三个未显式覆盖的组合：`issue.update/readback`、`knowledge.publish/pre-send`、
`issue.close/post-send`。补充的三个行为用例首次运行即 `4/4 PASS`，说明既有恢复实现已支持这些边界，
因此没有伪造产品 RED 或增加不需要的生产代码。

## 最终验证

以下命令均在当前 checkout、Node.js `v22.16.0` 上运行，退出码为 0：

```sh
node --import tsx --test --test-reporter=spec \
  tests/e2e/external-delivery-fixture.test.ts \
  tests/integration/workflow-close.test.ts \
  tests/integration/connector-doctor.test.ts \
  tests/contract/builtin-resources.test.ts \
  tests/contract/schemas.test.ts \
  tests/contract/documentation-baseline.test.ts
npm test
npm run lint
npm run typecheck
npm run build
npm run schemas:generate
node --import tsx --test tests/contract/schemas.test.ts \
  tests/contract/documentation-baseline.test.ts \
  tests/contract/requirements-traceability.test.ts
git diff --exit-code -- schemas
git diff --check 70e9191 --
git diff --check
```

- Task 7 focused：`90/90 PASS`，0 fail/skip。
- 全量：`751/751 PASS`，0 fail/skip。
- lint、typecheck、build：PASS。
- Schema 生成：PASS，无 checked-in Schema drift。
- Schema、文档、需求追踪合同：`24/24 PASS`。
- whitespace/diff gates：PASS。

## 证据边界与剩余风险

- 已验证：macOS 本地 Fixture CLI 进程、真实 Git commit、完整 Application 协议循环、三来源捕获、三阶段
  crash/reconciliation/order/idempotency、conditional Issue receipt/close、递归持久化泄漏扫描和四 Manifest Doctor。
- 未验证：真实 GitHub/GitLab/飞书认证、权限、网络、限流和平台语义；真实 Codex/Claude/Cursor Driver；
  Linux/Windows；生产恢复、发布和部署。以上仍属于 Release Acceptance，当前不得据此标记生产 GO。
- `lark-cli` 的无副作用认证探测在 Manifest 中明确 unavailable；Doctor 可区分二进制缺失与认证不可探测，
  但不能把 Fixture 或版本探测结果标记为飞书账号已认证。
- Fixture 的知识发布目标由受控测试 Executor 提供 discovery binding；真实项目如何配置/发现知识目标仍需
  Release Acceptance 使用真实 Workflow/Driver/平台验证。

## Commit

独立提交信息：`test: cover fixture external delivery`。
