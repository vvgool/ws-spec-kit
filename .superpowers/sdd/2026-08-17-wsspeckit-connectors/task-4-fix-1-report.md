# Task 4 修复报告（第 1 轮）：飞书来源机密性与分页一致性

## 状态

完成。严格修复 `task-4-review.md` 的两个 Important finding：发布/读取内容的凭据边界，以及分页期间的 canonical Source identity 一致性。没有开始 Task 5，没有调用真实飞书账号或网络。

基线：`495d347`

## TDD 证据

### RED

- 发布机密性：先加入递归编码凭据、Authorization/Cookie、GitHub/GitLab/Lark token、非法 percent 编码和残留第五层编码用例。旧实现有 9 个恶意输入进入 Provider spawn，最终以回读不匹配失败；普通飞书文档 token 正例通过。四层 GitLab 用例最初错误使用不编码连字符的 `encodeURIComponent()`，修正为字面量 `glpat%2525252D...` 后再确认 RED。
- 分页一致性：先加入 revision、updatedAt、owner、space 的变化、缺失和出现漂移共 11 个负例。旧实现全部报 `Missing expected rejection`。
- 读取机密性：先加入 title、Markdown、metadata 中的递归编码凭据，以及非法 percent 和第五层残留编码 fixture。旧实现 5 个用例全部报 `Missing expected rejection`，并会继续创建 Source Artifact。

### GREEN

- 发布聚焦：12/12 PASS。
- 分页聚焦：12/12 PASS。
- 读取机密性：6/6 PASS。
- Task 4 三模块最终聚焦：50/50 PASS，退出码 0。

## 修复实现

### 发布和读取的机密性边界

- 复用 Task 2 的公开、有界、递归 percent decode 凭据表面检查，并增加整段文本加逐行检查的公共 helper。
- 发布 title 在构造 argv 前扫描原始值和规范化值；Markdown 先执行 byte/character 上限，再扫描原文、规范化正文，并覆盖整段与逐行表面。
- 读取每一页的 title、Markdown 和 allowlist metadata value 均在形成 Source 前检查；读取到恶意内容时只返回固定 `WSSPEC_FEISHU_RESPONSE_INVALID`，不回显响应内容。
- 检查覆盖 raw 和 1-4 轮解码；非法 `%` 以及四轮后仍残留的第五层编码 fail closed。已覆盖 Authorization/Cookie/Bearer、GitHub/GitLab PAT 和 Lark `t-`/`u-`/`a-` token family。
- 发布恶意内容在 spawn 前拒绝，fixture 调用日志不存在；读取恶意响应只发生必要 fetch，不创建 `.wsspec` 或 Source Artifact，fixture 日志仍只有固定 fetch argv。

### 分页 canonical identity

- `revision` 作为现有响应合同的必需字段；单页缺失和分页后续页缺失均 fail closed。
- 每页生成稳定 canonical identity，包含 document token、canonical URL、title、updatedAt（缺失以 `null` 表示）和全部 allowlist metadata。
- metadata key 固定排序，数组值按语义排序后参与 identity；分页正文、cursor、hasMore 不属于 Source identity。
- 后续每页必须与第一页 identity 完全一致，因此字段变化、缺失或新出现都拒绝，不产生混合版本 Source。
- 保持原有固定 fetch argv 和回读流程，没有增加未记录的远端调用。

## 验证

- Task 4 聚焦测试：50/50 PASS，退出码 0。
- `npm test`：662/662 PASS，0 fail，退出码 0。
- `npm run lint`：PASS，退出码 0。
- `npm run typecheck`：PASS，退出码 0。
- `npm run build`：PASS，退出码 0。
- `npm run schemas:generate`：PASS，退出码 0。
- `git diff --exit-code -- schemas`：PASS，无 Schema drift。
- `git diff --check`：PASS。
- fixture `tests/fixtures/bin/lark-cli` 保持 `100755`。

## 自审

- 变更文件限定在共享 secret detector、Feishu publish/fetch Adapter 及对应 fixture/tests/report，没有 Task 5 内容。
- 公开错误均使用固定消息；恶意 title、Markdown、metadata 不进入错误、日志、receipt 或 Artifact。
- 分页比较覆盖 Source 输出使用的全部身份字段，并对 optional 字段的缺失/出现漂移 fail closed。
- 没有新增真实网络、账号配置读取或外部写入。

## 剩余关注点

- 本轮只证明当前 macOS/Node 与离线受控 fixture；未调用真实飞书账号、OAuth 或网络，不证明真实权限、远端 JSON/Markdown、限流和生产部署行为。
- `lark-cli v1.0.0` 仍要求 Markdown 位于 argv。已识别凭据会在 spawn 前拒绝，错误、receipt 和 fixture 日志也不保存正文；但普通正文在执行窗口仍可能被同机进程列表读取。这是 Task 4 已接受并继续保留的生产风险，收紧依赖上游提供 stdin/file 输入。
- Linux 进程和 CLI 行为未在本轮验证。
