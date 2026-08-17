import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ArchiveError, closeWorkItem } from "../../src/engine/archive.js";
import { verifyWorkItem } from "../../src/engine/verification.js";
import { transitionRuntime } from "../../src/engine/scheduler.js";
import { initializeControlPlane, readControlPlane, recoverControlPlane, writeProjection } from "../../src/storage/control-plane.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "./helpers/git.js";

async function prepare() {
  const root = await createGitRepository(); await initRepository(root); await mkdir(path.join(root, ".wsspec"), { recursive: true });
  const workflow = `version: 1\nworkflow: { id: close }\nstages:\n  - { id: verify, kind: verify, owner: engine, uses: quality.verify, gates: [test], output: [verification-result] }\n  - { id: close, kind: close, owner: engine, uses: work-item.close, needs: [verify] }\n`;
  const config = `version: 1\ntrigger: { mode: suggest }\ngit:\n  worktrees: { enabled: true, root: .worktrees, branchPrefix: wspec/ }\nruntime: { claimTtlSeconds: 60, maxStageRetries: 3 }\nquality:\n  gates:\n    test: { command: [${process.execPath}, -e, process.exit(0)], cwd: worktree, timeoutSeconds: 10, required: true, evidence: trusted }\n`;
  await writeFile(path.join(root, ".wsspec/workflow.yaml"), workflow); await writeFile(path.join(root, ".wsspec/config.yaml"), config); await git(root, "add", "."); await git(root, "commit", "-m", "archive fixture");
  const workItemId = "WSS-ARCHIVE"; const item = await createWorkItem({ root, workItemId, title: "归档", source: { type: "prompt", content: "归档" } }); const worktree = path.join(root, item.execution.worktree);
  await initializeControlPlane({ cwd: root, workItemId, stages: ["verify", "close"] }); await transitionRuntime({ cwd: root, workItemId, scope: "work-item", to: "active", idempotencyKey: "active" });
  return { root, worktree, workItemId };
}

test("close rejects an unverified Work Item", async () => {
  const fixture = await prepare(); await assert.rejects(closeWorkItem({ cwd: fixture.root, workItemId: fixture.workItemId }), (error: unknown) => error instanceof ArchiveError && error.code === "WSSPEC_WORK_ITEM_NOT_VERIFIED");
});

test("close exports an audit snapshot and makes the control plane read-only", async () => {
  const fixture = await prepare(); await verifyWorkItem({ cwd: fixture.root, workItemId: fixture.workItemId }); const closed = await closeWorkItem({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(closed.workItem.status, "closed"); assert.equal(closed.readOnly, true); await access(path.join(fixture.worktree, ".wsspec/archive", fixture.workItemId, "audit.json"));
  await assert.rejects(transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "cancelled", idempotencyKey: "late" }), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_CONTROL_PLANE_READ_ONLY");
  const recovered = await recoverControlPlane({ cwd: fixture.worktree, workItemId: fixture.workItemId }); assert.equal(recovered.readOnly, true);
  await assert.rejects(transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "cancelled", idempotencyKey: "later" }), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_CONTROL_PLANE_READ_ONLY");
});

test("recover rebuilds the archive after a crash following the close event", async () => {
  const fixture = await prepare();
  await verifyWorkItem({ cwd: fixture.root, workItemId: fixture.workItemId });
  const auditPath = path.join(fixture.worktree, ".wsspec/archive", fixture.workItemId, "audit.json");

  await assert.rejects(
    closeWorkItem({ cwd: fixture.root, workItemId: fixture.workItemId, simulateArchiveFailure: true }),
    (error: unknown) => error instanceof ArchiveError && error.code === "WSSPEC_ARCHIVE_WRITE_FAILED",
  );
  await assert.rejects(access(auditPath));

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.workItem.status, "closed");
  assert.equal(recovered.readOnly, true);
  await access(auditPath);
});

test("close rejects incomplete stages and pending approvals", async () => {
  const incomplete = await prepare(); await verifyWorkItem({ cwd: incomplete.root, workItemId: incomplete.workItemId }); const incompleteProjection = await readControlPlane(incomplete.root, incomplete.workItemId); incompleteProjection.stages.build = { status: "pending" }; await writeProjection(incompleteProjection);
  await assert.rejects(closeWorkItem({ cwd: incomplete.root, workItemId: incomplete.workItemId }), (error: unknown) => error instanceof ArchiveError && error.code === "WSSPEC_REQUIRED_STAGE_INCOMPLETE");
  const pending = await prepare(); await verifyWorkItem({ cwd: pending.root, workItemId: pending.workItemId }); const pendingProjection = await readControlPlane(pending.root, pending.workItemId); pendingProjection.approvals.pending = { requestId: "pending", stageId: "verify", attemptId: "attempt", artifactPath: "x", contentHash: "sha256:x", workspaceTreeDigest: "sha256:x", status: "pending", createdAt: new Date().toISOString() }; await writeProjection(pendingProjection);
  await assert.rejects(closeWorkItem({ cwd: pending.root, workItemId: pending.workItemId }), (error: unknown) => error instanceof ArchiveError && error.code === "WSSPEC_APPROVAL_PENDING");
});
