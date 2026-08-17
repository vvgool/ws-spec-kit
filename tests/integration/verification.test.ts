import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { recordReportedEvidence, runTrustedGate, VerificationError, verifyWorkItem } from "../../src/engine/verification.js";
import { transitionRuntime } from "../../src/engine/scheduler.js";
import { initializeControlPlane, readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "./helpers/git.js";

async function prepare(exitCode = 0, script?: string, timeoutSeconds = 10) {
  const root = await createGitRepository(); await initRepository(root); await mkdir(path.join(root, ".wsspec"), { recursive: true });
  const workflow = `version: 1\nworkflow: { id: verify }\nstages:\n  - id: verify\n    kind: verify\n    owner: engine\n    uses: quality.verify\n    gates: [test]\n    output: [verification-result]\n`;
  const command = JSON.stringify([process.execPath, "-e", script ?? `if(process.env.SECRET)process.exit(9); console.log('gate'); process.exit(${exitCode})`]);
  const config = `version: 1\ntrigger: { mode: suggest }\ngit:\n  worktrees: { enabled: true, root: .worktrees, branchPrefix: wspec/ }\nruntime: { claimTtlSeconds: 60, maxStageRetries: 3 }\nquality:\n  gates:\n    test:\n      command: ${command}\n      cwd: worktree\n      timeoutSeconds: ${timeoutSeconds}\n      required: true\n      evidence: trusted\n`;
  await writeFile(path.join(root, ".wsspec/workflow.yaml"), workflow); await writeFile(path.join(root, ".wsspec/config.yaml"), config); await git(root, "add", "."); await git(root, "commit", "-m", "verify fixture");
  const workItemId = `WSK-VERIFY-${exitCode}` as `WSK-${string}`; const item = await createWorkItem({ root, workItemId, title: "验证", source: { type: "prompt", content: "验证" } });
  const worktree = path.join(root, item.execution.worktree); await initializeControlPlane({ cwd: root, workItemId, stages: ["verify"] });
  await transitionRuntime({ cwd: root, workItemId, scope: "work-item", to: "active", idempotencyKey: "active" });
  return { root, worktree, workItemId };
}

test("trusted Gate runs fixed argv with a clean environment and records bound Evidence", async () => {
  const fixture = await prepare(); process.env.SECRET = "must-not-leak";
  try {
    const evidence = await runTrustedGate({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "verify", attemptId: "attempt-verify", gateId: "test" });
    assert.equal(evidence.result, "passed"); assert.equal(evidence.level, "trusted"); assert.match(evidence.recordHash, /^sha256:/);
  } finally { delete process.env.SECRET; }
});

test("Gate timeouts fail and captured output is truncated", async () => {
  const noisy = await prepare(0, "process.stdout.write('x'.repeat(100000))");
  const evidence = await runTrustedGate({ cwd: noisy.root, workItemId: noisy.workItemId, stageId: "verify", attemptId: "attempt-noisy", gateId: "test" });
  assert.equal(evidence.stdout.length, 65536);
  const slow = await prepare(0, "setTimeout(()=>{},5000)", 1);
  const timed = await runTrustedGate({ cwd: slow.root, workItemId: slow.workItemId, stageId: "verify", attemptId: "attempt-slow", gateId: "test" });
  assert.equal(timed.result, "failed");
});

test("Agent supplied command reports can only create reported Evidence", async () => {
  const fixture = await prepare();
  const evidence = await recordReportedEvidence({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "verify", attemptId: "attempt-agent", gateId: "test", claimedLevel: "trusted", result: "passed" });
  assert.equal(evidence.level, "reported");
});

test("required Gate failure blocks verification", async () => {
  const fixture = await prepare(2);
  await assert.rejects(verifyWorkItem({ cwd: fixture.root, workItemId: fixture.workItemId }), (error: unknown) => error instanceof VerificationError && error.code === "WSPEC_REQUIRED_GATE_FAILED");
  assert.equal((await readControlPlane(fixture.root, fixture.workItemId)).workItem.status, "blocked");
});

test("workspace changes invalidate a previously verified Work Item", async () => {
  const fixture = await prepare(); await verifyWorkItem({ cwd: fixture.root, workItemId: fixture.workItemId });
  await writeFile(path.join(fixture.worktree, "after-verification.txt"), "changed\n");
  await assert.rejects(verifyWorkItem({ cwd: fixture.root, workItemId: fixture.workItemId }), (error: unknown) => error instanceof VerificationError && error.code === "WSPEC_WORKSPACE_CHANGED");
});

test("recovery preserves trusted Evidence after projection corruption", async () => {
  const fixture = await prepare();
  const evidence = await runTrustedGate({ cwd: fixture.root, workItemId: fixture.workItemId, stageId: "verify", attemptId: "attempt-recover", gateId: "test" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });

  assert.deepEqual(recovered.evidence[evidence.evidenceId], evidence);
});
