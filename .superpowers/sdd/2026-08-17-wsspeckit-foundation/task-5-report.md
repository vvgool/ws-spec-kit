# Task 5 Skill Resolver 与 Skill Lock Report

## 状态

DONE

## RED 证据

首次创建 `tests/unit/skill-resolver.test.ts` 与 `tests/integration/skill-lock.test.ts` 后运行：

```sh
node --import tsx --test tests/unit/skill-resolver.test.ts tests/integration/skill-lock.test.ts
```

两组测试均以 `ERR_MODULE_NOT_FOUND` 失败，分别缺少
`src/registry/skills/resolver.js` 与 `src/registry/skills/lock.js`，确认失败原因是 Task 5 尚未实现。

GREEN 后继续观察并关闭三组边界 RED：

- Skill Lock 尚未使用设计稿的 `version + skills[]` 结构，且附加 Global 根错误接受任意相对路径。
- Package 加载后改写 Skill 辅助文件时，Resolver 曾返回旧摘要但指向新内容。
- Project Skill 链接到 `.wsspec/workflows` 时，曾因声明根过宽而被接受。

## 实现摘要

- 新增 Builtin、Package、Project、Global 四类显式 Resolver；URI 每段只接受小写字母、数字和连字符，不搜索同名替代来源。
- Builtin 使用正式 Catalog；Package 只接受当前 `WorkflowPackage` Manifest 与文件快照声明的 Skill；Project 固定在 `.wsspec/skills`。
- Global 固定 Codex、Claude、Cursor、Generic 默认根顺序，并在末尾追加绝对路径或 `~/...` 附加根；相同摘要候选按根顺序选择且保留诊断，不同摘要返回 `WSSPEC_SKILL_AMBIGUOUS`。
- 所有非 Package Skill 对完整 Skill 目录做可移植摘要；Package 复用 Task 4 正式摘要，并重新校验当前目录与加载快照一致，避免旧摘要执行新内容。
- 逐级执行 lexical + realpath containment；Project 越出 Skill 根、Package 跨包链接、悬空或越界链接均 fail closed。
- 可选缺失返回 `undefined`；必需缺失返回 `WSSPEC_SKILL_NOT_FOUND`；首版 fallback 仅允许 Global 显式回退到 Builtin。
- Skill Lock 使用 `version: 1` 与排序的 `skills[]`，记录逻辑引用、Provider、逻辑 rootId、摘要、候选和 fallback 摘要；不写 entrypoint、HOME 绝对路径或环境值。
- 既有锁与 Provider、绑定、解析来源或摘要不一致时返回 `WSSPEC_SKILL_LOCK_CHANGED`。

## 测试覆盖

- 四类来源、四种 Provider 默认根、附加根与根顺序。
- 必需/可选缺失、显式 fallback、锁定 fallback、主引用命中不替代。
- 相同摘要重复候选、不同摘要歧义、Global 内容漂移。
- 完整目录辅助文件变化、Package 安装位置移动摘要不变、加载后篡改。
- URI 词法逃逸、编码路径、Project 根逃逸、跨 Package 符号链接逃逸。
- Global Lock 序列化不包含临时 HOME、环境值或绝对 entrypoint。

## 验证结果

全部最终命令均在以下 PATH 下执行：

```sh
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH
```

- 聚焦测试：19 passed，0 failed，0 skipped。
- `npm run typecheck`：passed。
- `npm test`：174 passed，0 failed，0 skipped。
- `npm run build`：passed。
- `git diff --cached --check`：passed（无输出）。

首次完整测试曾因 shell 优先选中 `/usr/local/bin/npm` 6.14.8 而使既有
`package-install` E2E 无法识别 `--pack-destination`；将 Node 22 的 bin 放在 PATH 首位后，
同一 E2E 与完整套件通过，未修改该测试。

## 范围审计

- 仅新增 `src/registry/skills/{types,resolver,lock}.ts`、两份 Task 5 测试和本报告。
- 未修改、放宽或兼容 Task 4 的 `WorkflowPackage` 类型、loader、v1 parser、Catalog 或路径边界。
- 未实现 Task 6 compiler、Profile 或 Work Item 快照集成。

## Commit

独立提交信息：`feat: resolve and lock workflow skills`。

## 未解决项

无 Task 5 范围内已知未解决项。
