# Work Item v1 参考

本文定义仓库身份、Work Item 清单、来源快照、外部 Binding 与控制面定位协议。未知字段必须失败，不能静默忽略。

## 1. 仓库身份

每个启用 WiesenSpecKit 的仓库必须提交 `.wsspec/repository.yaml`：

```yaml
version: 1
repositoryId: repo-01J5V8Q4Y7M6F3K2N1P0ABCDER
```

- `version`：整数，v1 仅允许 `1`。
- `repositoryId`：初始化时生成的不可变 ULID，格式为 `repo-` 加 26 位大写 Crockford Base32。
- `repositoryId` 不从路径、remote URL 或 Git 根提交推导；clone、fork 后保留同一文件即表示继承同一 WiesenSpecKit 仓库身份。
- 更换身份必须执行显式迁移，预览受影响的活动 Work Item、Issue Binding、Knowledge 稳定键和归档；禁止直接编辑后继续运行。

Git common-dir 中的 `repository.json` 只缓存 `repositoryId`、规范仓库路径和控制面版本。缓存与已提交文件不一致时返回 `WSPEC_REPOSITORY_ID_MISMATCH`，不得自动选择任一方。

## 2. Work Item 清单

`.wsspec/work-items/<work-item-id>/work-item.yaml` 的最小结构：

```yaml
version: 1
workItemId: WSK-20260816-001
repositoryId: repo-01J5V8Q4Y7M6F3K2N1P0ABCDER
title: 支付重试
createdAt: 2026-08-16T10:00:00+08:00
status: active
execution:
  worktree: .worktrees/WSK-20260816-001
  branch: wspec/WSK-20260816-001
  baselineRevision: abc123
  baselineTreeDigest: sha256:...
  workflowDigest: sha256:...
  configDigest: sha256:...
  schemaDigest: sha256:...
source:
  type: issue
  snapshot: source/source.json
  contentDigest: sha256:...
bindings:
  issue:
    provider: github
    stableId: github:12345678
    url: https://github.com/org/repo/issues/123
  knowledge: null
```

`workItemId` 在一个 `repositoryId` 内唯一且创建后不可变。`execution` 固定规范 worktree、分支、基线、配置和 Schema；活动运行只读取快照。`source` 与 `bindings` 分离：Source 是创建时的不可变输入证据，Binding 是可更新的远端关联。

## 3. Source Snapshot

`source/source.json` 必须保存：

```json
{
  "version": 1,
  "type": "issue",
  "capturedAt": "2026-08-16T10:00:00+08:00",
  "origin": "github:12345678",
  "content": {"title": "支付重试", "body": "..."},
  "contentDigest": "sha256:..."
}
```

允许的 `type` 为 `prompt`、`file`、`issue`。快照不得被远端同步覆盖；远端后续变化保存为新的观察记录并生成差异，由用户决定是否更新已批准工件。

## 4. Binding

`bindings.issue` 与 `bindings.knowledge` 相互独立，均可为空。

- Issue Binding 必须保存 provider 稳定对象 ID、展示 URL、最后读取游标和最近回读摘要。
- Knowledge Binding 必须保存 adapter、space、稳定页面 ID、展示 URL和最近回读摘要。
- URL 是 locator，不是身份。重命名仓库、移动页面或 URL 变化不能创建第二个 Binding。
- Knowledge 默认稳定键为 `repositoryId + workItemId`。来自 Issue 时可附加 Issue 稳定身份用于搜索，但不能替代默认键。
- Binding 的创建、替换和解绑属于外部关联变更，必须写入事件；涉及远端写入时还必须遵守 External Action 协议。

## 5. 控制面定位

Git common-dir 的 `wsspec/work-items/<work-item-id>/locator.json` 只用于从共享控制面定位规范 worktree 和已提交快照：

```json
{
  "version": 1,
  "repositoryId": "repo-01J5V8Q4Y7M6F3K2N1P0ABCDER",
  "workItemId": "WSK-20260816-001",
  "worktree": ".worktrees/WSK-20260816-001",
  "snapshot": ".wsspec/work-items/WSK-20260816-001/snapshot"
}
```

引擎必须将目标解析为真实路径，验证 worktree 属于当前 Git common-dir，并核对仓库与 Work Item 身份。locator 不是事实来源，不能用来覆盖控制面或已提交快照内容。

## 6. Clone、恢复与迁移

- 普通 clone 保留已提交的 `repositoryId`，但不复制未提交的运行控制面；只能从已归档快照恢复。
- 同一仓库的多个 worktree 共享控制面和锁，不能各自创建同 ID Work Item。
- 发现已存在分支或 worktree 时必须核对快照身份；无法证明匹配则停止并报告冲突。
- `wspec recover` 只从事件链、快照和已验证 locator 重建派生状态，不猜测外部写入结果。
- 旧仓库迁移必须先生成 `.wsspec/repository.yaml` 预览；确认后一次性记录旧身份映射和 Knowledge 稳定键影响。
- 归档导入若 `repositoryId` 不同，默认只读；显式 rehome 必须生成新 Work Item ID，并保留来源关系。

## 7. 失败语义

- 缺少仓库身份：`WSPEC_REPOSITORY_NOT_INITIALIZED`。
- 身份不一致：`WSPEC_REPOSITORY_ID_MISMATCH`。
- Work Item 重复：`WSPEC_WORK_ITEM_ID_CONFLICT`。
- locator 逃逸或不匹配：`WSPEC_CONTROL_PLANE_INVALID`。
- Source 摘要不匹配：`WSPEC_SOURCE_SNAPSHOT_TAMPERED`。
