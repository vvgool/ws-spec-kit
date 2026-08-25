# WSSpecKit

**WSSpecKit**，包名 `ws-spec-kit`，是一个由 Agent Skill 驱动、可配置的软件交付工作流引擎。它把需求来源、工作流、Skill、配置和执行状态绑定到 Work Item，使 Agent 按已声明的步骤交付软件或文档。

当前版本为 `0.1.0-alpha.1`，仍处于 alpha 阶段。

## 中文概述

WSSpecKit 提供可执行文件 `wspec`。CLI 的成功、帮助与错误结果都以 JSON 写入标准输出，便于 Agent 或其他程序读取。

项目内置两种 Workflow Package：

- `builtin://workflows/feature-delivery`，用于功能交付。
- `builtin://workflows/documentation-delivery`，用于纯文档交付，并限制改动范围为声明的文档路径。

工作流定义、Profile、所需 Skill 和结果会在 Work Item 中快照。非内置工作流在首次使用或内容变化后需要明确的信任决定。外部连接器已有契约与本地自动化验证；真实 Provider 平台的验收状态以 [验收报告](docs/acceptance/release-report.md) 为准。

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
| `inspect` | 读取 Work Item 的快照状态。 |
| `workflow` | 列出、查看、导出、校验或选择工作流。 |
| `agent install` | 安装 Agent Driver Skill。 |
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
