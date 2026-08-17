# WSSpecKit 来源与交付 Connector 实施计划

> **Agent 执行要求：** 使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，在控制流计划通过后执行。

**目标：** 实现用户描述、本地文件、GitLab Issue、飞书文档需求来源，以及 Git commit、Issue 更新、Wiki 发布的可审批、幂等、可回读交付链路。

**架构：** Connector Registry 只处理结构化请求；认证由宿主 Agent/CLI 环境提供，凭据永不进入 Workflow 或控制面。所有外部写入采用 prepare -> approve -> execute -> read-back 四阶段协议。

## 全局约束

- 所有 Connector 文档和提示使用中文。
- 本地 Fixture、已登录客户端、真实平台验收分层报告。
- 外部写入必须绑定稳定目标、最终内容摘要、工作区摘要和幂等键。
- 禁止在日志、事件、Artifact、Work Package 或测试快照中保存凭据。

---

### Task 1：Connector Manifest 与 Registry

**文件：**
- 创建：`src/registry/connectors/{types,registry,manifest}.ts`
- 修改：`src/schemas/definitions.ts`
- 创建：`tests/contract/connector-manifest.test.ts`
- 创建：`tests/unit/connector-registry.test.ts`

- [ ] 写失败测试，覆盖 `external-read/external-write`、能力、目标类型、幂等、回读、未知字段和安全类别伪造。
- [ ] 定义 `Connector.prepare/execute/readBack`，Registry Manifest 决定安全类别，Workflow 无权覆盖。
- [ ] 运行契约、Registry、Schema 漂移和类型测试。
- [ ] 提交：`git commit -m "feat: define connector contracts"`。

### Task 2：需求来源快照

**文件：**
- 修改：`src/registry/connectors/local-requirement.ts`
- 创建：`src/registry/connectors/gitlab-source.ts`
- 创建：`src/registry/connectors/feishu-source.ts`
- 修改：`src/storage/work-items.ts`
- 创建：`tests/integration/requirement-sources.test.ts`

- [ ] 写失败测试：Prompt、Markdown/TXT、GitLab Issue Fixture、飞书文档 Fixture、路径逃逸、空内容、来源变化后快照不变。
- [ ] 统一输出 `RequirementSourceArtifact`：来源类型、稳定 ID/URL、抓取时间、正文摘要、只读正文和 Binding。
- [ ] GitLab/飞书读取只能通过 Connector 注入接口，单元测试不得访问真实网络。
- [ ] 运行来源测试、凭据扫描和类型检查。
- [ ] 提交：`git commit -m "feat: capture immutable requirement sources"`。

### Task 3：External Action 审批协议

**文件：**
- 创建：`src/engine/external-actions.ts`
- 修改：`src/application/decide.ts`
- 修改：`src/storage/control-plane.ts`
- 创建：`tests/integration/external-action-approval.test.ts`

- [ ] 写失败测试：精确目标、最终 diff、actionDigest、过期、工作区变化、非 TTY、幂等重试和回读缺失。
- [ ] 实现 `prepareExternalAction`，审批记录与 Artifact 审批分离。
- [ ] 执行前重算摘要；变化则使审批过期。执行后必须回读并记录 `reconciled` 或 `reconciliation_required`。
- [ ] 运行伪终端、恢复和安全扫描测试。
- [ ] 提交：`git commit -m "feat: approve exact external actions"`。

### Task 4：Git Commit Connector

**文件：**
- 创建：`src/registry/connectors/git-commit.ts`
- 创建：`tests/integration/git-commit-connector.test.ts`

- [ ] 写失败测试：精确文件集、空提交、越界文件、摘要变化、提交失败、重复幂等键、提交后 revision 回读。
- [ ] 使用 `execFile` argv 调用 Git，不经 Shell；只提交审批中展示的文件和消息。
- [ ] 回读 commit、tree 和父 revision；不实现 push、merge、release。
- [ ] 运行测试和安全扫描。
- [ ] 提交：`git commit -m "feat: add approved git commit connector"`。

### Task 5：Issue 与 Knowledge Connector

**文件：**
- 创建：`src/registry/connectors/issue-update.ts`
- 创建：`src/registry/connectors/knowledge-publish.ts`
- 创建：`tests/integration/issue-connector.test.ts`
- 创建：`tests/integration/knowledge-connector.test.ts`

- [ ] 写 Fixture 失败测试：创建/更新、稳定 ID、幂等、网络失败、成功但回读不一致、Issue 与 Knowledge 生命周期互不覆盖。
- [ ] Issue 更新输入只来自批准的交付摘要和 Evidence；Knowledge 发布输入来自规格、设计和验证结果。
- [ ] 必需 Target 失败时阻止 Close；可选 Target 失败时按 Profile 进入 warning 或 reconciliation。
- [ ] 运行 Connector、归档和恢复测试。
- [ ] 提交：`git commit -m "feat: publish issue and knowledge results"`。

### Task 6：Connector Fixture E2E

**文件：**
- 创建：`tests/e2e/external-delivery-fixture.test.ts`
- 创建：`tests/fixtures/connectors/*`

- [ ] 跑通 GitLab Issue Fixture -> 完整开发流程 -> Git commit -> Issue 更新 -> Wiki 发布 -> Close。
- [ ] 注入每个外部阶段的崩溃和重试，验证不重复写入。
- [ ] 扫描所有输出，确认测试凭据标记未进入持久化文件。
- [ ] 运行 `npm test && npm run build`。
- [ ] 提交：`git commit -m "test: cover fixture external delivery"`。

## 完成门禁

Fixture 只证明 Connector 契约与本地编排，不得标记真实 GitLab/飞书为通过。真实环境证据由发布验收计划产生。
