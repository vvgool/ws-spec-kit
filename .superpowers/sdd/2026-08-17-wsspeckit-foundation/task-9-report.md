# Foundation Task 9 Report

## 范围与结论

已删除旧协议文档，并建立四份中文公开参考真源：

- `docs/reference/application-protocol.md`
- `docs/reference/workflow-language.md`
- `docs/reference/skill-resolution.md`
- `docs/reference/connector-contracts.md`

四份文档覆盖公开 Application 操作、Schema、CLI、Workflow Language v1、四类 Skill 来源与锁定、Workflow Package 信任、Connector/Provider 边界、审批和回读契约。JSON/YAML 示例由契约测试解析。旧 `docs/specs`、`docs/reference`、`docs/plans` 协议文件已删除，未保留迁移或兼容层。

为满足旧协议清除门禁，`src/engine/claims.ts` 将残留 `builtin.stage-result.v1` 直接替换为已公开的 `builtin.submit-result.v1`；仓库错误文案和测试 Git 身份中的旧产品名也已直接替换为 `WSSpecKit`。

## TDD 证据

先创建并运行：

```text
node --import tsx --test tests/contract/documentation-baseline.test.ts tests/contract/requirements-traceability.test.ts
```

RED：旧文档仍存在，四份新参考缺失，且生产面扫描定位到 `src/engine/claims.ts` 的旧 Schema 与 `src/storage/repository.ts` 的旧产品名。

GREEN：同一命令通过，5/5 tests passed。`documentation-baseline` 验证旧文档删除、新文档存在、生成 Schema/CLI/Skill URI/错误码覆盖、示例可解析及生产面旧标识清零；`requirements-traceability` 验证 `REQ-01` 至 `REQ-20` 唯一连续、每项追踪字段完整，且 Foundation/Control/Connector/Release Task 标题均真实存在。

已按已确认的中文输出提示设计，将设计矩阵中的“中文扫描”证据改为内置 Skill 资源契约和 Driver 中文输出提示/参考文档契约；本 Task 未引入任何中文静态扫描器。

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

基础阶段旧标识搜索仅命中明确拒绝旧值的负例测试与本次基线测试中的删除断言；生产代码、Schema、资源不存在旧产品名、旧 Schema 或旧命令。发布包干跑清单不含 `chinese-content` 或 `check-chinese-content`。

## 验收边界

本报告只证明本地静态、契约、集成、E2E 测试、构建和 pack 门禁。未执行真实 Codex/Claude/Cursor 宿主 Smoke，也未执行 GitHub、GitLab 或飞书 Provider 的真实授权、写入和回读验收；这些不应被解释为完成或通过。
