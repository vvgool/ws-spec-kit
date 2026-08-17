# Task 8 修复第 4 轮报告

## 范围

- 修复基线：`8a34aa3 fix: close Task 8 round 3 findings`。
- 目标：只关闭 `task-8-fix-3-rereview.md` 的 P1：公开文案 sink 不得按整文件变量名 Map 解析，必须跟踪使用点的真实词法绑定与值流。
- 本轮未开始 Task 9，未合并、推送、发布或写入真实宿主目录。

## 修复

1. 每个 source/dist 虚拟文件建立 TypeScript `Program` 和 `TypeChecker`，以 `Symbol` 而非 identifier 文本作为绑定键；shorthand 属性显式使用 value symbol，不把属性 symbol 误当变量 symbol。
2. 按语句执行顺序维护 `Symbol -> ResolvedText`，声明初始化、声明后赋值、多段别名链都传播原字面量位置；函数、嵌套块中的同名变量因 symbol 不同而隔离。
3. `if`/`try` 分支保守合并可能到达值，循环以有界不动点传播并在不收敛时 fail closed；别名环、无绑定或无安全到达值的公开 identifier 输出 `无法安全解析公开文案：<expression>` finding。
4. `completed(...)` 只将第 3 个参数作为实际公开 message sink；`workItemId`、status、`WSSPEC_*` 与 URI 等结构化协议标识不进入未解析文案报告。

## TDD 证据

- RED：新增不同函数/嵌套块同名、声明后赋值与别名链、别名环/fail-closed 三个 source+dist 用例；在 `8a34aa3` 旧实现上均失败，实际 findings 为 `[]`。
- GREEN：实现 symbol 与顺序值流后，上述用例与真实仓库扫描通过。
- 循环 mutation RED：暂时禁用循环传播后，`公开文案保守合并循环中可能到达的赋值` 失败，source 实际 findings 为 `[]`；恢复后 source/dist 都精确报告循环体英文赋值。

## 最终验证

以下命令均在本轮最终修改上执行并退出 0：

```text
node --import tsx --test tests/contract/chinese-content.test.ts
PASS: 13 tests / 0 failures

npm run check:chinese
PASS

npm run lint
PASS

npm run typecheck
PASS

npm test
PASS: 308 tests / 0 failures

npm run build
PASS: 重建 dist，并完成 source/dist 中文内容检查

npm pack --dry-run --json
PASS: entryCount 200, packed 166859 bytes, unpacked 853589 bytes

git diff --check
PASS
```

## 验收边界

- 已验证静态 source/dist 文案门禁、真实仓库扫描、完整自动化测试、本地构建和 npm 打包干跑。
- 未执行 `npm publish`、远程推送、合并或生产环境验收。
