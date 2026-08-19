# WSSpecKit Control Runtime Remediation 1 Fix 1 报告

## 结论

本轮只修复 `runtime-remediation-1-review.md` 的两个剩余 finding：窄 `testAssetPaths` 可遗漏真实测试依赖，以及 external receipt 的 Evidence key 未绑定 receipt target。当前 worktree 的实现、对抗测试、完整测试、E2E、构建和 Schema 门禁均通过，可提交独立复审；未进入 Connectors，也不据此宣称真实外部系统或生产环境 GO。

## Trusted test asset roots

- Project Config 的 `testing.testAssetPaths` 只作为选择器；编译时从每个 pattern 的首个 `*`/`?` 前静态前缀导出不可由 Evidence 收窄的 `testAssetRoots`。
- 窄 pattern、递归 pattern 和精确文件 pattern 都提升到静态父目录；根级 pattern 提升到仓库根 `.`。所有原始 roots 保留用于 ownership，扫描时只裁剪已由父 root 覆盖的重复子树。
- Red、Green、Implement、Review-Fix、replay/recovery 与 Close 都绑定并比较 roots，扫描 roots 下每个 regular file；root 或子级 symlink、非普通文件、路径逃逸、超过 4096 个文件或总计超过 1 MiB 均 fail closed。
- 非根 trusted root 下的文件始终归测试所有，即使 `productPaths` 同时匹配。仓库根 `.` 覆盖的文件只有在匹配 `productPaths` 且不匹配任何 `testAssetPaths` 时才是 product-only。
- `testAssets` 保留扫描到的全部逐文件摘要用于审计，聚合 `testAssetsDigest` 绑定 roots 与 test-owned 文件。由根级 pattern 扫描到的 product-only 内容可以正常随实现变化，但 helper、fixture、snapshot、配置或新测试邻接资源的变化会失效旧 Red。
- `testAssetRoots` 已进入 Fixed Gate 命令身份、Trusted Evidence、TDD Cycle、运行时恢复/归档比较、公开 Schema 与 Application Protocol 文档。

## External receipt canonical key

- `assertExternalReceipts` 保留 Evidence 的 `[key, value]` 关系，binding 与 receipt 都必须位于和自身 target 完全一致的规范 key：`external-binding:<target>`、`external-receipt:<target>`。
- Close 只读取当前 target 的规范 receipt key，不再遍历任意 Evidence value 寻找可匹配 receipt。
- 带错误 suffix 或完全无规范前缀的 receipt 在 append 时返回 `WSSPEC_EVENT_INVALID`，在 replay 与 archive 写入时返回 `WSSPEC_EVENT_CHAIN_INVALID`；archive 文件不会被创建。

## RED / GREEN

- RED：`tests/*.test.mjs` 只绑定测试入口，遗漏同根 helper、fixture 与 snapshot；根级 pattern 和 Java/Ruby/.NET 窄 pattern 同样不能形成完整静态上界。
- RED：合法 issue receipt 放入 `external-receipt:knowledge` 后，Close 与持久化边界仍可接受。
- GREEN：窄 glob、根级 product-only 例外、跨栈 roots 三条聚焦测试 3/3 通过；trusted root symlink、子级 symlink、ownership、文件数和字节上限测试通过。
- GREEN：receipt canonical key 的 Close、append、replay、archive 聚焦测试 2/2 通过；两份相关 integration 文件 53/53 通过。

## 完整门禁

- `npm run lint`：PASS。
- `npm run typecheck`：PASS。
- `npm test`：PASS，463/463。
- `npm run test:e2e`：PASS，66/66。
- `npm run build`：PASS。
- `npm run schemas:generate`：PASS。
- 临时目录重新生成 Schema 与 `schemas/` 比对：PASS，无 drift。
- `git diff --check`：PASS。

## 自审与边界

- 自审覆盖 test ownership 从配置编译、Gate 命令身份、Red/Green/Cycle、Review-Fix 到 replay/recovery/Close 的完整链，以及 receipt 从 append、replay 到 archive/Close 的规范 key 约束。
- 未发现新的 Critical、Important 或 Minor 问题；根级 trusted root 不阻止 `productPaths` 内的正常实现变化，相关聚焦测试已直接验证聚合摘要保持稳定。
- 本轮仅验证本地 Runtime、临时 Git worktree、本地 JSON read-back、生成 Schema 与打包/E2E fixture。未实现或验证 GitHub、GitLab、飞书 Connector、真实宿主 Skill discovery、真实账号身份链、签名发布物、生产部署、生产恢复或真实外部系统回读。
- 本提交只能进入独立复审；在复审关闭两个 finding 前，Control Runtime 仍不应扩展到 Connectors 或宣称生产 GO。
