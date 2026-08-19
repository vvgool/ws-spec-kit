# Task 2 Fix Round 2 报告：访问 Source 前认证权威链

## 状态

完成。修复基线为 `8afca26 fix: harden immutable source snapshots`，范围严格限定为本轮 2 个 Critical 和 1 个 Important：恢复权威顺序、飞书 token 与完整 URL 表面检测、完整 Artifact 引用审批排序。未做兼容或迁移，未开始 Task 3，未推送。

## Review 关闭情况

### Critical 1：Recovery 在认证 Application 前访问 Source

已关闭。新增共享 `authenticateApplicationSourceAuthority()`，并由 recovery、Application 加载和 Close 共用，固定执行顺序为：

1. 读取固定 `snapshot/application.json` 字节；
2. 验证 `application-anchor.json` 的 Work Item 身份和 manifest 摘要；
3. 验证 Application 摘要并严格解析 Application；
4. 读取并要求唯一有效的 `source.captured` 事件；
5. 比较事件、Application、manifest 的完整 Source Artifact 引用；
6. 最后才解析真实路径并读取、验证 Source Artifact。

Application 摘要失配现在稳定优先于 Source 缺失、恶意路径或引用错位。缺少 Source 文件时不会在 Application 认证前发生 Source 文件系统访问。旧版缺少权威链的 Work Item 仍按既有决策 fail closed，不增加兼容或迁移路径。

### Critical 2：飞书访问令牌和 URL 表面可绕过 detector

已关闭。统一 secret detector 新增飞书小写前缀 `t-`、`u-`、`a-` 访问令牌识别，要求至少 24 个 token payload 字符且 Shannon entropy 不低于 3 bits/character，并使用显式字母数字边界。短前缀、低熵占位值、普通单词和合法飞书文档 token 保持可用。

`canonicalUrl` 先严格解析为 HTTP(S) URL，再逐项解码并扫描 username、password、hostname、每个 path segment、原始 query key/value 和 fragment。非法 percent encoding 直接失败关闭；percent-encoded hostname、path/query/fragment 和 punycode hostname 都不能绕过检测。所有拒绝错误使用固定消息，不回显 token 或攻击者控制的 URL 表面。

### Important：审批 Artifact 排序不是完整全序

已关闭。审批引用先将 `artifactType`、`artifactId`、`schemaVersion`、`path`、`revision`、`contentHash`、`mediaType` 规范化为 canonical JSON，再使用 canonical JSON 的 UTF-8 bytes 作为全序排序键。摘要计算、审批准备、审批复验和 Close 比较共用同一排序函数。

相同 `artifactType/path`、不同 ID/revision/hash 的引用在数组反转后摘要保持一致；Unicode 字段不依赖 locale；任一完整引用字段变化仍改变摘要。Close 不再因稳定排序保留 tied-key 输入顺序而产生伪审批失配。

## TDD 证据

本轮严格先写并执行失败用例，再修改产品代码：

- recovery RED：Application 同时篡改且 Source 被删除时，旧实现先报 `WSSPEC_SOURCE_SNAPSHOT_CHANGED`；Application 同时篡改且 anchored manifest 指向恶意 Source 路径时，旧实现也先报 Source 引用错误。GREEN 后两例都稳定返回 `WSSPEC_APPLICATION_SNAPSHOT_CHANGED`。
- detector RED：飞书 `t-`、`u-`、`a-` metadata、URL path/query/fragment/hostname、非法 percent encoding 用例在旧实现中未被拒绝。GREEN 后全部拒绝，边界/低熵/合法文档 token 负例保持接受。
- approval RED：相同 type/path 的完整引用数组反转后旧摘要不同，Close 报伪 approval 缺失。GREEN 后 digest 与 Close 均顺序无关，字段变化仍改变摘要。

旧 Close Source 测试只伪造事件而没有 Application/manifest/anchor 权威链。共享认证入口启用后，该夹具按新契约改为真实 `Application.start()` 生成的完整链，没有放宽生产认证逻辑。

## 验证结果

- `node --import tsx --test tests/integration/recovery.test.ts`：17/17 PASS。
- `node --import tsx --test tests/integration/requirement-source.test.ts`：26/26 PASS。
- `node --import tsx --test tests/integration/approval.test.ts tests/integration/workflow-close.test.ts`：40/40 PASS。
- `npm test`：564/564 PASS，0 fail。
- `npm run lint`：PASS。
- `npm run typecheck`：PASS。
- `npm run build`：PASS。
- `npm run schemas:generate`：PASS，生成后 `schemas/` 无 diff。
- `git diff --check`：PASS。

## 剩余关注点

- 本轮仅验证当前 macOS/Node 本地实现和 fixture，没有调用真实 GitHub、GitLab、飞书账号或远端 API，不证明真实 Connector 认证与生产可用性。
- 飞书 token 识别按本轮明确的前缀、最小长度和熵阈值实现；后续若官方 token 字符集或长度合同变化，应以官方格式和真实脱敏样本追加对抗测试后再调整，不能放宽为任意 `t-`、`u-`、`a-` 字符串。
- 旧 Source Work Item 仍明确不兼容、不迁移；本轮没有改变该决策。
- 本报告只证明 Task 2 Fix Round 2 的本地实现、契约和自动化门禁，不代表 Task 3 或生产 Connector GO。
