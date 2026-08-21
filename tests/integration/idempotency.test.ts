import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  approveExternalAction,
  executeExternalAction,
  ExternalActionError,
  prepareExternalAction,
  type ExternalActionExecutor,
} from "../../src/application/external-action.js";
import { ApplicationSubmitError } from "../../src/application/submit.js";
import { externalIdempotencyKey } from "../../src/engine/external-effects/idempotency.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { readControlPlane } from "../../src/storage/control-plane.js";
import { applicationExternalActionFixture, applicationGitActionFixture, externalActionFixture, prepareInput, submitExternalAction } from "./helpers/external-action.js";
import { worktreeFor } from "./helpers/control-runtime.js";

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
      return { targetStableId: request.target.stableId, publishedContentDigest: request.expectedContentDigest, readBackContentDigest: request.expectedContentDigest, verifiedAt: "2026-08-18T04:00:20.000Z" };
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

test("comment preparation, grant, and verified receipt bind the authoritative external effect identity", async () => {
  const fixture = await externalActionFixture();
  const input = {
    ...prepareInput(fixture.root, fixture.workPackage),
    externalEffectKind: "issue.comment" as const,
  };
  const prepared = await prepareExternalAction(input);
  assert.equal((prepared.request as unknown as Record<string, unknown>).externalEffectKind, "issue.comment");
  const approved = await approveExternalAction({
    root: fixture.root, workItemId: fixture.workItemId, requestId: prepared.request.requestId,
    expectedRequestDigest: prepared.request.requestDigest, actor: "maintainer", approvalDigest: prepared.request.requestDigest,
    profile: "standard", profileDigest: prepared.request.profileDigest, workspaceDigest: prepared.request.workspaceDigest,
    configDigest: prepared.request.configDigest, decidedAt: "2026-08-18T04:00:10.000Z",
    expiresAt: "2026-08-18T04:00:50.000Z", terminal: { isTTY: true },
  });
  assert.equal((approved.grant as unknown as Record<string, unknown>).externalEffectKind, "issue.comment");

  const verified = await executeExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: prepared.request.requestId,
    payload: input.payload,
    now: "2026-08-18T04:00:20.000Z",
    executor: {
      async execute({ request, markDispatched }) {
        await markDispatched();
        return {
          targetStableId: request.target.stableId,
          externalEffectId: "github-comment:4242",
          publishedContentDigest: request.expectedContentDigest,
          readBackContentDigest: request.expectedContentDigest,
          verifiedAt: "2026-08-18T04:00:20.000Z",
        };
      },
      async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:00:30.000Z" }; },
    },
  });
  assert.equal(verified.status, "verified");
  if (verified.status !== "verified") throw new Error("expected verified action");
  assert.equal((verified.receipt as unknown as Record<string, unknown>).externalEffectKind, "issue.comment");
  assert.equal((verified.receipt as unknown as Record<string, unknown>).externalEffectId, "github-comment:4242");
});

test("repeated application submit writes once, stores only the receipt, and rejects a changed payload for the same Attempt", async () => {
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
  const changed = structuredClone(fixture.result);
  const changedWrite = changed.externalWrites[0] as { payload: { action: { body: string } } };
  changedWrite.payload.action.body = "different payload";
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

test("verified application retry revalidates the production binding before reusing its receipt", async () => {
  const executor: ExternalActionExecutor = {
    async execute({ request, markDispatched }) {
      await markDispatched();
      return {
        targetStableId: request.target.stableId,
        publishedContentDigest: request.expectedContentDigest,
        readBackContentDigest: request.expectedContentDigest,
        verifiedAt: "2026-08-18T04:01:00.000Z",
      };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  };
  const fixture = await applicationExternalActionFixture(executor);
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved",
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  });
  const approved = (await readControlPlane(fixture.root, fixture.workItemId)).externalActions[pending.approval.requestId];
  assert.equal(approved?.status, "approved");
  if (approved?.status !== "approved") throw new Error("expected approved action");
  const intent = fixture.result.externalWrites[0] as { payload: unknown };
  const verified = await executeExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    payload: intent.payload,
    executor,
    now: approved.grant.decidedAt,
  });
  assert.equal(verified.status, "verified");

  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: fixture.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: `test:verified-binding-drift:${pending.approval.requestId}`,
    operationInput: { requestId: pending.approval.requestId },
    mutate: (projection) => {
      const bindings = projection.evidence.bindings as Record<string, Record<string, unknown>>;
      return {
        projection: {
          ...projection,
          evidence: {
            ...projection.evidence,
            bindings: {
              ...bindings,
              issue: { ...bindings.issue, stableId: "github:example/project#99" },
            },
          },
        },
        value: null,
      };
    },
  });

  await assert.rejects(
    submitExternalAction(fixture),
    (error: unknown) => error instanceof ApplicationSubmitError && error.code === "WSSPEC_EXTERNAL_BINDING_INVALID",
  );
});

test("verified application retry rejects same-path workspace drift before reusing its receipt", async () => {
  const executor: ExternalActionExecutor = {
    async execute({ request, markDispatched }) {
      await markDispatched();
      return {
        targetStableId: request.target.stableId,
        publishedContentDigest: request.expectedContentDigest,
        readBackContentDigest: request.expectedContentDigest,
        verifiedAt: "2026-08-18T04:01:00.000Z",
      };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  };
  const fixture = await applicationExternalActionFixture(executor);
  const worktree = await worktreeFor(fixture.root, fixture.workItemId);
  await writeFile(path.join(worktree, "README.md"), "approved workspace content\n", "utf8");
  const result = structuredClone(fixture.result);
  result.modifiedFiles = ["README.md"];

  const pending = await submitExternalAction(fixture, result);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved",
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  });
  const approved = (await readControlPlane(fixture.root, fixture.workItemId)).externalActions[pending.approval.requestId];
  assert.equal(approved?.status, "approved");
  if (approved?.status !== "approved") throw new Error("expected approved action");
  const intent = result.externalWrites[0] as { payload: unknown };
  assert.equal((await executeExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    payload: intent.payload,
    executor,
    now: approved.grant.decidedAt,
  })).status, "verified");

  await writeFile(path.join(worktree, "README.md"), "drifted workspace content\n", "utf8");
  await assert.rejects(
    submitExternalAction(fixture, result),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_GRANT_MISMATCH",
  );
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  assert.equal(projection.idempotency[`submit:${fixture.workPackage.attemptId}`], undefined);
});

test("verified git.commit retry rejects same-path worktree drift without submitting the Attempt", async () => {
  const executor: ExternalActionExecutor = {
    async execute({ request, markDispatched }) {
      await markDispatched();
      return {
        targetStableId: request.target.stableId,
        publishedContentDigest: request.expectedContentDigest,
        readBackContentDigest: request.expectedContentDigest,
        verifiedAt: "2026-08-18T04:01:00.000Z",
      };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  };
  const fixture = await applicationGitActionFixture(executor);
  const pending = await fixture.app.submit({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: fixture.workPackage.stepId,
    attemptId: fixture.workPackage.attemptId,
    leaseToken: fixture.workPackage.lease.token,
    result: fixture.result,
  });
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved",
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  });
  const approved = (await readControlPlane(fixture.root, fixture.workItemId)).externalActions[pending.approval.requestId];
  assert.equal(approved?.status, "approved");
  if (approved?.status !== "approved") throw new Error("expected approved action");
  const intent = fixture.result.externalWrites[0] as { payload: unknown };
  assert.equal((await executeExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    payload: intent.payload,
    executor,
    now: approved.grant.decidedAt,
  })).status, "verified");

  await writeFile(path.join(fixture.worktree, "README.md"), "drifted git content\n", "utf8");
  await assert.rejects(
    fixture.app.submit({
      root: fixture.root,
      workItemId: fixture.workItemId,
      stepId: fixture.workPackage.stepId,
      attemptId: fixture.workPackage.attemptId,
      leaseToken: fixture.workPackage.lease.token,
      result: fixture.result,
    }),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_EXTERNAL_GRANT_MISMATCH",
  );
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  assert.equal(projection.idempotency[`submit:${fixture.workPackage.attemptId}`], undefined);
});

test("verified knowledge.publish retry rejects publication-input drift without submitting the Attempt", async () => {
  const executor: ExternalActionExecutor = {
    async execute({ request, markDispatched }) {
      await markDispatched();
      return {
        targetStableId: request.target.stableId,
        publishedContentDigest: request.expectedContentDigest,
        readBackContentDigest: request.expectedContentDigest,
        verifiedAt: "2026-08-18T04:01:00.000Z",
      };
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  };
  const fixture = await applicationExternalActionFixture(executor, { action: "knowledge.publish" });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved",
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  });
  const approved = (await readControlPlane(fixture.root, fixture.workItemId)).externalActions[pending.approval.requestId];
  assert.equal(approved?.status, "approved");
  if (approved?.status !== "approved") throw new Error("expected approved action");
  const intent = fixture.result.externalWrites[0] as { payload: unknown };
  assert.equal((await executeExternalAction({
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    payload: intent.payload,
    executor,
    now: approved.grant.decidedAt,
  })).status, "verified");

  const publication = fixture.workPackage.artifacts.find(({ artifactType }) => artifactType === "knowledge-entry");
  assert.ok(publication?.path);
  const worktree = await worktreeFor(fixture.root, fixture.workItemId);
  const publicationPath = path.join(worktree, publication.path);
  await writeFile(publicationPath, `${await readFile(publicationPath, "utf8")}\nDrifted after verification.\n`, "utf8");
  await assert.rejects(
    submitExternalAction(fixture),
    (error: unknown) => (error as { code?: unknown }).code === "WSSPEC_ARTIFACT_REFERENCE_INVALID",
  );
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  assert.equal(projection.idempotency[`submit:${fixture.workPackage.attemptId}`], undefined);
});

test("repeated application submit reuses the approved logical request when the clock advances", async () => {
  let currentTime = "2026-08-18T04:00:00.000Z";
  let writes = 0;
  const fixture = await applicationExternalActionFixture({
    async execute({ request, markDispatched }) {
      await markDispatched();
      writes += 1;
      return { targetStableId: request.target.stableId, publishedContentDigest: request.expectedContentDigest, readBackContentDigest: request.expectedContentDigest, verifiedAt: currentTime };
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

test("repeating the same external approval after a lost response preserves the first decision", async () => {
  let currentTime = "2026-08-18T04:00:01.000Z";
  const fixture = await applicationExternalActionFixture({
    async execute() { throw new Error("must not execute"); },
    async reconcile() { return { outcome: "unknown", checkedAt: currentTime }; },
  }, { now: () => new Date(currentTime) });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  const decision = {
    kind: "external_action" as const,
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved" as const,
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  };

  const first = await fixture.app.decide(decision);
  const firstGrant = (await readControlPlane(fixture.root, fixture.workItemId)).externalActions[pending.approval.requestId];
  currentTime = "2026-08-18T04:00:02.000Z";
  const repeated = await fixture.app.decide(decision);

  assert.deepEqual(repeated, first);
  assert.deepEqual((await readControlPlane(fixture.root, fixture.workItemId)).externalActions[pending.approval.requestId], firstGrant);
});

test("repeating the same external rejection after a lost response preserves the first decision", async () => {
  let currentTime = "2026-08-18T04:00:01.000Z";
  const fixture = await applicationExternalActionFixture({
    async execute() { throw new Error("must not execute"); },
    async reconcile() { return { outcome: "unknown", checkedAt: currentTime }; },
  }, { now: () => new Date(currentTime) });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  const decision = {
    kind: "external_action" as const,
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    decision: "rejected" as const,
    expectedDigest: pending.approval.digest,
    actor: "maintainer",
  };

  const first = await fixture.app.decide(decision);
  const firstRejection = (await readControlPlane(fixture.root, fixture.workItemId)).evidence[`external-rejection:${pending.approval.requestId}`];
  currentTime = "2026-08-18T04:00:02.000Z";
  const repeated = await fixture.app.decide(decision);

  assert.deepEqual(repeated, first);
  assert.deepEqual((await readControlPlane(fixture.root, fixture.workItemId)).evidence[`external-rejection:${pending.approval.requestId}`], firstRejection);
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
      return { targetStableId: request.target.stableId, publishedContentDigest: request.expectedContentDigest, readBackContentDigest: request.expectedContentDigest, verifiedAt: "2026-08-18T04:01:00.000Z" };
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
