# WSSpecKit

**WSSpecKit**，包名 `ws-spec-kit`，是一个由 Agent Skill 驱动、可配置的软件交付工作流引擎。它把需求来源、工作流、Skill、配置和执行状态绑定到 Work Item，使 Agent 按已声明的步骤交付软件或文档。

当前仍处于 beta 阶段；已发布版本以 npm 的 `beta` 标签为准。

## 中文概述

WSSpecKit 提供可执行文件 `wspec`。CLI 的成功、帮助与错误结果都以 JSON 写入标准输出，便于 Agent 或其他程序读取。

项目内置四种 Workflow Package：

- `builtin://workflows/feature-delivery`，用于功能交付。
- `builtin://workflows/bugfix-delivery`，用于先诊断再修复，合并重复规格与计划。
- `builtin://workflows/assessment`，用于显式要求留档的只读评估，不创建业务工作树或提交发布。
- `builtin://workflows/documentation-delivery`，用于纯文档交付，并限制改动范围为声明的文档路径。

Workflow 定义、Profile、所需 Skill 和结果的执行合同会在 Work Item 中快照；Workflow、Skill 和 Schema 正文不复制到每个 Work Item。恢复时会按 Lock 从当前允许来源重新验证，来源缺失或漂移会 fail closed。非内置工作流在首次使用或内容变化后需要明确的信任决定。外部连接器已有契约与本地自动化验证；真实 Provider 平台的验收状态以 [验收报告](docs/acceptance/release-report.md) 为准。

## 使用已有发布包

```sh
npm install -g ws-spec-kit@beta
wspec --help
# 进入需要管理的 Git 仓库后运行
wspec init
```

CLI 安装、项目初始化和 Agent Skill 加载是三个独立步骤。自 0.1.0-beta.16 起提供下面的 `agent setup` 和 `agent status` 命令；源码体验可构建后用 `node dist/cli/main.js` 替代 `wspec`。

以 Codex 为例（安全安装器当前支持 macOS）：

```sh
wspec agent status --client codex
wspec agent setup --client codex
wspec agent status --client codex
```

Claude 使用 `--client claude` 和 `~/.claude/skills/wsspeckit-driver`；Cursor 使用 `--client cursor` 和 `~/.cursor/skills/wsspeckit-driver`。Generic 需显式传 `--target <安装目录>`。setup 自动创建缺失目录，`--dry-run` 可预演且不写入。目录有链接或同名自定义文件时，先处理冲突，安装器不会覆盖。旧的 `agent install` 仍要求预先创建目录。

`status=current` 仅证明磁盘上的 Driver 与当前 CLI 匹配。随后在宿主中重新加载技能或开启新会话，确认技能列表出现 `wsspeckit-driver`，再显式调用它。CLI 无法确认会话是否加载，返回 `hostLoaded=unknown`。全局 npm 升级也不会自动升级已安装的 Driver；`outdated` 时按提示人工迁移。

Driver v15 在已初始化项目的功能实现、修复和文档交付请求下提示 Agent 主动使用；咨询及只读 review 直接处理。开始新需求时也可明确要求“使用 wsspeckit-driver 完成……”。继续已有任务时提供 Work Item，让 Agent 使用 continue 恢复。纯咨询或只读 review 不应默认创建功能交付任务。自动触发能力需要在实际宿主验证，不能仅凭安装成功判断。

## 日常使用

项目初始化后可运行 `wspec agent project setup` 添加 Agent 入口提示；`--dry-run` 可预演，`wspec agent project remove` 仅移除受管区块。替换已有 AGENTS.md 时返回 recoveryFile 保留旧文件，避免并发编辑内容丢失。

- 新功能：`wspec start --intent feature --prompt "需求"`
- 修复：`wspec start --intent fix --prompt "问题"`
- 留档评估：`wspec start --intent assessment --prompt "评估范围"`
- 文档交付：`wspec start --intent docs --prompt "文档变更"`
- 继续：`wspec continue <workItemId> --actor <执行者>`
- 查看：`wspec status <workItemId>`

Agent 保存 continue 返回的 JSON，用 `wspec complete <workItemId> --actor <执行者> --package <领取结果文件> --input <输出映射与结果文件>` 完成当前步骤，不再手抄 Lease 或拼接 ArtifactRef。完整格式与审批/重试边界见 [Application Protocol](docs/reference/application-protocol.md#意图与日常操作)。这些入口自 0.1.0-beta.16 起提供，已知体验限制见 [发布说明](docs/releases/0.1.0-beta.16.md)。

## 本地开发快速开始

在仓库根目录运行：

```sh
npm install
npm run build
node dist/cli/main.js --help
```

在一个 Git 仓库中初始化 WSSpecKit 配置：

```sh
node dist/cli/main.js init
```

这会初始化当前仓库的 `.wsspec` 配置。命令输出为 JSON，请根据返回的 `ok`、`result` 或 `error` 字段处理结果。

## 命令族

使用 `node dist/cli/main.js --help` 查看当前公开用法。主要命令族如下：

| 命令 | 用途 |
| --- | --- |
| `init` | 初始化当前 Git 仓库的 WSSpecKit 配置。 |
| `start` | 从需求来源创建 Work Item。 |
| `acquire` | 获取指定 Work Item 的下一步 AgentAction。 |
| `artifact create` | 在活动 Attempt 范围内创建不可变 Artifact 引用。 |
| `submit` | 提交一次 Attempt 的结果、Artifact 与 Evidence 引用。 |
| `decide` | 提交步骤审批、工作流信任或外部动作相关决定。 |
| `continue` | 恢复当前授权，不重复领取任务。 |
| `complete` | 从原执行包及输出文件映射完成提交。 |
| `status` | 查看任务进度与下一步。 |
| `agent project` | 添加或移除项目 AGENTS.md 接入指引。 |
| `inspect` | 查看当前步骤、执行/中断预算和下一步建议。 |
| `recover` | 自动选择可用的 Red 路径恢复或环境重验，保留原实现与审计记录。 |
| `workflow` | 列出、查看、导出、校验或选择工作流。 |
| `agent setup` | 自动创建安装目录并安装 Driver，重复执行只读复验。 |
| `agent install` | 在已存在的目标目录安装 Agent Driver Skill。 |
| `agent status` | 只读检查 Driver 是否缺失、匹配当前版本、过旧或冲突，并提示下一步。 |
| `doctor connectors` | 对已声明的连接器执行无外部写入的诊断。 |

## 参考文档

- [Application Protocol](docs/reference/application-protocol.md)：公开 CLI 与 Application 生命周期契约。
- [Workflow Language v1](docs/reference/workflow-language.md)：工作流 Package、步骤、Gate 和 Profile。
- [Skill 解析与锁定](docs/reference/skill-resolution.md)：Skill URI、来源与快照规则。
- [Connector 契约](docs/reference/connector-contracts.md)：连接器、审批、回读和诊断边界。

## 开发检查

仓库提供以下检查脚本：

```sh
npm run build
npm run lint
npm run typecheck
npm test
npm run test:contract
npm run test:e2e
```

## English introduction

WSSpecKit, with the package name `ws-spec-kit`, is an Agent Skill-driven, configurable software delivery workflow engine. Its `wspec` CLI returns JSON on standard output and supports local Work Item workflows for feature delivery and documentation delivery. See the reference documents above for the public protocol and current implementation boundaries.

## License

Licensed under [Apache-2.0](LICENSE).

## 发布 beta 版本

更新版本号和发布说明后，提交并推送 `main`。等待该提交的全部 CI 作业成功，再创建并推送同一提交的 `v<版本号>` 标签，执行：

```sh
npm publish --tag beta --registry=https://registry.npmjs.org
```

`prepublishOnly` 通过已登录的 `gh` 核对当前提交的 CI，要求干净的 `main`、本地/远程版本标签和远程 `main` 一致，并重新构建发布包。失败、未完成、缺少必需作业或其他提交的 CI 不能通过门禁。不要用 `--ignore-scripts` 绕过发布检查。
