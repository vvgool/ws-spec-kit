import { computeWorkspaceSnapshot, computeWorkspaceTreeDigest } from "../domain/digests.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import type { AgentAction, AcquireInput, SubmitResult } from "../protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../protocol/work-package.js";
import type { ExecutorRegistry } from "../registry/executors/registry.js";
import { revalidateGlobalSkillLock } from "../registry/skills/resolver.js";
import { validate } from "../schemas/index.js";
import { applicationCloseEvidenceKey, recoverControlPlane, type ApplicationCloseEvidence, type RuntimeClaim, type RuntimeProjection } from "../storage/control-plane.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import { rebindAdditionalGlobalRoots } from "../storage/project-config.js";
import type { ApplicationSnapshot, ApplicationState, SnapshotProfile, SnapshotStep } from "./state.js";
import { loadApplicationState, selectedProfile } from "./state.js";

export interface AcquireDependencies {
  now(): Date;
  executors: ExecutorRegistry;
  home: string;
  provider: import("../registry/skills/types.js").SkillProvider;
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
      title: `审批 ${approval.stageId}`,
      digest: approval.contentHash,
    },
  };
}

function dependencyClosure(stepId: string, profile: SnapshotProfile): Set<string> {
  const byId = new Map(profile.steps.map((step) => [step.id, step]));
  const result = new Set<string>();
  const visit = (candidate: string): void => {
    for (const dependency of byId.get(candidate)?.needs ?? []) {
      if (result.has(dependency)) continue;
      result.add(dependency);
      visit(dependency);
    }
  };
  visit(stepId);
  return result;
}

function inputArtifacts(input: {
  step: SnapshotStep;
  profile: SnapshotProfile;
  projection: RuntimeProjection;
  snapshot: ApplicationSnapshot;
}): ArtifactReference[] {
  const ancestors = dependencyClosure(input.step.id, input.profile);
  const order = new Map(input.profile.order.map((stepId, index) => [stepId, index]));
  const selected: ArtifactReference[] = [];
  const seen = new Set<string>();
  for (const requirement of input.step.inputs) {
    if (seen.has(requirement.artifact)) continue;
    seen.add(requirement.artifact);
    let artifact: ArtifactReference | undefined;
    if (requirement.artifact === "requirement-source") {
      artifact = input.snapshot.source;
    } else {
      const candidates = [...ancestors].flatMap((stepId) => {
        const stage = input.projection.stages[stepId];
        const result = (input.projection.contexts[stepId] as ApplicationAttemptRecord | undefined)?.result;
        if ((stage?.status !== "succeeded" && stage?.status !== "succeeded_with_warnings") || result?.status !== "completed") return [];
        return result.artifacts
          .map((candidate, artifactIndex) => ({ candidate, artifactIndex, stepIndex: order.get(stepId) ?? -1 }))
          .filter(({ candidate }) => candidate.artifactType === requirement.artifact);
      });
      candidates.sort((left, right) => (right.candidate.revision ?? 0) - (left.candidate.revision ?? 0)
        || right.stepIndex - left.stepIndex
        || right.artifactIndex - left.artifactIndex);
      artifact = candidates[0]?.candidate;
    }
    if (artifact !== undefined) selected.push(artifact);
    else if (requirement.required) {
      throw new ApplicationAcquireError("WSSPEC_REQUIRED_INPUT_ARTIFACT_MISSING", `步骤 ${input.step.id} 缺少必需输入 Artifact ${requirement.artifact}。`);
    }
  }
  return selected;
}

function workPackageFor(input: {
  workItemId: string;
  step: SnapshotStep;
  attemptId: string;
  token: string;
  expiresAt: string;
  projection: RuntimeProjection;
  snapshot: ApplicationSnapshot;
  profile: SnapshotProfile;
}): WorkPackage {
  const gatesById = new Map(input.snapshot.gates.map((gate) => [gate.id, gate]));
  const requiredOutputs = input.step.outputs.filter((output) => output.required).map((output) => {
    if (output.artifact === "requirement-source") return input.snapshot.source;
    return {
      artifactType: output.artifact,
      schemaVersion: 1,
      ...(output.contentLevel === undefined ? {} : { contentLevel: output.contentLevel }),
    } as const;
  });
  const value: WorkPackage = {
    version: 1,
    workItemId: input.workItemId as `WSS-${string}`,
    stepId: input.step.id,
    attemptId: input.attemptId,
    lease: { token: input.token, expiresAt: input.expiresAt },
    objective: input.step.objective ?? `${input.step.uses}${input.step.action === undefined ? "" : `/${input.step.action}`}`,
    ...(input.step.artifactLevel === undefined ? {} : { artifactLevel: input.step.artifactLevel }),
    skills: input.step.skills.map((skill) => ({ ...skill })),
    artifacts: inputArtifacts(input),
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
  root: string;
  dependencies: AcquireDependencies;
}): Promise<{ projection: RuntimeProjection; action: AgentAction }> {
  const { state, actor, dependencies } = input;
  let projection = { ...input.projection, stages: { ...input.projection.stages }, claims: { ...input.projection.claims }, contexts: { ...input.projection.contexts } };
  if (projection.workItem.status === "closed" || projection.workItem.status === "cancelled") {
    return { projection, action: completed(state.item.workItemId, projection.workItem.status, "Workflow 已结束。") };
  }
  const approval = pendingApproval(projection, state.item.workItemId);
  if (approval !== undefined) return { projection, action: approval };
  const profile = selectedProfile(state.snapshot);
  const now = dependencies.now();
  for (const [stepId, claim] of Object.entries(projection.claims)) {
    if (new Date(claim.expiresAt) > now) {
      return {
        projection,
        action: { action: "blocked", problems: [{ code: "WSSPEC_STAGE_ALREADY_CLAIMED", message: `步骤 ${stepId} 已有活动 Lease。`, retryable: true }] },
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
        action: { action: "blocked", problems: [{ code: "WSSPEC_STEP_RETRY_EXHAUSTED", message: `步骤 ${exhausted.id} 已耗尽重试次数。`, retryable: false }] },
      };
    }
    const unfinished = Object.values(projection.stages).some(({ status }) => !["succeeded", "succeeded_with_warnings", "skipped", "cancelled"].includes(status));
    return {
      projection,
      action: unfinished
        ? { action: "blocked", problems: [{ code: "WSSPEC_WORKFLOW_BLOCKED", message: "没有可执行的步骤。", retryable: true }] }
        : completed(state.item.workItemId, "closed", "Workflow 已完成。"),
    };
  }
  const additionalGlobalRoots = await rebindAdditionalGlobalRoots({
    root: input.root,
    rootIds: state.snapshot.skillResolution.additionalGlobalRootIds,
  });
  await revalidateGlobalSkillLock({
    lock: state.snapshot.skillLock,
    provider: state.snapshot.skillResolution.provider,
    projectRoot: state.worktree,
    home: dependencies.home,
    additionalGlobalRoots,
  });
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
    return { projection, action: completed(state.item.workItemId, "closed", "Workflow 已完成。") };
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
  const workPackage = workPackageFor({ workItemId: state.item.workItemId, step, attemptId, token, expiresAt, projection, snapshot: state.snapshot, profile });
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
    return completed(state.item.workItemId, state.projection.workItem.status, "Workflow 已结束。");
  }
  const action = await mutateControlPlane({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: "attempt.acquired",
    idempotencyKey: `acquire:${crypto.randomUUID()}`,
    actor: input.actor,
    operationInput: { actor: input.actor, at: dependencies.now().toISOString() },
    mutate: async (projection) => {
      const acquired = await acquireNextLocked({ state, projection, actor: input.actor, root: input.root, dependencies });
      return { projection: acquired.projection, value: acquired.action };
    },
  });
  if (action.action === "completed" && action.summary.status === "closed") {
    await recoverControlPlane({ cwd: input.root, workItemId: input.workItemId });
  }
  return action;
}
