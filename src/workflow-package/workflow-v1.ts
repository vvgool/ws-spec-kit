import type {
  ProfileArtifactOverlay,
  ProfileAudit,
  ProfileDefinition,
  ProfileIdentity,
  ProfilePublishing,
  ProfileStepOverlay,
  WorkflowArtifactInput,
  WorkflowChangePolicy,
  WorkflowDefinition,
  WorkflowGate,
  WorkflowIdentity,
  WorkflowInputDefinition,
  WorkflowLoop,
  WorkflowRetry,
  WorkflowSkillBinding,
  WorkflowStep,
} from "./types.js";
import { WorkflowPackageError } from "./types.js";

function error(code: `WSSPEC_${string}`, message: string): never {
  throw new WorkflowPackageError(code, message);
}

function record(value: unknown, code: `WSSPEC_${string}`, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) error(code, `${label} 必须是对象。`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) error(code, `${label} 包含不支持字段。`);
  return result;
}

function string(value: unknown, code: `WSSPEC_${string}`, label: string): string {
  if (typeof value !== "string" || value === "") error(code, `${label} 必须是非空字符串。`);
  return value;
}

function strings(value: unknown, code: `WSSPEC_${string}`, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) error(code, `${label} 必须是非空字符串数组。`);
  return [...value];
}

function boolean(value: unknown, code: `WSSPEC_${string}`, label: string): boolean {
  if (typeof value !== "boolean") error(code, `${label} 必须是布尔值。`);
  return value;
}

function positiveInteger(value: unknown, code: `WSSPEC_${string}`, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) error(code, `${label} 必须是正整数。`);
  return value;
}

function parseSkillBinding(value: unknown): WorkflowSkillBinding {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "Step skill binding", ["ref", "required", "fallback"]);
  const result: WorkflowSkillBinding = { ref: string(source.ref, code, "Step skill ref") };
  if (source.required !== undefined) result.required = boolean(source.required, code, "Step skill required");
  if (source.fallback !== undefined) result.fallback = string(source.fallback, code, "Step skill fallback");
  return result;
}

function parseArtifactInput(value: unknown): string | WorkflowArtifactInput {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  if (typeof value === "string") return string(value, code, "Step input");
  const source = record(value, code, "Step artifact input", ["outputId", "required"]);
  const result: WorkflowArtifactInput = { outputId: string(source.outputId, code, "Step artifact input.outputId") };
  if (source.required !== undefined) result.required = boolean(source.required, code, "Step artifact input.required");
  return result;
}

function parseRetry(value: unknown): WorkflowRetry {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "Step retry", ["maxAttempts"]);
  return { maxAttempts: positiveInteger(source.maxAttempts, code, "Step retry.maxAttempts") };
}

function parseLoop(value: unknown): WorkflowLoop {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "Step loop", ["until", "maxIterations"]);
  return { until: string(source.until, code, "Step loop.until"), maxIterations: positiveInteger(source.maxIterations, code, "Step loop.maxIterations") };
}

function parseArtifactOutput(value: unknown): NonNullable<WorkflowStep["outputs"]>[number] {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  if (typeof value === "string") return string(value, code, "Step output");
  const source = record(value, code, "Step output", ["outputId", "artifactType"]);
  return {
    outputId: string(source.outputId, code, "Step output.outputId"),
    artifactType: string(source.artifactType, code, "Step output.artifactType"),
  };
}

function parseStep(value: unknown): WorkflowStep {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "Workflow Step", ["id", "uses", "workspace", "actorRole", "needs", "when", "retry", "loop", "approval", "inputs", "outputs", "skills", "action", "objective", "expectedOutcome", "until", "maxIterations", "steps"]);
  if (source.workspace !== "read-only" && source.workspace !== "isolated-worktree") error(code, "Step workspace 必须是 read-only 或 isolated-worktree。");
  const result: WorkflowStep = { id: string(source.id, code, "Step id"), uses: string(source.uses, code, "Step uses"), workspace: source.workspace };
  if (source.actorRole !== undefined) {
    if (source.actorRole !== "implementation" && source.actorRole !== "review" && source.actorRole !== "fix") {
      error(code, "Step actorRole 不受支持。");
    }
    result.actorRole = source.actorRole;
  }
  if (source.needs !== undefined) result.needs = strings(source.needs, code, "Step needs");
  if (source.when !== undefined) result.when = string(source.when, code, "Step when");
  if (source.retry !== undefined) result.retry = parseRetry(source.retry);
  if (source.loop !== undefined) result.loop = parseLoop(source.loop);
  if (source.approval !== undefined) {
    if (source.approval !== "required" && typeof source.approval !== "boolean") error(code, "Step approval 必须是布尔值或 required。");
    result.approval = source.approval;
  }
  if (source.inputs !== undefined) {
    if (!Array.isArray(source.inputs)) error(code, "Step inputs 必须是数组。");
    result.inputs = source.inputs.map(parseArtifactInput);
  }
  if (source.outputs !== undefined) {
    if (!Array.isArray(source.outputs)) error(code, "Step outputs 必须是数组。");
    result.outputs = source.outputs.map(parseArtifactOutput);
  }
  if (source.skills !== undefined) {
    if (!Array.isArray(source.skills)) error(code, "Step skills 必须是绑定对象数组。");
    result.skills = source.skills.map(parseSkillBinding);
  }
  if (source.action !== undefined) result.action = string(source.action, code, "Step action");
  if (source.objective !== undefined) result.objective = string(source.objective, code, "Step objective");
  if (source.expectedOutcome !== undefined) result.expectedOutcome = string(source.expectedOutcome, code, "Step expectedOutcome");
  if (source.until !== undefined) result.until = string(source.until, code, "Step until");
  if (source.maxIterations !== undefined) result.maxIterations = positiveInteger(source.maxIterations, code, "Step maxIterations");
  if (source.steps !== undefined) {
    if (!Array.isArray(source.steps)) error(code, "Step steps 必须是数组。");
    result.steps = source.steps.map(parseStep);
  }
  return result;
}

function parseGate(value: unknown): WorkflowGate {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "Workflow Gate", ["id", "evidence", "command"]);
  if (source.evidence !== "trusted" && source.evidence !== "attested") error(code, "Gate evidence 不受支持。");
  return { id: string(source.id, code, "Gate id"), evidence: source.evidence, command: strings(source.command, code, "Gate command") };
}

function parseChangePolicy(value: unknown): WorkflowChangePolicy {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "Workflow changePolicy", ["kind", "allowedPaths"]);
  if (source.kind !== "feature" && source.kind !== "documentation-only") error(code, "changePolicy.kind 不受支持。");
  return { kind: source.kind, allowedPaths: strings(source.allowedPaths, code, "changePolicy.allowedPaths") };
}

function parseWorkflowIdentity(value: unknown): WorkflowIdentity {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "Workflow workflow", ["id", "version"]);
  if (source.version !== 1) error("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Workflow identity v1。");
  return { id: string(source.id, code, "Workflow id"), version: 1 };
}

function parseWorkflowInputs(value: unknown): Record<string, WorkflowInputDefinition> {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  if (value === null || typeof value !== "object" || Array.isArray(value)) error(code, "Workflow inputs 必须是对象。");
  const result: Record<string, WorkflowInputDefinition> = {};
  for (const [id, input] of Object.entries(value as Record<string, unknown>)) {
    if (id === "") error(code, "Workflow input id 不能为空。");
    const source = record(input, code, `Workflow input ${id}`, ["accepts"]);
    result[id] = { accepts: strings(source.accepts, code, `Workflow input ${id}.accepts`) };
  }
  return result;
}

export function parseWorkflowV1(value: unknown): WorkflowDefinition {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "workflow.yaml", ["version", "workflow", "inputs", "steps", "gates", "changePolicy"]);
  if (source.version !== 1) error("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Workflow v1。");
  if (!Array.isArray(source.steps)) error(code, "Workflow steps 必须是数组。");
  if (source.gates !== undefined && !Array.isArray(source.gates)) error(code, "Workflow gates 必须是数组。");
  return {
    version: 1,
    workflow: parseWorkflowIdentity(source.workflow),
    inputs: parseWorkflowInputs(source.inputs),
    steps: source.steps.map(parseStep),
    gates: (source.gates ?? []).map(parseGate),
    ...(source.changePolicy === undefined ? {} : { changePolicy: parseChangePolicy(source.changePolicy) }),
  };
}

function parseProfileIdentity(value: unknown): ProfileIdentity {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  const source = record(value, code, "Profile profile", ["id", "workflow"]);
  return { id: string(source.id, code, "Profile id"), workflow: string(source.workflow, code, "Profile workflow") };
}

function parseProfileArtifact(value: unknown): ProfileArtifactOverlay {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  const source = record(value, code, "Profile artifact", ["required", "contentLevel"]);
  const result: ProfileArtifactOverlay = {};
  if (source.required !== undefined) result.required = boolean(source.required, code, "Profile artifact.required");
  if (source.contentLevel !== undefined) result.contentLevel = string(source.contentLevel, code, "Profile artifact.contentLevel");
  return result;
}

function parseProfileArtifacts(value: unknown): Record<string, ProfileArtifactOverlay> {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  if (value === null || typeof value !== "object" || Array.isArray(value)) error(code, "Profile artifacts 必须是对象。");
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([id, artifact]) => {
    if (id === "") error(code, "Profile artifact id 不能为空。");
    return [id, parseProfileArtifact(artifact)];
  }));
}

function parseProfileStep(value: unknown): ProfileStepOverlay {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  const source = record(value, code, "Profile step", ["enabled", "approval", "artifactLevel", "artifacts", "gates", "maxIterations", "independentReviewActor"]);
  const result: ProfileStepOverlay = {};
  if (source.enabled !== undefined) result.enabled = boolean(source.enabled, code, "Profile step.enabled");
  if (source.approval !== undefined) result.approval = boolean(source.approval, code, "Profile step.approval");
  if (source.artifactLevel !== undefined) result.artifactLevel = string(source.artifactLevel, code, "Profile step.artifactLevel");
  if (source.artifacts !== undefined) result.artifacts = parseProfileArtifacts(source.artifacts);
  if (source.gates !== undefined) result.gates = strings(source.gates, code, "Profile step.gates");
  if (source.maxIterations !== undefined) result.maxIterations = positiveInteger(source.maxIterations, code, "Profile step.maxIterations");
  if (source.independentReviewActor !== undefined) result.independentReviewActor = boolean(source.independentReviewActor, code, "Profile step.independentReviewActor");
  return result;
}

function parseProfileSteps(value: unknown): Record<string, ProfileStepOverlay> {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  if (value === null || typeof value !== "object" || Array.isArray(value)) error(code, "Profile steps 必须是对象。");
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([id, overlay]) => {
    if (id === "") error(code, "Profile step id 不能为空。");
    return [id, parseProfileStep(overlay)];
  }));
}

function parsePublishing(value: unknown): ProfilePublishing {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  const source = record(value, code, "Profile publishing", ["issueRequired", "knowledgeRequired", "readBackRequired"]);
  const result: ProfilePublishing = {
    issueRequired: boolean(source.issueRequired, code, "Profile publishing.issueRequired"),
    knowledgeRequired: boolean(source.knowledgeRequired, code, "Profile publishing.knowledgeRequired"),
  };
  if (source.readBackRequired !== undefined) result.readBackRequired = boolean(source.readBackRequired, code, "Profile publishing.readBackRequired");
  return result;
}

function parseAudit(value: unknown): ProfileAudit {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  const source = record(value, code, "Profile audit", ["level", "retention", "recordDecisions", "recordApprovals", "recordActors", "recordPublishing"]);
  if (source.level !== "standard" && source.level !== "complete") error(code, "Profile audit.level 不受支持。");
  const result: ProfileAudit = { level: source.level };
  if (source.retention !== undefined) {
    if (source.retention !== "standard" && source.retention !== "extended") error(code, "Profile audit.retention 不受支持。");
    result.retention = source.retention;
  }
  if (source.recordDecisions !== undefined) result.recordDecisions = boolean(source.recordDecisions, code, "Profile audit.recordDecisions");
  if (source.recordApprovals !== undefined) result.recordApprovals = boolean(source.recordApprovals, code, "Profile audit.recordApprovals");
  if (source.recordActors !== undefined) result.recordActors = boolean(source.recordActors, code, "Profile audit.recordActors");
  if (source.recordPublishing !== undefined) result.recordPublishing = boolean(source.recordPublishing, code, "Profile audit.recordPublishing");
  return result;
}

export function parseProfileV1(value: unknown): ProfileDefinition {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  const source = record(value, code, "Profile", ["version", "profile", "steps", "publishing", "audit"]);
  if (source.version !== 1) error("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Profile v1。");
  return { version: 1, profile: parseProfileIdentity(source.profile), steps: parseProfileSteps(source.steps), publishing: parsePublishing(source.publishing), audit: parseAudit(source.audit) };
}
