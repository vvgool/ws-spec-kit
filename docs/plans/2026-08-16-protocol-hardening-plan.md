# WiesenSpecKit 协议补强实施计划

> **执行要求：** 在当前会话中逐项实施并验证；本次只修改设计文档，不实现 CLI，不提交 Git。

**目标：** 补齐外部写入授权、完整工作区证据、稳定仓库身份、内置工件语义和可选发布状态五项协议缺口。

**架构：** 保持 Agent 无关、`interactive` 审批和 Engine-owned 发布架构。新增 Work Item 与 Artifact 两份独立参考规范，并在主设计、执行契约、状态转换和项目配置中引用相同的规范字段。

**技术栈：** Markdown、YAML/JSON 示例、SHA-256 内容摘要、Git worktree。

## 全局约束

- 所有说明使用中文，协议字段与 CLI 标识保留英文。
- 不引入 daemon、签名审批或模型调用能力。
- Issue 与 Knowledge 保持独立 Target、Binding、Attempt 和结果。
- 所有外部写入必须经过针对精确操作的真实 TTY 交互审批。
- 未知外部执行结果必须进入 `reconciliation_required`。

### Task 1：外部操作授权与工作区证据

**文件：**

- 修改：`docs/reference/execution-contracts-v1.md`
- 修改：`docs/specs/2026-08-16-wiesen-spec-kit-design.md`

- [x] 定义 `ExternalActionRequest`、状态、摘要、审批、执行和回读协议。
- [x] 定义 `baselineTreeDigest` 与 `workspaceTreeDigest` 的计算边界和失效规则。
- [x] 将摘要绑定到 Context、Result、Evidence、Approval、事件和外部操作。

### Task 2：仓库与 Work Item 身份

**文件：**

- 新增：`docs/reference/work-item-v1.md`
- 修改：`docs/specs/2026-08-16-wiesen-spec-kit-design.md`

- [x] 定义 `.wsspec/repository.yaml` 和稳定 `repositoryId`。
- [x] 定义 `work-item.yaml`、Source Snapshot、Bindings 和 `locator.json`。
- [x] 定义 clone、worktree、恢复、冲突和迁移语义。

### Task 3：内置工件内容契约

**文件：**

- 新增：`docs/reference/artifacts-v1.md`
- 修改：`docs/reference/execution-contracts-v1.md`

- [x] 定义所有内置 Artifact 的必需章节和结构化字段。
- [x] 定义 Schema 版本、引用、兼容和失效规则。

### Task 4：发布状态一致性

**文件：**

- 修改：`docs/specs/2026-08-16-wiesen-spec-kit-design.md`
- 修改：`docs/reference/state-transitions-v1.md`
- 修改：`docs/reference/project-config-v1.md`

- [x] 统一任何 enabled publish Stage 都进入 `pending_publish`。
- [x] 明确 required、optional、skipped、warning 和 unknown 的关闭规则。
- [x] 明确配置启用不等于外部写入授权。

### Task 5：规范自检

- [x] 运行 `git diff --check`。
- [x] 解析所有 Markdown 围栏中的 YAML 与 JSON 示例。
- [x] 检查所有内置输出均有 Artifact 契约。
- [x] 检查 Context、Result、Evidence、Approval、事件和外部操作均绑定工作区摘要。
- [x] 检查主设计与状态转换表的发布语义一致。
