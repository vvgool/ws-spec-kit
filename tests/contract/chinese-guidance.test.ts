import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installDriverSkill } from "../../src/adapters/skills/install.js";

const root = path.resolve(import.meta.dirname, "../..");
const guidance = "面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。";

test("四类 Driver 使用同一条中文输出提示", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-guidance-home-"));

  for (const agent of ["codex", "claude", "cursor"] as const) {
    const result = await installDriverSkill({ agent, home });
    const content = await readFile(path.join(result.target, "SKILL.md"), "utf8");
    assert.match(content, new RegExp(guidance, "u"));
  }

  const generic = await installDriverSkill({
    agent: "generic",
    home,
    target: path.join(home, "generic-driver"),
  });
  const content = await readFile(path.join(generic.target, "SKILL.md"), "utf8");
  assert.match(content, new RegExp(guidance, "u"));
});

test("源码和 npm scripts 不再包含中文静态分析器", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal("check:chinese" in packageJson.scripts, false);
  await assert.rejects(access(path.join(root, "src/resources/chinese-content.ts")), /ENOENT/u);
  await assert.rejects(access(path.join(root, "scripts/check-chinese-content.ts")), /ENOENT/u);
});
