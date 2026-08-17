import assert from "node:assert/strict";
import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as skillLockModule from "../../src/registry/skills/lock.js";
import { resolveSkill } from "../../src/registry/skills/resolver.js";
import type { ResolvedSkill, SkillLock, SkillResolverContext } from "../../src/registry/skills/types.js";
import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";

const { createSkillLock } = skillLockModule;

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
  const resolverContext: SkillResolverContext = { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg, stepStatus: "not_started" };

  const first = await resolveSkill({ ref: "project://skills/review", required: true }, resolverContext);
  await writeFile(path.join(skill, "references", "policy.md"), "second\n");
  const second = await resolveSkill({ ref: "project://skills/review", required: true }, resolverContext);

  assert.notEqual(second?.digest, first?.digest);
});

test("显式 fallback 被解析和锁定，主引用命中时不替代它", async () => {
  const root = await temporaryRoot();
  const packageRoot = await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const resolverContext: SkillResolverContext = { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg, stepStatus: "not_started" };
  const binding = { ref: "global://vendor/tdd", fallback: "builtin://skills/tdd-implementation", required: true } as const;

  const fallback = await resolveSkill(binding, resolverContext);
  assert.equal(fallback?.usedFallback, true);
  assert.equal(fallback?.requestedRef, "global://vendor/tdd");
  assert.equal(fallback?.ref, "builtin://skills/tdd-implementation");
  const fallbackLock = createSkillLock(fallback!);
  assert.equal(fallbackLock.version, 1);
  assert.equal(fallbackLock.skills[0]?.requested, "global://vendor/tdd");
  assert.equal(fallbackLock.skills[0]?.resolved, "global://vendor/tdd");
  assert.equal(fallbackLock.skills[0]?.fallback?.ref, "builtin://skills/tdd-implementation");
  assert.equal(fallbackLock.skills[0]?.fallback?.digest, fallback?.digest);

  await writeSkill(path.join(root, "global"), "vendor/tdd", { "SKILL.md": "# Global\n" });
  resolverContext.additionalGlobalRoots = [path.join(root, "global")];
  const primary = await resolveSkill(binding, resolverContext);
  assert.equal(primary?.usedFallback, false);
  assert.equal(primary?.ref, "global://vendor/tdd");
  assert.equal(primary?.fallback?.ref, "builtin://skills/tdd-implementation");
});

test("主项命中时仍拒绝无法解析的显式 fallback", async () => {
  const root = await temporaryRoot();
  const globalRoot = path.join(root, "global");
  await writeSkill(globalRoot, "vendor/tdd", { "SKILL.md": "# Global\n" });
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });

  await assert.rejects(
    resolveSkill(
      { ref: "global://vendor/tdd", fallback: "builtin://skills/not-installed", required: true },
      {
        provider: "generic",
        projectRoot: root,
        home: path.join(root, "home"),
        package: pkg,
        additionalGlobalRoots: [globalRoot],
        stepStatus: "not_started",
      },
    ),
    /WSSPEC_SKILL_NOT_FOUND/,
  );
});

test("必需 Global Skill 摘要偏离已有锁时返回 WSSPEC_SKILL_LOCK_CHANGED", async () => {
  const root = await temporaryRoot();
  const globalRoot = path.join(root, "global");
  const directory = await writeSkill(globalRoot, "vendor/tdd", { "SKILL.md": "# First\n" });
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const resolverContext: SkillResolverContext = { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg, stepStatus: "not_started", additionalGlobalRoots: [globalRoot] };
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
  const resolverContext: SkillResolverContext = { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg, stepStatus: "not_started" };
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

test("已开始 Step 没有既有 Lock 时不得首次选择 fallback", async () => {
  const root = await temporaryRoot();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const binding = { ref: "global://vendor/tdd", fallback: "builtin://skills/tdd-implementation", required: true } as const;
  const resolverContext: SkillResolverContext = {
    provider: "generic",
    projectRoot: root,
    home: path.join(root, "home"),
    package: pkg,
    stepStatus: "started",
  };

  await assert.rejects(
    resolveSkill(binding, resolverContext),
    /WSSPEC_SKILL_LOCK_CHANGED/,
  );

  const fallback = await resolveSkill(binding, { ...resolverContext, stepStatus: "not_started" });
  const resumed = await resolveSkill(binding, { ...resolverContext, lock: createSkillLock(fallback!) });
  assert.equal(resumed?.usedFallback, true);
});

test("Package 从 Builtin 位置移动到 Project 位置后 Skill 摘要不变", async () => {
  const sourceRoot = await temporaryRoot();
  const source = await packageFixture(sourceRoot, "portable");
  const firstPackage = await loadWorkflowPackage({ root: sourceRoot, ref: "project://workflows/portable" });
  const first = await resolveSkill({ ref: "package://skills/review", required: true }, { provider: "codex", projectRoot: sourceRoot, home: path.join(sourceRoot, "home"), package: firstPackage, stepStatus: "not_started" });

  const targetRoot = await temporaryRoot();
  const target = path.join(targetRoot, ".wsspec", "workflows", "portable");
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  const secondPackage = await loadWorkflowPackage({ root: targetRoot, ref: "project://workflows/portable" });
  const second = await resolveSkill({ ref: "package://skills/review", required: true }, { provider: "codex", projectRoot: targetRoot, home: path.join(targetRoot, "home"), package: secondPackage, stepStatus: "not_started" });

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
      { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg, stepStatus: "not_started" },
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
      { provider: "generic", projectRoot: root, home: path.join(root, "home"), package: pkg, stepStatus: "not_started" },
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
  const resolved = await resolveSkill({ ref: "global://vendor/tdd", required: true }, { provider: "codex", projectRoot: root, home, package: pkg, stepStatus: "not_started" });

  const serialized = JSON.stringify(createSkillLock(resolved!));
  assert.equal(serialized.includes(home), false);
  assert.equal(serialized.includes("secret-home-value"), false);
  assert.equal(serialized.includes(resolved!.entrypoint), false);
  assert.match(serialized, /global:\/\/vendor\/tdd/);
});

test("已锁主项消失后仅允许未开始 Step 切到完全匹配的已锁 fallback", async () => {
  const root = await temporaryRoot();
  const globalRoot = path.join(root, "global");
  await writeSkill(globalRoot, "vendor/tdd", { "SKILL.md": "# Global\n" });
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const binding = { ref: "global://vendor/tdd", fallback: "builtin://skills/tdd-implementation", required: true } as const;
  const resolverContext: SkillResolverContext = {
    provider: "generic",
    projectRoot: root,
    home: path.join(root, "home"),
    package: pkg,
    additionalGlobalRoots: [globalRoot],
    stepStatus: "not_started",
  };
  const primary = await resolveSkill(binding, resolverContext);
  const lock = createSkillLock(primary!);
  resolverContext.lock = lock;
  await rm(globalRoot, { recursive: true });

  const fallback = await resolveSkill(binding, resolverContext);
  assert.equal(fallback?.usedFallback, true);
  assert.equal(fallback?.ref, binding.fallback);
  const relocked = createSkillLock(fallback!);
  assert.equal(relocked.skills[0]?.resolved, binding.ref);
  assert.equal(relocked.skills[0]?.digest, lock.skills[0]?.digest);
  assert.deepEqual(relocked.skills[0]?.candidates, lock.skills[0]?.candidates);

  await assert.rejects(
    resolveSkill(binding, { ...resolverContext, stepStatus: "started" }),
    /WSSPEC_SKILL_LOCK_CHANGED/,
  );
});

test("主项命中时仍拒绝 fallback 声明或锁定摘要漂移", async () => {
  const root = await temporaryRoot();
  const globalRoot = path.join(root, "global");
  await writeSkill(globalRoot, "vendor/tdd", { "SKILL.md": "# Global\n" });
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const binding = { ref: "global://vendor/tdd", fallback: "builtin://skills/tdd-implementation", required: true } as const;
  const resolverContext: SkillResolverContext = {
    provider: "generic",
    projectRoot: root,
    home: path.join(root, "home"),
    package: pkg,
    additionalGlobalRoots: [globalRoot],
    stepStatus: "not_started",
  };
  const primary = await resolveSkill(binding, resolverContext);
  const lock = createSkillLock(primary!);

  await assert.rejects(
    resolveSkill({ ...binding, fallback: "builtin://skills/code-review" }, { ...resolverContext, lock }),
    /WSSPEC_SKILL_LOCK_CHANGED/,
  );

  const changedDigest = structuredClone(lock) as SkillLock;
  assert.ok(changedDigest.skills[0]?.fallback);
  changedDigest.skills[0]!.fallback!.digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(resolveSkill(binding, { ...resolverContext, lock: changedDigest }), /WSSPEC_SKILL_LOCK_CHANGED/);
});

test("Skill Lock v1 parser 递归拒绝版本、未知字段和非法逻辑值", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const valid = {
    version: 1,
    skills: [{
      requested: "global://vendor/tdd",
      resolved: "global://vendor/tdd",
      source: "global",
      provider: "codex",
      rootId: "codex:default:0",
      digest,
      candidates: [{ rootId: "codex:default:0", digest }],
      required: true,
      fallback: { ref: "builtin://skills/tdd-implementation", source: "builtin", rootId: "builtin", digest },
    }],
  };
  const parseSkillLock = (skillLockModule as unknown as { parseSkillLock(value: unknown): SkillLock }).parseSkillLock;

  assert.deepEqual(parseSkillLock(valid), valid);
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, unknown: true },
    { ...valid, skills: [{ ...valid.skills[0], unknown: true }] },
    { ...valid, skills: [{ ...valid.skills[0], candidates: [{ ...valid.skills[0]!.candidates[0], unknown: true }] }] },
    { ...valid, skills: [{ ...valid.skills[0], fallback: { ...valid.skills[0]!.fallback, unknown: true } }] },
    { ...valid, skills: [{ ...valid.skills[0], requested: "global://../escape" }] },
    { ...valid, skills: [{ ...valid.skills[0], digest: "sha256:short" }] },
    { ...valid, skills: [{ ...valid.skills[0], provider: "unknown" }] },
    { ...valid, skills: [{ ...valid.skills[0], source: "unknown" }] },
    { ...valid, skills: [{ ...valid.skills[0], rootId: "/secret/home" }] },
    { ...valid, skills: [{ ...valid.skills[0], candidates: [{ ...valid.skills[0]!.candidates[0], rootId: "/secret/home" }] }] },
    { ...valid, skills: [{ ...valid.skills[0], candidates: [{ ...valid.skills[0]!.candidates[0], digest: "sha256:short" }] }] },
    { ...valid, skills: [{ ...valid.skills[0], fallback: { ...valid.skills[0]!.fallback, ref: "project://skills/tdd" } }] },
    { ...valid, skills: [{ ...valid.skills[0], fallback: { ...valid.skills[0]!.fallback, source: "project" } }] },
    { ...valid, skills: [{ ...valid.skills[0], fallback: { ...valid.skills[0]!.fallback, rootId: "/secret/home" } }] },
    { ...valid, skills: [{ ...valid.skills[0], fallback: { ...valid.skills[0]!.fallback, digest: "sha256:short" } }] },
    {
      ...valid,
      skills: [{
        requested: "builtin://skills/tdd-implementation",
        resolved: "builtin://skills/tdd-implementation",
        source: "builtin",
        provider: "codex",
        candidates: [],
        required: true,
      }],
    },
    { ...valid, skills: [{ ...valid.skills[0], entrypoint: "/secret/home/SKILL.md" }] },
  ]) {
    assert.throws(() => parseSkillLock(invalid), /WSSPEC_SKILL_LOCK_INVALID/);
  }
});

test("Resolver 在使用 Lock 前执行严格 v1 解析", async () => {
  const root = await temporaryRoot();
  const globalRoot = path.join(root, "global");
  await writeSkill(globalRoot, "vendor/tdd", { "SKILL.md": "# Global\n" });
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/fixture" });
  const binding = { ref: "global://vendor/tdd", required: true } as const;
  const base: SkillResolverContext = {
    provider: "generic",
    projectRoot: root,
    home: path.join(root, "home"),
    package: pkg,
    additionalGlobalRoots: [globalRoot],
    stepStatus: "not_started",
  };
  const resolved = await resolveSkill(binding, base);
  const lock = createSkillLock(resolved!);

  await assert.rejects(
    resolveSkill(binding, { ...base, lock: { ...lock, version: 2, unknown: true } }),
    /WSSPEC_SKILL_LOCK_INVALID/,
  );
});

test("createSkillLock 分别拒绝伪造 ResolvedSkill 的绝对 rootId 和未知正文", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const valid = {
    requestedRef: "global://vendor/tdd",
    ref: "global://vendor/tdd",
    source: "global",
    provider: "codex",
    rootId: "codex:default:0",
    entrypoint: "/secret/home/vendor/tdd/SKILL.md",
    digest,
    candidates: [{ rootId: "codex:default:0", digest }],
    required: true,
    usedFallback: false,
    primary: {
      ref: "global://vendor/tdd",
      source: "global",
      rootId: "codex:default:0",
      digest,
      candidates: [{ rootId: "codex:default:0", digest }],
    },
  } as unknown as ResolvedSkill;

  assert.throws(
    () => createSkillLock({ ...valid, rootId: "/secret/home", candidates: [{ rootId: "/secret/home", digest }] }),
    /WSSPEC_SKILL_LOCK_INVALID/,
  );
  assert.throws(
    () => createSkillLock({ ...valid, body: "secret skill body" } as unknown as ResolvedSkill),
    /WSSPEC_SKILL_LOCK_INVALID/,
  );
});
