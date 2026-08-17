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
}

export interface RiskEvaluationInput {
  workflow: "feature" | "documentation-only";
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
const featureInvalidation: Record<ProfileId, readonly string[]> = {
  quick: ["clarify", "plan", "review-fix", "verify-green"],
  standard: ["design", "plan", "review-fix", "verify-green"],
  governed: ["design", "plan", "review-fix", "verify-green", "commit", "close"],
};
const documentationInvalidation: Record<ProfileId, readonly string[]> = {
  quick: ["clarify", "plan", "review-fix", "verify-document"],
  standard: ["clarify", "plan", "review-fix", "verify-document"],
  governed: ["clarify", "plan", "review-fix", "verify-document", "commit", "close"],
};
const riskRuleKeys = new Set(["id", "labels", "requirementRisks", "paths", "fileTypes", "actions", "minimum"]);

const builtinRules: RiskRule[] = [
  { id: "sensitive-label", labels: ["security", "permissions", "payment", "payments", "privacy", "release"], minimum: "governed" },
  { id: "high-requirement", requirementRisks: ["high"], minimum: "governed" },
  { id: "medium-requirement", requirementRisks: ["medium"], minimum: "standard" },
  { id: "low-requirement", requirementRisks: ["low"], minimum: "quick" },
  { id: "sensitive-path", paths: ["src/auth/**", "src/permissions/**", "migrations/**", "schema/**"], minimum: "governed" },
  { id: "sensitive-file-type", fileTypes: ["sql", "pem", "key"], minimum: "governed" },
  { id: "sensitive-action", actions: ["deploy", "release", "external-write", "database-migrate"], minimum: "governed" },
];

export class RiskPolicyError extends Error {
  constructor(readonly code: "WSSPEC_RISK_RULE_INVALID" | "WSSPEC_RISK_WORKFLOW_INVALID", readonly path: string, message: string) {
    super(`${code} ${path}: ${message}`);
    this.name = "RiskPolicyError";
  }
}

function validateWorkflow(workflow: unknown): asserts workflow is RiskEvaluationInput["workflow"] {
  if (workflow !== "feature" && workflow !== "documentation-only") {
    throw new RiskPolicyError("WSSPEC_RISK_WORKFLOW_INVALID", "/workflow", "Workflow 必须是 feature 或 documentation-only。");
  }
}

function validateCustomRule(rule: RiskRule, index: number): void {
  const path = `/rules/${index}`;
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) throw new RiskPolicyError("WSSPEC_RISK_RULE_INVALID", path, "Risk rule 必须是对象。");
  const source = rule as unknown as Record<string, unknown>;
  const unknown = Object.keys(source).find((key) => !riskRuleKeys.has(key));
  if (unknown !== undefined) throw new RiskPolicyError("WSSPEC_RISK_RULE_INVALID", `${path}/${unknown}`, `Risk rule 不接受字段 ${unknown}。`);
  if (typeof rule.id !== "string" || rule.id === "" || !Object.hasOwn(strength, rule.minimum)) throw new RiskPolicyError("WSSPEC_RISK_RULE_INVALID", path, "Risk rule 缺少有效 id 或 minimum。");
  for (const field of ["labels", "paths", "fileTypes", "actions"] as const) {
    const values = rule[field];
    if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value === ""))) throw new RiskPolicyError("WSSPEC_RISK_RULE_INVALID", `${path}/${field}`, `${field} 必须是非空字符串数组。`);
  }
  if (rule.requirementRisks !== undefined && (!Array.isArray(rule.requirementRisks) || rule.requirementRisks.some((risk) => !["low", "medium", "high"].includes(risk)))) throw new RiskPolicyError("WSSPEC_RISK_RULE_INVALID", `${path}/requirementRisks`, "requirementRisks 包含未知风险等级。");
}

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
  validateWorkflow(input.workflow);
  for (const [index, rule] of (input.rules ?? []).entries()) validateCustomRule(rule, index);
  const rules = [...builtinRules, ...(input.rules ?? [])];
  const matched = rules.filter((rule) => matchesRule(rule, input));
  if (matched.length === 0 && documentationOnly(input)) {
    return {
      risk: "low",
      minimum: "quick",
      matchedRules: ["documentation-only"],
      affectedSteps: [...(input.workflow === "documentation-only" ? documentationInvalidation.quick : featureInvalidation.quick)],
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
  const affectedSteps = input.workflow === "documentation-only" ? documentationInvalidation[minimum] : featureInvalidation[minimum];
  return {
    risk: minimum === "quick" ? "low" : minimum === "standard" ? "medium" : "high",
    minimum,
    matchedRules: [...new Set(matched.map(({ id }) => id))].sort(),
    affectedSteps: [...affectedSteps].sort(),
  };
}
