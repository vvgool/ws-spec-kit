# WSSpecKit Workflow v2 设计规格

## 1. 目标

WSSpecKit 是由当前 Agent 会话中的 Driver Skill 驱动、支持自由定制、阶段级 Skill 绑定和跨会话恢复的软件开发工作流引擎。

它支持从用户描述、本地文件、Git/GitLab Issue、飞书文档等来源获取需求，并将任务编排为代码探索、需求澄清、方案设计、任务计划、TDD 实现、Review-Fix 循环、可信验证、Git 提交、Issue 更新、知识库发布和关闭等阶段。

首版提供完整的内置 Skill Catalog 和一个基础功能交付工作流。用户可以在项目内组合、修改或创建 Workflow，也可以引用 WSSpecKit 内置 Skill、用户全局安装的 Skill 和项目自定义 Skill。

## 2. 设计原则

1. Agent 管理模型、对话、Token、上下文、代码检索、工具和子 Agent。
2. WSSpecKit 管理 Workflow、Step、Artifact、Checkpoint、Binding、审批、验证、恢复和审计。
3. Workflow 描述交付流程，不调用或托管模型。
4. Skill 指导 Agent 如何完成 Step，不能授予权限或绕过安全策略。
5. 当前 Agent 会话负责驱动流程；首版不提供 daemon、模型 Provider 或无人值守 Agent Runner。
6. 活动 Work Item 固定 Workflow、Skill、Schema、配置和来源快照，后续升级不能静默改变执行语义。
7. Workflow Language 只提供有限控制结构，不演变为通用编程语言。

## 3. 产品命名

| 对象 | 名称 |
|---|---|
| 产品 | WSSpecKit |
| 仓库和 npm 包 | `ws-spec-kit` |
| CLI | `wspec` |
| 项目目录 | `.wsspec/` |
| Work Item ID | `WSK-...` |
| 错误码前缀 | `WSPEC_`，保持协议兼容 |

仓库物理目录的重命名不属于代码迁移的一部分，由发布流程单独处理。npm 名称在发布前必须验证可用性。

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

Agent Adapter 负责将 `global://` 逻辑引用解析为当前客户端可读取的 Skill：

- Codex：Codex 与共享 Agent Skill 目录。
- Claude：Claude Skill 目录及用户配置的共享目录。
- Cursor：Cursor 支持的 Rules/Skill 适配目录。
- Generic：项目配置声明的搜索目录。

Resolver 返回逻辑引用、Provider、入口文件、内容摘要和解析状态，不把实际路径写入可移植 Workflow。

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
├── skills/
├── schemas/
├── templates/
├── examples/
└── tests/
```

`manifest.yaml` 声明 Workflow 版本、所需 WSSpecKit 版本、能力、Connector 和入口文件。第三方 Workflow Package 首次使用时必须展示来源、文件清单、Skill 摘要和外部副作用能力，并由用户确认信任。

## 9. Workflow Language v2

### 9.1 Step 类型

首版只提供四类执行模型：

| `uses` | 执行者 | 用途 |
|---|---|---|
| `agent.execute` | 当前 Agent | 探索、澄清、设计、计划、实现、Review、修复 |
| `command.execute` | WSSpecKit | Test、Lint、Typecheck、Build 和确定性脚本 |
| `connector.execute` | Connector Adapter | 需求读取、Git、GitLab、飞书和 Wiki |
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

### 9.3 内置基础工作流

```yaml
version: 2

workflow:
  id: feature-delivery
  version: 1

inputs:
  requirement:
    accepts:
      - user.prompt
      - local.file
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
    needs: [design]
    objective: 将设计拆分为可验证任务
    skills:
      - ref: builtin://skills/task-planning
        required: true
    outputs: [tasks]

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

`acquire` 原子完成当前 M1 的 `next + claim + context`，内部仍可使用 Execution Lease 防止过期或重复提交。

`submit` 替代面向普通 Agent 的 `complete`，由引擎独立重算工作区摘要、修改文件、Artifact 内容和输出契约。旧命令保留一个兼容周期，仅作为高级调试接口。

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

审批必须暂停并交还用户。会话中断后，新会话通过 `resume + acquire` 从持久化状态继续。

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

- Requirement Source：用户描述、本地 Markdown/TXT、GitLab Issue、飞书文档。
- Git：worktree、status、diff、commit。
- Issue：读取、更新进度、写回交付结果、关闭或状态同步。
- Knowledge：创建或更新 Wiki/飞书文档并回读。

Connector Manifest 必须声明 `external-read` 或 `external-write`、目标类型、幂等能力、回读能力和所需凭据引用。凭据由 Agent/Connector 运行环境管理，不进入 Workflow、Artifact、Work Package、事件或日志。

外部写入必须具备稳定目标、内容摘要、幂等键和回读证据。Git commit、Issue 状态修改、知识库发布以及未来的 push、merge、release 都受精确授权策略控制。

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

### 16.1 保留

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

- `src/engine/compiler.ts`：支持 Workflow v2、Step Manifest、Skill Binding 和有限控制结构。
- `src/engine/orchestrator.ts`：拆为 Application Protocol 用例。
- `src/engine/claims.ts`：Claim 降为内部 Execution Lease。
- `StageContext`：重命名并收敛为 Work Package。
- `src/cli/commands/core.ts`：变为 Application Protocol 的 CLI Adapter。
- `src/integrations/`：迁移为 Agent Skill Adapter 与安装器。

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

## 17. 兼容与迁移

- Workflow v1 和所有活动 v1 Work Item 继续按其快照执行。
- 新项目和新 Work Item 默认使用 Workflow v2。
- `wspec migrate --dry-run` 必须先展示 Workflow、命名和协议迁移影响。
- v1 的 `next/claim/context/complete` 保留一个兼容周期。
- v2 使用 `start/acquire/submit/decide/inspect`。
- 产品展示名称改为 WSSpecKit；`wspec`、`.wsspec/`、`WSK-` 和 `WSPEC_` 保持兼容。

## 18. 实施阶段

1. **规格基线**：产品改名、Workflow v2、Skill URI、Manifest 和 Application Protocol Schema。
2. **Application Facade**：在现有内核上实现 `start/acquire/submit/decide/inspect`。
3. **Skill Catalog**：内置 Skills、三层 Resolver、fallback、摘要和 Skill Lock。
4. **Workflow Package**：内置基础工作流、项目 Workflow、`list/show/eject/validate/use`。
5. **有限控制流**：条件、重试和有界 Review-Fix 循环。
6. **Driver Adapter**：Codex、Claude、Cursor 和 Generic 安装与恢复流程。
7. **Source Connector**：Prompt、文件、GitLab Issue 和飞书文档快照。
8. **Delivery Connector**：Git commit、Issue 更新、Wiki 发布、幂等和回读。
9. **兼容发布**：v1 回归、迁移预览、文档、安装包和真实客户端验收。

每个阶段必须保持现有 M1 测试通过，并为新协议先增加失败测试再实现。

## 19. 验收标准

- 首次安装后，不依赖第三方 Skill 即可执行内置基础工作流。
- 项目 Workflow 可以绑定多个 Builtin、Global 和 Project Skill。
- Global Skill 可以显式回退到 Builtin Skill。
- 必需 Skill 缺失、摘要变化或 Workflow Package 被篡改时 fail closed。
- Workflow 可以携带项目自己的 Skill、Schema 和模板。
- 用户描述、本地文件、GitLab Issue 和飞书文档均能形成不可变需求来源快照。
- Review-Fix 循环能在通过时结束，并在达到 `maxIterations` 时阻塞。
- Agent 自主管理上下文；Work Package 不默认内嵌工件正文或对话历史。
- 会话中断后，新 Agent 会话可以从下一可执行 Step 恢复。
- Git commit、Issue 更新和 Wiki 发布具备审批、幂等和回读证据。
- v1 活动 Work Item 不受产品改名和 Workflow v2 影响。
- 单元、契约、集成、E2E、构建、Schema 漂移和 `npm pack --dry-run` 全部通过。
- 本地 Fixture、已登录客户端测试和真实 GitLab/飞书验收必须分别报告，不能互相替代。

## 20. 非目标

- WSSpecKit 直接选择或调用模型。
- 管理 Agent 对话、Token、记忆或上下文压缩。
- 后台 daemon 和无人值守 Agent Runner。
- 分布式调度和多租户服务。
- 任意编程语言式 Workflow 表达式。
- 未经授权自动 push、merge、release 或改变外部状态。
