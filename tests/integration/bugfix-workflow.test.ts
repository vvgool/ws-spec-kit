import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadBuiltinCatalog } from "../../src/resources/catalog.js";
import { authorArtifact, completedResult, controlRuntimeFixture, requireExecute, submitPackage } from "./helpers/control-runtime.js";

for (const risk of ["low", "high"] as const) {
  test(`bugfix merges diagnosis and planning while ${risk} risk follows its profile gate`, async () => {
    const fixture = await controlRuntimeFixture({now: () => new Date()});
    const started = await fixture.app.start({root: fixture.root, source: {type: "prompt", text: "修复解析错误"}, workflowRef: "builtin://workflows/bugfix-delivery", profile: "auto"});
    const intake = requireExecute(await fixture.app.acquire({root: fixture.root, workItemId: started.workItemId, actor: "codex"}));
    const diagnosis = requireExecute(await submitPackage(fixture, intake));
    assert.equal(diagnosis.stepId, "explore");
    assert.deepEqual(diagnosis.skills.map(skill => skill.ref), ["builtin://skills/bugfix-diagnosis"]);
    assert.equal(diagnosis.workspace?.materialized, false);
    assert.deepEqual(diagnosis.requiredOutputs.map(output => output.artifactType), ["tasks"]);
    const skill = (await loadBuiltinCatalog()).skills.find(skill => skill.id === "bugfix-diagnosis");
    assert.ok(skill);
    const instructions = await readFile(skill.entry, "utf8");
    const example = instructions.slice(instructions.indexOf("## 任务\n"));
    const tasks = await authorArtifact({fixture, worktree: fixture.root, workPackage: diagnosis, artifactType: "tasks", body: example});
    const action = await submitPackage(fixture, diagnosis, {...completedResult(diagnosis, [tasks]), remainingRisks: [{level: risk}]});
    const view = await fixture.app.inspect({root: fixture.root, workItemId: started.workItemId});
    if (risk === "low") {
      assert.equal(view.profile, "quick");
      assert.equal(requireExecute(action).stepId, "write-tests");
    } else {
      assert.equal(view.profile, "governed");
      assert.notEqual(action.action === "execute" ? action.workPackage.stepId : action.action, "write-tests");
    }
  });
}
