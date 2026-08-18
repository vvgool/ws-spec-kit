# Foundation Task 9 修复第 4 轮报告

## 范围

- 基线：`a6f512f`（`fix: bound public CLI error codes`）。
- 本轮只关闭复审唯一 P1：CLI 对 `WSSPEC_INTERNAL_ERROR`、未知异常和非 Error 抛出值统一返回固定中文安全消息，不透传原始 message、stack 或 details。
- 已注册且非 internal 的 public code 保留现有中文消息；Application 直接 API 行为不变。
- 未开始 Runtime，未合并、推送、发布或执行真实外部 Provider 操作。

## 修复闭环

| 复审项 | 修复与证据 |
| --- | --- |
| internal code 命中 public 透传分支 | `applicationInternalError` 在 public contract 中统一定义 fallback code 与固定中文消息；`errorOutput` 只透传已注册且非 internal 的 Error。 |
| 函数级异常来源泄露 | 合同测试覆盖显式 `WSSPEC_INTERNAL_ERROR`、未知 `WSSPEC_` code、其他带 code Error、普通 Error、字符串和带 message/stack/details 的非 Error 对象，全部精确断言同一固定输出。 |
| 真实 CLI parser 泄露 | E2E 实际启动 CLI，读取包含凭据样例的 malformed result JSON；精确断言退出码 1、stdout 为单条换行终止的固定 JSON、stderr 为空，并拒绝 parser 文本和凭据样例。 |
| public catalog/docs 语义不清 | `WSSPEC_INTERNAL_ERROR` 继续作为公开 fallback code 保留在 catalog；Application Protocol 参考明确它不是消息透传业务错误，并区分 CLI 输出适配层与 Application 直接 API。 |

## TDD 证据

修改生产代码前运行：

```text
node --import tsx --test tests/contract/documentation-baseline.test.ts tests/e2e/application-cli.test.ts
FAIL: 10 tests / 2 failures
- 函数级：显式 WSSPEC_INTERNAL_ERROR 返回 internal credential=explicit-secret
- 真实 CLI：malformed JSON 返回 Unexpected token ... not valid JSON
```

最小修复后运行同一命令：

```text
PASS: 10 tests / 0 failures
```

## 完整验证

```text
node --import tsx --test tests/contract/documentation-baseline.test.ts tests/e2e/application-cli.test.ts
PASS: 10 tests / 0 failures

npm run lint
PASS

npm run typecheck
PASS

npm test
PASS: 307 tests / 0 failures，约 56.5s

npm run build
PASS

npm pack --dry-run --json
PASS: entryCount 203，packed 162381 bytes，unpacked 823836 bytes

git diff --check
PASS
```

Application 直接 API 独立探针：

```text
createApplication().start({})
SchemaValidationError / WSSPEC_SCHEMA_REQUIRED_FIELD / 缺少必填字段：root
```

## 验证边界

- 本轮验证覆盖 CLI JSON error adapter、真实 malformed JSON CLI 路径、public catalog/docs 合同、完整本地测试、构建和 npm 打包干跑。
- Application 直接 API 未新增错误映射，仍抛出原始异常；固定 internal 消息只应用于 CLI 输出边界。
- 未执行真实 Codex、Claude、Cursor 或 Generic Driver 宿主 Smoke，也未执行 GitHub、GitLab、飞书 Provider 的真实授权、写入与回读。
- 未执行 `npm publish`、远程推送、合并或生产发布。
