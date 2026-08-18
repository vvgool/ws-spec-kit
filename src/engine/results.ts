import type { ProfileDecision, RuntimeProfileProjection, RuntimeRiskSignals } from "../application/profile.js";
import type { ProfileId } from "../domain/workflow.js";
import { evaluateProfileUpgrade, selectProfile, type RiskLevel } from "../policy/profile.js";
import { evaluateRiskRules, type RiskEvaluationInput } from "../policy/risk.js";
import type { SubmitResult } from "../protocol/application.js";
import type { RuntimeProjection } from "../storage/control-plane.js";

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

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function mergeRiskSignals(previous: RuntimeRiskSignals, result: SubmitResult): RuntimeRiskSignals {
  const signals = [...result.remainingRisks, ...result.evidence].map(record).filter((value): value is Record<string, unknown> => value !== undefined);
  const affectedPaths = unique(signals.flatMap((signal) => strings(signal.affectedPaths)));
  const modifiedPaths = unique(result.modifiedFiles);
  const paths = [...affectedPaths, ...modifiedPaths];
  return {
    levels: unique([
      ...previous.levels,
      ...signals.flatMap((signal) => {
        const value = riskLevel(signal.risk) ?? riskLevel(signal.level) ?? riskLevel(signal.requirementRisk);
        return value === undefined ? [] : [value];
      }),
    ]),
    affectedPaths: unique([...previous.affectedPaths, ...affectedPaths]),
    modifiedPaths: unique([...previous.modifiedPaths, ...modifiedPaths]),
    issueLabels: unique([...previous.issueLabels, ...signals.flatMap((signal) => strings(signal.issueLabels))]),
    fileTypes: unique([
      ...previous.fileTypes,
      ...signals.flatMap((signal) => strings(signal.fileTypes)),
      ...paths.flatMap((candidate) => {
        const basename = candidate.split("/").at(-1);
        const dot = basename?.lastIndexOf(".") ?? -1;
        return basename === undefined || dot <= 0 || dot === basename.length - 1 ? [] : [basename.slice(dot + 1)];
      }),
    ]),
    plannedActions: unique([
      ...previous.plannedActions,
      ...signals.flatMap((signal) => strings(signal.plannedActions)),
      ...(result.externalWrites.length === 0 ? [] : ["external-write"]),
    ]),
  };
}

export interface SubmitProfileEvaluation {
  profile: RuntimeProfileProjection;
  decision?: ProfileDecision;
}

export function evaluateSubmitProfileDecision(input: {
  projection: RuntimeProjection;
  result: SubmitResult;
  stepId: string;
  workflow: RiskEvaluationInput["workflow"];
}): SubmitProfileEvaluation {
  const riskSignals = mergeRiskSignals(input.projection.profile.riskSignals, input.result);
  const profile = { ...input.projection.profile, riskSignals };
  const postExplore = input.stepId === "explore";
  const hasRuntimeEvidence = Object.values(riskSignals).some((values) => values.length > 0);
  if (profile.mode === "auto" && profile.provisional && !postExplore) return { profile };
  if (!postExplore && !hasRuntimeEvidence) return { profile };
  if (profile.mode !== "auto" && !hasRuntimeEvidence) return { profile };

  const evaluation = evaluateRiskRules({
    workflow: input.workflow,
    issueLabels: riskSignals.issueLabels,
    requirementRisk: strongestRisk(riskSignals.levels),
    affectedPaths: riskSignals.affectedPaths,
    modifiedPaths: riskSignals.modifiedPaths,
    fileTypes: riskSignals.fileTypes,
    plannedActions: riskSignals.plannedActions,
  });
  const minimum: ProfileId = profile.mode === "auto" && postExplore
    ? selectProfile({ mode: "auto", phase: "post-explore", risk: evaluation.risk }).id
    : evaluation.minimum;
  const upgrade = evaluateProfileUpgrade({ current: profile.selected, minimum, affectedSteps: evaluation.affectedSteps });
  return {
    profile,
    decision: {
      previous: profile.selected,
      selected: upgrade.profile,
      reasonRuleIds: evaluation.matchedRules,
      invalidatedStepIds: upgrade.affectedSteps,
    },
  };
}
