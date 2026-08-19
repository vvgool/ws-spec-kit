# Task 3 Fix Round 1 报告：Issue Provider 原生 CLI 合同

## 状态

完成。严格限定为 `task-3-review.md` 的 5 个 Important finding；没有开始 Task 4，没有使用真实 GitHub/GitLab 账号、认证配置或网络。

修复基线：`c9a0648`

## TDD 证据

### 1. GitLab 原生 host flag

- RED：先把单元期望与可执行 fixture 收紧为 `--hostname`；严格 fixture 拒绝生产代码仍发送的 `--host`，集成读取以 `WSSPEC_ISSUE_REQUEST_FAILED` 失败。
- 修复：GitLab read/write argv、代码内 Manifest 和 YAML Manifest 全部改为 `--hostname`；fixture 对完整 argv 顺序、method、endpoint、host flag、host 值和 `--input -` fail closed。
- GREEN：GitLab 单元与 Issue Source 集成聚焦 17/17 PASS；fixture `glab api --help` 明示 `--hostname string`，负向 `--host` 以 exit 9 拒绝。

### 2. 原生响应字段投影

- RED：先把 GitHub/GitLab Issue、comment/note fixture 升级为脱敏原生形状，并补缺必需字段、错类型、101 项数组、规范化重复和 raw-response marker；聚焦 31 项中 19 项因 `exactRecord` 拒绝正常附加字段而失败。
- 修复：响应对象改为“普通对象 + 必需自有字段存在”；必需字段仍执行严格类型、字节、编号、身份、时间、数组上限和重复检查，未知原生字段不进入归一化 DTO 或错误。
- GREEN：GitHub/GitLab/Issue Source 聚焦 31/31 PASS；缺字段、错型、超限与稳定身份漂移仍 fail closed，错误不包含原始响应 marker。

### 3. 关闭只能走 `issue.close`

- RED：两端 `{ type: "state", state: "closed" }` 测试均启动 CLI 后才以请求失败结束，证明普通 state 可绕过 close 合同。
- 修复：公开 union 和运行时 validator 同时将普通 state 收窄为仅 `open`；GitHub reopen 仍发送 `{ state: "open" }`，GitLab reopen 固定发送 `{ state_event: "reopen" }`。
- GREEN：两端 generic closed 均以 `WSSPEC_ISSUE_ACTION_INVALID` 在 spawn 前拒绝且日志不存在；既有 `issue.close` 测试仍验证 read-open、write-close、readback 三调用及 already-closed 幂等。

### 4. Canonical readback 与原始 stdin

- RED：NFD、CRLF/CR 的 comment/body/labels 等价回读共 10 项全部失败；规范化后重复的 labels 输入还会进入 CLI。
- 修复：比较双方统一使用 CRLF/CR 到 LF、再 NFC 的 canonicalization；labels 规范化后查重并稳定排序比较。validator 和 mutation payload 保留批准的原始字符串，不在发送前改写。
- GREEN：canonical 聚焦 10/10 PASS；comment、body、labels 的首个调用日志均逐值保留原始批准 payload，等价远端回读成功，规范化重复输入零 spawn 拒绝。

### 5. Target 凭据扫描

- RED：GitHub/GitLab token target 均进入进程，最后才因 canonical URL 不匹配报 `WSSPEC_ISSUE_RESPONSE_INVALID`。
- 修复：将 Task 2 的最多 4 轮、有界 percent 解码扫描提取到 `secret-detector.ts`；Issue target 在 endpoint/argv 构造前扫描 host、owner、repo、完整 projectPath 和每个 segment，命中后只返回固定 generic target error。
- GREEN：两端 target 聚焦 2/2 PASS，覆盖 `github_pat_`、`ghp_`、`glpat-`、高熵 Lark token 与三层 percent 编码；所有拒绝均无 spawn/log，合法近似名称不误报。Task 2 requirement-source 回归 30/30 PASS。

## 最终验证

- Task 3 聚焦：44/44 PASS，0 fail。
- `npm test`：612/612 PASS，0 fail/cancel/skip/todo。
- `npm run lint`：PASS。
- `npm run typecheck`：PASS。
- `npm run build`：PASS。
- `npm run schemas:generate`：PASS。
- `git diff --exit-code -- schemas`：PASS，无 schema drift。
- `git diff --check`：PASS。

## 剩余关注点

- 所有 Provider 验证均使用私有临时目录中的本地 fixture；没有读取真实认证配置，也没有发起真实 CLI 账号或网络请求。
- fixture help 与原生响应形状是受控合同证据，不证明真实 GitHub/GitLab 版本、企业 Host、权限、限流 header 或远端写入/回读可用。
- 真实账号只读与最小批准写入验收仍是独立后续门禁；本轮不扩展该边界。
