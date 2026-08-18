# WSSpecKit Foundation 最终残余修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留 Foundation 最终修复工作树的基础上，关闭最终复审剩余的一个 P1 和两个 P2，并重新冻结 Foundation 基线。

**Architecture:** Global Skill root 的持久化仅保存逻辑 ID，`acquire` 从调用方当前项目根读取 host-local 配置完成 ID 到路径的重绑定；portable config snapshot 使用独立严格 Schema；CLI rollback 失败统一固定脱敏。完成后对整个 Foundation 分支重新执行门禁和独立广域审查。

**Tech Stack:** TypeScript 5、Node.js 22、Node test runner、AJV/JSON Schema、Git worktree。

## Global Constraints

- 保留当前 41 项未提交 Foundation 最终修复，不回退已关闭的 Artifact input、route error catalog 和 claims 删除。
- Work Item、事件、Lock 和 snapshot 不得持久化用户 HOME 或 additional Global Skill root 的绝对路径。
- Host-local root 重绑定必须读取 `acquire/inspect` 调用方当前项目根的 `.wsspec/config.yaml`，不得读取隐藏 Work Item worktree 的旧配置。
- `WSSPEC_WORK_ITEM_ROLLBACK_FAILED` 不得透传底层异常、路径、凭据、stack 或 details。
- 不开始 Control Runtime、Connector，不 merge、push、publish。

---

### Task 1：关闭 Foundation 最终残余并重新冻结

**Files:**
- Modify: `src/application/{application,acquire}.ts`
- Modify/Create: `src/storage/project-config.ts`
- Modify: `src/application/snapshot.ts`
- Modify: `src/schemas/definitions.ts`
- Generate: `schemas/*.schema.json`
- Modify: `src/storage/work-items.ts`
- Modify: `src/adapters/cli/output.ts`
- Modify: `tests/integration/application-flow.test.ts`
- Modify: `tests/contract/schemas.test.ts`
- Modify: `tests/e2e/application-cli.test.ts`
- Modify: `tests/e2e/package-install.test.ts`

**Interfaces:**
- `acquire(input.root, workItemId, actor)` 中的 `input.root` 是当前 host 项目配置根；隐藏 `state.worktree` 只用于工作产物和 Git diff。
- portable config snapshot 使用独立 Schema ID，不冒充完整 Application Project Config。
- CLI internal/rollback 固定输出 `WSSPEC_INTERNAL_ERROR` 或已登记 rollback code 的固定中文安全消息。

- [ ] **Step 1：补齐当前 host root 重绑定 RED/GREEN**

覆盖：init 后不提交 `.wsspec` 仍可 start/acquire；调用方配置从逻辑 root `shared` 的 path A 改为内容摘要相同的 path B 后 acquire 成功；B 内容漂移后 fail closed；隐藏 worktree 不需要复制 config；所有 snapshot/event/lock 文件不含 A/B/HOME 绝对路径。

- [ ] **Step 2：为 portable config snapshot 建立严格 Schema**

新增独立 Schema ID，要求 root 仅含逻辑 `id`，拒绝 `path`、未知字段和缺失字段；生成物、canonical example、Schema drift 测试全部同步。完整 Project Config Schema 继续要求 host-local `id + path`。

- [ ] **Step 3：关闭 rollback message 泄露**

先用故障注入制造 Work Item 创建失败与 rollback 再失败，确认 CLI JSON 不包含底层异常、路径、secret、stack/details；实现固定中文安全消息。注册 typed rollback code 时只允许固定消息，否则统一 `WSSPEC_INTERNAL_ERROR`。

- [ ] **Step 4：运行完整 Foundation 门禁**

```bash
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm run lint
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm test
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm run test:e2e
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm run build
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm pack --dry-run --json
git diff --check 86d7149..HEAD
```

同时将 Schema 生成到临时目录并与 `schemas/` 比较，运行 legacy rg gate 和 packed clean-consumer 安装测试。

- [ ] **Step 5：提交并独立广域复审**

提交当前完整 Foundation 最终修复工作树。独立 reviewer 必须重放两个 host root probe、portable Schema 正反例、rollback 双重失败脱敏、Quick plan Artifact 最小披露、三条 route error 和 claims pack denylist；然后重新检查整个 `86d7149..HEAD` Foundation 区间。
