import { approvalBindingDigest } from "./approvals.js";
import { completedReviewActors, implementationActors } from "./actor-roles.js";
import { parseLoopStepInstanceId } from "./control/loop.js";
import { evidenceProjectionKey, isFreshGateEvidence, type EvidenceLevel } from "./verification.js";
import type { ApplicationSnapshot, SnapshotProfile, SnapshotStep } from "../application/state.js";
import type { ProjectGatePolicy } from "./compiler.js";
import type { RuntimeApproval, RuntimeProjection } from "../storage/control-plane.js";

export interface CloseDecision {
  allowed: boolean;
  missing: Array<{
    category: "step" | "artifact" | "approval" | "evidence" | "external-receipt";
    id: string;
  }>;
}

export interface CloseChecklistInput {
  profile: SnapshotProfile;
  projection: RuntimeProjection;
  gatePolicy: ProjectGatePolicy;
  gates: ApplicationSnapshot["gates"];
  workspaceTreeDigest: string;
  configDigest: string;
}

interface AttemptRecord {
  workPackage?: { attemptId?: string };
  actor?: string;
  stepInstanceId?: string;
  skipped?: boolean;
  result?: {
    status?: string;
    artifacts?: Array<{
      artifactType?: string;
      schemaVersion?: number;
      path?: string;
      revision?: number;
      contentHash?: string;
      mediaType?: string;
    }>;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function accepted(status: string | undefined): boolean {
  return status === "succeeded" || status === "succeeded_with_warnings" || status === "skipped";
}

function flatten(steps: readonly SnapshotStep[]): SnapshotStep[] {
  return steps.flatMap((step) => [step, ...flatten(step.steps)]);
}

function attemptRecord(value: unknown): AttemptRecord | undefined {
  return record(value) as AttemptRecord | undefined;
}

interface EffectiveStepInstance {
  step: SnapshotStep;
  stepInstanceId: string;
  context?: AttemptRecord;
}

function skippedInstance(projection: RuntimeProjection, stepInstanceId: string): boolean {
  return projection.stages[stepInstanceId]?.status === "skipped"
    || attemptRecord(projection.contexts[stepInstanceId])?.skipped === true;
}

function childInstanceIds(projection: RuntimeProjection, loopId: string, stepId: string): string[] {
  return Object.keys(projection.contexts)
    .filter((stepInstanceId) => {
      const parsed = parseLoopStepInstanceId(stepInstanceId);
      return parsed?.loopId === loopId && parsed.stepId === stepId;
    })
    .sort((left, right) => left.localeCompare(right));
}

function effectiveStepInstances(profile: SnapshotProfile, projection: RuntimeProjection): EffectiveStepInstance[] {
  const result: EffectiveStepInstance[] = [];
  const visit = (step: SnapshotStep, stepInstanceId: string, ancestorSkipped: boolean): void => {
    const skipped = ancestorSkipped || !step.enabled || skippedInstance(projection, stepInstanceId);
    if (!skipped) {
      const context = attemptRecord(projection.contexts[stepInstanceId]);
      result.push({ step, stepInstanceId, ...(context === undefined ? {} : { context }) });
    }
    for (const child of step.steps) {
      const instanceIds = childInstanceIds(projection, step.id, child.id);
      for (const childInstanceId of instanceIds.length === 0 ? [child.id] : instanceIds) {
        visit(child, childInstanceId, skipped);
      }
    }
  };
  for (const step of profile.steps) visit(step, step.id, false);
  return result;
}

function completedArtifacts(instance: EffectiveStepInstance): NonNullable<NonNullable<AttemptRecord["result"]>["artifacts"]> {
  return instance.context?.result?.status === "completed" ? instance.context.result.artifacts ?? [] : [];
}

type ApprovalArtifact = NonNullable<RuntimeApproval["artifacts"]>[number];

function approvalArtifact(value: NonNullable<NonNullable<AttemptRecord["result"]>["artifacts"]>[number]): ApprovalArtifact | undefined {
  if (typeof value.artifactType !== "string"
    || typeof value.schemaVersion !== "number"
    || typeof value.path !== "string"
    || typeof value.revision !== "number"
    || typeof value.contentHash !== "string"
    || (value.mediaType !== undefined && typeof value.mediaType !== "string")) return undefined;
  return {
    artifactType: value.artifactType,
    schemaVersion: value.schemaVersion,
    path: value.path,
    revision: value.revision,
    contentHash: value.contentHash,
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
  };
}

function sameArtifacts(left: readonly ApprovalArtifact[], right: readonly ApprovalArtifact[]): boolean {
  return left.length === right.length && left.every((artifact, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && artifact.artifactType === candidate.artifactType
      && artifact.schemaVersion === candidate.schemaVersion
      && artifact.path === candidate.path
      && artifact.revision === candidate.revision
      && artifact.contentHash === candidate.contentHash
      && artifact.mediaType === candidate.mediaType;
  });
}

function sortArtifacts(artifacts: readonly ApprovalArtifact[]): ApprovalArtifact[] {
  return [...artifacts].sort((left, right) => `${left.artifactType}\0${left.path}`.localeCompare(`${right.artifactType}\0${right.path}`));
}

function approvalMatches(approval: RuntimeApproval, instance: EffectiveStepInstance): boolean {
  if (approval.status !== "approved" || approval.stageId !== instance.stepInstanceId
    || typeof approval.requestedBy !== "string" || approval.requestedBy === ""
    || typeof approval.decidedBy !== "string" || approval.decidedBy === "") return false;
  const attempt = instance.context;
  if (attempt?.result?.status !== "completed" || attempt.workPackage?.attemptId !== approval.attemptId) return false;
  const artifacts = (attempt.result?.artifacts ?? []).map(approvalArtifact);
  if (approval.artifacts === undefined || artifacts.some((artifact) => artifact === undefined)) return false;
  const completeArtifacts = sortArtifacts(artifacts as ApprovalArtifact[]);
  if (!sameArtifacts(sortArtifacts(approval.artifacts), completeArtifacts)) return false;
  return approval.contentHash === approvalBindingDigest({ stageId: instance.stepInstanceId, attemptId: approval.attemptId, artifacts: completeArtifacts });
}

function requiredGateIds(profile: SnapshotProfile, policy: ProjectGatePolicy): ReadonlySet<string> {
  const gates = new Set(flatten(profile.steps).filter(({ enabled }) => enabled).flatMap(({ gates: ids }) => ids));
  if (profile.id === "standard") for (const id of policy.requiredGateIds) gates.add(id);
  if (profile.id === "governed") for (const id of policy.configuredGateIds) gates.add(id);
  return gates;
}

function gateLevel(gates: ApplicationSnapshot["gates"], gateId: string): EvidenceLevel {
  return gates.find(({ id }) => id === gateId)?.evidence ?? "trusted";
}

function hasFreshEvidence(input: CloseChecklistInput, instance: EffectiveStepInstance, gateId: string): boolean {
  const attemptId = instance.context?.result?.status === "completed"
    ? instance.context.workPackage?.attemptId
    : undefined;
  if (attemptId === undefined) return false;
  return isFreshGateEvidence({
    evidence: input.projection.evidence[evidenceProjectionKey(instance.stepInstanceId, gateId)],
    gateId,
    attemptId,
    requiredLevel: gateLevel(input.gates, gateId),
    workspaceTreeDigest: input.workspaceTreeDigest,
    configDigest: input.configDigest,
  });
}

function independentReviewsSatisfied(input: CloseChecklistInput, step: SnapshotStep): boolean {
  if (input.profile.id !== "governed" || step.independentReviewActor !== true) return true;
  if (input.projection.loops[step.id]?.status !== "succeeded") return false;
  const reviews = completedReviewActors({ loop: step, projection: input.projection });
  if (reviews.length === 0) return false;
  return reviews.every(({ iteration, actor }) => {
    const actors = implementationActors({
      profile: input.profile,
      projection: input.projection,
      loopId: step.id,
      iteration,
    });
    return actor !== undefined && actors !== undefined && !actors.has(actor);
  });
}

function externalReceiptSatisfied(input: CloseChecklistInput, target: "issue" | "knowledge"): boolean {
  const bindings = record(input.projection.evidence.bindings);
  const binding = record(bindings?.[target]);
  if (binding === undefined || binding.exists === false) return false;
  return Object.values(input.projection.evidence).some((value) => {
    const receipt = record(value);
    return receipt?.kind === "external-receipt"
      && receipt.target === target
      && receipt.status === "confirmed"
      && (input.profile.publishing.readBackRequired !== true || receipt.readBack === true);
  });
}

export function closeChecklist(input: CloseChecklistInput): CloseDecision {
  const missing: CloseDecision["missing"] = [];
  const missingKeys = new Set<string>();
  const addMissing = (category: CloseDecision["missing"][number]["category"], id: string): void => {
    const key = `${category}\0${id}`;
    if (missingKeys.has(key)) return;
    missingKeys.add(key);
    missing.push({ category, id });
  };
  const topLevel = input.profile.steps.filter(({ uses }) => uses !== "control.close");
  for (const step of topLevel) {
    if (step.enabled && !accepted(input.projection.stages[step.id]?.status)) {
      addMissing("step", step.id);
    }
    if (step.enabled && !independentReviewsSatisfied(input, step)) addMissing("step", step.id);
  }
  const requiredGates = requiredGateIds(input.profile, input.gatePolicy);
  for (const instance of effectiveStepInstances(input.profile, input.projection)) {
    const artifacts = completedArtifacts(instance);
    for (const output of instance.step.outputs.filter(({ required }) => required)) {
      if (!artifacts.some(({ artifactType }) => artifactType === output.artifact)) {
        addMissing("artifact", output.artifact);
      }
    }
    if (instance.step.approval
      && !Object.values(input.projection.approvals).some((approval) => approvalMatches(approval, instance))) {
      addMissing("approval", instance.step.id);
    }
    for (const gateId of instance.step.gates.filter((id) => requiredGates.has(id))) {
      if (!hasFreshEvidence(input, instance, gateId)) addMissing("evidence", gateId);
    }
  }
  for (const target of ["issue", "knowledge"] as const) {
    const required = target === "issue" ? input.profile.publishing.issueRequired : input.profile.publishing.knowledgeRequired;
    if (required && !externalReceiptSatisfied(input, target)) addMissing("external-receipt", target);
  }
  const categoryOrder = new Map<CloseDecision["missing"][number]["category"], number>([
    ["step", 0], ["artifact", 1], ["approval", 2], ["evidence", 3], ["external-receipt", 4],
  ]);
  missing.sort((left, right) => categoryOrder.get(left.category)! - categoryOrder.get(right.category)!
    || left.id.localeCompare(right.id));
  return { allowed: missing.length === 0, missing };
}
