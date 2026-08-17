# Task 4 Breaker Remediation Report

## 状态

DONE

## RED 证据

在 `PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH` 下，先运行：

```sh
node --import tsx --test tests/contract/builtin-resources.test.ts
```

生产代码修改前共观察到 10 个预期失败：

- `catalog.yaml`、`workflow.yaml`、`profiles/standard.yaml` 三类叶子文件的现存外链均被接受。
- 同三类叶子文件的悬空外链均只返回原始 `ENOENT`，没有稳定 Builtin 路径错误码。
- Catalog ref/目录与 Workflow id、Profile 文件名与 Profile id、Profile workflow 与当前 Workflow id 三类错配均被接受。

## 修复摘要

- `loadBuiltinCatalog()` 在使用 `catalog.yaml`、每个 `workflow.yaml`、每个 Profile YAML 及每个 Skill `SKILL.md` 入口前，统一以 canonical resources root 调用共享 `assertContainedPath()`。
- 叶子真实路径越界与悬空符号链接统一 fail closed，错误码为 `WSSPEC_BUILTIN_RESOURCE_PATH_ESCAPE`；词法越界继续使用 `WSSPEC_BUILTIN_RESOURCE_PATH_INVALID`。
- Catalog ref/目录 id 与 `workflow.workflow.id` 不一致时返回 `WSSPEC_BUILTIN_WORKFLOW_ID_MISMATCH`。
- Profile 文件名与 `profile.profile.id` 不一致时返回 `WSSPEC_BUILTIN_PROFILE_ID_MISMATCH`。
- `profile.profile.workflow` 与当前 Workflow id 不一致时返回 `WSSPEC_BUILTIN_PROFILE_WORKFLOW_MISMATCH`。
- 保留现有严格 Workflow/Profile v1 parser 与 Schema，不加入兼容或迁移逻辑。

## 测试覆盖

- 三类叶子 YAML x 现存/悬空外链，共 6 个真实文件系统子测试。
- 三类跨文件身份错配各 1 个稳定错误码测试。
- 现有正式内置 Catalog、两个 Workflow、六个 Profile 和 Skill 正向资源测试继续通过。

## 验证结果

全部命令均在 Node `v22.16.0` PATH 下执行：

- 聚焦测试：16 passed，0 failed，0 skipped。
- `npm run typecheck`：passed。
- `npm test`：155 passed，0 failed，0 skipped。
- `npm run build`：passed。
- `git diff --check`：passed（无输出）。

## 范围审计

- 仅修改 Builtin Catalog loader、对应 contract test 和本报告。
- 未放宽 Schema，未修改共享 v1 parser、Project loader 或 Task 5+。
- 未加入旧格式兼容或迁移读取。

## Commit

独立提交信息：`fix: bind builtin workflow catalog identities`。

## 未解决项

无已知未解决项。
