import assert from "node:assert/strict";
import test from "node:test";
import { inspectApplication } from "../../src/application/inspect.js";
import { recoverApplication } from "../../src/application/recover.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { controlRuntimeFixture, failedResult, requireExecute, retainOnlyReadyStage, rewriteSelectedSnapshot, submitPackage } from "./helpers/control-runtime.js";

async function fixture() {
  const fixture = await controlRuntimeFixture({ now: () => new Date() });
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "loop recovery guidance" }, profile: "quick" });
  await rewriteSelectedSnapshot(fixture, started.workItemId, profile => {
    const loop = profile.steps.find(step => step.id === "review-fix")!;
    const children = loop.steps as Array<{ retry?: { maxAttempts: number } }>;
    children[0]!.retry = { maxAttempts: 2 };
    loop.needs = [];
    profile.steps = [loop];
    profile.order = ["review-fix"];
  });
  await retainOnlyReadyStage(fixture, started.workItemId, "review-fix");
  return { fixture, input: { root: fixture.root, workItemId: started.workItemId } };
}

test("inspect and recover report the current loop child failure budget", async () => {
  const { fixture: f, input } = await fixture();
  const first = requireExecute(await f.app.acquire({ ...input, actor: "agent" }));
  const active = await inspectApplication(input);
  assert.equal(active.currentStep, "review-fix");
  assert.equal(active.currentStepInstanceId, first.stepId);
  assert.equal(active.retry?.attemptsUsed, 1);
  await submitPackage(f, first, failedResult(first));
  const retryable = await recoverApplication({ ...input, actor: "agent", reason: "retry failed child" });
  assert.equal(retryable.currentStepInstanceId, first.stepId);
  assert.equal(retryable.retry?.attemptsRemaining, 1);
  assert.equal(retryable.nextAction.kind, "acquire");
  const second = requireExecute(await f.app.acquire({ ...input, actor: "agent" }));
  await submitPackage(f, second, failedResult(second));
  const exhausted = await inspectApplication(input);
  assert.equal(exhausted.retry?.attemptsRemaining, 0);
  assert.equal(exhausted.nextAction.kind, "blocked");
  assert.match(exhausted.nextAction.reason, /预算已耗尽/u);
});

test("inspect retains loop child interruption budget after expired claim cleanup", async () => {
  const { fixture: f, input } = await fixture();
  const first = requireExecute(await f.app.acquire({ ...input, actor: "agent" }));
  await mutateControlPlane({ cwd: input.root, workItemId: input.workItemId, eventType: "evidence.recorded",
    idempotencyKey: "test:expire", operationInput: {}, mutate: projection => ({ projection: { ...projection,
      claims: { ...projection.claims, "review-fix": { ...projection.claims["review-fix"]!, expiresAt: new Date(0).toISOString() } } }, value: null }) });
  const interrupted = await inspectApplication(input);
  assert.equal(interrupted.currentStepInstanceId, first.stepId);
  assert.equal(interrupted.retry?.interruptions, 1);
  assert.equal(interrupted.retry?.attemptsUsed, 0);
  assert.equal(interrupted.retry?.attemptsRemaining, 2);
  assert.equal(interrupted.nextAction.kind, "acquire");
});
