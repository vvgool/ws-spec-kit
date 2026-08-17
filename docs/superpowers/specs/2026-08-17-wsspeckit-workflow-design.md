# WSSpecKit Workflow 设计规格

## 1. 目标

WSSpecKit 是由当前 Agent 会话中的 Driver Skill 驱动、支持自由定制、阶段级 Skill 绑定和跨会话恢复的软件开发工作流引擎。

它支持从用户描述、本地文件、GitHub/GitLab Issue、飞书文档等来源获取需求，并将任务编排为代码探索、需求澄清、方案设计、任务计划、TDD 实现、Review-Fix 循环、可信验证、Git 提交、Issue 更新、知识库发布和关闭等阶段。

首版提供完整的内置 Skill Catalog、一个基础功能交付工作流，以及 `quick`、`standard`、`governed` 三种执行 Profile。用户可以在项目内组合、修改或创建 Workflow，也可以引用 WSSpecKit 内置 Skill、用户全局安装的 Skill 和项目自定义 Skill。

## 2. 设计原则

1. Agent 管理模型、对话、Token、上下文、代码检索、工具和子 Agent。
2. WSSpecKit 管理 Workflow、Step、Artifact、Checkpoint、Binding、审批、验证、恢复和审计。
3. Workflow 描述交付流程，不调用或托管模型。
4. Skill 指导 Agent 如何完成 Step，不能授予权限或绕过安全策略。
5. 当前 Agent 会话负责驱动流程；首版不提供 daemon、模型 Provider 或无人值守 Agent Runner。
6. 活动 Work Item 固定 Workflow、Skill、Schema、配置和来源快照，后续升级不能静默改变执行语义。
7. Workflow Language 只提供有限控制结构，不演变为通用编程语言。
8. Profile 只调整执行强度，不能关闭可信验证、外部写入授权等安全底线。
9. 所有用户文档、CLI 文案、内置 Workflow 说明、模板和内置 Skill 正文使用中文；协议字段、命令、URI、Schema ID 和错误码使用英文标识。

## 3. 产品命名

| 对象 | 名称 |
|---|---|
| 产品 | WSSpecKit |
| 仓库和 npm 包 | `ws-spec-kit` |
| CLI | `wspec` |
| 项目目录 | `.wsspec/` |
| Work Item ID | `WSS-...` |
| 错误码前缀 | `WSSPEC_` |

仓库物理目录由发布准备流程直接改名。npm 名称在发布前必须验证可用性。

## 4. 总体架构

```text
用户自然语言
  -> Codex / Claude / Cursor
  -> WSSpecKit Driver Skill
  -> Application Protocol
       start / acquire / submit / decide / inspect
  -> Workflow Runtime
       Compiler / Step Registry / Skill Resolver / Policy
  -> Artifact / Approval / Evidence / Connector
  -> Git worktree + Git common-dir 控制面
```

### 4.1 Agent 执行平面

当前 Agent 负责：

- 读取 Work Package 引用的文件和工件。
- 解析并遵循当前 Step 绑定的 Skill。
- 管理自身上下文和 Token。
- 使用自身的代码编辑、终端、浏览器和子 Agent 能力。
- 生成符合 Result Contract 的结构化结果。

### 4.2 WSSpecKit 治理平面

WSSpecKit 负责：

- 编译并推进 Workflow。
- 返回当前可执行 Work Package。
- 校验 Attempt、输入版本、修改范围、Artifact 和 Result。
- 执行可信质量 Gate。
- 管理人工审批和外部写入授权。
- 持久化状态、恢复中断执行并生成审计记录。

## 5. 核心领域模型

面向用户和 Workflow 作者的核心概念只有：

- **Workflow**：一套可版本化的软件交付流程。
- **Profile**：同一 Workflow 的执行强度配置，用于调整 Step、审批、Gate、Review 和发布要求。
- **Step**：Workflow 中的一个执行单元。
- **Skill Binding**：Step 要求当前 Agent 使用的工作方法。
- **Artifact**：Step 之间传递的持久化工件。
- **Checkpoint**：审批、验证、重试或恢复边界。
- **Binding**：Work Item 与 Issue、需求文档或知识库页面的关联。
- **Work Item**：一次具体需求交付及其生命周期。

Claim、Lease、Event、Digest 和 Projection 是内部可靠性机制，不作为普通用户的主要交互概念。

## 6. 发布包结构

首版发布一个自包含 npm 包，避免 CLI、Workflow 和 Skill 发生版本漂移：

```text
ws-spec-kit/
├── dist/
├── schemas/
├── resources/
│   ├── workflows/
│   │   └── feature-delivery/
│   │       ├── manifest.yaml
│   │       ├── workflow.yaml
│   │       ├── profiles/
│   │       │   ├── quick.yaml
│   │       │   ├── standard.yaml
│   │       │   └── governed.yaml
│   │       └── workflow.lock
│   ├── skills/
│   │   ├── driver/SKILL.md
│   │   ├── requirement-capture/SKILL.md
│   │   ├── code-exploration/SKILL.md
│   │   ├── requirement-clarification/SKILL.md
│   │   ├── specification/SKILL.md
│   │   ├── technical-design/SKILL.md
│   │   ├── task-planning/SKILL.md
│   │   ├── tdd-implementation/SKILL.md
│   │   ├── code-review/SKILL.md
│   │   ├── review-fix/SKILL.md
│   │   ├── verification/SKILL.md
│   │   ├── git-commit/SKILL.md
│   │   ├── issue-update/SKILL.md
│   │   └── wiki-publish/SKILL.md
│   ├── templates/
│   └── connectors/
└── package.json
```

内置 Skill 可以吸收 Superpowers 等成熟方法，但由 WSSpecKit 自己维护，不形成第三方运行依赖。

## 7. Skill 系统

### 7.1 Skill 来源

Workflow 可以显式引用三类 Skill：

| URI | 来源 | 示例 |
|---|---|---|
| `builtin://` | WSSpecKit 发布包 | `builtin://skills/tdd-implementation` |
| `global://` | 用户全局安装 | `global://superpowers/test-driven-development` |
| `project://` | 当前项目 | `project://skills/payment-security-review` |

不允许按照名称隐式覆盖。每个引用必须声明来源，避免在不同机器或 Agent 上解析到不同内容。

### 7.2 组合与回退

多个绑定默认全部加载：

```yaml
skills:
  - ref: builtin://skills/code-review
    required: true
  - ref: project://skills/security-review
    required: true
```

用户全局 Skill 可以回退到内置 Skill：

```yaml
skills:
  - ref: global://superpowers/test-driven-development
    fallback: builtin://skills/tdd-implementation
    required: true
```

- `required: true` 且主引用及 fallback 都不可用时，Step 进入 `blocked`。
- `required: false` 的 Skill 缺失时记录警告并继续。
- 找到主引用时不再加载其 fallback。
- 一个 Step 的独立绑定之间不存在覆盖关系。

### 7.3 Global Skill Resolver

Agent Adapter 负责将 `global://<相对路径>` 解析为当前客户端可读取的
`<root>/<相对路径>/SKILL.md`。首版只解析 Skill，不把 Cursor Rule 当作 Skill。

默认搜索根以宿主官方发现规则为准：

| Provider | 默认用户级搜索根 | 说明 |
|---|---|---|
| `codex` | `~/.agents/skills` | Codex 官方用户级 Skill 目录 |
| `claude` | `~/.claude/skills` | Claude Code 官方 Personal Skill 目录 |
| `cursor` | `~/.agents/skills`、`~/.cursor/skills`、`~/.claude/skills`、`~/.codex/skills` | Cursor 官方兼容目录，按表中顺序扫描 |
| `generic` | 无 | 必须在项目配置中显式声明 |

项目可以为任意 Provider 增加 `skills.additionalGlobalRoots`，但不能删除或重排
官方默认根。附加根必须是绝对路径或基于用户目录展开的路径；配置和 Lock 只保存
根的逻辑标识，不保存用户目录绝对路径。

Resolver 扫描全部候选根，不采用“第一个文件静默胜出”。逻辑引用的每一段只能包含
小写字母、数字和连字符，拒绝空段、`.`、`..`、绝对路径和编码后的路径分隔符。未找到时
只允许使用 Workflow 显式声明的 fallback；找到一个候选时直接返回；找到多个且摘要一致时
按搜索顺序选择并记录全部来源；找到多个且摘要不一致时返回 `WSSPEC_SKILL_AMBIGUOUS`。
入口文件或其父目录经真实路径解析后逃出声明根时返回 `WSSPEC_SKILL_PATH_ESCAPE`。

Resolver 返回逻辑引用、Provider、根标识、入口文件、内容摘要、候选来源和解析状态；
可移植 Workflow 与 Work Item 事件不记录本机绝对路径。宿主是否会自动触发 Skill
不影响绑定语义：Driver Skill 必须按 Work Package 中的绑定读取已解析 Skill，Workflow
绑定是确定性要求，不依赖模型自行猜测触发。

目录基线依据当前宿主官方规范：Codex 使用 `.agents/skills`，Claude Code 使用
`.claude/skills`，Cursor 支持 `.agents/skills`、`.cursor/skills` 及 Claude/Codex 兼容目录。
实现和发布验收时必须重新核对官方规范，不能只依据开发机现有目录。

### 7.4 Skill Lock

Work Item 创建时生成 Skill Lock：

```yaml
version: 1
skills:
  - requested: global://superpowers/test-driven-development
    resolved: global://superpowers/test-driven-development
    provider: codex
    digest: sha256:example
    fallback: builtin://skills/tdd-implementation
    fallbackDigest: sha256:fallback
```

- Builtin 和 Project Skill 随 Work Item 完整快照。
- Global Skill 首版记录来源和摘要，不复制其内容。
- Global Skill 缺失时，尚未开始的 Step 可以使用已锁定 fallback。
- Global Skill 内容变化时暂停执行，要求更新锁或选择 fallback。
- 已完成 Step 不因 Skill 升级自动重跑，但保留其实际 Skill 摘要。

## 8. Workflow Package

项目 Workflow 可以携带自己的 Skill、Schema 和模板：

```text
.wsspec/workflows/team-feature-delivery/
├── manifest.yaml
├── workflow.yaml
├── workflow.lock
├── profiles/
├── skills/
├── schemas/
├── templates/
├── examples/
└── tests/
```

`manifest.yaml` 声明 Workflow 版本、所需 WSSpecKit 版本、支持的 Profile、能力、Connector 和入口文件。第三方 Workflow Package 首次使用时必须展示来源、文件清单、Skill 摘要和外部副作用能力，并由用户确认信任。

## 9. Workflow Language v1

### 9.1 Step 类型

首版只提供四类执行模型：

| `uses` | 执行者 | 用途 |
|---|---|---|
| `agent.execute` | 当前 Agent | 探索、澄清、设计、计划、实现、Review、修复 |
| `command.execute` | WSSpecKit | Test、Lint、Typecheck、Build 和确定性脚本 |
| `connector.execute` | Connector Adapter | 需求读取、Git、GitHub/GitLab、飞书和 Wiki |
| `control.*` | Workflow Runtime | 条件、有限循环、审批和关闭 |

`uses` 决定执行方式和副作用边界，`skills` 决定 Agent 使用的工作方法，两者不能混用。

### 9.2 控制能力

首版支持：

- `needs`
- `when`
- `retry.maxAttempts`
- `loop.until`
- `loop.maxIterations`
- `approval`
- `inputs` / `outputs`

首版不支持任意表达式语言、动态 DAG 改写、无限嵌套循环、分布式并发调度或无人值守 Agent Runner。

表达式只能引用已声明的 Step 输出、Artifact 元数据、Binding 状态和有限比较操作。解析失败、未知引用或类型不匹配必须在编译期拒绝。

### 9.3 Profile

Profile 是 Workflow Package 内的显式 overlay。Workflow 定义完整 Step 图，Profile 只能调整以下字段：

- Step 是否启用；禁用后以 `skipped` 参与依赖计算。
- Artifact 是否必需以及内容级别。
- Step 是否需要人工审批。
- Review 循环上限和是否要求独立执行主体。
- 必需质量 Gate 集合。
- Issue、Knowledge 等发布目标是否为关闭前必需项。
- 审计记录级别和保留要求。

Profile 不得修改 Step 的 `uses`、Skill 来源、依赖关系、安全类别或外部目标，也不能关闭引擎安全内核。每份 Profile 都必须与 Workflow 一起编译；被启用 Step 如果消费了被跳过 Step 的必需输出，编译直接失败。

内置基础工作流提供：

| Profile | 适用任务 | 流程强度 |
|---|---|---|
| `quick` | 小型、低风险、局部修改 | 简要规格，跳过独立设计，紧凑单任务计划，单轮 Review，最小可信 Gate |
| `standard` | 默认功能和缺陷开发 | 完整规格、设计、计划、Review-Fix 和项目标准 Gate |
| `governed` | 权限、支付、数据、发布及高风险任务 | 分阶段审批、独立 Review、完整 Gate、必需发布回读和完整审计 |

内置 Profile 的规范差异为：

| 策略 | `quick` | `standard` | `governed` |
|---|---|---|---|
| 设计与计划 | 跳过独立设计；紧凑单任务计划必需 | 完整设计和计划必需 | 完整设计和计划必需 |
| Artifact 审批 | 无默认审批 | 规格、设计 | 规格、设计、计划 |
| Review-Fix | 最多 1 轮 | 最多 5 轮 | 最多 5 轮且 Review Actor 独立 |
| Trusted Gate | `test` | 项目 required Gates | 项目全部 configured Gates |
| Issue/Knowledge | 默认可选 | 默认可选 | 按项目策略，可设为关闭前必需 |
| 审计 | 标准事件和结果 | 标准事件、Artifact、Evidence | 完整决策、审批、Actor、发布与回读记录 |

所有 Profile 中，Git commit 和外部写入仍受独立的精确授权约束；表中的 Artifact 审批不能替代外部动作授权。

示例 overlay：

```yaml
version: 1
profile:
  id: quick
  workflow: feature-delivery

steps:
  clarify:
    approval: false
    artifactLevel: compact
  design:
    enabled: false
  plan:
    artifactLevel: compact
  review-fix:
    maxIterations: 1
  verify:
    gates: [test]

publishing:
  issueRequired: false
  knowledgeRequired: false

audit:
  level: standard
```

#### Profile 选择与升级

`wspec start` 接受 `auto`、`quick`、`standard` 或 `governed`，默认 `auto`：

- `auto` 初始以 provisional `quick` 只执行需求采集和代码探索，不允许提前进入实现。
- 探索完成后，风险为 low 时选择 `quick`，medium 或未知时选择 `standard`，high 时选择 `governed`。
- 用户可以在创建 Work Item 时显式选择 Profile。
- Agent 可以提交带理由的升级建议，但不能自行降低 Profile。
- 项目风险策略可以根据 Issue 标签、需求风险字段、受影响路径、文件类型和计划动作声明最低 Profile。
- Runtime 在每次 `submit` 后重新评估确定性风险规则，只允许 `quick -> standard -> governed` 单向自动升级。
- 升级后重新编译未完成执行图；新增的前置 Step 必须完成，受影响的审批和下游结果失效。
- 降级必须由用户显式创建决策记录，并且仍不能低于项目风险策略要求或安全内核底线。

项目风险策略示例：

```yaml
version: 1
profilePolicy:
  mode: auto
  provisional: quick
  unknown: standard
  rules:
    - id: security-code
      paths: ["src/auth/**", "src/permissions/**"]
      minimum: governed
    - id: database-change
      paths: ["migrations/**", "schema/**"]
      minimum: governed
    - id: documentation-only
      paths: ["docs/**"]
      minimum: quick
```

路径信息尚不可用时不提前猜测；在代码探索、计划或实际修改暴露路径后再升级。Profile 选择和每次升级都写入事件及审计快照。

### 9.4 内置基础工作流

```yaml
version: 1

workflow:
  id: feature-delivery
  version: 1

inputs:
  requirement:
    accepts:
      - user.prompt
      - local.file
      - github.issue
      - gitlab.issue
      - feishu.document

steps:
  - id: intake
    uses: connector.execute
    action: requirement.capture
    outputs: [requirement-source]

  - id: explore
    uses: agent.execute
    needs: [intake]
    objective: 探索代码并提取需求相关约束
    skills:
      - ref: builtin://skills/code-exploration
        required: true
    outputs: [exploration-report]

  - id: clarify
    uses: agent.execute
    needs: [explore]
    objective: 澄清需求并生成可验收规格
    skills:
      - ref: builtin://skills/requirement-clarification
        required: true
      - ref: builtin://skills/specification
        required: true
    outputs: [specification]
    approval: required

  - id: design
    uses: agent.execute
    needs: [clarify]
    objective: 形成可实施的技术方案
    skills:
      - ref: builtin://skills/technical-design
        required: true
    outputs: [design]
    approval: required

  - id: plan
    uses: agent.execute
    needs: [clarify, design]
    objective: 将设计拆分为可验证任务
    skills:
      - ref: builtin://skills/task-planning
        required: true
    outputs: [tasks]
    inputs:
      - artifact: specification
        required: true
      - artifact: design
        required: false

  - id: implement
    uses: agent.execute
    needs: [plan]
    objective: 按任务使用 TDD 完成功能
    skills:
      - ref: builtin://skills/tdd-implementation
        required: true
    outputs: [implementation-result]

  - id: review-fix
    uses: control.loop
    needs: [implement]
    until: ${review-result.approved}
    maxIterations: 5
    steps:
      - id: review
        uses: agent.execute
        skills:
          - ref: builtin://skills/code-review
            required: true
        outputs: [review-result]

      - id: fix
        uses: agent.execute
        when: ${review-result.approved == false}
        skills:
          - ref: builtin://skills/review-fix
            required: true

      - id: verify
        uses: command.execute
        action: quality.verify

  - id: commit
    uses: connector.execute
    action: git.commit
    needs: [review-fix]
    approval: required

  - id: update-issue
    uses: connector.execute
    action: issue.update
    needs: [commit]
    when: ${bindings.issue.exists}

  - id: update-wiki
    uses: connector.execute
    action: knowledge.publish
    needs: [commit]
    when: ${bindings.knowledge.exists}

  - id: close
    uses: control.close
    needs: [update-issue, update-wiki]
```

`update-issue` 和 `update-wiki` 在 Binding 不存在时进入 `skipped`；内置基础工作流允许关闭。配置为必需发布目标时，确定失败或缺少回读证据必须阻止关闭。

`plan` 对 `design` 的依赖是可选 Artifact 依赖：Quick 中 `design` 为 `skipped` 时，
`plan` 必须直接根据 `specification` 生成一个包含修改范围、测试先行步骤、验收命令和
回滚点的紧凑单任务计划。`implement` 在所有 Profile 下都只消费 `tasks`，不存在无计划实现。

## 10. Application Protocol

Driver Skill、CLI 和未来可选的 MCP Adapter 使用同一用例接口：

```ts
interface WSSpecApplication {
  start(input: StartInput): Promise<StartResult>;
  acquire(input: AcquireInput): Promise<AgentAction>;
  submit(input: SubmitInput): Promise<AgentAction>;
  decide(input: ApprovalDecision): Promise<AgentAction>;
  inspect(input: InspectInput): Promise<WorkItemView>;
}
```

```ts
type AgentAction =
  | { action: "execute"; workPackage: WorkPackage }
  | { action: "await_approval"; approval: ApprovalSummary }
  | { action: "blocked"; problems: Problem[] }
  | { action: "completed"; summary: CompletionSummary };
```

### 10.1 Work Package

Work Package 是执行契约，不是模型上下文。它只包含：

- Work Item、Step 和 Attempt 身份。
- Objective。
- 已解析 Skill 描述符和摘要。
- 输入 Artifact 的路径、类型、revision 和摘要。
- 允许修改路径及禁止动作。
- 必需输出和验收 Gate。
- Result Schema。

它不包含对话历史、隐藏推理、完整代码或默认内嵌的工件正文。

### 10.2 Acquire 与 Submit

`acquire` 原子获取下一可执行 Step、创建 Attempt 和内部 Execution Lease，并返回 Work Package。

`submit` 接收结构化执行结果，由引擎独立重算工作区摘要、修改文件、Artifact 内容和输出契约。首版不公开 `next/claim/context/complete` 等内部细粒度命令。

## 11. Driver Skill

发布包提供 WSSpecKit Driver Skill，并支持：

```text
wspec agent install codex
wspec agent install claude
wspec agent install cursor
wspec agent install generic
```

Driver Skill 的循环是：

```text
识别工作流触发
  -> start 或 resume
  -> acquire
  -> 读取当前 Step 绑定的 Skills
  -> 当前 Agent 原生执行
  -> submit
  -> 重复，直到审批、阻塞或完成
```

审批必须暂停并交还用户。会话中断后，新会话通过 `inspect + acquire` 从持久化状态继续；`start` 只创建新 Work Item。

## 12. 项目初始化与自定义

`wspec init` 必须生成完整项目配置：

```text
.wsspec/
├── repository.yaml
├── config.yaml
├── workflow.yaml
├── workflows/
├── skills/
└── archive/
```

默认选择内置基础工作流：

```yaml
version: 1
activeWorkflow:
  ref: builtin://workflows/feature-delivery
  version: 1
profile: auto
```

用户可以执行：

```text
wspec workflow list
wspec workflow show feature-delivery
wspec workflow eject feature-delivery
wspec workflow validate
wspec workflow use project://workflows/feature-delivery
```

`eject` 将内置 Workflow 复制到项目目录，此后由项目维护，不再随包升级自动变化。项目 Workflow 可以删除、增加或重排 Step，绑定 Builtin、Global 和 Project Skill，并增加项目专用审批或 Connector。

## 13. Connector 架构

首版 Connector 能力包括：

- Requirement Source：用户描述、本地 Markdown/TXT、GitHub Issue、GitLab Issue、飞书文档。
- Git：worktree、status、diff、commit。
- Issue：GitHub/GitLab Issue 读取、更新进度、写回交付结果、关闭或状态同步。
- Knowledge：创建或更新 Wiki/飞书文档并回读。

Connector Manifest 必须声明 `external-read` 或 `external-write`、目标类型、幂等能力、回读能力和所需凭据引用。凭据由 Agent/Connector 运行环境管理，不进入 Workflow、Artifact、Work Package、事件或日志。

外部写入必须具备稳定目标、内容摘要、幂等键和回读证据。Git commit、Issue 状态修改、知识库发布以及未来的 push、merge、release 都受精确授权策略控制。

### 13.1 首版 Provider

外部 Provider 通过 `spawn` 的固定可执行文件和 argv 调用，不经过 Shell，不接受 Workflow
拼接命令。Provider 进程只接收规范化 JSON 输入并返回规范化 JSON；stderr 脱敏后只作为
诊断信息。CLI 自身的认证存储由对应工具管理，WSSpecKit 不读取或持久化 Token、Cookie、
Keychain 内容或 CLI 配置文件。

| 能力 | Provider | 固定调用契约 | 认证与可用性 |
|---|---|---|---|
| `github.issue` | `github-cli` | 读取：`gh api --method GET <固定端点>`；写入：`gh api --method <POST|PATCH> <固定端点> --input -` | 使用 `gh auth` 或其官方环境变量；`doctor` 校验 `gh api user` |
| `gitlab.issue` | `gitlab-cli` | 读取：`glab api --method GET <固定端点>`；写入：`glab api --method <POST|PUT> <固定端点> --input -` | 使用 `glab auth`；首版要求预装 `glab`，缺失时返回可操作诊断 |
| `feishu.document` / `knowledge.publish` | `lark-cli` | 读取：`docs +fetch --doc <target> --format json --as <identity>`；写入：`docs +create/+update` 各自固定参数，使用默认 JSON 输出 | 使用 `lark-cli auth`；不接受浏览器 Cookie |
| `git.commit` | `git-native` | Node `spawn("git", argv)` 的允许列表 | 使用当前仓库身份；不实现 push、merge、release |

Issue 规范化模型至少包含 `provider`、`host`、`repository`、`number`、`stableId`、`url`、
`title`、`body`、`state`、`labels`、`updatedAt` 和 `digest`。GitHub 端点限定为
`repos/{owner}/{repo}/issues/{number}` 及其 comments；GitLab 端点限定为
`projects/{urlEncodedPath}/issues/{iid}` 及其 notes。目标字段分别保存 GitHub `number/node_id`
和 GitLab `iid/id`，不得混用。

飞书读取使用文档 URL 或 token；创建必须指定 folder token、wiki node 或 wiki space 中之一；
更新必须指定已解析 doc token。每次写入后再次 `+fetch --format json`，比较目标 token、标题和
正文摘要。CLI 返回非零、JSON Schema 不匹配或回读摘要不一致都不能形成成功 Evidence。

Provider Manifest 声明最低 CLI 版本、可执行文件名、允许的 argv 模板、输入/输出 Schema、
超时、最大响应体和脱敏字段。`wspec doctor connectors` 输出 `available`、`unauthenticated`、
`unsupported_version` 或 `missing_binary`，但不得回显凭据。

## 14. 持久化与恢复

项目内保存可移植事实：

```text
.wsspec/work-items/<id>/
├── work-item.yaml
├── source/
├── snapshot/
│   ├── workflow/
│   ├── skills/
│   ├── schemas/
│   └── config.yaml
├── artifacts/
└── archive/
```

Git common-dir 保存共享运行控制面：

```text
.git/wsspec/work-items/<id>/
├── locator.json
├── runtime.json
├── events.ndjson
└── runtime.lock
```

现有事件哈希链、事件先于投影、原子写入、幂等键、锁、投影回放和归档后只读语义继续保留。当前会话结束不影响 Work Item 状态；未完成 Attempt、租约和审批按恢复规则失效或回到可执行状态。

## 15. 安全边界

1. Skill 是执行指导，不是授权主体。
2. Workflow 和 Skill 不能关闭引擎安全不变量。
3. 第三方 Workflow、Global Skill 和 Project Skill 均视为不可信指令来源。
4. Skill 内容变化必须通过摘要检测，不能静默继续。
5. WSSpecKit 的路径限制和摘要校验不是 OS 沙箱，也不防御拥有当前用户完整 Shell 权限的恶意 Agent。
6. 外部写入、Git 高风险操作和发布动作需要精确目标授权。
7. Agent 报告的命令只能产生 reported Evidence；trusted Evidence 只能由引擎直接执行并捕获的 Gate 产生。

## 16. 当前实现改造

### 16.1 复用的实现能力

- `src/domain/digests.ts`
- `src/domain/artifacts.ts`
- `src/domain/states.ts`
- `src/storage/events.ts`
- `src/storage/control-plane.ts`
- `src/storage/work-items.ts`
- `src/engine/approvals.ts`
- `src/engine/verification.ts`
- Git worktree、事件哈希链、原子投影、恢复、Evidence 和归档机制

### 16.2 重构

- `src/engine/compiler.ts`：重写为 Workflow Language v1 编译器，支持 Step Manifest、Skill Binding 和有限控制结构。
- `src/engine/orchestrator.ts`：拆为 Application Protocol 用例。
- `src/engine/claims.ts`：Claim 降为内部 Execution Lease。
- `StageContext`：重命名并收敛为 Work Package。
- `src/cli/commands/core.ts`：变为 Application Protocol 的 CLI Adapter。
- `src/integrations/`：替换为 Agent Skill Adapter 与安装器。

### 16.3 新增目录

```text
src/
├── application/
├── protocol/
├── policy/
├── registry/
│   ├── executors/
│   ├── connectors/
│   └── skills/
├── workflow-package/
└── adapters/
    ├── cli/
    ├── skills/
    └── mcp/
```

`mcp` 是未来可选 Adapter，不是首版完成条件。

## 17. 一次性替换策略

当前项目尚未形成需要支持的正式发布版本，因此直接以本规格作为首个正式协议基线：

- 删除旧 Workflow、Stage Context、Stage Result 和项目配置 Schema，不提供双版本读取。
- 删除 `next/claim/context/complete` 公开命令，只提供 `start/acquire/submit/decide/inspect`。
- 删除固定 `define/design/plan/implement/review/verify/publish/close` 类型约束，使用 Step Manifest 和安全类别。
- 现有测试中仍然适用于摘要、事件、锁、审批、验证和恢复的场景按新协议改写；旧接口断言直接删除。
- 不提供 `migrate` 命令、兼容别名、旧包转发层或活动 Work Item 迁移。
- 产品、包、Work Item ID 和错误码直接采用 WSSpecKit 新命名。

## 18. 实施阶段

1. **规格基线**：产品改名、Workflow Language v1、Skill URI、Manifest 和 Application Protocol Schema。
2. **Application Facade**：在现有内核上实现 `start/acquire/submit/decide/inspect`。
3. **Skill Catalog**：内置 Skills、三层 Resolver、fallback、摘要和 Skill Lock。
4. **Workflow Package**：内置基础工作流、项目 Workflow、`list/show/eject/validate/use`。
5. **Profile Engine**：三种内置 Profile、overlay 编译、风险策略、单向升级和失效传播。
6. **有限控制流**：条件、重试和有界 Review-Fix 循环。
7. **Driver Adapter**：Codex、Claude、Cursor 和 Generic 安装与恢复流程。
8. **Source Connector**：Prompt、文件、GitHub/GitLab Issue 和飞书文档快照。
9. **Delivery Connector**：Git commit、Issue 更新、Wiki 发布、幂等和回读。
10. **发布验收**：完整文档、安装包、Driver Skill 和真实客户端验收。

每个阶段必须先为新协议增加失败测试再实现。可复用的现有安全与恢复场景必须按新协议重写，不要求旧接口测试继续通过。

## 19. 验收标准

- 首次安装后，不依赖第三方 Skill 即可执行内置基础工作流。
- 所有发布文档、模板和内置 Skill 正文均为中文，且 CI 扫描不得出现未登记的英文用户文案。
- 内置基础工作流提供 `quick`、`standard`、`governed`，并由同一 Runtime 执行。
- `auto` 先以 provisional `quick` 完成采集和探索，再按风险选择 Profile；风险未知使用 `standard`。
- Profile overlay 不能修改 Step 安全类别、外部目标或关闭安全内核。
- Profile 升级会补回必需 Step，并失效受影响的审批、结果和 Evidence。
- 项目自定义 Workflow 可以声明自己的 Profile overlay 和最低风险要求。
- 项目 Workflow 可以绑定多个 Builtin、Global 和 Project Skill。
- Global Skill 可以显式回退到 Builtin Skill。
- Global Skill 按宿主官方目录和显式附加目录解析；同名不同摘要必须阻塞，不得静默覆盖。
- 必需 Skill 缺失、摘要变化或 Workflow Package 被篡改时 fail closed。
- Workflow 可以携带项目自己的 Skill、Schema 和模板。
- 用户描述、本地文件、GitHub Issue、GitLab Issue 和飞书文档均能形成不可变需求来源快照。
- Quick 也必须产出紧凑单任务计划，任何 Profile 都不能直接从规格跳到无计划实现。
- Review-Fix 循环能在通过时结束，并在达到 `maxIterations` 时阻塞。
- Agent 自主管理上下文；Work Package 不默认内嵌工件正文或对话历史。
- 会话中断后，新 Agent 会话可以从下一可执行 Step 恢复。
- Git commit、Issue 更新和 Wiki 发布具备审批、幂等和回读证据。
- 仓库中不残留旧产品名、旧公开命令、旧 Schema ID、`WSK-` 或 `WSPEC_` 对外协议。
- 单元、契约、集成、E2E、构建、Schema 漂移和 `npm pack --dry-run` 全部通过。
- 本地 Fixture、已登录客户端测试和真实 GitHub/GitLab/飞书验收必须分别报告，不能互相替代。

## 20. 非目标

- WSSpecKit 直接选择或调用模型。
- 管理 Agent 对话、Token、记忆或上下文压缩。
- 后台 daemon 和无人值守 Agent Runner。
- 分布式调度和多租户服务。
- 任意编程语言式 Workflow 表达式。
- 未经授权自动 push、merge、release 或改变外部状态。
