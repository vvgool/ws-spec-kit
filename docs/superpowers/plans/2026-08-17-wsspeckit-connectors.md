# WSSpecKit 来源与交付 Connector 实施计划

> **Agent 执行要求：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务执行；每一步使用复选框跟踪。

**目标：** 实现 Prompt、文件、GitHub/GitLab Issue、飞书文档来源，以及受审批保护的 Git commit、Issue 更新、飞书知识发布和外部 Issue Close。

**架构：** Connector Registry 暴露规范化能力，Provider Adapter 只用固定 executable/argv 与外部 CLI 通信。所有来源先快照为不可变 Artifact；所有写入先授权、再执行、再回读，并以稳定目标和幂等键恢复。

**技术栈：** Node.js 22、TypeScript、`node:child_process.spawn`、现有 YAML/JSON Schema 工具；外部命令为 `git`、`gh`、`glab`、`lark-cli`，不新增 HTTP SDK。

## 全局约束

- 继承基础计划和控制流计划的公开接口与中文文案要求。
- Provider 不经过 Shell，不拼接命令字符串，不读取 CLI 认证文件。
- 凭据、Cookie、Token、Keychain 内容不得进入参数日志、Artifact、Evidence、事件或错误。
- 外部写入必须有精确授权、稳定目标、内容摘要、幂等键和回读证据。
- Fixture、已认证 CLI 和真实平台验收分层报告，Fixture 不能替代真实验收。
- 本计划不实现 push、merge、release、PR/MR 创建或任意自定义命令 Provider。

---

### Task 1：Provider Manifest、进程边界与 Doctor

**文件：**
- 创建：`src/registry/connectors/{types,registry,manifest}.ts`
- 创建：`src/adapters/process/{spawn-json,redaction}.ts`
- 创建：`src/application/doctor-connectors.ts`
- 创建：`tests/unit/{connector-registry,spawn-json,redaction}.test.ts`
- 创建：`tests/integration/connector-doctor.test.ts`

**接口：**
- 输入：`ConnectorManifest`、规范化 JSON 请求、可执行文件定位器。
- 输出：`ConnectorRegistry.resolve(capability, provider)`、`spawnJson(request): Promise<ProcessJsonResult>`、`doctorConnectors(): Promise<ConnectorHealth[]>`。

```ts
export interface ConnectorManifest {
  id: string;
  capabilities: string[];
  securityClass: "external-read" | "external-write" | "local-write";
  executable: "git" | "gh" | "glab" | "lark-cli";
  minimumVersion: string;
  argvTemplates: readonly string[][];
  timeoutMs: number;
  maxStdoutBytes: number;
}
```

- [ ] **步骤 1：编写 Registry、argv 和脱敏失败测试**

覆盖未知能力、重复 Provider、Shell 元字符作为普通 argv、超时、输出超限、非 JSON、非零退出、
`GH_TOKEN`/`GITLAB_TOKEN`/`Authorization`/Cookie 脱敏，以及错误对象不携带原始 env。

- [ ] **步骤 2：运行失败测试**

运行：`node --import tsx --test tests/unit/connector-registry.test.ts tests/unit/spawn-json.test.ts tests/unit/redaction.test.ts tests/integration/connector-doctor.test.ts`

预期：FAIL，提示 Connector Registry 和 `spawnJson` 模块不存在。

- [ ] **步骤 3：实现最小 Registry 和无 Shell 进程边界**

只调用 `spawn(executable, argv, { shell: false, env: allowlistedEnv })`；stdin 发送 JSON，stdout
达到上限立即终止。Doctor 仅运行版本与无副作用认证探测，状态限定为 `available`、
`unauthenticated`、`unsupported_version`、`missing_binary`。

- [ ] **步骤 4：运行聚焦测试和类型检查**

运行：`node --import tsx --test tests/unit/connector-registry.test.ts tests/unit/spawn-json.test.ts tests/unit/redaction.test.ts tests/integration/connector-doctor.test.ts && npm run typecheck`

预期：PASS；测试输出中不含注入的秘密标记。

- [ ] **步骤 5：提交**

```bash
git add src/registry/connectors src/adapters/process src/application/doctor-connectors.ts tests/unit tests/integration/connector-doctor.test.ts
git commit -m "feat: add connector provider boundary"
```

### Task 2：不可变需求来源快照

**文件：**
- 创建：`src/registry/connectors/requirement-source.ts`
- 创建：`src/registry/connectors/local-requirement.ts`
- 创建：`tests/integration/requirement-source.test.ts`

**接口：**
- 输入：`user.prompt`、仓库内 `.md/.txt` 文件或后续 Provider 的 `NormalizedRequirementSource`。
- 输出：`captureRequirement(input): Promise<SourceArtifact>`。

```ts
export interface NormalizedRequirementSource {
  type: "user.prompt" | "local.file" | "github.issue" | "gitlab.issue" | "feishu.document";
  stableId: string;
  canonicalUrl?: string;
  title: string;
  body: string;
  updatedAt?: string;
  metadata: Record<string, string | string[]>;
}
```

- [ ] **步骤 1：编写失败测试**

断言 Prompt 规范化、本地文件真实路径限制、二进制/超限拒绝、UTF-8、换行归一化、同内容同摘要、
来源变更不改写旧 Artifact，以及 Provider metadata 白名单。

- [ ] **步骤 2：运行失败测试**

运行：`node --import tsx --test tests/integration/requirement-source.test.ts`

预期：FAIL，缺少 `captureRequirement`。

- [ ] **步骤 3：实现捕获和快照**

写入 `.wsspec/work-items/<id>/source/<digest>.json`，事件只引用 Artifact ID 和摘要；正文不进入
Work Package，Agent 按 Artifact 引用读取。超出限制返回 `WSSPEC_SOURCE_TOO_LARGE`。

- [ ] **步骤 4：验证并提交**

运行：`node --import tsx --test tests/integration/requirement-source.test.ts tests/integration/recovery.test.ts && npm run typecheck`

预期：PASS。

```bash
git add src/registry/connectors/requirement-source.ts src/registry/connectors/local-requirement.ts tests/integration/requirement-source.test.ts
git commit -m "feat: snapshot requirement sources"
```

### Task 3：GitHub 与 GitLab Issue Provider

**文件：**
- 创建：`src/adapters/connectors/{github-cli,gitlab-cli}.ts`
- 创建：`src/registry/connectors/issue.ts`
- 创建：`resources/connectors/{github-cli,gitlab-cli}.yaml`
- 创建：`tests/unit/{github-cli,gitlab-cli}.test.ts`
- 创建：`tests/integration/{issue-source,credential-redaction}.test.ts`
- 创建：`tests/fixtures/bin/{gh,glab}`

**接口：**
- 输入：`github.issue` 的 `{ host, owner, repo, number }` 或 `gitlab.issue` 的 `{ host, projectPath, iid }`。
- 输出：统一 `NormalizedIssue`，并交给 Task 2 生成 Source Artifact。

```ts
export interface NormalizedIssue extends NormalizedRequirementSource {
  type: "github.issue" | "gitlab.issue";
  provider: "github" | "gitlab";
  repository: string;
  number: number;
  state: "open" | "closed";
  labels: string[];
}
```

- [ ] **步骤 1：编写固定 argv 与映射失败测试**

GitHub 读取只允许 `gh api --method GET repos/{owner}/{repo}/issues/{number}`，写入追加
`--input -`；GitLab 读取只允许 `glab api --method GET projects/{encodedPath}/issues/{iid}`，写入
使用 `<POST|PUT>` 并追加 `--input -`。覆盖 GitHub `number/node_id`、
GitLab `iid/id` 不混用、企业 Host、404、限流、恶意路径、Schema 漂移和缺少二进制。

- [ ] **步骤 2：运行失败测试**

运行：`node --import tsx --test tests/unit/github-cli.test.ts tests/unit/gitlab-cli.test.ts tests/integration/issue-source.test.ts`

预期：FAIL，Provider Adapter 不存在。

- [ ] **步骤 3：实现 CLI Adapter 和规范化**

请求体一律经 stdin；host 使用 CLI 专用参数，不进入端点字符串。GitHub 使用 `gh` 自身认证，
GitLab 使用 `glab` 自身认证；WSSpecKit 不提供 Token 配置字段。写操作只暴露 comment、更新正文、
标签/状态和 `issue.close` 四个固定动作，所有内容来自已批准 payload。`issue.close` 必须验证
当前状态为 open、写入 closed 状态并回读稳定 ID 和最终状态；已经 closed 的相同目标按幂等成功处理。

- [ ] **步骤 4：运行测试和安全扫描**

运行：`node --import tsx --test tests/unit/github-cli.test.ts tests/unit/gitlab-cli.test.ts tests/integration/issue-source.test.ts tests/integration/credential-redaction.test.ts`

预期：测试 PASS，扫描无凭据值。

- [ ] **步骤 5：提交**

```bash
git add src/adapters/connectors src/registry/connectors/issue.ts resources/connectors tests/unit/github-cli.test.ts tests/unit/gitlab-cli.test.ts tests/integration/issue-source.test.ts tests/fixtures/bin
git commit -m "feat: add GitHub and GitLab issue providers"
```

### Task 4：飞书文档来源与知识发布 Provider

**文件：**
- 创建：`src/adapters/connectors/lark-cli.ts`
- 创建：`src/registry/connectors/{feishu-document,knowledge-publish}.ts`
- 创建：`resources/connectors/lark-cli.yaml`
- 创建：`tests/unit/lark-cli.test.ts`
- 创建：`tests/integration/{feishu-source,knowledge-publish}.test.ts`
- 创建：`tests/fixtures/bin/lark-cli`

**接口：**
- 输入：文档 URL/token；发布目标 `{ folderToken? | wikiNode? | wikiSpace?, documentToken?, title, markdown }`。
- 输出：Source Artifact 或 `ExternalWriteReceipt`。

- [ ] **步骤 1：编写失败测试**

覆盖 `docs +fetch --doc <document> --format json --as user`、`+create` 三选一目标且使用默认 JSON 输出、
`+update` 必须有 doc 且使用默认 JSON 输出、拒绝向 create/update 传入不存在的 `--format`、
非法 URL、认证失败、分页、CLI 输出 Schema 漂移、创建成功但回读失败、标题或正文摘要不一致。

- [ ] **步骤 2：运行失败测试**

运行：`node --import tsx --test tests/unit/lark-cli.test.ts tests/integration/feishu-source.test.ts tests/integration/knowledge-publish.test.ts`

预期：FAIL，缺少 `lark-cli` Adapter。

- [ ] **步骤 3：实现读取、发布和回读**

只使用 `lark-cli` 当前 OAuth 身份，默认 `--as user`，项目可显式改为 `bot`。Markdown 不进入
诊断日志。写入成功后重新 `+fetch --format json`，比较 token、标题、规范化正文摘要并形成 receipt。

- [ ] **步骤 4：验证并提交**

运行：`node --import tsx --test tests/unit/lark-cli.test.ts tests/integration/feishu-source.test.ts tests/integration/knowledge-publish.test.ts && npm run typecheck`

预期：PASS。

```bash
git add src/adapters/connectors/lark-cli.ts src/registry/connectors/feishu-document.ts src/registry/connectors/knowledge-publish.ts resources/connectors/lark-cli.yaml tests/unit/lark-cli.test.ts tests/integration/feishu-source.test.ts tests/integration/knowledge-publish.test.ts tests/fixtures/bin/lark-cli
git commit -m "feat: add Feishu document provider"
```

### Task 5：外部动作授权、幂等与协调恢复

**文件：**
- 创建：`src/application/external-action.ts`
- 创建：`src/engine/external-effects/{authorization,idempotency,reconciliation}.ts`
- 修改：`src/application/{acquire,decide,submit}.ts`
- 修改：`src/storage/control-plane.ts`
- 创建：`tests/integration/{external-authorization,idempotency,reconciliation}.test.ts`

**接口：**
- 输入：Provider 写入意图和当前 Work Item/Attempt。
- 输出：`ExternalActionRequest`、`ExternalActionGrant`、`ExternalWriteReceipt` 或 reconciliation 状态。

- [ ] **步骤 1：编写失败测试**

覆盖审批前零写入、过期/错目标/错摘要授权、同幂等键重复提交、发送前崩溃、发送后回读前崩溃、
远端已写入但本地未知、知识发布前禁止 Issue Close、外部 Issue Close 失败阻止 Work Item Close、
可选知识目标 warning 和必需知识目标阻塞。

- [ ] **步骤 2：运行失败测试**

运行：`node --import tsx --test tests/integration/external-authorization.test.ts tests/integration/idempotency.test.ts tests/integration/reconciliation.test.ts`

预期：FAIL，缺少外部动作状态机。

- [ ] **步骤 3：实现状态机**

状态限定为 `prepared -> approved -> executing -> verified`，不确定结果进入 `reconciliation_required`，
不得自动重发。幂等键为 `workItemId/stepId/targetStableId/payloadDigest`；审批展示 Provider、动作、
稳定目标、内容摘要和副作用，不展示凭据。

- [ ] **步骤 4：运行恢复与授权测试并提交**

运行：`node --import tsx --test tests/integration/external-authorization.test.ts tests/integration/idempotency.test.ts tests/integration/reconciliation.test.ts tests/integration/recovery.test.ts && npm run typecheck`

预期：PASS。

```bash
git add src/application src/engine/external-effects src/storage/control-plane.ts tests/integration/external-authorization.test.ts tests/integration/idempotency.test.ts tests/integration/reconciliation.test.ts
git commit -m "feat: govern external connector effects"
```

### Task 6：受授权的 Git commit

**文件：**
- 创建：`src/adapters/connectors/git-native.ts`
- 创建：`src/registry/connectors/git-commit.ts`
- 创建：`tests/integration/git-commit.test.ts`

**接口：**
- 输入：批准的仓库 common-dir、基线 revision、精确文件列表、commit message 和 diff digest。
- 输出：commit OID、parent OID、tree OID、实际文件列表和回读摘要。

- [ ] **步骤 1：编写失败测试**

覆盖脏文件不在授权列表、基线变化、diff 摘要变化、空提交、merge/rebase 中、路径逃逸、Git hook
修改内容、提交成功后回读不一致，以及确认不支持 push/merge/release。

- [ ] **步骤 2：运行失败测试**

运行：`node --import tsx --test tests/integration/git-commit.test.ts`

预期：FAIL，缺少 `git.commit` Connector。

- [ ] **步骤 3：实现固定 Git argv**

使用临时 index 只暂存授权文件，提交前后分别计算 diff/tree；不执行用户提供的 Shell。保留正常
Git hooks，但 hook 改变授权内容时不形成成功 receipt，并要求重新审批。

- [ ] **步骤 4：验证并提交**

运行：`node --import tsx --test tests/integration/git-commit.test.ts tests/integration/external-authorization.test.ts && npm run typecheck`

预期：PASS。

```bash
git add src/adapters/connectors/git-native.ts src/registry/connectors/git-commit.ts tests/integration/git-commit.test.ts
git commit -m "feat: add approved git commit connector"
```

### Task 7：Connector Fixture E2E

**文件：**
- 创建：`tests/e2e/external-delivery-fixture.test.ts`
- 创建：`tests/fixtures/connectors/{github,gitlab,feishu}/*`
- 创建：`tests/fixtures/workflows/external-delivery/*`

**接口：**
- 输入：本计划全部 Provider、控制流计划 Runtime 和内置 Workflow。
- 输出：无新公开接口；形成 Connector 阶段门禁。

- [ ] **步骤 1：编写三条失败 E2E**

分别跑通 GitHub Issue、GitLab Issue、飞书文档来源；Issue 链严格断言
`Git commit -> Issue 更新 -> 飞书知识发布或 skipped -> 外部 Issue Close -> Work Item Close`。
注入每个外部阶段崩溃，验证不越序、不重复写入，且外部 Close 回读失败时 Work Item 保持 blocked。

- [ ] **步骤 2：运行 E2E，确认未接线失败**

运行：`node --import tsx --test tests/e2e/external-delivery-fixture.test.ts`

预期：FAIL，报告尚未注册的 Connector 或未完成的 Workflow action。

- [ ] **步骤 3：完成 Registry 接线并扫描持久化输出**

把四个 Provider Manifest 注册到 Builtin Catalog；测试递归扫描 `.wsspec` 和 `.git/wsspec`，
断言秘密标记、HOME 绝对路径、CLI 配置内容均不存在。

- [ ] **步骤 4：运行完整 Connector 门禁**

运行：`npm run lint && npm run typecheck && npm test && npm run build`

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add tests/e2e/external-delivery-fixture.test.ts tests/fixtures src/registry/connectors
git commit -m "test: cover fixture external delivery"
```

## 完成门禁

`wspec doctor connectors` 能分别诊断 `git`、`gh`、`glab`、`lark-cli`；GitHub/GitLab/飞书
Fixture 全部通过；授权前无写入，未知写入结果不自动重试，回读不一致不形成成功 Evidence；
存在 Issue Binding 时，没有经过授权并回读成功的外部 Issue Close 就不能关闭 Work Item。
本机未安装或未认证某个 CLI 只影响该 Provider 的真实验收，不得用 Fixture 标记其生产可用。
