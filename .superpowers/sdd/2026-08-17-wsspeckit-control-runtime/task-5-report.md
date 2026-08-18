# Task 5 报告：可信 TDD Red/Green Evidence

## 范围

基线为 `1588e78`。本任务实现功能交付 Workflow 的可信 Red/Green Evidence、Review-Fix 复验链与 Close 校验，并关闭 Task 5 审查提出的八项可信边界缺口。未执行 Task 6 E2E、真实宿主验收、merge、push 或 publish。

## 实现

- 引擎只执行项目不可变配置快照中的固定 test Gate。`argv[0]` 先解析为绝对可执行文件，实际 spawn 使用该路径；命令身份同时绑定 Gate 配置、可执行路径/内容、有效继承环境和 reporter 源码摘要，Red/Green 任一漂移都会使 Evidence 失效。
- 首版 trusted runner 只支持当前 Node.js 的 `node:test`。引擎注入自有 reporter 与受控结果目标，按严格 `builtin.tdd-node-test-report.v1` 解析有界结果；明文 TAP、signal 终止、语法错误、依赖错误和无 assertion failure 均不能形成可信 Red。
- 超时先终止完整进程组，并等待引用中的 SIGKILL 清理完成后再返回；子进程不能在调用 CLI 退出后继续修改 workspace。
- Red/Green gate 执行前后重算 workspace 与测试清单。引擎管理的 `verify-red`、`verify-green` 和 Review-Fix `verify` Attempt 要求零文件修改，Agent 自报命令或 Evidence 被丢弃。
- 测试路径由配置快照的显式 `node/java/ruby/dotnet` 规则识别，不使用通用 glob；其中 Java/Ruby/.NET 目前仅为路径规则，不代表对应 runner adapter 已支持。
- 无 assertion、已 Green 或语法错误的 Red 在同一控制面事务中清除当前 TDD Cycle、释放 Claim，并重新 acquire `write-tests`；timeout、依赖缺失、signal 和启动失败转换为可信的可重试 Step failure，保留 Retry 预算与 Attempt 记录。
- `builtin.tdd-trusted-evidence.v1` 与 `builtin.tdd-cycle-evidence.v1` 进入公开 Schema。Close 会严格解析并重算 Evidence ID，核对 task、phase、command、测试路径/摘要/规则、Red/Green/Refactor 引用，并要求最后一份 Green workspace digest 等于 Close 当前 workspace。
- Review-Fix 修改生产文件时以同一 command 追加 Green/Refactor Evidence；修改测试时清除旧链并回到 `write-tests`。

## 审查项闭环

| 审查项 | 闭环证据 |
| --- | --- |
| 环境、PATH、可执行身份未绑定 | inherited env 与 PATH executable 漂移测试均拒绝 Green。 |
| verify Attempt 可先修改 workspace | Application submit 的 Red/Green 变更反例均返回 `WSSPEC_TDD_EVIDENCE_INVALIDATED`。 |
| Close 接受任意 `{}` | `{}` Red/Cycle 分别报告缺失；只有完整 Schema-valid 链可 Close。 |
| timeout 提前返回 | 强进程组测试在 CLI 退出后等待并确认 descendant 未写入 survivor 文件。 |
| signal 可伪造成 Red | signal 终止稳定返回 infrastructure failure。 |
| 明文 TAP 可伪造 assertion | forged `not ok` 输出没有结构化 assertion 时返回 report invalid。 |
| Node-only 路径启发式 | 路径规则显式覆盖 Node、Java、Ruby 与 .NET 默认布局。 |
| invalid Red 无恢复路径 | invalid Red 原子回 `write-tests`；dependency infrastructure failure 持久化 retryable Attempt。 |

## 最终验证

以下命令在当前候选树上串行执行：

| 门禁 | 结果 |
| --- | --- |
| `node --import tsx --test tests/integration/tdd-evidence.test.ts tests/integration/profile-runtime.test.ts tests/integration/recovery.test.ts` | PASS，42 passed，0 failed |
| Close/Repository/Schema/Application Protocol/Documentation 五文件矩阵 | PASS，50 passed，0 failed |
| `npm test` | PASS，427 passed，0 failed，0 skipped |
| `npm run lint` | PASS，exit 0 |
| `npm run typecheck` | PASS，exit 0 |
| `npm run build` | PASS，exit 0 |
| `npm run schemas:generate` 后 `tests/contract/schemas.test.ts` | PASS，8 passed，0 failed；检入 Schema 与生成定义一致 |
| `git diff --check` | PASS |

## 证据边界

- 上述证据证明当前 checkout 的本地 trusted `node:test` adapter、控制面恢复、Close 和公开 Schema 合同，不构成 Task 6 三 Profile E2E、真实 Codex/Claude/Cursor 宿主或生产验收。
- Java、Ruby 与 .NET 仅完成路径分类；可信 runner adapter 必须后续单独实现严格结构化 reporter，不能复用明文输出。
- 本任务未 merge、push、publish，也未执行外部 issue/knowledge 写入或回读。
