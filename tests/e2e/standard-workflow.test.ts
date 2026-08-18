import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClosedFeatureWorkflow,
  createWorkflowFixture,
  executeFeatureWorkflow,
} from "./helpers/workflow-fixture.js";

test("Standard executes approved complete artifacts and resumes the two-round Review-Fix loop", async () => {
  const fixture = await createWorkflowFixture();
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "按完整设计交付本地 feature" },
    workflowRef: "builtin://workflows/feature-delivery",
    profile: "standard",
  });

  const result = await executeFeatureWorkflow(fixture, started, {
    first: await fixture.acquire(started.workItemId, "standard-author"),
    implementationActor: "standard-author",
    reviewActors: ["standard-reviewer", "standard-reviewer"],
    reviewApprovals: [false, true],
    interruptAfterLoopSubmit: true,
  });

  assert.equal(result.artifacts.specification.contentLevel, "complete");
  assert.equal(result.artifacts.design?.contentLevel, "complete");
  assert.equal(result.artifacts.tasks.contentLevel, "complete");
  assert.equal(result.projection.loops["review-fix"]?.iteration, 2);
  assert.equal(result.recoveryEvidence.loopStep, "review-fix:1:fix");
  assert.equal(result.recoveryEvidence.loopAttemptsUsed, 2);
  assert.ok(Object.values(result.recovered.approvals).filter(({ status }) => status === "approved").length >= 3);
  assert.ok(result.recovered.evidence["verify-green:gate:test"]);
  await assertClosedFeatureWorkflow(fixture, started.workItemId, result);
});
