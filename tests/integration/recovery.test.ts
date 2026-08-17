import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initializeControlPlane, readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { ControlPlaneError, transitionRuntime } from "../../src/engine/scheduler.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "./helpers/git.js";

const workflow = `version: 1
workflow:
  id: recovery-test
stages:
  - id: define
    kind: define
    owner: agent
    uses: specification.write
    output: [specification]
    approval:
      required: true
      provider: interactive
`;

const config = `version: 1
trigger:
  mode: suggest
git:
  worktrees:
    enabled: true
    root: .worktrees
    branchPrefix: wspec/
runtime:
  claimTtlSeconds: 1800
  maxStageRetries: 3
quality:
  gates:
    test:
      command: [npm, test]
      cwd: worktree
      timeoutSeconds: 900
      required: true
      evidence: trusted
`;

async function prepare(): Promise<{ root: string; worktree: string; workItemId: string }> {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "workflow.yaml"), workflow, "utf8");
  await writeFile(path.join(root, ".wsspec", "config.yaml"), config, "utf8");
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "chore: configure recovery fixture");
  const workItemId = "WSK-20260816-RECOVERY";
  const item = await createWorkItem({
    root,
    workItemId,
    title: "恢复测试",
    source: { type: "prompt", content: "验证事件恢复" },
    createdAt: "2026-08-16T12:00:00+08:00",
  });
  const worktree = path.join(root, item.execution.worktree);
  await initializeControlPlane({ cwd: root, workItemId, stages: ["define"] });
  return { root, worktree, workItemId };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as Error & { code: string }).code === code;
}

test("replays an appended event when projection persistence fails", async () => {
  const fixture = await prepare();
  await assert.rejects(
    transitionRuntime({
      cwd: fixture.root,
      workItemId: fixture.workItemId,
      scope: "work-item",
      to: "active",
      idempotencyKey: "activate-after-create",
      simulateProjectionFailure: true,
    }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "WSPEC_PROJECTION_WRITE_FAILED",
  );
  assert.equal((await readControlPlane(fixture.root, fixture.workItemId)).workItem.status, "draft");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.workItem.status, "active");
  assert.equal(recovered.lastSequence, 1);
});

test("repeated idempotency keys return the original transition without another event", async () => {
  const fixture = await prepare();
  const input = {
    cwd: fixture.root,
    workItemId: fixture.workItemId,
    scope: "work-item" as const,
    to: "active" as const,
    idempotencyKey: "activate-once",
  };
  const first = await transitionRuntime(input);
  const second = await transitionRuntime(input);
  assert.deepEqual(second, first);
  assert.equal(second.lastSequence, 1);
});

test("idempotent retry after later events returns the original operation result", async () => {
  const fixture = await prepare();
  const activation = {
    cwd: fixture.root,
    workItemId: fixture.workItemId,
    scope: "work-item" as const,
    to: "active" as const,
    idempotencyKey: "activation-result",
  };
  const first = await transitionRuntime(activation);
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "define", to: "ready", idempotencyKey: "define-ready" });

  const retried = await transitionRuntime(activation);

  assert.deepEqual(retried, first);
  assert.equal((await readControlPlane(fixture.root, fixture.workItemId)).lastSequence, 2);
});

test("reusing an idempotency key with different input fails closed", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "shared-key" });

  await assert.rejects(
    transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "shared-key" }),
    (error: unknown) => hasCode(error, "WSPEC_IDEMPOTENCY_CONFLICT"),
  );
});

test("separate real worktrees share one locked control plane", async () => {
  const fixture = await prepare();
  const [fromRoot, fromWorktree] = await Promise.all([
    transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "shared-activation" }),
    transitionRuntime({ cwd: fixture.worktree, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "shared-activation" }),
  ]);
  assert.deepEqual(fromWorktree, fromRoot);
  assert.deepEqual(await readControlPlane(fixture.worktree, fixture.workItemId), fromRoot);
  assert.equal(fromRoot.lastSequence, 1);
});

test("recovery rejects a broken event hash chain", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "activate" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const eventLog = path.join(projection.controlPlane, "events.jsonl");
  const events = (await readFile(eventLog, "utf8")).replace('"to":"active"', '"to":"verified"');
  await writeFile(eventLog, events, "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSPEC_EVENT_CHAIN_INVALID"),
  );
});

test("recovery discards only an incomplete final event line", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "activate" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const eventLog = path.join(projection.controlPlane, "events.jsonl");
  await writeFile(eventLog, `${await readFile(eventLog, "utf8")}{\"eventId\":\"partial`, "utf8");
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });

  assert.equal(recovered.workItem.status, "active");
  assert.equal(recovered.lastSequence, 1);
  assert.match(await readFile(eventLog, "utf8"), /\n$/);
});

test("recovery rejects a valid event prefix truncated behind the durable projection", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "activate" });
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "verify" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const eventLog = path.join(projection.controlPlane, "events.jsonl");
  const [first] = (await readFile(eventLog, "utf8")).trimEnd().split("\n");
  await writeFile(eventLog, `${first}\n`, "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSPEC_EVENT_CHAIN_INVALID"),
  );
});

test("recovery rejects repository identity mismatch", async () => {
  const fixture = await prepare();
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const runtimePath = path.join(projection.controlPlane, "runtime.json");
  await writeFile(runtimePath, `${JSON.stringify({ ...projection, repositoryId: "repo-00000000000000000000000000" }, null, 2)}\n`, "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSPEC_REPOSITORY_ID_MISMATCH"),
  );
});

test("recovery cancels an unfinished approval state instead of inheriting it", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "activate" });
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "define", to: "ready", idempotencyKey: "ready" });
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "define", to: "running", idempotencyKey: "run" });
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "define", to: "validating", idempotencyKey: "validate" });
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "define", to: "awaiting_approval", idempotencyKey: "approval" });

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.workItem.status, "active");
  assert.equal(recovered.stages.define?.status, "ready");
  assert.ok(recovered.lastSequence > 5);
});

test("recovery rebuilds a damaged projection from immutable metadata and the complete event chain", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "active", idempotencyKey: "activate" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.worktree, workItemId: fixture.workItemId });
  assert.equal(recovered.workItem.status, "active");
  assert.equal(recovered.lastSequence, 1);
});
