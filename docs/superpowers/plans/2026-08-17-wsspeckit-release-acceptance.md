# WSSpecKit 完整工作流与发布验收计划

> **Agent 执行要求：** 使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，前三份计划全部通过后执行。

**目标：** 验证 WSSpecKit 在 Codex、Claude、Cursor 和 Generic Agent 中以中文 Driver Skill 驱动完整工作流，并形成可发布 npm 包和分层外部平台证据。

## 全局约束

- 不新增核心协议；发现协议缺口必须回到对应计划修复并补回归测试。
- 所有发布文档和 Skill 使用中文。
- Fixture、已登录客户端、真实外部平台证据分开记录。
- 未取得真实平台证据时不得宣称对应 Connector 生产可用。

---

### Task 1：项目自定义 Workflow E2E

**文件：**
- 创建：`tests/e2e/custom-workflow.test.ts`
- 创建：`tests/fixtures/workflows/custom-delivery/*`

- [ ] 验证 `workflow list/show/eject/validate/use`。
- [ ] Eject 内置 Workflow，增加 Project Skill 和安全 Review Step，绑定 Global Skill fallback。
- [ ] 验证包升级不改变活动 Work Item 快照。
- [ ] 运行测试并提交：`git commit -m "test: cover project workflow customization"`。

### Task 2：四类 Driver Skill 验收

**文件：**
- 创建：`tests/e2e/agent-driver-contract.test.ts`
- 创建：`docs/acceptance/agent-drivers.md`

- [ ] 在隔离目录安装 Codex、Claude、Cursor、Generic Driver Skill，验证中文内容、触发描述和统一循环协议。
- [ ] 对每个 Adapter 跑 `start/acquire/submit/inspect` Fixture；中断后换新会话模拟器执行 `inspect + acquire` 继续。
- [ ] 记录哪些是文件级契约验证，哪些经过真实客户端执行。
- [ ] 提交：`git commit -m "test: validate agent driver adapters"`。

### Task 3：真实 GitLab 与飞书验收

**文件：**
- 创建：`docs/acceptance/gitlab-live.md`
- 创建：`docs/acceptance/feishu-live.md`
- 创建：`docs/acceptance/live-acceptance-matrix.yaml`

- [ ] 使用专用测试项目读取真实 GitLab Issue，更新后回读稳定 ID、正文和状态。
- [ ] 使用专用测试文档读取真实飞书需求，发布知识文档后回读标题、正文摘要和 URL。
- [ ] 不在文档中记录 Cookie、Token 或凭据；只记录时间、目标 ID、摘要、结果和脱敏错误。
- [ ] 未配置真实账号时将状态记录为 `not_run`，不得用 Fixture 替代。
- [ ] 提交脱敏证据：`git commit -m "docs: record live connector acceptance"`。

### Task 4：中文文档与发布包

**文件：**
- 创建：`README.md`
- 创建：`docs/guide/{getting-started,workflow,skills,profiles,connectors}.md`
- 修改：`package.json`
- 修改：`tests/contract/chinese-content.test.ts`

- [ ] 编写中文扫描失败测试和允许术语清单，覆盖 README、指南、模板、CLI 和内置 Skill。
- [ ] 编写中文安装、初始化、基础工作流、自定义 Workflow、三层 Skill、Profile 和故障恢复指南。
- [ ] `npm pack --dry-run` 校验只包含 dist、schemas、resources、中文 README、LICENSE。
- [ ] 从 tarball 安装到全新临时项目并跑 Quick Fixture。
- [ ] 提交：`git commit -m "docs: publish the Chinese WSSpecKit guide"`。

### Task 5：最终发布门禁

**文件：**
- 创建：`scripts/run-release-gate.sh`
- 创建：`docs/acceptance/release-report.md`

- [ ] 脚本依次运行 Schema 漂移、中文扫描、lint、typecheck、全部测试、build、pack、干净安装 E2E。
- [ ] 检查旧产品名、旧 Schema、旧命令、`WSK-`、`WSPEC_` 和未预期发布文件。
- [ ] 报告分别给出本地静态、Fixture 集成、真实客户端、真实 GitLab、真实飞书的 GO/NO-GO。
- [ ] 只有所有必需层级通过才允许发布；脚本不得执行 npm publish。
- [ ] 提交：`git commit -m "build: add the WSSpecKit release gate"`。

## 完成定义

四份计划的自动门禁全部通过；内置 Quick/Standard/Governed 和项目自定义 Workflow 均完成 E2E；发布报告没有用 Fixture 冒充真实环境；任何未运行的真实验收明确标记为 `not_run` 或 NO-GO。
