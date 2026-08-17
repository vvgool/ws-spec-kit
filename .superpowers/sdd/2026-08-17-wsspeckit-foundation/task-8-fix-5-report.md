# Task 8 修复第 5 轮报告

## 范围

- 修复基线：`8dee4b7 fix: resolve Chinese copy bindings by scope`。
- 目标：只关闭 `task-8-fix-4-rereview.md` 的 P1，即公开文案 sink 不得把不支持的表达式或控制流当作安全无文本。
- 本轮未开始 Task 9，未合并、推送、发布或写入真实宿主目录。

## 修复

1. `ResolvedText` 现在区分已创作文案、无法解析值、外部运行时数据和结构化值。未知调用或不支持的表达式进入公开文案 sink 时 fail closed；只有显式识别的运行时来源与标准转换可以免报，不能把任意未知调用伪装成安全空值。
2. 值流解析覆盖调用、局部 helper 返回、二元表达式、模板插值、属性访问、赋值、别名与解构。模板或拼接中的已创作英文字面量继续被定位；无法证明安全的动态部分产生 `无法安全解析公开文案` finding。
3. `switch` 分支按入口与 fallthrough 保守合并，循环仍使用最多 8 轮的不动点并在未收敛时标记 unresolved。`try/catch` 只合并可能正常到达后续语句的分支，避免已终止分支污染或掩盖真实值流。
4. Error sink 按构造器语义选择 message：原生 `Error` 家族使用第 1 个参数，`AggregateError` 使用第 2 个参数，项目 `*Error(code, message)` 使用第 2 个参数；options 不再被误当作公开 message。
5. 结构化 `summary` 容器本身不是字符串 sink，但内部 `message` 或字符串 `summary` 仍会递归检查。局部结构化值经过 `Object.*`、属性访问或本地 helper 时不会被错误标记为外部运行时数据。

## TDD 证据

- RED：调用表达式经变量流入 `completed(...)` 时，source/dist 结果均为 `findings: []`。GREEN：未知调用在两个路径都产生 unresolved finding。
- RED：二元拼接只产生 unresolved，模板中的未知调用插值被漏检；`switch` 分支与 fallthrough 赋值结果为 `findings: []`。GREEN：已创作英文和动态未解析部分分别被报告，分支英文赋值可达公开 sink。
- RED：`new Error(message, { cause })` 检查了 options 而不是 message。GREEN：原生与项目 Error 的 source/dist message 变量均按各自参数语义检查。
- RED：局部 helper 返回与结构化 summary 被错误归类；首次运行时豁免还可把本地对象经转换错误标记为 external。GREEN：新增本地结构化值防绕过回归后，这些路径要么定位已创作英文，要么 fail closed，真实外部运行时路径仍保持免报。

## 最终验证

以下命令均在本轮最终修改上执行并退出 0：

```text
npm run test:contract
PASS: 58 tests / 0 failures

npm run check:chinese
PASS: 真实仓库 findings 为 0

npm run lint
PASS

npm run typecheck
PASS

npm test
PASS: 315 tests / 0 failures

npm run build
PASS: 重建 dist，并完成 source/dist 中文内容检查

构建后 dist/resources/chinese-content.js 独立探针
PASS: 调用、二元拼接、switch、Error options 的 source/dist 反例均被阻断

npm pack --dry-run --json
PASS: entryCount 200, packed 170601 bytes, unpacked 875954 bytes

git diff --check
PASS
```

## 验收边界

- 已验证当前 worktree 的 source/dist 文案门禁、完整自动化测试、本地构建、构建产物反例和 npm 打包干跑。
- 未启动真实 Codex、Claude、Cursor 或 Generic Driver 宿主验证发现、自动触发或跨会话恢复；上述本地证据不等于生产环境验收。
- 未执行 Task 9、`npm publish`、远程推送、合并或生产环境写入。
