import assert from "node:assert/strict";
import test from "node:test";

import { evaluateProfileUpgrade, selectProfile } from "../../src/policy/profile.js";
import { evaluateRiskRules, type RiskEvaluationInput } from "../../src/policy/risk.js";

test("auto uses provisional quick during intake and standard for unknown post-explore risk", () => {
  assert.equal(selectProfile({ mode: "auto", phase: "intake", risk: null }).id, "quick");
  assert.equal(selectProfile({ mode: "auto", phase: "post-explore", risk: null }).id, "standard");
});

test("auto deterministically maps known risk while explicit mode remains explicit", () => {
  assert.equal(selectProfile({ mode: "auto", phase: "post-explore", risk: "low" }).id, "quick");
  assert.equal(selectProfile({ mode: "auto", phase: "post-explore", risk: "medium" }).id, "standard");
  assert.equal(selectProfile({ mode: "auto", phase: "post-explore", risk: "high" }).id, "governed");
  assert.deepEqual(selectProfile({ mode: "governed", phase: "intake", risk: "low" }), { id: "governed", provisional: false, source: "explicit" });
});

test("automatic upgrade is one-way and returns affected Steps without mutating Runtime", () => {
  assert.equal(evaluateProfileUpgrade({ current: "standard", minimum: "quick" }).profile, "standard");
  assert.deepEqual(evaluateProfileUpgrade({ current: "standard", minimum: "governed", affectedSteps: ["plan", "design", "plan"] }), {
    profile: "governed",
    upgraded: true,
    affectedSteps: ["design", "plan"],
  });
  assert.deepEqual(evaluateProfileUpgrade({ current: "governed", minimum: "quick", affectedSteps: ["design"] }), {
    profile: "governed",
    upgraded: false,
    affectedSteps: [],
  });
});

const neutralRisk: RiskEvaluationInput = {
  workflow: "feature",
  issueLabels: [],
  requirementRisk: null,
  affectedPaths: [],
  modifiedPaths: [],
  fileTypes: [],
  plannedActions: [],
};

test("risk rules read every deterministic signal and choose the strictest minimum", () => {
  const cases: Array<[string, Partial<RiskEvaluationInput>]> = [
    ["Issue label", { issueLabels: ["security"] }],
    ["requirement risk", { requirementRisk: "high" }],
    ["affected path", { affectedPaths: ["src/auth/session.ts"] }],
    ["modified path", { modifiedPaths: ["migrations/20260817.sql"] }],
    ["file type", { fileTypes: ["sql"] }],
    ["planned action", { plannedActions: ["deploy"] }],
  ];
  for (const [label, override] of cases) {
    const result = evaluateRiskRules({ ...neutralRisk, ...override });
    assert.equal(result.minimum, "governed", label);
    assert.ok(result.matchedRules.length > 0, label);
  }
});

test("risk remains unknown before evidence exists", () => {
  assert.deepEqual(evaluateRiskRules(neutralRisk), { risk: null, minimum: "standard", matchedRules: [], affectedSteps: [] });
  assert.deepEqual(evaluateRiskRules({ ...neutralRisk, requirementRisk: "low" }), {
    risk: "low",
    minimum: "quick",
    matchedRules: ["low-requirement"],
    affectedSteps: ["clarify", "plan", "review-fix", "verify-green"],
  });
});

test("documentation path evidence keeps the explicit feature Workflow invalidation map", () => {
  assert.deepEqual(evaluateRiskRules({
    ...neutralRisk,
    affectedPaths: ["docs/guide.md"],
    modifiedPaths: ["README.md"],
    fileTypes: ["md"],
  }), { risk: "low", minimum: "quick", matchedRules: ["documentation-only"], affectedSteps: ["clarify", "plan", "review-fix", "verify-green"] });
});

test("builtin governed risk keeps the explicit feature Workflow invalidation map for documentation paths", () => {
  const result = evaluateRiskRules({
    ...neutralRisk,
    requirementRisk: "high",
    affectedPaths: ["docs/security.md"],
    fileTypes: ["md"],
  });

  assert.deepEqual(result.affectedSteps, ["close", "commit", "design", "plan", "review-fix", "verify-green"]);
});

test("custom governed risk keeps the explicit feature Workflow invalidation map for documentation paths", () => {
  const result = evaluateRiskRules({
    ...neutralRisk,
    issueLabels: ["regulated-docs"],
    affectedPaths: ["docs/policy.md"],
    fileTypes: ["md"],
    rules: [{ id: "regulated-docs", labels: ["regulated-docs"], minimum: "governed" }],
  });

  assert.deepEqual(result.affectedSteps, ["close", "commit", "design", "plan", "review-fix", "verify-green"]);
});

test("custom project rules match all declared selectors and use the fixed Workflow invalidation map", () => {
  const result = evaluateRiskRules({
    ...neutralRisk,
    issueLabels: ["regulated-ledger"],
    affectedPaths: ["src/billing/charge.ts"],
    plannedActions: ["write-ledger"],
    rules: [{
      id: "payment-write",
      labels: ["regulated-ledger"],
      paths: ["src/billing/**"],
      actions: ["write-ledger"],
      minimum: "governed",
    }],
  });

  assert.equal(result.minimum, "governed");
  assert.ok(result.matchedRules.includes("payment-write"));
  assert.deepEqual(result.affectedSteps, ["close", "commit", "design", "plan", "review-fix", "verify-green"]);
});

test("documentation risk always returns documentation Workflow affected Steps", () => {
  const result = evaluateRiskRules({
    ...neutralRisk,
    workflow: "documentation-only",
    requirementRisk: "high",
    affectedPaths: ["docs/security.md"],
    fileTypes: ["md"],
  });

  assert.equal(result.minimum, "governed");
  assert.ok(result.affectedSteps.includes("verify-document"));
  assert.ok(!result.affectedSteps.includes("verify-green"));
});

test("documentation custom governed rules return only documentation Workflow Steps", () => {
  const result = evaluateRiskRules({
    ...neutralRisk,
    workflow: "documentation-only",
    issueLabels: ["regulated-docs"],
    affectedPaths: ["docs/policy.md"],
    fileTypes: ["md"],
    rules: [{ id: "regulated-docs", labels: ["regulated-docs"], minimum: "governed" }],
  });

  assert.deepEqual(result.affectedSteps, ["clarify", "close", "commit", "plan", "review-fix", "verify-document"]);
  assert.ok(!result.affectedSteps.includes("verify-green"));
});

test("documentation Workflow keeps its invalidation map when sensitive paths raise risk", () => {
  const result = evaluateRiskRules({
    ...neutralRisk,
    workflow: "documentation-only",
    affectedPaths: ["src/auth/session.ts"],
    fileTypes: ["ts"],
  });

  assert.equal(result.minimum, "governed");
  assert.deepEqual(result.affectedSteps, ["clarify", "close", "commit", "plan", "review-fix", "verify-document"]);
});

test("risk evaluation rejects missing and unknown Workflow kinds", () => {
  for (const workflow of [undefined, "maintenance"]) {
    assert.throws(() => evaluateRiskRules({
      ...neutralRisk,
      workflow,
    } as unknown as RiskEvaluationInput), (error: unknown) => error instanceof Error
      && "code" in error
      && "path" in error
      && error.code === "WSSPEC_RISK_WORKFLOW_INVALID"
      && error.path === "/workflow");
  }
});

test("custom risk rules cannot inject affected Step IDs", () => {
  assert.throws(() => evaluateRiskRules({
    ...neutralRisk,
    workflow: "documentation-only",
    issueLabels: ["regulated-docs"],
    rules: [{
      id: "invalid-steps",
      labels: ["regulated-docs"],
      minimum: "governed",
      affectedSteps: ["verify-green"],
    }],
  } as unknown as RiskEvaluationInput), (error: unknown) => error instanceof Error
    && "code" in error
    && "path" in error
    && error.code === "WSSPEC_RISK_RULE_INVALID"
    && error.path === "/rules/0/affectedSteps");
});
