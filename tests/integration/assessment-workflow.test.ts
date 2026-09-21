import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadBuiltinCatalog } from "../../src/resources/catalog.js";
import { readControlPlane } from "../../src/storage/control-plane.js";
import { authorArtifact, completedResult, controlRuntimeFixture, requireExecute, submitPackage } from "./helpers/control-runtime.js";
import { git } from "./helpers/git.js";

test("assessment 的全部 Profile 只允许读取和记录结论，不包含代码或外部交付步骤", async () => {
  const assessment = (await loadBuiltinCatalog()).workflows.find((item) => item.workflow.id === "assessment");
  assert.ok(assessment);
  assert.deepEqual(assessment.steps.map(({ id }) => id), ["intake", "assess", "close"]);
  assert.ok(assessment.steps.every(({ workspace }) => workspace === "read-only"));
  assert.deepEqual(assessment.gates, []);
  assert.deepEqual(assessment.steps.map(({ action }) => action).filter(Boolean), ["requirement.capture"]);
  for (const profile of assessment.profiles) {
    assert.deepEqual(profile.publishing, { issueRequired: false, knowledgeRequired: false, readBackRequired: false });
    assert.equal(profile.steps.assess?.artifacts?.["assessment-report"]?.required, true);
  }
});

for (const profile of ["quick", "standard", "governed"] as const) {
  test(`assessment ${profile} 从 intake 到归档全程不创建 Worktree、提交或外部写入`, async () => {
    let externalWrites = 0;
    const fixture = await controlRuntimeFixture({ externalExecutor: { execute: async () => { externalWrites += 1; throw new Error("read-only workflow must not invoke external writes"); }, reconcile: async () => { throw new Error("read-only workflow must not reconcile external writes"); } } });
    const initialHead = await git(fixture.root, "rev-parse", "HEAD");
    const initialWorktrees = await git(fixture.root, "worktree", "list", "--porcelain");
    const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "只读评估当前上线阻塞，给出证据与建议，不修改项目" }, workflowRef: "builtin://workflows/assessment", profile });
    const intake = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
    assert.equal(intake.stepId, "intake");
    const assess = requireExecute(await submitPackage(fixture, intake));
    assert.equal(assess.stepId, "assess");
    await assert.rejects(submitPackage(fixture, assess, completedResult(assess, [])), (error: unknown) => (error as { code?: string }).code === "WSSPEC_REQUIRED_ARTIFACT_MISSING");
    const report = await authorArtifact({ fixture, worktree: fixture.root, workPackage: assess, artifactType: "assessment-report", body: "# 上线评估\n\n范围：当前仓库。\n证据：README.md。\n结论：尚无真实部署验收证据，无法判定上线。\n建议：执行已授权的真实验收。\n未修改代码、未提交、未发布。\n" });
    const action = await submitPackage(fixture, assess, completedResult(assess, [report]));
    assert.equal(action.action, "completed", JSON.stringify(action));
    const projection = await readControlPlane(fixture.root, started.workItemId);
    const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { materialized: boolean };
    assert.equal(locator.materialized, false);
    const archive = JSON.parse(await readFile(path.join(fixture.root, ".wsspec", "archive", started.workItemId, "audit.json"), "utf8")) as { workItemId: string; terminalEventHash: string };
    assert.equal(archive.workItemId, started.workItemId);
    assert.equal(archive.terminalEventHash, projection.lastEventHash);
    assert.equal(await git(fixture.root, "rev-parse", "HEAD"), initialHead);
    assert.equal(await git(fixture.root, "worktree", "list", "--porcelain"), initialWorktrees);
    // Read-only permits engine-owned Artifact/navigation/archive records, not project edits.
    assert.equal(await git(fixture.root, "status", "--porcelain", "--", ".", ":(exclude).wsspec/archive", ":(exclude).wsspec/work-items"), "");
    assert.equal(externalWrites, 0);
    fixture.restart();
    assert.equal((await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" })).action, "completed");
  });
}
