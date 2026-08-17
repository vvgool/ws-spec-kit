import { computeWorkspaceSnapshot, computeWorkspaceTreeDigest } from "../domain/digests.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import type { AgentAction, AcquireInput, SubmitResult } from "../protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../protocol/work-package.js";
import type { ExecutorRegistry } from "../registry/executors/registry.js";
import { validate } from "../schemas/index.js";
import { applicationCloseEvidenceKey, recoverControlPlane, type ApplicationCloseEvidence, type RuntimeClaim, type RuntimeProjection } from "../storage/control-plane.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import type { ApplicationSnapshot, ApplicationState, SnapshotProfile, SnapshotStep } from "./state.js";
import { loadApplicationState, selectedProfile } from "./state.js";

export interface AcquireDependencies {
  now(): Date;
  executors: ExecutorRegistry;
}

export interface ApplicationAttemptRecord {
  workPackage: WorkPackage;
  retryCount: number;
  result?: SubmitResult;
  nextAction?: AgentAction;
}

export class ApplicationAcquireError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ApplicationAcquireError";
  }
}

function conditionIsFalse(step: SnapshotStep): boolean {
  return step.when?.includes("bindings.issue.exists") === true || step.when?.includes("bindings.knowledge.exists") === true;
}

function promoteReady(projection: RuntimeProjection, profile: SnapshotProfile): RuntimeProjection {
  let next = { ...projection, stages: { ...projection.stages } };
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of profile.steps) {
      const state = next.stages[step.id];
      if (state?.status !== "pending") continue;
      const dependenciesComplete = step.needs.every((dependency) => {
        const status = next.stages[dependency]?.status;
        return status === "succeeded" || status === "succeeded_with_warnings" || status === "skipped";
      });
      if (dependenciesComplete) {
        next.stages[step.id] = transitionStage(state, { type: "transition", to: !step.enabled || conditionIsFalse(step) ? "skipped" : "ready" });
        changed = true;
      }
    }
  }
  return next;
}

function pendingApproval(projection: RuntimeProjection, workItemId: string): AgentAction | undefined {
  const approval = Object.values(projection.approvals).find((candidate) => candidate.status === "pending");
  if (approval === undefined) return undefined;
  return {
    action: "await_approval",
    approval: {
      kind: "step",
      requestId: approval.requestId,
      workItemId: workItemId as `WSS-${string}`,
      title: `Approve ${approval.stageId}`,
      digest: approval.contentHash,
    },
  };
}

function priorArtifacts(projection: RuntimeProjection, snapshot: ApplicationSnapshot): ArtifactReference[] {
  const artifacts = [snapshot.source];
  for (const value of Object.values(projection.contexts)) {
    const result = (value as ApplicationAttemptRecord | undefined)?.result;
    if (result !== undefined) artifacts.push(...result.artifacts);
  }
  const unique = new Map(artifacts.map((artifact) => [`${artifact.artifactType}\0${artifact.path ?? ""}\0${artifact.contentHash ?? ""}`, artifact]));
  return [...unique.values()];
}

function workPackageFor(input: {
  workItemId: string;
  step: SnapshotStep;
  attemptId: string;
  token: string;
  expiresAt: string;
  projection: RuntimeProjection;
  snapshot: ApplicationSnapshot;
}): WorkPackage {
  const gatesById = new Map(input.snapshot.gates.map((gate) => [gate.id, gate]));
  const requiredOutputs = input.step.outputs.filter((output) => output.required).map((output) => {
    if (output.artifact === "requirement-source") return input.snapshot.source;
    return { artifactType: output.artifact, schemaVersion: 1 } as const;
  });
  const value: WorkPackage = {
    version: 1,
    workItemId: input.workItemId as `WSS-${string}`,
    stepId: input.step.id,
    attemptId: input.attemptId,
    lease: { token: input.token, expiresAt: input.expiresAt },
    objective: input.step.objective ?? `${input.step.uses}${input.step.action === undefined ? "" : `/${input.step.action}`}`,
    skills: input.step.skills.map((skill) => ({ ...skill })),
    artifacts: priorArtifacts(input.projection, input.snapshot),
    constraints: {
      allowedPaths: [...input.snapshot.changePolicy.allowedPaths],
      forbiddenActions: ["push", "merge", "release", "unapproved-external-write"],
    },
    requiredOutputs,
    gates: input.step.gates.map((id) => ({ id, evidence: gatesById.get(id)?.evidence ?? "trusted", required: true })),
    resultSchema: "builtin.submit-result.v1",
  };
  return validate<WorkPackage>("builtin.work-package.v1", value);
}

function completed(workItemId: string, status: "closed" | "cancelled", message: string): AgentAction {
  return { action: "completed", summary: { workItemId: workItemId as `WSS-${string}`, status, message } };
}

export async function acquireNextLocked(input: {
  state: ApplicationState;
  projection: RuntimeProjection;
  actor: string;
  dependencies: AcquireDependencies;
}): Promise<{ projection: RuntimeProjection; action: AgentAction }> {
  const { state, actor, dependencies } = input;
  let projection = { ...input.projection, stages: { ...input.projection.stages }, claims: { ...input.projection.claims }, contexts: { ...input.projection.contexts } };
  if (projection.workItem.status === "closed" || projection.workItem.status === "cancelled") {
    return { projection, action: completed(state.item.workItemId, projection.workItem.status, "Workflow is terminal") };
  }
  const approval = pendingApproval(projection, state.item.workItemId);
  if (approval !== undefined) return { projection, action: approval };
  const profile = selectedProfile(state.snapshot);
  const now = dependencies.now();
  for (const [stepId, claim] of Object.entries(projection.claims)) {
    if (new Date(claim.expiresAt) > now) {
      return {
        projection,
        action: { action: "blocked", problems: [{ code: "WSSPEC_STAGE_ALREADY_CLAIMED", message: `Step ${stepId} already has an active lease`, retryable: true }] },
      };
    }
    const current = projection.stages[stepId];
    if (current?.status === "claimed") projection.stages[stepId] = transitionStage(current, { type: "transition", to: "ready" });
    delete projection.claims[stepId];
    delete projection.contexts[stepId];
  }
  for (const [stepId, stateValue] of Object.entries(projection.stages)) {
    if (stateValue.status === "revision_required") {
      projection.stages[stepId] = transitionStage(stateValue, { type: "transition", to: "ready" });
    } else if (stateValue.status === "failed") {
      const attempt = projection.contexts[stepId] as ApplicationAttemptRecord | undefined;
      if ((attempt?.retryCount ?? 0) < state.snapshot.maxStageRetries) {
        const retrying = transitionStage(stateValue, { type: "transition", to: "retrying" });
        projection.stages[stepId] = transitionStage(retrying, { type: "transition", to: "ready" });
      }
    }
  }
  projection = promoteReady(projection, profile);
  const step = profile.steps.find((candidate) => projection.stages[candidate.id]?.status === "ready");
  if (step === undefined) {
    const exhausted = profile.steps.find((candidate) => projection.stages[candidate.id]?.status === "failed"
      && ((projection.contexts[candidate.id] as ApplicationAttemptRecord | undefined)?.retryCount ?? 0) >= state.snapshot.maxStageRetries);
    if (exhausted !== undefined) {
      return {
        projection,
        action: { action: "blocked", problems: [{ code: "WSSPEC_STEP_RETRY_EXHAUSTED", message: `Step ${exhausted.id} exhausted its retry limit`, retryable: false }] },
      };
    }
    const unfinished = Object.values(projection.stages).some(({ status }) => !["succeeded", "succeeded_with_warnings", "skipped", "cancelled"].includes(status));
    return {
      projection,
      action: unfinished
        ? { action: "blocked", problems: [{ code: "WSSPEC_WORKFLOW_BLOCKED", message: "No executable Step is ready", retryable: true }] }
        : completed(state.item.workItemId, "closed", "Workflow completed"),
    };
  }
  dependencies.executors.assertStep(step as unknown as CompiledStepShape);
  if (step.uses === "control.close") {
    let stage = transitionStage(projection.stages[step.id]!, { type: "transition", to: "running" });
    stage = transitionStage(stage, { type: "transition", to: "validating" });
    stage = transitionStage(stage, { type: "transition", to: "succeeded" });
    let workItem = transitionWorkItem(projection.workItem, { type: "transition", to: "verifying" });
    workItem = transitionWorkItem(workItem, { type: "transition", to: "verified" });
    workItem = transitionWorkItem(workItem, { type: "transition", to: "closed" });
    const applicationClose: ApplicationCloseEvidence = {
      closedAt: now.toISOString(),
      workspaceTreeDigest: await computeWorkspaceTreeDigest(state.worktree),
    };
    projection = {
      ...projection,
      stages: { ...projection.stages, [step.id]: stage },
      workItem,
      evidence: { ...projection.evidence, [applicationCloseEvidenceKey]: applicationClose },
      readOnly: true,
    };
    return { projection, action: completed(state.item.workItemId, "closed", "Workflow completed") };
  }
  const attemptId = `attempt-${crypto.randomUUID()}`;
  const token = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + state.snapshot.leaseTtlSeconds * 1000).toISOString();
  const claim: RuntimeClaim = {
    stageId: step.id,
    attemptId,
    claimToken: token,
    actor,
    claimedAt: now.toISOString(),
    expiresAt,
    inputWorkspaceTreeDigest: await computeWorkspaceTreeDigest(state.worktree),
    allowedPaths: [...state.snapshot.changePolicy.allowedPaths],
    workspaceSnapshot: await computeWorkspaceSnapshot(state.worktree),
  };
  const workPackage = workPackageFor({ workItemId: state.item.workItemId, step, attemptId, token, expiresAt, projection, snapshot: state.snapshot });
  const priorAttempt = projection.contexts[step.id] as ApplicationAttemptRecord | undefined;
  const retryCount = priorAttempt?.result?.status === "failed" ? priorAttempt.retryCount + 1 : priorAttempt?.retryCount ?? 0;
  projection = {
    ...projection,
    stages: { ...projection.stages, [step.id]: transitionStage(projection.stages[step.id]!, { type: "transition", to: "claimed" }) },
    claims: { ...projection.claims, [step.id]: claim },
    contexts: { ...projection.contexts, [step.id]: { workPackage, retryCount } satisfies ApplicationAttemptRecord },
  };
  const executor = dependencies.executors.assertStep(step as unknown as CompiledStepShape);
  const action = await executor.acquire(step as never, projection);
  return { projection, action };
}

type CompiledStepShape = Pick<import("../domain/workflow.js").CompiledStep, "uses" | "action" | "securityClass">;

export async function acquireApplication(input: AcquireInput, dependencies: AcquireDependencies): Promise<AgentAction> {
  validate("builtin.application-acquire-input.v1", input);
  const state = await loadApplicationState(input.root, input.workItemId);
  if (state.projection.workItem.status === "closed" || state.projection.workItem.status === "cancelled") {
    return completed(state.item.workItemId, state.projection.workItem.status, "Workflow is terminal");
  }
  const action = await mutateControlPlane({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: "attempt.acquired",
    idempotencyKey: `acquire:${crypto.randomUUID()}`,
    actor: input.actor,
    operationInput: { actor: input.actor, at: dependencies.now().toISOString() },
    mutate: async (projection) => {
      const acquired = await acquireNextLocked({ state, projection, actor: input.actor, dependencies });
      return { projection: acquired.projection, value: acquired.action };
    },
  });
  if (action.action === "completed" && action.summary.status === "closed") {
    await recoverControlPlane({ cwd: input.root, workItemId: input.workItemId });
  }
  return action;
}
