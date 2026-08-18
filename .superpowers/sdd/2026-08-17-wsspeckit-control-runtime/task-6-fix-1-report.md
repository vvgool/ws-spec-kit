# Task 6 Fix Round 1 报告

## 状态

- 已修复 review 中 1 个 Critical 和 3 个 Important；未扩展 Minor、真实外部 Connector、宿主发现或生产验收范围。
- Artifact 完整性、repository-relative matcher、symlink/非普通文件边界、Governed 活动态恢复与归档审计均有 source 或 built/dist 对抗测试。

## RED 证据

- Artifact 写入和篡改后 workspace digest 不变；仓库预先忽略 `.wsspec/work-items/` 时，初版专用 Artifact digest 也保持不变。
- Close 缺少磁盘重验入口；已审批 Artifact 正文可在投影不变时被替换。
- 文档 Gate 接受仓库外 symlink，并在目录路径上以 `EISDIR` 非结构化失败。
- submit/docs/compiler 各自实现 glob；旧 compiler containment 不支持 `docs/**/*.md` 对 `docs/readme.md` 的零目录语义。
- Governed 只有 Close 后 `inspect` 恢复，未覆盖 active Attempt 的 `inspect + acquire`，也未读取 archive audit。

## 修复

- workspace digest 仅排除 Artifact、归档和严格列举的 `runtime.json`、`events.jsonl`、`runtime.lock`；Artifact 通过不受 `.gitignore` 影响的 `artifactTreeDigest` 单独摘要，并写入 Close Evidence 与 audit。
- `control.close` 通过异步 worktree checklist 重新验证全部 required/approved Artifact；核对普通文件边界、producer、schema、path、revision、content hash、完整引用和 Approval binding。删除、malformed、替换、symlink 均 fail closed。
- 新增 1024 字符上限、记忆化有限 matcher，统一 `*`、`?`、`**`、`**/` 零目录语义；submit、docs Gate 和 compiler containment 共用实现。
- 文档和 Artifact 文件解析统一要求 `lstat + realpath + canonical root containment`，拒绝 symlink、symlink traversal 和非普通文件；build 后直接导入 `dist` 重复对抗验证。
- Governed 在 `commit` 审批后损坏 active `update-issue` projection，经公开 `inspect + acquire` 恢复；断言 Attempt 被安全替换且 retry=2，Profile、Loop 和审批不重置。Close 后实读 audit，核对 decisions、approvals、actors 与 publishing receipts。

## 验证

- 受影响集合：152 tests，0 fail。
- `npm run lint`、`npm run typecheck`、`npm test`（446/446）、`npm run build`、`npm run schemas:generate`、Schema drift 与 `git diff --check` 均通过。

## 边界

- 本轮证明本地 Runtime、临时 Git worktree、本地 JSON read-back fixture 和构建产物边界。
- 未执行真实 GitHub、GitLab、飞书 Connector、真实宿主 Skill 发现、签名发布物或生产恢复验收。
