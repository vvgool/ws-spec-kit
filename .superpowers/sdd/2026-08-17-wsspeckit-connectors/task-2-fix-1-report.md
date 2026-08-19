# Task 2 Fix Round 1 报告：加固不可变 Source 快照

## 状态

完成。修复基线为 `434193c feat: snapshot requirement sources`，范围严格限定在 Task 2 的 Source 权威链、文件系统边界、审批摘要、Work Package 输出授权和对应测试/文档；未开始 Task 3，未调用真实 GitHub、GitLab 或飞书 Provider，未推送。

按本轮明确决策，不为旧 v1 Source Work Item 实现兼容或迁移。缺少 `application-anchor.json`、Application Snapshot 或唯一有效 `source.captured` 事件的旧 Work Item 以 `WSSPEC_SOURCE_SNAPSHOT_CHANGED` fail closed。

## 原 Review 关闭情况

### Critical

1. **未锚定 recovery 信任可变 manifest：已关闭。** Source 恢复权威改为 Application anchor、Application Snapshot 与唯一 `source.captured` 事件。manifest 和 Application 的完整 Source 引用必须先与事件一致，之后才会跟随路径读取 Artifact。Application 加载和 Close 复用同一事件来源。
2. **secret detector 可绕过且错误回显 metadata：已关闭。** 新增集中式 detector，覆盖 `github_pat_`、`gh[pousr]_`、`glpat-`、Slack token、Authorization、Cookie/Set-Cookie、Bearer、Basic 与高风险 key；metadata 和 URL query key/value/fragment 共用检测。公开错误不回显攻击者提供的 key/value。
3. **hardlink 破坏不可变 Source/Artifact：已关闭。** 本地 Source 和磁盘 Artifact 都要求单链接普通文件，并在路径、FD、读取后路径之间绑定 `dev`、`ino`、`size`、`mtimeNs`、`ctimeNs`、`nlink`。预置 hardlink、新建后 hardlink 和读取期间身份变化均 fail closed。

### Important

1. **Artifact root 未认证：已关闭到 Node 宿主边界。** 根目录拒绝 symlink、越出 repository/worktree、非当前 UID 所有或 group/world writable；新建和既有目录组件均逐项验证并在创建后复检。Node 没有本实现可用的 dirfd-relative `openat`/`linkat` 接口，因此同 UID 主体在检查间隙替换自身路径仍明确保留为宿主信任边界，不宣称 race-free。
2. **单 Artifact 审批摘要未绑定完整身份：已关闭。** 删除单项 `contentHash` 快捷路径。摘要统一绑定版本、stage、attempt 和完整 Artifact 引用，并按 `artifactType + path` 内部排序以保持数组顺序无关。无法 canonicalize 时返回已登记的 `WSSPEC_APPROVAL_DIGEST_INVALID`。
3. **Source output 泄露已有引用：已关闭。** `requiredOutputs` 改为只含 `artifactType`、`schemaVersion` 和可选 `contentLevel` 的期望描述；现有 Source 只在 Step 声明 input 时出现在 `workPackage.artifacts`。Schema 拒绝在 `requiredOutputs` 中放入 ID、路径、摘要等 Artifact 引用字段。
4. **旧 v1 Work Item 兼容：按决策显式不兼容。** 不增加 v2 迁移或旧形状恢复。旧 Source manifest 没有新的可信链时固定 fail closed，并由恢复测试与公开文档明确该行为。

### Minor

1. **Unicode 路径身份不稳定：已关闭。** 本地文件继续按调用方实际拼写打开和验证 inode，同时把持久化 `stableId` 规范化为 NFC；macOS NFD/NFC 等价名称有聚焦测试。
2. **aggregate metadata 上限缺少真实测试：已关闭。** 新增每个单项合法但聚合字节超过上限的用例，并同时补齐 PAT、Artifact root、hardlink、未锚定替换和审批身份对抗探针。

## TDD 与回归证据

本轮按可观察 RED 到最小 GREEN 分组实施：

- recovery 的旧 Source、manifest/Application 协同替换和事件引用错位；
- GitHub PAT、Header/Cookie/Basic/Bearer 与 metadata/URL 凭据输入；
- 本地 Source/Artifact hardlink、Artifact root symlink/越界/owner/mode 和聚合上限；
- 单/多 Artifact 审批身份、stage、attempt、顺序和 Close 复验；
- output-only Source 授权与公开 Schema 负例；
- macOS NFD/NFC 路径身份。

首轮全量回归进一步发现两个旧夹具/目录遗漏：`lock-recovery.test.ts` 仍构造无锚点旧 Work Item，公开错误码目录遗漏 `WSSPEC_APPROVAL_DIGEST_INVALID`。二者均先在全量测试中得到失败，再将锁夹具迁到真实 `Application.start()`、补齐公共错误合同；未放宽生产恢复或审批边界。

## 实现摘要

- `control-plane.ts`、`state.ts`、`archive.ts` 统一从可信事件解析 Source 引用并在恢复、加载和 Close 中复验。
- `secret-detector.ts` 为 Source metadata 和 canonical URL 提供集中 credential-like 检测。
- `local-requirement.ts` 与 `requirement-source.ts` 加固 Unicode 身份、hardlink、目录 owner/mode、canonical containment 和读写身份复检。
- `approvals.ts` 统一计算完整且顺序稳定的审批绑定摘要。
- `work-package.ts`、Schema 定义和 acquire 将输出期望与现有 Artifact capability 分离。
- 共享 integration/E2E 夹具只从 `workPackage.artifacts` 取得已授权 Source 引用，不从 `requiredOutputs` 反推读取权限。

## 最终验证

- 聚焦 Source：`node --import tsx --test tests/integration/requirement-source.test.ts`
  - 22/22 PASS。
- 聚焦 recovery：`node --import tsx --test tests/integration/recovery.test.ts`
  - 15/15 PASS。
- 聚焦 approval：`node --import tsx --test tests/integration/approval.test.ts`
  - 9/9 PASS。
- 聚焦 Application：`node --import tsx --test tests/integration/application-flow.test.ts`
  - 69/69 PASS。
- 聚焦 Close：`node --import tsx --test tests/integration/workflow-close.test.ts`
  - 29/29 PASS。
- 公共 Schema：`node --import tsx --test tests/contract/schemas.test.ts`
  - 9/9 PASS。
- `npm test`
  - 556/556 tests PASS，0 fail，退出码 0。
- `npm run lint`、`npm run typecheck`、`npm run build`、`npm run schemas:generate`
  - 全部 PASS，退出码 0。
- schema 再生成前后 diff SHA-256 均为 `37b859d54f83f61690bf5eb892eb66110e0f399acf6ae40d511c52dd8f3491dc`，无额外 drift。

## 剩余关注点

- 本轮只在当前 macOS/Node 本地文件系统和 fixture 上验证；未在 Linux、网络文件系统或其他文件系统语义下执行。
- Node 路径 API 无法提供本实现所需的 dirfd-relative 原子目录遍历与创建。同 UID 恶意进程可写 repository/worktree 或父目录时仍属于宿主信任边界；当前实现是检测和 fail-closed 加固，不是 OS 沙箱或 race-freedom 证明。
- 本轮没有调用真实 `gh`、`glab`、`lark-cli`，没有读取真实账号数据，也不证明真实 Provider 认证、远端一致性或部署可用性。
- 旧 Source Work Item 明确不兼容、不迁移。需要保留旧运行数据的环境必须在升级前另行做离线导出或重新创建 Work Item，不能依赖 Runtime 自动恢复。
- 本报告只证明 Task 2 Fix Round 1 的本地实现、契约和自动化门禁，不代表 Task 3 或生产 Connector GO。
