import type { ProfileId } from "../domain/workflow.js";
import type { ProfileMode, RiskLevel } from "../policy/profile.js";
import type { RuntimeProjection } from "../storage/control-plane.js";

export interface ProfileDecision {
  previous: ProfileId;
  selected: ProfileId;
  reasonRuleIds: string[];
  invalidatedStepIds: string[];
}

export interface RuntimeProfileProjection {
  mode: ProfileMode;
  selected: ProfileId;
  provisional: boolean;
  reasonRuleIds: string[];
  riskSignals: RuntimeRiskSignals;
}

export interface RuntimeRiskSignals {
  levels: RiskLevel[];
  affectedPaths: string[];
  modifiedPaths: string[];
  issueLabels: string[];
  fileTypes: string[];
  plannedActions: string[];
}

export function emptyRuntimeRiskSignals(): RuntimeRiskSignals {
  return { levels: [], affectedPaths: [], modifiedPaths: [], issueLabels: [], fileTypes: [], plannedActions: [] };
}

export class ProfileRuntimeError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProfileRuntimeError";
  }
}

const strength: Record<ProfileId, number> = { quick: 0, standard: 1, governed: 2 };

function belongsToStep(candidate: string, stepId: string): boolean {
  return candidate === stepId || candidate.startsWith(`${stepId}:`);
}

function invalidated(candidate: string, stepIds: ReadonlySet<string>): boolean {
  return [...stepIds].some((stepId) => belongsToStep(candidate, stepId));
}

function evidenceDependsOnStep(value: unknown, stepIds: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => evidenceDependsOnStep(item, stepIds, depth + 1));
  const record = value as Record<string, unknown>;
  for (const key of ["stageId", "stepId", "stepInstanceId"] as const) {
    if (typeof record[key] === "string" && invalidated(record[key], stepIds)) return true;
  }
  return Object.values(record).some((item) => evidenceDependsOnStep(item, stepIds, depth + 1));
}

export function applyProfileDecision(
  projection: RuntimeProjection,
  decision: ProfileDecision,
  options: { preserveCurrentStep?: string } = {},
): RuntimeProjection {
  if (decision.previous !== projection.profile.selected) {
    throw new ProfileRuntimeError("WSSPEC_PROFILE_DECISION_STALE", "Profile 决策的 previous 与当前运行投影不一致。");
  }
  if (strength[decision.selected] < strength[decision.previous]) {
    throw new ProfileRuntimeError("WSSPEC_PROFILE_DOWNGRADE_FORBIDDEN", "运行时 Profile 只允许保持或提升强度。");
  }

  const upgraded = strength[decision.selected] > strength[decision.previous];
  const stepIds = new Set((upgraded ? decision.invalidatedStepIds : [])
    .filter((stepId) => stepId !== options.preserveCurrentStep));
  const stages = { ...projection.stages };
  for (const stepId of stepIds) {
    const stage = stages[stepId];
    if (stage !== undefined && !["succeeded", "succeeded_with_warnings", "cancelled"].includes(stage.status)) {
      stages[stepId] = { status: "invalidated" };
    }
  }
  const invalidatedPendingApproval = Object.values(projection.approvals)
    .some((approval) => approval.status === "pending" && invalidated(approval.stageId, stepIds));

  return {
    ...projection,
    workItem: projection.workItem.status === "awaiting_approval" && invalidatedPendingApproval
      ? { status: "active" }
      : projection.workItem,
    profile: {
      ...projection.profile,
      selected: decision.selected,
      provisional: false,
      reasonRuleIds: [...new Set([...projection.profile.reasonRuleIds, ...decision.reasonRuleIds])].sort(),
    },
    stages,
    claims: Object.fromEntries(Object.entries(projection.claims).filter(([stageId, claim]) =>
      !invalidated(stageId, stepIds) && !invalidated(claim.stageId, stepIds))),
    contexts: Object.fromEntries(Object.entries(projection.contexts).filter(([stepId]) => !invalidated(stepId, stepIds))),
    approvals: Object.fromEntries(Object.entries(projection.approvals).filter(([, approval]) => !invalidated(approval.stageId, stepIds))),
    evidence: Object.fromEntries(Object.entries(projection.evidence).filter(([key, value]) =>
      !invalidated(key, stepIds) && !evidenceDependsOnStep(value, stepIds))),
    loops: Object.fromEntries(Object.entries(projection.loops).filter(([loopId, loop]) =>
      !invalidated(loopId, stepIds) && !invalidated(loop.loopId, stepIds))),
    retries: Object.fromEntries(Object.entries(projection.retries).filter(([stepId, retry]) =>
      !invalidated(stepId, stepIds) && !invalidated(retry.stepInstanceId, stepIds))),
  };
}
