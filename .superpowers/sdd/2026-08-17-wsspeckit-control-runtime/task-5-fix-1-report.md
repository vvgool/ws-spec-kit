# Task 5 修复轮 1 报告

## 结论

- 两个 Important finding 已修复。
- 范围仅限 Task 5 trusted TDD Gate 与 submit 状态恢复；未进入 Task 6。
- 本轮未执行 merge、push、publish、真实宿主或生产验收。

## RED 证据

先新增稳定失败测试，再修改生产实现：

1. 固定 Gate 同时包含目标 assertion 与非目标 syntax/dependency 时，旧实现仍签发 trusted Red；两个子场景均复现 `Missing expected rejection`。
2. 产生 101 个 assertion failure 时，旧 reporter 静默保留前 100 条并签发 trusted Red；复现 `Missing expected rejection`。
3. Green assertion、timeout 与 workspace drift 的 Application 状态测试随后覆盖 Claim、Stage、Retry、Context、Evidence、重复 submit 和事件恢复。

## 修复内容

### Reporter 与 Gate

- node:test reporter 新增 `failureTotal` 和 `truncated`。
- 报告 Schema 同步要求这两个聚合字段，生成公开 JSON Schema。
- Gate 在按本轮 testPaths 筛 assertion 前，先检查固定命令的全局 failure：
  - syntax 拒绝为 Red syntax failure；
  - dependency/other 拒绝为 infrastructure failure；
  - failure 列表截断或聚合不一致时以 report invalid fail closed。
- 只有全局报告可信后，才允许目标测试路径中的 assertion failure 形成 Red Evidence。

### 原子状态转换

- 建立 `TddVerificationCode` 完整集合与穷尽分类函数；未知 VerificationError 默认 fail closed。
- Red 可修复输入返回 `write-tests`，并清理旧 Cycle/Claim/Context/Retry/Evidence。
- 顶层 Green 未通过返回 `implement`；保留 Red，清理 Green/Cycle/Review-Fix 状态。
- Review-Fix verify 未通过进入内部 retry 分类。
- timeout、signal、dependency、start、report 等基础设施结果持久化 retryable failed Attempt。
- evidence/workspace/path/config 漂移持久化非重试 failed Attempt，原子释放 Claim、清理 Retry，返回稳定 blocked action。
- 重复 submit 复用原事件结果；事件恢复按中断 Attempt 规则恢复 Claim/Stage/Retry，同时保留 Evidence。

## 验证

- 聚焦 TDD：`20/20`。
- 聚焦 TDD + Schema：`28/28`。
- 相关矩阵（TDD/Profile/Recovery/Retry/Review-Fix/Close/Repository/Schema/Protocol）：`100/100`。
- 全量 `npm test`：`433/433`。
- `npm run lint`：通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run schemas:generate`：无额外漂移。
- `git diff --check`：通过。

## Concerns

- trusted runner 仍按 Task 5 既定边界仅支持当前 Node.js `node:test`；Java/Ruby/.NET 仍只有路径分类。
- 本地门禁不能替代 Task 6 的真实宿主、跨环境或生产验收。
