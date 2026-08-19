# WSSpecKit Control Runtime Remediation 1 Fix 2 报告

## 结论

本轮只修复 `runtime-remediation-1-fix-1-review.md` 剩余的 Trusted TDD Critical：Project Config 可以通过深层 selector 把 trusted root 合法收窄到真实测试 ownership root 之下。当前本地实现与门禁通过，可提交独立复审；未恢复 execution trace，未修改已关闭的 external receipt 逻辑，也未进入 Connectors。

## 根因与 RED

- 旧 `scopeRoot()` 直接使用首个 wildcard 前的完整静态目录，因此 `tests/unit/*.test.mjs` 导出 `tests/unit`，而不是测试栈 ownership root `tests`。
- reviewer 场景中 `tests/unit/feature.test.mjs` 导入 `tests/support/helper.mjs`；旧 Evidence 只绑定入口，helper 不在 manifest，修改 helper 后摘要不变。
- 新增测试先在旧实现上确认 RED：5 条聚焦中 4 条失败，分别暴露 Node 深层 selector、跨栈深层 selector、归一化矩阵和未知自定义布局的错误边界；已有 nested marker 联合 selector 用例保持通过。

## 修复

- 引擎内置不可配置的 ownership markers：`test`、`tests`、`spec`、`__tests__`、`__snapshots__`、`.NET Tests` 与具体 `*.Tests` 项目目录。
- pattern 在 wildcard 之前出现已知 marker 时，root 固定截到最早 marker：`tests/unit` 归一化为 `tests`，`src/test/java` 为 `src/test`，`spec/models` 为 `spec`，`packages/Foo.Tests/Unit` 为 `packages/Foo.Tests`。
- marker 出现在 wildcard 之后时不生成含 wildcard 的 root，而是使用已有静态前缀的顶层目录；没有已知 marker 的 wildcard 或 exact selector 同样保守上提到静态前缀顶层。
- 没有静态前缀的 `**/*.test.*` 或根级 selector 归一化为仓库根 `.`。
- 多个 selector 独立派生并共同保留 ownership roots；同一 package 的 `__tests__` 与 `__snapshots__` 因而同时进入扫描、Evidence 与摘要。
- 既有 manifest 校验会重新计算 roots，调用方不能伪造更窄的 `testAssetRoots`；新 roots 继续进入 Fixed Gate 命令身份、Trusted Evidence、TDD Cycle、Implement、Green、Review-Fix、replay/recovery 与 Close。
- 非根 trusted root 继续拥有最高测试 ownership；即使 `productPaths` 同时匹配 `tests/**`，`tests/support/helper.mjs` 的变化仍使旧 Red Evidence 失效。

## 覆盖

- reviewer 真实 Red/Evidence 场景：`tests/unit/*.test.mjs` 绑定 sibling `tests/support/helper.mjs`，helper 修改后 Implement 返回 `WSSPEC_TDD_EVIDENCE_INVALIDATED`。
- Node `tests`/`test`、Java `src/test`、Ruby `spec`、`.NET Tests`/`Foo.Tests`、nested `__tests__`/`__snapshots__` 均覆盖 sibling helper、fixture、resource 或 snapshot。
- 未知 `qa/unit/*.case.mjs` 与 exact `qa/unit/case.mjs` 都上提到 `qa`，绑定 `qa/support`；`**/*.test.*` 绑定 `.`。
- receipt canonical-key 的 Close 与 append/replay/archive 聚焦回归 2/2 通过，相关两份 integration 57/57 通过。

## 完整门禁

- `npm run lint`：PASS。
- `npm run typecheck`：PASS。
- `npm test`：PASS，467/467。
- `npm run test:e2e`：PASS，66/66。
- `npm run build`：PASS。
- `npm run schemas:generate`：PASS。
- 临时目录重新生成 Schema 与 `schemas/` 比对：PASS，无 drift。
- `git diff --check`：PASS。

## 边界与 concerns

- 本轮证明的是引擎定义的常见测试栈 ownership 上界与未知布局的保守扩大，不声称静态 ownership 模型能识别任意跨目录运行时依赖；没有已知 marker 的布局会扩大到顶层目录或仓库根并受 4096 文件/1 MiB 上限约束，超限时 fail closed。
- 当前证据仍只覆盖本地 Runtime、临时 Git worktree、本地 JSON read-back、Schema 与 fixture E2E。真实 GitHub/GitLab/飞书 Connector、宿主 Skill discovery、身份链、签名发布物、生产部署/恢复和真实外部回读仍未验证。
- 在独立复审关闭剩余 Critical 前，仍不应进入 Connectors 或宣称 Control Runtime/生产 GO。
