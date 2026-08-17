import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";
import { lockWorkflowPackage } from "../../src/workflow-package/lock.js";

async function packageFixture(root: string, id = "team-feature"): Promise<string> {
  const directory = path.join(root, ".wsspec", "workflows", id);
  await mkdir(path.join(directory, "profiles"), { recursive: true });
  await mkdir(path.join(directory, "skills", "review"), { recursive: true });
  await mkdir(path.join(directory, "schemas"), { recursive: true });
  await mkdir(path.join(directory, "templates"), { recursive: true });
  await writeFile(path.join(directory, "manifest.yaml"), [
    "version: 1",
    `id: ${id}`,
    "entry: workflow.yaml",
    "profiles: [standard]",
    "capabilities: [git, external-read]",
    "skills: [review]",
  ].join("\n") + "\n");
  await writeFile(path.join(directory, "workflow.yaml"), [
    "version: 1",
    `id: ${id}`,
    "steps:",
    "  - id: review",
    "    skills: [package://skills/review]",
  ].join("\n") + "\n");
  await writeFile(path.join(directory, "profiles", "standard.yaml"), `version: 1\nid: standard\nworkflow: ${id}\n`);
  await writeFile(path.join(directory, "skills", "review", "SKILL.md"), "# Review\n");
  await writeFile(path.join(directory, "schemas", "review.json"), "{\"type\":\"object\"}\n");
  await writeFile(path.join(directory, "templates", "review.md"), "# Template\n");
  return directory;
}

async function temporaryRoot(): Promise<string> {
  return path.join(os.tmpdir(), `wspec-workflow-package-${crypto.randomUUID()}`);
}

test("加载项目 Package 时收集已声明的内置 Skill 与可移植内容摘要", async () => {
  const root = await temporaryRoot();
  await packageFixture(root);

  const loaded = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  assert.equal(loaded.ref, "project://workflows/team-feature");
  assert.equal(loaded.manifest.id, "team-feature");
  assert.equal(loaded.workflow.id, "team-feature");
  assert.equal(loaded.profiles.get("standard")?.id, "standard");
  assert.equal(loaded.packageSkills.get("package://skills/review")?.entrypoint.endsWith("/skills/review/SKILL.md"), true);
  assert.match(loaded.contentDigest, /^sha256:[a-f0-9]{64}$/);
});

test("拒绝词法路径逃逸", async () => {
  const root = await temporaryRoot();
  await assert.rejects(
    loadWorkflowPackage({ root, ref: "project://workflows/../../outside" }),
    /WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID/,
  );
});

test("拒绝通过符号链接逃出项目工作流根目录", async (context) => {
  const root = await temporaryRoot();
  const outside = path.join(root, "outside");
  await packageFixture(outside, "escaped");
  await mkdir(path.join(root, ".wsspec", "workflows"), { recursive: true });
  try {
    await symlink(outside, path.join(root, ".wsspec", "workflows", "escaped"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("当前文件系统不支持测试符号链接");
    throw error;
  }
  await assert.rejects(
    loadWorkflowPackage({ root, ref: "project://workflows/escaped" }),
    /WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE/,
  );
});

test("缺少 Manifest 或 Manifest 版本不受支持时拒绝加载", async () => {
  const root = await temporaryRoot();
  const missing = path.join(root, ".wsspec", "workflows", "missing");
  await mkdir(missing, { recursive: true });
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/missing" }), /WSSPEC_WORKFLOW_PACKAGE_MANIFEST_MISSING/);

  const unsupported = await packageFixture(root, "unsupported");
  await writeFile(path.join(unsupported, "manifest.yaml"), "version: 2\nid: unsupported\nentry: workflow.yaml\nprofiles: [standard]\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/unsupported" }), /WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED/);
});

test("拒绝 Workflow 引用 Manifest 未声明的 Package Skill", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root, "undeclared-skill");
  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nid: undeclared-skill\nsteps:\n  - id: review\n    skills: [package://skills/secret]\n");

  await assert.rejects(
    loadWorkflowPackage({ root, ref: "project://workflows/undeclared-skill" }),
    /WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED/,
  );
});

test("Lock 拒绝未知字段，并以排序的相对文件清单产生确定性摘要", async () => {
  const root = await temporaryRoot();
  const firstDirectory = await packageFixture(root, "first");
  const secondDirectory = await packageFixture(root, "second");
  for (const relative of ["manifest.yaml", "workflow.yaml", "profiles/standard.yaml"]) {
    await writeFile(path.join(secondDirectory, relative), await readFile(path.join(firstDirectory, relative), "utf8"));
  }
  const first = await loadWorkflowPackage({ root, ref: "project://workflows/first" });
  const second = await loadWorkflowPackage({ root, ref: "project://workflows/second" });

  const lock = lockWorkflowPackage(first);
  assert.equal(lock.version, 1);
  assert.deepEqual(lock.files.map((entry) => entry.path), [...lock.files.map((entry) => entry.path)].sort());
  assert.deepEqual(lock.packageSkills, [{ ref: "package://skills/review", digest: first.packageSkills.get("package://skills/review")!.digest }]);
  assert.equal(lock.contentDigest, first.contentDigest);
  assert.equal(first.contentDigest, second.contentDigest);

  await writeFile(path.join(firstDirectory, "workflow.lock"), "version: 1\nunknown: true\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/first" }), /WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID/);
  await readFile(path.join(secondDirectory, "manifest.yaml"), "utf8");
});

test("加载内置 Package 使用内置 URI", async () => {
  const root = await temporaryRoot();
  const loaded = await loadWorkflowPackage({ root, ref: "builtin://workflows/feature-delivery" });
  assert.equal(loaded.manifest.id, "feature-delivery");
  assert.equal(loaded.ref, "builtin://workflows/feature-delivery");
});
