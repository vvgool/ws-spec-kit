import type { ProfileId } from "../domain/workflow.js";
import { evaluateProfileUpgrade, selectProfile, type RiskLevel } from "../policy/profile.js";
import { evaluateRiskRules, type RiskEvaluationInput } from "../policy/risk.js";
import type { SubmitResult } from "../protocol/application.js";
import type { RuntimeProjection } from "../storage/control-plane.js";
import type { ProfileDecision } from "../application/profile.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

function riskLevel(value: unknown): RiskLevel | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

const riskStrength: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

function strongestRisk(values: readonly RiskLevel[]): RiskLevel | null {
  return values.reduce<RiskLevel | null>((current, candidate) =>
    current === null || riskStrength[candidate] > riskStrength[current] ? candidate : current, null);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function evaluateSubmitProfileDecision(input: {
  projection: RuntimeProjection;
  result: SubmitResult;
  stepId: string;
  workflow: RiskEvaluationInput["workflow"];
}): ProfileDecision | undefined {
  const signals = [...input.result.remainingRisks, ...input.result.evidence].map(record).filter((value): value is Record<string, unknown> => value !== undefined);
  const levels = signals.flatMap((signal) => {
    const value = riskLevel(signal.risk) ?? riskLevel(signal.level) ?? riskLevel(signal.requirementRisk);
    return value === undefined ? [] : [value];
  });
  const affectedPaths = unique(signals.flatMap((signal) => strings(signal.affectedPaths)));
  const issueLabels = unique(signals.flatMap((signal) => strings(signal.issueLabels)));
  const plannedActions = unique([
    ...signals.flatMap((signal) => strings(signal.plannedActions)),
    ...(input.result.externalWrites.length === 0 ? [] : ["external-write"]),
  ]);
  const modifiedPaths = unique(input.result.modifiedFiles);
  const fileTypes = unique([
    ...signals.flatMap((signal) => strings(signal.fileTypes)),
    ...[...affectedPaths, ...modifiedPaths].flatMap((candidate) => {
      const extension = candidate.split("/").at(-1)?.split(".").at(-1);
      return extension === undefined || extension === candidate ? [] : [extension];
    }),
  ]);
  const postExplore = input.stepId === "explore";
  const hasRuntimeEvidence = levels.length > 0 || affectedPaths.length > 0 || modifiedPaths.length > 0
    || issueLabels.length > 0 || fileTypes.length > 0 || plannedActions.length > 0;
  if (!postExplore && !hasRuntimeEvidence) return undefined;
  if (input.projection.profile.mode !== "auto" && !hasRuntimeEvidence) return undefined;

  const evaluation = evaluateRiskRules({
    workflow: input.workflow,
    issueLabels,
    requirementRisk: strongestRisk(levels),
    affectedPaths,
    modifiedPaths,
    fileTypes,
    plannedActions,
  });
  const minimum: ProfileId = input.projection.profile.mode === "auto" && postExplore
    ? selectProfile({ mode: "auto", phase: "post-explore", risk: evaluation.risk }).id
    : evaluation.minimum;
  const upgrade = evaluateProfileUpgrade({
    current: input.projection.profile.selected,
    minimum,
    affectedSteps: evaluation.affectedSteps,
  });
  return {
    previous: input.projection.profile.selected,
    selected: upgrade.profile,
    reasonRuleIds: evaluation.matchedRules,
    invalidatedStepIds: upgrade.affectedSteps,
  };
}
