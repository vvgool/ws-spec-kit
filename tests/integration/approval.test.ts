import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createApplication } from "../../src/application/application.js";
import { computeArtifactContentHash } from "../../src/domain/artifacts.js";
import { approvalBindingDigest, ApprovalError, decideArtifactApproval, requestArtifactApproval } from "../../src/engine/approvals.js";
import { transitionRuntime } from "../../src/engine/scheduler.js";
import { readControlPlane, recoverControlPlane, writeProjection } from "../../src/storage/control-plane.js";
import { withControlPlaneLock } from "../../src/storage/events.js";
import { initRepository } from "../../src/storage/repository.js";
import { createGitRepository, git } from "./helpers/git.js";

async function prepare() {
  const root = await createGitRepository();
  await initRepository(root);
  const workflow = "version: 1\nactiveWorkflow: { ref: builtin://workflows/feature-delivery, version: 1 }\nprofile: standard\n";
  const config = `version: 1\ntrigger: { mode: suggest }\ngit:\n  worktrees: { enabled: true, root: .worktrees, branchPrefix: wspec/ }\nruntime: { claimTtlSeconds: 60, maxStageRetries: 3 }\nquality:\n  gates:\n    test: { command: [npm, test], cwd: worktree, timeoutSeconds: 60, required: true, evidence: trusted }\n`;
  await mkdir(path.join(root, ".wsspec"), { recursive: true });
  await writeFile(path.join(root, ".wsspec/workflow.yaml"), workflow); await writeFile(path.join(root, ".wsspec/config.yaml"), config);
  await git(root, "add", "."); await git(root, "commit", "-m", "approval fixture");
  const app = createApplication({ provider: "codex", terminal: { isTTY: true }, now: () => new Date("2026-08-18T00:00:00.000Z") });
  const { workItemId } = await app.start({ root, source: { type: "prompt", text: "审批" }, profile: "standard" });
  const projection = await readControlPlane(root, workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  const worktree = path.join(root, locator.worktree);
  for (const [to, key] of [["running", "run"], ["validating", "validate"]] as const) {
    await transitionRuntime({ cwd: root, workItemId, scope: "stage", stageId: "intake", to, idempotencyKey: key });
  }
  const body = ["# 规格", "", "## 目标与背景", "目标", "## 范围", "范围", "## 需求", "需求", "## 验收条件", "条件", "## 约束", "约束", "## 排除项", "无", "## 开放问题", "无", ""].join("\n");
  const metadata = { artifactType: "specification", schemaVersion: 1 as const, workItemId, stageId: "intake", attemptId: "attempt-approval", revision: 1 };
  const contentHash = computeArtifactContentHash(metadata, body); const artifactPath = "artifacts/specification.md";
  await mkdir(path.join(worktree, "artifacts")); await writeFile(path.join(worktree, artifactPath), `---\nartifactType: specification\nschemaVersion: 1\nworkItemId: ${workItemId}\nstageId: intake\nattemptId: attempt-approval\nrevision: 1\ncontentHash: ${contentHash}\n---\n${body}`);
  return { root, worktree, workItemId, artifactPath, contentHash };
}

test("single-Artifact approval digest binds stage, attempt and the complete reference", () => {
  const reference = {
    artifactType: "specification",
    artifactId: "artifact-a",
    schemaVersion: 1,
    path: "artifacts/specification.md",
    revision: 1,
    contentHash: "sha256:same-content",
    mediaType: "text/markdown",
  };
  const original = approvalBindingDigest({ stageId: "define", attemptId: "attempt-a", artifacts: [reference] });
  const variants = [
    { stageId: "design", attemptId: "attempt-a", artifacts: [reference] },
    { stageId: "define", attemptId: "attempt-b", artifacts: [reference] },
    { stageId: "define", attemptId: "attempt-a", artifacts: [{ ...reference, artifactId: "artifact-b" }] },
    { stageId: "define", attemptId: "attempt-a", artifacts: [{ ...reference, path: "artifacts/other.md" }] },
    { stageId: "define", attemptId: "attempt-a", artifacts: [{ ...reference, schemaVersion: 2 }] },
    { stageId: "define", attemptId: "attempt-a", artifacts: [{ ...reference, revision: 2 }] },
    { stageId: "define", attemptId: "attempt-a", artifacts: [{ ...reference, mediaType: "application/json" }] },
  ];

  for (const variant of variants) assert.notEqual(approvalBindingDigest(variant), original);
});

test("non-TTY input cannot approve an Artifact", async () => {
  const fixture = await prepare(); const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: fixture.artifactPath, artifactType: "specification" });
  await assert.rejects(decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: false } }), (error: unknown) => error instanceof ApprovalError && error.code === "WSSPEC_INTERACTIVE_TTY_REQUIRED");
});

test("approval expires when the bound workspace changes", async () => {
  const fixture = await prepare(); const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: fixture.artifactPath, artifactType: "specification" });
  await writeFile(path.join(fixture.worktree, "changed.txt"), "changed\n");
  await assert.rejects(decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: true } }), (error: unknown) => error instanceof ApprovalError && error.code === "WSSPEC_APPROVAL_EXPIRED");
});

test("a stale expiration cannot overwrite a completed approval decision", async () => {
  const fixture = await prepare();
  const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: fixture.artifactPath, artifactType: "specification" });
  await writeFile(path.join(fixture.worktree, "changed.txt"), "changed\n");
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  let expiring: Promise<unknown> | undefined;
  await withControlPlaneLock(projection.controlPlane, async () => {
    expiring = decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: true } });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const decided = await readControlPlane(fixture.root, fixture.workItemId);
    decided.approvals[request.requestId] = { ...request, status: "approved", decidedAt: new Date().toISOString() };
    decided.stages.intake = { status: "succeeded" };
    await writeProjection(decided);
  });
  assert.ok(expiring);
  await assert.rejects(
    expiring,
    (error: unknown) => error instanceof ApprovalError && error.code === "WSSPEC_APPROVAL_NOT_PENDING",
  );
  assert.equal((await readControlPlane(fixture.root, fixture.workItemId)).approvals[request.requestId]?.status, "approved");
});

test("an approval decision revalidates the workspace after acquiring the control-plane lock", async () => {
  const fixture = await prepare();
  const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: fixture.artifactPath, artifactType: "specification" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  let deciding: Promise<unknown> | undefined;
  await withControlPlaneLock(projection.controlPlane, async () => {
    deciding = decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: true } });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await writeFile(path.join(fixture.worktree, "changed-while-waiting.txt"), "changed\n");
  });
  assert.ok(deciding);
  await assert.rejects(
    deciding,
    (error: unknown) => error instanceof ApprovalError && error.code === "WSSPEC_APPROVAL_EXPIRED",
  );
  const current = await readControlPlane(fixture.root, fixture.workItemId);
  assert.equal(current.approvals[request.requestId]?.status, "expired");
  assert.notEqual(current.stages.intake?.status, "succeeded");
});

test("TTY decisions approve or reject the exact pending request", async () => {
  const approvedFixture = await prepare(); const approvedRequest = await requestArtifactApproval({ cwd: approvedFixture.root, workItemId: approvedFixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: approvedFixture.artifactPath, artifactType: "specification" });
  const approved = await decideArtifactApproval({ cwd: approvedFixture.root, workItemId: approvedFixture.workItemId, requestId: approvedRequest.requestId, decision: "approve", terminal: { isTTY: true } }); assert.equal(approved.status, "approved");
  const rejectedFixture = await prepare(); const rejectedRequest = await requestArtifactApproval({ cwd: rejectedFixture.root, workItemId: rejectedFixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: rejectedFixture.artifactPath, artifactType: "specification" });
  const rejected = await decideArtifactApproval({ cwd: rejectedFixture.root, workItemId: rejectedFixture.workItemId, requestId: rejectedRequest.requestId, decision: "reject", terminal: { isTTY: true }, reason: "需要修订" }); assert.equal(rejected.status, "rejected");
});

test("approval persistence excludes environment preauthorization and terminal secrets", async () => {
  const fixture = await prepare(); const secret = `secret-${crypto.randomUUID()}`; process.env.WSSPEC_APPROVAL = secret;
  try {
    const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: fixture.artifactPath, artifactType: "specification" });
    await decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: true } });
    const projection = await readControlPlane(fixture.root, fixture.workItemId); const persisted = `${await readFile(path.join(projection.controlPlane, "runtime.json"), "utf8")}\n${await readFile(path.join(projection.controlPlane, "events.jsonl"), "utf8")}`;
    assert.doesNotMatch(persisted, new RegExp(secret));
  } finally { delete process.env.WSSPEC_APPROVAL; }
});

test("recovery preserves completed approval history after projection corruption", async () => {
  const fixture = await prepare();
  const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: fixture.artifactPath, artifactType: "specification" });
  await decideArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, requestId: request.requestId, decision: "approve", terminal: { isTTY: true } });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });

  assert.equal(recovered.approvals[request.requestId]?.status, "approved");
  assert.equal(recovered.stages.intake?.status, "succeeded");
});

test("recovery preserves a durable pending approval and its audit record", async () => {
  const fixture = await prepare();
  const request = await requestArtifactApproval({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "intake", attemptId: "attempt-approval", artifactPath: fixture.artifactPath, artifactType: "specification" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });

  assert.equal(recovered.approvals[request.requestId]?.status, "pending");
  assert.equal(recovered.workItem.status, "awaiting_approval");
  assert.equal(recovered.stages.intake?.status, "awaiting_approval");
});
