# Task 6 Workflow Compiler 与风险 Profile Report

## 状态

DONE

## RED 证据

首次替换旧固定 Stage compiler 前运行：

```sh
node --import tsx --test tests/unit/compiler.test.ts tests/unit/profile-policy.test.ts
```

测试因缺少 `resolveChangePolicy`、Profile/Risk 模块和正式 Step Manifest 编译接口而失败，证明旧 compiler 不满足 Task 6 协议。

实现过程中继续形成并观察了以下定向 RED：

- `verify-red` 可绕过 `write-tests`。
- Quick 可关闭嵌套 Review Step。
- Profile identity 可与 Package map key 不一致。
- 嵌套 DAG、disabled producer 和未来/不可达表达式未被拒绝。
- Manifest 可漏报 Executor capability、Connector 和 external side effect。
- Standard/Governed 可降低审批、Review、发布和审计强度。
- 自定义文档 glob 可用更宽的 wildcard 伪装成收窄。
- 文档风险规则返回功能 Workflow 的 `verify-green`。
- legacy `new/new-file` 丢失创建 Work Item 前的完整语义预检与稳定错误码。
- Profile 修复曾误禁 Documentation/Project Workflow 的合法可选 Step。
- Builtin Standard/Governed 可同时把 Review-Fix 上限提高到 6 以上。

reviewer 第一轮补强测试时，focused 为 29 passed / 4 failed；加入授权与未选中 Profile 用例后为 21 passed / 5 failed。最终三个复审 probe 在修复前分别复现联合 Profile 降级、legacy 语义漏检和合法 optional Step 被拒绝。

## 实现摘要

- 用 `compileWorkflow(pkg, profile)` 替换旧 `compileWorkflow(workflow, config)`，输出正式 `CompiledWorkflow`、递归 `CompiledStep`、Resolved Skill、Profile 和 Change Policy；没有保留旧协议 overload。
- Executor Registry 唯一决定 `securityClass`、capability、Connector、副作用和 `authorizationRequired`；Workflow/Profile/Skill 均不能伪造或扩大。
- 编译器递归校验 Step ID、局部 DAG、依赖、Artifact producer、disabled producer、Gate、有限表达式属性/类型与执行可达性。
- 每个 Package Profile 均完整编译；通用策略保证 `quick <= standard <= governed` 单调性，同时允许低强度 Profile 关闭非内核可选 Step。
- 两个 canonical Builtin URI 额外执行绝对 Profile 矩阵：Quick compact plan 与 1 轮 Review，Standard/Governed 5 轮上限，Governed 独立 Review、发布回读和 complete/extended 审计均不可协同降级。
- Feature Workflow 固定可信 TDD 链 `write-tests -> verify-red -> implement -> verify-green`，`implement` 必须消费 `tasks`；Quick 只跳过独立 `design`。
- Documentation Change Policy 默认五类安全路径；项目只能以相同 glob 或可证明匹配的具体路径收窄，无法证明的 wildcard 子集 fail closed。
- 风险规则读取 Issue 标签、需求风险、受影响/实际修改路径、文件类型和计划动作；自动 Profile 只允许单向升级，documentation-only 使用文档 Step 失效集合。
- 两个 Builtin Manifest 补齐实际 capability、Connector 与 external side effect 声明。
- 仍公开的 legacy `new/new-file` 在 `createWorkItem()` 前执行独立完整 preflight，恢复旧 Artifact、审批、Review/required Gate、Verify-before-Close 语义和稳定 `code/path`；该 validator 不属于正式 compiler 协议。

## 测试覆盖

- 正常编译、Registry-owned security/authorization、Resolved Skill 和递归 control Step。
- 重复 ID、未知依赖、循环、未知 Executor/action 和安全类别伪造。
- 必需 Skill 缺失、Skill/Profile 范围扩大与 Profile 禁止字段。
- Artifact 缺少生产者、生产者 disabled、嵌套 sibling producer。
- 表达式非法语法、未知 root/property、未来/不可达/disabled 输出和类型不匹配。
- Manifest capability、Connector、副作用漏报。
- TDD Red/Green 内核、Quick compact plan、Builtin 绝对 Profile 矩阵与跨 Profile 单调性。
- Documentation/Project optional Step 合法禁用正例。
- 文档路径默认值、非法/越界/生产代码路径、glob 扩大反例。
- 风险六类确定性信号、未知风险、文档 Workflow Step 映射和自定义规则。
- legacy duplicate/dependency/Executor、Artifact、审批、Review、Gate 和 Close 语义错误码。

## 独立 Review

第一次 review 为 Ready: No，报告 1 个 Critical 和 5 个 Important：Profile 降级、Manifest 漏报、glob 扩大、表达式不可达、legacy 预检回归和文档风险 Step 错配。

第一次修复复审仍为 Ready: No，剩余 C1/I1/N1：Builtin 绝对矩阵可协同降级、legacy 预检不完整、合法 Profile disabled 被误禁。第二轮按 probe 修复后，reviewer 又发现 Builtin Review-Fix 的“最多 5 轮”不能按一般单调值处理，已补 RED 并固定为恰好 5。

最终独立复审：

- Ready: Yes
- Spec compliance: PASS（限 Task 6）
- Code quality: PASS
- Critical/Important open finding: 0
- 报告：`task-6-re-review.md`

## 最终验证

全部命令均使用：

```sh
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH
node --version  # v22.16.0
npm --version   # 10.9.2
```

- focused compiler/profile：35 passed，0 failed。
- compiler/profile/schema/Builtin/loader：79 passed，0 failed。
- `npm run typecheck`：passed。
- `npm test`：208 passed，0 failed，0 skipped。
- `npm run build`：passed。
- `npm run schemas:generate`：passed；`git diff --exit-code -- schemas` 无差异。
- `git diff --check`：passed（无输出）。
- packed CLI clean-consumer 安装测试包含在完整套件中并通过。

## 范围边界

- 本报告证明 Task 6 compiler/Profile/Change Policy/risk policy 及 legacy public-command preflight 在当前工作树内通过。
- 正式 Runtime 接入、Work Item 新协议快照、真实 Connector 写入和生产发布不在 Task 6 范围内；本结论不等同于完整产品或生产 GO。

## Commit

提交信息：`feat: compile workflows with risk profiles`。

## 未解决项

无 Task 6 范围内已知 Critical 或 Important open finding。
