# Task 2 Fix Round 3 报告：拒绝多层编码的 Source 凭据

## 状态

完成。修复基线为 `d7ede53 fix: authenticate source authority before access`，范围严格限定为 `task-2-fix-2-review.md` 剩余的 1 个 Critical：双重及多层 percent encoding 可绕过 canonical URL secret detection。未做 Connector、兼容、迁移、恢复或审批改动，未开始 Task 3，未推送。

## Finding 关闭情况

旧实现对每个 URL surface 只执行一次 `decodeURIComponent()`；双重编码第一次解码后仍是 `%HH` 序列，因此 detector 无法看到下游再次解码后出现的凭据。

现由所有 URL 表面共用有界严格 decoder：raw URL、username、password、hostname、Unicode domain、每个 path segment、raw query key/value、`URLSearchParams` key/value 和 fragment 都逐轮执行长度检查、secret scan 与严格 percent 解码。最多允许 4 轮，每个中间值限制为 8192 UTF-8 bytes；非法 percent escape 立即返回固定 `WSSPEC_SOURCE_INVALID`，4 轮后仍有合法 percent escape 则返回固定 `WSSPEC_SOURCE_METADATA_INVALID`。错误不回显 URL 或凭据。

query 同时扫描 raw `+` 和 `URLSearchParams` 的 form-decoded 空格语义；hostname 同时扫描解析值和 `domainToUnicode()` 结果。合法 Unicode 编码 URL 与普通 `+` query value 仍可接受，任意深度编码和合法 `%25` 均按 fail-closed 合同处理。

## TDD 证据

先补回归测试并在产品代码修改前执行。最初生成器使用 `encodeURIComponent(token)`，由于字母、数字、`-`、`_` 不会被编码，不能构成有效 RED；修正为逐 UTF-8 byte 生成 `%HH`、后续层再编码 `%` 后，旧实现得到 27 PASS、3 个新增行为组 FAIL。

RED 独立复现了双重编码的飞书 path、GitHub query 和 GitLab fragment 均被接受。GREEN 覆盖 1/2/3/4 层凭据拒绝、5 层有界失败、`%25` fail closed、大小写与拆分前缀、query `Basic+...` 语义、Unicode/punycode 与 percent hostname，以及合法编码 URL 和合法 `+` value 接受。

## 验证结果

- `node --import tsx --test tests/integration/requirement-source.test.ts`：30/30 PASS，0 fail。
- `npm test`：568/568 PASS，0 fail。
- `npm run lint`：PASS。
- `npm run typecheck`：PASS。
- `npm run build`：PASS。
- `npm run schemas:generate`：PASS。
- `git diff --exit-code -- schemas`：PASS，无 schema drift。
- `git diff --check`：PASS。

## 剩余关注点

- 本轮只验证当前 macOS/Node 本地实现与 fixture，没有调用真实 GitHub、GitLab、飞书账号或远端 API，不证明真实 Connector 认证、下游 URL 处理或生产可用性。
- 最多 4 轮解码和 8192-byte 中间表面上限是明确的 fail-closed 合同；超过边界的输入不会继续猜测或透传给下游。
- 本报告只证明 Task 2 Fix Round 3 的编码凭据修复与本地自动化门禁，不代表 Task 3 或生产 Connector GO。
