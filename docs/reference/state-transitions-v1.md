# State Transitions v1 参考

本文是 Stage 和 Work Item 状态转换的规范性契约。未列出的转换一律拒绝并返回 `WSPEC_STATE_TRANSITION_FORBIDDEN`。所有成功转换先追加事件，再原子更新 `runtime.json` 投影；相同幂等键重复提交必须返回原结果，不能重复产生副作用。

## 1. 通用字段

每个转换事件必须包含：

```text
eventId / eventType / occurredAt / actor / workItemId /
stageId? / attemptId? / from / to / idempotencyKey /
workflowDigest / configDigest / baselineTreeDigest /
inputWorkspaceTreeDigest / outputWorkspaceTreeDigest? / inputDigest / result
```

- `actor` 是审计元数据，不能替代交互式审批。
- Agent-owned Stage 写操作必须校验活动 `attemptId`、`claimToken` 和 `contextDigest`；Engine-owned Stage 不签发 Claim 令牌。
- 外部写入的幂等键由 `workItemId + stageId + attemptId + target + action` 派生。
- 事件追加成功但投影更新失败时，通过事件回放修复投影。

## 2. Stage 转换

| From | 触发 | To | 前置条件与行为 |
|---|---|---|---|
| `pending` | 依赖重算 | `ready` | 所有 `needs` 成功且输入工件有效 |
| `pending` | Target 禁用或 Binding 条件不满足 | `skipped` | 仅 Engine-owned publish；不执行外部写入 |
| `ready` | `stage claim` | `claimed` | 仅 Agent-owned；创建 Attempt、租约和 Claim 令牌 |
| `claimed` | `stage start` | `running` | 仅 Agent-owned；Claim 有效且上下文摘要匹配 |
| `ready` | `wspec next` 内部调度 | `running` | 仅 Engine-owned；创建 Attempt，不创建 Claim |
| `claimed` | `stage release` | `ready` | 主动释放，不复用原 Claim 令牌 |
| `claimed` | 租约到期 | `ready` | 写入 `claim.expired` 事件 |
| `running` | `stage complete` | `validating` | 仅 Agent-owned；令牌、Attempt 和输入摘要匹配，且引擎重算值等于结果声明的输出摘要 |
| `running` | 引擎执行完成 | `validating` | 仅 Engine-owned；保存内部执行结果和可信证据 |
| `running` | `stage fail` 或引擎失败 | `failed` | 保存原因和已有证据 |
| `running` | `pause` | `paused` | 记录 `suspendedFrom=running` |
| `paused` | `resume` | `running` | Claim 仍有效；否则先回到 `ready` |
| `validating` | 校验通过且无需审批 | `succeeded` | 输出和必需门禁满足契约 |
| `validating` | 可选 Target 明确失败 | `succeeded_with_warnings` | 保存错误与回读结果，不阻止关闭 |
| `validating` | 校验通过且需要审批 | `awaiting_approval` | 创建绑定精确工件哈希的审批请求 |
| `validating` | 校验失败 | `failed` | 保存稳定错误码和失败详情 |
| `awaiting_approval` | 真实 TTY 中 `approve` | `succeeded` | 审批请求、Attempt 和工件哈希仍有效 |
| `awaiting_approval` | 真实 TTY 中 `reject` | `revision_required` | 保存拒绝原因，不覆盖旧工件 |
| `revision_required` | `stage revise` | `ready` | 创建新 Attempt，旧审批保持历史状态 |
| `failed` | `stage retry` | `retrying` | 未超过策略上限且失败可重试 |
| `retrying` | 初始化完成 | `ready` | 创建新 Attempt，不覆盖旧证据 |
| `succeeded` | 上游或快照变化 | `invalidated` | 取消下游 Claim 并失效相关证据 |
| `succeeded_with_warnings` | 上游、Target 或快照变化 | `invalidated` | 清除旧警告的完成效力并重新求值 |
| `skipped` | Target 启用或 Binding 补充 | `invalidated` | 重新求值激活条件 |
| 非终止下游状态 | 上游工件、快照或审批变化 | `invalidated` | 取消活动 Claim，失效 Context、Approval 与 Evidence，等待依赖重新建立 |
| `invalidated` | 失效传播完成 | `ready` | 所有新前置条件已建立 |
| 活动非终态 | `stage cancel` | `cancelled` | 释放 Claim；已发生外部写入必须先对账 |

`succeeded`、`succeeded_with_warnings`、`skipped` 和 `cancelled` 是完成态，其中前三者可以满足下游 `needs`。`succeeded` 和 `succeeded_with_warnings` 可以因输入变化进入 `invalidated`；`skipped` 在 Target 启用或 Binding 补充后进入 `invalidated` 再重新求值。对已经失效、取消或结束的 Attempt 提交结果返回 `WSPEC_ATTEMPT_NOT_ACTIVE`。

## 3. Work Item 转换

| From | 触发 | To | 前置条件与行为 |
|---|---|---|---|
| `draft` | `new` 完成 | `active` | 快照、规范 worktree 和控制面均已创建 |
| `active` | Stage 请求审批 | `awaiting_approval` | 至少一个 Stage 处于 `awaiting_approval` |
| `awaiting_approval` | 审批或拒绝处理完 | `active` | 不再存在未处理审批请求 |
| `active` | Engine-owned `verify` Stage 启动 | `verifying` | 所有必需实现和审查 Stage 成功 |
| `verifying` | 必需门禁通过 | `verified` | 只有安全内核可以产生此转换 |
| `verifying` | 门禁失败 | `blocked` | 记录失败证据和修复入口 |
| `blocked` | `retry verify` | `verifying` | 输入或环境变化已记录 |
| `verified` | 已验证工作区、配置或工件变化 | `blocked` | 失效旧 Evidence，必须重新执行 verify |
| `verified` | 所有 publish Stage 均 disabled 或因 Binding 缺失可直接跳过 | `closed` | 记录每个跳过原因并导出最终审计快照 |
| `verified` | 至少一个 Engine-owned publish Stage enabled 且可执行 | `pending_publish` | 分别为 Issue 和 Knowledge Target 生成 External Action Request；配置启用不代表批准写入 |
| `pending_publish` | 必需目标通过；可选目标通过、警告或跳过 | `closed` | 分别记录各 Target 的远端引用、错误和回读摘要 |
| `pending_publish` | 结果确定失败 | `pending_publish` | 允许按策略重试，不改变状态 |
| `pending_publish` | 结果未知 | `reconciliation_required` | 禁止盲目重试 |
| `reconciliation_required` | `reconcile` | `pending_publish` | 回读远端并由用户选择接受、补偿或重试 |
| `active`/`blocked`/`pending_publish` | `pause` | `paused` | 记录精确 `suspendedFrom` |
| `paused` | `resume` | 原状态 | 重新校验快照、输入和外部绑定 |
| 非 `closed` 状态 | `cancel` | `cancelled` | 高风险副作用已经完成对账或补偿 |

`closed` 和 `cancelled` 是 Work Item 终态。关闭后的运行控制面转为只读，清理必须通过独立显式命令完成。

Publish Target 的确定结果分别计算：必需 Target 只有 `succeeded` 满足关闭条件；可选 Target 的 `succeeded`、`succeeded_with_warnings` 和 `skipped` 均满足关闭条件。用户拒绝可选 External Action 产生 `skipped`，拒绝必需 External Action 产生 `failed`。任何 `unknown` 或执行中断都优先进入 `reconciliation_required`，不受 `required` 放宽。

## 4. 失败、重试和恢复

- Schema、权限、审批和安全不变量失败不可自动重试。
- 临时命令失败可以按固定上限重试，每次重试创建新 Attempt。
- 外部写入必须先记录意图事件；进程中断后根据幂等键回读远端。
- 无法确认远端结果时进入 `reconciliation_required`，用户处理前不能关闭 Work Item。
- `runtime.json` 缺失或损坏时只允许从完整事件链重建；事件链哈希不连续时停止并返回 `WSPEC_EVENT_CHAIN_INVALID`。
- `wspec recover` 从提交的快照和审计记录建立新控制面，不继承租约、Claim 令牌或未完成的交互式审批。
