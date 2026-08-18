import { approvalBindingDigest } from "./approvals.js";
import { isFreshGateEvidence, type EvidenceLevel } from "./verification.js";
import { parseLoopStepInstanceId } from "./control/loop.js";
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

function contextsForStep(projection: RuntimeProjection, step: SnapshotStep): AttemptRecord[] {
  const values: unknown[] = [];
  if (projection.contexts[step.id] !== undefined) values.push(projection.contexts[step.id]);
  for (const [key, value] of Object.entries(projection.contexts)) {
    if (key.endsWith(`:${step.id}`)) values.push(value);
  }
  return values.filter((value): value is AttemptRecord => record(value) !== undefined) as AttemptRecord[];
}

function completedArtifacts(projection: RuntimeProjection, step: SnapshotStep): NonNullable<NonNullable<AttemptRecord["result"]>["artifacts"]> {
  return contextsForStep(projection, step)
    .filter(({ result }) => result?.status === "completed")
    .flatMap(({ result }) => result?.artifacts ?? []);
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

function approvalMatches(approval: RuntimeApproval, step: SnapshotStep, projection: RuntimeProjection): boolean {
  if (approval.status !== "approved" || approval.stageId !== step.id
    || typeof approval.requestedBy !== "string" || approval.requestedBy === ""
    || typeof approval.decidedBy !== "string" || approval.decidedBy === "") return false;
  const attempts = contextsForStep(projection, step).filter(({ result }) => result?.status === "completed");
  const attempt = attempts.find(({ workPackage }) => workPackage?.attemptId === approval.attemptId);
  if (attempt === undefined) return false;
  const artifacts = (attempt.result?.artifacts ?? []).map(approvalArtifact);
  if (approval.artifacts === undefined || artifacts.some((artifact) => artifact === undefined)) return false;
  const completeArtifacts = sortArtifacts(artifacts as ApprovalArtifact[]);
  if (!sameArtifacts(sortArtifacts(approval.artifacts), completeArtifacts)) return false;
  return approval.contentHash === approvalBindingDigest({ stageId: step.id, attemptId: approval.attemptId, artifacts: completeArtifacts });
}

function requiredGateIds(profile: SnapshotProfile, policy: ProjectGatePolicy): string[] {
  const gates = new Set(flatten(profile.steps).filter(({ enabled }) => enabled).flatMap(({ gates: ids }) => ids));
  if (profile.id === "standard") for (const id of policy.requiredGateIds) gates.add(id);
  if (profile.id === "governed") for (const id of policy.configuredGateIds) gates.add(id);
  return [...gates].sort((left, right) => left.localeCompare(right));
}

function gateLevel(gates: ApplicationSnapshot["gates"], gateId: string): EvidenceLevel {
  return gates.find(({ id }) => id === gateId)?.evidence ?? "trusted";
}

function hasFreshEvidence(input: CloseChecklistInput, gateId: string): boolean {
  return Object.values(input.projection.evidence).some((evidence) => isFreshGateEvidence({
    evidence,
    gateId,
    requiredLevel: gateLevel(input.gates, gateId),
    workspaceTreeDigest: input.workspaceTreeDigest,
    configDigest: input.configDigest,
  }));
}

function stepWasSkipped(projection: RuntimeProjection, step: SnapshotStep): boolean {
  if (projection.stages[step.id]?.status === "skipped") return true;
  const contexts = contextsForStep(projection, step);
  return contexts.length > 0 && contexts.every(({ skipped }) => skipped === true);
}

function completedActor(value: unknown): { completed: boolean; actor?: string } {
  const source = record(value) as { actor?: unknown; result?: { status?: unknown } } | undefined;
  return {
    completed: source?.result?.status === "completed",
    ...(typeof source?.actor === "string" && source.actor !== "" ? { actor: source.actor } : {}),
  };
}

function implementationActors(input: {
  profile: SnapshotProfile;
  projection: RuntimeProjection;
  loopId: string;
  iteration: number;
}): ReadonlySet<string> | undefined {
  const actors = new Set<string>();
  const topLevelIds = ["implement", "edit-document"].filter((stepId) => input.profile.steps.some(({ id }) => id === stepId));
  if (topLevelIds.length === 0) return undefined;
  for (const stepId of topLevelIds) {
    const candidate = completedActor(input.projection.contexts[stepId]);
    if (!candidate.completed || candidate.actor === undefined) return undefined;
    actors.add(candidate.actor);
  }
  for (const [stepInstanceId, value] of Object.entries(input.projection.contexts)) {
    const parsed = parseLoopStepInstanceId(stepInstanceId);
    if (parsed?.loopId !== input.loopId || parsed.stepId !== "fix" || parsed.iteration >= input.iteration) continue;
    const candidate = completedActor(value);
    if (!candidate.completed) continue;
    if (candidate.actor === undefined) return undefined;
    actors.add(candidate.actor);
  }
  return actors.size === 0 ? undefined : actors;
}

function independentReviewsSatisfied(input: CloseChecklistInput, step: SnapshotStep): boolean {
  if (input.profile.id !== "governed" || step.independentReviewActor !== true) return true;
  if (input.projection.loops[step.id]?.status !== "succeeded") return false;
  const reviews = Object.entries(input.projection.contexts)
    .map(([stepInstanceId, value]) => ({ parsed: parseLoopStepInstanceId(stepInstanceId), value }))
    .filter(({ parsed }) => parsed?.loopId === step.id && parsed.stepId === "review")
    .filter(({ value }) => completedActor(value).completed);
  if (reviews.length === 0) return false;
  return reviews.every(({ parsed, value }) => {
    const reviewer = completedActor(value).actor;
    const actors = implementationActors({
      profile: input.profile,
      projection: input.projection,
      loopId: step.id,
      iteration: parsed!.iteration,
    });
    return reviewer !== undefined && actors !== undefined && !actors.has(reviewer);
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
  for (const step of flatten(input.profile.steps)) {
    if (!step.enabled || stepWasSkipped(input.projection, step)) continue;
    const artifacts = completedArtifacts(input.projection, step);
    for (const output of step.outputs.filter(({ required }) => required)) {
      if (!artifacts.some(({ artifactType }) => artifactType === output.artifact)) {
        addMissing("artifact", output.artifact);
      }
    }
    if (step.approval
      && !Object.values(input.projection.approvals).some((approval) => approvalMatches(approval, step, input.projection))) {
      addMissing("approval", step.id);
    }
  }
  for (const gateId of requiredGateIds(input.profile, input.gatePolicy)) {
    if (!hasFreshEvidence(input, gateId)) addMissing("evidence", gateId);
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
