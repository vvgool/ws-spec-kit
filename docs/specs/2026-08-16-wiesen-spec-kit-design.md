# WiesenSpecKit 设计规格

本文实现 `docs/specs/2026-08-16-wiesen-spec-kit-requirements.md` 中的产品需求。M1 实施和验收必须以需求编号及追踪矩阵为入口；本文件说明如何实现，不替代验收条件。

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
- 支持 Git worktree、阶段性提交、远程 Issue 任务同步和独立的项目知识库沉淀。
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
- **Binding（绑定）**：Work Item 与外部对象的关联。`issue` 表示任务来源和执行协同，`knowledge` 表示最终知识沉淀页面；两者生命周期独立。
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
       - Issue 任务同步
       - Knowledge/Wiki 知识沉淀
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
    kind: define
    owner: agent
    uses: artifact.generate
    input: [intent]
    output: [specification]
    approval: { required: true, provider: interactive }

  - id: design
    kind: design
    owner: agent
    uses: artifact.generate
    needs: [define]
    input: [specification]
    output: [design]
    approval: { required: true, provider: interactive }

  - id: plan
    kind: plan
    owner: agent
    uses: task.plan
    needs: [design]
    output: [plan, tasks]
    approval: { required: true, provider: interactive }

  - id: build
    kind: implement
    owner: agent
    uses: engineering.implement
    needs: [plan]
    output: [implementation-result]

  - id: review
    kind: review
    owner: agent
    uses: engineering.review
    needs: [build]
    input: [specification, design, implementation-result]
    output: [review-result]

  - id: verify
    kind: verify
    owner: engine
    uses: quality.verify
    needs: [review]
    input: [review-result]
    output: [verification-result]
    gates: [test, lint, typecheck, build]

  - id: close
    kind: close
    owner: engine
    uses: work-item.close
    needs: [verify]
```

以上是 M1 内置 `verified-delivery`，不要求外部协作。M2 增加 `verified-delivery-external` Profile，把 Issue 同步和知识沉淀拆成两个并行的 Engine-owned Stage，并用下述 `close` 替换 M1 的同名 Stage：

```yaml
  - id: sync-issue
    kind: publish
    owner: engine
    uses: issue.sync
    needs: [verify]
    publish: [issue]

  - id: publish-knowledge
    kind: publish
    owner: engine
    uses: knowledge.publish
    needs: [verify]
    input: [specification, design, verification-result]
    publish: [knowledge]

  - id: close
    kind: close
    owner: engine
    uses: work-item.close
    needs: [sync-issue, publish-knowledge]
```

M2 Profile 初始化时默认创建 `issue` 和 `knowledge` 两个 Target，均为 `enabled: true, required: false`。`enabled` 决定 Stage 执行或 `skipped`，`required` 决定确定失败是否阻止关闭。Issue Target 还要求存在 `bindings.issue`；没有 Issue Binding 时 `sync-issue` 自动 `skipped`。两个 Stage 使用独立 Attempt、幂等键、回读证据和对账状态，任一结果不得覆盖另一方。

引擎不硬编码这些阶段 ID，只解释其依赖、输入、输出、审批、质量门禁和发布契约；但工作流不能覆盖或削弱下述安全内核。

### 5.1 不可绕过的安全内核

声明式工作流负责描述“做什么和先后关系”，安全内核负责决定“是否允许发生”。每个阶段必须通过 `kind` 声明安全类别，通过 `owner` 声明由 `agent` 或 `engine` 执行；`uses` 只选择执行器，不能改变安全类别或所有权。`define`、`design`、`plan`、`implement`、`review` 属于 Agent-owned Stage，`verify`、`publish`、`close` 属于 Engine-owned Stage。工作流编译器根据这些契约强制检查以下不变量：

- 实现类阶段必须依赖已批准的规格、设计和计划工件；自定义阶段名不能绕过该要求。
- 被实现或验证阶段消费的已批准工件发生变化时，所有下游成功状态、Claim 和证据立即失效。
- Work Item 只有在所有必需验证门禁产生可信通过证据后才能进入 `verified`。
- 必需发布目标完成写入和回读验证前，Work Item 不能进入 `closed`。
- 删除文件、Git push、合并、发布版本和远程状态变更必须取得针对精确目标和操作的人工授权；启用配置、工件审批或 Stage 成功均不能替代该授权。
- 工作流和扩展只能收紧权限，不能关闭、替换或放宽以上规则。

编译失败必须指出违反的不变量、相关阶段路径和可执行修复建议。例如 `build` 没有已批准计划依赖时，`wspec validate` 直接失败，而不是运行到该阶段再报错。安全类别和不变量属于带版本的引擎契约；扩展可以提供新的 `uses`，但只能选择现有 `kind`，未知类别默认拒绝执行。

### 5.2 交互式审批

首版只提供 `interactive` 审批，用于阻止 Agent 自动越过人工门禁和降低误操作风险，不把它描述为能够防御拥有当前用户全部 Shell 权限的恶意本地 Agent。

Agent 只能执行 `wspec approval request <work-item-id> <stage-id>` 创建审批请求。批准和拒绝必须由用户在连接真实 TTY 的交互式 `wspec approve` 或 `wspec reject` 流程中完成；命令禁止 `--yes`、标准输入管道、环境变量预授权和非交互调用。审批界面必须展示 Work Item、Stage、工件差异、内容哈希、失效范围和后续动作。

工件审批记录绑定 `workItemId`、`stageId`、`attemptId`、`artifactHash`、已接受的 `outputWorkspaceTreeDigest`、动作、终端会话标识和时间。工件、完整工作区、工作流、配置或上游审批发生变化时，原审批自动失效。

外部写入使用独立的 External Action 审批，而不复用工件审批。引擎先生成包含稳定目标、最终差异、`actionDigest`、`workspaceTreeDigest`、幂等键和过期时间的请求，再由用户通过真实 TTY 批准；执行前内容发生变化必须重新批准，执行后必须回读。完整字段和状态见 `docs/reference/execution-contracts-v1.md`。未来需要企业级身份保证时通过新的审批提供者扩展，不纳入首版。

### 5.3 参数契约

每个公开参数必须定义名称和字段路径、类型、必填性、默认值、允许值、作用域、执行语义、生效阶段、字段约束、失败行为、最小与完整示例、扩展方式、版本兼容和迁移策略。

未知字段直接校验失败，不允许静默忽略。错误必须包含稳定错误码、字段路径、期望结构和修复建议。

JSON Schema 是结构契约的唯一事实来源。CLI 帮助和参数参考文档从同一字段定义生成，文档中的示例必须在 CI 中通过校验。

规范性契约拆分为三部分：Workflow 字段见 `docs/reference/workflow-language-v1.md`，项目配置与 CI Policy 见 `docs/reference/project-config-v1.md`，Executor、Artifact、Context、Result 和 Evidence 见 `docs/reference/execution-contracts-v1.md`。实现 Schema、编译器和文档生成前，这些参考必须覆盖所有公开字段，不能仅依赖示例推断。

```text
wspec schema
wspec explain <field-path>
wspec validate
wspec workflow graph
wspec migrate --dry-run
```

### 5.4 扩展机制（M3 / Workflow Language v1.1）

扩展必须显式注册，不能通过随意增加 YAML 字段实现：

```yaml
extensions:
  - package: "@company/wsspec-security"
    version: "1.0.3"
    integrity: "sha512-example"
    config:
      policy: strict
```

扩展包必须提供 Manifest、JSON Schema、执行器、输入输出工件契约、权限声明、参数文档、示例、兼容版本范围和契约测试夹具。工作流编译前，引擎将扩展 Schema 合并进完整 Schema。

Workflow Language v1 不接受 `extensions` 字段。M3 通过向后兼容的 Workflow Language v1.1 增加本节语法。项目声明扩展不代表信任扩展。扩展首次安装或权限、版本、完整性发生变化时，CLI 必须展示来源、精确版本、完整性摘要和请求能力，并取得人工授权。批准结果写入 `.wsspec/extensions.lock`，运行时只加载锁文件中的精确版本和完整性，不解析浮动版本；CI 只能使用预先批准并签入的锁文件。

Node.js 子进程只提供故障隔离，不构成文件、进程或网络安全沙箱。首版内置适配器随 WiesenSpecKit 发布并视为可信代码；所有第三方执行器和项目本地适配器统一标记为 `unsandboxed`，每次执行前展示其 Manifest 权限并取得交互确认，非交互模式默认拒绝。扩展不得接收凭据值，只能调用经过批准的外部凭据代理或官方 CLI。基于操作系统沙箱、容器或远程执行代理的强隔离不属于首版。

扩展升级、降级和撤销均生成审计事件；撤销后不得继续恢复该扩展创建的未完成 Attempt。权限声明用于授权展示、策略拒绝和审计，不能被描述为 Node.js 运行时能够强制执行的沙箱。

## 6. 项目存储结构

项目数据分为可提交工件和共享运行控制面。可提交内容统一存放在仓库的 `.wsspec/`：

```text
.wsspec/
├── repository.yaml
├── config.yaml
├── constitution.md
├── workflow.yaml
├── schemas/
├── work-items/
│   └── WSK-20260816-001/
│       ├── work-item.yaml
│       ├── snapshot/
│       │   ├── workflow.yaml
│       │   ├── config.yaml
│       │   └── schemas/
│       ├── source/
│       ├── artifacts/
│       ├── evidence/
│       └── audit/
├── templates/
└── archive/
```

运行控制面存放在 `git rev-parse --git-common-dir` 所指向的共享 Git 目录中，不进入任何 Work Item worktree 的版本化文件：

```text
<git-common-dir>/wsspec/
├── repository.json
├── locks/
├── work-items/<work-item-id>/
│   ├── locator.json
│   ├── events.jsonl
│   └── runtime.json
```

同一仓库的所有 worktree 必须解析到同一个规范化 `git-common-dir` 和仓库 ID，`wspec list`、Claim、锁和事件写入只访问这一个控制面。`locator.json` 记录 Work Item 的规范 worktree、分支和快照位置；从任意 worktree 调用命令都先通过共享控制面解析该位置，不能从当前目录猜测。

创建 Work Item 时必须固定 `repositoryId`、规范 worktree、分支、基线修订、`baselineTreeDigest`、`workflowDigest`、`configDigest` 和 `schemaDigest`，并把完整配置复制到 `snapshot/`。稳定 `repositoryId` 来自已提交的 `.wsspec/repository.yaml`，不能由 clone 路径或 remote 临时生成；控制面缓存只能校验它。M3 启用扩展后额外固定 `extensionLockDigest` 和 `extensions.lock`。活动 Work Item 只读取该快照；项目全局配置变化不会静默影响现有运行。`wspec rebase-config` 显示差异、创建事件、更新快照，并使受影响的 Stage、Claim、审批和证据失效。完整身份、Source、Binding、locator、恢复和迁移契约见 `docs/reference/work-item-v1.md`。

M1 要求项目是 Git 仓库，不提供无 Git 降级模式。`wspec init --git` 只有在用户显式授权后才能初始化新仓库；否则返回 `WSPEC_GIT_REPOSITORY_REQUIRED`。复制或重新克隆仓库不会复制运行租约；`wspec recover` 根据已提交快照、工件和审计记录显式建立新的控制面，不能静默继承旧 Claim。

Agent 宿主要求的发现文件可以位于其约定目录，但只包含路由指令，不得保存 Work Item 工件。

Work Item 示例：

```yaml
version: 1
workItemId: WSK-20260816-001
repositoryId: repo-01J5V8Q4Y7M6F3K2N1P0ABCDER
title: 支付重试
createdAt: "2026-08-16T12:00:00+08:00"
status: active
execution:
  worktree: .worktrees/WSK-20260816-001
  branch: wspec/WSK-20260816-001
  baselineRevision: abc123
  baselineTreeDigest: sha256:example-tree
  workflowDigest: sha256:example-workflow
  configDigest: sha256:example-config
  schemaDigest: sha256:example-schema
source:
  type: file
  snapshot: source/source.json
  contentDigest: sha256:example-source
bindings:
  issue: null
  knowledge: null
```

工件采用带 Schema 校验 Frontmatter 的 Markdown。工件批准时记录内容哈希和完整工作区摘要；已批准上游工件或工作区发生变化时，所有依赖阶段自动失效并重新进入审批。内置工件最低内容见 `docs/reference/artifacts-v1.md`。

共享控制面中的 `runtime.json` 是追加式 `events.jsonl` 的可丢弃、可完整重建状态投影。事件日志是审批、Evidence、Claim、Context、状态转换、失效传播和关闭结果等持久业务事实的唯一写入源；投影不得保存任何无法从事件与不可变快照重建的持久事实。事件只记录结构化决策、命令、结果和外部写入，不记录凭据或模型隐藏推理。

### 6.1 控制面事务与事件重放

所有控制面修改必须通过唯一事务入口完成。事务取得共享控制面锁后重新读取并校验完整事件链和当前投影，在锁内完成前置条件检查、幂等判断、一个或多个事件的追加，以及投影的原子替换。业务模块不得直接读取旧投影后调用 `writeProjection`。同一次业务操作产生的事件组使用共同的 `operationId`；重放时只接受带提交标记的完整事件组，未提交的尾部事件组不产生任何状态变化并由恢复流程截断或隔离。

M1 事件至少覆盖以下持久事实：Work Item 与 Stage 转换、Claim 创建/续期/释放/过期、Context 创建/失效、审批请求/决定/过期、Evidence 记录/失效，以及 Work Item 关闭。事件 Payload 必须包含重放所需的规范数据；同一幂等键记录其规范输入摘要、事件序号范围和原始操作结果。输入摘要不同却复用幂等键时返回冲突；输入相同时返回原始操作结果，不返回后续事件产生的最新投影作为替代。

`recover` 从不可变 Work Item 快照和完整已提交事件组重建所有持久状态。活动 Claim 和未完成交互式审批属于不可安全继承的运行租约：恢复必须保留其审计历史，追加明确的过期或取消事件，再把对应 Stage 恢复到可继续的安全状态；不得通过清空全部 Claim、审批、Context 或 Evidence 丢失已完成历史。事件链断裂、事件组不完整且无法安全截断，或投影锚点与事件链冲突时 fail closed。

### 6.2 锁生命周期与进程异常

控制面锁文件记录随机 owner token、PID、主机标识和创建时间。释放锁时必须校验 owner token，防止旧进程删除新锁。同一主机上只有在能够确认 PID 已不存在时，恢复命令才可清理 stale lock；无法确认所有者状态或来自其他主机的锁不得按超时自动抢占。普通命令遇到 stale lock 时返回稳定错误和显式 `wspec recover` 建议，恢复操作必须写入审计事件。

### 6.3 关闭与可重建归档

关闭前先在内存中生成并校验包含最终工件、审批、Evidence、状态和事件链锚点的归档内容，再通过控制面事务提交唯一的 `work-item.closed` 事件。归档文件使用该关闭事件中的确定数据生成并原子替换；如果进程在事件提交后、归档替换前终止，`recover` 必须能够重复生成字节一致的归档。只读状态由已提交的关闭事件派生，不依赖额外的投影写入。每个里程碑和关闭操作将哈希链校验后的只读审计快照导出到 Work Item 的 `.wsspec/archive/`。

### 6.4 CLI 投影边界

CLI 不得直接序列化内部 `RuntimeProjection`。每个命令使用显式响应 DTO，只暴露协议字段；`controlPlane`、本机绝对路径、Claim token、锁 owner token 和内部恢复元数据不得出现在 `status --json` 或错误输出中。

Stage 与 Work Item 使用两套独立状态机。

Stage 状态：

```text
pending -> ready -> claimed -> running -> validating
pending -> skipped                                      # Target disabled or Binding absent
ready -> running                                        # Engine-owned
claimed -> ready                                        # release or lease expiry
running -> failed
validating -> succeeded
validating -> succeeded_with_warnings                   # optional publish failed definitively
validating -> awaiting_approval -> succeeded          # approve
awaiting_approval -> revision_required -> ready       # reject and revise
validating -> failed
failed -> retrying -> ready
running -> paused -> running
succeeded -> invalidated -> ready
succeeded_with_warnings -> invalidated -> ready
skipped -> invalidated -> ready                         # Target or Binding changed
pending|ready|claimed|running|paused|validating|awaiting_approval|revision_required|failed|retrying -> invalidated
pending|ready|claimed|running|paused|failed -> cancelled
```

Work Item 状态：

```text
draft -> active -> awaiting_approval -> active
active -> verifying -> verified
verifying -> blocked -> verifying
verified -> blocked                         # verified inputs changed
verified -> pending_publish -> closed       # 存在 enabled 的发布阶段
verified -> closed                          # 所有发布阶段均 disabled 或可直接 skipped
pending_publish -> reconciliation_required -> pending_publish
active|blocked|pending_publish -> paused
paused -> active|blocked|pending_publish
draft|active|blocked|verified|pending_publish|paused -> cancelled
```

每次转换都必须遵循 `docs/reference/state-transitions-v1.md`，其中定义触发命令、允许的前置状态、权限、输入、生成事件、幂等键、重试和失败后的补偿行为。进入 `paused` 时事件必须记录 `suspendedFrom`，恢复只能回到该状态，并重新校验其前置条件。外部写入在进程中断后无法确认结果时进入 `reconciliation_required`，必须先回读远端并人工处理，不能盲目重试。Stage 审批只批准特定内容哈希和工作区摘要；External Action 审批只批准精确远端操作。Work Item 的 `verified` 只能由安全内核在全部必需验证通过后产生；所有必需 Target 成功，且可选 Target 为 `succeeded`、`succeeded_with_warnings` 或 `skipped` 后才能 `closed`。

关闭后的 Work Item 可提交内容完整移动到 `.wsspec/archive/<work-item-id>/`，最终审计快照必须包含控制面事件链末端哈希。已提交的关闭事件使对应运行控制面进入只读；归档文件缺失时只能依据该事件重建，不能重新开放 Work Item。清理控制面需要单独的显式命令。

## 7. Agent 无关的阶段执行协议

WiesenSpecKit 不启动或控制 Agent。自动推进由每个宿主安装的编排 Skill 执行同一个 Pull Loop，CLI 是唯一状态入口。Agent-owned Stage 交给宿主 Agent；Engine-owned Stage 由 CLI 安全内核内部执行：

```text
wspec next --json
  -> 没有可执行阶段：返回 gate、blocked 或 complete
  -> Engine-owned Stage：内执行并继续求值
  -> Agent-owned Stage：返回 Work Item 和 Stage 引用
wspec stage claim
  -> 创建 Attempt 和限时 Claim
wspec context
  -> 返回绑定 Attempt 的执行包
Agent 执行任务
wspec stage complete|fail
  -> 校验令牌和摘要，写入事件
  -> 编排 Skill 再次调用 wspec next
```

所有 Agent 使用相同 CLI：

```bash
wspec next
wspec context WSK-20260816-001 build --format json
wspec stage claim WSK-20260816-001 build --actor codex
wspec stage start WSK-20260816-001 build
wspec stage complete WSK-20260816-001 build \
  --attempt attempt-3 \
  --claim-token <opaque-token> \
  --context-digest sha256:example \
  --result result.json
```

`context` 只用于 Agent-owned Stage，返回目标、输入工件、期望输出、允许路径、质量门禁、完成 Schema、当前 Claim，以及 `workItemId`、`stageId`、`attemptId`、`claimToken`、`contextDigest` 和 `workflowDigest`。`claimToken` 是仅用于防止结果误投到其他 Attempt 的随机能力令牌，不代表人工审批或系统身份。完整结构遵循 `docs/reference/execution-contracts-v1.md`。

阶段完成必须提交结构化结果，包括摘要、修改文件、工件、命令、证据、剩余风险、输入工作区摘要和输出工作区摘要。引擎同时校验 Work Item、Stage、Attempt、Claim 令牌、上下文摘要、工作流摘要和输入摘要，并独立重算输出摘要；输入与输出可以因合法实现而不同。任一身份不匹配、输出摘要不实、Claim 过期、Attempt 已终结或上游已经失效时都拒绝结果。引擎校验结果，并可独立重跑质量命令后再接受完成状态。

Claim 是带过期时间的租约。其他 Actor 可以查看已领取阶段，但不能同时写入。过期后必须显式接管并写入审计事件；上游失效会取消下游 Claim。

编排 Skill 只负责循环调用协议、把 Agent-owned Stage 的执行包交给当前 Agent 并原样回写结构化结果，不复制状态机规则。`verify`、`publish` 和 `close` 由 Engine-owned Stage 自动驱动 Work Item 的 `verifying`、`verified`、`pending_publish` 和 `closed` 转换，不要求 Agent 额外调用同名命令。Agent 会话中断后，新的宿主或 Agent 从 `wspec next` 恢复；它不依赖原会话历史。

## 8. 触发方式与 Agent 集成

WiesenSpecKit 提供三种入口：

1. **Skill 自动触发**：Agent 在存在 `.wsspec/` 的仓库中识别工程任务，首次使用时建议启用 WiesenSpecKit；确认后自动推进到审批门禁。
2. **斜杠命令触发**：为不同宿主生成等价的 `/wspec-start`、`/wspec-issues`、`/wspec-status`、`/wspec-resume`、`/wspec-verify` 和 `/wspec-close`。
3. **自然语言触发**：例如“使用 WiesenSpecKit 按这份需求文档开始开发”。

默认触发策略为 `suggest`：首次匹配需要用户确认；同一 Work Item 的后续阶段由宿主编排 Skill 按 Pull Loop 自动继续，直到 CLI 返回审批门禁、失败、暂停或完成。

首版为 Codex、Claude Code、OpenCode、Cursor 和通用 Agent Skills 标准提供集成。集成只安装发现元数据、编排 Skill 和显式命令，不保存工作流、不选择模型，也不充当 Runner。

自动触发不得擅自初始化未配置仓库、导入远程 Issue、批准工件、push、合并、发布或覆盖已有 Work Item。不同宿主的集成必须通过同一套协议契约测试，禁止绕过 CLI 直接修改 `.wsspec/` 或共享控制面。

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

读取可以自动执行；修改远程状态、标签或评论必须生成精确 External Action Request，并经真实 TTY 批准、执行和回读。本地和远程同时变化时生成结构化冲突，不允许任一侧静默覆盖。Issue 评论可以作为反馈导入，但不能直接修改已批准工件。

Issue 同步只服务于任务协同：更新执行状态、阶段摘要、验证结果和 PR/MR 引用。它不发布完整规格、设计或知识文档，也不创建或更新 Knowledge Binding。

## 11. Git 行为

每个 Work Item 自动创建独立分支和 worktree。规格、设计、计划和实现形成可审查的阶段性提交；Claim、运行状态和可变事件始终写入共享控制面，不写入各 worktree 的 `.wsspec/` 副本。未经明确授权，WiesenSpecKit 不执行 push、合并、创建 PR 或发布版本。

失败或暂停后保留 worktree，并从最后一个确定完成的事件恢复。执行 Git 写操作前必须解析并展示仓库、分支、worktree 和目标。

## 12. 质量门禁发现

初始化时读取项目清单和 CI 配置，推断 test、lint、typecheck 和 build 命令。用户首次确认后按 `docs/reference/project-config-v1.md` 写入 `.wsspec/config.yaml`，之后保持稳定，直到显式修改。v1 命令使用 argv 数组直接启动，不经过 Shell 字符串拼接。

Agent 声称命令成功不能直接作为可信通过证据。证据分为三级：

- `trusted`：由 `wspec` 在已记录的工作目录和环境策略下启动命令，直接捕获命令、退出码、输出摘要、代码修订和环境指纹。
- `attested`：来自配置的 CI 或外部验证系统，具有可校验身份、不可变运行 ID、代码修订和结果签名。
- `reported`：由 Agent 或用户导入的命令结果，只用于诊断和审计，不能单独满足必需门禁。

必需门禁只能由 `trusted` 或满足项目策略的 `attested` 证据通过。证据校验必须确认完整 `workspaceTreeDigest`、配置哈希、输入工件和适用 Stage Attempt；Git 修订只作为可读定位信息。tracked 内容、非 ignored untracked 内容、路径、文件模式或符号链接变化都会使证据失效。输出摘要不是校验依据，原始输出可以存放在受控证据文件中并记录内容哈希和脱敏状态。

## 13. Knowledge/Wiki 知识沉淀

Knowledge 发布针对已经验证的需求或 Bug 沉淀可复用知识，与 Issue 状态同步完全独立。引擎使用版本化模板，从已批准的规格、设计、实现摘要和验证结果生成 `knowledge-entry`，内容包括背景、问题、关键决策、实现方式、验证证据、限制和后续建议。WiesenSpecKit 不调用模型生成额外内容。

Knowledge 采用通用 `KnowledgeAdapter`，包括目标解析、稳定页面定位、发布、回读和验证：

```yaml
publishing:
  targets:
    knowledge:
      type: knowledge
      enabled: true
      adapter: builtin.wiki
      required: false
      readBack: true
```

Knowledge Binding 使用已提交的稳定 `repositoryId + workItemId` 生成默认稳定键；如果 Work Item 来自 Issue，同时记录 Issue 稳定身份用于检索，但不能把可变的 Issue URL 当作唯一页面身份。首次发布创建页面并保存 `bindings.knowledge`，重复发布只更新同一页面。项目可以通过配置覆盖知识空间、目录和标题模板；改变稳定键策略必须显式迁移，不能在活动 Work Item 中静默切换。

```yaml
bindings:
  knowledge:
    provider: feishu-wiki
    stableKey: "repository-id:WSK-20260816-001"
    remoteId: wiki-node-token
    url: https://example.feishu.cn/wiki/example
    publishedRevision: sha256:example
    lastVerifiedAt: "2026-08-16T20:00:00+08:00"
```

发布内容包括最终规格、设计决策、使用方式、限制和验证结果，不包含凭据、模型隐藏推理、敏感日志和不必要过程工件。

当 `enabled: false` 时 Stage 为 `skipped`。任何 enabled publish Stage 都使 Work Item 进入 `pending_publish`。当 `required: false` 且远端明确返回失败时，Stage 为 `succeeded_with_warnings`；用户拒绝可选写入时为 `skipped`，二者均不阻止关闭。当 `required: true` 时，拒绝、发布失败或回读失败会阻止关闭。无论是否必需，只要外部写入结果未知，都必须进入 `reconciliation_required`，完成回读和明确处置后才能关闭，避免产生重复页面。

```text
wspec knowledge preview <work-item-id>
wspec knowledge publish <work-item-id>
wspec knowledge status <work-item-id>
wspec knowledge verify <work-item-id>
```

## 14. 安全边界

WiesenSpecKit 不调用模型或管理模型凭据，但仍会标记敏感来源，并默认将其排除在 Agent 执行上下文之外。

外部适配器必须声明文件读取、写入、命令、网络目标和凭据句柄需求；运行时按已批准策略强制限制，而不是仅记录声明。所有外部写入都使用幂等键，并在执行前记录意图、执行后记录结果或不确定状态。凭据不得出现在项目文件、工件、日志、Issue、Wiki 或生成的提示词中。

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
wspec approval request <work-item-id> <stage-id>
wspec approve <work-item-id> <stage-id>
wspec reject <work-item-id> <stage-id>
wspec issue sync <work-item-id>
wspec knowledge preview <work-item-id>
wspec knowledge publish <work-item-id>
wspec knowledge verify <work-item-id>
wspec verify <work-item-id>
wspec close <work-item-id>
```

机器调用使用 `--json`。CI 必须显式指定非交互策略：

```bash
wspec verify --non-interactive --policy .wsspec/ci-policy.yaml
```

错误同时提供稳定错误码、人类可读信息和 JSON 输出，并指出具体字段或状态、期望条件和修复命令。

## 16. 测试策略

测试覆盖以下层次：

- Schema 与编译器测试：覆盖 Workflow Language v1 的所有字段、扩展合并、错误、迁移，以及尝试绕过审批、可信验证、必需发布和高风险授权的不合法工作流。
- 引擎测试：按状态转换参考分别覆盖 Stage 与 Work Item 的成功、拒绝、超时、失败、取消、失效、重试、暂停恢复、对账和事件回放。
- 共享控制面测试：使用多个真实 Git worktree 和独立进程并发领取、审批、记录 Evidence 和更新 Work Item，验证只有一个事件源、无陈旧投影覆盖、锁互斥、配置快照固定和跨目录定位。
- 故障注入测试：分别在事件组追加中、事件组提交后投影写入前、关闭事件提交后归档写入前和持锁进程被 `SIGKILL` 后终止进程，验证恢复不会产生半完成业务操作、不会丢失已完成审批或 Evidence、能够重建归档，并且只清理可证明已死亡所有者的 stale lock。
- 幂等与恢复测试：在原操作之后追加其他事件再重试相同幂等键，验证返回原始结果；损坏或删除 `runtime.json` 后重放完整事件链，验证审批历史、Evidence、失效记录和关闭只读状态均保持一致。
- 扩展与适配器契约测试：覆盖来源和完整性锁定、权限变化重新授权、隔离失败、`unsandboxed` 拒绝、撤销、需求来源、Issue 同步、Knowledge 发布和 Agent 集成生成。
- 证据测试：覆盖 `trusted` 捕获、`attested` 身份与修订校验、`reported` 降级，以及代码或配置变化后的证据失效。
- 端到端测试：覆盖 Agent Pull Loop、交互式审批拒绝非 TTY 调用、跨宿主中断恢复、显式命令、文档输入、Issue 输入、独立 Issue/Knowledge Stage、可选知识发布失败、禁用知识发布、必需知识发布和带回读的归档发布。
- 发布包测试：构建 tarball 后在干净临时目录执行真实 `npm install`，通过安装后的 `wspec` 完成 `--help`、`init`、`new`、`status` 和最小关闭流程；M1 包不得把 M2 命令展示为可用功能。

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

## 17. 分阶段交付范围

### M1：核心协议

- 使用 Node.js 和 TypeScript 实现，发布 `wiesen-spec-kit` npm 包和 `wspec` 命令。
- 实现 Workflow Language v1、Project Config v1、Execution Contracts v1、对应 JSON Schema、带安全不变量检查的编译器和完整状态转换表。
- 实现双层状态机、事件日志、Claim、Agent Pull Loop 和 `interactive` 审批。
- 实现 Work Item 配置快照、基于 Git common dir 的共享控制面、跨 worktree 定位、审计快照和显式恢复。
- 提供内置 `verified-delivery` 工作流、Markdown/TXT 输入、Codex 集成、通用 Agent Skills 集成和完整 Recipe。
- 自动发现质量命令并由用户首次确认，提供 `trusted` 和 `reported` 证据及失效校验。

### M2：外部协作

- 增加 PDF、DOCX 和公开网页输入。
- 增加 GitHub、GitLab Issue 发现、选择、导入和同步。
- 增加独立的 Issue 同步适配器、带回读验证的 Knowledge/Wiki 适配器以及 `attested` CI 证据。
- 增加并行执行 `sync-issue` 与 `publish-knowledge` 的 `verified-delivery-external` Profile；两者分别配置 `enabled` 和 `required`。
- 增加 Claude Code、OpenCode 和 Cursor 集成，并全部通过同一 Pull Loop 契约测试。

### M3：扩展生态

- 增加飞书、Confluence 认证来源适配器契约。
- 增加扩展锁文件、完整性校验、权限授权、撤销和 `unsandboxed` 默认拒绝策略。
- 评估基于操作系统沙箱、容器或远程执行代理的强隔离；没有真实隔离证据前不得宣称第三方代码被沙箱限制。

所有阶段均使用 Apache-2.0 许可证，并提供由 Schema 生成和验证的参数参考文档。明确不包含直接模型调用、模型选择、模型凭据存储、自动 push、自动合并和自动发布版本。
