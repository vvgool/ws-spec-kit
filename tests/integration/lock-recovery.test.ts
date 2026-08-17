import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";

import { transitionRuntime } from "../../src/engine/scheduler.js";
import { initializeControlPlane, readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "./helpers/git.js";

async function prepare() {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec/workflow.yaml"), "version: 1\nworkflow: { id: lock }\nstages:\n  - { id: define, kind: define, owner: agent, uses: artifact.generate, output: [specification], approval: { required: true, provider: interactive } }\n");
  await writeFile(path.join(root, ".wsspec/config.yaml"), "version: 1\ntrigger: { mode: suggest }\ngit:\n  worktrees: { enabled: true, root: .worktrees, branchPrefix: wspec/ }\nruntime: { claimTtlSeconds: 60, maxStageRetries: 3 }\nquality:\n  gates:\n    test: { command: [npm, test], cwd: worktree, timeoutSeconds: 60, required: true, evidence: trusted }\n");
  await git(root, "add", "."); await git(root, "commit", "-m", "lock fixture");
  const workItemId = "WSK-LOCK";
  await createWorkItem({ root, workItemId, title: "锁恢复", source: { type: "prompt", content: "锁恢复" } });
  const projection = await initializeControlPlane({ cwd: root, workItemId, stages: ["define"] });
  return { root, workItemId, lockPath: path.join(projection.controlPlane, "runtime.lock") };
}

const hasCode = (error: unknown, code: string) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === code;

test("explicit recover clears a stale lock owned by a dead local process", async () => {
  const fixture = await prepare();
  await writeFile(fixture.lockPath, `${JSON.stringify({ version: 1, ownerToken: "dead-owner", pid: 2147483647, hostname: hostname(), createdAt: new Date().toISOString() })}\n`);

  await assert.rejects(
    transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "activate" }),
    (error: unknown) => hasCode(error, "WSPEC_CONTROL_PLANE_STALE_LOCK"),
  );
  await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  const active = await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "activate" });
  assert.equal(active.workItem.status, "active");
});

test("recover never steals a lock from another host", async () => {
  const fixture = await prepare();
  await writeFile(fixture.lockPath, `${JSON.stringify({ version: 1, ownerToken: "remote-owner", pid: 2147483647, hostname: "different-host.invalid", createdAt: new Date().toISOString() })}\n`);

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSPEC_CONTROL_PLANE_LOCKED"),
  );
});
