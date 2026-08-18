import assert from "node:assert/strict";
import test from "node:test";

import {
  CompileError,
  compileWorkflow as compileWorkflowWithPolicy,
  resolveChangePolicy,
  type CompileProfile,
  type ProjectGatePolicy,
} from "../../src/engine/compiler.js";
import { resolveSkill } from "../../src/registry/skills/resolver.js";
import type { ResolvedSkill } from "../../src/registry/skills/types.js";
import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";
import type { ProfileDefinition, WorkflowPackage, WorkflowStep } from "../../src/workflow-package/types.js";

interface CompilerFixture {
  pkg: WorkflowPackage;
  profile: CompileProfile;
}

function clonePackage(pkg: WorkflowPackage): WorkflowPackage {
  return {
    ...pkg,
    manifest: structuredClone(pkg.manifest),
    workflow: structuredClone(pkg.workflow),
    profiles: new Map([...pkg.profiles].map(([id, profile]) => [id, structuredClone(profile)])),
    packageSkills: new Map([...pkg.packageSkills].map(([ref, skill]) => [ref, { ...skill }])),
    files: pkg.files.map((file) => ({ ...file })),
  };
}

function allSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [step, ...allSteps(step.steps ?? [])]);
}

async function fixture(workflow = "feature-delivery", profileId = "standard"): Promise<CompilerFixture> {
  const loaded = await loadWorkflowPackage({ root: process.cwd(), ref: `builtin://workflows/${workflow}` });
  const pkg = clonePackage(loaded);
  const bindings = new Map(allSteps(pkg.workflow.steps).flatMap((step) => (step.skills ?? []).map((binding) => [binding.ref, binding])));
  const skills = (await Promise.all([...bindings.values()].map((binding) => resolveSkill(binding, {
    provider: "codex",
    projectRoot: process.cwd(),
    home: process.cwd(),
    package: pkg,
    stepStatus: "not_started",
  })))).filter((skill): skill is ResolvedSkill => skill !== undefined);
  return { pkg, profile: { id: profileId, skills } };
}

function step(pkg: WorkflowPackage, id: string): WorkflowStep {
  const found = allSteps(pkg.workflow.steps).find((candidate) => candidate.id === id);
  assert.ok(found, `missing fixture step ${id}`);
  return found;
}

function profile(pkg: WorkflowPackage, id: string): ProfileDefinition {
  const found = pkg.profiles.get(id);
  assert.ok(found, `missing fixture profile ${id}`);
  return found;
}

function defaultGatePolicy(pkg: WorkflowPackage): ProjectGatePolicy {
  const minimum = pkg.workflow.workflow.id === "documentation-delivery" ? "docs.integrity" : "test";
  return { requiredGateIds: [minimum], configuredGateIds: [minimum] };
}

function compileWorkflow(
  pkg: WorkflowPackage,
  selected: CompileProfile,
  gatePolicy: ProjectGatePolicy = defaultGatePolicy(pkg),
): ReturnType<typeof compileWorkflowWithPolicy> {
  return compileWorkflowWithPolicy(pkg, selected, gatePolicy);
}

function expectCompileError(run: () => unknown, code: `WSSPEC_${string}`): void {
  assert.throws(run, (error: unknown) => error instanceof CompileError && error.code === code && error.path.startsWith("/"));
}

test("compiles the formal Step Manifest with registry-owned security classes and resolved Skills", async () => {
  const { pkg, profile } = await fixture();

  const compiled = compileWorkflow(pkg, profile);

  assert.equal(compiled.id, "feature-delivery");
  assert.equal(compiled.profile.id, "standard");
  assert.equal(compiled.steps.find(({ id }) => id === "intake")?.securityClass, "external-read");
  assert.equal(compiled.steps.find(({ id }) => id === "verify-red")?.securityClass, "local-write");
  assert.equal(compiled.steps.find(({ id }) => id === "commit")?.securityClass, "local-write");
  assert.equal(compiled.steps.find(({ id }) => id === "update-wiki")?.securityClass, "external-write");
  assert.equal(compiled.steps.find(({ id }) => id === "close")?.securityClass, "control");
  assert.equal(compiled.steps.find(({ id }) => id === "intake")?.authorizationRequired, false);
  assert.equal(compiled.steps.find(({ id }) => id === "commit")?.authorizationRequired, true);
  assert.equal(compiled.steps.find(({ id }) => id === "update-wiki")?.authorizationRequired, true);
  assert.equal(compiled.steps.find(({ id }) => id === "implement")?.skills[0]?.requestedRef, "builtin://skills/tdd-implementation");
  assert.equal(compiled.steps.find(({ id }) => id === "review-fix")?.until, "${artifacts.review-result.approved}");
  assert.deepEqual(compiled.order.slice(0, 5), ["intake", "explore", "clarify", "design", "plan"]);
  assert.equal(compiled.changePolicy.kind, "feature");
});

test("Quick skips only independent design while keeping a compact plan consumed by implement", async () => {
  const { pkg, profile } = await fixture("feature-delivery", "quick");

  const compiled = compileWorkflow(pkg, profile);

  assert.equal(compiled.steps.find(({ id }) => id === "design")?.enabled, false);
  assert.equal(compiled.steps.find(({ id }) => id === "plan")?.enabled, true);
  assert.equal(compiled.steps.find(({ id }) => id === "plan")?.artifactLevel, "compact");
  assert.deepEqual(compiled.steps.find(({ id }) => id === "plan")?.inputs, [
    { artifact: "specification", required: true },
    { artifact: "design", required: false },
  ]);
  assert.deepEqual(compiled.steps.find(({ id }) => id === "implement")?.inputs, [{ artifact: "tasks", required: true }]);
});

test("rejects duplicate Step IDs including nested control Steps", async () => {
  const { pkg, profile } = await fixture();
  step(pkg, "review-fix").steps?.push({ id: "plan", uses: "agent.execute" });

  expectCompileError(() => compileWorkflow(pkg, profile), "WSSPEC_COMPILE_DUPLICATE_STEP");
});

test("rejects nested control.loop before completed Submit can bypass its until condition", async () => {
  const { pkg, profile } = await fixture();
  step(pkg, "review-fix").steps?.push({
    id: "nested-review-fix",
    uses: "control.loop",
    until: "false",
    maxIterations: 2,
    steps: [{ id: "nested-review", uses: "agent.execute" }],
  });

  assert.throws(
    () => compileWorkflow(pkg, profile),
    (error: unknown) => error instanceof CompileError
      && error.code === "WSSPEC_COMPILE_NESTED_LOOP_UNSUPPORTED"
      && error.path === "/steps/9/steps/3/uses",
  );
});

test("rejects unknown dependencies and cycles in the complete top-level DAG", async () => {
  const unknown = await fixture();
  step(unknown.pkg, "plan").needs = ["missing"];
  expectCompileError(() => compileWorkflow(unknown.pkg, unknown.profile), "WSSPEC_COMPILE_UNKNOWN_DEPENDENCY");

  const cyclic = await fixture();
  step(cyclic.pkg, "intake").needs = ["plan"];
  expectCompileError(() => compileWorkflow(cyclic.pkg, cyclic.profile), "WSSPEC_COMPILE_CYCLE");
});

test("rejects unknown dependencies and cycles inside nested control DAGs", async () => {
  const unknown = await fixture();
  step(unknown.pkg, "review").needs = ["missing"];
  expectCompileError(() => compileWorkflow(unknown.pkg, unknown.profile), "WSSPEC_COMPILE_UNKNOWN_DEPENDENCY");

  const cyclic = await fixture();
  step(cyclic.pkg, "review").needs = ["verify"];
  step(cyclic.pkg, "verify").needs = ["review"];
  expectCompileError(() => compileWorkflow(cyclic.pkg, cyclic.profile), "WSSPEC_COMPILE_CYCLE");
});

test("rejects malformed expressions and references to undeclared outputs", async () => {
  const malformed = await fixture();
  step(malformed.pkg, "update-issue").when = "${bindings.issue.exists = true}";
  expectCompileError(() => compileWorkflow(malformed.pkg, malformed.profile), "WSSPEC_COMPILE_EXPRESSION_INVALID");

  const unknown = await fixture();
  step(unknown.pkg, "update-issue").when = "${artifacts.missing.approved}";
  expectCompileError(() => compileWorkflow(unknown.pkg, unknown.profile), "WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNKNOWN");
});

test("compiler 与 runtime 共用受限 AST，并接受复合 Binding 和 Artifact 条件", async () => {
  const { pkg, profile: selected } = await fixture();
  step(pkg, "update-issue").when = "${bindings.issue.exists && (bindings.knowledge.exists == false)}";
  step(pkg, "commit").when = "${artifacts.review-result.approved == true || bindings.issue.exists}";

  const compiled = compileWorkflow(pkg, selected);

  assert.equal(compiled.steps.find(({ id }) => id === "update-issue")?.when, "${bindings.issue.exists && (bindings.knowledge.exists == false)}");
  assert.equal(compiled.steps.find(({ id }) => id === "commit")?.when, "${artifacts.review-result.approved == true || bindings.issue.exists}");
});

test("嵌套 Step 条件可引用父级可达依赖，并区分未来与未知 Step", async () => {
  const parentDependency = await fixture();
  step(parentDependency.pkg, "fix").when = "${steps.verify-green.status == 'succeeded'}";
  assert.doesNotThrow(() => compileWorkflow(parentDependency.pkg, parentDependency.profile));

  const future = await fixture();
  step(future.pkg, "fix").when = "${steps.commit.status == 'succeeded'}";
  expectCompileError(() => compileWorkflow(future.pkg, future.profile), "WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNAVAILABLE");

  const unknown = await fixture();
  step(unknown.pkg, "fix").when = "${steps.missing.status == 'succeeded'}";
  expectCompileError(() => compileWorkflow(unknown.pkg, unknown.profile), "WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNKNOWN");
});

test("rejects expressions that reference unreachable, future, disabled or unknown-typed outputs", async () => {
  const future = await fixture();
  step(future.pkg, "clarify").when = "${artifacts.review-result.approved}";
  expectCompileError(() => compileWorkflow(future.pkg, future.profile), "WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNAVAILABLE");

  const disabled = await fixture("feature-delivery", "quick");
  step(disabled.pkg, "plan").when = "${artifacts.design.approved}";
  expectCompileError(() => compileWorkflow(disabled.pkg, disabled.profile), "WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNAVAILABLE");

  const property = await fixture();
  step(property.pkg, "commit").when = "${artifacts.review-result.typo}";
  expectCompileError(() => compileWorkflow(property.pkg, property.profile), "WSSPEC_COMPILE_EXPRESSION_PROPERTY_UNKNOWN");
});

test("rejects unknown Executors and Workflow attempts to supply a security class", async () => {
  const unknown = await fixture();
  step(unknown.pkg, "implement").uses = "shell.execute";
  expectCompileError(() => compileWorkflow(unknown.pkg, unknown.profile), "WSSPEC_EXECUTOR_NOT_FOUND");

  const forged = await fixture();
  Object.assign(step(forged.pkg, "commit"), { securityClass: "agent" });
  expectCompileError(() => compileWorkflow(forged.pkg, forged.profile), "WSSPEC_COMPILE_SECURITY_OVERRIDE");
});

test("rejects missing required Skills and Skill attempts to expand allowed paths", async () => {
  const missing = await fixture();
  missing.profile.skills = missing.profile.skills.filter(({ requestedRef }) => requestedRef !== "builtin://skills/tdd-implementation");
  expectCompileError(() => compileWorkflow(missing.pkg, missing.profile), "WSSPEC_COMPILE_REQUIRED_SKILL_MISSING");

  const forged = await fixture();
  Object.assign(forged.profile.skills[0]!, { allowedPaths: ["src/**"] });
  expectCompileError(() => compileWorkflow(forged.pkg, forged.profile), "WSSPEC_COMPILE_SKILL_POLICY_OVERRIDE");
});

test("rejects required inputs produced only by a disabled Step", async () => {
  const { pkg, profile: selected } = await fixture("feature-delivery", "quick");
  step(pkg, "plan").inputs = [{ artifact: "specification", required: true }, { artifact: "design", required: true }];

  expectCompileError(() => compileWorkflow(pkg, selected), "WSSPEC_COMPILE_DISABLED_OUTPUT_REQUIRED");
});

test("rejects nested required inputs produced only by a disabled sibling Step", async () => {
  const { pkg, profile: selected } = await fixture();
  Object.assign(profile(pkg, "standard").steps, { fix: { enabled: false } });
  step(pkg, "fix").outputs = ["fix-result"];
  step(pkg, "verify").needs = ["fix"];
  step(pkg, "verify").inputs = ["fix-result"];

  expectCompileError(() => compileWorkflow(pkg, selected), "WSSPEC_COMPILE_DISABLED_OUTPUT_REQUIRED");
});

test("rejects required inputs produced only by optional or conditional top-level outputs", async () => {
  const optional = await fixture();
  optional.pkg.ref = "project://workflows/feature-delivery";
  for (const profileId of ["quick", "standard", "governed"]) {
    profile(optional.pkg, profileId).steps.plan!.artifacts!.tasks!.required = false;
  }
  expectCompileError(() => compileWorkflow(optional.pkg, optional.profile), "WSSPEC_COMPILE_OUTPUT_NOT_GUARANTEED");

  const conditional = await fixture();
  conditional.pkg.ref = "project://workflows/feature-delivery";
  step(conditional.pkg, "plan").when = "${bindings.issue.exists}";
  expectCompileError(() => compileWorkflow(conditional.pkg, conditional.profile), "WSSPEC_COMPILE_OUTPUT_NOT_GUARANTEED");
});

test("rejects a nested required input produced only by an optional loop output", async () => {
  const { pkg, profile: selected } = await fixture();
  pkg.ref = "project://workflows/feature-delivery";
  step(pkg, "review").outputs = ["review-result", "review-evidence"];
  step(pkg, "verify").needs = ["review"];
  step(pkg, "verify").inputs = ["review-evidence"];
  for (const profileId of ["quick", "standard", "governed"]) {
    profile(pkg, profileId).steps.review = { artifacts: { "review-evidence": { required: false } } };
  }

  expectCompileError(() => compileWorkflow(pkg, selected), "WSSPEC_COMPILE_OUTPUT_NOT_GUARANTEED");
});

test("accepts a required input when another ancestor guarantees the same Artifact", async () => {
  const { pkg, profile: selected } = await fixture();
  pkg.ref = "project://workflows/feature-delivery";
  step(pkg, "clarify").outputs = ["specification", "tasks"];
  for (const profileId of ["quick", "standard", "governed"]) {
    profile(pkg, profileId).steps.plan!.artifacts!.tasks!.required = false;
  }

  const compiled = compileWorkflow(pkg, selected);

  assert.equal(compiled.profile.id, "standard");
});

test("rejects required inputs without a producer in the dependency closure", async () => {
  const { pkg, profile } = await fixture();
  step(pkg, "verify-green").inputs = ["red-evidence", "unknown-result"];

  expectCompileError(() => compileWorkflow(pkg, profile), "WSSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER");
});

test("rejects Profile attempts to change execution, dependencies, security or external targets", async () => {
  const forbidden = [
    ["uses", "command.execute"],
    ["needs", ["intake"]],
    ["securityClass", "agent"],
    ["externalTarget", "attacker"],
    ["allowedPaths", ["src/**"]],
  ] as const;
  for (const [key, value] of forbidden) {
    const { pkg, profile: selected } = await fixture();
    Object.assign(profile(pkg, "standard").steps.plan!, { [key]: value });
    expectCompileError(() => compileWorkflow(pkg, selected), "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN");
  }

  const publishing = await fixture();
  Object.assign(profile(publishing.pkg, "standard").publishing, { targets: ["attacker"] });
  expectCompileError(() => compileWorkflow(publishing.pkg, publishing.profile), "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN");
});

test("Profiles cannot lower approval, Review or enabled-Step strength", async () => {
  const approval = await fixture();
  profile(approval.pkg, "standard").steps.commit = { approval: false };
  expectCompileError(() => compileWorkflow(approval.pkg, approval.profile), "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE");

  const review = await fixture();
  profile(review.pkg, "standard").steps["review-fix"]!.maxIterations = 1;
  expectCompileError(() => compileWorkflow(review.pkg, review.profile), "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE");

  const governed = await fixture("feature-delivery", "governed");
  profile(governed.pkg, "governed").steps.design!.enabled = false;
  expectCompileError(() => compileWorkflow(governed.pkg, governed.profile), "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE");

  const unselected = await fixture("feature-delivery", "standard");
  profile(unselected.pkg, "governed").steps.design!.enabled = false;
  expectCompileError(() => compileWorkflow(unselected.pkg, unselected.profile), "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE");

  const publishing = await fixture("feature-delivery", "standard");
  profile(publishing.pkg, "quick").publishing.issueRequired = true;
  expectCompileError(() => compileWorkflow(publishing.pkg, publishing.profile), "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE");

  const audit = await fixture("feature-delivery", "standard");
  profile(audit.pkg, "quick").audit.level = "complete";
  expectCompileError(() => compileWorkflow(audit.pkg, audit.profile), "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE");

  const jointlyWeakened = await fixture("feature-delivery", "standard");
  profile(jointlyWeakened.pkg, "standard").steps.clarify!.approval = false;
  profile(jointlyWeakened.pkg, "governed").steps.clarify!.approval = false;
  profile(jointlyWeakened.pkg, "governed").steps.plan!.approval = false;
  profile(jointlyWeakened.pkg, "governed").publishing = { issueRequired: false, knowledgeRequired: false, readBackRequired: false };
  profile(jointlyWeakened.pkg, "governed").audit = {
    level: "standard",
    retention: "standard",
    recordDecisions: false,
    recordApprovals: false,
    recordActors: false,
    recordPublishing: false,
  };
  expectCompileError(() => compileWorkflow(jointlyWeakened.pkg, jointlyWeakened.profile), "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE");

  const excessiveReview = await fixture("feature-delivery", "standard");
  profile(excessiveReview.pkg, "standard").steps["review-fix"]!.maxIterations = 6;
  profile(excessiveReview.pkg, "governed").steps["review-fix"]!.maxIterations = 6;
  expectCompileError(() => compileWorkflow(excessiveReview.pkg, excessiveReview.profile), "WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE");
});

test("Quick documentation Profile may disable an optional publishing Step", async () => {
  const { pkg, profile: selected } = await fixture("documentation-delivery", "quick");
  profile(pkg, "quick").steps["update-wiki"] = { enabled: false };

  const compiled = compileWorkflow(pkg, selected);

  assert.equal(compiled.steps.find(({ id }) => id === "update-wiki")?.enabled, false);
});

test("project Workflow Profile may disable an optional Step without inheriting Builtin-only defaults", async () => {
  const { pkg, profile: selected } = await fixture("feature-delivery", "quick");
  pkg.ref = "project://workflows/feature-delivery";
  profile(pkg, "quick").steps["update-wiki"] = { enabled: false };

  const compiled = compileWorkflow(pkg, selected);

  assert.equal(compiled.steps.find(({ id }) => id === "update-wiki")?.enabled, false);
});

test("Package Manifest must disclose every Executor capability, connector and external side effect", async () => {
  const capability = await fixture();
  capability.pkg.manifest.capabilities = capability.pkg.manifest.capabilities.filter((item) => item !== "command-execution");
  expectCompileError(() => compileWorkflow(capability.pkg, capability.profile), "WSSPEC_COMPILE_MANIFEST_CAPABILITY_MISSING");

  const connector = await fixture();
  connector.pkg.manifest.connectors = connector.pkg.manifest.connectors.filter((item) => item !== "knowledge");
  expectCompileError(() => compileWorkflow(connector.pkg, connector.profile), "WSSPEC_COMPILE_MANIFEST_CONNECTOR_MISSING");

  const sideEffect = await fixture();
  sideEffect.pkg.manifest.externalSideEffects = sideEffect.pkg.manifest.externalSideEffects.filter((item) => item !== "issue-close");
  expectCompileError(() => compileWorkflow(sideEffect.pkg, sideEffect.profile), "WSSPEC_COMPILE_MANIFEST_SIDE_EFFECT_MISSING");
});

test("Gate policy rejects unknown IDs and required Gates outside configured Gates", async () => {
  const unknown = await fixture();
  expectCompileError(() => compileWorkflow(unknown.pkg, unknown.profile, {
    requiredGateIds: ["lint"],
    configuredGateIds: ["lint"],
  }), "WSSPEC_COMPILE_GATE_POLICY_UNKNOWN");

  const inconsistent = await fixture();
  inconsistent.pkg.workflow.gates.push({ id: "lint", evidence: "trusted", command: ["wspec", "gate", "lint"] });
  expectCompileError(() => compileWorkflow(inconsistent.pkg, inconsistent.profile, {
    requiredGateIds: ["lint"],
    configuredGateIds: [],
  }), "WSSPEC_COMPILE_GATE_POLICY_INVALID");
});

test("Standard requires every project required Gate in its effective verification set", async () => {
  const { pkg, profile: selected } = await fixture();
  pkg.workflow.gates.push({ id: "lint", evidence: "trusted", command: ["wspec", "gate", "lint"] });
  profile(pkg, "standard").steps.intake = { gates: ["lint"] };
  profile(pkg, "governed").steps.intake = { gates: ["lint"] };

  expectCompileError(() => compileWorkflow(pkg, selected, {
    requiredGateIds: ["test", "lint"],
    configuredGateIds: ["test", "lint"],
  }), "WSSPEC_COMPILE_REQUIRED_GATE_MISSING");
});

test("Governed requires every configured Gate even when all Profiles omit it", async () => {
  const { pkg, profile: selected } = await fixture("feature-delivery", "governed");
  pkg.workflow.gates.push({ id: "lint", evidence: "trusted", command: ["wspec", "gate", "lint"] });

  expectCompileError(() => compileWorkflow(pkg, selected, {
    requiredGateIds: ["test"],
    configuredGateIds: ["test", "lint"],
  }), "WSSPEC_COMPILE_CONFIGURED_GATE_MISSING");
});

test("Gate policy accepts required and configured Gates on effective verification Steps", async () => {
  const { pkg, profile: selected } = await fixture();
  pkg.workflow.gates.push({ id: "lint", evidence: "trusted", command: ["wspec", "gate", "lint"] });
  profile(pkg, "standard").steps["verify-green"]!.gates = ["test", "lint"];
  profile(pkg, "governed").steps["verify-green"]!.gates = ["test", "lint"];

  const compiled = compileWorkflow(pkg, selected, {
    requiredGateIds: ["test", "lint"],
    configuredGateIds: ["test", "lint"],
  });

  assert.deepEqual(compiled.steps.find(({ id }) => id === "verify-green")?.gates, ["test", "lint"]);
});

test("feature delivery cannot disable its Red/Green safety kernel or trusted test Gate", async () => {
  for (const id of ["write-tests", "verify-red", "implement", "verify-green"]) {
    const { pkg, profile: selected } = await fixture();
    Object.assign(profile(pkg, "standard").steps, { [id]: { enabled: false } });
    expectCompileError(() => compileWorkflow(pkg, selected), "WSSPEC_COMPILE_TDD_REQUIRED");
  }

  const gates = await fixture();
  profile(gates.pkg, "standard").steps["verify-green"]!.gates = [];
  expectCompileError(() => compileWorkflow(gates.pkg, gates.profile), "WSSPEC_COMPILE_TDD_REQUIRED");
});

test("feature Red verification cannot bypass write-tests", async () => {
  const { pkg, profile } = await fixture();
  step(pkg, "verify-red").needs = ["plan"];

  expectCompileError(() => compileWorkflow(pkg, profile), "WSSPEC_COMPILE_TDD_REQUIRED");
});

test("Quick cannot disable nested Review Steps", async () => {
  const { pkg, profile: selected } = await fixture("feature-delivery", "quick");
  Object.assign(profile(pkg, "quick").steps, { review: { enabled: false } });

  expectCompileError(() => compileWorkflow(pkg, selected), "WSSPEC_COMPILE_QUICK_PROFILE_INVALID");
});

test("selected Profile identity must match its package map key", async () => {
  const { pkg, profile: selected } = await fixture();
  profile(pkg, "standard").profile.id = "quick";

  expectCompileError(() => compileWorkflow(pkg, selected), "WSSPEC_COMPILE_PROFILE_MISMATCH");
});

test("feature implement must explicitly consume tasks", async () => {
  const { pkg, profile } = await fixture();
  step(pkg, "implement").inputs = [];

  expectCompileError(() => compileWorkflow(pkg, profile), "WSSPEC_COMPILE_PLAN_REQUIRED");
});

test("documentation workflow compiles an immutable narrowed documentation-only Change Policy", async () => {
  const { pkg, profile } = await fixture("documentation-delivery", "standard");
  profile.documentationAllowedPaths = ["docs/guides/**/*.md"];

  const compiled = compileWorkflow(pkg, profile);

  assert.deepEqual(compiled.changePolicy.allowedPaths, ["docs/guides/**/*.md"]);
  assert.match(compiled.changePolicy.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(compiled.changePolicy.kind, "documentation-only");
  assert.equal(Object.isFrozen(compiled.changePolicy.allowedPaths), true);
});

test("documentation Change Policy defaults to five safe path classes", () => {
  const resolved = resolveChangePolicy({
    workflowId: "documentation-delivery",
    policy: { kind: "documentation-only", allowedPaths: [] },
  });

  assert.deepEqual(resolved.allowedPaths, [
    "README*.md",
    "CHANGELOG*.md",
    "docs/**/*.md",
    "docs/**/*.mdx",
    "docs/**/*.txt",
  ]);
});

test("documentation Change Policy rejects empty entries, escapes, absolute and production fallback paths", () => {
  for (const allowedPath of ["", "/docs/readme.md", "../README.md", "docs/../../src/index.ts", "src/**", "**", "package.json"]) {
    expectCompileError(() => resolveChangePolicy({
      workflowId: "documentation-delivery",
      policy: { kind: "documentation-only", allowedPaths: [allowedPath] },
    }), "WSSPEC_CHANGE_POLICY_PATH_INVALID");
  }
});

test("only project documentation policy may narrow, while Profile and Skill scope keys are rejected", () => {
  expectCompileError(() => resolveChangePolicy({
    workflowId: "documentation-delivery",
    policy: { kind: "documentation-only", allowedPaths: ["docs/**/*.md"] },
    documentationAllowedPaths: ["README.md"],
  }), "WSSPEC_CHANGE_POLICY_EXPANSION");

  for (const forbidden of ["profileAllowedPaths", "skillAllowedPaths"] as const) {
    expectCompileError(() => resolveChangePolicy({
      workflowId: "documentation-delivery",
      policy: { kind: "documentation-only", allowedPaths: ["docs/**/*.md"] },
      [forbidden]: ["src/**"],
    } as never), "WSSPEC_CHANGE_POLICY_OVERRIDE_FORBIDDEN");
  }
});

test("documentation glob narrowing rejects broader wildcard placement", () => {
  for (const [parent, child] of [
    ["docs/*-guide.md", "docs/*.md"],
    ["README*-safe.md", "README*.md"],
  ] as const) {
    expectCompileError(() => resolveChangePolicy({
      workflowId: "documentation-delivery",
      policy: { kind: "documentation-only", allowedPaths: [parent] },
      documentationAllowedPaths: [child],
    }), "WSSPEC_CHANGE_POLICY_EXPANSION");
  }
});

test("documentation glob narrowing shares zero-directory globstar semantics", () => {
  const resolved = resolveChangePolicy({
    workflowId: "documentation-delivery",
    policy: { kind: "documentation-only", allowedPaths: ["docs/**/*.md"] },
    documentationAllowedPaths: ["docs/readme.md"],
  });

  assert.deepEqual(resolved.allowedPaths, ["docs/readme.md"]);
});
