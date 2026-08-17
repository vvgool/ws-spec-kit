import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installDriverSkill } from "../../src/adapters/skills/install.js";

test("Codex Driver 安装只写入临时 HOME 的官方目录，并包含中文执行循环", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
  const result = await installDriverSkill({ agent: "codex", home });
  assert.equal(result.target, path.join(home, ".agents", "skills", "wsspeckit-driver"));
  const skill = await readFile(path.join(result.target, "SKILL.md"), "utf8");
  assert.match(skill, /新任务判断功能\/文档 Workflow/);
  assert.match(skill, /已有任务 inspect -> acquire/);
  await assert.rejects(access(path.join(home, ".cursor", "rules", "wsspeckit-driver.mdc")), /ENOENT/);
});

test("Driver 安装 dry-run 不创建目录，Generic 必须提供显式目标", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
  const preview = await installDriverSkill({ agent: "claude", home, dryRun: true });
  await assert.rejects(access(preview.target), /ENOENT/);
  await assert.rejects(installDriverSkill({ agent: "generic", home }), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_ARGUMENT_REQUIRED");
});
