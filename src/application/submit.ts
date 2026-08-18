import path from "node:path";

import { verifyArtifact } from "../domain/artifacts.js";
import { computeWorkspaceSnapshot, type TreeEntry } from "../domain/digests.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { prepareArtifactApproval } from "../engine/approvals.js";
import { parseLoopStepInstanceId, projectArtifactValues } from "../engine/control/loop.js";
import {
  failRetry,
  isRetryableStepFailure,
  isStepFailureCode,
  retryFailureProblem,
  stepFailureProblem,
} from "../engine/control/retry.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import type { AgentAction, SubmitInput, SubmitResult } from "../protocol/application.js";
import type { ArtifactReference } from "../protocol/work-package.js";
import type { ExecutorRegistry } from "../registry/executors/registry.js";
import { validate } from "../schemas/index.js";
import { recoverControlPlane, type RuntimeProjection } from "../storage/control-plane.js";
import { acquireNextLocked, type AcquireDependencies, type ApplicationAttemptRecord, type ApplicationStepResult } from "./acquire.js";
import { loadApplicationState, selectedProfile, type ApplicationState, type SnapshotStep } from "./state.js";

export interface SubmitDependencies extends AcquireDependencies {
  executors: ExecutorRegistry;
}

export class ApplicationSubmitError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ApplicationSubmitError";
  }
}

interface ExecutionTarget {
  stageId: string;
  stepInstanceId: string;
  step: SnapshotStep;
  internal: boolean;
}

function ownProjection<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function executionTarget(profile: ReturnType<typeof selectedProfile>, projection: RuntimeProjection, stepInstanceId: string): ExecutionTarget {
  const topLevel = profile.steps.find((candidate) => candidate.id === stepInstanceId);
  if (topLevel !== undefined) return { stageId: topLevel.id, stepInstanceId, step: topLevel, internal: false };
  const parsed = parseLoopStepInstanceId(stepInstanceId);
  if (parsed === undefined) throw new ApplicationSubmitError("WSSPEC_STAGE_NOT_FOUND", `找不到 Step ${stepInstanceId}。 `);
  const loopStep = profile.steps.find((candidate) => candidate.id === parsed.loopId && candidate.uses === "control.loop");
  const loop = ownProjection(projection.loops, parsed.loopId);
  const child = loopStep?.steps.find((candidate) => candidate.id === parsed.stepId);
  if (loopStep === undefined || child === undefined || loop?.status !== "running" || loop.iteration !== parsed.iteration) {
    throw new ApplicationSubmitError("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 所属循环轮次已失效。 ");
  }
  return { stageId: loopStep.id, stepInstanceId, step: child, internal: true };
}

function internalPath(workItemId: string, filename: string): boolean {
  return filename === `.wsspec/work-items/${workItemId}` || filename.startsWith(`.wsspec/work-items/${workItemId}/`);
}

async function actualChangedFiles(state: ApplicationState, before: readonly TreeEntry[]): Promise<string[]> {
  const after = await computeWorkspaceSnapshot(state.worktree);
  const beforeByPath = new Map(before.map((entry) => [entry.path, JSON.stringify(entry)]));
  const afterByPath = new Map(after.map((entry) => [entry.path, JSON.stringify(entry)]));
  return [...new Set([...beforeByPath.keys(), ...afterByPath.keys()].filter((file) => beforeByPath.get(file) !== afterByPath.get(file)))]
    .filter((file) => !internalPath(state.item.workItemId, file))
    .sort((left, right) => left.localeCompare(right));
}

function glob(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function permitted(file: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowed) => glob(allowed).test(file));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort((a, b) => a.localeCompare(b));
  const normalizedRight = [...new Set(right)].sort((a, b) => a.localeCompare(b));
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

async function verifySubmittedArtifact(state: ApplicationState, step: SnapshotStep, attemptId: string, reference: ArtifactReference): Promise<void> {
  if (reference.artifactType === "requirement-source") {
    if (JSON.stringify(reference) !== JSON.stringify(state.snapshot.source)) {
      throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", "Requirement Source Artifact 与不可变快照不一致。 ");
    }
    return;
  }
  if (reference.path === undefined || reference.contentHash === undefined || reference.revision === undefined) {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", `Artifact ${reference.artifactType} 缺少路径、revision 或摘要。 `);
  }
  const normalized = reference.path.replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", "Artifact 路径必须位于工作区内。 ");
  }
  const filename = path.join(state.worktree, normalized);
  const verified = await verifyArtifact(filename, {
    repositoryRoot: state.worktree,
    artifactType: reference.artifactType,
    workItemId: state.item.workItemId,
    stageId: step.id,
    attemptId,
  }, { allowUnregisteredType: true });
  if (verified.artifactType !== reference.artifactType
    || verified.schemaVersion !== reference.schemaVersion
    || verified.path !== normalized
    || verified.revision !== reference.revision
    || verified.contentHash !== reference.contentHash
    || (reference.mediaType !== undefined && verified.mediaType !== reference.mediaType)) {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", `Artifact ${reference.artifactType} 身份与提交引用不一致。 `);
  }
}

async function validateResult(input: SubmitInput, state: ApplicationState, target: ExecutionTarget, projection: RuntimeProjection, now: Date): Promise<void> {
  const claim = projection.claims[target.stageId];
  const context = projection.contexts[target.stageId] as ApplicationAttemptRecord | undefined;
  if (claim?.stageId !== input.stepId || claim.attemptId !== input.attemptId || claim.claimToken !== input.leaseToken || context?.workPackage.stepId !== input.stepId || context.workPackage.attemptId !== input.attemptId || context.workPackage.lease.token !== input.leaseToken) {
    throw new ApplicationSubmitError("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 或 Lease 已失效。 ");
  }
  if (new Date(claim.expiresAt) <= now) {
    throw new ApplicationSubmitError("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt Lease 已过期。 ");
  }
  const changed = await actualChangedFiles(state, claim.workspaceSnapshot);
  if (state.snapshot.changePolicy.kind === "documentation-only" && changed.some((file) => !permitted(file, state.snapshot.changePolicy.allowedPaths))) {
    throw new ApplicationSubmitError("WSSPEC_DOCUMENTATION_SCOPE_VIOLATION", "实际 Git diff 越出 documentation-only 路径边界。 ");
  }
  if (!sameStrings(changed, input.result.modifiedFiles)) {
    throw new ApplicationSubmitError("WSSPEC_MODIFIED_FILES_MISMATCH", "提交结果的 modifiedFiles 与实际 Git diff 不一致。 ");
  }
  const declaredOutputs = new Set(target.step.outputs.map((output) => output.artifact));
  const undeclared = input.result.artifacts.find((artifact) => !declaredOutputs.has(artifact.artifactType));
  if (undeclared !== undefined) {
    throw new ApplicationSubmitError("WSSPEC_UNDECLARED_ARTIFACT", `Artifact ${undeclared.artifactType} 未在 Step outputs 中声明。 `);
  }
  for (const artifact of input.result.artifacts) await verifySubmittedArtifact(state, { ...target.step, id: input.stepId }, input.attemptId, artifact);
  if (input.result.status === "completed") {
    for (const output of target.step.outputs.filter((candidate) => candidate.required)) {
      if (!input.result.artifacts.some((artifact) => artifact.artifactType === output.artifact)) {
        throw new ApplicationSubmitError("WSSPEC_REQUIRED_ARTIFACT_MISSING", `缺少必需 Artifact ${output.artifact}。 `);
      }
    }
  }
}

function approvalAction(state: ApplicationState, request: Awaited<ReturnType<typeof prepareArtifactApproval>>): AgentAction {
  return {
    action: "await_approval",
    approval: {
      kind: "step",
      requestId: request.requestId,
      workItemId: state.item.workItemId,
      title: `审批 ${request.stageId}`,
      digest: request.contentHash,
    },
  };
}

function trustedSubmitResult(
  submitted: SubmitResult,
  validated: Awaited<ReturnType<ReturnType<ExecutorRegistry["assertStep"]>["validate"]>>,
): ApplicationStepResult {
  if (validated.status !== submitted.status) {
    throw new ApplicationSubmitError("WSSPEC_STEP_FAILURE_CLASSIFICATION_INVALID", "Executor 返回的状态与 SubmitResult 不一致。 ");
  }
  if (submitted.status === "failed") {
    if (!isStepFailureCode(validated.failureCode)) {
      throw new ApplicationSubmitError("WSSPEC_STEP_FAILURE_CLASSIFICATION_INVALID", "Executor 未返回受支持的稳定失败码。 ");
    }
    return { ...submitted, failureCode: validated.failureCode };
  }
  if (validated.failureCode !== undefined) {
    throw new ApplicationSubmitError("WSSPEC_STEP_FAILURE_CLASSIFICATION_INVALID", "成功结果不能携带失败码。 ");
  }
  return submitted;
}

export async function submitApplication(input: SubmitInput, dependencies: SubmitDependencies): Promise<AgentAction> {
  validate("builtin.application-submit-input.v1", input);
  validate<SubmitResult>("builtin.submit-result.v1", input.result);
  const state = await loadApplicationState(input.root, input.workItemId);
  const profile = selectedProfile(state.snapshot);
  const { root: _root, ...operationInput } = input;
  const action = await mutateControlPlane({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: "attempt.submitted",
    idempotencyKey: `submit:${input.attemptId}`,
    stageId: input.stepId,
    attemptId: input.attemptId,
    operationInput,
    mutate: async (current) => {
      const target = executionTarget(profile, current, input.stepId);
      await validateResult(input, state, target, current, dependencies.now());
      const executorStep = { ...target.step, id: target.stageId };
      const result = trustedSubmitResult(
        input.result,
        await dependencies.executors.assertStep(executorStep as never).validate(executorStep as never, input.result, current),
      );
      if (target.internal && target.step.approval) {
        throw new ApplicationSubmitError("WSSPEC_LOOP_STEP_APPROVAL_UNSUPPORTED", "循环内部 Step 暂不支持审批。 ");
      }
      const active = current.contexts[target.stageId] as ApplicationAttemptRecord;
      const artifactValues = await projectArtifactValues(state.worktree, result.artifacts);
      const record: ApplicationAttemptRecord = {
        workPackage: active.workPackage,
        retryCount: active.retryCount,
        stepInstanceId: target.stepInstanceId,
        artifactValues,
        result,
      };
      let projection: RuntimeProjection = {
        ...current,
        stages: { ...current.stages },
        claims: { ...current.claims },
        contexts: { ...current.contexts, [target.stageId]: record },
        retries: { ...current.retries },
      };
      if (target.internal) projection.contexts[target.stepInstanceId] = record;
      const actor = current.claims[target.stageId]!.actor;
      delete projection.claims[target.stageId];
      if (result.status === "failed") {
        const running = transitionStage(current.stages[target.stageId]!, { type: "transition", to: "running" });
        projection.stages[target.stageId] = transitionStage(running, { type: "transition", to: "failed" });
        const retry = ownProjection(projection.retries, target.stepInstanceId);
        if (retry === undefined) throw new ApplicationSubmitError("WSSPEC_RETRY_PROJECTION_INVALID", `步骤 ${target.stepInstanceId} 缺少重试投影。 `);
        const failureCode = result.failureCode!;
        if (!isRetryableStepFailure(failureCode)) {
          delete projection.retries[target.stepInstanceId];
          return {
            projection,
            value: { action: "blocked", problems: [stepFailureProblem(failureCode, result.summary)] } satisfies AgentAction,
          };
        }
        const failedRetry = failRetry(retry);
        projection.retries[target.stepInstanceId] = failedRetry;
        return {
          projection,
          value: { action: "blocked", problems: [retryFailureProblem(failedRetry, result.summary)] } satisfies AgentAction,
        };
      }
      delete projection.retries[target.stepInstanceId];
      if (target.internal) {
        projection.stages[target.stageId] = transitionStage(current.stages[target.stageId]!, { type: "transition", to: "ready" });
        delete projection.contexts[target.stageId];
        const next = await acquireNextLocked({ state, projection, actor, root: input.root, dependencies });
        return { projection: next.projection, value: next.action };
      }
      const running = transitionStage(current.stages[target.stageId]!, { type: "transition", to: "running" });
      const validating = transitionStage(running, { type: "transition", to: "validating" });
      projection.stages[target.stageId] = validating;
      if (target.step.approval) {
        const artifacts = result.artifacts.filter((candidate) => candidate.path !== undefined);
        if (artifacts.length === 0) throw new ApplicationSubmitError("WSSPEC_REQUIRED_ARTIFACT_MISSING", "审批 Step 必须提交可校验 Artifact。 ");
        const request = await prepareArtifactApproval({ cwd: input.root, workItemId: input.workItemId, stageId: target.stageId, attemptId: input.attemptId, artifacts, now: dependencies.now() });
        projection = {
          ...projection,
          workItem: transitionWorkItem(projection.workItem, { type: "transition", to: "awaiting_approval" }),
          stages: { ...projection.stages, [target.stageId]: transitionStage(validating, { type: "transition", to: "awaiting_approval" }) },
          approvals: { ...projection.approvals, [request.requestId]: request },
        };
        return { projection, value: approvalAction(state, request) };
      }
      projection.stages[target.stageId] = transitionStage(validating, { type: "transition", to: "succeeded" });
      const next = await acquireNextLocked({ state, projection, actor, root: input.root, dependencies });
      return { projection: next.projection, value: next.action };
    },
  });
  if (action.action === "completed" && action.summary.status === "closed") {
    await recoverControlPlane({ cwd: input.root, workItemId: input.workItemId });
  }
  return action;
}
