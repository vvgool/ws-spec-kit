# Connector、Provider、审批与回读契约

本参考定义外部能力的安全边界和后续 Connector 实现必须遵守的契约。Foundation 当前只捕获 Prompt 和仓库内 Markdown/TXT 需求；GitHub、GitLab、飞书、知识发布和外部 Issue 写入尚未完成真实 Provider 验收。

## 1. 来源与 Provider 边界

来源类型分为 `user.prompt`、`local.file`、`github.issue`、`gitlab.issue`、`feishu.document`。每个来源必须先规范化为不可变 Source Artifact，保留稳定身份、捕获时间、内容摘要和允许的元数据；Work Package 只引用 Artifact，不复制来源正文。

```json contract=normalized-requirement-source
{
  "type": "user.prompt",
  "stableId": "prompt:local-01",
  "title": "补充登录说明",
  "body": "说明失败重试的行为。",
  "metadata": { "channel": "local" }
}
```

Provider 必须使用固定 executable 与 argv，禁止 Shell 拼接和从日志、Artifact、Evidence 或错误中泄露 Cookie、Token、Keychain 内容或认证文件。当前不支持的来源类型返回 `WSSPEC_SOURCE_TYPE_UNSUPPORTED`；空来源或越界文件分别返回 `WSSPEC_SOURCE_EMPTY`、`WSSPEC_SOURCE_PATH_INVALID`。

## 2. 审批与外部写入

外部动作必须先生成精确授权，再执行，再回读。授权至少绑定 actor、稳定目标、动作、内容摘要、幂等键和有效期；配置开启、Workflow capability 或 Agent 建议都不是授权。审批必须由真实交互式 TTY 完成，否则返回 `WSSPEC_INTERACTIVE_TTY_REQUIRED`。

```json contract=schema:builtin.application-decision-input.v1
{
  "kind": "approval",
  "root": "/workspace/demo",
  "workItemId": "WSS-20260818-001",
  "requestId": "approval-01",
  "decision": "approved",
  "expectedDigest": "sha256:artifact",
  "actor": "maintainer"
}
```

审批摘要或状态不匹配时分别返回 `WSSPEC_APPROVAL_DIGEST_MISMATCH`、`WSSPEC_APPROVAL_NOT_PENDING`；过期请求返回 `WSSPEC_APPROVAL_EXPIRED`。Workflow Package 信任是单独的 `workflow_trust` 决定，不可借用步骤审批。

## 3. 回读、幂等与报告

Provider 写入后必须重新读取稳定目标，校验目标身份与预期内容摘要，并将回读证据写入审计记录。进程中断或远端结果未知时不得盲目重试；应按幂等键回读后进入对账。Issue 更新、知识发布、外部 Issue Close 和 Work Item Close 必须串行，任何必需外部关闭失败都不得关闭 Work Item。

```yaml contract=connector-write-intent
action: issue.update
target:
  provider: github
  stableId: github:issue:42
authorization:
  actor: maintainer
  digest: sha256:content
  idempotencyKey: work-item-01:issue-update
readBack:
  required: true
```

Fixture、已登录 CLI 和真实平台验收必须分层报告。Fixture 只证明本地契约，不能代替真实 GitHub、GitLab 或飞书的授权、回读和失败恢复证据。

## 4. Doctor 的不可探测认证边界

Doctor 必须先调用 executable locator，以区分 `missing_binary`。当二进制存在但 Manifest 将认证声明为 `auth.kind: unavailable` 时，Doctor 必须立即返回 `unauthenticated` 和 `DoctorAuthUnavailableReasonCode` 定义的唯一固定 reason code；不得启动该 Provider 的任何 CLI，包括 version 命令，也不得读取认证文件、访问网络、传递 `HOME` 或创建文件。

这类结果不包含 `version`，也不能返回 `available`。省略 `version` 表示当前没有可安全执行的探针，不表示 locator 未找到二进制。`auth.kind: none` 只允许本地 git；git 仍执行受审计的 version 探针，并在版本满足要求时返回 `available`。外部 Provider 不能用 `none` 绕过认证合同。

Doctor 的 `unauthenticated` 结果只描述 Task 1 的无副作用诊断边界。后续 Task 4 必须通过正式工作流中的实际只读 fetch，另外验证当前请求、Provider、外部对象和认证状态；该证据不能由 Doctor 的 locator、版本输出或本地 fixture 替代。
