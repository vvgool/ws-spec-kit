import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256 } from "../../src/domain/digests.js";
import { resolveSkill } from "../../src/registry/skills/resolver.js";
import type { SkillProvider, SkillResolverContext } from "../../src/registry/skills/types.js";
import { workflowPackageContentDigest } from "../../src/workflow-package/lock.js";
import type { WorkflowPackage } from "../../src/workflow-package/types.js";

async function temporaryRoot(): Promise<string> {
  return path.join(os.tmpdir(), `wspec-skill-resolver-${crypto.randomUUID()}`);
}

function packageSnapshot(root: string, skills: Array<[string, string, string]> = [], files: WorkflowPackage["files"] = []): WorkflowPackage {
  return {
    ref: "project://workflows/fixture",
    root,
    manifest: { version: 1, id: "fixture", entry: "workflow.yaml", profiles: [], skills: skills.map(([name]) => name), capabilities: [], externalSideEffects: [], connectors: [] },
    workflow: { version: 1, workflow: { id: "fixture", version: 1 }, inputs: {}, steps: [], gates: [] },
    profiles: new Map(),
    packageSkills: new Map(skills.map(([name, entrypoint, digest]) => [`package://skills/${name}`, { entrypoint, digest }])),
    files,
    contentDigest: "sha256:fixture",
  };
}

async function context(provider: SkillProvider = "generic"): Promise<SkillResolverContext> {
  const root = await temporaryRoot();
  const packageRoot = path.join(root, ".wsspec", "workflows", "fixture");
  await mkdir(packageRoot, { recursive: true });
  return { provider, projectRoot: root, home: path.join(root, "home"), package: packageSnapshot(packageRoot), stepStatus: "not_started" };
}

async function writeSkill(root: string, relative: string, contents = "# Skill\n"): Promise<string> {
  const directory = path.join(root, ...relative.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), contents);
  return directory;
}

test("解析精确的 Builtin Skill 并摘要完整目录", async () => {
  const result = await resolveSkill({ ref: "builtin://skills/tdd-implementation", required: true }, await context("codex"));

  assert.equal(result?.requestedRef, "builtin://skills/tdd-implementation");
  assert.equal(result?.ref, "builtin://skills/tdd-implementation");
  assert.equal(result?.source, "builtin");
  assert.equal(result?.provider, "codex");
  assert.equal(result?.rootId, "builtin");
  assert.equal(path.basename(result!.entrypoint), "SKILL.md");
  assert.match(result!.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result?.usedFallback, false);
});

test("Package Skill 必须由当前 Package Manifest 声明", async () => {
  const resolverContext = await context();
  const declaredDirectory = await writeSkill(resolverContext.package.root, "skills/review", "# Review\n");
  const files = [{ path: "skills/review/SKILL.md", digest: sha256("# Review\n") }];
  const digest = workflowPackageContentDigest(files);
  resolverContext.package = packageSnapshot(resolverContext.package.root, [["review", path.join(declaredDirectory, "SKILL.md"), digest]], files);

  const result = await resolveSkill({ ref: "package://skills/review", required: true }, resolverContext);

  assert.equal(result?.source, "package");
  assert.equal(result?.rootId, "package");
  assert.equal(result?.digest, digest);
  await assert.rejects(
    resolveSkill({ ref: "package://skills/secret", required: true }, resolverContext),
    /WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED/,
  );
});

test("Project Skill 只从显式项目 URI 加载，不搜索 Global 同名替代品", async () => {
  const resolverContext = await context("codex");
  await writeSkill(path.join(resolverContext.home, ".agents", "skills"), "review", "# Global\n");
  await assert.rejects(resolveSkill({ ref: "project://skills/review", required: true }, resolverContext), /WSSPEC_SKILL_NOT_FOUND/);

  const directory = await writeSkill(path.join(resolverContext.projectRoot, ".wsspec"), "skills/review", "# Project\n");
  const result = await resolveSkill({ ref: "project://skills/review", required: true }, resolverContext);

  assert.equal(result?.source, "project");
  assert.equal(result?.rootId, "project");
  assert.equal(result?.entrypoint, path.join(directory, "SKILL.md"));
});

test("四种 Provider 使用固定默认 Global 根顺序", async () => {
  const cases: Array<[SkillProvider, string[]]> = [
    ["codex", [".agents/skills"]],
    ["claude", [".claude/skills"]],
    ["cursor", [".agents/skills", ".cursor/skills", ".claude/skills", ".codex/skills"]],
    ["generic", []],
  ];

  for (const [provider, roots] of cases) {
    const resolverContext = await context(provider);
    for (const root of roots) await writeSkill(path.join(resolverContext.home, ...root.split("/")), "vendor/tdd", "# Same\n");
    const result = await resolveSkill({ ref: "global://vendor/tdd", required: false }, resolverContext);
    if (roots.length === 0) {
      assert.equal(result, undefined);
    } else {
      assert.equal(result?.source, "global");
      assert.deepEqual(result?.candidates.map(({ rootId }) => rootId), roots.map((_, index) => `${provider}:default:${index}`));
      assert.equal(result?.rootId, `${provider}:default:0`);
    }
  }
});

test("附加 Global 根追加在默认根之后并使用逻辑 rootId", async () => {
  const resolverContext = await context("codex");
  const additional = path.join(resolverContext.home, "custom-skills");
  resolverContext.additionalGlobalRoots = [additional];
  await writeSkill(additional, "vendor/tdd", "# Added\n");

  const result = await resolveSkill({ ref: "global://vendor/tdd", required: true }, resolverContext);

  assert.equal(result?.rootId, "codex:additional:0");
  assert.equal(result?.candidates[0]?.rootId, "codex:additional:0");
  assert.equal(JSON.stringify(result?.candidates).includes(resolverContext.home), false);
});

test("附加 Global 根拒绝无法移植的相对路径", async () => {
  const resolverContext = await context("generic");
  resolverContext.additionalGlobalRoots = ["relative/skills"];

  await assert.rejects(
    resolveSkill({ ref: "global://vendor/tdd", required: true }, resolverContext),
    /WSSPEC_SKILL_PATH_INVALID/,
  );
});

test("多个 Global 候选同摘要时去重并保留诊断，不同摘要时拒绝歧义", async () => {
  const resolverContext = await context("cursor");
  const firstRoot = path.join(resolverContext.home, ".agents", "skills");
  const secondRoot = path.join(resolverContext.home, ".cursor", "skills");
  await writeSkill(firstRoot, "vendor/tdd", "# Same\n");
  await writeSkill(secondRoot, "vendor/tdd", "# Same\n");

  const same = await resolveSkill({ ref: "global://vendor/tdd", required: true }, resolverContext);
  assert.equal(same?.rootId, "cursor:default:0");
  assert.equal(same?.candidates.length, 2);
  assert.equal(same?.candidates[0]?.digest, same?.candidates[1]?.digest);

  await writeFile(path.join(secondRoot, "vendor", "tdd", "SKILL.md"), "# Different\n");
  await assert.rejects(resolveSkill({ ref: "global://vendor/tdd", required: true }, resolverContext), /WSSPEC_SKILL_AMBIGUOUS/);
});

test("缺失 Skill 仅在可选时继续，必需时阻塞", async () => {
  const resolverContext = await context();

  assert.equal(await resolveSkill({ ref: "global://missing/skill", required: false }, resolverContext), undefined);
  await assert.rejects(resolveSkill({ ref: "global://missing/skill", required: true }, resolverContext), /WSSPEC_SKILL_NOT_FOUND/);
});

test("URI 逐段校验拒绝词法逃逸、绝对路径和编码路径", async () => {
  const resolverContext = await context();
  for (const ref of [
    "package://../other",
    "project://skills/../other",
    "global:///absolute",
    "global://vendor/%2fescape",
    "global://vendor//escape",
    "builtin://skills/Uppercase",
  ]) {
    await assert.rejects(resolveSkill({ ref, required: true }, resolverContext), /WSSPEC_SKILL_(REF|PATH)_INVALID/, ref);
  }
});

test("入口或目录通过符号链接逃出声明根时 fail closed", async (t) => {
  const resolverContext = await context();
  const outside = path.join(resolverContext.projectRoot, "outside");
  await writeSkill(outside, "review", "# Outside\n");
  await mkdir(path.join(resolverContext.projectRoot, ".wsspec", "skills"), { recursive: true });
  try {
    await symlink(path.join(outside, "review"), path.join(resolverContext.projectRoot, ".wsspec", "skills", "review"));
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "EPERM") return t.skip("当前文件系统不支持符号链接");
    throw caught;
  }

  await assert.rejects(resolveSkill({ ref: "project://skills/review", required: true }, resolverContext), /WSSPEC_SKILL_PATH_ESCAPE/);
});

test("Project Skill 符号链接不得离开 .wsspec/skills 声明根", async (t) => {
  const resolverContext = await context();
  const other = await writeSkill(path.join(resolverContext.projectRoot, ".wsspec", "workflows"), "other", "# Other\n");
  await mkdir(path.join(resolverContext.projectRoot, ".wsspec", "skills"), { recursive: true });
  try {
    await symlink(other, path.join(resolverContext.projectRoot, ".wsspec", "skills", "review"));
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "EPERM") return t.skip("当前文件系统不支持符号链接");
    throw caught;
  }

  await assert.rejects(resolveSkill({ ref: "project://skills/review", required: true }, resolverContext), /WSSPEC_SKILL_PATH_ESCAPE/);
});

test("Project 的 .wsspec 与 skills 根均拒绝现存和悬空的越界符号链接", async (t) => {
  for (const [level, dangling] of [
    ["configuration", false],
    ["configuration", true],
    ["skills", false],
    ["skills", true],
  ] as const) {
    const resolverContext = await context();
    const outside = path.join(await temporaryRoot(), "outside");
    if (!dangling) await writeSkill(outside, level === "configuration" ? "skills/review" : "review", "# Outside\n");
    try {
      if (level === "configuration") {
        await rm(path.join(resolverContext.projectRoot, ".wsspec"), { recursive: true });
        await symlink(outside, path.join(resolverContext.projectRoot, ".wsspec"));
      } else {
        await mkdir(path.join(resolverContext.projectRoot, ".wsspec"), { recursive: true });
        await symlink(dangling ? outside : path.dirname(path.join(outside, "review")), path.join(resolverContext.projectRoot, ".wsspec", "skills"));
      }
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "EPERM") return t.skip("当前文件系统不支持符号链接");
      throw caught;
    }

    await assert.rejects(
      resolveSkill({ ref: "project://skills/review", required: true }, { ...resolverContext, stepStatus: "not_started" }),
      /WSSPEC_SKILL_PATH_ESCAPE/,
      `${level}/${dangling ? "dangling" : "existing"}`,
    );
  }
});
