# WSSpecKit Control Runtime Remediation 1 报告

## 结论

本轮仅修复 Control Runtime 的两个独立审查 finding：可信 TDD Evidence 的测试资产闭包可被受测进程伪造，以及 external receipt 未绑定当前发布输入与实际内容。当前 worktree 的本地实现、测试、构建和生成 Schema 门禁已通过；未进入 Connector 实现，也不据此宣称真实外部系统或生产环境可交付。

## 修复范围

### 可信 TDD Evidence

- 移除受测进程可删除或替换的 dependency trace，不再信任测试进程上报依赖集合。
- Red、Green、Implement、Review-Fix、recovery 与 Close 都重新扫描 Project Config 声明的完整 `testAssetPaths` 作用域。
- Evidence 绑定排序后的 canonical regular file 清单、逐文件摘要、聚合摘要、`testAssetPaths` 和 `productPaths`。
- 对新增、删除、修改、symlink、非普通文件、空作用域、测试/产品分类歧义、超过 4096 个文件或超过 1 MiB 的作用域 fail closed。
- recovery 严格验证 Red、Green 和 Cycle schema、canonical 字段一致性，以及 Cycle 引用的 Green/refactor Evidence 是否真实存在并匹配当前 Red。
- Review-Fix 在忽略文件进入测试资产作用域时失效旧 Evidence，并从 `write-tests` 重启 TDD cycle。

### External binding 与 receipt

- 新增严格的 `builtin.external-binding.v1`，绑定 target、stable identity、外部 Work Item、发布 Step、Attempt、输入摘要和预期内容摘要。
- 发布前重新读取 Work Package 引用的 Artifact，验证 canonical regular file、元数据身份、revision 和实际内容摘要；发现 acquire 后篡改时不创建 binding。
- 新 binding 与当前发布 Attempt 原子写入，并使同 target 的旧 receipt 失效。
- receipt 必须与当前 binding 的 target、stable identity、外部 Work Item、Step、Attempt、输入摘要、发布摘要和回读摘要一致。
- evidence map 中 `external-binding:<target>` 的 key suffix 必须与 binding 自身 target 一致；append、event replay/recovery 和 archive 写入均使用相同严格校验。
- 内置 feature/documentation 发布步骤显式消费 `implementation-result` 或 `documentation-result`，使发布输入具有确定内容绑定。

## 对抗验证

- 完整测试资产覆盖 helper、fixture、snapshot、测试配置、ignored 新文件、删除、修改、symlink、非普通文件、分类歧义、文件数和字节上限。
- Implement、Green、Review-Fix、recovery 与 Close 均验证完整作用域漂移；伪造 Cycle 或缺失 Green/refactor 引用会在 replay 时被拒绝。
- External publish 覆盖 acquire 后 Artifact 篡改、binding 重绑、Attempt/输入/内容摘要变化、错配 stable identity、错配 Work Item、错配 target 与 key suffix、陈旧 receipt，以及 append/replay/archive 三个持久化边界。
- 最终 key/target 定向回归：2/2 通过。

## 提交前自审

- 项目类型：Node.js / TypeScript。
- 审查范围：本提交的 19 个 tracked 产品、Schema、工作流、文档和测试文件，以及新增生成 Schema 与本报告。
- 严重问题：0；警告：0；建议：0。
- 已复核 Artifact 实际字节到 binding、binding 到 receipt、Red 到 Green/Cycle、以及 runtime projection 到 replay/recovery/archive 的跨模块绑定。
- 未发现调试代码、敏感信息、未处理 Promise、资源清理或路径逃逸回归。

## 本地门禁

- 定向 external binding 回归：PASS，2/2。
- `npm run lint`：PASS。
- `npm run typecheck`：PASS。
- `npm test`：PASS，459/459。
- `npm run test:e2e`：PASS，66/66。
- `npm run build`：PASS。
- `npm run schemas:generate`：PASS。
- 临时目录重新生成 Schema 与 `schemas/` 比对：PASS，无 drift。
- `git diff --check`：PASS。

首次将 `npm test` 与 `npm run test:e2e` 并行执行时，两者竞争重建共享 `dist/`，造成一次 `loader.d.ts` 读取 ENOENT；E2E 同轮 66/66 通过，随后隔离重跑 `npm test` 为 459/459。最终门禁结果均来自互不竞争的完整执行。

## 验收边界

- 仅验证当前本地 worktree、临时 Git worktree、本地 JSON read-back、生成 Schema 和本地构建。
- 未实现或验证 GitHub、GitLab、飞书 Connector。
- 未验证真实宿主 Skill discovery、真实账号身份链或外部权限。
- 未生成或验证签名发布物。
- 未执行生产部署、生产事件恢复或真实外部系统回读验收。
