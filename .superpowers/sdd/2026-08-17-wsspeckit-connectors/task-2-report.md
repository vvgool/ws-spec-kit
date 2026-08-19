# Task 2 实施报告：不可变需求 Source Artifact

## 状态

完成。实现范围限定为不可变需求来源捕获及其在 Work Item、Application、Work Package、恢复和 Close 中的完整绑定，没有开始 Task 3 的 GitHub/GitLab Provider。

基线：`c1fb47a`

## TDD 与安全回归证据

Task 2 使用 `tests/integration/requirement-source.test.ts` 覆盖 Prompt、仓库文件、Provider 规范输入、内容寻址写入与磁盘复验。最终自审另外观察并修复了三组真实 RED：

- 恢复流程在认证 Work Item manifest 锚点前跟随 `manifest.source`。篡改 Source 引用后，测试原先得到 `WSSPEC_SOURCE_SNAPSHOT_CHANGED`，而不是预期的 `WSSPEC_WORK_ITEM_MANIFEST_CHANGED`。
- Provider `canonicalUrl` 只过滤 credential-like query key，未过滤 query value。加入 Bearer/GitHub token 样式的 query value 后，测试原先报告 `Missing expected rejection`。
- Close 的 Approval 比对在引用新增 `artifactId` 后仍只比较旧字段。Approval 与 Attempt 使用不同 `artifactId` 时，测试原先错误返回无缺失审批。

三项均先确认失败原因，再实施最小修复并观察聚焦测试转为 GREEN。恢复、Source、Close、conditional 与 approval 相关集成测试最终为 65/65 PASS。

## 实现

### 规范化与内容寻址

- 统一支持 `user.prompt`、`local.file` 和后续 Provider 可提交的 `github.issue`、`gitlab.issue`、`feishu.document` 规范输入。
- 正文使用严格 UTF-8，移除单个开头 BOM，统一 CRLF/CR 为 LF，并执行 NFC 规范化。
- 正文限制为 1 MiB 且不超过 262144 个 Unicode code point；空内容、NUL、二进制控制字符和超限输入 fail closed。
- `contentDigest` 绑定规范正文；`artifactId = source-<digest>` 与引用 `contentHash` 绑定除 `artifactId` 外的完整 canonical Artifact。
- canonical JSON 写入 `.wsspec/work-items/<id>/source/<digest>.json`，使用临时文件、fsync 和 hard-link no-clobber；重复或并发相同捕获只能接受逐字节相同文件。

### 文件与 Provider 安全边界

- 本地来源只接受规范的仓库相对 POSIX `.md`/`.txt` 路径。
- 路径组件拒绝 symlink，目标必须是普通文件；打开时使用 `O_NOFOLLOW`，并比较打开前、读取中和读取后的文件身份与大小。
- Provider metadata 使用按来源类型固定的 allowlist，拒绝自定义 prototype、未知字段、credential-like key/value 与越界数组/总大小。
- `canonicalUrl` 只接受无 userinfo 的 HTTP(S)，并拒绝 credential-like query key、query value 和 fragment。

### 生命周期绑定

- Work Item manifest 和 Application Snapshot 保存完整 Source Artifact 引用；公共 Schema 新增 `builtin.source-artifact.v1` 和可选 `artifactId` 引用字段。
- 只有声明 `requirement-source` 输入或输出的 Work Package 获得引用；正文与 metadata 不复制进 Work Package。
- `source.captured` 事件只保存 `{ artifactId, path, digest }`，不保存来源正文或 metadata。
- Application 加载、recovery 和 Close 均重新验证引用形状、canonical bytes、Schema、Artifact 身份和摘要。
- recovery 在解析或跟随 `manifest.source` 前认证固定 Application 快照与 `application-anchor.json`；传统无 Application/无锚点控制面仍保留兼容恢复。
- Close 保留并比较 `artifactId`，重新读盘验证 Source Artifact，避免审批或关闭时丢失来源身份。
- 新增 Source 错误码已登记到公共 CLI 错误契约，不会被折叠为未知 internal error。

## 验证

- 相关集成测试：65/65 PASS，退出码 0。
- `npm test`：543/543 PASS，0 fail，退出码 0。
- `npm run lint`：PASS，退出码 0。
- `npm run typecheck`：PASS，退出码 0。
- `npm run build`：PASS，退出码 0。
- `npm run schemas:generate`：PASS，退出码 0。
- `git diff --exit-code -- schemas`：PASS，生成后无未暂存 schema drift。
- `git diff --cached --check`：PASS。

## 剩余关注点

- 未调用真实 `gh`、`glab` 或 `lark-cli`，也未读取真实 GitHub、GitLab 或飞书账号数据；Provider 规范输入只由本地 fixture 验证。
- 本地结果证明当前 macOS checkout 的静态、构建和自动化测试门禁，不证明真实账号认证、远端内容一致性、生产部署或跨平台文件系统行为。
- Task 3 仍需分别验证真实 CLI 输出、认证边界、凭据脱敏和 Issue read-back，不能把本任务的规范输入 fixture 外推为 Provider 已可用。
