import assert from "node:assert/strict";
import { mkdir, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approveExternalAction,
  ExternalActionError,
  type ExternalActionGrant,
} from "../../src/application/external-action.js";
import { loadApplicationState } from "../../src/application/state.js";
import { assertGrantAuthorizes } from "../../src/engine/external-effects/authorization.js";
import { readControlPlane } from "../../src/storage/control-plane.js";
import {
  applicationExternalActionFixture,
  externalActionFixture,
  prepareInput,
  preparedAction,
  submitExternalAction,
} from "./helpers/external-action.js";
import { completedResult } from "./helpers/control-runtime.js";

async function payloadArtifactNames(root: string, workItemId: string): Promise<string[]> {
  const projection = await readControlPlane(root, workItemId);
  try {
    return (await readdir(path.join(projection.controlPlane, "external-actions", "payloads"))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function replaceAttemptWhileMutationWaits<T>(input: {
  root: string;
  workItemId: string;
  stepId: string;
  operation(): Promise<T>;
}): Promise<T> {
  const projection = await readControlPlane(input.root, input.workItemId);
  const claim = projection.claims[input.stepId]!;
  const context = projection.contexts[input.stepId] as { workPackage: { attemptId: string } };
  const lockPath = path.join(projection.controlPlane, "runtime.lock");
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    ownerToken: "test-race-lock",
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  })}\n`, { flag: "wx", mode: 0o600 });
  const operation = input.operation();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const replacedAttemptId = `${claim.attemptId}-replaced`;
    projection.claims[input.stepId] = { ...claim, attemptId: replacedAttemptId };
    projection.contexts[input.stepId] = {
      ...context,
      workPackage: { ...context.workPackage, attemptId: replacedAttemptId },
    };
    await writeFile(
      path.join(projection.controlPlane, "runtime.json"),
      `${JSON.stringify({ ...projection, controlPlane: undefined }, null, 2)}\n`,
      "utf8",
    );
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
  return operation;
}

test("credential-like payload is rejected before persistence", async () => {
  const fixture = await externalActionFixture();
  await assert.rejects(
    (await import("../../src/application/external-action.js")).prepareExternalAction(
      prepareInput(fixture.root, fixture.workPackage, { payload: { body: "Authorization: Bearer fixture-secret" } }),
    ),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_PAYLOAD_INVALID",
  );
  assert.deepEqual((await readControlPlane(fixture.root, fixture.workItemId)).externalActions, {});
});

test("stale Attempt rejection leaves no payload artifact", async () => {
  const fixture = await externalActionFixture();
  assert.deepEqual(await payloadArtifactNames(fixture.root, fixture.workItemId), []);
  await assert.rejects(replaceAttemptWhileMutationWaits({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: fixture.workPackage.stepId,
    operation: () => import("../../src/application/external-action.js").then(({ prepareExternalAction }) =>
      prepareExternalAction(prepareInput(fixture.root, fixture.workPackage))),
  }), (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_ATTEMPT_MISMATCH");
  assert.deepEqual(await payloadArtifactNames(fixture.root, fixture.workItemId), []);
});

test("same-Attempt target conflict does not grow payload artifacts", async () => {
  const fixture = await preparedAction();
  const before = await payloadArtifactNames(fixture.root, fixture.workItemId);
  await assert.rejects(
    import("../../src/application/external-action.js").then(({ prepareExternalAction }) => prepareExternalAction({
      ...fixture.input,
      payload: { body: "conflicting release summary" },
    })),
    (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(await payloadArtifactNames(fixture.root, fixture.workItemId), before);
});

test("explicit idempotency conflict does not grow payload artifacts", async () => {
  const fixture = await preparedAction();
  const before = await payloadArtifactNames(fixture.root, fixture.workItemId);
  await assert.rejects(
    import("../../src/application/external-action.js").then(({ prepareExternalAction }) => prepareExternalAction({
      ...fixture.input,
      payload: { body: "conflicting release summary" },
      idempotencyKey: fixture.prepared.request.idempotencyKey,
    })),
    (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(await payloadArtifactNames(fixture.root, fixture.workItemId), before);
});

test("concurrent conflicting prepare persists only the winning payload", async () => {
  const fixture = await externalActionFixture();
  const { prepareExternalAction } = await import("../../src/application/external-action.js");
  const results = await Promise.allSettled([
    prepareExternalAction(prepareInput(fixture.root, fixture.workPackage, { payload: { body: "candidate one" } })),
    prepareExternalAction(prepareInput(fixture.root, fixture.workPackage, { payload: { body: "candidate two" } })),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await payloadArtifactNames(fixture.root, fixture.workItemId)).length, 1);
});

test("successful exact prepare retry reuses its payload artifact", async () => {
  const fixture = await preparedAction();
  const before = await payloadArtifactNames(fixture.root, fixture.workItemId);
  const { prepareExternalAction } = await import("../../src/application/external-action.js");
  const retried = await prepareExternalAction(fixture.input);
  assert.deepEqual(retried, fixture.prepared);
  assert.deepEqual(await payloadArtifactNames(fixture.root, fixture.workItemId), before);
});

test("payload persistence rejects an external-actions symlink before writing through it", async () => {
  const fixture = await externalActionFixture();
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const outside = path.join(fixture.root, "outside-external-actions");
  await mkdir(outside);
  await symlink(outside, path.join(projection.controlPlane, "external-actions"));
  const { prepareExternalAction } = await import("../../src/application/external-action.js");
  await assert.rejects(
    prepareExternalAction(prepareInput(fixture.root, fixture.workPackage)),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_PAYLOAD_ARTIFACT_INVALID",
  );
  assert.deepEqual(await readdir(outside), []);
});

test("payload persistence rejects a payloads symlink without writing outside", async () => {
  const fixture = await externalActionFixture();
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const outside = path.join(fixture.root, "outside-payloads");
  const externalActions = path.join(projection.controlPlane, "external-actions");
  await mkdir(outside);
  await mkdir(externalActions);
  await symlink(outside, path.join(externalActions, "payloads"));
  const { prepareExternalAction } = await import("../../src/application/external-action.js");
  await assert.rejects(
    prepareExternalAction(prepareInput(fixture.root, fixture.workPackage)),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_PAYLOAD_ARTIFACT_INVALID",
  );
  assert.deepEqual(await readdir(outside), []);
});

test("grant is bound to request, actor, approval, profile, workspace, config, target, digest, and Attempt", async () => {
  const fixture = await preparedAction();
  const grant = await approveExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: fixture.prepared.request.requestId,
    expectedRequestDigest: fixture.prepared.request.requestDigest,
    actor: "maintainer",
    approvalDigest: fixture.prepared.request.requestDigest,
    profile: "standard",
    profileDigest: fixture.prepared.request.profileDigest,
    workspaceDigest: fixture.prepared.request.workspaceDigest,
    configDigest: fixture.prepared.request.configDigest,
    decidedAt: "2026-08-18T04:00:10.000Z",
    expiresAt: "2026-08-18T04:00:50.000Z",
    terminal: { isTTY: true },
  });
  assert.equal(grant.status, "approved");
  assert.doesNotThrow(() => assertGrantAuthorizes(grant.request, grant.grant, new Date("2026-08-18T04:00:20.000Z")));

  for (const forged of [
    { ...grant.grant, attemptId: "attempt-other" },
    { ...grant.grant, target: { ...grant.grant.target, stableId: "github:example/project#43" } },
    { ...grant.grant, payloadDigest: "sha256:changed" },
    { ...grant.grant, configDigest: "sha256:changed" },
  ] as ExternalActionGrant[]) {
    assert.throws(() => assertGrantAuthorizes(grant.request, forged, new Date("2026-08-18T04:00:20.000Z")),
      (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_GRANT_MISMATCH");
  }
});

test("wrong digest, expired decision, and non-TTY approval fail closed", async (t) => {
  for (const scenario of [
    { name: "wrong digest", expectedRequestDigest: "sha256:wrong", decidedAt: "2026-08-18T04:00:10.000Z", terminal: { isTTY: true }, code: "WSSPEC_EXTERNAL_REQUEST_DIGEST_MISMATCH" },
    { name: "expired", expectedRequestDigest: undefined, decidedAt: "2026-08-18T05:00:00.000Z", terminal: { isTTY: true }, code: "WSSPEC_EXTERNAL_REQUEST_EXPIRED" },
    { name: "non tty", expectedRequestDigest: undefined, decidedAt: "2026-08-18T04:00:10.000Z", terminal: { isTTY: false }, code: "WSSPEC_INTERACTIVE_TTY_REQUIRED" },
  ] as const) {
    await t.test(scenario.name, async () => {
      const fixture = await preparedAction();
      await assert.rejects(approveExternalAction({
        root: fixture.root,
        workItemId: fixture.workItemId,
        requestId: fixture.prepared.request.requestId,
        expectedRequestDigest: scenario.expectedRequestDigest ?? fixture.prepared.request.requestDigest,
        actor: "maintainer",
        approvalDigest: fixture.prepared.request.requestDigest,
        profile: "standard",
        profileDigest: fixture.prepared.request.profileDigest,
        workspaceDigest: fixture.prepared.request.workspaceDigest,
        configDigest: fixture.prepared.request.configDigest,
        decidedAt: scenario.decidedAt,
        expiresAt: "2026-08-18T04:00:50.000Z",
        terminal: scenario.terminal,
      }), (error: unknown) => error instanceof ExternalActionError && error.code === scenario.code);
    });
  }
});

test("application submit exposes a payload-free external approval and decide resumes the same Attempt without writing", async () => {
  let writes = 0;
  const fixture = await applicationExternalActionFixture({
    async execute({ request, markDispatched }) {
      await markDispatched();
      writes += 1;
      return { targetStableId: request.target.stableId, publishedContentDigest: request.expectedContentDigest, readBackContentDigest: request.expectedContentDigest, verifiedAt: "2026-08-18T04:01:00.000Z" };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });

  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected external approval");
  assert.deepEqual(pending.approval, {
    kind: "external_action",
    requestId: pending.approval.requestId,
    workItemId: fixture.workItemId,
    title: "github issue.update github:example/project#42",
    digest: pending.approval.digest,
    provider: "github",
    action: "issue.update",
    target: { kind: "issue", stableId: "github:example/project#42" },
    sideEffects: ["更新 Issue 正文"],
  });
  assert.equal(JSON.stringify(pending).includes("fixture-secret"), false);
  assert.equal(writes, 0);

  const resumed = await fixture.app.decide({
    kind: "external_action",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved",
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  } as never);
  assert.equal(resumed.action, "execute");
  if (resumed.action !== "execute") throw new Error("expected resumed Attempt");
  assert.equal(resumed.workPackage.attemptId, fixture.workPackage.attemptId);
  assert.equal(resumed.workPackage.lease.token, fixture.workPackage.lease.token);
  assert.equal(writes, 0);
});

test("external approval expires when the workspace changes after request preparation", async () => {
  const fixture = await applicationExternalActionFixture({
    async execute() { throw new Error("must not execute"); },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected external approval");
  const state = await loadApplicationState(fixture.root, fixture.workItemId);
  await writeFile(path.join(state.worktree, "approval-drift.txt"), "changed after request\n", "utf8");

  await assert.rejects(fixture.app.decide({
    kind: "external_action",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved",
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  }), (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_GRANT_MISMATCH");
});

test("an approved external action cannot execute after the workspace changes", async () => {
  let writes = 0;
  const fixture = await applicationExternalActionFixture({
    async execute({ request }) {
      writes += 1;
      return { targetStableId: request.target.stableId, publishedContentDigest: request.expectedContentDigest, readBackContentDigest: request.expectedContentDigest, verifiedAt: "2026-08-18T04:01:00.000Z" };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected external approval");
  await fixture.app.decide({
    kind: "external_action",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved",
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  });
  const state = await loadApplicationState(fixture.root, fixture.workItemId);
  await writeFile(path.join(state.worktree, "execution-drift.txt"), "changed after approval\n", "utf8");

  await assert.rejects(
    submitExternalAction(fixture, { ...fixture.result, modifiedFiles: ["execution-drift.txt"] }),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_GRANT_MISMATCH",
  );
  assert.equal(writes, 0);
});

test("external approval metadata rejects credential-like side effects before persistence", async () => {
  const fixture = await applicationExternalActionFixture({
    async execute() { throw new Error("must not execute"); },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });
  const externalWrite = fixture.result.externalWrites[0]!;

  await assert.rejects(
    submitExternalAction(fixture, {
      ...fixture.result,
      externalWrites: [{ ...externalWrite, sideEffects: ["Authorization: Bearer fixture-secret"] }],
    }),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_REQUEST_INVALID",
  );
  assert.deepEqual((await readControlPlane(fixture.root, fixture.workItemId)).externalActions, {});
});

test("a successful external-write Step cannot omit its governed external intent", async () => {
  let writes = 0;
  const fixture = await applicationExternalActionFixture({
    async execute() { writes += 1; throw new Error("must not execute"); },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });

  await assert.rejects(
    submitExternalAction(fixture, { ...fixture.result, externalWrites: [] }),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_INTENT_INVALID",
  );
  assert.equal(writes, 0);
  assert.deepEqual((await readControlPlane(fixture.root, fixture.workItemId)).externalActions, {});
});

test("an external Grant cannot execute after its Attempt is replaced", async () => {
  const fixture = await preparedAction();
  const approved = await approveExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: fixture.prepared.request.requestId,
    expectedRequestDigest: fixture.prepared.request.requestDigest,
    actor: "maintainer",
    approvalDigest: fixture.prepared.request.requestDigest,
    profile: "standard",
    profileDigest: fixture.prepared.request.profileDigest,
    workspaceDigest: fixture.prepared.request.workspaceDigest,
    configDigest: fixture.prepared.request.configDigest,
    decidedAt: "2026-08-18T04:00:10.000Z",
    expiresAt: "2026-08-18T04:00:50.000Z",
    terminal: { isTTY: true },
  });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  projection.claims[fixture.workPackage.stepId] = {
    ...projection.claims[fixture.workPackage.stepId]!,
    attemptId: "attempt-replacement",
  };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(
    `${projection.controlPlane}/runtime.json`,
    `${JSON.stringify({ ...projection, controlPlane: undefined }, null, 2)}\n`,
    "utf8",
  ));
  let calls = 0;
  const { executeExternalAction } = await import("../../src/application/external-action.js");
  await assert.rejects(executeExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: approved.request.requestId,
    payload: fixture.input.payload,
    executor: {
      async execute() { calls += 1; throw new Error("must not execute"); },
      async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:00:30.000Z" }; },
    },
    now: "2026-08-18T04:00:20.000Z",
  }), (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_ATTEMPT_MISMATCH");
  assert.equal(calls, 0);
});

test("approval rechecks the active Attempt while holding the control-plane mutation lock", async () => {
  const fixture = await preparedAction();
  await assert.rejects(replaceAttemptWhileMutationWaits({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: fixture.workPackage.stepId,
    operation: () => approveExternalAction({
      root: fixture.root,
      workItemId: fixture.workItemId,
      requestId: fixture.prepared.request.requestId,
      expectedRequestDigest: fixture.prepared.request.requestDigest,
      actor: "maintainer",
      approvalDigest: fixture.prepared.request.requestDigest,
      profile: "standard",
      profileDigest: fixture.prepared.request.profileDigest,
      workspaceDigest: fixture.prepared.request.workspaceDigest,
      configDigest: fixture.prepared.request.configDigest,
      decidedAt: "2026-08-18T04:00:10.000Z",
      expiresAt: "2026-08-18T04:00:50.000Z",
      terminal: { isTTY: true },
    }),
  }), (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_ATTEMPT_MISMATCH");
});

test("execution rechecks the active Attempt in the approved-to-executing mutation", async () => {
  const fixture = await preparedAction();
  const approved = await approveExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: fixture.prepared.request.requestId,
    expectedRequestDigest: fixture.prepared.request.requestDigest,
    actor: "maintainer",
    approvalDigest: fixture.prepared.request.requestDigest,
    profile: "standard",
    profileDigest: fixture.prepared.request.profileDigest,
    workspaceDigest: fixture.prepared.request.workspaceDigest,
    configDigest: fixture.prepared.request.configDigest,
    decidedAt: "2026-08-18T04:00:10.000Z",
    expiresAt: "2026-08-18T04:00:50.000Z",
    terminal: { isTTY: true },
  });
  let calls = 0;
  const { executeExternalAction } = await import("../../src/application/external-action.js");
  await assert.rejects(replaceAttemptWhileMutationWaits({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: fixture.workPackage.stepId,
    operation: () => executeExternalAction({
      root: fixture.root,
      workItemId: fixture.workItemId,
      requestId: approved.request.requestId,
      payload: fixture.input.payload,
      executor: {
        async execute() { calls += 1; throw new Error("must not execute"); },
        async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:00:30.000Z" }; },
      },
      now: "2026-08-18T04:00:20.000Z",
    }),
  }), (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_ATTEMPT_MISMATCH");
  assert.equal(calls, 0);
});

test("rejecting an external action remains blocked after application restart", async () => {
  const fixture = await applicationExternalActionFixture({
    async execute() { throw new Error("must not execute"); },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected external approval");
  await fixture.app.decide({
    kind: "external_action",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "rejected",
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  } as never);
  fixture.restart();

  const blocked = await fixture.app.acquire({ root: fixture.root, workItemId: fixture.workItemId, actor: "codex" });
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") throw new Error("expected durable rejection");
  assert.equal(blocked.problems[0]?.code, "WSSPEC_EXTERNAL_ACTION_REJECTED");
  assert.equal(blocked.problems[0]?.retryable, false);
});

test("a non-external Step rejects submitted externalWrites", async () => {
  const fixture = await externalActionFixture();
  const result = completedResult(fixture.workPackage);
  result.externalWrites = [{ kind: "local-fixture", payload: { secret: "must-not-persist" } }];
  await assert.rejects(fixture.app.submit({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: fixture.workPackage.stepId,
    attemptId: fixture.workPackage.attemptId,
    leaseToken: fixture.workPackage.lease.token,
    result,
  }), (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_INTENT_INVALID");
});
