import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  approveExternalAction,
  executeExternalAction,
  ExternalActionError,
  prepareExternalAction,
  reconcileExternalAction,
  type ExternalActionExecutor,
} from "../../src/application/external-action.js";
import { loadApplicationState } from "../../src/application/state.js";
import { computeWorkspaceSnapshot } from "../../src/domain/digests.js";
import { evaluateExternalDelivery } from "../../src/engine/external-effects/reconciliation.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { applicationExternalActionFixture, externalActionFixture, prepareInput, submitExternalAction } from "./helpers/external-action.js";
import { controlRuntimeFixture, requireExecute, rewriteSelectedSnapshot } from "./helpers/control-runtime.js";

async function approvedAction(action: "issue.update" | "knowledge.publish" | "issue.close" = "issue.update") {
  const fixture = await externalActionFixture();
  const input = prepareInput(fixture.root, fixture.workPackage, {
    action,
    provider: action === "knowledge.publish" ? "feishu" : "github",
    target: action === "knowledge.publish"
      ? { kind: "knowledge", stableId: "feishu:document-token" }
      : { kind: "issue", stableId: "github:example/project#42" },
  });
  const prepared = await prepareExternalAction(input);
  await approveExternalAction({
    root: fixture.root, workItemId: fixture.workItemId, requestId: prepared.request.requestId,
    expectedRequestDigest: prepared.request.requestDigest, actor: "maintainer", approvalDigest: prepared.request.requestDigest,
    profile: "standard", profileDigest: prepared.request.profileDigest, workspaceDigest: prepared.request.workspaceDigest,
    configDigest: prepared.request.configDigest, decidedAt: "2026-08-18T04:00:10.000Z",
    expiresAt: "2026-08-18T04:00:50.000Z", terminal: { isTTY: true },
  });
  return { ...fixture, input, requestId: prepared.request.requestId };
}

test("a proven pre-send crash may continue, while a post-dispatch crash requires read-only reconciliation", async () => {
  const before = await approvedAction();
  let beforeCalls = 0;
  const beforeExecutor: ExternalActionExecutor = {
    async execute() { throw new Error("crash before dispatch"); },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:00:30.000Z" }; },
  };
  await assert.rejects(executeExternalAction({ root: before.root, workItemId: before.workItemId, requestId: before.requestId,
    payload: before.input.payload, executor: beforeExecutor, now: "2026-08-18T04:00:20.000Z" }),
  (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED");
  assert.equal(beforeCalls, 0);
  const beforeProjection = await readControlPlane(before.root, before.workItemId);
  const beforeAction = beforeProjection.externalActions[before.requestId];
  assert.equal(beforeAction?.status, "executing");
  if (beforeAction?.status !== "executing") throw new Error("expected executing action");
  assert.equal(beforeAction.dispatch, "not_sent");

  const after = await approvedAction();
  let afterCalls = 0;
  const afterExecutor: ExternalActionExecutor = {
    async execute({ markDispatched }) { await markDispatched(); afterCalls += 1; throw new Error("lost response"); },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:00:30.000Z" }; },
  };
  const required = await executeExternalAction({ root: after.root, workItemId: after.workItemId, requestId: after.requestId,
    payload: after.input.payload, executor: afterExecutor, now: "2026-08-18T04:00:20.000Z" });
  assert.equal(required.status, "reconciliation_required");
  await assert.rejects(executeExternalAction({ root: after.root, workItemId: after.workItemId, requestId: after.requestId,
    payload: after.input.payload, executor: afterExecutor, now: "2026-08-18T04:00:40.000Z" }),
  (error: unknown) => error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED");
  assert.equal(afterCalls, 1);
});

test("reconciliation only reads stable identity/content and resolves verified, failed, or remains required", async (t) => {
  for (const outcome of ["verified", "failed", "unknown"] as const) {
    await t.test(outcome, async () => {
      const fixture = await approvedAction();
      let writes = 0;
      let reads = 0;
      const executor: ExternalActionExecutor = {
        async execute({ markDispatched }) { await markDispatched(); writes += 1; throw new Error("unknown after send"); },
        async reconcile({ request }) {
          reads += 1;
          if (outcome === "verified") return { outcome, targetStableId: request.target.stableId, contentDigest: request.payloadDigest, checkedAt: "2026-08-18T04:00:30.000Z" };
          if (outcome === "failed") return { outcome, checkedAt: "2026-08-18T04:00:30.000Z", reason: "stable target differs" };
          return { outcome, checkedAt: "2026-08-18T04:00:30.000Z" };
        },
      };
      await executeExternalAction({ root: fixture.root, workItemId: fixture.workItemId, requestId: fixture.requestId,
        payload: fixture.input.payload, executor, now: "2026-08-18T04:00:20.000Z" });
      const result = await reconcileExternalAction({ root: fixture.root, workItemId: fixture.workItemId,
        requestId: fixture.requestId, executor, now: "2026-08-18T04:00:30.000Z" });
      assert.equal(result.status, outcome === "unknown" ? "reconciliation_required" : outcome);
      assert.equal(writes, 1);
      assert.equal(reads, 1);
    });
  }
});

test("external action events replay after projection loss", async () => {
  const fixture = await approvedAction();
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: fixture.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: `test:renew-lease:${fixture.requestId}`,
    operationInput: { requestId: fixture.requestId },
    mutate: (projection) => {
      const claim = projection.claims[fixture.workPackage.stepId];
      const context = projection.contexts[fixture.workPackage.stepId] as {
        workPackage?: { lease?: { expiresAt?: string } };
      } | undefined;
      assert.ok(claim);
      assert.ok(context?.workPackage?.lease);
      const expiresAt = "2999-01-01T00:00:00.000Z";
      return {
        projection: {
          ...projection,
          claims: { ...projection.claims, [fixture.workPackage.stepId]: { ...claim, expiresAt } },
          contexts: {
            ...projection.contexts,
            [fixture.workPackage.stepId]: {
              ...context,
              workPackage: {
                ...context.workPackage,
                lease: { ...context.workPackage.lease, expiresAt },
              },
            },
          },
        },
        value: null,
      };
    },
  });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.externalActions[fixture.requestId]?.status, "approved");
});

test("valid runtime projections missing either external-action field fail closed without migration", async (t) => {
  for (const missing of [
    ["externalActions"],
    ["externalActionIdempotency"],
    ["externalActions", "externalActionIdempotency"],
  ] as const) await t.test(missing.join("+"), async () => {
    const fixture = await approvedAction();
    const projection = await readControlPlane(fixture.root, fixture.workItemId);
    const runtimePath = path.join(projection.controlPlane, "runtime.json");
    const stored = JSON.parse(await readFile(runtimePath, "utf8")) as Record<string, unknown>;
    for (const field of missing) delete stored[field];
    await writeFile(runtimePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    for (const operation of [
      () => readControlPlane(fixture.root, fixture.workItemId),
      () => recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    ]) {
      await assert.rejects(operation, (error: unknown) =>
        error instanceof Error
        && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_RUNTIME_PROJECTION_INCOMPATIBLE");
    }
  });
});

test("delivery ordering blocks close on required knowledge/issue-close but makes optional knowledge failure an explicit warning", () => {
  assert.deepEqual(evaluateExternalDelivery({ issueUpdate: "verified", knowledge: "failed", knowledgeRequired: false, issueClose: "verified" }), {
    allowed: false,
    warnings: [],
    blockers: ["WSSPEC_OPTIONAL_KNOWLEDGE_NOT_SETTLED"],
  });
  assert.deepEqual(evaluateExternalDelivery({ issueUpdate: "verified", knowledge: "failed", knowledgeRequired: true, issueClose: "prepared" }), {
    allowed: false,
    warnings: [],
    blockers: ["WSSPEC_REQUIRED_KNOWLEDGE_NOT_VERIFIED", "WSSPEC_EXTERNAL_ISSUE_CLOSE_NOT_VERIFIED"],
  });
  assert.equal(evaluateExternalDelivery({ issueUpdate: "prepared", knowledge: "verified", knowledgeRequired: true, issueClose: "verified" }).allowed, false);
  assert.equal(evaluateExternalDelivery({ issueUpdate: "verified", knowledge: "missing", knowledgeRequired: false, issueClose: "verified" }).allowed, false);
  assert.equal(evaluateExternalDelivery({ issueUpdate: "verified", knowledge: "absent", knowledgeRequired: false, issueClose: "verified" }).allowed, true);
  assert.equal(evaluateExternalDelivery({ issueUpdate: "verified", knowledge: "skipped", knowledgeRequired: false, issueClose: "verified" }).allowed, true);
  assert.deepEqual(evaluateExternalDelivery({ issueUpdate: "verified", knowledge: "warning", knowledgeRequired: false, issueClose: "verified" }), {
    allowed: true,
    warnings: ["WSSPEC_OPTIONAL_KNOWLEDGE_FAILED"],
    blockers: [],
  });
});

test("Governed issue.close rejects a custom Workflow that omits required knowledge.publish", async () => {
  const fixture = await controlRuntimeFixture({
    externalExecutor: {
      async execute({ request, markDispatched }) {
        await markDispatched();
        return {
          targetStableId: request.target.stableId,
          contentDigest: request.payloadDigest,
          verifiedAt: "2026-08-18T04:01:00.000Z",
        };
      },
      async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
    },
  });
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "关闭前必须发布知识" }, profile: "governed" });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    profile.order = ["update-issue", "close-issue"];
    profile.steps = [
      {
        id: "update-issue", uses: "connector.execute", action: "issue.update", securityClass: "external-write",
        needs: [], enabled: true, skills: [], inputs: [{ artifact: "requirement-source", required: true }],
        outputs: [], gates: [], approval: false, authorizationRequired: true, steps: [],
      },
      {
        id: "close-issue", uses: "connector.execute", action: "issue.close", securityClass: "external-write",
        needs: ["update-issue"], enabled: true, skills: [], inputs: [{ artifact: "requirement-source", required: true }],
        outputs: [], gates: [], approval: false, authorizationRequired: true, steps: [],
      },
    ];
  });
  const stableId = "github:example/project#42";
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:required-knowledge-close",
    operationInput: { stableId },
    mutate: (projection) => ({
      projection: {
        ...projection,
        stages: { "update-issue": { status: "ready" }, "close-issue": { status: "pending" } },
        claims: {}, contexts: {}, approvals: {},
        evidence: {
          ...projection.evidence,
          bindings: { issue: { exists: true, stableId, externalWorkItemId: started.workItemId } },
        },
      },
      value: null,
    }),
  });
  const update = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  const resultFor = (action: "issue.update" | "issue.close") => ({
    version: 1 as const,
    status: "completed" as const,
    summary: action,
    modifiedFiles: [], artifacts: [], commands: [], evidence: [], remainingRisks: [],
    externalWrites: [{
      kind: "external-action", provider: "github", action,
      target: { kind: "issue", stableId }, payload: { body: action }, sideEffects: [action],
    }],
  });
  const submit = (workPackage: typeof update, action: "issue.update" | "issue.close") => fixture.app.submit({
    root: fixture.root,
    workItemId: started.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    leaseToken: workPackage.lease.token,
    result: resultFor(action),
  });
  const pending = await submit(update, "issue.update");
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected update approval");
  await fixture.app.decide({
    kind: "external_action", root: fixture.root, workItemId: started.workItemId,
    requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
  });
  const closeAction = await submit(update, "issue.update");
  assert.equal(closeAction.action, "execute");
  if (closeAction.action !== "execute") throw new Error("expected close step");

  await assert.rejects(
    submit(closeAction.workPackage, "issue.close"),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_EXTERNAL_ORDER_INVALID",
  );
});

test("application submit and acquire block after dispatch uncertainty instead of resending", async () => {
  let writes = 0;
  const fixture = await applicationExternalActionFixture({
    async execute({ markDispatched }) {
      await markDispatched();
      writes += 1;
      throw new Error("response lost");
    },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action", root: fixture.root, workItemId: fixture.workItemId,
    requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
  } as never);
  const blocked = await submitExternalAction(fixture);
  assert.equal(blocked.action, "blocked");
  if (blocked.action !== "blocked") throw new Error("expected reconciliation block");
  assert.deepEqual(blocked.problems.map(({ code }) => code), ["WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED"]);
  fixture.restart();
  const recovered = await fixture.app.acquire({ root: fixture.root, workItemId: fixture.workItemId, actor: "codex" });
  assert.equal(recovered.action, "blocked");
  if (recovered.action !== "blocked") throw new Error("expected recovery block");
  assert.deepEqual(recovered.problems.map(({ code }) => code), ["WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED"]);
  assert.equal(writes, 1);
});

test("decide exposes read-only reconciliation through the five-operation Application protocol", async () => {
  let writes = 0;
  let reads = 0;
  const fixture = await applicationExternalActionFixture({
    async execute({ markDispatched }) {
      await markDispatched();
      writes += 1;
      throw new Error("response lost");
    },
    async reconcile({ request }) {
      reads += 1;
      return {
        outcome: "verified",
        targetStableId: request.target.stableId,
        contentDigest: request.payloadDigest,
        checkedAt: "2026-08-18T04:02:00.000Z",
      };
    },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action", root: fixture.root, workItemId: fixture.workItemId,
    requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
  });
  const uncertain = await submitExternalAction(fixture);
  assert.equal(uncertain.action, "blocked");

  const resumed = await fixture.app.decide({
    kind: "external_reconciliation",
    root: fixture.root,
    workItemId: fixture.workItemId,
    requestId: pending.approval.requestId,
    actor: "codex",
  });
  assert.equal(resumed.action, "execute");
  const completed = await submitExternalAction(fixture);
  assert.equal(completed.action, "completed");
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

test("Provider errors and reconciliation reasons never expose credentials in errors, events, or projection", async (t) => {
  const secrets = [
    "Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "Cookie: session=private-cookie-value",
    "Token: glpat-abcdefghijklmnop",
  ];
  for (const secret of secrets) await t.test(secret.split(":", 1)[0]!, async () => {
    const before = await approvedAction();
    let thrown: unknown;
    try {
      await executeExternalAction({
        root: before.root,
        workItemId: before.workItemId,
        requestId: before.requestId,
        payload: before.input.payload,
        executor: {
          async execute() { throw new Error(secret); },
          async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:00:30.000Z" }; },
        },
        now: "2026-08-18T04:00:20.000Z",
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ExternalActionError);
    assert.equal(thrown.code, "WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED");

    const after = await approvedAction();
    const executor: ExternalActionExecutor = {
      async execute({ markDispatched }) { await markDispatched(); throw new Error("response lost"); },
      async reconcile() { return { outcome: "failed", checkedAt: "2026-08-18T04:00:30.000Z", reason: secret }; },
    };
    await executeExternalAction({
      root: after.root, workItemId: after.workItemId, requestId: after.requestId,
      payload: after.input.payload, executor, now: "2026-08-18T04:00:20.000Z",
    });
    const failed = await reconcileExternalAction({
      root: after.root, workItemId: after.workItemId, requestId: after.requestId,
      executor, now: "2026-08-18T04:00:30.000Z",
    });
    assert.equal(failed.status, "failed");
    if (failed.status !== "failed") throw new Error("expected failed reconciliation");
    assert.equal(failed.reason, "provider read-back did not verify approved content");

    for (const current of [before, after]) {
      const projection = await readControlPlane(current.root, current.workItemId);
      const events = await readFile(path.join(projection.controlPlane, "events.jsonl"), "utf8");
      const exposed: string = `${thrown instanceof Error ? thrown.message : String(thrown)}\n${JSON.stringify(projection)}\n${events}`;
      assert.equal(exposed.includes(secret), false);
    }
  });
});

test("expired-Lease recovery discards a proven not-sent action before creating a replacement Attempt", async () => {
  const fixture = await applicationExternalActionFixture({
    async execute() { throw new Error("crash before dispatch"); },
    async reconcile() { return { outcome: "unknown", checkedAt: "2026-08-18T04:02:00.000Z" }; },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action", root: fixture.root, workItemId: fixture.workItemId,
    requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
  });
  await assert.rejects(submitExternalAction(fixture), (error: unknown) =>
    error instanceof ExternalActionError && error.code === "WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.externalActions[pending.approval.requestId], undefined);
  assert.equal(Object.values(recovered.externalActionIdempotency).includes(pending.approval.requestId), false);
  const replacement = await fixture.app.acquire({ root: fixture.root, workItemId: fixture.workItemId, actor: "codex" });
  assert.equal(replacement.action, "execute");
  if (replacement.action !== "execute") throw new Error("expected replacement Attempt");
  assert.notEqual(replacement.workPackage.attemptId, fixture.workPackage.attemptId);
  const replacementApproval = await fixture.app.submit({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: replacement.workPackage.stepId,
    attemptId: replacement.workPackage.attemptId,
    leaseToken: replacement.workPackage.lease.token,
    result: fixture.result,
  });
  assert.equal(replacementApproval.action, "await_approval");
});

test("expired-Lease recovery renews the original post-dispatch Attempt for reconciliation receipt adoption", async () => {
  let writes = 0;
  const fixture = await applicationExternalActionFixture({
    async execute({ markDispatched }) { await markDispatched(); writes += 1; throw new Error("response lost"); },
    async reconcile({ request }) {
      return {
        outcome: "verified", targetStableId: request.target.stableId, contentDigest: request.payloadDigest,
        checkedAt: "2026-08-18T04:02:00.000Z",
      };
    },
  });
  const pending = await submitExternalAction(fixture);
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval") throw new Error("expected approval");
  await fixture.app.decide({
    kind: "external_action", root: fixture.root, workItemId: fixture.workItemId,
    requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
  });
  assert.equal((await submitExternalAction(fixture)).action, "blocked");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.claims[fixture.workPackage.stepId]?.attemptId, fixture.workPackage.attemptId);
  assert.ok(new Date(recovered.claims[fixture.workPackage.stepId]!.expiresAt) > new Date());
  const resumed = await fixture.app.decide({
    kind: "external_reconciliation", root: fixture.root, workItemId: fixture.workItemId,
    requestId: pending.approval.requestId, actor: "codex",
  });
  assert.equal(resumed.action, "execute");
  if (resumed.action !== "execute") throw new Error("expected original Attempt receipt adoption");
  assert.equal(resumed.workPackage.attemptId, fixture.workPackage.attemptId);
  assert.notEqual(resumed.workPackage.lease.expiresAt, fixture.workPackage.lease.expiresAt);
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const state = await loadApplicationState(fixture.root, fixture.workItemId);
  assert.deepEqual(await computeWorkspaceSnapshot(state.worktree), projection.claims[fixture.workPackage.stepId]?.workspaceSnapshot);

  const completed = await fixture.app.submit({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: resumed.workPackage.stepId,
    attemptId: resumed.workPackage.attemptId,
    leaseToken: resumed.workPackage.lease.token,
    result: fixture.result,
  });
  assert.equal(completed.action, "completed");
  assert.equal(writes, 1);
});

test("inspect recovers a dispatched-only event tail into a payload-free reconciliation view", async () => {
  const fixture = await approvedAction();
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: fixture.workItemId,
    eventType: "external-action.executing",
    idempotencyKey: `test:executing:${fixture.requestId}`,
    operationInput: { requestId: fixture.requestId, startedAt: "2026-08-18T04:00:20.000Z" },
    mutate: (projection) => {
      const current = projection.externalActions[fixture.requestId];
      assert.equal(current?.status, "approved");
      if (current?.status !== "approved") throw new Error("expected approved action");
      return {
        projection: {
          ...projection,
          externalActions: {
            ...projection.externalActions,
            [fixture.requestId]: { ...current, status: "executing", dispatch: "not_sent", startedAt: "2026-08-18T04:00:20.000Z" },
          },
        },
        value: null,
      };
    },
  });
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: fixture.workItemId,
    eventType: "external-action.dispatched",
    idempotencyKey: `test:dispatched:${fixture.requestId}`,
    operationInput: { requestId: fixture.requestId, dispatchedAt: "2026-08-18T04:00:21.000Z" },
    mutate: (projection) => {
      const current = projection.externalActions[fixture.requestId];
      assert.equal(current?.status, "executing");
      if (current?.status !== "executing") throw new Error("expected executing action");
      return {
        projection: {
          ...projection,
          externalActions: {
            ...projection.externalActions,
            [fixture.requestId]: { ...current, dispatch: "sent_or_unknown", dispatchedAt: "2026-08-18T04:00:21.000Z" },
          },
        },
        value: null,
      };
    },
  });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "crashed after dispatch\n", "utf8");

  const view = await fixture.app.inspect({ root: fixture.root, workItemId: fixture.workItemId });
  assert.deepEqual(view.externalActions, [{
    requestId: fixture.requestId,
    stepId: fixture.workPackage.stepId,
    attemptId: fixture.workPackage.attemptId,
    provider: fixture.input.provider,
    action: fixture.input.action,
    target: fixture.input.target,
    status: "reconciliation_required",
  }]);
  assert.equal(JSON.stringify(view).includes("approved release summary"), false);
});

test("failed knowledge reconciliation becomes a warning only when the selected profile makes knowledge optional", async (t) => {
  for (const scenario of [
    { profile: "standard" as const, expectedStatus: "completed", expectedStage: "succeeded_with_warnings" },
    { profile: "governed" as const, expectedStatus: "blocked", expectedStage: "claimed" },
  ]) {
    await t.test(scenario.profile, async () => {
      const executor: ExternalActionExecutor = {
        async execute({ markDispatched }) { await markDispatched(); throw new Error("response lost"); },
        async reconcile() { return { outcome: "failed", checkedAt: "2026-08-18T04:00:30.000Z", reason: "remote document missing" }; },
      };
      const fixture = await applicationExternalActionFixture(executor, { action: "knowledge.publish", profile: scenario.profile });
      const pending = await submitExternalAction(fixture);
      assert.equal(pending.action, "await_approval");
      if (pending.action !== "await_approval") throw new Error("expected approval");
      await fixture.app.decide({
        kind: "external_action", root: fixture.root, workItemId: fixture.workItemId,
        requestId: pending.approval.requestId, decision: "approved", expectedDigest: pending.approval.digest, actor: "maintainer",
      });
      const uncertain = await submitExternalAction(fixture);
      assert.equal(uncertain.action, "blocked");
      await reconcileExternalAction({
        root: fixture.root,
        workItemId: fixture.workItemId,
        requestId: pending.approval.requestId,
        executor,
        now: "2026-08-18T04:00:30.000Z",
      });

      const next = await fixture.app.acquire({ root: fixture.root, workItemId: fixture.workItemId, actor: "codex" });
      assert.equal(next.action, scenario.expectedStatus);
      const projection = await readControlPlane(fixture.root, fixture.workItemId);
      assert.equal(projection.stages[fixture.workPackage.stepId]?.status, scenario.expectedStage);
      if (scenario.profile === "standard") {
        assert.deepEqual(projection.evidence[`external-warning:${pending.approval.requestId}`], {
          code: "WSSPEC_OPTIONAL_KNOWLEDGE_FAILED",
          reason: "provider read-back did not verify approved content",
        });
      }
    });
  }
});
