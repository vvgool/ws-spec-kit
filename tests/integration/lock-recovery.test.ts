import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplication } from "../../src/application/application.js";
import { transitionRuntime } from "../../src/engine/scheduler.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { defaultProjectConfig, initRepository } from "../../src/storage/repository.js";
import { stringify } from "yaml";
import { createGitRepository, git } from "./helpers/git.js";

async function prepare() {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec/workflow.yaml"), "version: 1\nactiveWorkflow: { ref: builtin://workflows/feature-delivery, version: 1 }\nprofile: standard\n");
  await writeFile(path.join(root, ".wsspec/config.yaml"), stringify({
    ...defaultProjectConfig(),
    trigger: { mode: "suggest" },
    git: { worktrees: { enabled: true, root: ".worktrees", branchPrefix: "wspec/" } },
    runtime: { claimTtlSeconds: 60, maxStageRetries: 3 },
  }, { lineWidth: 0 }));
  await git(root, "add", "."); await git(root, "commit", "-m", "lock fixture");
  const app = createApplication({ provider: "codex", terminal: { isTTY: true }, now: () => new Date("2026-08-18T00:00:00.000Z") });
  const { workItemId } = await app.start({ root, source: { type: "prompt", text: "锁恢复" }, profile: "standard" });
  const projection = await readControlPlane(root, workItemId);
  return { root, workItemId, lockPath: path.join(projection.controlPlane, "runtime.lock") };
}

const hasCode = (error: unknown, code: string) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === code;

test("explicit recover clears a stale lock owned by a dead local process", async () => {
  const fixture = await prepare();
  await writeFile(fixture.lockPath, `${JSON.stringify({ version: 1, ownerToken: "dead-owner", pid: 2147483647, hostname: hostname(), createdAt: new Date().toISOString() })}\n`);

  await assert.rejects(
    transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "verify" }),
    (error: unknown) => hasCode(error, "WSSPEC_CONTROL_PLANE_STALE_LOCK"),
  );
  await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  const verifying = await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "verify" });
  assert.equal(verifying.workItem.status, "verifying");
});

test("recover never steals a lock from another host", async () => {
  const fixture = await prepare();
  await writeFile(fixture.lockPath, `${JSON.stringify({ version: 1, ownerToken: "remote-owner", pid: 2147483647, hostname: "different-host.invalid", createdAt: new Date().toISOString() })}\n`);

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_CONTROL_PLANE_LOCKED"),
  );
});
