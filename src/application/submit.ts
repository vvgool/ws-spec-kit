import { readFile } from "node:fs/promises";
import path from "node:path";

import { artifactOutputId, computeArtifactContentHash, readArtifact, verifyArtifact } from "../domain/artifacts.js";
import { createExternalBinding, externalPublishTarget } from "../domain/external-receipt.js";
import { computeWorkspaceSnapshot, computeWorkspaceTreeDigest, sha256, type TreeEntry } from "../domain/digests.js";
import { matchesRepositoryPath, resolveRepositoryRegularFile } from "../domain/repository-path.js";
import { transitionStage, transitionWorkItem } from "../domain/states.js";
import { deriveInitialStages } from "./initial-stages.js";
import { applyProfileDecision, type ProfileDecision } from "./profile.js";
import { prepareArtifactApproval } from "../engine/approvals.js";
import { parseLoopStepInstanceId, projectArtifactValues } from "../engine/control/loop.js";
import {
  failRetry,
  isRetryableStepFailure,
  isStepFailureCode,
  retryFailureProblem,
  stepFailureProblem,
} from "../engine/control/retry.js";
import { mutateControlPlane, readIdempotentControlPlaneResult } from "../engine/scheduler.js";
import { evaluateSubmitProfileDecision } from "../engine/results.js";
import type { AgentAction, SubmitInput, SubmitResult } from "../protocol/application.js";
import type { ArtifactReference } from "../protocol/work-package.js";
import type { ExecutorRegistry } from "../registry/executors/registry.js";
import { validateGitCommitApproval, type GitCommitApproval } from "../registry/connectors/git-commit.js";
import { canonicalRequirementText } from "../registry/connectors/local-requirement.js";
import { validateKnowledgePublishTarget } from "../registry/connectors/knowledge-publish.js";
import { validateIssueWriteAction } from "../registry/connectors/issue.js";
import { validate } from "../schemas/index.js";
import { recoverControlPlane, type RuntimeProjection } from "../storage/control-plane.js";
import { readEvents } from "../storage/events.js";
import { recordGreenEvidenceDetails } from "../engine/tdd/green-gate.js";
import { recordRedEvidence } from "../engine/tdd/red-gate.js";
import { isTddVerificationCode, VerificationError, type TddCycleEvidence, type TddVerificationCode, type TrustedEvidence } from "../engine/tdd/types.js";
import {
  assertImplementHasTrustedRed,
  evaluateReviewFixEvidence,
  evidenceProjectionKey,
  evidenceRecordHash,
  fixedTestGateForState,
  tddCycleEvidenceKey,
  tddGreenEvidenceKey,
  tddRedEvidenceKey,
  type GateEvidence,
} from "../engine/verification.js";
import { acquireNextLocked, type AcquireDependencies, type ApplicationAttemptRecord, type ApplicationStepResult } from "./acquire.js";
import { loadApplicationState, selectedProfile, type ApplicationState, type SnapshotStep } from "./state.js";
import {
  assertCurrentExternalActionContext,
  executeExternalAction,
  ExternalActionError,
  externalActionApprovalSummary,
  externalActionRejectionKey,
  prepareExternalAction,
  type ExternalActionName,
  type ExternalActionRejection,
  type ExternalActionState,
  type ExternalWriteReceipt,
} from "./external-action.js";
import { canonicalDigest } from "../engine/external-effects/idempotency.js";
import { evaluateExternalDelivery, type ExternalDeliveryStatus } from "../engine/external-effects/reconciliation.js";

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

interface ExternalWriteIntent {
  kind: "external-action";
  provider: string;
  action: ExternalActionName;
  target: { kind: "repository" | "issue" | "knowledge"; stableId: string };
  payload: unknown;
  sideEffects: string[];
}

function ownProjection<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function externalWriteIntent(result: SubmitResult): ExternalWriteIntent {
  if (result.externalWrites.length !== 1) {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "external-write Step 必须精确提交一个外部动作意图。 ");
  }
  const value = record(result.externalWrites[0]);
  const target = record(value?.target);
  const allowed = ["kind", "provider", "action", "target", "payload", "sideEffects"];
  if (value?.kind !== "external-action" || Object.keys(value).some((key) => !allowed.includes(key))
    || typeof value.provider !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(value.provider)
    || !["git.commit", "issue.update", "knowledge.publish", "issue.close"].includes(value.action as string)
    || target === undefined || Object.keys(target).some((key) => !["kind", "stableId"].includes(key))
    || !["repository", "issue", "knowledge"].includes(target.kind as string) || typeof target.stableId !== "string" || target.stableId === ""
    || !Array.isArray(value.sideEffects) || value.sideEffects.length === 0
    || value.sideEffects.some((item) => typeof item !== "string" || item === "") || value.payload === undefined) {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "外部动作意图字段不完整或包含未知字段。 ");
  }
  return {
    kind: "external-action",
    provider: value.provider,
    action: value.action as ExternalActionName,
    target: { kind: target.kind as ExternalWriteIntent["target"]["kind"], stableId: target.stableId },
    payload: value.payload,
    sideEffects: [...value.sideEffects] as string[],
  };
}

function governedActionStep(step: SnapshotStep): boolean {
  return step.securityClass === "external-write"
    || (step.securityClass === "local-write" && step.action === "git.commit");
}

function validatedGitApproval(intent: ExternalWriteIntent, worktree: string): Readonly<GitCommitApproval> {
  let approval: Readonly<GitCommitApproval>;
  try { approval = validateGitCommitApproval(intent.payload); }
  catch {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_BINDING_INVALID", "Git commit approval 无效。");
  }
  if (intent.provider !== "git-native" || intent.action !== "git.commit" || intent.target.kind !== "repository"
    || intent.target.stableId !== approval.repositoryCommonDir || approval.repositoryRoot !== worktree
    || canonicalDigest(approval) !== canonicalDigest(intent.payload)) {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_BINDING_INVALID", "Git commit approval 未精确绑定当前 Work Item 仓库。");
  }
  return approval;
}

function externalBlocked(code: `WSSPEC_${string}`, message: string, retryable = false): AgentAction {
  return { action: "blocked", problems: [{ code, message, retryable }] };
}

function externalApprovalAction(workItemId: string, state: Extract<ExternalActionState, { status: "prepared" }>): AgentAction {
  const summary = externalActionApprovalSummary(state.request);
  return {
    action: "await_approval",
    approval: {
      kind: "external_action",
      requestId: state.request.requestId,
      workItemId: workItemId as `WSS-${string}`,
      title: `${summary.provider} ${summary.action} ${summary.target.stableId}`,
      digest: state.request.requestDigest,
      provider: summary.provider,
      action: summary.action,
      target: summary.target,
      sideEffects: summary.sideEffects,
    },
  };
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
  const identity = (entry: TreeEntry): string => JSON.stringify([
    entry.type,
    entry.mode,
    entry.digest ?? null,
    entry.target ?? null,
  ]);
  const beforeByPath = new Map(before.map((entry) => [entry.path, identity(entry)]));
  const afterByPath = new Map(after.map((entry) => [entry.path, identity(entry)]));
  return [...new Set([...beforeByPath.keys(), ...afterByPath.keys()].filter((file) => beforeByPath.get(file) !== afterByPath.get(file)))]
    .filter((file) => !internalPath(state.item.workItemId, file))
    .sort((left, right) => left.localeCompare(right));
}

function permitted(file: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowed) => matchesRepositoryPath(allowed, file));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort((a, b) => a.localeCompare(b));
  const normalizedRight = [...new Set(right)].sort((a, b) => a.localeCompare(b));
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

async function verifySubmittedArtifact(state: ApplicationState, step: SnapshotStep, attemptId: string, reference: ArtifactReference): Promise<void> {
  if (reference.artifactType === "requirement-source") {
    const source = state.snapshot.source;
    const fields = ["artifactType", "outputId", "schemaVersion", "artifactId", "path", "revision", "contentHash", "mediaType", "contentLevel"] as const;
    if (!fields.every((field) => reference[field] === source[field])) {
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
    || verified.outputId !== reference.outputId
    || verified.schemaVersion !== reference.schemaVersion
    || verified.path !== normalized
    || verified.revision !== reference.revision
    || verified.contentHash !== reference.contentHash
    || (reference.mediaType !== undefined && verified.mediaType !== reference.mediaType)) {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", `Artifact ${reference.artifactType} 身份与提交引用不一致。 `);
  }
  const canonicalPath = `.wsspec/work-items/${state.item.workItemId}/artifacts/${reference.artifactType}/${reference.contentHash.slice("sha256:".length)}.md`;
  const artifactDigest = sha256(await readFile(filename));
  const authored = (await readEvents(state.projection.controlPlane)).some((event) => {
    if (event.eventType !== "artifact.authored" || event.stageId !== step.id || event.attemptId !== attemptId) return false;
    const value = record((event.result as { value?: unknown }).value);
    return value?.artifactType === reference.artifactType
      && value.outputId === reference.outputId
      && value.schemaVersion === reference.schemaVersion
      && value.revision === reference.revision
      && value.contentHash === reference.contentHash
      && (reference.mediaType === undefined || value.mediaType === reference.mediaType)
      && value.contentLevel === reference.contentLevel
      && value.artifactDigest === artifactDigest;
  });
  if (normalized !== canonicalPath || !authored) {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", `Artifact ${reference.artifactType} 缺少匹配的受治理 authoring 事件。`);
  }
}

async function verifyPublicationArtifacts(state: ApplicationState, artifacts: readonly ArtifactReference[]): Promise<string[]> {
  const bodies: string[] = [];
  for (const reference of artifacts) {
    try {
      if (reference.path === undefined || reference.contentHash === undefined || reference.revision === undefined) throw new Error("incomplete reference");
      const normalized = reference.path.replaceAll("\\", "/");
      const filename = await resolveRepositoryRegularFile(state.worktree, normalized);
      const artifact = await readArtifact(filename);
      const { contentHash: storedHash, ...metadataWithoutHash } = artifact.metadata;
      const actualHash = computeArtifactContentHash(metadataWithoutHash, artifact.body);
      if (artifact.metadata.workItemId !== state.item.workItemId
        || artifact.metadata.artifactType !== reference.artifactType
        || artifact.metadata.revision !== reference.revision
        || storedHash !== actualHash
        || reference.contentHash !== actualHash) throw new Error("artifact content mismatch");
      bodies.push(artifact.body);
    } catch {
      throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", `External publish Artifact ${reference.artifactType} 的实际内容与输入引用不一致。 `);
    }
  }
  return bodies;
}

function knowledgePublishedContentDigest(bodies: readonly string[]): string {
  if (bodies.length !== 1) {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", "Knowledge publish 必须精确绑定一个已验证 Artifact 正文。 ");
  }
  try {
    return sha256(canonicalRequirementText(bodies[0]!));
  } catch {
    throw new ApplicationSubmitError("WSSPEC_ARTIFACT_REFERENCE_INVALID", "Knowledge publish Artifact 正文无法规范化为有界 Markdown。 ");
  }
}

function engineTddStep(step: SnapshotStep, internal = false, hasCycle = false): boolean {
  return (step.id === "verify-red" && step.action === "quality.test")
    || (step.id === "verify-green" && step.action === "quality.test")
    || (internal && hasCycle && step.id === "verify" && step.action === "quality.verify");
}

type TddFailureDisposition = "restart-red" | "restart-implementation" | "retry" | "fail-closed";

export function tddFailureDisposition(input: { phase: "red" | "green"; internal: boolean }, code: TddVerificationCode): TddFailureDisposition {
  switch (code) {
    case "WSSPEC_TDD_RED_NOT_OBSERVED":
    case "WSSPEC_TDD_RED_SCOPE_INVALID":
      return input.phase === "red" ? "restart-red" : "fail-closed";
    case "WSSPEC_TDD_RED_SYNTAX_FAILURE":
    case "WSSPEC_TDD_REPORT_INVALID":
      return input.phase === "red" ? "restart-red" : "retry";
    case "WSSPEC_TDD_GREEN_NOT_OBSERVED":
      return input.phase === "red" ? "fail-closed" : input.internal ? "retry" : "restart-implementation";
    case "WSSPEC_TDD_GATE_EXECUTION_FAILED":
    case "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE":
    case "WSSPEC_TDD_RED_TIMEOUT":
      return "retry";
    case "WSSPEC_TDD_EVIDENCE_INVALIDATED":
    case "WSSPEC_TDD_GATE_CONFIGURATION_INVALID":
    case "WSSPEC_TDD_RED_REQUIRED":
    case "WSSPEC_TDD_REPORTER_UNSUPPORTED":
    case "WSSPEC_TDD_STEP_INVALID":
    case "WSSPEC_TDD_TEST_PATH_INVALID":
      return "fail-closed";
  }
}

function failedTddResult(input: SubmitInput, error: VerificationError, retryable: boolean): ApplicationStepResult {
  return {
    ...input.result,
    status: "failed",
    failureCode: retryable ? "WSSPEC_STEP_FAILED" : "WSSPEC_STEP_INPUT_INVALID",
    summary: error.message,
    artifacts: [],
    commands: [],
    evidence: [],
    externalWrites: [],
    remainingRisks: [],
  };
}

function restartTddCycle(projection: RuntimeProjection, workItemId: string): RuntimeProjection {
  const resetIds = new Set(["write-tests", "verify-red", "implement", "verify-green", "review-fix"]);
  const stages = { ...projection.stages };
  for (const stepId of resetIds) {
    if (stepId === "write-tests" || stages[stepId] !== undefined) stages[stepId] = { status: stepId === "write-tests" ? "ready" : "pending" };
  }
  const outsideCycle = ([key]: [string, unknown]): boolean => !resetIds.has(key) && !key.startsWith("review-fix:");
  const loops = { ...projection.loops };
  delete loops["review-fix"];
  const evidence = Object.fromEntries(Object.entries(projection.evidence).filter(([key]) => !key.startsWith(`tdd:${workItemId}:`)));
  delete evidence[evidenceProjectionKey("verify-green", "test")];
  return {
    ...projection,
    stages,
    claims: Object.fromEntries(Object.entries(projection.claims).filter(outsideCycle)),
    contexts: Object.fromEntries(Object.entries(projection.contexts).filter(outsideCycle)),
    retries: Object.fromEntries(Object.entries(projection.retries).filter(outsideCycle)),
    loops,
    evidence,
  };
}

function restartTddImplementation(projection: RuntimeProjection, workItemId: string): RuntimeProjection {
  const resetIds = new Set(["implement", "verify-green", "review-fix"]);
  const stages = { ...projection.stages };
  for (const stepId of resetIds) {
    if (stepId === "implement" || stages[stepId] !== undefined) stages[stepId] = { status: stepId === "implement" ? "ready" : "pending" };
  }
  const outsideReset = ([key]: [string, unknown]): boolean => !resetIds.has(key) && !key.startsWith("review-fix:");
  const loops = { ...projection.loops };
  delete loops["review-fix"];
  const evidence = Object.fromEntries(Object.entries(projection.evidence).filter(([key]) => !key.startsWith(`tdd:${workItemId}:green:`) && key !== tddCycleEvidenceKey(workItemId)));
  delete evidence[evidenceProjectionKey("verify-green", "test")];
  return {
    ...projection,
    stages,
    claims: Object.fromEntries(Object.entries(projection.claims).filter(outsideReset)),
    contexts: Object.fromEntries(Object.entries(projection.contexts).filter(outsideReset)),
    retries: Object.fromEntries(Object.entries(projection.retries).filter(outsideReset)),
    loops,
    evidence,
  };
}

async function validateResult(input: SubmitInput, state: ApplicationState, target: ExecutionTarget, projection: RuntimeProjection, now: Date): Promise<string[]> {
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
  const hasCycle = projection.evidence[tddCycleEvidenceKey(state.item.workItemId)] !== undefined;
  if (engineTddStep(target.step, target.internal, hasCycle) && changed.length !== 0) {
    throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "引擎管理的 TDD 验证 Attempt 不允许修改 workspace。 ");
  }
  const undeclared = input.result.artifacts.find((artifact) => !target.step.outputs.some((output) => {
    return artifact.artifactType === output.artifact && artifactOutputId(artifact) === output.outputId;
  }));
  if (undeclared !== undefined) {
    throw new ApplicationSubmitError("WSSPEC_UNDECLARED_ARTIFACT", `Artifact output ${artifactOutputId(undeclared) ?? "<missing>"} 未在 Step outputs 中声明。 `);
  }
  const expectedOutputs = context.workPackage.requiredOutputs;
  for (const artifact of input.result.artifacts) await verifySubmittedArtifact(state, { ...target.step, id: input.stepId }, input.attemptId, artifact);
  if (input.result.status === "completed" && !engineTddStep(target.step, target.internal, hasCycle)) {
    for (const output of expectedOutputs) {
      const outputId = output.outputId ?? (output.artifactType === "requirement-source" ? "requirement-source" : undefined);
      if (outputId === undefined || !input.result.artifacts.some((artifact) => {
        return artifact.artifactType === output.artifactType && artifactOutputId(artifact) === outputId;
      })) {
        throw new ApplicationSubmitError("WSSPEC_REQUIRED_ARTIFACT_MISSING", `缺少必需 Artifact output ${output.outputId ?? output.artifactType}。 `);
      }
    }
  }
  return changed;
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

function changedProfileSteps(state: ApplicationState, decision: ProfileDecision): string[] {
  if (decision.previous === decision.selected) return [];
  const previous = state.snapshot.profiles[decision.previous];
  const selected = state.snapshot.profiles[decision.selected];
  const previousById = new Map(previous.steps.map((step) => [step.id, step]));
  return selected.steps
    .filter((step) => JSON.stringify(previousById.get(step.id)) !== JSON.stringify(step))
    .map(({ id }) => id);
}

function activateSelectedProfile(
  state: ApplicationState,
  projection: RuntimeProjection,
  decision: ProfileDecision,
  options: { preserveCurrentStep?: string } = {},
): {
  state: ApplicationState;
  projection: RuntimeProjection;
  invalidatedStepIds: string[];
} {
  const invalidatedStepIds = [...new Set([...decision.invalidatedStepIds, ...changedProfileSteps(state, decision)])].sort();
  const applied = applyProfileDecision(projection, { ...decision, invalidatedStepIds }, options);
  const profile = state.snapshot.profiles[decision.selected];
  const initial = deriveInitialStages(profile);
  const stages = { ...applied.stages };
  for (const stepId of invalidatedStepIds) {
    if (stages[stepId]?.status === "invalidated" && initial[stepId] !== undefined) stages[stepId] = initial[stepId];
  }
  const loops = { ...applied.loops };
  if (options.preserveCurrentStep !== undefined && loops[options.preserveCurrentStep] !== undefined) {
    const selectedStep = profile.steps.find(({ id }) => id === options.preserveCurrentStep);
    if (selectedStep?.maxIterations !== undefined) {
      loops[options.preserveCurrentStep] = { ...loops[options.preserveCurrentStep]!, maxIterations: selectedStep.maxIterations };
    }
  }
  const activated = { ...applied, stages, loops };
  return {
    state: {
      ...state,
      projection: activated,
      snapshot: { ...state.snapshot, selectedProfile: decision.selected, changePolicy: profile.changePolicy },
    },
    projection: activated,
    invalidatedStepIds,
  };
}

function discoveryTarget(projection: RuntimeProjection, kind: "issue" | "knowledge", workItemId: string) {
  const bindings = record(projection.evidence.bindings);
  const binding = record(bindings?.[kind]);
  if (binding?.exists !== true || typeof binding.stableId !== "string" || binding.stableId === ""
    || binding.externalWorkItemId !== workItemId) {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_BINDING_INVALID", `外部 ${kind} 目标缺少当前 Work Item 的稳定发现绑定。 `);
  }
  return {
    exists: true as const,
    stableId: binding.stableId,
    externalWorkItemId: workItemId,
    ...(typeof binding.provider === "string" ? { provider: binding.provider } : {}),
  };
}

function normalizedProvider(value: string): string {
  return ({ github: "github-cli", gitlab: "gitlab-cli", feishu: "lark-cli" } as Record<string, string>)[value] ?? value;
}

function assertKnowledgePayloadContract(input: {
  payload: unknown;
  applicationBinding: unknown;
  stableId: string;
  contentDigest: `sha256:${string}`;
}): void {
  const payload = record(input.payload);
  if (payload === undefined || Object.keys(payload).sort().join("\0") !== "binding\0target") {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_BINDING_INVALID", "Knowledge payload 必须精确携带目标和 Application binding。 ");
  }
  let target;
  try { target = validateKnowledgePublishTarget(payload.target); }
  catch {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_BINDING_INVALID", "Knowledge payload 目标无法规范化。 ");
  }
  if (target.stableId !== input.stableId || sha256(target.markdown) !== input.contentDigest
    || canonicalDigest(payload.binding, "WSSPEC_EXTERNAL_BINDING_INVALID")
      !== canonicalDigest(input.applicationBinding, "WSSPEC_EXTERNAL_BINDING_INVALID")) {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_BINDING_INVALID", "Knowledge payload、Application binding 与已验证 Artifact 正文不一致。 ");
  }
}

function previousVerifiedIssueUpdate(projection: RuntimeProjection, stableId: string): ExternalWriteReceipt | undefined {
  return Object.values(projection.externalActions)
    .filter((state): state is Extract<ExternalActionState, { status: "verified" }> =>
      state.status === "verified" && state.request.action === "issue.update" && state.request.target.stableId === stableId)
    .sort((left, right) => left.receipt.verifiedAt.localeCompare(right.receipt.verifiedAt))
    .at(-1)?.receipt;
}

function knowledgeDeliveryStatus(
  projection: RuntimeProjection,
  profile: ReturnType<typeof selectedProfile>,
): ExternalDeliveryStatus {
  const actions = Object.values(projection.externalActions)
    .filter((state) => state.request.action === "knowledge.publish")
    .sort((left, right) => left.request.createdAt.localeCompare(right.request.createdAt));
  const latest = actions.at(-1);
  if (latest !== undefined) {
    if (latest.status === "failed") {
      const warning = projection.evidence[`external-warning:${latest.request.requestId}`] as { code?: unknown } | undefined;
      if (warning?.code === "WSSPEC_OPTIONAL_KNOWLEDGE_FAILED") return "warning";
    }
    return latest.status;
  }
  const steps = profile.steps.filter((step) => step.action === "knowledge.publish");
  if (steps.length === 0) return "absent";
  if (steps.every((step) => projection.stages[step.id]?.status === "skipped")) return "skipped";
  return "missing";
}

async function governExternalSubmit(
  input: SubmitInput,
  state: ApplicationState,
  dependencies: SubmitDependencies,
): Promise<{ input: SubmitInput; action?: AgentAction }> {
  if (input.result.externalWrites.length === 0) return { input };
  const profile = selectedProfile(state.snapshot);
  const target = executionTarget(profile, state.projection, input.stepId);
  if (!governedActionStep(target.step)) {
    if (input.result.externalWrites.length !== 0) {
      throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "非受治理写入 Step 不能携带外部写入记录。");
    }
    return { input };
  }
  if (target.internal) throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "循环内部 Step 不支持外部写入。 ");
  if (input.result.status === "failed") {
    if (input.result.externalWrites.length !== 0) throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "失败结果不能携带外部写入意图。 ");
    return { input };
  }
  const intent = externalWriteIntent(input.result);
  const gitCommit = intent.action === "git.commit";
  if (intent.action !== target.step.action
    || (gitCommit && intent.target.kind !== "repository")
    || (!gitCommit && (intent.action === "knowledge.publish") !== (intent.target.kind === "knowledge"))
    || (!gitCommit && intent.target.kind === "repository")) {
    throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "外部动作意图与编译后的 Step 动作或目标类别不一致。 ");
  }
  let externalEffectKind: "issue.comment" | undefined;
  if (intent.action === "issue.update" || intent.action === "issue.close") {
    const issueAction = validateIssueWriteAction(record(intent.payload)?.action as never);
    if ((intent.action === "issue.close") !== (issueAction.type === "issue.close")) {
      throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "Issue payload 动作与编译后的 Step 动作不一致。 ");
    }
    if (issueAction.type === "comment") externalEffectKind = "issue.comment";
  }
  const payloadDigest = canonicalDigest(intent.payload);
  const prior = Object.values(state.projection.externalActions).find((candidate) =>
    candidate.request.workItemId === input.workItemId
    && candidate.request.stepId === input.stepId
    && candidate.request.attemptId === input.attemptId
    && candidate.request.provider === intent.provider
    && candidate.request.action === intent.action
    && candidate.request.target.kind === intent.target.kind
    && candidate.request.target.stableId === intent.target.stableId);
  if (prior !== undefined) {
    const rejection = state.projection.evidence[externalActionRejectionKey(prior.request.requestId)] as ExternalActionRejection | undefined;
    if (rejection !== undefined) {
      if (rejection.requestId !== prior.request.requestId || rejection.requestDigest !== prior.request.requestDigest
        || rejection.actor === "" || !Number.isFinite(Date.parse(rejection.rejectedAt))) {
        throw new ApplicationSubmitError("WSSPEC_EXTERNAL_REJECTION_INVALID", "外部动作拒绝证据未绑定当前请求。");
      }
      return { input, action: externalBlocked("WSSPEC_EXTERNAL_ACTION_REJECTED", "外部动作未获授权。") };
    }
    if (prior.request.payloadDigest !== payloadDigest
      || JSON.stringify(prior.request.sideEffects) !== JSON.stringify(intent.sideEffects)) {
      throw new ExternalActionError("WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT", "同一 Attempt 的外部动作已绑定不同请求内容。");
    }
  }
  const active = state.projection.contexts[target.stageId] as ApplicationAttemptRecord;
  let bindingDigest: `sha256:${string}`;
  let inputDigest: `sha256:${string}`;
  let expectedContentDigest = payloadDigest;
  if (gitCommit) {
    const approval = validatedGitApproval(intent, state.worktree);
    expectedContentDigest = approval.diffDigest;
    bindingDigest = canonicalDigest({
      kind: "repository",
      repositoryRoot: approval.repositoryRoot,
      repositoryCommonDir: approval.repositoryCommonDir,
      baselineRevision: approval.baselineRevision,
    }, "WSSPEC_EXTERNAL_BINDING_INVALID");
    inputDigest = canonicalDigest({
      baselineRevision: approval.baselineRevision,
      files: approval.files,
      message: approval.message,
      diffDigest: approval.diffDigest,
    }, "WSSPEC_EXTERNAL_BINDING_INVALID");
  } else {
    if (intent.target.kind === "repository") {
      throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "外部动作意图与目标类别不一致。 ");
    }
    const publicationBodies = await verifyPublicationArtifacts(
      state,
      active.workPackage.artifacts.filter(({ artifactType }) => artifactType !== "requirement-source"),
    );
    const discovered = discoveryTarget(state.projection, intent.target.kind, state.item.workItemId);
    if (discovered.stableId !== intent.target.stableId) {
      throw new ApplicationSubmitError("WSSPEC_EXTERNAL_BINDING_INVALID", "外部动作意图的稳定目标与发现绑定不一致。 ");
    }
    if (discovered.provider !== undefined && normalizedProvider(discovered.provider) !== normalizedProvider(intent.provider)) {
      throw new ApplicationSubmitError("WSSPEC_EXTERNAL_BINDING_INVALID", "外部动作 Provider 与生产发现绑定不一致。 ");
    }
    if (intent.action === "issue.close") {
    const previous = previousVerifiedIssueUpdate(state.projection, discovered.stableId);
    if (previous === undefined) {
      throw new ApplicationSubmitError("WSSPEC_EXTERNAL_ORDER_INVALID", "Issue Close 前缺少已验证的 Issue Update Receipt。 ");
    }
    const delivery = evaluateExternalDelivery({
      issueUpdate: "verified",
      knowledge: knowledgeDeliveryStatus(state.projection, profile),
      knowledgeRequired: profile.publishing.knowledgeRequired,
      issueClose: "verified",
    });
    if (!delivery.allowed) {
      throw new ApplicationSubmitError("WSSPEC_EXTERNAL_ORDER_INVALID", "Issue Close 前的 Knowledge 发布状态尚未满足 Profile 约束。 ");
    }
    bindingDigest = canonicalDigest({ kind: "issue", ...discovered }, "WSSPEC_EXTERNAL_BINDING_INVALID");
    inputDigest = previous.readBackContentDigest;
    } else {
      const publishTarget = intent.action === "knowledge.publish" ? "knowledge" : "issue";
      if (publishTarget === "knowledge") expectedContentDigest = knowledgePublishedContentDigest(publicationBodies) as `sha256:${string}`;
      const binding = createExternalBinding({
        target: publishTarget,
        workPackage: active.workPackage,
        discoveryBinding: discovered,
        ...(publishTarget === "knowledge" ? { expectedPublishedContentDigest: expectedContentDigest } : {}),
      });
      if (publishTarget === "knowledge") {
        assertKnowledgePayloadContract({
          payload: intent.payload,
          applicationBinding: binding,
          stableId: discovered.stableId,
          contentDigest: expectedContentDigest,
        });
      }
      bindingDigest = canonicalDigest(binding, "WSSPEC_EXTERNAL_BINDING_INVALID");
      inputDigest = binding.publishInputDigest as `sha256:${string}`;
    }
  }
  const artifactDigests = active.workPackage.artifacts.map((artifact) =>
    (artifact.contentHash ?? canonicalDigest(artifact)) as `sha256:${string}`).sort();
  if (prior !== undefined) {
    const sameLogicalRequest = prior.request.payloadDigest === payloadDigest
      && prior.request.expectedContentDigest === expectedContentDigest
      && prior.request.bindingDigest === bindingDigest
      && prior.request.inputDigest === inputDigest
      && prior.request.externalEffectKind === externalEffectKind
      && JSON.stringify(prior.request.artifactDigests) === JSON.stringify(artifactDigests)
      && JSON.stringify(prior.request.sideEffects) === JSON.stringify(intent.sideEffects);
    if (!sameLogicalRequest) {
      throw new ExternalActionError("WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT", "同一 Attempt 的外部动作已绑定不同请求内容。");
    }
    if (prior.status === "verified") {
      await assertCurrentExternalActionContext(state, state.projection, prior.request);
    }
  }
  await validateResult(input, state, target, state.projection, dependencies.now());
  const executorStep = { ...target.step, id: target.stageId };
  trustedSubmitResult(
    input.result,
    await dependencies.executors.assertStep(executorStep as never).validate(executorStep as never, input.result, state.projection),
  );
  let governed: ExternalActionState;
  if (prior !== undefined) {
    governed = prior;
  } else {
    governed = await prepareExternalAction({
      root: input.root,
      workItemId: input.workItemId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      provider: intent.provider,
      action: intent.action,
      securityClass: gitCommit ? "local-write" : "external-write",
      target: intent.target,
      ...(externalEffectKind === undefined ? {} : { externalEffectKind }),
      payload: intent.payload,
      expectedContentDigest,
      bindingDigest,
      inputDigest,
      artifactDigests,
      sideEffects: intent.sideEffects,
      createdAt: dependencies.now().toISOString(),
      expiresAt: active.workPackage.lease.expiresAt,
      actor: state.projection.claims[target.stageId]!.actor,
    });
  }
  if (governed.status === "prepared") return { input, action: externalApprovalAction(input.workItemId, governed) };
  if (governed.status === "reconciliation_required"
    || (governed.status === "executing" && governed.dispatch === "sent_or_unknown")) {
    return { input, action: externalBlocked("WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED", "外部动作结果未知，禁止自动重发。") };
  }
  if (governed.status === "failed") {
    return { input, action: externalBlocked("WSSPEC_EXTERNAL_RECONCILIATION_FAILED", governed.reason) };
  }
  if (governed.status !== "verified") {
    governed = await executeExternalAction({
      root: input.root,
      workItemId: input.workItemId,
      requestId: governed.request.requestId,
      payload: intent.payload,
      executor: dependencies.externalExecutor(intent.provider, intent.action),
      now: dependencies.now().toISOString(),
    });
  }
  if (governed.status === "reconciliation_required") {
    return { input, action: externalBlocked("WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED", "外部动作结果未知，必须先完成只读协调回查。") };
  }
  if (governed.status === "executing") {
    return { input, action: externalBlocked("WSSPEC_EXTERNAL_EXECUTION_IN_PROGRESS", "外部动作已有执行 owner，请稍后重试。", true) };
  }
  return {
    input: { ...input, result: { ...input.result, externalWrites: [{ ...governed.receipt }] } },
  };
}

function governedExternalReceipt(result: SubmitResult): ExternalWriteReceipt | undefined {
  const candidate = result.externalWrites.length === 1 ? result.externalWrites[0] : undefined;
  try { return validate<ExternalWriteReceipt>("builtin.external-write-receipt.v1", candidate); }
  catch { return undefined; }
}

function withLegacyExternalEvidence(projection: RuntimeProjection, receipt: ExternalWriteReceipt): RuntimeProjection {
  if (receipt.action === "git.commit" || receipt.action === "issue.close") return projection;
  const target = receipt.target.kind;
  const binding = {
    version: 1 as const,
    kind: "external-binding" as const,
    target,
    exists: true as const,
    stableId: receipt.target.stableId,
    externalWorkItemId: receipt.workItemId,
    publishStepId: receipt.stepId,
    publishAttemptId: receipt.attemptId,
    publishInputDigest: receipt.inputDigest,
    expectedPublishedContentDigest: receipt.expectedContentDigest,
  };
  const legacyReceipt = {
    version: 1 as const,
    kind: "external-receipt" as const,
    target,
    stableId: receipt.target.stableId,
    ...(receipt.externalEffectKind === undefined ? {} : { externalEffectKind: receipt.externalEffectKind }),
    ...(receipt.externalEffectId === undefined ? {} : { externalEffectId: receipt.externalEffectId }),
    externalWorkItemId: receipt.workItemId,
    publishStepId: receipt.stepId,
    publishAttemptId: receipt.attemptId,
    publishInputDigest: receipt.inputDigest,
    publishedContentDigest: receipt.publishedContentDigest,
    readBackContentDigest: receipt.readBackContentDigest,
    status: "confirmed" as const,
    readBackStatus: "confirmed" as const,
  };
  return {
    ...projection,
    evidence: {
      ...projection.evidence,
      [`external-binding:${target}`]: binding,
      [`external-receipt:${target}`]: legacyReceipt,
    },
  };
}

export async function submitApplication(input: SubmitInput, dependencies: SubmitDependencies): Promise<AgentAction> {
  validate("builtin.application-submit-input.v1", input);
  validate<SubmitResult>("builtin.submit-result.v1", input.result);
  const { root: _root, ...operationInput } = input;
  const completed = await readIdempotentControlPlaneResult<AgentAction>({
    cwd: input.root,
    workItemId: input.workItemId,
    idempotencyKey: `submit:${input.attemptId}`,
    operationInput,
  });
  if (completed !== undefined) return completed;
  const state = await loadApplicationState(input.root, input.workItemId);
  const governed = await governExternalSubmit(input, state, dependencies);
  if (governed.action !== undefined) return governed.action;
  input = governed.input;
  let profileEvent: "profile.selected" | "profile.upgraded" | undefined;
  let profileInvalidatedStepIds: string[] = [];
  const action = await mutateControlPlane<AgentAction>({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: (value) => value.action === "completed" && value.summary.status === "closed"
      ? "work-item.closed"
      : profileEvent ?? "attempt.submitted",
    idempotencyKey: `submit:${input.attemptId}`,
    stageId: input.stepId,
    attemptId: input.attemptId,
    operationInput,
    eventDetails: () => profileInvalidatedStepIds.length === 0 ? {} : { invalidatedStepIds: profileInvalidatedStepIds },
    mutate: async (current) => {
      let runtimeState = state;
      if (runtimeState.snapshot.selectedProfile !== current.profile.selected) {
        const selected = runtimeState.snapshot.profiles[current.profile.selected];
        runtimeState = {
          ...runtimeState,
          projection: current,
          snapshot: { ...runtimeState.snapshot, selectedProfile: current.profile.selected, changePolicy: selected.changePolicy },
        };
      }
      const profile = selectedProfile(runtimeState.snapshot);
      const target = executionTarget(profile, current, input.stepId);
      if (governedActionStep(target.step) && input.result.status === "completed"
        && input.result.externalWrites.length === 0) {
        throw new ApplicationSubmitError("WSSPEC_EXTERNAL_INTENT_INVALID", "external-write Step 必须提交经过授权和回读验证的外部动作 Receipt。 ");
      }
      let changed: string[];
      try {
        changed = await validateResult(input, runtimeState, target, current, dependencies.now());
      } catch (error) {
        if (!(error instanceof VerificationError) || !engineTddStep(target.step, target.internal, current.evidence[tddCycleEvidenceKey(runtimeState.item.workItemId)] !== undefined)) throw error;
        const result = failedTddResult(input, error, false);
        const actor = current.claims[target.stageId]!.actor;
        const active = current.contexts[target.stageId] as ApplicationAttemptRecord;
        const projection: RuntimeProjection = {
          ...current,
          stages: { ...current.stages, [target.stageId]: { status: "failed" } },
          claims: { ...current.claims },
          contexts: { ...current.contexts, [target.stageId]: { ...active, actor, stepInstanceId: target.stepInstanceId, artifactValues: {}, result } },
          retries: { ...current.retries },
        };
        delete projection.claims[target.stageId];
        delete projection.retries[target.stepInstanceId];
        return { projection, value: { action: "blocked", problems: [stepFailureProblem("WSSPEC_STEP_INPUT_INVALID", error.message)] } };
      }
      const executorStep = { ...target.step, id: target.stageId };
      const hasCycle = current.evidence[tddCycleEvidenceKey(runtimeState.item.workItemId)] !== undefined;
      const engineManagedTdd = engineTddStep(target.step, target.internal, hasCycle);
      let gate: Awaited<ReturnType<typeof fixedTestGateForState>> | undefined;
      let gateFailure: VerificationError | undefined;
      if (engineManagedTdd || target.step.id === "implement") {
        try { gate = await fixedTestGateForState(runtimeState); }
        catch (error) {
          if (!(error instanceof VerificationError) || !engineManagedTdd) throw error;
          gateFailure = error;
        }
      }
      if (target.step.id === "implement") {
        await assertImplementHasTrustedRed({
          taskId: runtimeState.item.workItemId,
          commandId: gate!.commandId,
          gate: gate!,
          worktree: runtimeState.worktree,
          redEvidence: current.evidence[tddRedEvidenceKey(runtimeState.item.workItemId)] as TrustedEvidence | undefined,
        });
      }
      let trustedTddEvidence: TrustedEvidence | undefined;
      let trustedTddCycle: TddCycleEvidence | undefined;
      let executionProjection = current;
      const publishTarget = externalPublishTarget(target.step.action);
      const externalReceipt = governedExternalReceipt(input.result);
      if (externalReceipt !== undefined) {
        executionProjection = withLegacyExternalEvidence(current, externalReceipt);
      } else if (publishTarget !== undefined) {
        const active = current.contexts[target.stageId] as ApplicationAttemptRecord;
        const publicationBodies = await verifyPublicationArtifacts(runtimeState, active.workPackage.artifacts);
        const bindings = current.evidence.bindings as Record<string, unknown> | undefined;
        const binding = createExternalBinding({
          target: publishTarget,
          workPackage: active.workPackage,
          discoveryBinding: bindings?.[publishTarget],
          ...(publishTarget === "knowledge" ? { expectedPublishedContentDigest: knowledgePublishedContentDigest(publicationBodies) } : {}),
        });
        const evidence = { ...current.evidence, [`external-binding:${publishTarget}`]: binding };
        delete evidence[`external-receipt:${publishTarget}`];
        executionProjection = { ...current, evidence };
      }
      let result: ApplicationStepResult;
      if (target.step.id === "verify-red") {
        const writeTests = current.contexts["write-tests"] as ApplicationAttemptRecord | undefined;
        if (gateFailure !== undefined) {
          result = failedTddResult(input, gateFailure, false);
        } else try {
          trustedTddEvidence = await recordRedEvidence({
            taskId: runtimeState.item.workItemId,
            step: target.step as never,
            gate: gate!,
            worktree: runtimeState.worktree,
            workspaceDigest: await computeWorkspaceTreeDigest(runtimeState.worktree),
            modifiedFiles: writeTests?.result?.modifiedFiles ?? [],
            testPaths: writeTests?.result?.modifiedFiles ?? [],
          });
          result = { ...input.result, status: "completed", summary: "引擎已记录可信 Red Evidence。", artifacts: [], commands: [], evidence: [] };
        } catch (error) {
          if (!(error instanceof VerificationError)) throw error;
          const disposition = isTddVerificationCode(error.code)
            ? tddFailureDisposition({ phase: "red", internal: false }, error.code)
            : "fail-closed";
          if (disposition === "restart-red") {
            const restarted = restartTddCycle(current, runtimeState.item.workItemId);
            const next = await acquireNextLocked({ state: runtimeState, projection: restarted, actor: current.claims[target.stageId]!.actor, root: input.root, dependencies });
            return { projection: next.projection, value: next.action };
          }
          result = failedTddResult(input, error, disposition === "retry");
        }
      } else if (target.step.id === "verify-green" || (target.internal && hasCycle && target.step.id === "verify" && target.step.action === "quality.verify")) {
        const redEvidence = current.evidence[tddRedEvidenceKey(runtimeState.item.workItemId)] as TrustedEvidence | undefined;
        if (redEvidence === undefined) gateFailure = new VerificationError("WSSPEC_TDD_RED_REQUIRED", "verify-green 缺少可信 Red Evidence。 ");
        const previousCycle = current.evidence[tddCycleEvidenceKey(runtimeState.item.workItemId)] as TddCycleEvidence | undefined;
        if (gateFailure !== undefined) {
          result = failedTddResult(input, gateFailure, false);
        } else try {
          const green = await recordGreenEvidenceDetails({
            taskId: runtimeState.item.workItemId,
            step: target.step as never,
            gate: gate!,
            worktree: runtimeState.worktree,
            workspaceDigest: await computeWorkspaceTreeDigest(runtimeState.worktree),
            redEvidence: redEvidence!,
            ...(target.internal && previousCycle !== undefined ? { previousCycle } : {}),
          });
          trustedTddEvidence = green.evidence;
          trustedTddCycle = green.cycle;
          result = { ...input.result, status: "completed", summary: "引擎已记录可信 Green Evidence。", artifacts: [], commands: [], evidence: [] };
        } catch (error) {
          if (!(error instanceof VerificationError)) throw error;
          const disposition = isTddVerificationCode(error.code)
            ? tddFailureDisposition({ phase: "green", internal: target.internal }, error.code)
            : "fail-closed";
          if (disposition === "restart-implementation") {
            const restarted = restartTddImplementation(current, runtimeState.item.workItemId);
            const next = await acquireNextLocked({ state: runtimeState, projection: restarted, actor: current.claims[target.stageId]!.actor, root: input.root, dependencies });
            return { projection: next.projection, value: next.action };
          }
          result = failedTddResult(input, error, disposition === "retry");
        }
      } else {
        result = trustedSubmitResult(
          input.result,
          await dependencies.executors.assertStep(executorStep as never).validate(executorStep as never, input.result, executionProjection),
        );
      }
      if (target.internal && target.step.approval) {
        throw new ApplicationSubmitError("WSSPEC_LOOP_STEP_APPROVAL_UNSUPPORTED", "循环内部 Step 暂不支持审批。 ");
      }
      const actor = current.claims[target.stageId]!.actor;
      const active = current.contexts[target.stageId] as ApplicationAttemptRecord;
      const artifactValues = await projectArtifactValues(runtimeState.worktree, result.artifacts);
      const record: ApplicationAttemptRecord = {
        workPackage: active.workPackage,
        retryCount: active.retryCount,
        actor,
        stepInstanceId: target.stepInstanceId,
        artifactValues,
        result,
      };
      let projection: RuntimeProjection = {
        ...executionProjection,
        stages: { ...current.stages },
        claims: { ...current.claims },
        contexts: { ...current.contexts, [target.stageId]: record },
        retries: { ...current.retries },
      };
      if (target.step.id === "verify-red" && trustedTddEvidence !== undefined) {
        projection.evidence = { ...projection.evidence, [tddRedEvidenceKey(runtimeState.item.workItemId)]: trustedTddEvidence };
      } else if ((target.step.id === "verify-green" || (target.internal && target.step.id === "verify")) && trustedTddEvidence !== undefined && trustedTddCycle !== undefined) {
        const verifyGreen = target.step.id === "verify-green"
          ? active.workPackage
          : (projection.contexts["verify-green"] as ApplicationAttemptRecord | undefined)?.workPackage;
        if (verifyGreen === undefined) throw new ApplicationSubmitError("WSSPEC_TDD_EVIDENCE_INVALIDATED", "Review-Fix 复验缺少原始 verify-green Attempt。 ");
        const unsignedGate = {
          evidenceId: trustedTddEvidence.evidenceId,
          level: "trusted" as const,
          gateId: "test",
          codeRevision: runtimeState.item.execution.baselineRevision,
          baselineTreeDigest: runtimeState.item.execution.baselineTreeDigest,
          workspaceTreeDigest: trustedTddEvidence.workspaceDigest,
          configDigest: runtimeState.item.execution.configDigest,
          attemptId: verifyGreen.attemptId,
          result: "passed" as const,
        };
        const gateEvidence: GateEvidence = { ...unsignedGate, recordHash: evidenceRecordHash(unsignedGate) };
        projection.evidence = {
          ...projection.evidence,
          [tddCycleEvidenceKey(runtimeState.item.workItemId)]: trustedTddCycle,
          [tddGreenEvidenceKey(runtimeState.item.workItemId, trustedTddEvidence.evidenceId)]: trustedTddEvidence,
          [evidenceProjectionKey("verify-green", "test")]: gateEvidence,
        };
      }
      if (target.internal) projection.contexts[target.stepInstanceId] = record;
      delete projection.claims[target.stageId];
      const currentRetry = result.status === "failed"
        ? ownProjection(projection.retries, target.stepInstanceId)
        : undefined;
      if (result.status === "failed" && currentRetry === undefined) {
        throw new ApplicationSubmitError("WSSPEC_RETRY_PROJECTION_INVALID", `步骤 ${target.stepInstanceId} 缺少重试投影。 `);
      }
      const profileEvaluation = evaluateSubmitProfileDecision({
        projection,
        result,
        stepId: target.stageId,
        workflow: runtimeState.snapshot.changePolicy.kind,
      });
      projection.profile = profileEvaluation.profile;
      const decision = profileEvaluation.decision;
      let invalidatesTarget = false;
      if (decision !== undefined) {
        const selectedChanged = decision.selected !== decision.previous;
        const activated = activateSelectedProfile(
          runtimeState,
          projection,
          decision,
          result.status === "failed" ? { preserveCurrentStep: target.stageId } : {},
        );
        projection = activated.projection;
        runtimeState = activated.state;
        profileInvalidatedStepIds = activated.invalidatedStepIds;
        profileEvent = selectedChanged ? "profile.upgraded" : "profile.selected";
        invalidatesTarget = activated.invalidatedStepIds.includes(target.stageId);
      }
      if (result.status === "failed") {
        const running = transitionStage(current.stages[target.stageId]!, { type: "transition", to: "running" });
        projection.stages[target.stageId] = transitionStage(running, { type: "transition", to: "failed" });
        const failureCode = result.failureCode!;
        if (!isRetryableStepFailure(failureCode)) {
          delete projection.retries[target.stepInstanceId];
          return {
            projection,
            value: { action: "blocked", problems: [stepFailureProblem(failureCode, result.summary)] } satisfies AgentAction,
          };
        }
        const failedRetry = failRetry(currentRetry!);
        projection.retries[target.stepInstanceId] = failedRetry;
        return {
          projection,
          value: { action: "blocked", problems: [retryFailureProblem(failedRetry, result.summary)] } satisfies AgentAction,
        };
      }
      delete projection.retries[target.stepInstanceId];
      if (target.internal && target.step.id === "fix") {
        const cycle = projection.evidence[tddCycleEvidenceKey(runtimeState.item.workItemId)] as TddCycleEvidence | undefined;
        if (cycle !== undefined) {
          let restart = evaluateReviewFixEvidence({ modifiedFiles: changed, cycle }).action === "restart-cycle";
          if (!restart) {
            try {
              await assertImplementHasTrustedRed({
                taskId: runtimeState.item.workItemId,
                commandId: cycle.commandId,
                worktree: runtimeState.worktree,
                redEvidence: projection.evidence[tddRedEvidenceKey(runtimeState.item.workItemId)] as TrustedEvidence | undefined,
              });
            } catch (error) {
              if (!(error instanceof VerificationError) || error.code !== "WSSPEC_TDD_EVIDENCE_INVALIDATED") throw error;
              restart = true;
            }
          }
          if (restart) {
            projection = restartTddCycle(projection, runtimeState.item.workItemId);
            const next = await acquireNextLocked({ state: runtimeState, projection, actor, root: input.root, dependencies });
            return { projection: next.projection, value: next.action };
          }
        }
      }
      if (invalidatesTarget) {
        const next = await acquireNextLocked({ state: runtimeState, projection, actor, root: input.root, dependencies });
        return { projection: next.projection, value: next.action };
      }
      if (target.internal) {
        projection.stages[target.stageId] = transitionStage(projection.stages[target.stageId]!, { type: "transition", to: "ready" });
        delete projection.contexts[target.stageId];
        const next = await acquireNextLocked({ state: runtimeState, projection, actor, root: input.root, dependencies });
        return { projection: next.projection, value: next.action };
      }
      const running = transitionStage(projection.stages[target.stageId]!, { type: "transition", to: "running" });
      const validating = transitionStage(running, { type: "transition", to: "validating" });
      projection.stages[target.stageId] = validating;
      if (target.step.approval && !governedActionStep(target.step)) {
        const artifacts = result.artifacts.filter((candidate) => candidate.path !== undefined);
        const request = await prepareArtifactApproval({
          cwd: input.root,
          workItemId: input.workItemId,
          stageId: target.stageId,
          attemptId: input.attemptId,
          artifacts,
          actor,
          now: dependencies.now(),
        });
        projection = {
          ...projection,
          workItem: transitionWorkItem(projection.workItem, { type: "transition", to: "awaiting_approval" }),
          stages: { ...projection.stages, [target.stageId]: transitionStage(validating, { type: "transition", to: "awaiting_approval" }) },
          approvals: { ...projection.approvals, [request.requestId]: request },
        };
        return { projection, value: approvalAction(runtimeState, request) };
      }
      projection.stages[target.stageId] = transitionStage(validating, { type: "transition", to: "succeeded" });
      const next = await acquireNextLocked({ state: runtimeState, projection, actor, root: input.root, dependencies });
      return { projection: next.projection, value: next.action };
    },
  });
  if (action.action === "completed" && action.summary.status === "closed") {
    await recoverControlPlane({ cwd: input.root, workItemId: input.workItemId });
  }
  return action;
}
