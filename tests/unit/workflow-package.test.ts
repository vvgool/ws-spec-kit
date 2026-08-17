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

test("Package Skill 的辅助内容变化会改变 Skill 和 Package 摘要", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await mkdir(path.join(directory, "skills", "review", "scripts"), { recursive: true });
  await mkdir(path.join(directory, "skills", "review", "references"), { recursive: true });
  await writeFile(path.join(directory, "skills", "review", "scripts", "review.sh"), "echo first\n");
  await writeFile(path.join(directory, "skills", "review", "references", "policy.md"), "first\n");
  const first = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  await writeFile(path.join(directory, "skills", "review", "scripts", "review.sh"), "echo second\n");
  const second = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  assert.notEqual(second.contentDigest, first.contentDigest);
  assert.notEqual(second.packageSkills.get("package://skills/review")?.digest, first.packageSkills.get("package://skills/review")?.digest);
  assert.ok(second.files.some((file) => file.path === "skills/review/scripts/review.sh"));
});

test("Skill 树的悬空链接必须 fail closed", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await symlink(path.join(root, "missing-target"), path.join(directory, "skills", "review", "dangling"));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /ENOENT|WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE/);
});

test("保真加载完整 Step 与 Profile overlay 字段", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nid: team-feature\ninputs: { requirement: { accepts: [user.prompt] } }\nsteps:\n  - id: review\n    uses: agent.execute\n    needs: []\n    when: '${bindings.issue.exists}'\n    retry: { maxAttempts: 2 }\n    loop: { until: '${review.approved}', maxIterations: 2 }\n    approval: required\n    inputs: [{ artifact: specification, required: true }]\n    outputs: [result]\n    skills: [{ ref: package://skills/review, required: true }]\n");
  await writeFile(path.join(directory, "profiles", "standard.yaml"), "version: 1\nprofile: { id: standard, workflow: team-feature }\nsteps: { review: { enabled: true, approval: false, artifactLevel: compact, gates: [test] } }\npublishing: { issueRequired: false, knowledgeRequired: false }\naudit: { level: standard }\n");
  const loaded = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  assert.equal(loaded.workflow.steps[0]!.uses, "agent.execute");
  assert.equal((loaded.profiles.get("standard")?.audit as { level?: string } | undefined)?.level, "standard");
});

test("Manifest、Workflow、Profile、Schema 和 Template 的变化均改变 Package 摘要", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  let previous = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const changes: Array<[string, string]> = [
    ["manifest.yaml", "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: [standard]\nskills: [review]\ncapabilities: [external-read]\n"],
    ["workflow.yaml", "version: 1\nid: team-feature\nsteps:\n  - id: revised\n    skills: [package://skills/review]\n"],
    ["profiles/standard.yaml", "version: 1\nid: standard\nworkflow: team-feature\ndesign: false\n"],
    ["schemas/review.json", "{\"type\":\"string\"}\n"],
    ["templates/review.md", "# Revised template\n"],
  ];
  for (const [relative, content] of changes) {
    await writeFile(path.join(directory, relative), content);
    const current = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
    assert.notEqual(current.contentDigest, previous.contentDigest, `${relative} 必须进入摘要`);
    previous = current;
  }
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

test("拒绝 Schema、Template 和 Package Skill 内部的空目录符号链接逃逸", async (context) => {
  for (const escapedDirectory of ["schemas", "templates", "skills/review/scripts"]) {
    const root = await temporaryRoot();
    const directory = await packageFixture(root);
    const outside = path.join(root, "outside-empty");
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(directory, escapedDirectory), { recursive: true });
    try {
      await symlink(outside, path.join(directory, escapedDirectory, "escaped"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("当前文件系统不支持测试符号链接");
      throw error;
    }
    await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE/);
  }
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

test("缺少 Workflow 和 Profile 给出各自稳定诊断", async () => {
  const root = await temporaryRoot();
  const workflowMissing = await packageFixture(root, "workflow-missing");
  await writeFile(path.join(workflowMissing, "workflow.yaml"), "");
  await (await import("node:fs/promises")).unlink(path.join(workflowMissing, "workflow.yaml"));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/workflow-missing" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_MISSING/);

  const profileMissing = await packageFixture(root, "profile-missing");
  await (await import("node:fs/promises")).unlink(path.join(profileMissing, "profiles", "standard.yaml"));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/profile-missing" }), /WSSPEC_WORKFLOW_PACKAGE_PROFILE_MISSING/);
});

test("拒绝 Manifest、Workflow、Profile 和 Lock 中的未知字段", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  await writeFile(path.join(directory, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: [standard]\nskills: [review]\nexternalSideEffect: [external-write]\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID/);

  await packageFixture(root);
  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nid: team-feature\nsteps:\n  - id: review\n    skills: [package://skills/review]\n    typo: true\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID/);

  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nid: team-feature\nsteps:\n  - id: review\n    skills: [package://skills/review]\n");
  await writeFile(path.join(directory, "profiles", "standard.yaml"), "version: 1\nid: standard\nworkflow: team-feature\ntypo: true\n");
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID/);

  await writeFile(path.join(directory, "profiles", "standard.yaml"), "version: 1\nid: standard\nworkflow: team-feature\n");
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const lock = lockWorkflowPackage(pkg);
  await writeFile(path.join(directory, "workflow.lock"), JSON.stringify({ ...lock, files: [{ ...lock.files[0], typo: true }] }));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID/);
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

test("Lock 拒绝摘要、文件与 Skill 清单漂移", async () => {
  const root = await temporaryRoot();
  const directory = await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const lock = lockWorkflowPackage(pkg);
  await writeFile(path.join(directory, "workflow.lock"), JSON.stringify({ ...lock, packageSkills: [{ ...lock.packageSkills[0]!, digest: "sha256:changed" }] }));
  await assert.rejects(loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }), /WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID/);
});

test("加载内置 Package 使用内置 URI", async () => {
  const root = await temporaryRoot();
  const loaded = await loadWorkflowPackage({ root, ref: "builtin://workflows/feature-delivery" });
  assert.equal(loaded.manifest.id, "feature-delivery");
  assert.equal(loaded.ref, "builtin://workflows/feature-delivery");
});

test("生产 Builtin 路径不能由调用方注入的根或 Catalog 伪造", async () => {
  const root = await temporaryRoot();
  const fakeRoot = path.join(root, "fake-builtin");
  await mkdir(path.join(fakeRoot, "workflows"), { recursive: true });
  const fakePackage = await packageFixture(fakeRoot, "feature-delivery");
  await (await import("node:fs/promises")).rename(fakePackage, path.join(fakeRoot, "workflows", "feature-delivery"));
  const loaded = await loadWorkflowPackage({
    root,
    ref: "builtin://workflows/feature-delivery",
    builtinRoot: fakeRoot,
    catalog: { version: 1, skills: [], workflows: [{ id: "feature-delivery", steps: [], gates: [], changePolicy: { kind: "feature", allowedPaths: [] }, profiles: [] }] },
  } as never);
  assert.equal(loaded.manifest.description, "基础功能交付工作流");
});
