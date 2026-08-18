# WSSpecKit 中文输出提示实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除中文公开文案静态分析器和构建门禁，改由内置 Driver Skill 提示 Agent 默认使用中文。

**Architecture:** 中文要求属于 Agent 行为约定，由四类 Driver 共用的 Skill 正文承载。WSSpecKit 不分析 TypeScript 数据流，也不检查用户输入或用户自行安装的 Skill；构建恢复为纯编译，测试只验证发布包已移除扫描器且所有 Driver 安装产物包含同一提示。

**Tech Stack:** TypeScript 5、Node.js 22、Node test runner、npm pack。

## Global Constraints

- 面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。
- 不检查用户输入、Issue 标题、外部文档或用户安装的 Global/Project Skill 语言。
- 不保留中文静态分析器、执行脚本、npm 门禁或跨函数数据流测试。
- 不改变 Application Protocol、Schema ID、类型名、URI、错误码及 Driver 安装安全语义。
- 不执行 merge、push、publish，也不伪造真实 Codex/Claude/Cursor 宿主验收。

---

### Task 1：以 Driver 提示替代中文静态分析门禁

**Files:**
- Modify: `src/adapters/skills/install.ts`
- Modify: `tests/e2e/driver-install.test.ts`
- Create: `tests/contract/chinese-guidance.test.ts`
- Delete: `src/resources/chinese-content.ts`
- Delete: `scripts/check-chinese-content.ts`
- Delete: `tests/contract/chinese-content.test.ts`
- Modify: `package.json`
- Modify: `docs/superpowers/plans/2026-08-17-wsspeckit-foundation.md`

**Interfaces:**
- Consumes: `installDriverSkill(input: InstallDriverSkillInput): Promise<InstallDriverSkillResult>` 生成的四类 `SKILL.md`。
- Produces: Driver Skill 固定提示 `面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。`。
- Removes: `validateChineseContent()`、`scripts/check-chinese-content.ts` 和 `npm run check:chinese`。

- [ ] **Step 1：编写失败的 Driver 提示与发布面契约测试**

创建 `tests/contract/chinese-guidance.test.ts`，用临时 HOME 安装四类 Driver，并断言每份 `SKILL.md` 包含完全相同的提示；同时断言源码和 npm scripts 不再暴露扫描器。pack 文件清单在 build 后的完整发布门禁中验证，避免并行测试修改共享 `dist`。

```ts
const guidance = "面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。";

for (const agent of ["codex", "claude", "cursor"] as const) {
  const result = await installDriverSkill({ agent, home });
  assert.match(await readFile(path.join(result.target, "SKILL.md"), "utf8"), new RegExp(guidance));
}

const generic = await installDriverSkill({ agent: "generic", home, target: path.join(home, "generic-driver") });
assert.match(await readFile(path.join(generic.target, "SKILL.md"), "utf8"), new RegExp(guidance));

assert.equal("check:chinese" in packageJson.scripts, false);
await assert.rejects(access(path.join(root, "src/resources/chinese-content.ts")), /ENOENT/u);
await assert.rejects(access(path.join(root, "scripts/check-chinese-content.ts")), /ENOENT/u);
```

- [ ] **Step 2：运行契约测试并确认 RED**

运行：

```bash
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH node --import tsx --test tests/contract/chinese-guidance.test.ts
```

预期：FAIL；Driver 尚无固定提示，`check:chinese` script 和扫描器文件仍存在。

- [ ] **Step 3：删除静态分析器并加入 Driver 提示**

在 `src/adapters/skills/install.ts` 的共享 `body()` 中加入固定文本：

```ts
"面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。",
```

删除 `src/resources/chinese-content.ts`、`scripts/check-chinese-content.ts` 和 `tests/contract/chinese-content.test.ts`。从 `package.json` 删除 `check:chinese`，将 build 恢复为：

```json
"build": "rm -rf dist && tsc -p tsconfig.build.json"
```

- [ ] **Step 4：同步既有 Driver 安装测试和 Foundation 计划**

在 `tests/e2e/driver-install.test.ts` 的 Codex Driver 用例中增加：

```ts
assert.match(skill, /面向用户的说明、文档和交互文案默认使用中文/);
assert.match(skill, /协议字段、类型名、URI、命令名和错误码保持英文/);
```

更新 `docs/superpowers/plans/2026-08-17-wsspeckit-foundation.md`：

- Task 8 删除中文检查器文件、实现步骤和测试命令引用。
- Task 8 改为要求 Driver 包含上述固定提示。
- Task 8 基础门禁保留 lint、typecheck、test、build、pack。
- Task 9 删除 `tests/contract/chinese-content.test.ts` 的命令引用。
- 不改动“内置中文文档、CLI 和 Skill 保持中文”的产品要求。

- [ ] **Step 5：运行聚焦测试并确认 GREEN**

运行：

```bash
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH node --import tsx --test tests/contract/chinese-guidance.test.ts tests/e2e/driver-install.test.ts tests/e2e/application-cli.test.ts
```

预期：全部通过；四类 Driver 都包含固定提示，安装冲突和原子写入测试不回退。

- [ ] **Step 6：运行完整发布门禁**

运行：

```bash
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm run lint
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm test
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm run build
PATH=/Users/wiesenwang/.nvm/versions/node/v22.16.0/bin:$PATH npm pack --dry-run --json
```

预期：全部退出码为 0；pack 清单不包含 `chinese-content` 或 `check-chinese-content`；不声称真实宿主验收。

- [ ] **Step 7：提交并重新审查 Foundation Task 8**

```bash
git add package.json src/adapters/skills/install.ts tests/e2e/driver-install.test.ts tests/contract/chinese-guidance.test.ts docs/superpowers/plans/2026-08-17-wsspeckit-foundation.md
git add -u src/resources/chinese-content.ts scripts/check-chinese-content.ts tests/contract/chinese-content.test.ts
git commit -m "refactor: replace Chinese copy gate with driver guidance"
```

生成从 `3597aa5` 到新 HEAD 的 Task 8 完整 review package，独立复审 Task 8 的全部公开 CLI、Workflow、Driver 安装、Provider、信任和发布包契约。中文部分只检查 Driver 固定提示与扫描器已移除，不再要求静态证明任意 TypeScript 文案语言。
