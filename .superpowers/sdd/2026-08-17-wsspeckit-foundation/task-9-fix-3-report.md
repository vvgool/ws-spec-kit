# Foundation Task 9 修复第 3 轮报告

## 范围

- 基线：`f3c7379`（`docs: align public protocol contracts`）。
- 本轮将 Application public error catalog 绑定到 CLI JSON 输出边界，并修复 catalog 与公开参考的双向漂移。
- 未修改 Application API 的异常实现；未开始 Runtime，未合并、推送或发布。

## 修复闭环

| 复审项 | 修复与证据 |
| --- | --- |
| catalog 没有生产约束 | `applicationPublicErrorCodes` 定义 public code 的 readonly tuple，`isApplicationPublicErrorCode` 使用只读查询集合。`errorOutput` 仅透传 guard 命中的 code。 |
| 内部错误原样泄露 | 未注册 `WSSPEC_*`、其他带 code 异常及无 code 异常统一返回 `WSSPEC_INTERNAL_ERROR` 和固定中文消息“发生未预期的内部错误。”；已注册 code 保留原 code 和消息。 |
| 17 个可达诊断遗漏 | catalog 与 Application Protocol 参考补齐复审确认的 snapshot、approval、builtin catalog、source、Workflow Package 和 trust store 17 项诊断。 |
| catalog/docs 单向检查 | 合同测试提取四份公开参考的错误码并与 catalog 双向集合相等；删除 catalog 项对应文档 code 或加入多余 code 的变异均被拒绝。 |

## 验证

```text
node --import tsx --test tests/contract/documentation-baseline.test.ts tests/contract/requirements-traceability.test.ts
PASS: 8 tests / 0 failures

npm run lint
PASS

npm run typecheck
PASS

npm test
PASS: 305 tests / 0 failures，约 56.9s

npm run build
PASS

npm pack --dry-run --json
PASS: entryCount 203，packed 162245 bytes，unpacked 823469 bytes

git diff --check
PASS
```

## 验证边界

- 本轮验证覆盖公开 CLI JSON error adapter、文档合同、完整本地测试、构建和 npm 打包干跑。
- Application 直接 API 未新增错误映射，仍抛出原始异常；本轮收敛仅适用于 CLI 公开输出。
- 未执行真实 Codex、Claude、Cursor 或 Generic Driver 宿主 Smoke，也未执行 GitHub、GitLab、飞书 Provider 的真实授权、写入与回读。
- 未执行 `npm publish`、远程推送、合并或生产发布。
