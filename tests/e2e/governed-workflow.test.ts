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
import { readControlPlane, type RuntimeProjection } from "../../src/storage/control-plane.js";

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
    const binding = result.recovered.evidence[`external-binding:${target}`] as Record<string, unknown>;
    const receipt = result.recovered.evidence[`external-receipt:${target}`] as Record<string, unknown>;
    assert.equal(binding.kind, "external-binding");
    assert.equal(binding.target, target);
    assert.equal(binding.exists, true);
    assert.equal(binding.externalWorkItemId, started.workItemId);
    assert.equal(binding.stableId, target === "knowledge" ? "feishu:targetDocumentToken123" : "local:issue");
    assert.equal(binding.publishStepId, target === "issue" ? "update-issue" : "update-wiki");
    assert.match(String(binding.publishAttemptId), /^attempt-/u);
    assert.match(String(binding.publishInputDigest), /^sha256:/u);
    assert.match(String(binding.expectedPublishedContentDigest), /^sha256:/u);
    assert.equal(receipt.kind, "external-receipt");
    assert.equal(receipt.target, target);
    assert.equal(receipt.status, "confirmed");
    assert.equal(receipt.readBackStatus, "confirmed");
    assert.equal(receipt.externalWorkItemId, started.workItemId);
    assert.equal(receipt.stableId, target === "knowledge" ? "feishu:targetDocumentToken123" : "local:issue");
    assert.equal(receipt.publishStepId, binding.publishStepId);
    assert.equal(receipt.publishAttemptId, binding.publishAttemptId);
    assert.equal(receipt.publishInputDigest, binding.publishInputDigest);
    assert.equal(receipt.publishedContentDigest, binding.expectedPublishedContentDigest);
    assert.equal(receipt.readBackContentDigest, receipt.publishedContentDigest);
    const external = JSON.parse(await readFile(path.join(fixture.externalRoot, `${target}.json`), "utf8")) as { workItemId: string };
    assert.equal(external.workItemId, started.workItemId);
  }
  assert.equal(result.snapshot.profiles.governed.audit.level, "complete");
  assert.equal(result.snapshot.profiles.governed.audit.retention, "extended");
  assert.ok(Object.values(result.recovered.approvals).every(({ status }) => status === "approved"));
  assert.equal(Object.values(result.recovered.externalActions).filter(({ status }) => status === "verified").length, 4);
  assert.ok(Object.values(result.recovered.externalActions).every((action) => action.status === "verified" && action.grant.actor === "fixture-owner"));
  assert.deepEqual(result.recoveryEvidence, {
    governedStep: "commit",
    governedAttemptChanged: true,
    governedAttemptsUsed: 2,
    governedLoopMaxIterations: 5,
    governedProfile: "governed",
    governedApprovalCount: 3,
  });

  const worktree = await worktreeFor(fixture.root, started.workItemId);
  const audit = JSON.parse(await readFile(path.join(worktree, ".wsspec", "archive", started.workItemId, "audit.json"), "utf8")) as {
    projection: {
      approvals: Record<string, { status: string; requestedBy?: string; decidedBy?: string; decidedAt?: string }>;
      contexts: Record<string, { actor?: string }>;
      evidence: Record<string, unknown>;
      externalActions: RuntimeProjection["externalActions"];
    };
  };
  const decisions = Object.values(audit.projection.approvals);
  assert.equal(decisions.length, 3);
  assert.ok(decisions.every(({ status, requestedBy, decidedBy, decidedAt }) => status === "approved" && requestedBy !== undefined && decidedBy === "fixture-owner" && decidedAt !== undefined));
  assert.ok(new Set(Object.values(audit.projection.contexts).map(({ actor }) => actor)).has("independent-reviewer"));
  assert.equal(Object.values(audit.projection.externalActions).filter(({ status }) => status === "verified").length, 4);
  for (const target of ["issue", "knowledge"] as const) {
    const binding = audit.projection.evidence[`external-binding:${target}`] as Record<string, unknown>;
    const publishing = audit.projection.evidence[`external-receipt:${target}`] as Record<string, unknown>;
    assert.equal(publishing.target, target);
    assert.equal(publishing.status, "confirmed");
    assert.equal(publishing.readBackStatus, "confirmed");
    assert.equal(publishing.externalWorkItemId, started.workItemId);
    assert.equal(publishing.stableId, target === "knowledge" ? "feishu:targetDocumentToken123" : "local:issue");
    assert.equal(publishing.publishStepId, binding.publishStepId);
    assert.equal(publishing.publishAttemptId, binding.publishAttemptId);
    assert.equal(publishing.publishInputDigest, binding.publishInputDigest);
    assert.equal(publishing.publishedContentDigest, binding.expectedPublishedContentDigest);
    assert.equal(publishing.readBackContentDigest, publishing.publishedContentDigest);
  }
  await assertClosedFeatureWorkflow(fixture, started.workItemId, result);
});

test("Governed rejects publish artifact tampering before creating an external binding", async () => {
  const fixture = await createWorkflowFixture({ externalTargets: true });
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "发布前重新校验输入 Artifact" },
    workflowRef: "builtin://workflows/feature-delivery",
    profile: "governed",
  });

  await assert.rejects(
    executeFeatureWorkflow(fixture, started, {
      first: await fixture.acquire(started.workItemId, "governed-author"),
      implementationActor: "governed-author",
      reviewActors: ["independent-reviewer"],
      reviewApprovals: [true],
      externalTargets: true,
      tamperPublishArtifactAtStep: "update-issue",
    }),
    /WSSPEC_ARTIFACT_REFERENCE_INVALID/u,
  );
  const projection = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(projection.evidence["external-binding:issue"], undefined);
});
