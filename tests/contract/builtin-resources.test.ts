import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadBuiltinCatalog } from "../../src/resources/catalog.js";
import { WorkflowPackageError } from "../../src/workflow-package/types.js";
import { invalidProfileV1Fixtures, invalidWorkflowV1Fixtures, profileV1Fixture, workflowV1Fixture } from "../helpers/workflow-v1-fixtures.js";

async function writeCatalogFixture(workflow: string, profile: string, catalogSuffix = ""): Promise<string> {
  const root = path.join(os.tmpdir(), `wspec-builtin-catalog-${crypto.randomUUID()}`);
  const workflowRoot = path.join(root, "workflows", "fixture-workflow");
  await mkdir(path.join(workflowRoot, "profiles"), { recursive: true });
  await mkdir(path.join(root, "skills", "fixture-skill"), { recursive: true });
  await writeFile(path.join(root, "catalog.yaml"), `version: 1\nworkflows: [fixture-workflow]\nskills:\n  - id: fixture-skill\n    version: 1.0.0\n    description: 测试 Skill\n${catalogSuffix}`);
  await writeFile(path.join(root, "skills", "fixture-skill", "SKILL.md"), "# 测试 Skill\n");
  await writeFile(path.join(workflowRoot, "workflow.yaml"), workflow);
  for (const id of ["quick", "standard", "governed"]) {
    await writeFile(path.join(workflowRoot, "profiles", `${id}.yaml`), profile.replace("id: standard", `id: ${id}`));
  }
  return root;
}

test("内置目录提供两个完整中文工作流及其 Skill", async () => {
  const catalog = await loadBuiltinCatalog();
  assert.deepEqual(catalog.workflows.map((item) => item.workflow.id).sort(), ["documentation-delivery", "feature-delivery"]);
  assert.ok(catalog.skills.length >= 9);
  const skillRefs = new Set(catalog.skills.map((skill) => `builtin://skills/${skill.id}`));
  for (const skill of catalog.skills) {
    assert.match(skill.description, /[\u4e00-\u9fff]/u);
    assert.match(await readFile(skill.entry, "utf8"), /[\u4e00-\u9fff]/u);
  }
  for (const workflow of catalog.workflows) {
    assert.equal(workflow.version, 1);
    assert.equal(workflow.workflow.version, 1);
    assert.deepEqual(workflow.profiles.map((profile) => profile.profile.id).sort(), ["governed", "quick", "standard"]);
    const visit = (steps: typeof workflow.steps): void => {
      for (const step of steps) {
        for (const binding of step.skills ?? []) assert.ok(skillRefs.has(binding.ref), `${binding.ref} 未注册`);
        visit(step.steps ?? []);
      }
    };
    visit(workflow.steps);
  }
});

test("功能交付绑定可信 Red/Green Gate，文档交付保持纯文档边界", async () => {
  const catalog = await loadBuiltinCatalog();
  const feature = catalog.workflows.find((item) => item.workflow.id === "feature-delivery")!;
  assert.deepEqual(feature.steps.map((step) => step.id), ["intake", "explore", "clarify", "design", "plan", "write-tests", "verify-red", "implement", "verify-green", "review-fix", "commit", "update-issue", "update-wiki", "close-issue", "close"]);
  assert.equal(feature.steps.find((step) => step.id === "review-fix")?.steps?.length, 3);
  assert.ok(feature.gates.some((gate) => gate.id === "verify-red" && gate.evidence === "trusted"));
  assert.ok(feature.gates.some((gate) => gate.id === "verify-green" && gate.evidence === "trusted"));
  const docs = catalog.workflows.find((item) => item.workflow.id === "documentation-delivery")!;
  assert.deepEqual(docs.steps.map((step) => step.id), ["intake", "explore", "clarify", "plan", "edit-document", "verify-document", "review-fix", "commit", "update-issue", "update-wiki", "close-issue", "close"]);
  assert.equal(docs.steps.find((step) => step.id === "review-fix")?.steps?.length, 3);
  assert.equal(docs.changePolicy?.kind, "documentation-only");
  assert.deepEqual(docs.gates.find((gate) => gate.id === "docs.integrity")?.command, ["wspec", "gate", "docs.integrity"]);
});

test("六个内置 Profile 只使用正式 overlay 结构", async () => {
  const catalog = await loadBuiltinCatalog();
  for (const workflow of catalog.workflows) for (const profile of workflow.profiles) {
    assert.deepEqual(Object.keys(profile).sort(), ["audit", "profile", "publishing", "steps", "version"]);
    assert.equal(profile.profile.workflow, workflow.workflow.id);
    assert.ok(["standard", "complete"].includes(profile.audit.level));
    assert.ok(Object.values(profile.steps).some((step) => Object.keys(step.artifacts ?? {}).length > 0));
    assert.equal(typeof profile.publishing.readBackRequired, "boolean");
    assert.equal(typeof profile.audit.recordDecisions, "boolean");
    assert.equal(typeof profile.audit.recordApprovals, "boolean");
    assert.equal(typeof profile.audit.recordActors, "boolean");
    assert.equal(typeof profile.audit.recordPublishing, "boolean");
    if (profile.profile.id === "governed") {
      assert.equal(profile.steps["review-fix"]?.independentReviewActor, true);
      assert.equal(profile.publishing.readBackRequired, true);
      assert.equal(profile.audit.retention, "extended");
    } else {
      assert.equal(profile.publishing.readBackRequired, false);
      assert.equal(profile.audit.retention, "standard");
    }
  }
});

test("Builtin Catalog 对 Workflow/Profile 使用与 Project loader 相同的 v1 正反例矩阵", async () => {
  const validRoot = await writeCatalogFixture(workflowV1Fixture, profileV1Fixture);
  const valid = await loadBuiltinCatalog(validRoot);
  assert.equal(valid.workflows[0]?.workflow.id, "fixture-workflow");
  assert.equal(valid.workflows[0]?.profiles[1]?.steps["review-fix"]?.independentReviewActor, true);

  for (const [label, workflow] of invalidWorkflowV1Fixtures) {
    const root = await writeCatalogFixture(workflow, profileV1Fixture);
    await assert.rejects(loadBuiltinCatalog(root), /WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID/, label);
  }
  for (const [label, profile] of invalidProfileV1Fixtures) {
    const root = await writeCatalogFixture(workflowV1Fixture, profile);
    await assert.rejects(loadBuiltinCatalog(root), /WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID/, label);
  }
});

test("Builtin Catalog 递归拒绝自身未知字段和错误类型", async () => {
  for (const [label, suffix] of [
    ["catalog top-level unknown", "typo: true\n"],
    ["catalog skill nested unknown", "  - id: extra\n    version: 1.0.0\n    description: 额外 Skill\n    typo: true\n"],
    ["catalog workflow type", ""],
  ] as const) {
    const root = await writeCatalogFixture(workflowV1Fixture, profileV1Fixture, suffix);
    if (label === "catalog workflow type") await writeFile(path.join(root, "catalog.yaml"), "version: 1\nworkflows: wrong\nskills: []\n");
    await assert.rejects(loadBuiltinCatalog(root), /WSSPEC_BUILTIN_CATALOG_INVALID/, label);
  }
});

test("Builtin Catalog 将 workflows 绑定到 canonical resources root", async (context) => {
  for (const targetState of ["existing", "dangling"] as const) {
    const root = await writeCatalogFixture(workflowV1Fixture, profileV1Fixture);
    const outside = await writeCatalogFixture(workflowV1Fixture, profileV1Fixture);
    await rm(path.join(root, "workflows"), { recursive: true });
    try {
      await symlink(
        targetState === "existing" ? path.join(outside, "workflows") : path.join(outside, "missing-workflows"),
        path.join(root, "workflows"),
      );
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "EPERM") context.skip("当前文件系统不支持测试符号链接");
      throw caught;
    }
    await assert.rejects(loadBuiltinCatalog(root), /WSSPEC_BUILTIN_RESOURCE_PATH_ESCAPE/, targetState);
  }
});

test("Builtin Catalog 拒绝越出 canonical resources root 的叶子 YAML", async (context) => {
  const leaves = [
    ["catalog", "catalog.yaml"],
    ["workflow", path.join("workflows", "fixture-workflow", "workflow.yaml")],
    ["profile", path.join("workflows", "fixture-workflow", "profiles", "standard.yaml")],
  ] as const;
  for (const [label, relative] of leaves) {
    for (const targetState of ["existing", "dangling"] as const) {
      await context.test(`${label} ${targetState}`, async (leafContext) => {
        const root = await writeCatalogFixture(workflowV1Fixture, profileV1Fixture);
        const outside = await writeCatalogFixture(workflowV1Fixture, profileV1Fixture);
        const leaf = path.join(root, relative);
        await rm(leaf);
        try {
          await symlink(
            targetState === "existing" ? path.join(outside, relative) : path.join(outside, "missing", relative),
            leaf,
          );
        } catch (caught) {
          if ((caught as NodeJS.ErrnoException).code === "EPERM") leafContext.skip("当前文件系统不支持测试符号链接");
          throw caught;
        }
        await assert.rejects(
          loadBuiltinCatalog(root),
          (error: unknown) => error instanceof WorkflowPackageError && error.code === "WSSPEC_BUILTIN_RESOURCE_PATH_ESCAPE",
        );
      });
    }
  }
});

test("Builtin Catalog 拒绝 Catalog ref 与 Workflow id 不一致", async () => {
  const root = await writeCatalogFixture(
    workflowV1Fixture.replace("id: fixture-workflow", "id: other-workflow"),
    profileV1Fixture,
  );
  await assert.rejects(
    loadBuiltinCatalog(root),
    (error: unknown) => error instanceof WorkflowPackageError && error.code === "WSSPEC_BUILTIN_WORKFLOW_ID_MISMATCH",
  );
});

test("Builtin Catalog 拒绝 Profile 文件名与 Profile id 不一致", async () => {
  const root = await writeCatalogFixture(workflowV1Fixture, profileV1Fixture);
  const standard = path.join(root, "workflows", "fixture-workflow", "profiles", "standard.yaml");
  await writeFile(standard, profileV1Fixture.replace("id: standard", "id: quick"));
  await assert.rejects(
    loadBuiltinCatalog(root),
    (error: unknown) => error instanceof WorkflowPackageError && error.code === "WSSPEC_BUILTIN_PROFILE_ID_MISMATCH",
  );
});

test("Builtin Catalog 拒绝 Profile 绑定其他 Workflow", async () => {
  const root = await writeCatalogFixture(workflowV1Fixture, profileV1Fixture);
  const standard = path.join(root, "workflows", "fixture-workflow", "profiles", "standard.yaml");
  await writeFile(standard, profileV1Fixture.replace("workflow: fixture-workflow", "workflow: other-workflow"));
  await assert.rejects(
    loadBuiltinCatalog(root),
    (error: unknown) => error instanceof WorkflowPackageError && error.code === "WSSPEC_BUILTIN_PROFILE_WORKFLOW_MISMATCH",
  );
});
