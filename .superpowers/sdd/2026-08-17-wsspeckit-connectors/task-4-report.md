# Task 4 实施报告：飞书文档来源与知识发布 Provider

## 状态

完成。实现范围限定为飞书文档读取、Task 2 Source Artifact 接入、知识页面创建/更新、严格回读、Manifest 注册和 ExternalBinding/Receipt 内容绑定；没有开始 Task 5，没有调用真实飞书账号或网络。

基线：`3c3ee03`

## TDD 证据

首次运行 brief 指定的三个测试模块，退出码为 1，均因 `lark-cli` Adapter 不存在而产生 `ERR_MODULE_NOT_FOUND`，与预期 RED 一致。

提交前自审另外复现了 receipt 内容绑定缺口：给 Provider 传入绑定正文 B 的 `ExternalBinding`，同时发布正文 A，旧实现仍执行外部写入并返回成功，测试以 `Missing expected rejection` 失败。修复后，知识发布 binding 由单一已验证 Artifact 的规范 Markdown 正文生成摘要，Provider 在 spawn 前校验目标正文摘要；receipt 的发布摘要和回读摘要分别从实际发送的规范正文与实际 fetch 回读的规范正文独立计算，不再复制 binding 字段。

补充回归覆盖 NFD + CRLF 输入与 NFC + LF 回读的规范等价，以及凭据样式标题在进程启动前 fail closed。

## 实现

### 固定 CLI 和输入边界

- 读取固定使用 `docs +fetch --doc <token> --format json --as <user|bot>`；默认身份为 `user`，项目可显式选择 `bot`。
- 创建只允许 `folderToken`、`wikiNode`、`wikiSpace` 精确三选一，使用 `docs +create` 默认 JSON 输出；更新只接受已解析 document token，固定 `overwrite`，不向 create/update 传入不存在的 `--format`。
- 文档、目录、wiki 和 space 目标使用有界字符集、Host/URL 结构、多层 percent 解码与集中凭据检测；未知属性、访问器、凭据样式标题/metadata 和非法环境配置均在 spawn 前拒绝。
- 当前本机 `lark-cli v1.0.0` 只提供 `--markdown <value>`，没有 stdin/file 选项，因此规范 Markdown 以单一 argv value 传入；正文同时加入进程错误脱敏 secrets。

### 严格读取和 Source Artifact

- 响应要求 `doc_id`、`doc_url`、`title`、`markdown`、`has_more`，严格校验类型、必需字段、稳定 token、canonical URL、时间和 allowlist metadata；原生额外字段不进入规范输出。
- 支持最多 100 页、固定每页 100 条、offset cursor 循环检测和 1 MiB 聚合正文限制；分页 token、URL 或标题漂移时 fail closed。
- Markdown 规范为 NFC 和 LF，再交给 Task 2 `captureRequirement()` 形成内容寻址、不可变 Source Artifact。
- 认证、禁止、404、限流、缺失二进制、输出超限和 Schema 漂移映射为稳定错误；公开错误不保留原始 argv、stderr、URL、token 或正文。

### 写入、回读和可信 receipt

- 写成功后始终以写响应 `doc_id` 重新 fetch；wiki create 允许 `doc_url` 的 node token 与 `doc_id` 不同，但回读严格使用 `doc_id`。
- 回读 token、规范标题或规范 Markdown 摘要不一致，以及回读失败、分页异常或 Schema 漂移，均不形成成功 receipt。
- knowledge binding 的 `expectedPublishedContentDigest` 由 submit 路径重新读取并校验的单一 Artifact 正文生成；正文无法规范化或 Artifact 数量不是 1 时 fail closed。
- Provider 在写前要求 binding expected 摘要等于目标规范正文摘要；receipt 的 `publishedContentDigest` 与 `readBackContentDigest` 分别从发送正文和回读正文独立计算，再由既有 `externalReceiptMatches()` 对当前 binding、Step、Attempt、Work Item 和稳定目标进行严格核对。

### Manifest 与 fixture

- `lark-cli.yaml` 使用与代码审计常量逐字段一致的 argv 模板，包含分页 fetch；YAML loader 拒绝 duplicate key、warning、alias、符号链接、超限和合同漂移。
- Doctor 继续保持 `auth: unavailable` 和 locator 后零 Provider spawn，不将版本存在误报为认证可用。
- 测试 fixture 复制到私有 `0700` 临时目录执行，不读取真实认证配置或网络；调用日志中的 Markdown 固定写成 `<redacted>`，只记录 SHA-256。

## 验证

- 初始 RED：3 个测试模块因 Adapter 缺失失败，退出码 1。
- receipt 内容绑定 RED：旧实现对 binding B / 正文 A 未拒绝，测试报 `Missing expected rejection`；修复后聚焦用例 PASS。
- Task 4 聚焦测试：20/20 PASS，退出码 0。
- 控制面回归 `workflow-close` + `governed-workflow`：32/32 PASS，退出码 0。
- `npm test`：632/632 PASS，0 fail，退出码 0。
- `npm run lint`：PASS，退出码 0。
- `npm run typecheck`：PASS，退出码 0。
- `npm run build`：PASS，退出码 0。
- `npm run schemas:generate`：PASS，退出码 0。
- `git diff --exit-code -- schemas`：PASS，无 Schema drift。
- `git diff --check`：PASS。
- `git diff --cached --check`：PASS。

## 剩余关注点

- 本轮只证明当前 macOS/Node、本地受控 fixture 和控制面合同；未调用真实飞书账号、OAuth 配置或网络，不证明真实文档权限、wiki/folder/space 目标、限流响应、远端 Markdown 转换或生产部署可用。
- 真实生产 GO 仍需使用显式批准的最小目标分别完成 user/bot 只读 fetch、create/update、写后回读和失败恢复验收，并确认真实 CLI JSON Schema 与本实现一致。
- 当前 `lark-cli v1.0.0` 要求 Markdown 位于 argv。WSSpecKit 的错误、receipt、事件和 fixture 日志不会持久化正文，但在执行窗口内同机 OS 进程列表可能看到 argv。生产收紧依赖上游提供 stdin 或 file 输入后切换传输合同；在此之前这是明确保留的安全风险。
- fixture 进程边界只在 macOS 验证；Linux CLI 行为和目标主机部署仍需独立验收。
