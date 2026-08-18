# Foundation Task 9 Fix Round 1 Report

## 修复范围

本轮修复 `task-9-review.md` 的 1 个 P1 与 2 个 P2：

- `workflow-language.md` 的 `workflow-v1` 示例逐项对齐内置 `documentation-delivery/workflow.yaml`：包含 `workflow.version: 1`、正式 Step 字段、Gate 的 `id/evidence/command`，以及 `changePolicy.kind: documentation-only`。
- `application-protocol.md` 逐项说明 `start`、`acquire`、`submit`、`decide`、`inspect` 的输入和输出。明确 `submit` 不含 `actor`，并且 `acquire`、`submit`、`decide` 都返回 `AgentAction`。
- 每个 JSON/YAML fenced block 使用 `contract=<name>` 标注。基线测试按标签调用 `validate(schemaId)`、`parseWorkflowV1`、`parseProfileV1`、`parseSkillLock`；Manifest 和 Workflow 还分别与内置 `documentation-delivery` 资源比较。命令、操作和公开边界错误码改从 CLI、`WSSpecApplication` 接口与实现源派生，删除手写漂移清单。

## TDD 证据

先扩展 `tests/contract/documentation-baseline.test.ts` 并运行：

```text
node --import tsx --test tests/contract/documentation-baseline.test.ts tests/contract/requirements-traceability.test.ts
```

RED：测试要求逐操作的输入/输出章节和 fenced `contract` 标签后失败；在补入标签和正式 parser 后，内置 Manifest 比对仍失败，准确报告文档中的 description 与空 `skills` 字段偏离内置资源。

GREEN：修正文档为内置 Manifest 的精确内容后，同一命令通过，5/5 tests passed。Workflow 示例经过 `parseWorkflowV1` 并与内置工作流解析结果相等；Application、Profile 和 Skill Lock 示例分别经过对应正式契约。

## 本地验证

以下命令均以退出码 0 完成：

```text
npm run lint
npm run typecheck
node --import tsx --test tests/contract/documentation-baseline.test.ts tests/contract/requirements-traceability.test.ts
npm test
npm run build
npm pack --dry-run --json
git diff --check
```

旧标识门禁只命中明确拒绝旧值的测试断言。发布包不包含中文静态分析器、旧 Schema 或旧公开标识。

## 验收边界

本轮只证明本地文档契约、测试、构建和 dry-run pack。没有执行真实 Codex/Claude/Cursor 宿主 Smoke，也没有执行 GitHub、GitLab 或飞书 Provider 的真实授权、写入和回读验收；这些均不应表述为已通过。
