# WiesenSpecKit 设计规格

## 1. 产品定义

WiesenSpecKit 是一套独立、与 Agent 无关的工程工作流协议和 CLI。它把用户意图、需求文档或远程 Issue 转化为受控的规格定义、技术设计、实施计划、编码、审查、验证和归档流程。

产品名为 `WiesenSpecKit`，仓库和 npm 包名为 `wiesen-spec-kit`，CLI 命令为 `wspec`。项目产生的所有中间工件统一保存在 `.wsspec/`。

WiesenSpecKit 不选择或调用大模型。Codex、Claude Code、OpenCode、Cursor 或其他编码 Agent 自行负责模型选择、认证、上下文管理和代码执行。WiesenSpecKit 只负责确定性的工作流状态、工件契约、人工门禁、审计记录和失败恢复。

仓库采用 Apache-2.0 许可证。

## 2. 产品目标与非目标

产品目标：

- 用声明式工作流语言描述完整的软件交付过程。
- 让任何能够读写文件并执行命令的编码 Agent 使用相同协议。
- 支持 Skill 自动触发、斜杠命令显式触发和自然语言触发。
- 所有项目中间工件都存放在 `.wsspec/`。
- 支持用户直接描述、本地需求文档、远程页面和 Issue 等需求来源。
- 默认要求人工批准需求规格、技术设计和实施计划。
- 跨会话、跨 Agent 产品保留可恢复、可审计的执行状态。
- 支持 Git worktree、阶段性提交、远程 Issue 同步和项目 Wiki 发布。
- 每个工作流参数都有完整定义、Schema 校验、示例和扩展说明。

非目标：

- 选择、托管、代理或直接调用模型。
- 保存模型、Issue 平台或 Wiki 的访问凭据。
- 取代编码 Agent、代码托管平台或项目 Wiki。
- 未经明确授权自动 push、合并、发布版本或改变远程 Issue 状态。
- 在 YAML 内提供不受限制的编程语言。

## 3. 统一领域词汇

- **Work Item（工作项）**：一个用户目标及其完整生命周期，可以是功能、缺陷、审计、重构、文档交付或项目初始化。
- **Workflow（工作流）**：由阶段及其契约组成的声明式有向图。
- **Stage（阶段）**：工作流中的一个节点。
- **Artifact（工件）**：规格、设计、计划或报告等带版本输出。
- **Run（运行）**：一个 Work Item 的一次整体执行。
- **Attempt（尝试）**：一个 Stage 的一次执行尝试。
- **Binding（绑定）**：Work Item 与 Issue、Wiki 页面等外部对象的关联。
- **Evidence（证据）**：可复现的测试、构建、审查、发布或验收结果。
- **Claim（领取）**：授予一个执行主体对某个 Stage 写权限的限时租约。
- **Actor（执行主体）**：审计记录中的人或 Agent 身份，不代表工作流 Runner。

代码、文档、Schema、Skill 和 CLI 输出必须统一使用这些词汇，不得用 `change`、`ticket`、`runner` 或 `model provider` 指代以上概念。

## 4. 总体架构

WiesenSpecKit 以声明式工作流引擎为核心：

```text
workflow.yaml
    -> 解析器和 Schema 校验器
    -> 工作流编译器
       - 依赖图
       - 工件契约
       - 审批门禁
       - 状态转换规则
    -> 工作流运行时
       - 阶段执行协议
       - 暂停、恢复、重试和失效传播
       - Claim 与并发控制
       - 事件日志
    -> 适配器运行时
       - 需求来源
       - Issue 平台
       - Wiki
       - Agent 集成安装器
```

运行时对外提供 CLI 协议。Agent 调用该协议，但 WiesenSpecKit 不启动或控制 Agent。

## 5. 声明式工作流语言

项目工作流位于 `.wsspec/workflow.yaml`。内置标准工作流为：

```text
discover -> define -> design -> plan -> build -> review -> verify -> close
```

示例：

```yaml
version: 1
workflow:
  id: verified-delivery

stages:
  - id: define
    uses: artifact.generate
    input: [intent]
    output: [specification]
    approval: { required: true }

  - id: design
    uses: artifact.generate
    needs: [define]
    input: [specification]
    output: [design]
    approval: { required: true }

  - id: plan
    uses: task.plan
    needs: [design]
    output: [plan, tasks]
    approval: { required: true }

  - id: build
    uses: engineering.implement
    needs: [plan]
    output: [implementation-result]

  - id: review
    uses: engineering.review
    needs: [build]
    input: [specification, design, implementation-result]
    output: [review-result]

  - id: verify
    uses: quality.verify
    needs: [review]
    input: [review-result]
    gates: [test, lint, typecheck, build]

  - id: close
    uses: work-item.close
    needs: [verify]
    publish: [issue, wiki]
```

引擎不硬编码这些阶段 ID，只解释其依赖、输入、输出、审批、质量门禁和发布契约。

### 5.1 参数契约

每个公开参数必须定义名称和字段路径、类型、必填性、默认值、允许值、作用域、执行语义、生效阶段、字段约束、失败行为、最小与完整示例、扩展方式、版本兼容和迁移策略。

未知字段直接校验失败，不允许静默忽略。错误必须包含稳定错误码、字段路径、期望结构和修复建议。

JSON Schema 是结构契约的唯一事实来源。CLI 帮助和参数参考文档从同一字段定义生成，文档中的示例必须在 CI 中通过校验。

```text
wspec schema
wspec explain <field-path>
wspec validate
wspec workflow graph
wspec migrate --dry-run
```

### 5.2 扩展机制

扩展必须显式注册，不能通过随意增加 YAML 字段实现：

```yaml
extensions:
  - package: "@company/wsspec-security"
    version: "^1.0.0"
    config:
      policy: strict
```

扩展包必须提供 Manifest、JSON Schema、执行器、输入输出工件契约、权限声明、参数文档、示例、兼容版本范围和契约测试夹具。工作流编译前，引擎将扩展 Schema 合并进完整 Schema。

## 6. 项目存储结构

所有项目中间文档和状态统一存放在 `.wsspec/`：

```text
.wsspec/
├── config.yaml
├── constitution.md
├── workflow.yaml
├── schemas/
├── work-items/
│   └── WSK-20260816-001/
│       ├── work-item.yaml
│       ├── source/
│       ├── artifacts/
│       ├── evidence/
│       ├── events.jsonl
│       └── runtime.json
├── templates/
└── archive/
```

Agent 宿主要求的发现文件可以位于其约定目录，但只包含路由指令，不得保存 Work Item 工件。

Work Item 示例：

```yaml
version: 1
id: WSK-20260816-001
title: Add payment retry policy
workflow: verified-delivery
source:
  type: document
  uri: requirements/payment-retry.docx
  revision: sha256:example
bindings:
  issue: null
  wiki: null
createdAt: 2026-08-16T12:00:00+08:00
```

工件采用带 Schema 校验 Frontmatter 的 Markdown。工件批准时记录内容哈希；已批准上游工件发生变化时，所有依赖阶段自动失效并重新进入审批。

`runtime.json` 是追加式 `events.jsonl` 的可恢复状态投影。所有状态写入使用文件锁和原子替换。事件只记录结构化决策、命令、结果和外部写入，不记录凭据或模型隐藏推理。

```text
pending -> ready -> claimed -> running -> validating
validating -> awaiting_approval -> succeeded
validating -> failed -> retrying
running -> paused -> running
succeeded -> invalidated -> ready
verified -> pending_publish -> closed
```

关闭后的 Work Item 完整移动到 `.wsspec/archive/<work-item-id>/`。

## 7. Agent 无关的阶段执行协议

所有 Agent 使用相同 CLI：

```bash
wspec next
wspec context WSK-20260816-001 build --format json
wspec stage claim WSK-20260816-001 build --actor codex
wspec stage start WSK-20260816-001 build
wspec stage complete WSK-20260816-001 build --result result.json
```

`context` 返回目标、输入工件、期望输出、允许路径、质量门禁、完成 Schema 和当前 Claim。

阶段完成必须提交结构化结果，包括摘要、修改文件、工件、命令、证据、剩余风险和外部写入。引擎校验结果，并可独立重跑质量命令后再接受完成状态。

Claim 是带过期时间的租约。其他 Actor 可以查看已领取阶段，但不能同时写入。过期后必须显式接管并写入审计事件；上游失效会取消下游 Claim。

## 8. 触发方式与 Agent 集成

WiesenSpecKit 提供三种入口：

1. **Skill 自动触发**：Agent 在存在 `.wsspec/` 的仓库中识别工程任务，首次使用时建议启用 WiesenSpecKit；确认后自动推进到审批门禁。
2. **斜杠命令触发**：为不同宿主生成等价的 `/wspec-start`、`/wspec-issues`、`/wspec-status`、`/wspec-resume`、`/wspec-verify` 和 `/wspec-close`。
3. **自然语言触发**：例如“使用 WiesenSpecKit 按这份需求文档开始开发”。

默认触发策略为 `suggest`：首次匹配需要用户确认；同一 Work Item 的后续阶段自动继续，直到审批门禁或失败。

首版为 Codex、Claude Code、OpenCode、Cursor 和通用 Agent Skills 标准提供集成。集成只安装发现元数据、编排 Skill 和显式命令，不保存工作流、不选择模型，也不充当 Runner。

自动触发不得擅自初始化未配置仓库、导入远程 Issue、批准工件、push、合并、发布或覆盖已有 Work Item。

## 9. 需求来源

本地支持 Markdown、TXT、PDF 和 DOCX；远程支持公开网页、飞书文档/Wiki 和 Confluence 页面。

认证型来源通过 `SourceAdapter` 获取，凭据只能来自官方 CLI、系统凭据存储或环境注入，不得进入 `.wsspec/`。

来源记录包含 URI、修订版本或内容哈希、获取时间和标准化快照。原始需求始终只读；原文更新与已批准工件冲突时必须停止并人工解决。

Work Item 不要求绑定 Issue，后续可以在不改变 Work Item 身份的情况下补充绑定。

## 10. Issue 发现与同步

Issue 适配器根据 Git remote 识别 GitHub 或 GitLab，并优先复用 `gh`、`glab` 已有登录态。用户可以查看或交互选择分配给当前账号的开放 Issue：

```bash
wspec issue list
wspec issue pick
wspec issue import <issue-url>
wspec issue sync <work-item-id>
```

一个 Work Item 绑定一个主 Issue。导入时拉取标题、正文、标签、评论、附件链接和关联关系，并保存带版本的来源快照。

读取可以自动执行；修改远程状态、标签或评论必须确认并写入审计事件。本地和远程同时变化时生成结构化冲突，不允许任一侧静默覆盖。Issue 评论可以作为反馈导入，但不能直接修改已批准工件。

## 11. Git 行为

每个 Work Item 自动创建独立分支和 worktree。规格、设计、计划和实现形成可审查的阶段性提交。未经明确授权，WiesenSpecKit 不执行 push、合并、创建 PR 或发布版本。

失败或暂停后保留 worktree，并从最后一个确定完成的事件恢复。执行 Git 写操作前必须解析并展示仓库、分支、worktree 和目标。

## 12. 质量门禁发现

初始化时读取项目清单和 CI 配置，推断 test、lint、typecheck 和 build 命令。用户首次确认后写入 `.wsspec/config.yaml`，之后保持稳定，直到显式修改。

Agent 声称命令成功不能直接作为证据。阶段成功前必须重新执行门禁命令，或校验带完整命令、退出码和输出摘要的证据。

## 13. Wiki 发布

Wiki 采用通用 `WikiAdapter`，包括探测、目标解析、发布、回读和验证：

```yaml
wiki:
  enabled: true
  adapter: ./tools/wsspec/wiki-adapter.mjs
  publishOn: close
  required: true
```

发布内容包括最终规格、设计决策、使用方式、限制和验证结果，不包含凭据、模型隐藏推理、敏感日志和不必要过程工件。

当 Wiki 为必需项时，发布或回读失败会让 Work Item 停留在 `pending_publish`，不能关闭。重复发布必须更新原页面，不能创建重复页面。

## 14. 安全边界

WiesenSpecKit 不调用模型或管理模型凭据，但仍会标记敏感来源，并默认将其排除在 Agent 执行上下文之外。

外部适配器必须声明文件读取、写入、网络和凭据需求。所有外部写入都进入审计日志。凭据不得出现在项目文件、工件、日志、Issue、Wiki 或生成的提示词中。

删除文件、Git push、合并、发布版本和改变远程状态等高风险操作始终需要明确授权，即使自定义工作流要求执行也不能绕过。

## 15. CLI 体验

CLI 同时提供稳定命令和交互式终端向导：

```text
wspec init
wspec new
wspec next
wspec list
wspec status <work-item-id>
wspec run <work-item-id>
wspec resume <work-item-id>
wspec pause <work-item-id>
wspec verify <work-item-id>
wspec close <work-item-id>
```

机器调用使用 `--json`。CI 必须显式指定非交互策略：

```bash
wspec verify --non-interactive --policy .wsspec/ci-policy.yaml
```

错误同时提供稳定错误码、人类可读信息和 JSON 输出，并指出具体字段或状态、期望条件和修复命令。

## 16. 测试策略

测试分为四层：

- Schema 测试：覆盖所有字段、扩展合并、错误和迁移。
- 引擎测试：覆盖状态转换、失效传播、审批、Claim、并发、重试、恢复和事件回放。
- 适配器契约测试：覆盖需求来源、Issue、Wiki 和 Agent 集成生成。
- 端到端测试：覆盖自动触发、显式命令、文档输入、Issue 输入、中断恢复和归档发布。

每个公开参数必须有正确和错误语义测试；每个 YAML 文档示例必须通过 Schema 校验；每个 Recipe 必须在临时 Git 仓库中运行。CLI 帮助、JSON Schema 和参考文档由同一字段定义生成，生成产物漂移时 CI 失败。

本地 Fixture 和模拟测试不等于真实外部集成证明。发布验收必须单独记录真实账号 GitHub、GitLab 和项目 Wiki 的发布及回读证据。

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm pack --dry-run
```

## 17. 首版交付范围

- 使用 Node.js 和 TypeScript 实现，发布 `wiesen-spec-kit` npm 包和 `wspec` 命令。
- 提供工作流解析、JSON Schema、编译器、运行时、事件日志、Claim 和审批门禁。
- 提供内置 `verified-delivery` 工作流和完整 Recipe。
- 支持 Markdown、TXT、PDF、DOCX 和公开网页来源。
- 提供飞书、Confluence 认证来源适配器契约。
- 支持 GitHub、GitLab Issue 发现、选择、导入和同步。
- 提供带回读验证的通用 Wiki 适配器契约。
- 提供 Codex、Claude Code、OpenCode、Cursor 和通用 Agent Skills 集成。
- 自动发现质量命令并由用户首次确认。
- 自动管理隔离的 Git 分支和 worktree。
- 使用 Apache-2.0 许可证，并提供由 Schema 生成和验证的参数参考文档。

首版明确不包含直接模型调用、模型选择、模型凭据存储、自动 push、自动合并和自动发布版本。
