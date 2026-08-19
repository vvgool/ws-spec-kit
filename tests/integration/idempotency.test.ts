import assert from "node:assert/strict";
import test from "node:test";

import {
  approveExternalAction,
  executeExternalAction,
  ExternalActionError,
  prepareExternalAction,
  type ExternalActionExecutor,
} from "../../src/application/external-action.js";
import { externalIdempotencyKey } from "../../src/engine/external-effects/idempotency.js";
import { readControlPlane } from "../../src/storage/control-plane.js";
import { applicationExternalActionFixture, externalActionFixture, prepareInput, submitExternalAction } from "./helpers/external-action.js";

async function approvedAction() {
  const fixture = await externalActionFixture();
  const input = prepareInput(fixture.root, fixture.workPackage);
  const prepared = await prepareExternalAction(input);
  const approved = await approveExternalAction({
    root: fixture.root, workItemId: fixture.workItemId, requestId: prepared.request.requestId,
    expectedRequestDigest: prepared.request.requestDigest, actor: "maintainer", approvalDigest: prepared.request.requestDigest,
    profile: "standard", profileDigest: prepared.request.profileDigest, workspaceDigest: prepared.request.workspaceDigest,
    configDigest: prepared.request.configDigest, decidedAt: "2026-08-18T04:00:10.000Z",
    expiresAt: "2026-08-18T04:00:50.000Z", terminal: { isTTY: true },
  });
  return { ...fixture, input, approved };
}

test("canonical idempotency key binds exactly work item, step, stable target, and payload digest", async () => {
  const fixture = await externalActionFixture();
  const first = await prepareExternalAction(prepareInput(fixture.root, fixture.workPackage));
  const repeated = await prepareExternalAction(prepareInput(fixture.root, fixture.workPackage));
  assert.deepEqual(repeated, first);
  assert.equal(first.request.idempotencyKey, externalIdempotencyKey(first.request));

  const providerChanged = { ...first.request, provider: "gitlab" };
  const actionChanged = { ...first.request, action: "issue.close" };
  assert.equal(externalIdempotencyKey(providerChanged), first.request.idempotencyKey);
  assert.equal(externalIdempotencyKey(actionChanged), first.request.idempotencyKey);

  await assert.rejects(prepareExternalAction(prepareInput(fixture.root, fixture.workPackage, {
    idempotencyKey: first.request.idempotencyKey,
    payload: { body: "different payload" },
  })), (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT");
});

test("provider or action changes conflict with an existing canonical logical write", async () => {
  const fixture = await externalActionFixture();
  await prepareExternalAction(prepareInput(fixture.root, fixture.workPackage));

  for (const changed of [
    { provider: "gitlab" },
    { action: "issue.close" as const },
  ]) {
    await assert.rejects(
      prepareExternalAction(prepareInput(fixture.root, fixture.workPackage, changed)),
      (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT",
    );
  }
});

test("verified duplicate execute returns the original receipt without another provider call", async () => {
  const fixture = await approvedAction();
  let calls = 0;
  const executor: ExternalActionExecutor = {
    async execute({ request, markDispatched }) {
      await markDispatched();
      calls += 1;
      return { targetStableId: request.target.stableId, contentDigest: request.payloadDigest, verifiedAt: "2026-08-18T04:00:20.000Z" };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:00:30.000Z" }; },
  };

  const first = await executeExternalAction({ root: fixture.root, workItemId: fixture.workItemId,
    requestId: fixture.approved.request.requestId, payload: fixture.input.payload, executor, now: "2026-08-18T04:00:20.000Z" });
  const repeated = await executeExternalAction({ root: fixture.root, workItemId: fixture.workItemId,
    requestId: fixture.approved.request.requestId, payload: fixture.input.payload, executor, now: "2026-08-18T04:00:40.000Z" });

  assert.equal(first.status, "verified");
  assert.deepEqual(repeated, first);
  assert.equal(calls, 1);
});

test("repeated application submit writes once, stores only the receipt, and rejects a changed payload for the same Attempt", async () => {
  let writes = 0;
  const fixture = await applicationExternalActionFixture({
    async execute({ request, markDispatched }) {
      await markDispatched();
      writes += 1;
      return { targetStableId: request.target.stableId, contentDigest: request.payloadDigest, verifiedAt: "2026-08-18T04:01:00.000Z" };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  const changed = structuredClone(fixture.result);
  (changed.externalWrites[0] as { payload: unknown }).payload = { body: "different payload" };
  await assert.rejects(submitExternalAction(fixture, changed),
    (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action", root: fixture.root, workItemId: fixture.workItemId,
    requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
  } as never);
  const first = await submitExternalAction(fixture);
  const repeated = await submitExternalAction(fixture);
  assert.deepEqual(repeated, first);
  assert.equal(writes, 1);
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const stored = projection.contexts[fixture.workPackage.stepId] as { result?: { externalWrites?: unknown[] } };
  assert.equal((stored.result?.externalWrites?.[0] as { kind?: unknown })?.kind, "external-write-receipt");
  assert.equal(JSON.stringify(projection).includes("fixture-secret"), false);
});

test("repeated application submit reuses the approved logical request when the clock advances", async () => {
  let currentTime = "2026-08-18T04:00:00.000Z";
  let writes = 0;
  const fixture = await applicationExternalActionFixture({
    async execute({ request, markDispatched }) {
      await markDispatched();
      writes += 1;
      return { targetStableId: request.target.stableId, contentDigest: request.payloadDigest, verifiedAt: currentTime };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: currentTime }; },
  }, { now: () => new Date(currentTime) });

  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  currentTime = "2026-08-18T04:00:01.000Z";
  await fixture.app.decide({
    kind: "external_action", root: fixture.root, workItemId: fixture.workItemId,
    requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
  } as never);
  currentTime = "2026-08-18T04:00:02.000Z";

  const completed = await submitExternalAction(fixture);
  assert.equal(completed.action, "completed");
  assert.equal(writes, 1);
});

test("concurrent application submits atomically assign one Provider dispatch owner", async () => {
  let providerCalls = 0;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const fixture = await applicationExternalActionFixture({
    async execute({ request, markDispatched }) {
      providerCalls += 1;
      enteredResolve();
      await release;
      await markDispatched();
      return { targetStableId: request.target.stableId, contentDigest: request.payloadDigest, verifiedAt: "2026-08-18T04:01:00.000Z" };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action", root: fixture.root, workItemId: fixture.workItemId,
    requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
  });

  const submissions = Promise.all([submitExternalAction(fixture), submitExternalAction(fixture)]);
  await entered;
  await new Promise((resolve) => setTimeout(resolve, 200));
  releaseResolve();
  await submissions;

  assert.equal(providerCalls, 1);
  assert.equal((await readControlPlane(fixture.root, fixture.workItemId)).externalActions[pending.approval.requestId]?.status, "verified");
});
