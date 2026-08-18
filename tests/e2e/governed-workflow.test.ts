import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertClosedFeatureWorkflow,
  createWorkflowFixture,
  executeFeatureWorkflow,
  worktreeFor,
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
    interruptAfterApprovalStep: "commit",
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
  assert.deepEqual(result.recoveryEvidence, {
    governedStep: "update-issue",
    governedAttemptChanged: true,
    governedAttemptsUsed: 2,
    governedLoopMaxIterations: 5,
    governedProfile: "governed",
    governedApprovalCount: 4,
  });

  const worktree = await worktreeFor(fixture.root, started.workItemId);
  const audit = JSON.parse(await readFile(path.join(worktree, ".wsspec", "archive", started.workItemId, "audit.json"), "utf8")) as {
    projection: {
      approvals: Record<string, { status: string; requestedBy?: string; decidedBy?: string; decidedAt?: string }>;
      contexts: Record<string, { actor?: string }>;
      evidence: Record<string, unknown>;
    };
  };
  const decisions = Object.values(audit.projection.approvals);
  assert.equal(decisions.length, 5);
  assert.ok(decisions.every(({ status, requestedBy, decidedBy, decidedAt }) => status === "approved" && requestedBy !== undefined && decidedBy === "fixture-owner" && decidedAt !== undefined));
  assert.ok(new Set(Object.values(audit.projection.contexts).map(({ actor }) => actor)).has("independent-reviewer"));
  for (const target of ["issue", "knowledge"] as const) {
    const publishing = audit.projection.evidence[`external-receipt:${target}`] as { target?: string; status?: string; readBack?: boolean };
    assert.deepEqual(publishing, { ...publishing, target, status: "confirmed", readBack: true });
  }
  await assertClosedFeatureWorkflow(fixture, started.workItemId, result);
});
