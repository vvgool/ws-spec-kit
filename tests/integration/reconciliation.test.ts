import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
import { evaluateExternalDelivery } from "../../src/engine/external-effects/reconciliation.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { applicationExternalActionFixture, externalActionFixture, prepareInput, submitExternalAction } from "./helpers/external-action.js";

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
    payload: before.input.payload, executor: beforeExecutor, now: "2026-08-18T04:00:20.000Z" }), /crash before dispatch/);
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
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.externalActions[fixture.requestId]?.status, "approved");
});

test("delivery ordering blocks close on required knowledge/issue-close but makes optional knowledge failure an explicit warning", () => {
  assert.deepEqual(evaluateExternalDelivery({ issueUpdate: "verified", knowledge: "failed", knowledgeRequired: false, issueClose: "verified" }), {
    allowed: true,
    warnings: ["WSSPEC_OPTIONAL_KNOWLEDGE_FAILED"],
    blockers: [],
  });
  assert.deepEqual(evaluateExternalDelivery({ issueUpdate: "verified", knowledge: "failed", knowledgeRequired: true, issueClose: "prepared" }), {
    allowed: false,
    warnings: [],
    blockers: ["WSSPEC_REQUIRED_KNOWLEDGE_NOT_VERIFIED", "WSSPEC_EXTERNAL_ISSUE_CLOSE_NOT_VERIFIED"],
  });
  assert.equal(evaluateExternalDelivery({ issueUpdate: "prepared", knowledge: "verified", knowledgeRequired: true, issueClose: "verified" }).allowed, false);
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
          reason: "remote document missing",
        });
      }
    });
  }
});
