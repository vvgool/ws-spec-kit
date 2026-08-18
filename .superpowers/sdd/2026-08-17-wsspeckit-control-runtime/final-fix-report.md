# WSSpecKit Control Runtime 最终修复报告

## 结论

最终广域审查中的 1 个 Critical、2 个 Important 和 1 个 Minor finding 已在本地 Runtime 范围内修复。结论仅适用于当前 worktree、生成 Schema、本地构建与自动化测试，不代表真实外部系统或生产环境验收。

## TDD RED 证据

- 完整测试资产：新增测试先证明旧 Evidence 不含 helper、fixture、snapshot、测试配置、CJS reader 和动态 import 资产。
- Trace 边界：新增截断记录，证明超过条目上限时必须 fail closed。
- Review-Fix：重命名并增加第二个语义等价 loop，证明旧编译约束可被固定 ID 绕过。
- External receipt：使用错配 stableId、错配 externalWorkItemId、陈旧回读摘要和 binding 重绑证明旧 Close 可接受错误对象。
- Public errors：证明 close 与 evidence ingestion 错误组未按实际公开路由拆分。

## 实现

- trusted `node:test` gate 注入引擎控制的 preload 和 reporter，跟踪真实 ESM/CJS 模块加载及 `fs.readFileSync`、`fs.readFile`、`fs.promises.readFile` 读取；调用 `syncBuiltinESMExports()` 让 named ESM import 使用已包装的 builtin。
- Trace 使用独立临时目录、exclusive create、普通文件及 canonical parent 校验，并限制 4096 条和 1 MiB 汇总；缺失、非法、越界或截断均 fail closed。
- Red/Green/Cycle Evidence 绑定排序后的完整测试资产 manifest、摘要和不可变分类配置。Implement/Fix 后测试资产变化会使旧 Red 失效。
- 编译器按 loop 后代的 `actorRole: review` 与 `actorRole: fix` 语义识别所有 Review-Fix loop，并逐一实施 Profile 轮数与 Governed 独立主体约束。
- 新增 `builtin.external-receipt.v1`，绑定 target、stableId、externalWorkItemId、发布摘要、回读摘要与状态。记录前、事件 replay/recovery 和归档写入前均验证严格 schema；Close 另外验证当前 binding 和内容一致性。
- 公开错误合同将 `close` 与非公开路由的 `evidenceIngestion` 分组拆开，仅向实际可达路由声明错误。

## 验证

- dependency trace 对抗测试覆盖静态 ESM named import、动态 import、CJS require、CJS `fs.readFileSync`、helper、fixture、snapshot 与测试配置，并验证截断 fail closed。
- External receipt 对抗测试覆盖错配身份、陈旧内容、binding 重绑、append 前拒绝、replay 拒绝和 archive 写前拒绝；Governed E2E 覆盖有效 receipt 的恢复与归档。
- Review-Fix 聚焦测试覆盖重命名与多个匹配 loop。
- 最终完整门禁结果记录于提交前验证输出。

## 验收边界

- 仅验证本地 Runtime、临时 Git worktree、本地 JSON read-back、生成 Schema 和本地构建。
- 未接入或验证真实 GitHub、GitLab、飞书 Connector。
- 未验证宿主 Skill discovery 或宿主身份可信链。
- 未生成或验证签名发布物。
- 未执行生产部署、生产事件恢复或生产回读验收。
