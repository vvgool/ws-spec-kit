import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { computeArtifactContentHash, readArtifact } from "../domain/artifacts.js";
import { computeWorkspaceSnapshot, type TreeEntry } from "../domain/digests.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { prepareArtifactApproval } from "../engine/approvals.js";
import { mutateControlPlane } from "../engine/scheduler.js";
import type { AgentAction, SubmitInput, SubmitResult } from "../protocol/application.js";
import type { ArtifactReference } from "../protocol/work-package.js";
import type { ExecutorRegistry } from "../registry/executors/registry.js";
import { validate } from "../schemas/index.js";
import { recoverControlPlane, type RuntimeProjection } from "../storage/control-plane.js";
import { acquireNextLocked, type AcquireDependencies, type ApplicationAttemptRecord } from "./acquire.js";
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
  const [realRoot, realFile] = await Promise.all([realpath(state.worktree), realpath(filename)]);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", "Artifact 真实路径越出工作区。 ");
  }
  const artifact = await readArtifact(realFile);
  if (artifact.metadata.artifactType !== reference.artifactType
    || artifact.metadata.workItemId !== state.item.workItemId
    || artifact.metadata.stageId !== step.id
    || artifact.metadata.attemptId !== attemptId
    || artifact.metadata.revision !== reference.revision
    || artifact.metadata.contentHash !== reference.contentHash) {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", `Artifact ${reference.artifactType} 身份与提交引用不一致。 `);
  }
  const { contentHash: _contentHash, ...metadata } = artifact.metadata;
  if (computeArtifactContentHash(metadata, artifact.body) !== reference.contentHash) {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_HASH_MISMATCH", `Artifact ${reference.artifactType} 内容摘要不匹配。 `);
  }
}

async function validateResult(input: SubmitInput, state: ApplicationState, step: SnapshotStep, projection: RuntimeProjection, now: Date): Promise<void> {
  const claim = projection.claims[input.stepId];
  const context = projection.contexts[input.stepId] as ApplicationAttemptRecord | undefined;
  if (claim?.attemptId !== input.attemptId || claim.claimToken !== input.leaseToken || context?.workPackage.attemptId !== input.attemptId || context.workPackage.lease.token !== input.leaseToken) {
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
    throw new ApplicationSubmitError("WSSPEC_MODIFIED_FILES_MISMATCH", "SubmitResult.modifiedFiles 与实际 Git diff 不一致。 ");
  }
  const declaredOutputs = new Set(step.outputs.map((output) => output.artifact));
  const undeclared = input.result.artifacts.find((artifact) => !declaredOutputs.has(artifact.artifactType));
  if (undeclared !== undefined) {
    throw new ApplicationSubmitError("WSSPEC_UNDECLARED_ARTIFACT", `Artifact ${undeclared.artifactType} 未在 Step outputs 中声明。 `);
  }
  for (const artifact of input.result.artifacts) await verifySubmittedArtifact(state, step, input.attemptId, artifact);
  if (input.result.status === "completed") {
    for (const output of step.outputs.filter((candidate) => candidate.required)) {
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
      title: `Approve ${request.stageId}`,
      digest: request.contentHash,
    },
  };
}

export async function submitApplication(input: SubmitInput, dependencies: SubmitDependencies): Promise<AgentAction> {
  validate("builtin.application-submit-input.v1", input);
  validate<SubmitResult>("builtin.submit-result.v1", input.result);
  const state = await loadApplicationState(input.root, input.workItemId);
  const profile = selectedProfile(state.snapshot);
  const step = profile.steps.find((candidate) => candidate.id === input.stepId);
  if (step === undefined) throw new ApplicationSubmitError("WSSPEC_STAGE_NOT_FOUND", `找不到 Step ${input.stepId}。 `);
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
      await validateResult(input, state, step, current, dependencies.now());
      await dependencies.executors.assertStep(step as never).validate(step as never, input.result, current);
      const running = transitionStage(current.stages[input.stepId]!, { type: "transition", to: "running" });
      let projection: RuntimeProjection = {
        ...current,
        stages: { ...current.stages, [input.stepId]: running },
        claims: { ...current.claims },
        contexts: {
          ...current.contexts,
          [input.stepId]: {
            workPackage: (current.contexts[input.stepId] as ApplicationAttemptRecord).workPackage,
            retryCount: (current.contexts[input.stepId] as ApplicationAttemptRecord).retryCount,
            result: input.result,
          } satisfies ApplicationAttemptRecord,
        },
      };
      delete projection.claims[input.stepId];
      if (input.result.status === "failed") {
        projection.stages[input.stepId] = transitionStage(running, { type: "transition", to: "failed" });
        const retryable = (projection.contexts[input.stepId] as ApplicationAttemptRecord).retryCount < state.snapshot.maxStageRetries;
        return {
          projection,
          value: { action: "blocked", problems: [{ code: "WSSPEC_STEP_FAILED", message: input.result.summary, retryable }] } satisfies AgentAction,
        };
      }
      const validating = transitionStage(running, { type: "transition", to: "validating" });
      projection.stages[input.stepId] = validating;
      if (step.approval) {
        const artifacts = input.result.artifacts.filter((candidate) => candidate.path !== undefined);
        if (artifacts.length === 0) throw new ApplicationSubmitError("WSSPEC_REQUIRED_ARTIFACT_MISSING", "审批 Step 必须提交可校验 Artifact。 ");
        const request = await prepareArtifactApproval({ cwd: input.root, workItemId: input.workItemId, stageId: input.stepId, attemptId: input.attemptId, artifacts, now: dependencies.now() });
        projection = {
          ...projection,
          workItem: transitionWorkItem(projection.workItem, { type: "transition", to: "awaiting_approval" }),
          stages: { ...projection.stages, [input.stepId]: transitionStage(validating, { type: "transition", to: "awaiting_approval" }) },
          approvals: { ...projection.approvals, [request.requestId]: request },
        };
        return { projection, value: approvalAction(state, request) };
      }
      projection.stages[input.stepId] = transitionStage(validating, { type: "transition", to: "succeeded" });
      const next = await acquireNextLocked({ state, projection, actor: current.claims[input.stepId]!.actor, dependencies });
      return { projection: next.projection, value: next.action };
    },
  });
  if (action.action === "completed" && action.summary.status === "closed") {
    await recoverControlPlane({ cwd: input.root, workItemId: input.workItemId });
  }
  return action;
}
