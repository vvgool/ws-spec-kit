import assert from "node:assert/strict";
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSkillLock } from "../../src/registry/skills/lock.js";
import { resolveSkill } from "../../src/registry/skills/resolver.js";
import type { SkillResolverContext } from "../../src/registry/skills/types.js";
import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";

async function temporaryRoot(): Promise<string> {
  return path.join(os.tmpdir(), `wspec-skill-lock-${crypto.randomUUID()}`);
}

async function writeSkill(root: string, relative: string, files: Record<string, string>): Promise<string> {
  const directory = path.join(root, ...relative.split("/"));
  for (const [filename, contents] of Object.entries(files)) {
    const target = path.join(directory, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return directory;
}

async function packageFixture(projectRoot: string, id = "fixture"): Promise<string> {
  const directory = path.join(projectRoot, ".wsspec", "workflows", id);
  await mkdir(path.join(directory, "skills", "review", "references"), { recursive: true });
  await writeFile(path.join(directory, "manifest.yaml"), `version: 1\nid: ${id}\nentry: workflow.yaml\nprofiles: []\nskills: [review]\n`);
  await writeFile(path.join(directory, "workflow.yaml"), `version: 1\nworkflow: { id: ${id}, version: 1 }\ninputs: {}\nsteps:\n  - id: review\n    uses: agent.execute\n    skills: [{ ref: package://skills/review, required: true }]\ngates: []\n`);
  await writeFile(path.join(directory, "skills", "review", "SKILL.md"), "# Review\n");
  await writeFile(path.join(directory, "skills", "review", "references", "policy.md"), "policy\n");
  return directory;
}

test("完整 Skill 目录任一辅助文件变化都会改变摘要", async () => {
  const root = await temporaryRoot();
  const skill = await writeSkill(path.join(root, ".wsspec"), "skills/review", {
    "SKILL.md": "# Review\n",
    "references/policy.md": "first\n",
  });
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const resolverContext: SkillResolverContext = { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg };

  const first = await resolveSkill({ ref: "project://skills/review", required: true }, resolverContext);
  await writeFile(path.join(skill, "references", "policy.md"), "second\n");
  const second = await resolveSkill({ ref: "project://skills/review", required: true }, resolverContext);

  assert.notEqual(second?.digest, first?.digest);
});

test("显式 fallback 被解析和锁定，主引用命中时不替代它", async () => {
  const root = await temporaryRoot();
  const packageRoot = await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const resolverContext: SkillResolverContext = { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg };
  const binding = { ref: "global://vendor/tdd", fallback: "builtin://skills/tdd-implementation", required: true } as const;

  const fallback = await resolveSkill(binding, resolverContext);
  assert.equal(fallback?.usedFallback, true);
  assert.equal(fallback?.requestedRef, "global://vendor/tdd");
  assert.equal(fallback?.ref, "builtin://skills/tdd-implementation");
  const fallbackLock = createSkillLock(fallback!);
  assert.equal(fallbackLock.version, 1);
  assert.equal(fallbackLock.skills[0]?.requested, "global://vendor/tdd");
  assert.equal(fallbackLock.skills[0]?.resolved, "builtin://skills/tdd-implementation");
  assert.equal(fallbackLock.skills[0]?.fallback, "builtin://skills/tdd-implementation");
  assert.equal(fallbackLock.skills[0]?.fallbackDigest, fallback?.digest);

  await writeSkill(path.join(root, "global"), "vendor/tdd", { "SKILL.md": "# Global\n" });
  resolverContext.additionalGlobalRoots = [path.join(root, "global")];
  const primary = await resolveSkill(binding, resolverContext);
  assert.equal(primary?.usedFallback, false);
  assert.equal(primary?.ref, "global://vendor/tdd");
  assert.equal(primary?.fallback?.ref, "builtin://skills/tdd-implementation");
});

test("必需 Global Skill 摘要偏离已有锁时返回 WSSPEC_SKILL_LOCK_CHANGED", async () => {
  const root = await temporaryRoot();
  const globalRoot = path.join(root, "global");
  const directory = await writeSkill(globalRoot, "vendor/tdd", { "SKILL.md": "# First\n" });
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const resolverContext: SkillResolverContext = { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg, additionalGlobalRoots: [globalRoot] };
  const binding = { ref: "global://vendor/tdd", required: true } as const;
  const first = await resolveSkill(binding, resolverContext);
  resolverContext.lock = createSkillLock(first!);

  await writeFile(path.join(directory, "SKILL.md"), "# Changed\n");

  await assert.rejects(resolveSkill(binding, resolverContext), /WSSPEC_SKILL_LOCK_CHANGED/);
});

test("缺失 Global 只能使用 Workflow 声明且与既有锁一致的 fallback", async () => {
  const root = await temporaryRoot();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const resolverContext: SkillResolverContext = { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg };
  const binding = { ref: "global://vendor/tdd", fallback: "builtin://skills/tdd-implementation", required: true } as const;
  const first = await resolveSkill(binding, resolverContext);
  resolverContext.lock = createSkillLock(first!);

  const resumed = await resolveSkill(binding, resolverContext);
  assert.equal(resumed?.usedFallback, true);

  await assert.rejects(
    resolveSkill({ ...binding, fallback: "builtin://skills/code-review" }, resolverContext),
    /WSSPEC_SKILL_LOCK_CHANGED/,
  );
});

test("Package 从 Builtin 位置移动到 Project 位置后 Skill 摘要不变", async () => {
  const sourceRoot = await temporaryRoot();
  const source = await packageFixture(sourceRoot, "portable");
  const firstPackage = await loadWorkflowPackage({ root: sourceRoot, ref: "project://workflows/portable" });
  const first = await resolveSkill({ ref: "package://skills/review", required: true }, { provider: "codex", projectRoot: sourceRoot, home: path.join(sourceRoot, "home"), package: firstPackage });

  const targetRoot = await temporaryRoot();
  const target = path.join(targetRoot, ".wsspec", "workflows", "portable");
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  const secondPackage = await loadWorkflowPackage({ root: targetRoot, ref: "project://workflows/portable" });
  const second = await resolveSkill({ ref: "package://skills/review", required: true }, { provider: "codex", projectRoot: targetRoot, home: path.join(targetRoot, "home"), package: secondPackage });

  assert.equal(second?.digest, first?.digest);
  assert.equal(second?.ref, first?.ref);
  assert.notEqual(second?.entrypoint, first?.entrypoint);
});

test("Package 加载后 Skill 目录被改写时不得以旧摘要执行新内容", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root, "immutable");
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/immutable" });
  await writeFile(path.join(directory, "skills", "review", "references", "policy.md"), "changed after load\n");

  await assert.rejects(
    resolveSkill(
      { ref: "package://skills/review", required: true },
      { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg },
    ),
    /WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID/,
  );
});

test("Package Skill 加载后被跨 Package 符号链接替换时 fail closed", async (t) => {
  const root = await temporaryRoot();
  const source = await packageFixture(root, "source");
  const target = await packageFixture(root, "target");
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/source" });
  await rm(path.join(source, "skills", "review"), { recursive: true });
  try {
    await symlink(path.join(target, "skills", "review"), path.join(source, "skills", "review"));
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "EPERM") return t.skip("当前文件系统不支持符号链接");
    throw caught;
  }

  await assert.rejects(
    resolveSkill(
      { ref: "package://skills/review", required: true },
      { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg },
    ),
    /WSSPEC_SKILL_PATH_ESCAPE/,
  );
});

test("Global Lock 仅保留逻辑来源和摘要，不泄露 HOME 或环境值", async () => {
  const root = await temporaryRoot();
  const home = path.join(root, "secret-home-value");
  await writeSkill(path.join(home, ".agents", "skills"), "vendor/tdd", { "SKILL.md": "# Global\n" });
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const resolved = await resolveSkill({ ref: "global://vendor/tdd", required: true }, { provider: "codex", projectRoot: root, home, package: pkg });

  const serialized = JSON.stringify(createSkillLock(resolved!));
  assert.equal(serialized.includes(home), false);
  assert.equal(serialized.includes("secret-home-value"), false);
  assert.equal(serialized.includes(resolved!.entrypoint), false);
  assert.match(serialized, /global:\/\/vendor\/tdd/);
});
