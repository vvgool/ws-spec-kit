import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClosedFeatureWorkflow,
  createWorkflowFixture,
  executeFeatureWorkflow,
  interruptAfterAcquire,
} from "./helpers/workflow-fixture.js";

test("Quick executes compact TDD delivery and resumes an acquired attempt from the event log", async () => {
  const fixture = await createWorkflowFixture();
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "将本地 feature value 从 0 改为 1" },
    workflowRef: "builtin://workflows/feature-delivery",
    profile: "quick",
  });

  const first = await fixture.acquire(started.workItemId, "quick-author");
  assert.equal(first.stepId, "intake");
  const resumed = await interruptAfterAcquire(fixture, started, first, "quick-author");
  assert.notEqual(resumed.attemptId, first.attemptId);

  const result = await executeFeatureWorkflow(fixture, started, {
    first: resumed,
    implementationActor: "quick-author",
    reviewActors: ["quick-reviewer"],
    reviewApprovals: [true],
  });

  assert.deepEqual(result.snapshot.profiles.quick.order.includes("design"), true);
  assert.equal(result.projection.stages.design?.status, "skipped");
  assert.equal(result.artifacts.specification.contentLevel, "compact");
  assert.equal(result.artifacts.tasks.contentLevel, "compact");
  assert.equal(result.projection.loops["review-fix"]?.iteration, 1);
  assert.equal(result.recovered.retries.intake, undefined);
  assert.equal(result.recoveryEvidence.intakeAttemptsUsed, 2);
  await assertClosedFeatureWorkflow(fixture, started.workItemId, result);
});
