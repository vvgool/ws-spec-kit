import type { ProfileId } from "../domain/workflow.js";
import type { RiskLevel } from "./profile.js";

export interface RiskRule {
  id: string;
  labels?: string[];
  requirementRisks?: RiskLevel[];
  paths?: string[];
  fileTypes?: string[];
  actions?: string[];
  minimum: ProfileId;
  affectedSteps?: string[];
}

export interface RiskEvaluationInput {
  workflow?: "feature" | "documentation-only";
  issueLabels: string[];
  requirementRisk: RiskLevel | null;
  affectedPaths: string[];
  modifiedPaths: string[];
  fileTypes: string[];
  plannedActions: string[];
  rules?: RiskRule[];
}

export interface RiskEvaluation {
  risk: RiskLevel | null;
  minimum: ProfileId;
  matchedRules: string[];
  affectedSteps: string[];
}

const strength: Record<ProfileId, number> = { quick: 0, standard: 1, governed: 2 };
const governedSteps = ["design", "plan", "review-fix", "verify-green", "commit", "close"];

const builtinRules: RiskRule[] = [
  { id: "sensitive-label", labels: ["security", "permissions", "payment", "payments", "privacy", "release"], minimum: "governed", affectedSteps: governedSteps },
  { id: "high-requirement", requirementRisks: ["high"], minimum: "governed", affectedSteps: governedSteps },
  { id: "medium-requirement", requirementRisks: ["medium"], minimum: "standard", affectedSteps: ["design", "plan", "review-fix", "verify-green"] },
  { id: "low-requirement", requirementRisks: ["low"], minimum: "quick", affectedSteps: ["clarify", "plan", "review-fix", "verify-green"] },
  { id: "sensitive-path", paths: ["src/auth/**", "src/permissions/**", "migrations/**", "schema/**"], minimum: "governed", affectedSteps: governedSteps },
  { id: "sensitive-file-type", fileTypes: ["sql", "pem", "key"], minimum: "governed", affectedSteps: governedSteps },
  { id: "sensitive-action", actions: ["deploy", "release", "external-write", "database-migrate"], minimum: "governed", affectedSteps: governedSteps },
];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function glob(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") { source += ".*"; index += 1; }
      else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left.map(normalize));
  return right.some((value) => values.has(normalize(value)));
}

function matchesRule(rule: RiskRule, input: RiskEvaluationInput): boolean {
  if (rule.labels !== undefined && !intersects(input.issueLabels, rule.labels)) return false;
  if (rule.requirementRisks !== undefined && (input.requirementRisk === null || !rule.requirementRisks.includes(input.requirementRisk))) return false;
  if (rule.paths !== undefined) {
    const paths = [...input.affectedPaths, ...input.modifiedPaths];
    if (!rule.paths.some((pattern) => paths.some((candidate) => glob(pattern).test(candidate)))) return false;
  }
  if (rule.fileTypes !== undefined && !intersects(input.fileTypes.map((type) => type.replace(/^\./, "")), rule.fileTypes)) return false;
  if (rule.actions !== undefined && !intersects(input.plannedActions, rule.actions)) return false;
  return rule.labels !== undefined || rule.requirementRisks !== undefined || rule.paths !== undefined || rule.fileTypes !== undefined || rule.actions !== undefined;
}

function documentationOnly(input: RiskEvaluationInput): boolean {
  const paths = [...input.affectedPaths, ...input.modifiedPaths];
  if (paths.length === 0) return false;
  const documentationPath = /^(?:README[^/]*\.md|CHANGELOG[^/]*\.md|docs\/.+\.(?:md|mdx|txt))$/i;
  return paths.every((path) => documentationPath.test(path))
    && input.fileTypes.every((type) => ["md", "mdx", "txt"].includes(normalize(type).replace(/^\./, "")))
    && input.plannedActions.length === 0;
}

export function evaluateRiskRules(input: RiskEvaluationInput): RiskEvaluation {
  const rules = [...builtinRules, ...(input.rules ?? [])];
  const matched = rules.filter((rule) => matchesRule(rule, input));
  const isDocumentation = input.workflow === "documentation-only" || documentationOnly(input);
  if (matched.length === 0 && isDocumentation) {
    return {
      risk: "low",
      minimum: "quick",
      matchedRules: ["documentation-only"],
      affectedSteps: ["clarify", "plan", "review-fix", "verify-document"],
    };
  }
  if (matched.length === 0) {
    const hasEvidence = input.requirementRisk !== null
      || input.issueLabels.length > 0
      || input.affectedPaths.length > 0
      || input.modifiedPaths.length > 0
      || input.fileTypes.length > 0
      || input.plannedActions.length > 0;
    return { risk: hasEvidence ? "medium" : null, minimum: "standard", matchedRules: [], affectedSteps: [] };
  }
  const minimum = matched.reduce<ProfileId>((current, rule) => strength[rule.minimum] > strength[current] ? rule.minimum : current, "quick");
  const customRuleIds = new Set((input.rules ?? []).map(({ id }) => id));
  const documentationSteps = minimum === "governed"
    ? ["clarify", "plan", "review-fix", "verify-document", "commit", "close"]
    : ["clarify", "plan", "review-fix", "verify-document"];
  return {
    risk: minimum === "quick" ? "low" : minimum === "standard" ? "medium" : "high",
    minimum,
    matchedRules: [...new Set(matched.map(({ id }) => id))].sort(),
    affectedSteps: [...new Set(matched.flatMap((rule) => isDocumentation && !customRuleIds.has(rule.id) ? documentationSteps : (rule.affectedSteps ?? [])))].sort(),
  };
}
