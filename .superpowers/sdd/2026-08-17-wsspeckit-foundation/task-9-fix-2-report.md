# Foundation Task 9 修复第 2 轮报告

## 范围

- 基线：`6a751bc`（`docs: validate protocol reference examples`）。
- 本轮只修复 Task 9 第 1 轮复审中的公开参考、合同测试和公开契约漂移问题。
- 未开始 Runtime 工作，未合并、推送、发布或调用外部 Provider。

## 修复闭环

| 复审项 | 修复与证据 |
| --- | --- |
| Profile 示例无法编译 | `workflow-language.md` 的 governed 示例使用真实 `edit-document`，并补齐 `documentation-delivery` 的可信 Gate、独立 Review、产物、发布与审计约束。合同测试将示例替换到 builtin Package 后以生产 `compileWorkflow` 编译。 |
| 五操作断言会跨章节借用输出 | 合同测试按 `### <operation>` 边界切分章节，逐项断言输入和精确输出类型；删除 `acquire` 本节 `AgentAction` 输出的变异测试会失败。 |
| CLI/错误码存在手写漂移清单 | `publicCommandDescriptors` 驱动 CLI help，`publicRouteCommands` 从真实 `routes` 表导出并与描述符双向比较。`applicationPublicErrorCodes` 显式覆盖 Application 可透传的 compiler、Workflow Package loader/trust、Project config 和 Skill resolver 诊断；四份公开参考文档必须包含 catalog 的每个代码。 |

## 验证

在本轮最终改动后重新执行：

```text
node --import tsx --test tests/contract/documentation-baseline.test.ts tests/contract/requirements-traceability.test.ts
PASS: 6 tests / 0 failures

npm run lint
PASS

npm run typecheck
PASS

npm test
PASS: 303 tests / 0 failures，约 65.1s

npm run build
PASS

npm pack --dry-run --json
PASS: entryCount 203，packed 161714 bytes，unpacked 821024 bytes

git diff --check
PASS

旧标识门禁
PASS: 仅命中 documentation-baseline/identity 的拒绝旧值负例
```

## 验证边界

- 上述证据证明本地文档契约、编译/加载路径、CLI 路由与 help、静态检查、完整测试、构建和 npm 打包干跑通过。
- 未执行真实 Codex、Claude、Cursor 或 Generic Driver 宿主 Smoke；也未执行 GitHub、GitLab、飞书 Provider 的真实授权、写入与回读。
- 未执行 `npm publish`、远程推送、合并或生产发布。
