import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertClosedFeatureWorkflow,
  createWorkflowFixture,
  executeFeatureWorkflow,
} from "./helpers/workflow-fixture.js";

test("Governed requires an independent reviewer, complete audit, and read-back local receipts", async () => {
  const fixture = await createWorkflowFixture({ externalTargets: true });
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "以 Governed 交付并发布到本地可回读目标" },
    workflowRef: "builtin://workflows/feature-delivery",
    profile: "governed",
  });

  const result = await executeFeatureWorkflow(fixture, started, {
    first: await fixture.acquire(started.workItemId, "governed-author"),
    implementationActor: "governed-author",
    reviewActors: ["independent-reviewer"],
    reviewApprovals: [true],
    externalTargets: true,
  });

  const review = result.recovered.contexts["review-fix:1:review"] as { actor?: string };
  const implementation = result.recovered.contexts.implement as { actor?: string };
  assert.equal(review.actor, "independent-reviewer");
  assert.notEqual(review.actor, implementation.actor);
  for (const target of ["issue", "knowledge"] as const) {
    const receipt = result.recovered.evidence[`external-receipt:${target}`] as Record<string, unknown>;
    assert.deepEqual(
      { kind: receipt.kind, target: receipt.target, status: receipt.status, readBack: receipt.readBack },
      { kind: "external-receipt", target, status: "confirmed", readBack: true },
    );
    const external = JSON.parse(await readFile(path.join(fixture.externalRoot, `${target}.json`), "utf8")) as { workItemId: string };
    assert.equal(external.workItemId, started.workItemId);
  }
  assert.equal(result.snapshot.profiles.governed.audit.level, "complete");
  assert.equal(result.snapshot.profiles.governed.audit.retention, "extended");
  assert.ok(Object.values(result.recovered.approvals).every(({ status }) => status === "approved"));
  await assertClosedFeatureWorkflow(fixture, started.workItemId, result);
});
