import { computeWorkspaceSnapshot, computeWorkspaceTreeDigest } from "../domain/digests.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import type { AgentAction, AcquireInput, StepFailureCode, SubmitResult } from "../protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../protocol/work-package.js";
import type { ExecutorRegistry } from "../registry/executors/registry.js";
import { revalidateGlobalSkillLock } from "../registry/skills/resolver.js";
import { validate } from "../schemas/index.js";
import { applicationCloseEvidenceKey, recoverControlPlane, type ApplicationCloseEvidence, type RuntimeClaim, type RuntimeProjection } from "../storage/control-plane.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import { closeChecklist, type CloseDecision } from "../engine/archive.js";
import { conditionScope, evaluateCondition } from "../engine/control/condition.js";
import {
  advanceLoop,
  blockLoop,
  loopLimitProblem,
  loopStepInstanceId,
  startLoop,
  succeedLoop,
} from "../engine/control/loop.js";
import { implementationActors } from "../engine/actor-roles.js";
import {
  acquireRetry,
  interruptedRetry,
  isRetryableStepFailure,
  isStepFailureCode,
  retryExhaustedProblem,
  retryLimit,
  stepFailureProblem,
} from "../engine/control/retry.js";
import { rebindAdditionalGlobalRoots } from "../storage/project-config.js";
import { assertImplementHasTrustedRed, fixedTestGateForState, tddRedEvidenceKey } from "../engine/verification.js";
import type { TrustedEvidence } from "../engine/tdd/types.js";
import type { ApplicationSnapshot, ApplicationState, SnapshotProfile, SnapshotStep } from "./state.js";
import { loadApplicationState, selectedProfile } from "./state.js";

export interface AcquireDependencies {
  now(): Date;
  executors: ExecutorRegistry;
  home: string;
  provider: import("../registry/skills/types.js").SkillProvider;
}

export interface ApplicationStepResult extends SubmitResult {
  failureCode?: StepFailureCode;
}

export interface ApplicationAttemptRecord {
  workPackage: WorkPackage;
  retryCount: number;
  actor?: string;
  stepInstanceId?: string;
  artifactValues?: Record<string, Record<string, unknown>>;
  result?: ApplicationStepResult;
  nextAction?: AgentAction;
}

export interface ApplicationSkippedStepRecord {
  stepInstanceId: string;
  skipped: true;
}

interface AcquiredMutation {
  action: AgentAction;
  skippedStepIds: string[];
  closeDecision?: CloseDecision;
}

export class ApplicationAcquireError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ApplicationAcquireError";
  }
}

function attemptRecord(value: unknown): ApplicationAttemptRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<ApplicationAttemptRecord>;
  return record.workPackage === undefined ? undefined : record as ApplicationAttemptRecord;
}

function skippedRecord(value: unknown): ApplicationSkippedStepRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<ApplicationSkippedStepRecord>;
  return record.skipped === true && typeof record.stepInstanceId === "string"
    ? record as ApplicationSkippedStepRecord
    : undefined;
}

function ownProjection<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function completedResults(projection: RuntimeProjection, stageId: string): ApplicationStepResult[] {
  const direct = attemptRecord(projection.contexts[stageId])?.result;
  const loop = ownProjection(projection.loops, stageId);
  const nested = loop === undefined
    ? []
    : Object.entries(projection.contexts)
      .filter(([key]) => key.startsWith(`${stageId}:${loop.iteration}:`))
      .map(([, value]) => attemptRecord(value)?.result)
      .filter((result): result is ApplicationStepResult => result !== undefined);
  return [...(direct === undefined ? [] : [direct]), ...nested];
}

function promoteReady(projection: RuntimeProjection, profile: SnapshotProfile): { projection: RuntimeProjection; skippedStepIds: string[] } {
  let next = { ...projection, stages: { ...projection.stages } };
  const skippedStepIds: string[] = [];
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
        const skipped = !step.enabled || !evaluateCondition(step.when, conditionScope(next));
        next.stages[step.id] = transitionStage(state, { type: "transition", to: skipped ? "skipped" : "ready" });
        if (step.enabled && skipped) skippedStepIds.push(step.id);
        changed = true;
      }
    }
  }
  return { projection: next, skippedStepIds };
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
    if (requirement.artifact === "red-evidence") {
      const red = input.projection.evidence[tddRedEvidenceKey(input.projection.workItemId)] as TrustedEvidence | undefined;
      if (red?.level === "trusted" && red.phase === "red" && red.taskId === input.projection.workItemId) continue;
    }
    if (requirement.artifact === "red-test-result" && input.step.id === "verify-red") {
      const writeTests = input.projection.contexts["write-tests"] as { result?: { modifiedFiles?: unknown } } | undefined;
      const modifiedFiles = writeTests?.result?.modifiedFiles;
      if (Array.isArray(modifiedFiles) && modifiedFiles.length > 0 && modifiedFiles.every((filename) => typeof filename === "string")) continue;
    }
    let artifact: ArtifactReference | undefined;
    if (requirement.artifact === "requirement-source") {
      artifact = input.snapshot.source;
    } else {
      const candidates = [...ancestors].flatMap((stepId) => {
        const stage = input.projection.stages[stepId];
        if (stage?.status !== "succeeded" && stage?.status !== "succeeded_with_warnings") return [];
        return completedResults(input.projection, stepId).flatMap((result) => result.status !== "completed" ? [] : result.artifacts
          .map((candidate, artifactIndex) => ({ candidate, artifactIndex, stepIndex: order.get(stepId) ?? -1 }))
          .filter(({ candidate }) => candidate.artifactType === requirement.artifact));
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
  stepInstanceId?: string;
  artifacts?: ArtifactReference[];
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
    stepId: input.stepInstanceId ?? input.step.id,
    attemptId: input.attemptId,
    lease: { token: input.token, expiresAt: input.expiresAt },
    objective: input.step.objective ?? `${input.step.uses}${input.step.action === undefined ? "" : `/${input.step.action}`}`,
    ...(input.step.artifactLevel === undefined ? {} : { artifactLevel: input.step.artifactLevel }),
    skills: input.step.skills.map((skill) => ({ ...skill })),
    artifacts: input.artifacts ?? inputArtifacts(input),
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

function loopScope(projection: RuntimeProjection, loopId: string, iteration: number, steps: readonly SnapshotStep[]) {
  const iterationPrefix = `${loopId}:${iteration}:`;
  const loopPrefix = `${loopId}:`;
  const contextKeys = Object.keys(projection.contexts).filter((key) => {
    return key !== loopId && (!key.startsWith(loopPrefix) || key.startsWith(iterationPrefix));
  });
  const statuses: Record<string, { status: string }> = {};
  for (const step of steps) {
    const stepInstanceId = loopStepInstanceId(loopId, iteration, step.id);
    const attempt = attemptRecord(projection.contexts[stepInstanceId]);
    if (attempt?.result?.status === "completed") statuses[step.id] = { status: "succeeded" };
    else if (attempt?.result?.status === "failed") statuses[step.id] = { status: "failed" };
    else if (skippedRecord(projection.contexts[stepInstanceId]) !== undefined) statuses[step.id] = { status: "skipped" };
  }
  return conditionScope(projection, { contextKeys, steps: statuses });
}

function loopInputArtifacts(input: {
  loop: SnapshotStep;
  iteration: number;
  profile: SnapshotProfile;
  projection: RuntimeProjection;
  snapshot: ApplicationSnapshot;
}): ArtifactReference[] {
  const artifacts = new Map(inputArtifacts({
    step: input.loop,
    profile: input.profile,
    projection: input.projection,
    snapshot: input.snapshot,
  }).map((artifact) => [artifact.artifactType, artifact]));
  for (const child of input.loop.steps) {
    const context = attemptRecord(input.projection.contexts[loopStepInstanceId(input.loop.id, input.iteration, child.id)]);
    if (context?.result?.status !== "completed") continue;
    for (const artifact of context.result.artifacts) {
      const current = artifacts.get(artifact.artifactType);
      if ((artifact.revision ?? 0) >= (current?.revision ?? 0)) artifacts.set(artifact.artifactType, artifact);
    }
  }
  return [...artifacts.values()];
}

function loopDependenciesComplete(
  projection: RuntimeProjection,
  loopId: string,
  iteration: number,
  step: SnapshotStep,
): boolean {
  return step.needs.every((dependency) => {
    const context = projection.contexts[loopStepInstanceId(loopId, iteration, dependency)];
    return attemptRecord(context)?.result?.status === "completed" || skippedRecord(context) !== undefined;
  });
}

function exhaustedRetryInstanceId(projection: RuntimeProjection, stageId: string): string | undefined {
  const direct = attemptRecord(projection.contexts[stageId])?.stepInstanceId ?? stageId;
  if (ownProjection(projection.retries, direct)?.status === "exhausted") return direct;
  const loop = ownProjection(projection.loops, stageId);
  if (loop?.status !== "running") return undefined;
  const prefix = `${stageId}:${loop.iteration}:`;
  return Object.keys(projection.retries)
    .filter((stepInstanceId) => stepInstanceId.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right))
    .find((stepInstanceId) => ownProjection(projection.retries, stepInstanceId)?.status === "exhausted");
}

function permanentFailureProblem(projection: RuntimeProjection, stageId: string) {
  const result = attemptRecord(projection.contexts[stageId])?.result;
  return result?.status === "failed"
    && isStepFailureCode(result.failureCode)
    && !isRetryableStepFailure(result.failureCode)
    ? stepFailureProblem(result.failureCode, result.summary)
    : undefined;
}

async function acquireExecutableStep(input: {
  state: ApplicationState;
  projection: RuntimeProjection;
  actor: string;
  stageId: string;
  stepInstanceId: string;
  step: SnapshotStep;
  profile: SnapshotProfile;
  root: string;
  dependencies: AcquireDependencies;
  now: Date;
  artifacts?: ArtifactReference[];
}): Promise<{ projection: RuntimeProjection; action: AgentAction }> {
  const maxAttempts = retryLimit(input.step.retry?.maxAttempts, input.state.snapshot.maxStageRetries);
  const retry = acquireRetry(ownProjection(input.projection.retries, input.stepInstanceId), input.stepInstanceId, maxAttempts);
  const attemptId = `attempt-${crypto.randomUUID()}`;
  const token = crypto.randomUUID();
  const expiresAt = new Date(input.now.getTime() + input.state.snapshot.leaseTtlSeconds * 1000).toISOString();
  const claim: RuntimeClaim = {
    stageId: input.stepInstanceId,
    attemptId,
    claimToken: token,
    actor: input.actor,
    claimedAt: input.now.toISOString(),
    expiresAt,
    inputWorkspaceTreeDigest: await computeWorkspaceTreeDigest(input.state.worktree),
    allowedPaths: [...input.state.snapshot.changePolicy.allowedPaths],
    workspaceSnapshot: await computeWorkspaceSnapshot(input.state.worktree),
  };
  const workPackage = workPackageFor({
    workItemId: input.state.item.workItemId,
    step: input.step,
    attemptId,
    token,
    expiresAt,
    projection: input.projection,
    snapshot: input.state.snapshot,
    profile: input.profile,
    stepInstanceId: input.stepInstanceId,
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
  });
  let projection: RuntimeProjection = {
    ...input.projection,
    stages: {
      ...input.projection.stages,
      [input.stageId]: transitionStage(input.projection.stages[input.stageId]!, { type: "transition", to: "claimed" }),
    },
    claims: { ...input.projection.claims, [input.stageId]: claim },
    contexts: {
      ...input.projection.contexts,
      [input.stageId]: {
        workPackage,
        retryCount: retry.attemptsUsed - 1,
        stepInstanceId: input.stepInstanceId,
      } satisfies ApplicationAttemptRecord,
    },
    retries: { ...input.projection.retries, [input.stepInstanceId]: retry },
  };
  const executorStep = { ...input.step, id: input.stageId };
  const executor = input.dependencies.executors.assertStep(executorStep as unknown as CompiledStepShape);
  const action = await executor.acquire(executorStep as never, projection);
  return { projection, action };
}

async function acquireLoopStep(input: {
  state: ApplicationState;
  projection: RuntimeProjection;
  actor: string;
  root: string;
  dependencies: AcquireDependencies;
  profile: SnapshotProfile;
  step: SnapshotStep;
  now: Date;
  skippedStepIds: string[];
}): Promise<{ projection: RuntimeProjection; action: AgentAction; skippedStepIds: string[] }> {
  if (input.step.until === undefined || input.step.maxIterations === undefined || input.step.steps.length === 0) {
    throw new ApplicationAcquireError("WSSPEC_LOOP_CONFIGURATION_INVALID", `循环 ${input.step.id} 缺少 until、maxIterations 或内部 Step。`);
  }
  let projection = {
    ...input.projection,
    loops: { ...input.projection.loops },
    retries: { ...input.projection.retries },
    contexts: { ...input.projection.contexts },
    stages: { ...input.projection.stages },
  };
  let loop = ownProjection(projection.loops, input.step.id) ?? startLoop(input.step.id, input.step.maxIterations);
  if (loop.maxIterations !== input.step.maxIterations || loop.loopId !== input.step.id) {
    throw new ApplicationAcquireError("WSSPEC_LOOP_PROJECTION_INVALID", `循环 ${input.step.id} 的投影与 Application 快照不一致。`);
  }
  projection.loops[input.step.id] = loop;
  const skippedStepIds = [...input.skippedStepIds];

  while (true) {
    const scope = loopScope(projection, loop.loopId, loop.iteration, input.step.steps);
    const iterationPrefix = `${loop.loopId}:${loop.iteration}:`;
    const hasCompletedStep = Object.entries(projection.contexts).some(([key, value]) => {
      return key.startsWith(iterationPrefix)
        && (attemptRecord(value)?.result?.status === "completed" || skippedRecord(value) !== undefined);
    });
    if (hasCompletedStep && evaluateCondition(input.step.until, scope)) {
      loop = succeedLoop(loop);
      let stage = transitionStage(projection.stages[input.step.id]!, { type: "transition", to: "running" });
      stage = transitionStage(stage, { type: "transition", to: "validating" });
      stage = transitionStage(stage, { type: "transition", to: "succeeded" });
      projection = {
        ...projection,
        loops: { ...projection.loops, [loop.loopId]: loop },
        stages: { ...projection.stages, [input.step.id]: stage },
      };
      return acquireNextLocked({
        state: input.state,
        projection,
        actor: input.actor,
        root: input.root,
        dependencies: input.dependencies,
      });
    }

    let selected: { step: SnapshotStep; stepInstanceId: string } | undefined;
    let skippedThisPass = false;
    for (const child of input.step.steps) {
      const stepInstanceId = loopStepInstanceId(loop.loopId, loop.iteration, child.id);
      const attempt = attemptRecord(projection.contexts[stepInstanceId]);
      if (attempt?.result?.status === "completed" || skippedRecord(projection.contexts[stepInstanceId]) !== undefined) continue;
      if (!loopDependenciesComplete(projection, loop.loopId, loop.iteration, child)) continue;
      if (attempt?.result?.status === "failed") {
        const retry = ownProjection(projection.retries, stepInstanceId);
        if (retry?.status === "exhausted") {
          return { projection, action: { action: "blocked", problems: [retryExhaustedProblem(stepInstanceId)] }, skippedStepIds };
        }
        selected = { step: child, stepInstanceId };
        break;
      }
      if (!evaluateCondition(child.when, scope)) {
        projection.contexts[stepInstanceId] = { stepInstanceId, skipped: true } satisfies ApplicationSkippedStepRecord;
        skippedStepIds.push(stepInstanceId);
        skippedThisPass = true;
        continue;
      }
      selected = { step: child, stepInstanceId };
      break;
    }

    if (selected !== undefined) {
      if (input.step.independentReviewActor === true && selected.step.actorRole === "review") {
        const actors = implementationActors({ profile: input.profile, projection: input.projection, loopId: loop.loopId, iteration: loop.iteration });
        if (actors === undefined || actors.has(input.actor)) {
          return {
            projection,
            action: {
              action: "blocked",
              problems: [{
                code: "WSSPEC_INDEPENDENT_REVIEW_REQUIRED",
                message: "Governed Review 必须由不同于实现者的独立 Actor 执行。",
                retryable: true,
              }],
            },
            skippedStepIds,
          };
        }
      }
      const acquired = await acquireExecutableStep({
        state: input.state,
        projection,
        actor: input.actor,
        stageId: input.step.id,
        stepInstanceId: selected.stepInstanceId,
        step: selected.step,
        profile: input.profile,
        root: input.root,
        dependencies: input.dependencies,
        now: input.now,
        artifacts: loopInputArtifacts({
          loop: input.step,
          iteration: loop.iteration,
          profile: input.profile,
          projection,
          snapshot: input.state.snapshot,
        }),
      });
      return { projection: acquired.projection, action: acquired.action, skippedStepIds };
    }
    if (skippedThisPass) continue;

    if (loop.iteration >= loop.maxIterations) {
      loop = blockLoop(loop);
      let stage = transitionStage(projection.stages[input.step.id]!, { type: "transition", to: "running" });
      stage = transitionStage(stage, { type: "transition", to: "failed" });
      projection = {
        ...projection,
        loops: { ...projection.loops, [loop.loopId]: loop },
        stages: { ...projection.stages, [input.step.id]: stage },
      };
      return { projection, action: { action: "blocked", problems: [loopLimitProblem(loop)] }, skippedStepIds };
    }
    loop = advanceLoop(loop);
    projection.loops[loop.loopId] = loop;
  }
}

export async function acquireNextLocked(input: {
  state: ApplicationState;
  projection: RuntimeProjection;
  actor: string;
  root: string;
  dependencies: AcquireDependencies;
}): Promise<{ projection: RuntimeProjection; action: AgentAction; skippedStepIds: string[]; closeDecision?: CloseDecision }> {
  const { state, actor, dependencies } = input;
  let projection = {
    ...input.projection,
    stages: { ...input.projection.stages },
    claims: { ...input.projection.claims },
    contexts: { ...input.projection.contexts },
    loops: { ...input.projection.loops },
    retries: { ...input.projection.retries },
  };
  if (projection.workItem.status === "closed" || projection.workItem.status === "cancelled") {
    return { projection, action: completed(state.item.workItemId, projection.workItem.status, "Workflow 已结束。"), skippedStepIds: [] };
  }
  const approval = pendingApproval(projection, state.item.workItemId);
  if (approval !== undefined) return { projection, action: approval, skippedStepIds: [] };
  const profile = selectedProfile(state.snapshot);
  const now = dependencies.now();
  for (const [stepId, claim] of Object.entries(projection.claims)) {
    if (new Date(claim.expiresAt) > now) {
      return {
        projection,
        action: { action: "blocked", problems: [{ code: "WSSPEC_STAGE_ALREADY_CLAIMED", message: `步骤 ${claim.stageId} 已有活动 Lease。`, retryable: true }] },
        skippedStepIds: [],
      };
    }
    const retry = ownProjection(projection.retries, claim.stageId);
    if (retry !== undefined) projection.retries[claim.stageId] = interruptedRetry(retry);
    const current = projection.stages[stepId];
    if (current?.status === "claimed") {
      projection.stages[stepId] = ownProjection(projection.retries, claim.stageId)?.status === "exhausted"
        ? transitionStage(transitionStage(current, { type: "transition", to: "running" }), { type: "transition", to: "failed" })
        : transitionStage(current, { type: "transition", to: "ready" });
    }
    delete projection.claims[stepId];
    delete projection.contexts[stepId];
  }
  for (const [stepId, stateValue] of Object.entries(projection.stages)) {
    if (stateValue.status === "revision_required") {
      projection.stages[stepId] = transitionStage(stateValue, { type: "transition", to: "ready" });
    } else if (stateValue.status === "failed") {
      const stepInstanceId = attemptRecord(projection.contexts[stepId])?.stepInstanceId ?? stepId;
      if (ownProjection(projection.retries, stepInstanceId)?.status === "ready") {
        const retrying = transitionStage(stateValue, { type: "transition", to: "retrying" });
        projection.stages[stepId] = transitionStage(retrying, { type: "transition", to: "ready" });
      }
    }
  }
  const promoted = promoteReady(projection, profile);
  projection = promoted.projection;
  const step = profile.steps.find((candidate) => projection.stages[candidate.id]?.status === "ready");
  if (step === undefined) {
    const blocked = profile.steps.map((candidate) => {
      if (projection.stages[candidate.id]?.status !== "failed") return false;
      const loop = ownProjection(projection.loops, candidate.id);
      if (loop?.status === "blocked") return { step: candidate, problem: loopLimitProblem(loop) };
      const stepInstanceId = exhaustedRetryInstanceId(projection, candidate.id);
      if (stepInstanceId !== undefined) return { step: candidate, problem: retryExhaustedProblem(stepInstanceId) };
      const problem = permanentFailureProblem(projection, candidate.id);
      return problem === undefined ? false : { step: candidate, problem };
    }).find((candidate) => candidate !== false);
    if (blocked !== undefined) {
      return {
        projection,
        action: { action: "blocked", problems: [blocked.problem] },
        skippedStepIds: promoted.skippedStepIds,
      };
    }
    const unfinished = Object.values(projection.stages).some(({ status }) => !["succeeded", "succeeded_with_warnings", "skipped", "cancelled"].includes(status));
    return {
      projection,
      action: unfinished
        ? { action: "blocked", problems: [{ code: "WSSPEC_WORKFLOW_BLOCKED", message: "没有可执行的步骤。", retryable: true }] }
        : completed(state.item.workItemId, "closed", "Workflow 已完成。"),
      skippedStepIds: promoted.skippedStepIds,
    };
  }
  if (step.id === "implement") {
    const gate = await fixedTestGateForState(state);
    await assertImplementHasTrustedRed({
      taskId: state.item.workItemId,
      commandId: gate.commandId,
      gate,
      worktree: state.worktree,
      redEvidence: projection.evidence[tddRedEvidenceKey(state.item.workItemId)] as TrustedEvidence | undefined,
      requireWorkspaceMatch: true,
    });
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
  if (step.uses === "control.loop") {
    return acquireLoopStep({
      state,
      projection,
      actor,
      root: input.root,
      dependencies,
      profile,
      step,
      now,
      skippedStepIds: promoted.skippedStepIds,
    });
  }
  if (step.uses === "control.close") {
    const workspaceTreeDigest = await computeWorkspaceTreeDigest(state.worktree);
    const decision = closeChecklist({
      profile,
      projection,
      gatePolicy: state.snapshot.gatePolicy,
      gates: state.snapshot.gates,
      workspaceTreeDigest,
      configDigest: state.item.execution.configDigest,
    });
    if (!decision.allowed) {
      let workItem = transitionWorkItem(projection.workItem, { type: "transition", to: "verifying" });
      workItem = transitionWorkItem(workItem, { type: "transition", to: "blocked" });
      projection = {
        ...projection,
        workItem,
        evidence: {
          ...projection.evidence,
          "application.close-checklist": {
            checkedAt: now.toISOString(),
            workspaceTreeDigest,
            decision,
          },
        },
      };
      const missing = decision.missing.map(({ category, id }) => `${category}:${id}`).join(", ");
      return {
        projection,
        action: {
          action: "blocked",
          problems: [{
            code: "WSSPEC_CLOSE_CHECKLIST_INCOMPLETE",
            message: `Close checklist 未满足：${missing}`,
            retryable: true,
          }],
        },
        skippedStepIds: promoted.skippedStepIds,
        closeDecision: decision,
      };
    }
    let stage = transitionStage(projection.stages[step.id]!, { type: "transition", to: "running" });
    stage = transitionStage(stage, { type: "transition", to: "validating" });
    stage = transitionStage(stage, { type: "transition", to: "succeeded" });
    let workItem = transitionWorkItem(projection.workItem, { type: "transition", to: "verifying" });
    workItem = transitionWorkItem(workItem, { type: "transition", to: "verified" });
    workItem = transitionWorkItem(workItem, { type: "transition", to: "closed" });
    const applicationClose: ApplicationCloseEvidence = {
      closedAt: now.toISOString(),
      workspaceTreeDigest,
    };
    projection = {
      ...projection,
      stages: { ...projection.stages, [step.id]: stage },
      workItem,
      evidence: { ...projection.evidence, [applicationCloseEvidenceKey]: applicationClose },
      readOnly: true,
    };
    return {
      projection,
      action: completed(state.item.workItemId, "closed", "Workflow 已完成。"),
      skippedStepIds: promoted.skippedStepIds,
      closeDecision: decision,
    };
  }
  const acquired = await acquireExecutableStep({
    state,
    projection,
    actor,
    stageId: step.id,
    stepInstanceId: step.id,
    step,
    profile,
    root: input.root,
    dependencies,
    now,
  });
  return { projection: acquired.projection, action: acquired.action, skippedStepIds: promoted.skippedStepIds };
}

type CompiledStepShape = Pick<import("../domain/workflow.js").CompiledStep, "uses" | "action" | "securityClass">;

export async function acquireApplication(input: AcquireInput, dependencies: AcquireDependencies): Promise<AgentAction> {
  validate("builtin.application-acquire-input.v1", input);
  const state = await loadApplicationState(input.root, input.workItemId);
  if (state.projection.workItem.status === "closed" || state.projection.workItem.status === "cancelled") {
    return completed(state.item.workItemId, state.projection.workItem.status, "Workflow 已结束。");
  }
  const action = await mutateControlPlane<AcquiredMutation>({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: (value) => {
      if (value.action.action === "completed" && value.action.summary.status === "closed") return "work-item.closed";
      if (value.closeDecision !== undefined) return "evidence.recorded";
      return value.skippedStepIds.length > 0 ? "step.skipped" : "attempt.acquired";
    },
    stageId: (value) => value.skippedStepIds[0],
    idempotencyKey: `acquire:${crypto.randomUUID()}`,
    actor: input.actor,
    operationInput: { actor: input.actor, at: dependencies.now().toISOString() },
    eventDetails: (value) => ({
      ...(value.skippedStepIds.length === 0 ? {} : { skippedStepIds: value.skippedStepIds }),
      ...(value.closeDecision === undefined ? {} : { closeDecision: value.closeDecision }),
    }),
    mutate: async (projection) => {
      const acquired = await acquireNextLocked({ state, projection, actor: input.actor, root: input.root, dependencies });
      return {
        projection: acquired.projection,
        value: {
          action: acquired.action,
          skippedStepIds: acquired.skippedStepIds,
          ...(acquired.closeDecision === undefined ? {} : { closeDecision: acquired.closeDecision }),
        },
      };
    },
  });
  if (action.action.action === "completed" && action.action.summary.status === "closed") {
    await recoverControlPlane({ cwd: input.root, workItemId: input.workItemId });
  }
  return action.action;
}
