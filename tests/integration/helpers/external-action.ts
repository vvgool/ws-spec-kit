import assert from "node:assert/strict";

import {
  prepareExternalAction,
  type ExternalActionExecutor,
  type ExternalActionPrepareInput,
} from "../../../src/application/external-action.js";
import { sha256 } from "../../../src/domain/digests.js";
import { mutateControlPlane } from "../../../src/engine/scheduler.js";
import type { SubmitResult } from "../../../src/protocol/application.js";
import type { WorkPackage } from "../../../src/protocol/work-package.js";
import { controlRuntimeFixture, requireExecute, retainOnlyReadyStage, rewriteSelectedSnapshot } from "./control-runtime.js";

export const digest = (value: string): `sha256:${string}` => sha256(value) as `sha256:${string}`;

export async function externalActionFixture() {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "外部动作测试" }, profile: "standard" });
  const workPackage = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  return { ...fixture, workItemId: started.workItemId, workPackage };
}

export function prepareInput(
  root: string,
  workPackage: WorkPackage,
  overrides: Partial<ExternalActionPrepareInput> = {},
): ExternalActionPrepareInput {
  return {
    root,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    provider: "github",
    action: "issue.update",
    securityClass: "external-write",
    target: { kind: "issue", stableId: "github:example/project#42" },
    payload: { body: "approved release summary" },
    bindingDigest: digest("b"),
    inputDigest: digest("i"),
    artifactDigests: [digest("a")],
    sideEffects: ["更新 Issue 正文"],
    createdAt: "2026-08-18T04:00:00.000Z",
    expiresAt: "2026-08-18T04:30:00.000Z",
    actor: "codex",
    ...overrides,
  };
}

export async function preparedAction() {
  const fixture = await externalActionFixture();
  const input = prepareInput(fixture.root, fixture.workPackage);
  const prepared = await prepareExternalAction(input);
  assert.equal(prepared.status, "prepared");
  return { ...fixture, input, prepared };
}

export async function applicationExternalActionFixture(
  executor: ExternalActionExecutor,
  options: { action?: "issue.update" | "knowledge.publish"; profile?: "standard" | "governed"; now?: () => Date } = {},
) {
  const action = options.action ?? "issue.update";
  const stepId = action === "knowledge.publish" ? "update-wiki" : "update-issue";
  const targetKind = action === "knowledge.publish" ? "knowledge" : "issue";
  const provider = action === "knowledge.publish" ? "feishu" : "github";
  const stableId = action === "knowledge.publish" ? "feishu:document-token" : "github:example/project#42";
  const fixture = await controlRuntimeFixture({
    externalExecutor: executor,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "应用协议外部动作测试" }, profile: options.profile ?? "governed" });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    profile.order = [stepId];
    profile.steps = [{
      id: stepId,
      uses: "connector.execute",
      action,
      securityClass: "external-write",
      needs: [],
      enabled: true,
      skills: [],
      inputs: [{ artifact: "requirement-source", required: true }],
      outputs: [],
      gates: [],
      approval: false,
      authorizationRequired: true,
      steps: [],
    }];
  });
  await retainOnlyReadyStage(fixture, started.workItemId, stepId);
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: `test:external-binding:${targetKind}`,
    operationInput: { target: targetKind },
    mutate: (projection) => ({
      projection: {
        ...projection,
        evidence: {
          ...projection.evidence,
          bindings: {
            [targetKind]: { exists: true, stableId, externalWorkItemId: started.workItemId },
          },
        },
      },
      value: null,
    }),
  });
  const workPackage = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  const result: SubmitResult = {
    version: 1,
    status: "completed",
    summary: "update issue",
    modifiedFiles: [],
    artifacts: [],
    commands: [],
    evidence: [],
    externalWrites: [{
      kind: "external-action",
      provider,
      action,
      target: { kind: targetKind, stableId },
      payload: { body: "approved release summary", authorization: "fixture-secret" },
      sideEffects: [action === "knowledge.publish" ? "发布知识文档" : "更新 Issue 正文"],
    }],
    remainingRisks: [],
  };
  return { ...fixture, workItemId: started.workItemId, workPackage, result };
}

export async function submitExternalAction(
  fixture: Awaited<ReturnType<typeof applicationExternalActionFixture>>,
  result: SubmitResult = fixture.result,
) {
  return fixture.app.submit({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: fixture.workPackage.stepId,
    attemptId: fixture.workPackage.attemptId,
    leaseToken: fixture.workPackage.lease.token,
    result,
  });
}
