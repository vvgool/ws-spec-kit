import { sha256 } from "../domain/digests.js";
import type {
  ArtifactDeclaration,
  ArtifactRequirement,
  CompiledStep,
  CompiledWorkflow,
  ResolvedChangePolicy,
  SecurityClass,
} from "../domain/workflow.js";
import type { ResolvedSkill } from "../registry/skills/types.js";
import type {
  ProfileDefinition,
  WorkflowChangePolicy,
  WorkflowPackage,
  WorkflowStep,
} from "../workflow-package/types.js";

export type { CompiledWorkflow, ResolvedChangePolicy } from "../domain/workflow.js";

export interface CompileProfile {
  id: string;
  skills: ResolvedSkill[];
  documentationAllowedPaths?: string[];
}

export interface ResolveChangePolicyInput {
  workflowId: string;
  policy?: WorkflowChangePolicy;
  documentationAllowedPaths?: readonly string[];
}

interface ExecutorContract {
  securityClass: SecurityClass;
  capability: string;
  authorizationRequired: boolean;
  connector?: string;
  externalSideEffect?: string;
}

interface ExecutorManifest extends ExecutorContract {
  actions?: Readonly<Record<string, ExecutorContract>>;
}

const executors: Readonly<Record<string, ExecutorManifest>> = Object.freeze({
  "agent.execute": Object.freeze({ securityClass: "agent", capability: "agent-execution", authorizationRequired: false }),
  "command.execute": Object.freeze({
    securityClass: "local-write",
    capability: "command-execution",
    authorizationRequired: false,
    actions: Object.freeze({
      "quality.test": Object.freeze({ securityClass: "local-write", capability: "command-execution", authorizationRequired: false }),
      "quality.verify": Object.freeze({ securityClass: "local-write", capability: "command-execution", authorizationRequired: false }),
      "quality.docs.integrity": Object.freeze({ securityClass: "local-read", capability: "command-execution", authorizationRequired: false }),
    }),
  }),
  "connector.execute": Object.freeze({
    securityClass: "external-read",
    capability: "connector-execution",
    authorizationRequired: false,
    actions: Object.freeze({
      "requirement.capture": Object.freeze({ securityClass: "external-read", capability: "connector-execution", connector: "requirement", authorizationRequired: false }),
      "git.commit": Object.freeze({ securityClass: "local-write", capability: "connector-execution", connector: "git", externalSideEffect: "git-commit", authorizationRequired: true }),
      "issue.update": Object.freeze({ securityClass: "external-write", capability: "connector-execution", connector: "issue", externalSideEffect: "issue-update", authorizationRequired: true }),
      "knowledge.publish": Object.freeze({ securityClass: "external-write", capability: "connector-execution", connector: "knowledge", externalSideEffect: "knowledge-publish", authorizationRequired: true }),
      "issue.close": Object.freeze({ securityClass: "external-write", capability: "connector-execution", connector: "issue", externalSideEffect: "issue-close", authorizationRequired: true }),
    }),
  }),
  "control.loop": Object.freeze({ securityClass: "control", capability: "control-flow", authorizationRequired: false }),
  "control.close": Object.freeze({ securityClass: "control", capability: "control-flow", authorizationRequired: false }),
});

const defaultDocumentationPaths = Object.freeze([
  "README*.md",
  "CHANGELOG*.md",
  "docs/**/*.md",
  "docs/**/*.mdx",
  "docs/**/*.txt",
]);

const workflowStepKeys = new Set(["id", "uses", "needs", "when", "retry", "loop", "approval", "inputs", "outputs", "skills", "action", "objective", "expectedOutcome", "until", "maxIterations", "steps"]);
const profileStepKeys = new Set(["enabled", "approval", "artifactLevel", "artifacts", "gates", "maxIterations", "independentReviewActor"]);
const resolvedSkillKeys = new Set(["requestedRef", "ref", "source", "provider", "rootId", "entrypoint", "digest", "candidates", "required", "usedFallback", "primary", "fallback"]);

export class CompileError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, readonly path: string, message: string) {
    super(`${code} ${path}: ${message}`);
    this.name = "CompileError";
  }
}

function fail(code: `WSSPEC_${string}`, path: string, message: string): never {
  throw new CompileError(code, path, message);
}

function record(value: unknown, path: string, keys: ReadonlySet<string>, code: `WSSPEC_${string}`): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, path, "必须是对象。");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !keys.has(key))) fail(code, path, "包含无权覆盖的字段。");
  return source;
}

function validateProfile(profile: ProfileDefinition, workflowId: string, profileId: string, stepIds: ReadonlySet<string>): void {
  record(profile, "/profile", new Set(["version", "profile", "steps", "publishing", "audit"]), "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN");
  const identity = record(profile.profile, "/profile/profile", new Set(["id", "workflow"]), "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN");
  if (identity.workflow !== workflowId || identity.id !== profileId) fail("WSSPEC_COMPILE_PROFILE_MISMATCH", "/profile/profile", "Profile 身份未绑定当前 Workflow 和所选 Profile。");
  record(profile.publishing, "/profile/publishing", new Set(["issueRequired", "knowledgeRequired", "readBackRequired"]), "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN");
  record(profile.audit, "/profile/audit", new Set(["level", "retention", "recordDecisions", "recordApprovals", "recordActors", "recordPublishing"]), "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN");
  for (const [id, overlay] of Object.entries(profile.steps)) {
    if (!stepIds.has(id)) fail("WSSPEC_COMPILE_PROFILE_STEP_UNKNOWN", `/profile/steps/${id}`, "Profile 引用了未知 Step。");
    record(overlay, `/profile/steps/${id}`, profileStepKeys, "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN");
    if (overlay.artifacts !== undefined) {
      for (const [artifact, definition] of Object.entries(overlay.artifacts)) {
        record(definition, `/profile/steps/${id}/artifacts/${artifact}`, new Set(["required", "contentLevel"]), "WSSPEC_COMPILE_PROFILE_OVERRIDE_FORBIDDEN");
      }
    }
  }
}

const profileOrder = ["quick", "standard", "governed"] as const;

function profileSafetyFailure(profileId: string, path: string, message: string): never {
  fail("WSSPEC_COMPILE_PROFILE_SAFETY_DOWNGRADE", `/profiles/${profileId}${path}`, message);
}

function effectiveApproval(step: WorkflowStep, profile: ProfileDefinition): boolean {
  return profile.steps[step.id]?.approval ?? (step.approval === true || step.approval === "required");
}

function effectiveEnabled(step: WorkflowStep, profile: ProfileDefinition): boolean {
  return profile.steps[step.id]?.enabled ?? true;
}

function effectiveIterations(step: WorkflowStep, profile: ProfileDefinition): number | undefined {
  return profile.steps[step.id]?.maxIterations ?? step.maxIterations ?? step.loop?.maxIterations;
}

function isSubset(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function auditLevel(profile: ProfileDefinition): number {
  return profile.audit.level === "complete" ? 1 : 0;
}

function retentionLevel(profile: ProfileDefinition): number {
  return profile.audit.retention === "extended" ? 1 : 0;
}

function contentLevel(value: string | undefined): number {
  if (value === "complete") return 2;
  if (value === "compact") return 1;
  return 0;
}

function validateProfileSafety(packageRef: string, workflowId: string, sourceSteps: readonly WorkflowStep[], profiles: ReadonlyMap<string, ProfileDefinition>): void {
  for (const [profileId, profile] of profiles) {
    for (const step of sourceSteps) {
      const overlay = profile.steps[step.id];
      const executor = executorContractFor(step, `/steps/${step.id}`);
      const baseApproval = step.approval === true || step.approval === "required";
      if (executor.authorizationRequired && baseApproval && overlay?.approval === false) {
        profileSafetyFailure(profileId, `/steps/${step.id}/approval`, "Profile 不能关闭受保护动作的基础审批。");
      }
    }

    const review = sourceSteps.find(({ id }) => id === "review-fix");
    if (review !== undefined) {
      const baseIterations = review.maxIterations ?? review.loop?.maxIterations;
      const iterations = effectiveIterations(review, profile);
      if (profileId === "quick" && iterations !== 1) profileSafetyFailure(profileId, "/steps/review-fix/maxIterations", "Quick Review-Fix 必须限制为 1 轮。");
      if ((profileId === "standard" || profileId === "governed") && baseIterations !== undefined && (iterations === undefined || iterations < baseIterations)) {
        profileSafetyFailure(profileId, "/steps/review-fix/maxIterations", "Standard/Governed 不能降低基础 Review-Fix 轮数。");
      }
      if (profileId === "governed" && profile.steps[review.id]?.independentReviewActor !== true) {
        profileSafetyFailure(profileId, "/steps/review-fix/independentReviewActor", "Governed 必须要求独立 Review Actor。");
      }
    }
  }

  const ordered = profileOrder.flatMap((id) => {
    const profile = profiles.get(id);
    return profile === undefined ? [] : [{ id, profile }];
  });
  for (let index = 1; index < ordered.length; index += 1) {
    const lower = ordered[index - 1]!;
    const higher = ordered[index]!;
    for (const step of sourceSteps) {
      if (effectiveEnabled(step, lower.profile) && !effectiveEnabled(step, higher.profile)) profileSafetyFailure(higher.id, `/steps/${step.id}/enabled`, "高强度 Profile 不能禁用低强度 Profile 已启用的 Step。");
      if (effectiveApproval(step, lower.profile) && !effectiveApproval(step, higher.profile)) profileSafetyFailure(higher.id, `/steps/${step.id}/approval`, "高强度 Profile 不能降低审批要求。");
      const lowerIterations = effectiveIterations(step, lower.profile);
      const higherIterations = effectiveIterations(step, higher.profile);
      if (lowerIterations !== undefined && (higherIterations === undefined || higherIterations < lowerIterations)) profileSafetyFailure(higher.id, `/steps/${step.id}/maxIterations`, "高强度 Profile 不能降低循环上限。");
      if (lower.profile.steps[step.id]?.independentReviewActor === true && higher.profile.steps[step.id]?.independentReviewActor !== true) profileSafetyFailure(higher.id, `/steps/${step.id}/independentReviewActor`, "高强度 Profile 不能关闭独立执行主体要求。");
      if (!isSubset(lower.profile.steps[step.id]?.gates ?? [], higher.profile.steps[step.id]?.gates ?? [])) profileSafetyFailure(higher.id, `/steps/${step.id}/gates`, "高强度 Profile 必须保留低强度 Profile 的 Gate。");
      for (const artifact of step.outputs ?? []) {
        const lowerArtifact = lower.profile.steps[step.id]?.artifacts?.[artifact];
        const higherArtifact = higher.profile.steps[step.id]?.artifacts?.[artifact];
        if ((lowerArtifact?.required ?? true) && !(higherArtifact?.required ?? true)) profileSafetyFailure(higher.id, `/steps/${step.id}/artifacts/${artifact}/required`, "高强度 Profile 不能降低 Artifact 必需性。");
        if (contentLevel(lowerArtifact?.contentLevel) > contentLevel(higherArtifact?.contentLevel)) profileSafetyFailure(higher.id, `/steps/${step.id}/artifacts/${artifact}/contentLevel`, "高强度 Profile 不能降低 Artifact 内容级别。");
      }
    }
    for (const field of ["issueRequired", "knowledgeRequired", "readBackRequired"] as const) {
      if ((lower.profile.publishing[field] ?? false) && !(higher.profile.publishing[field] ?? false)) profileSafetyFailure(higher.id, `/publishing/${field}`, "高强度 Profile 不能降低发布要求。");
    }
    if (auditLevel(lower.profile) > auditLevel(higher.profile)) profileSafetyFailure(higher.id, "/audit/level", "高强度 Profile 不能降低审计级别。");
    if (retentionLevel(lower.profile) > retentionLevel(higher.profile)) profileSafetyFailure(higher.id, "/audit/retention", "高强度 Profile 不能降低审计保留要求。");
    for (const field of ["recordDecisions", "recordApprovals", "recordActors", "recordPublishing"] as const) {
      if ((lower.profile.audit[field] ?? false) && !(higher.profile.audit[field] ?? false)) profileSafetyFailure(higher.id, `/audit/${field}`, "高强度 Profile 不能关闭审计记录。");
    }
  }
  validateBuiltinProfileMatrix(packageRef, workflowId, sourceSteps, profiles);
}

function validateBuiltinProfileMatrix(packageRef: string, workflowId: string, sourceSteps: readonly WorkflowStep[], profiles: ReadonlyMap<string, ProfileDefinition>): void {
  if (packageRef !== `builtin://workflows/${workflowId}` || (workflowId !== "feature-delivery" && workflowId !== "documentation-delivery")) return;
  const byId = new Map(sourceSteps.map((step) => [step.id, step]));
  const profile = (id: "quick" | "standard" | "governed"): ProfileDefinition => {
    const definition = profiles.get(id);
    if (definition === undefined) profileSafetyFailure(id, "", "Builtin Workflow 必须提供 quick、standard 和 governed Profile。");
    return definition;
  };
  const step = (id: string): WorkflowStep => {
    const definition = byId.get(id);
    if (definition === undefined) profileSafetyFailure("standard", `/steps/${id}`, "Builtin Workflow 缺少规范 Step。");
    return definition;
  };
  const requireEnabled = (profileId: "quick" | "standard" | "governed", stepId: string): void => {
    if (!effectiveEnabled(step(stepId), profile(profileId))) profileSafetyFailure(profileId, `/steps/${stepId}/enabled`, "Builtin Profile 不能关闭规范必需 Step。");
  };
  const requireApproval = (profileId: "standard" | "governed", stepId: string): void => {
    if (!effectiveApproval(step(stepId), profile(profileId))) profileSafetyFailure(profileId, `/steps/${stepId}/approval`, "Builtin Profile 缺少规范审批。");
  };
  const requireArtifact = (profileId: "quick" | "standard" | "governed", stepId: string, artifact: string, expectedContentLevel: "compact" | "complete"): void => {
    const artifactOverlay = profile(profileId).steps[stepId]?.artifacts?.[artifact];
    if (artifactOverlay?.required !== true || artifactOverlay.contentLevel !== expectedContentLevel) profileSafetyFailure(profileId, `/steps/${stepId}/artifacts/${artifact}`, `Builtin Profile 必须声明 ${expectedContentLevel} 且必需的 ${artifact}。`);
  };
  const requireGovernedPolicy = (): void => {
    const governed = profile("governed");
    if (!governed.publishing.issueRequired || !governed.publishing.knowledgeRequired || governed.publishing.readBackRequired !== true) profileSafetyFailure("governed", "/publishing", "Governed Builtin Profile 必须要求 Issue、Knowledge 和发布回读。");
    if (governed.audit.level !== "complete" || governed.audit.retention !== "extended") profileSafetyFailure("governed", "/audit", "Governed Builtin Profile 必须使用 complete/extended 审计。");
    for (const field of ["recordDecisions", "recordApprovals", "recordActors", "recordPublishing"] as const) {
      if (governed.audit[field] !== true) profileSafetyFailure("governed", `/audit/${field}`, "Governed Builtin Profile 必须记录完整治理证据。");
    }
    if (governed.steps["review-fix"]?.independentReviewActor !== true) profileSafetyFailure("governed", "/steps/review-fix/independentReviewActor", "Governed Builtin Profile 必须要求独立 Review Actor。");
  };
  for (const profileId of ["standard", "governed"] as const) {
    if (effectiveIterations(step("review-fix"), profile(profileId)) !== 5) profileSafetyFailure(profileId, "/steps/review-fix/maxIterations", "Standard/Governed Builtin Profile 的 Review-Fix 上限必须为 5 轮。");
  }

  if (workflowId === "feature-delivery") {
    if (effectiveEnabled(step("design"), profile("quick"))) profileSafetyFailure("quick", "/steps/design/enabled", "Feature Quick 必须跳过独立 design。");
    for (const id of sourceSteps.map(({ id }) => id).filter((id) => id !== "design")) requireEnabled("quick", id);
    for (const profileId of ["standard", "governed"] as const) for (const { id } of sourceSteps) requireEnabled(profileId, id);
    requireArtifact("quick", "clarify", "specification", "compact");
    requireArtifact("quick", "plan", "tasks", "compact");
    requireApproval("standard", "clarify");
    requireApproval("standard", "design");
    requireArtifact("standard", "clarify", "specification", "complete");
    requireArtifact("standard", "design", "design", "complete");
    requireArtifact("standard", "plan", "tasks", "complete");
    for (const id of ["clarify", "design", "plan"]) requireApproval("governed", id);
    requireArtifact("governed", "clarify", "specification", "complete");
    requireArtifact("governed", "design", "design", "complete");
    requireArtifact("governed", "plan", "tasks", "complete");
  } else {
    for (const id of ["intake", "explore", "clarify", "plan", "edit-document", "verify-document", "review-fix", "commit", "close"]) requireEnabled("quick", id);
    for (const profileId of ["standard", "governed"] as const) for (const { id } of sourceSteps) requireEnabled(profileId, id);
    requireArtifact("quick", "clarify", "specification", "compact");
    requireArtifact("quick", "plan", "tasks", "compact");
    requireArtifact("standard", "clarify", "specification", "complete");
    requireArtifact("standard", "plan", "tasks", "complete");
    for (const id of ["clarify", "plan"]) requireApproval("governed", id);
    requireArtifact("governed", "clarify", "specification", "complete");
    requireArtifact("governed", "plan", "tasks", "complete");
  }
  requireGovernedPolicy();
}

function validateStepShape(step: WorkflowStep, path: string): void {
  if (Object.hasOwn(step, "securityClass")) fail("WSSPEC_COMPILE_SECURITY_OVERRIDE", `${path}/securityClass`, "安全类别只能来自 Executor Registry。");
  record(step, path, workflowStepKeys, "WSSPEC_COMPILE_STEP_INVALID");
  for (const [index, child] of (step.steps ?? []).entries()) validateStepShape(child, `${path}/steps/${index}`);
}

function executorContractFor(step: Pick<WorkflowStep, "uses" | "action">, path: string): ExecutorContract {
  const manifest = executors[step.uses];
  if (manifest === undefined) fail("WSSPEC_EXECUTOR_NOT_FOUND", `${path}/uses`, `未注册 Executor ${step.uses}。`);
  if (manifest.actions === undefined) {
    if (step.action !== undefined) fail("WSSPEC_EXECUTOR_ACTION_NOT_FOUND", `${path}/action`, `${step.uses} 不接受 action。`);
    return manifest;
  }
  if (step.action === undefined || manifest.actions[step.action] === undefined) {
    fail("WSSPEC_EXECUTOR_ACTION_NOT_FOUND", `${path}/action`, `${step.uses} 未注册 action ${step.action ?? "<missing>"}。`);
  }
  return manifest.actions[step.action]!;
}

function normalizeInput(input: NonNullable<WorkflowStep["inputs"]>[number]): ArtifactRequirement {
  return typeof input === "string"
    ? { artifact: input, required: true }
    : { artifact: input.artifact, required: input.required ?? true };
}

function validateResolvedSkill(skill: ResolvedSkill, index: number): void {
  record(skill, `/resolvedSkills/${index}`, resolvedSkillKeys, "WSSPEC_COMPILE_SKILL_POLICY_OVERRIDE");
}

function resolveStepSkills(step: WorkflowStep, available: readonly ResolvedSkill[], path: string): ResolvedSkill[] {
  const result: ResolvedSkill[] = [];
  for (const [bindingIndex, binding] of (step.skills ?? []).entries()) {
    const matches = available.filter(({ requestedRef }) => requestedRef === binding.ref);
    if (matches.length > 1) fail("WSSPEC_COMPILE_SKILL_AMBIGUOUS", `${path}/skills/${bindingIndex}`, `Skill ${binding.ref} 有多个解析结果。`);
    const resolved = matches[0];
    const required = binding.required ?? true;
    if (resolved === undefined) {
      if (required) fail("WSSPEC_COMPILE_REQUIRED_SKILL_MISSING", `${path}/skills/${bindingIndex}`, `缺少必需 Skill ${binding.ref}。`);
      continue;
    }
    if (resolved.required !== required) fail("WSSPEC_COMPILE_SKILL_MISMATCH", `${path}/skills/${bindingIndex}`, `Skill ${binding.ref} 的 required 状态与绑定不一致。`);
    result.push(resolved);
  }
  return result;
}

function compileStep(step: WorkflowStep, overlays: Readonly<Record<string, ProfileDefinition["steps"][string]>>, availableSkills: readonly ResolvedSkill[], path: string): CompiledStep {
  const overlay = overlays[step.id];
  const executor = executorContractFor(step, path);
  const declaredOutputs = new Set(step.outputs ?? []);
  for (const artifact of Object.keys(overlay?.artifacts ?? {})) {
    if (!declaredOutputs.has(artifact)) fail("WSSPEC_COMPILE_PROFILE_ARTIFACT_UNKNOWN", `${path}/outputs/${artifact}`, "Profile 引用了 Step 未声明的输出。");
  }
  const outputs: ArtifactDeclaration[] = (step.outputs ?? []).map((artifact) => {
    const artifactOverlay = overlay?.artifacts?.[artifact];
    return {
      artifact,
      required: artifactOverlay?.required ?? true,
      ...(artifactOverlay?.contentLevel === undefined ? {} : { contentLevel: artifactOverlay.contentLevel }),
    };
  });
  const compiled: CompiledStep = {
    id: step.id,
    uses: step.uses,
    securityClass: executor.securityClass,
    needs: [...(step.needs ?? [])],
    enabled: overlay?.enabled ?? true,
    skills: resolveStepSkills(step, availableSkills, path),
    inputs: (step.inputs ?? []).map(normalizeInput),
    outputs,
    gates: [...(overlay?.gates ?? [])],
    approval: overlay?.approval ?? (step.approval === true || step.approval === "required"),
    authorizationRequired: executor.authorizationRequired,
    steps: (step.steps ?? []).map((child, index) => compileStep(child, overlays, availableSkills, `${path}/steps/${index}`)),
  };
  if (overlay?.artifactLevel !== undefined) compiled.artifactLevel = overlay.artifactLevel;
  if (step.action !== undefined) compiled.action = step.action;
  if (step.objective !== undefined) compiled.objective = step.objective;
  if (step.expectedOutcome !== undefined) compiled.expectedOutcome = step.expectedOutcome;
  if (step.when !== undefined) compiled.when = step.when;
  const until = step.until ?? step.loop?.until;
  if (until !== undefined) compiled.until = until;
  if (step.retry !== undefined) compiled.retry = { ...step.retry };
  const maxIterations = overlay?.maxIterations ?? step.maxIterations ?? step.loop?.maxIterations;
  if (maxIterations !== undefined) compiled.maxIterations = maxIterations;
  if (overlay?.independentReviewActor !== undefined) compiled.independentReviewActor = overlay.independentReviewActor;
  return compiled;
}

function flatten<T extends { steps: T[] }>(steps: readonly T[]): T[] {
  return steps.flatMap((step) => [step, ...flatten(step.steps)]);
}

function topologicalOrder(steps: readonly CompiledStep[], byId: ReadonlyMap<string, CompiledStep>, path: string): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) fail("WSSPEC_COMPILE_CYCLE", `${path}/${id}/needs`, "Workflow DAG 包含循环依赖。");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.needs) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };
  for (const step of steps) visit(step.id);
  return order;
}

function validateDag(steps: readonly CompiledStep[], path: string): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const current of steps) {
    for (const dependency of current.needs) if (!byId.has(dependency)) fail("WSSPEC_COMPILE_UNKNOWN_DEPENDENCY", `${path}/${current.id}/needs/${dependency}`, `未知依赖 ${dependency}。`);
    validateDag(current.steps, `${path}/${current.id}/steps`);
  }
  return topologicalOrder(steps, byId, path);
}

function dependencyClosure(id: string, byId: ReadonlyMap<string, CompiledStep>): Set<string> {
  const result = new Set<string>();
  const visit = (candidate: string): void => {
    for (const dependency of byId.get(candidate)?.needs ?? []) if (!result.has(dependency)) { result.add(dependency); visit(dependency); }
  };
  visit(id);
  return result;
}

function producedArtifacts(step: CompiledStep): Array<{ artifact: string; enabled: boolean }> {
  return [
    ...step.outputs.map(({ artifact }) => ({ artifact, enabled: step.enabled })),
    ...step.steps.flatMap((child) => producedArtifacts(child).map((output) => ({ ...output, enabled: step.enabled && output.enabled }))),
  ];
}

function validateArtifactDependencies(steps: readonly CompiledStep[], path: string): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const current of steps) {
    if (!current.enabled) continue;
    const ancestors = dependencyClosure(current.id, byId);
    const produced = [...ancestors].flatMap((id) => producedArtifacts(byId.get(id)!));
    for (const input of current.inputs) {
      if (!input.required) continue;
      const candidates = produced.filter(({ artifact }) => artifact === input.artifact);
      if (candidates.some(({ enabled }) => enabled)) continue;
      if (candidates.length > 0) fail("WSSPEC_COMPILE_DISABLED_OUTPUT_REQUIRED", `${path}/${current.id}/inputs/${input.artifact}`, "启用 Step 消费了已跳过 Step 的必需输出。");
      fail("WSSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER", `${path}/${current.id}/inputs/${input.artifact}`, "必需输入没有依赖闭包内的生产者。");
    }
    validateArtifactDependencies(current.steps, `${path}/${current.id}/steps`);
  }
}

function expressionReference(expression: string, path: string): { root: string; property: string; literal?: string } {
  const match = /^\$\{\s*([a-z][a-z0-9-]*)\.([a-z][a-zA-Z0-9.-]*)(?:\s*(==|!=)\s*(true|false|null|-?[0-9]+(?:\.[0-9]+)?|"[^"\\]*"|'[^'\\]*'))?\s*\}$/.exec(expression);
  if (match === null) fail("WSSPEC_COMPILE_EXPRESSION_INVALID", path, "表达式不属于 Workflow Language v1 有限语法。");
  return { root: match[1]!, property: match[2]!, ...(match[4] === undefined ? {} : { literal: match[4] }) };
}

type ExpressionValueType = "boolean" | "number" | "string" | "null";

function literalType(literal: string): ExpressionValueType {
  if (literal === "true" || literal === "false") return "boolean";
  if (literal === "null") return "null";
  if (literal.startsWith('"') || literal.startsWith("'")) return "string";
  return "number";
}

function artifactPropertyType(root: string, property: string): ExpressionValueType | undefined {
  if (property === "exists") return "boolean";
  if (property === "status" || property === "digest") return "string";
  if (root === "review-result" && property === "approved") return "boolean";
  return undefined;
}

function effectiveOutputs(step: CompiledStep, parentEnabled: boolean): Set<string> {
  const enabled = parentEnabled && step.enabled;
  if (!enabled) return new Set();
  return new Set([
    ...step.outputs.map(({ artifact }) => artifact),
    ...step.steps.flatMap((child) => [...effectiveOutputs(child, enabled)]),
  ]);
}

function addAll(target: Set<string>, values: Iterable<string>): void {
  for (const value of values) target.add(value);
}

function validateExpressions(sourceSteps: readonly WorkflowStep[], compiledSteps: readonly CompiledStep[]): void {
  const declaredOutputs = new Set(flatten(compiledSteps).flatMap((step) => step.outputs.map(({ artifact }) => artifact)));
  const validate = (expression: string, path: string, available: ReadonlySet<string>): void => {
    const reference = expressionReference(expression, path);
    let valueType: ExpressionValueType | undefined;
    if (reference.root === "bindings") {
      if (!/^(?:issue|knowledge)\.exists$/.test(reference.property)) fail("WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNKNOWN", path, "表达式引用了未知 Binding 状态。");
      valueType = "boolean";
    } else {
      if (!declaredOutputs.has(reference.root)) fail("WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNKNOWN", path, `表达式引用了未声明输出 ${reference.root}。`);
      if (!available.has(reference.root)) fail("WSSPEC_COMPILE_EXPRESSION_REFERENCE_UNAVAILABLE", path, `表达式引用了当前 Step 不可达或未启用的输出 ${reference.root}。`);
      valueType = artifactPropertyType(reference.root, reference.property);
      if (valueType === undefined) fail("WSSPEC_COMPILE_EXPRESSION_PROPERTY_UNKNOWN", path, `输出 ${reference.root} 没有属性 ${reference.property}。`);
    }
    if (reference.literal === undefined) {
      if (valueType !== "boolean") fail("WSSPEC_COMPILE_EXPRESSION_TYPE_MISMATCH", path, "无比较操作的表达式必须解析为布尔值。");
    } else if (literalType(reference.literal) !== valueType) {
      fail("WSSPEC_COMPILE_EXPRESSION_TYPE_MISMATCH", path, "表达式属性与比较值类型不匹配。");
    }
  };

  const visit = (
    sources: readonly WorkflowStep[],
    compiled: readonly CompiledStep[],
    path: string,
    inherited: ReadonlySet<string>,
    nested: boolean,
    parentEnabled: boolean,
  ): void => {
    const byId = new Map(compiled.map((step) => [step.id, step]));
    const preceding = new Set<string>();
    for (const [index, step] of sources.entries()) {
      const current = compiled[index]!;
      const stepPath = `${path}/${index}`;
      const available = new Set(inherited);
      if (nested) addAll(available, preceding);
      for (const dependency of dependencyClosure(current.id, byId)) addAll(available, effectiveOutputs(byId.get(dependency)!, parentEnabled));
      if (step.when !== undefined) validate(step.when, `${stepPath}/when`, available);
      const untilAvailable = new Set(available);
      for (const child of current.steps) addAll(untilAvailable, effectiveOutputs(child, parentEnabled && current.enabled));
      if (step.until !== undefined) validate(step.until, `${stepPath}/until`, untilAvailable);
      if (step.loop?.until !== undefined) validate(step.loop.until, `${stepPath}/loop/until`, untilAvailable);
      visit(step.steps ?? [], current.steps, `${stepPath}/steps`, available, true, parentEnabled && current.enabled);
      if (nested) addAll(preceding, effectiveOutputs(current, parentEnabled));
    }
  };
  visit(sourceSteps, compiledSteps, "/steps", new Set(), false, true);
}

function validateGates(workflow: WorkflowPackage["workflow"], steps: readonly CompiledStep[]): void {
  const gates = new Map(workflow.gates.map((gate) => [gate.id, gate]));
  if (gates.size !== workflow.gates.length) fail("WSSPEC_COMPILE_DUPLICATE_GATE", "/gates", "Gate ID 必须唯一。");
  for (const step of flatten(steps)) {
    for (const gate of step.gates) if (!gates.has(gate)) fail("WSSPEC_COMPILE_UNKNOWN_GATE", `/steps/${step.id}/gates/${gate}`, "Profile 引用了未知 Gate。");
  }
}

function validateManifestDeclarations(pkg: WorkflowPackage, steps: readonly CompiledStep[]): void {
  const capabilities = new Set(pkg.manifest.capabilities);
  const connectors = new Set(pkg.manifest.connectors);
  const sideEffects = new Set(pkg.manifest.externalSideEffects);
  for (const step of flatten(steps)) {
    const contract = executorContractFor(step, `/steps/${step.id}`);
    if (!capabilities.has(contract.capability)) fail("WSSPEC_COMPILE_MANIFEST_CAPABILITY_MISSING", `/manifest/capabilities/${contract.capability}`, `Manifest 未声明 Step ${step.id} 使用的能力 ${contract.capability}。`);
    if (contract.connector !== undefined && !connectors.has(contract.connector)) fail("WSSPEC_COMPILE_MANIFEST_CONNECTOR_MISSING", `/manifest/connectors/${contract.connector}`, `Manifest 未声明 Step ${step.id} 使用的 Connector ${contract.connector}。`);
    if (contract.externalSideEffect !== undefined && !sideEffects.has(contract.externalSideEffect)) fail("WSSPEC_COMPILE_MANIFEST_SIDE_EFFECT_MISSING", `/manifest/externalSideEffects/${contract.externalSideEffect}`, `Manifest 未声明 Step ${step.id} 的外部副作用 ${contract.externalSideEffect}。`);
  }
}

function hasAncestor(stepId: string, ancestorId: string, byId: ReadonlyMap<string, CompiledStep>): boolean {
  return dependencyClosure(stepId, byId).has(ancestorId);
}

function validateFeatureSafety(workflow: WorkflowPackage["workflow"], packageRef: string, profileId: string, steps: readonly CompiledStep[], byId: ReadonlyMap<string, CompiledStep>): void {
  const safetyIds = ["write-tests", "verify-red", "implement", "verify-green"];
  const safetySteps = new Map(safetyIds.map((id) => [id, byId.get(id)]));
  if ([...safetySteps.values()].some((step) => step === undefined || !step.enabled)) fail("WSSPEC_COMPILE_TDD_REQUIRED", "/steps", "功能 Workflow 不能关闭 Red/Green 安全内核。");
  const writeTests = safetySteps.get("write-tests")!;
  const verifyRed = safetySteps.get("verify-red")!;
  const implement = safetySteps.get("implement")!;
  const verifyGreen = safetySteps.get("verify-green")!;
  if (writeTests.uses !== "agent.execute" || !writeTests.skills.some(({ requestedRef }) => requestedRef === "builtin://skills/tdd-implementation")) fail("WSSPEC_COMPILE_TDD_REQUIRED", "/steps/write-tests", "write-tests 必须绑定 TDD Skill。");
  if (!hasAncestor("verify-red", "write-tests", byId) || verifyRed.uses !== "command.execute" || verifyRed.action !== "quality.test" || verifyRed.expectedOutcome !== "test-failure" || !verifyRed.outputs.some(({ artifact, required }) => artifact === "red-evidence" && required)) fail("WSSPEC_COMPILE_TDD_REQUIRED", "/steps/verify-red", "verify-red 必须在 write-tests 后形成可信 Red Evidence。");
  if (!implement.inputs.some(({ artifact, required }) => artifact === "tasks" && required)) fail("WSSPEC_COMPILE_PLAN_REQUIRED", "/steps/implement/inputs", "implement 必须显式消费 tasks。");
  if (!hasAncestor("implement", "verify-red", byId) || implement.uses !== "agent.execute" || !implement.skills.some(({ requestedRef }) => requestedRef === "builtin://skills/tdd-implementation")) fail("WSSPEC_COMPILE_TDD_REQUIRED", "/steps/implement", "implement 必须位于有效 Red Evidence 之后并绑定 TDD Skill。");
  if (!hasAncestor("verify-green", "implement", byId) || verifyGreen.uses !== "command.execute" || verifyGreen.action !== "quality.test" || verifyGreen.expectedOutcome !== "success" || !verifyGreen.inputs.some(({ artifact, required }) => artifact === "red-evidence" && required) || !verifyGreen.outputs.some(({ artifact, required }) => artifact === "tdd-evidence" && required) || !verifyGreen.gates.includes("test")) fail("WSSPEC_COMPILE_TDD_REQUIRED", "/steps/verify-green", "verify-green 必须绑定 Red Evidence、可信 test Gate 和 TDD Evidence。");
  const gates = new Map(workflow.gates.map((gate) => [gate.id, gate]));
  for (const gate of ["test", "verify-red", "verify-green"]) if (gates.get(gate)?.evidence !== "trusted") fail("WSSPEC_COMPILE_TDD_REQUIRED", `/gates/${gate}`, "功能 Workflow 缺少可信 Red/Green Gate。");
  if (profileId === "quick" && packageRef === "builtin://workflows/feature-delivery") {
    const disabled = flatten(steps).filter(({ enabled }) => !enabled).map(({ id }) => id);
    if (disabled.some((id) => id !== "design") || byId.get("plan")?.enabled !== true || byId.get("plan")?.artifactLevel !== "compact") fail("WSSPEC_COMPILE_QUICK_PROFILE_INVALID", "/profile/steps", "Quick 只能跳过 design，且必须保留 compact plan。");
  }
}

function validateDocumentationSafety(workflow: WorkflowPackage["workflow"], steps: readonly CompiledStep[], byId: ReadonlyMap<string, CompiledStep>): void {
  const verify = byId.get("verify-document");
  const gate = workflow.gates.find(({ id }) => id === "docs.integrity");
  if (verify === undefined || !verify.enabled || !verify.gates.includes("docs.integrity") || gate?.evidence !== "trusted") fail("WSSPEC_COMPILE_DOCUMENTATION_GATE_REQUIRED", "/steps/verify-document", "文档 Workflow 必须包含可信 docs.integrity Gate。");
  if (steps.some(({ id }) => ["write-tests", "verify-red", "implement", "verify-green"].includes(id))) fail("WSSPEC_COMPILE_DOCUMENTATION_TDD_FORBIDDEN", "/steps", "文档 Workflow 不得伪造功能 TDD Cycle。");
}

function validRelativePathPattern(pattern: string): boolean {
  if (pattern === "" || pattern.includes("\0") || pattern.includes("\\") || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) return false;
  const segments = pattern.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

type DocumentationPathClass = "readme" | "changelog" | "docs-md" | "docs-mdx" | "docs-txt";

function documentationPathClass(pattern: string): DocumentationPathClass | undefined {
  if (/^README[^/]*\.md$/i.test(pattern)) return "readme";
  if (/^CHANGELOG[^/]*\.md$/i.test(pattern)) return "changelog";
  if (/^docs\/.+\.md$/i.test(pattern)) return "docs-md";
  if (/^docs\/.+\.mdx$/i.test(pattern)) return "docs-mdx";
  if (/^docs\/.+\.txt$/i.test(pattern)) return "docs-txt";
  return undefined;
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
  return new RegExp(`^${source}$`, "i");
}

function containsPattern(parent: string, child: string): boolean {
  if (parent === child) return true;
  if (documentationPathClass(parent) !== documentationPathClass(child)) return false;
  if (defaultDocumentationPaths.includes(parent)) return true;
  if (!/[?*]/.test(child)) return glob(parent).test(child);
  return false;
}

function validateDocumentationPaths(paths: readonly string[], path: string): string[] {
  const result = [...new Set(paths)];
  for (const [index, allowed] of result.entries()) {
    if (!validRelativePathPattern(allowed) || documentationPathClass(allowed) === undefined) fail("WSSPEC_CHANGE_POLICY_PATH_INVALID", `${path}/${index}`, "文档路径必须位于五类默认文档范围内。");
  }
  return result;
}

export function resolveChangePolicy(input: ResolveChangePolicyInput): ResolvedChangePolicy {
  record(input, "/changePolicy", new Set(["workflowId", "policy", "documentationAllowedPaths"]), "WSSPEC_CHANGE_POLICY_OVERRIDE_FORBIDDEN");
  const kind = input.policy?.kind ?? (input.workflowId === "documentation-delivery" ? "documentation-only" : "feature");
  let allowedPaths: string[];
  if (kind === "documentation-only") {
    const declared = input.policy?.allowedPaths ?? [];
    const upperBound = validateDocumentationPaths(declared.length === 0 ? defaultDocumentationPaths : declared, "/changePolicy/allowedPaths");
    for (const candidate of upperBound) if (!defaultDocumentationPaths.some((parent) => containsPattern(parent, candidate))) fail("WSSPEC_CHANGE_POLICY_EXPANSION", "/changePolicy/allowedPaths", "Workflow 文档路径扩大了内置上界。");
    if (input.documentationAllowedPaths === undefined) allowedPaths = upperBound;
    else {
      if (input.documentationAllowedPaths.length === 0) fail("WSSPEC_CHANGE_POLICY_PATH_INVALID", "/changePolicy/documentationAllowedPaths", "项目文档路径不能为空。");
      const narrowed = validateDocumentationPaths(input.documentationAllowedPaths, "/changePolicy/documentationAllowedPaths");
      for (const candidate of narrowed) if (!upperBound.some((parent) => containsPattern(parent, candidate))) fail("WSSPEC_CHANGE_POLICY_EXPANSION", "/changePolicy/documentationAllowedPaths", "项目文档路径只能收窄 Workflow 范围。");
      allowedPaths = narrowed;
    }
  } else {
    if (input.documentationAllowedPaths !== undefined) fail("WSSPEC_CHANGE_POLICY_OVERRIDE_FORBIDDEN", "/changePolicy/documentationAllowedPaths", "功能 Workflow 不接受文档路径策略。");
    allowedPaths = [...new Set(input.policy?.allowedPaths ?? ["**"])].sort();
    if (allowedPaths.length === 0 || allowedPaths.some((allowed) => !validRelativePathPattern(allowed))) fail("WSSPEC_CHANGE_POLICY_PATH_INVALID", "/changePolicy/allowedPaths", "功能修改路径必须是仓库相对 glob。");
  }
  const frozenPaths = Object.freeze([...allowedPaths]) as unknown as string[];
  return Object.freeze({ kind, allowedPaths: frozenPaths, digest: sha256(`${JSON.stringify({ version: 1, kind, allowedPaths })}\n`) });
}

export function compileWorkflow(pkg: WorkflowPackage, selected: CompileProfile): CompiledWorkflow {
  for (const [index, skill] of selected.skills.entries()) validateResolvedSkill(skill, index);
  for (const [index, step] of pkg.workflow.steps.entries()) validateStepShape(step, `/steps/${index}`);
  const sourceSteps = pkg.workflow.steps.flatMap((step) => [step, ...allSourceSteps(step.steps ?? [])]);
  const sourceIds = new Set<string>();
  for (const step of sourceSteps) {
    if (sourceIds.has(step.id)) fail("WSSPEC_COMPILE_DUPLICATE_STEP", `/steps/${step.id}`, `Step ID ${step.id} 重复。`);
    sourceIds.add(step.id);
  }
  for (const [profileId, definition] of pkg.profiles) validateProfile(definition, pkg.workflow.workflow.id, profileId, sourceIds);
  const definition = pkg.profiles.get(selected.id);
  if (definition === undefined) fail("WSSPEC_COMPILE_PROFILE_NOT_FOUND", `/profiles/${selected.id}`, "Workflow Package 不包含所选 Profile。");
  const changePolicy = resolveChangePolicy({ workflowId: pkg.workflow.workflow.id, ...(pkg.workflow.changePolicy === undefined ? {} : { policy: pkg.workflow.changePolicy }), ...(selected.documentationAllowedPaths === undefined ? {} : { documentationAllowedPaths: selected.documentationAllowedPaths }) });
  let selectedSteps: CompiledStep[] | undefined;
  let selectedOrder: string[] | undefined;
  let manifestValidated = false;
  const profilesToCompile: Array<[string, ProfileDefinition]> = [
    [selected.id, definition],
    ...[...pkg.profiles].filter(([profileId]) => profileId !== selected.id),
  ];
  for (const [profileId, profile] of profilesToCompile) {
    const compiledSteps = pkg.workflow.steps.map((step, index) => compileStep(step, profile.steps, selected.skills, `/steps/${index}`));
    const byId = new Map(compiledSteps.map((step) => [step.id, step]));
    const order = validateDag(compiledSteps, "/steps");
    validateGates(pkg.workflow, compiledSteps);
    if (!manifestValidated) {
      validateManifestDeclarations(pkg, compiledSteps);
      manifestValidated = true;
    }
    if (changePolicy.kind === "feature") validateFeatureSafety(pkg.workflow, pkg.ref, profileId, compiledSteps, byId);
    else validateDocumentationSafety(pkg.workflow, compiledSteps, byId);
    validateExpressions(pkg.workflow.steps, compiledSteps);
    validateArtifactDependencies(compiledSteps, "/steps");
    if (profileId === selected.id) {
      selectedSteps = compiledSteps;
      selectedOrder = order;
    }
  }
  validateProfileSafety(pkg.ref, pkg.workflow.workflow.id, sourceSteps, pkg.profiles);
  if (selectedSteps === undefined || selectedOrder === undefined) fail("WSSPEC_COMPILE_PROFILE_NOT_FOUND", `/profiles/${selected.id}`, "Workflow Package 不包含所选 Profile。");
  return {
    version: 1,
    id: pkg.workflow.workflow.id,
    packageRef: pkg.ref,
    packageDigest: pkg.contentDigest,
    profile: { id: selected.id, publishing: structuredClone(definition.publishing), audit: structuredClone(definition.audit) },
    steps: selectedSteps,
    order: selectedOrder,
    changePolicy,
  };
}

function allSourceSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [step, ...allSourceSteps(step.steps ?? [])]);
}
