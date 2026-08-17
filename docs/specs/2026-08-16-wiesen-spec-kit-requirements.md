# WiesenSpecKit M1 需求规格

## 1. 文档目的

本文定义 WiesenSpecKit M1 的可交付需求和验收条件，是实施计划、测试和发布验收的需求事实来源。技术方案见 `docs/specs/2026-08-16-wiesen-spec-kit-design.md`；字段级契约见 `docs/reference/`。

## 2. 用户与使用场景

主要用户是使用 Codex 或兼容 Agent Skills 编码工具的软件工程师。用户希望用自然语言或显式命令启动一项工程任务，由 Agent 按统一流程生成规格、设计、计划和实现，并由 WiesenSpecKit 可靠保存状态、执行门禁、支持中断恢复。

M1 必须支持以下主路径：

```text
本地 prompt 或 Markdown/TXT 需求
-> 创建隔离 Work Item
-> define -> design -> plan 人工审批
-> implement -> review
-> Engine 验证
-> 关闭和归档
```

## 3. M1 功能需求

### REQ-M1-001：仓库初始化与稳定身份

系统必须在 Git 仓库中显式初始化 `.wsspec/`，创建并提交语义稳定的 `repositoryId` 配置；不得根据路径或 remote 自动改变身份。

验收条件：

- `AC-001-1`：未初始化仓库执行工作流命令时返回稳定错误和初始化建议，不隐式初始化 Git 或 WiesenSpecKit。
- `AC-001-2`：初始化生成符合 Work Item v1 的 `.wsspec/repository.yaml`、配置和工作流文件。
- `AC-001-3`：clone 和新增 worktree 读取相同 `repositoryId`；控制面缓存不一致时拒绝运行。

### REQ-M1-002：Work Item 创建与隔离

系统必须为每项任务创建唯一 Work Item、独立分支和独立 Git worktree，并固定需求来源、基线和配置快照。

验收条件：

- `AC-002-1`：prompt、Markdown 或 TXT 输入均可创建 Source Snapshot，原始来源保持只读。
- `AC-002-2`：创建结果符合 Work Item v1，包含规范 worktree、分支、基线修订和所有必需摘要。
- `AC-002-3`：目标分支、worktree 或 Work Item ID 冲突时停止并报告精确目标，不复用未知内容。

### REQ-M1-003：声明式工作流校验

系统必须解析 Workflow Language v1，并在执行前完成结构、依赖、工件闭包和安全不变量校验。

验收条件：

- `AC-003-1`：合法的内置 `verified-delivery` 工作流通过 Schema 和编译检查。
- `AC-003-2`：未知字段、循环依赖、缺失工件生产者、owner/kind 不匹配均返回稳定错误码和字段路径。
- `AC-003-3`：自定义 Stage 名称不能绕过规格、设计、计划审批或可信验证要求。

### REQ-M1-004：Agent Pull Loop

Codex 与通用 Agent Skills 集成必须通过同一 CLI Pull Loop 获取和完成 Agent-owned Stage；WiesenSpecKit 不选择模型或启动 Agent。

验收条件：

- `AC-004-1`：`wspec next --json` 只返回可执行 Agent-owned Stage、门禁状态或完成状态。
- `AC-004-2`：Engine-owned Stage 由引擎内部执行，不签发 Agent Claim。
- `AC-004-3`：Codex 与通用集成通过同一契约 Fixture，且不直接修改共享控制面。

### REQ-M1-005：Claim 与并发控制

Agent-owned Stage 必须使用带期限的 Claim 和 Attempt 身份，防止两个 Agent 同时提交同一阶段。

验收条件：

- `AC-005-1`：同一 Stage 同时只有一个有效 Claim。
- `AC-005-2`：过期、释放或上游失效的 Claim 不能提交结果。
- `AC-005-3`：接管创建新 Attempt 并保留旧 Attempt 的审计记录。

### REQ-M1-006：Stage Context 与 Result

Agent 必须通过结构化 Context 接收目标和约束，并通过结构化 Result 报告输出；引擎不得信任 Agent 自报的文件、摘要或证据。

验收条件：

- `AC-006-1`：Context 包含输入工件、允许路径、期望输出、Claim 身份和 `inputWorkspaceTreeDigest`。
- `AC-006-2`：Result 同时提交匹配 Context 的输入摘要和完成后的 `outputWorkspaceTreeDigest`。
- `AC-006-3`：引擎独立重算输出摘要和修改文件；虚假摘要、越界路径或缺失输出导致拒绝。

### REQ-M1-007：内置 Artifact 契约

规格、设计、计划、任务、实现结果、审查结果和验证结果必须使用统一 front matter，并满足 Artifacts v1 的最低内容。

验收条件：

- `AC-007-1`：所有内置 Artifact 均通过对应 `builtin.<type>.v1` Schema。
- `AC-007-2`：内容哈希按 Execution Contracts v1 的规范化算法重算。
- `AC-007-3`：缺少必需章节、生产者身份不符或内容哈希错误时 Stage 不能成功。

### REQ-M1-008：交互式工件审批

define、design 和 plan 工件在被实现消费前必须由用户通过真实 TTY 审批精确内容。

验收条件：

- `AC-008-1`：审批界面展示工件差异、内容哈希、输出工作区摘要和失效范围。
- `AC-008-2`：`--yes`、管道、环境变量预授权和非交互调用均不能批准。
- `AC-008-3`：工件、工作区、配置、工作流或上游审批变化后旧审批失效。

### REQ-M1-009：状态机与失效传播

系统必须按 State Transitions v1 管理 Stage 与 Work Item 两套状态机，并拒绝所有未定义转换。

验收条件：

- `AC-009-1`：每次有效转换先追加事件，再原子更新运行投影。
- `AC-009-2`：已批准上游工件变化后，下游成功状态、Claim、审批和 Evidence 全部失效。
- `AC-009-3`：相同幂等键重复提交返回原结果，不重复转换或产生副作用。

### REQ-M1-010：可信质量验证

必需 Gate 只能由引擎直接执行并捕获的 `trusted` Evidence 满足；Agent 报告只能产生 `reported` Evidence。

验收条件：

- `AC-010-1`：质量命令使用固定 argv、worktree、环境白名单和超时执行，不经 Shell 拼接。
- `AC-010-2`：Evidence 绑定配置、Attempt、输入工件和被验证的 `workspaceTreeDigest`。
- `AC-010-3`：验证后工作区发生任何纳入摘要的变化，旧 Evidence 失效且 Work Item 不再保持 verified。

### REQ-M1-011：共享控制面与恢复

同一 Git 仓库的所有 worktree 必须共享唯一运行控制面，并能从事件链和已提交快照恢复。

验收条件：

- `AC-011-1`：从任意 worktree 查询同一 Work Item 得到相同状态。
- `AC-011-2`：进程中断后恢复不继承 Claim、租约或未完成审批。
- `AC-011-3`：投影损坏可以从完整事件链重建；事件链不连续时停止恢复。

### REQ-M1-012：关闭、归档与审计

Work Item 只有在必需 Stage、审批和质量 Gate 全部满足后才能关闭，并输出可校验的只读审计快照。

验收条件：

- `AC-012-1`：缺少必需工件、审批或可信 Evidence 时 `close` 被拒绝并指出缺项。
- `AC-012-2`：关闭记录最终工件、Evidence、状态和事件链末端哈希。
- `AC-012-3`：归档成功后运行控制面只读，清理需要独立显式命令。

### REQ-M1-013：CLI 与机器接口

所有核心操作必须同时提供可读终端输出和稳定 JSON 输出。

验收条件：

- `AC-013-1`：错误包含稳定错误码、字段或状态路径、实际值摘要和修复建议。
- `AC-013-2`：JSON 模式不混入装饰性终端文本，退出码与结果类别稳定对应。
- `AC-013-3`：CLI 帮助、JSON Schema 和参考文档来自同一字段定义，生成物漂移时 CI 失败。

## 4. 非功能需求

### REQ-M1-014：安全边界

系统不得保存模型或外部平台凭据，不得声称能够防御拥有当前用户完整 Shell 权限的恶意 Agent，也不得未经精确授权执行 push、合并、发布、删除或远程状态修改。

验收条件：

- `AC-014-1`：项目文件、事件、日志、工件和 Context 中不出现凭据值。
- `AC-014-2`：M1 无外部发布执行器；高风险 Git 操作默认拒绝。
- `AC-014-3`：安全说明明确 interactive approval 的误操作防护边界，不宣称强身份或 OS 沙箱。

### REQ-M1-015：确定性与兼容性

相同版本的规范输入必须产生相同摘要、编译结果和状态判断；未知字段和不支持版本必须 fail closed。

验收条件：

- `AC-015-1`：跨两次独立运行计算的 Artifact、配置、工作流和工作区摘要一致。
- `AC-015-2`：Schema 默认 `additionalProperties: false`，未知版本不会被猜测解析。
- `AC-015-3`：格式或协议升级必须先支持 dry-run 预览，不能静默迁移活动 Work Item。

## 5. M1 排除项

- GitHub/GitLab Issue 发现、导入和同步。
- Knowledge/Wiki 发布及 External Action 执行。
- PDF、DOCX、网页、飞书和 Confluence 来源。
- `attested` CI Evidence。
- Claude Code、OpenCode 和 Cursor 专用集成。
- 第三方扩展、签名审批、daemon、强沙箱和直接模型调用。
- 自动 push、合并、创建 PR/MR 或发布版本。

以上能力分别属于 M2、M3 或明确非目标；M1 可以定义其兼容边界，但不得把未实现能力暴露为可用功能。

## 6. 需求追踪矩阵

| 需求 | 设计依据 | 主要验证 |
|---|---|---|
| REQ-M1-001 | 设计 6；Work Item v1 | 初始化、clone、身份冲突 E2E |
| REQ-M1-002 | 设计 6、9、11；Work Item v1 | Source Fixture、真实 Git worktree E2E |
| REQ-M1-003 | 设计 5；Workflow Language v1 | Schema 正反例、编译器不变量测试 |
| REQ-M1-004 | 设计 7、8 | Pull Loop 与 Codex/Generic 契约测试 |
| REQ-M1-005 | 设计 6、7；State Transitions v1 | 并发 Claim、租约、接管测试 |
| REQ-M1-006 | 设计 7；Execution Contracts v1 | Context/Result Schema 与摘要篡改测试 |
| REQ-M1-007 | Artifacts v1；Execution Contracts v1 | 每种 Artifact 正反例测试 |
| REQ-M1-008 | 设计 5.2 | 真 TTY、非交互拒绝、失效传播测试 |
| REQ-M1-009 | 设计 6；State Transitions v1 | 全状态转换表驱动测试 |
| REQ-M1-010 | 设计 12；Project Config v1 | Gate 执行、证据等级、失效测试 |
| REQ-M1-011 | 设计 6；Work Item v1 | 多 worktree、崩溃和事件回放测试 |
| REQ-M1-012 | 设计 6、16 | close 负例、归档和审计哈希测试 |
| REQ-M1-013 | 设计 15 | CLI 快照、JSON 输出和生成物漂移测试 |
| REQ-M1-014 | 设计 5.1、14 | 凭据扫描与高风险操作拒绝测试 |
| REQ-M1-015 | 全部 v1 参考规范 | 确定性、未知字段和迁移测试 |

## 7. M1 完成定义

只有同时满足以下条件，M1 才能声明完成：

- `REQ-M1-001..015` 的全部验收条件均有自动测试或明确人工验收证据。
- 文档中的所有 YAML/JSON 示例通过发布包中的实际 Schema 校验。
- Codex 与 Generic Agent Skills 分别完成一次中断恢复后的完整本地交付流程。
- lint、typecheck、单元测试、契约测试、E2E、build 和 `npm pack --dry-run` 全部通过。
- 本地 Fixture 结果只证明 M1 本地能力，不宣称 M2 真实外部平台集成完成。

