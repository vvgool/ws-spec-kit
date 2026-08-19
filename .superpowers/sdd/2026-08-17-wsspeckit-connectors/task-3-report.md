# Task 3 实施报告：GitHub 与 GitLab Issue Provider

## 状态

完成。实现范围限定为 GitHub/GitLab Issue 读取、固定写动作、关闭回读、Manifest 注册和 Task 2 Source Artifact 接入；没有开始 Task 4，也没有调用真实外部账号或网络。

基线：`dfd590a`

## TDD 证据

先创建以下测试和隔离 fixture，再创建生产模块：

- `tests/unit/github-cli.test.ts`
- `tests/unit/gitlab-cli.test.ts`
- `tests/integration/issue-source.test.ts`
- `tests/integration/credential-redaction.test.ts`
- `tests/fixtures/bin/gh`
- `tests/fixtures/bin/glab`

首次运行 brief 指定的三个测试文件，退出码为 1。三个文件分别因 `github-cli.js` 或 `gitlab-cli.js` 不存在而产生 `ERR_MODULE_NOT_FOUND`，与预期 RED 一致。

实现后自审又增加一个规范化回归：NFD 标题和 CRLF/CR 正文最初由 Adapter 原样返回，两个测试均以实际值未规范化失败。最小修复在响应映射处执行 NFC 和 LF 规范化，再次运行 2/2 PASS；批准写入 payload 仍逐字通过 stdin 发送，不在写入前静默改写。

## 实现

### 固定进程与目标边界

- GitHub 只构造 `gh api --method GET|POST|PATCH <固定端点> --hostname <host>`；写入固定追加 `--input -`。
- GitLab 只构造 `glab api --method GET|POST|PUT <固定端点> --host <host>`；写入固定追加 `--input -`。
- GitHub `owner`/`repo` 和 GitLab `projectPath` 每段先按有界安全字符集校验，再编码为 endpoint；编号只接受正安全整数。
- Host 只接受无 scheme、路径、userinfo、端口的裸主机名，只进入 `--hostname`/`--host` 参数，不拼入 API endpoint。
- 公开写动作是 `comment`、`body`、`labels`、`state`、`issue.close` 的固定 union；调用方不能提供 method、endpoint 或 flags。
- 请求 payload 只经 stdin JSON；不提供 Token、Cookie 或任意认证字段。运行时环境只允许对应 Provider 的绝对 CLI 配置目录字段，类型绕过同样 fail closed。

### 严格映射与 Source Artifact

- 响应使用精确键集、类型、数组数量、字符串字节和总 stdout 上限校验，拒绝未知或漂移形状。
- GitHub 使用 `number` 对齐目标编号、`node_id` 构造稳定身份；GitLab 使用 `iid` 对齐目标编号、`id` 构造稳定身份，不交叉复用。
- 统一输出 `NormalizedIssue`，规范化 title/body/state/labels/updatedAt，并生成只含 allowlist 字段的 metadata。
- `captureRequirement()` 直接消费规范化 Issue，生成 Task 2 内容寻址 Source Artifact；事件和 Work Package 仍只保存既有安全引用。
- 错误稳定分类为 missing binary、404、401、403、rate limit、schema、identity/readback mismatch 和通用 request failure；公开错误不保留原始 argv、host、路径、diagnostic 或 cause。

### 写入、关闭与回读

- comment、body、labels、state 都使用固定 payload 和固定 method/endpoint，写后重新读取 Issue；正文、标签或状态不匹配不能返回成功。
- `issue.close` 先读取目标；已 closed 时幂等返回且不写。
- open 目标执行固定 close 写入，校验写响应与写前稳定身份一致且状态为 closed，再次 GET 校验同一稳定身份和 closed。
- 写入成功但回读 404、Schema 异常、身份变化或状态不匹配时抛出失败，不形成成功结果；后续持久化状态机由 Task 5 接管。

### Manifest 与 fixture

- 两份 YAML Manifest 必须是有界普通文件，YAML 解析拒绝 duplicate key、warning、alias，并与代码内审计常量逐字段一致。
- 注册复用 Task 1 `defineConnectorManifest` 和 `ConnectorRegistry`；Doctor fixture 验证 GitHub/GitLab 均保持 Task 1 的版本和认证 argv 合同。
- 仓库 fixture 在执行前复制到 `0700` 私有临时目录；执行副本只读取 argv/stdin 并返回本地 JSON，不读取真实 CLI 配置、Token 或网络。
- 凭据回归递归扫描 Provider error、event-shaped value 和 artifact-shaped value 的键和值；host/path 形式和 GitHub/GitLab token 形式均未残留。

## 验证

- RED：brief 指定 3 文件因 Provider Adapter 模块缺失失败，退出码 1。
- 规范化 RED：2/2 因 NFD 标题未规范化失败，退出码 1；修复后 2/2 PASS。
- checkout 权限 RED：Git 仅保存 executable bit，仓库 fixture 在模拟干净 checkout 的 `0755` 下触发权限断言失败；改为私有临时执行副本后 PASS。
- Task 3 聚焦测试：29/29 PASS，退出码 0。
- `npm test`：597/597 PASS，0 fail，退出码 0。
- `npm run lint`：PASS，退出码 0。
- `npm run typecheck`：PASS，退出码 0。
- `npm run build`：PASS，退出码 0。
- `npm run schemas:generate`：PASS，退出码 0。
- `git diff --exit-code -- schemas`：PASS，无 schema drift。
- `git diff --cached --check`：PASS。

## 剩余关注点

- 自动化只使用本地受控 fixture；未调用真实 GitHub/GitLab API、未读取真实认证配置，也不证明真实账号权限、企业 Host、限流 header 或远端写入/回读可用。
- 当前机器只有 `gh`，没有 `glab`；本任务没有对任一真实 CLI 发起账号或网络请求。后续真实只读验收必须分别核对安装版本、原生 JSON 字段与严格响应 Schema，再进行显式批准的最小写入验收。
- fixture 进程边界在 macOS 执行；Task 1 的 Linux POSIX 进程组分支和本 Provider 的 Linux CLI 行为未在 Linux 主机验证。
