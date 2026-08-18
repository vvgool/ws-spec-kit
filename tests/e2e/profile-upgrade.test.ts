import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClosedFeatureWorkflow,
  createWorkflowFixture,
  executeFeatureWorkflow,
} from "./helpers/workflow-fixture.js";

test("Quick upgrades in flight to Governed, adds design, invalidates compact work, and resumes the upgrade event", async () => {
  const fixture = await createWorkflowFixture({ externalTargets: true });
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "先按 Quick 开始，运行中发现高风险后升档" },
    workflowRef: "builtin://workflows/feature-delivery",
    profile: "quick",
  });

  const result = await executeFeatureWorkflow(fixture, started, {
    first: await fixture.acquire(started.workItemId, "upgrade-author"),
    implementationActor: "upgrade-author",
    reviewActors: ["upgrade-reviewer"],
    reviewApprovals: [true],
    externalTargets: true,
    upgradeAtStep: "write-tests",
    interruptAfterProfileUpgrade: true,
  });

  assert.equal(result.recovered.profile.selected, "governed");
  assert.equal(result.recovered.profile.mode, "quick");
  assert.equal(result.projection.stages.design?.status, "succeeded");
  assert.equal(result.artifacts.specification.contentLevel, "complete");
  assert.equal(result.artifacts.design?.contentLevel, "complete");
  assert.equal(result.artifacts.tasks.contentLevel, "complete");
  assert.equal(result.recovered.loops["review-fix"]?.maxIterations, 5);
  assert.equal(result.recoveryEvidence.upgradeStep, "clarify");
  assert.equal(result.recoveryEvidence.upgradeAttemptsUsed, 2);
  assert.ok(result.events.some(({ eventType }) => eventType === "profile.upgraded"));
  assert.ok(result.events.some(({ eventType, result: eventResult }) =>
    eventType === "profile.upgraded" && JSON.stringify(eventResult).includes("design")));
  assert.ok(Object.values(result.recovered.approvals).filter(({ status }) => status === "approved").length >= 4);
  await assertClosedFeatureWorkflow(fixture, started.workItemId, result);
});
