# WSSpecKit Control Runtime Remediation 1 Fix 3 报告

## 结论

本轮只修复 `runtime-remediation-1-fix-2-review.md` 剩余的 Trusted TDD Critical：nested `__tests__` 或 `__snapshots__` selector 只绑定 marker 自身，导致 sibling marker 资源依赖 Project Config 主动列全。当前实现把这两类 selector 提升到父 package ownership root，并由引擎在 package 内区分测试所有、product-only 与保守未分类文件。本地门禁通过，可提交独立复审；未恢复 execution trace，未修改已关闭的 external receipt 逻辑，也未进入 Connectors。

## 根因与 RED

- 旧 `scopeRoot()` 在最早 marker 截断，因此 `packages/a/__tests__/unit/*.test.ts` 导出 `packages/a/__tests__`，`packages/a/__snapshots__/**` 导出 `packages/a/__snapshots__`。
- `deriveTestAssetRoots()` 只处理配置中实际列出的 selector；只声明 `__tests__` 时不会扫描 sibling `__snapshots__`，snapshot 漂移不改变 `testAssetsDigest`，recovery 与 Close 也无法发现。
- 旧 `isTrustedTestAssetPath()` 将任意非根 trusted root 下的全部文件视为测试所有；若直接扩大到 package root，会错误地把正常 `packages/a/src/**` 产品实现纳入聚合摘要。
- 生产修改前，新增 normalization、单 `__tests__` selector、反向单 `__snapshots__` selector与 recovery 测试均得到旧 marker root；Close 测试在修改 sibling snapshot 后仍返回空缺失项，确认失败原因是 sibling 未绑定。

## 修复

- `__tests__` 与 `__snapshots__` 在 wildcard 之前出现时，trusted root 提升到 marker 父目录；根级 marker 提升到仓库根 `.`。其他已有 stack marker 仍截到自身 ownership root。
- 同一 package 内只配置任一 nested marker selector，扫描都覆盖 sibling `__tests__`、`__snapshots__` 及其他引擎 marker；多个 package 分别保留 roots，不跨 package 扩大。
- selector 直接匹配或路径位于 `test`、`tests`、`spec`、`__tests__`、`__snapshots__`、`.NET Tests`、具体 `*.Tests` marker 下时，测试 ownership 优先于 `productPaths`。
- marker 外明确匹配 `productPaths` 的文件只保留逐文件 manifest，不进入聚合 TDD digest；其他未分类 package 文件保守归测试所有。
- 测试资产聚合摘要语义版本从 2 升至 3，旧 ownership 算法生成的 Evidence 不能跨版本复用。
- 既有 Fixed Gate、Trusted Evidence、Cycle、Implement、Green、Review-Fix、event replay/recovery 与 Close 继续复用并重新校验同一 `testAssetRoots` 和摘要。

## 覆盖

- `packages/a/__tests__/unit/*.test.ts` 单 selector 导出 `packages/a`，绑定 sibling snapshot、nested fixture/helper、已知跨栈 marker与未分类 package 文件。
- `packages/a/__snapshots__/**` 单 selector 反向绑定 sibling `__tests__`。
- 恶意 `productPaths: ["packages/a/__snapshots__/**"]` 不能把 snapshot 降级为产品文件；snapshot 修改会改变聚合摘要。
- `packages/a/src/**` 产品文件修改会改变逐文件 manifest，但不改变聚合摘要；`package.json` 等未分类文件仍归测试所有。
- 选择 `packages/a` 不扫描 `packages/b`。
- 自动绑定的 sibling snapshot 漂移会使 recovery 返回 `WSSPEC_EVENT_CHAIN_INVALID`，并使 Close 移除 Red/Green TDD 完成证据。
- 原有 root/descendant symlink、非普通文件、路径逃逸、4096 文件和 1 MiB 限制继续由相关集成覆盖。

## 验证

- 新增 nested marker 聚焦测试：PASS，5/5。
- `tests/integration/tdd-evidence.test.ts` 与 `tests/integration/workflow-close.test.ts`：PASS，59/59。
- receipt identity 与 canonical-key 聚焦回归：PASS，2/2。
- `npm run lint`：PASS。
- `npm run typecheck`：PASS。
- `npm test`：PASS，469/469。
- `npm run test:e2e`：PASS，66/66。
- `npm run build`：PASS。
- `npm run schemas:generate`：PASS。
- 临时目录重新生成 Schema 与 `schemas/` 比对：PASS，无 drift。
- `git diff --check`：PASS。

## 边界与 concerns

- 本轮只证明引擎定义的静态 package ownership 边界。marker 外且明确匹配 `productPaths` 的运行时测试依赖仍会按项目声明作为产品文件排除；未知布局继续采用静态前缀顶层或仓库根的保守扩大，并受资源上限约束。
- 本地门禁不替代独立对抗复审。剩余 Critical 是否关闭，应由 reviewer 使用单 selector、恶意 `productPaths`、多 package 隔离和生命周期漂移再次验证。
- 当前证据仍只覆盖本地 Runtime、临时 Git worktree、本地 JSON read-back、Schema 与 fixture E2E。真实 GitHub/GitLab/飞书 Connector、宿主 Skill discovery、身份链、签名发布物、生产部署/恢复和真实外部回读仍未验证。
- 在独立复审关闭该 Critical 前，仍不应进入 Connectors 或宣称 Control Runtime/生产 GO。
