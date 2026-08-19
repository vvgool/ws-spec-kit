import type { CompiledStep, CompiledWorkflow, ProfileId, ResolvedChangePolicy, SecurityClass } from "../domain/workflow.js";
import type { ProjectGatePolicy } from "../engine/compiler.js";
import { parseExpression } from "../engine/expressions/parser.js";
import type { ArtifactReference, ResolvedSkillDescriptor } from "../protocol/work-package.js";
import { parseSkillLock } from "../registry/skills/lock.js";
import type { SkillLock, SkillProvider } from "../registry/skills/types.js";
import type { ProfileAudit, ProfilePublishing, WorkflowActorRole, WorkflowPackageLock, WorkflowRetry } from "../workflow-package/types.js";

export interface SnapshotStep {
  id: string;
  uses: string;
  actorRole?: WorkflowActorRole;
  securityClass: SecurityClass;
  needs: string[];
  enabled: boolean;
  skills: ResolvedSkillDescriptor[];
  inputs: Array<{ artifact: string; required: boolean }>;
  outputs: Array<{ artifact: string; required: boolean; contentLevel?: string }>;
  gates: string[];
  approval: boolean;
  authorizationRequired: boolean;
  artifactLevel?: string;
  objective?: string;
  expectedOutcome?: string;
  when?: string;
  action?: string;
  until?: string;
  retry?: WorkflowRetry;
  maxIterations?: number;
  independentReviewActor?: boolean;
  steps: SnapshotStep[];
}

export interface SnapshotProfile {
  id: ProfileId;
  order: string[];
  steps: SnapshotStep[];
  publishing: ProfilePublishing;
  audit: ProfileAudit;
  changePolicy: ResolvedChangePolicy;
}

export interface ApplicationSnapshot {
  version: 1;
  workflowRef: string;
  packageDigest: string;
  selectedProfile: ProfileId;
  profiles: Record<ProfileId, SnapshotProfile>;
  workflowPackageLock: WorkflowPackageLock;
  skillLock: SkillLock;
  skillResolution: { provider: SkillProvider; additionalGlobalRootIds: string[] };
  gatePolicy: ProjectGatePolicy;
  changePolicy: ResolvedChangePolicy;
  source: ArtifactReference;
  gates: Array<{ id: string; evidence: "trusted" | "attested" }>;
  leaseTtlSeconds: number;
  maxStageRetries: number;
  createdAt: string;
}

export class ApplicationSnapshotError extends Error {
  readonly code = "WSSPEC_APPLICATION_SNAPSHOT_INVALID" as const;

  constructor(message: string) {
    super(`${ApplicationSnapshotError.name}: ${message}`);
    this.name = "ApplicationSnapshotError";
  }
}

function invalid(label: string): never {
  throw new ApplicationSnapshotError(`${label} 无效。`);
}

function record(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(label);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) invalid(`${label} 包含未知字段`);
  return result;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") invalid(label);
  return value;
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(label);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(label);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) invalid(label);
  return result;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) invalid(label);
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) invalid(`${label} 包含重复项`);
  return result;
}

function optionalText(source: Record<string, unknown>, key: string, label: string): { [key: string]: string } | undefined {
  return source[key] === undefined ? undefined : { [key]: text(source[key], `${label}.${key}`) };
}

function optionalExpression(source: Record<string, unknown>, key: string, label: string): { [key: string]: string } | undefined {
  if (source[key] === undefined) return undefined;
  const value = text(source[key], `${label}.${key}`);
  try {
    parseExpression(value);
  } catch {
    invalid(`${label}.${key}`);
  }
  return { [key]: value };
}

function parseArtifactReference(value: unknown, label: string): ArtifactReference {
  const source = record(value, label, ["artifactType", "schemaVersion", "artifactId", "path", "revision", "contentHash", "mediaType", "contentLevel"]);
  return {
    artifactType: text(source.artifactType, `${label}.artifactType`),
    schemaVersion: integer(source.schemaVersion, `${label}.schemaVersion`, 1),
    ...(source.artifactId === undefined ? {} : { artifactId: text(source.artifactId, `${label}.artifactId`) }),
    ...(source.path === undefined ? {} : { path: text(source.path, `${label}.path`) }),
    ...(source.revision === undefined ? {} : { revision: integer(source.revision, `${label}.revision`, 1) }),
    ...(source.contentHash === undefined ? {} : { contentHash: digest(source.contentHash, `${label}.contentHash`) }),
    ...(source.mediaType === undefined ? {} : { mediaType: text(source.mediaType, `${label}.mediaType`) }),
    ...(source.contentLevel === undefined ? {} : { contentLevel: text(source.contentLevel, `${label}.contentLevel`) }),
  };
}

function parseSkillDescriptor(value: unknown, label: string): ResolvedSkillDescriptor {
  const source = record(value, label, ["ref", "version", "digest", "description"]);
  return {
    ref: text(source.ref, `${label}.ref`),
    version: text(source.version, `${label}.version`),
    digest: digest(source.digest, `${label}.digest`),
    description: text(source.description, `${label}.description`),
  };
}

function parseArtifactRequirement(value: unknown, label: string): { artifact: string; required: boolean } {
  const source = record(value, label, ["artifact", "required"]);
  return { artifact: text(source.artifact, `${label}.artifact`), required: flag(source.required, `${label}.required`) };
}

function parseArtifactDeclaration(value: unknown, label: string): { artifact: string; required: boolean; contentLevel?: string } {
  const source = record(value, label, ["artifact", "required", "contentLevel"]);
  return {
    artifact: text(source.artifact, `${label}.artifact`),
    required: flag(source.required, `${label}.required`),
    ...(source.contentLevel === undefined ? {} : { contentLevel: text(source.contentLevel, `${label}.contentLevel`) }),
  };
}

function parseSnapshotStep(value: unknown, label: string): SnapshotStep {
  const source = record(value, label, [
    "id", "uses", "actorRole", "securityClass", "needs", "enabled", "skills", "inputs", "outputs", "gates", "approval",
    "authorizationRequired", "artifactLevel", "objective", "expectedOutcome", "when", "action", "until", "retry",
    "maxIterations", "independentReviewActor", "steps",
  ]);
  const securityClasses: SecurityClass[] = ["agent", "local-read", "local-write", "external-read", "external-write", "control"];
  if (!securityClasses.includes(source.securityClass as SecurityClass)) invalid(`${label}.securityClass`);
  if (source.actorRole !== undefined && source.actorRole !== "implementation" && source.actorRole !== "review" && source.actorRole !== "fix") {
    invalid(`${label}.actorRole`);
  }
  if (!Array.isArray(source.skills) || !Array.isArray(source.inputs) || !Array.isArray(source.outputs) || !Array.isArray(source.steps)) invalid(label);
  let retry: WorkflowRetry | undefined;
  if (source.retry !== undefined) {
    const rawRetry = record(source.retry, `${label}.retry`, ["maxAttempts"]);
    retry = { maxAttempts: integer(rawRetry.maxAttempts, `${label}.retry.maxAttempts`, 1) };
  }
  return {
    id: text(source.id, `${label}.id`),
    uses: text(source.uses, `${label}.uses`),
    ...(source.actorRole === undefined ? {} : { actorRole: source.actorRole as WorkflowActorRole }),
    securityClass: source.securityClass as SecurityClass,
    needs: strings(source.needs, `${label}.needs`),
    enabled: flag(source.enabled, `${label}.enabled`),
    skills: source.skills.map((skill, index) => parseSkillDescriptor(skill, `${label}.skills[${index}]`)),
    inputs: source.inputs.map((input, index) => parseArtifactRequirement(input, `${label}.inputs[${index}]`)),
    outputs: source.outputs.map((output, index) => parseArtifactDeclaration(output, `${label}.outputs[${index}]`)),
    gates: strings(source.gates, `${label}.gates`),
    approval: flag(source.approval, `${label}.approval`),
    authorizationRequired: flag(source.authorizationRequired, `${label}.authorizationRequired`),
    ...optionalText(source, "artifactLevel", label),
    ...optionalText(source, "objective", label),
    ...optionalText(source, "expectedOutcome", label),
    ...optionalExpression(source, "when", label),
    ...optionalText(source, "action", label),
    ...optionalExpression(source, "until", label),
    ...(retry === undefined ? {} : { retry }),
    ...(source.maxIterations === undefined ? {} : { maxIterations: integer(source.maxIterations, `${label}.maxIterations`, 1) }),
    ...(source.independentReviewActor === undefined ? {} : { independentReviewActor: flag(source.independentReviewActor, `${label}.independentReviewActor`) }),
    steps: source.steps.map((step, index) => parseSnapshotStep(step, `${label}.steps[${index}]`)),
  };
}

function parsePublishing(value: unknown, label: string): ProfilePublishing {
  const source = record(value, label, ["issueRequired", "knowledgeRequired", "readBackRequired"]);
  return {
    issueRequired: flag(source.issueRequired, `${label}.issueRequired`),
    knowledgeRequired: flag(source.knowledgeRequired, `${label}.knowledgeRequired`),
    ...(source.readBackRequired === undefined ? {} : { readBackRequired: flag(source.readBackRequired, `${label}.readBackRequired`) }),
  };
}

function parseAudit(value: unknown, label: string): ProfileAudit {
  const source = record(value, label, ["level", "retention", "recordDecisions", "recordApprovals", "recordActors", "recordPublishing"]);
  if (source.level !== "standard" && source.level !== "complete") invalid(`${label}.level`);
  if (source.retention !== undefined && source.retention !== "standard" && source.retention !== "extended") invalid(`${label}.retention`);
  return {
    level: source.level,
    ...(source.retention === undefined ? {} : { retention: source.retention }),
    ...(source.recordDecisions === undefined ? {} : { recordDecisions: flag(source.recordDecisions, `${label}.recordDecisions`) }),
    ...(source.recordApprovals === undefined ? {} : { recordApprovals: flag(source.recordApprovals, `${label}.recordApprovals`) }),
    ...(source.recordActors === undefined ? {} : { recordActors: flag(source.recordActors, `${label}.recordActors`) }),
    ...(source.recordPublishing === undefined ? {} : { recordPublishing: flag(source.recordPublishing, `${label}.recordPublishing`) }),
  };
}

function parseChangePolicy(value: unknown, label: string): ResolvedChangePolicy {
  const source = record(value, label, ["kind", "allowedPaths", "digest"]);
  if (source.kind !== "feature" && source.kind !== "documentation-only") invalid(`${label}.kind`);
  return {
    kind: source.kind,
    allowedPaths: strings(source.allowedPaths, `${label}.allowedPaths`),
    digest: digest(source.digest, `${label}.digest`),
  };
}

function parseSnapshotProfile(value: unknown, id: ProfileId): SnapshotProfile {
  const label = `Application Snapshot profiles.${id}`;
  const source = record(value, label, ["id", "order", "steps", "publishing", "audit", "changePolicy"]);
  if (source.id !== id || !Array.isArray(source.steps)) invalid(`${label}.id`);
  const order = strings(source.order, `${label}.order`);
  const steps = source.steps.map((step, index) => parseSnapshotStep(step, `${label}.steps[${index}]`));
  const topLevelIds = steps.map(({ id: stepId }) => stepId);
  if (new Set(topLevelIds).size !== topLevelIds.length || order.length !== topLevelIds.length || order.some((stepId) => !topLevelIds.includes(stepId))) invalid(`${label}.order`);
  const recursiveIds = steps.flatMap(function flatten(step): string[] { return [step.id, ...step.steps.flatMap(flatten)]; });
  if (new Set(recursiveIds).size !== recursiveIds.length) invalid(`${label}.steps`);
  return {
    id,
    order,
    steps,
    publishing: parsePublishing(source.publishing, `${label}.publishing`),
    audit: parseAudit(source.audit, `${label}.audit`),
    changePolicy: parseChangePolicy(source.changePolicy, `${label}.changePolicy`),
  };
}

function parseWorkflowPackageLock(value: unknown): WorkflowPackageLock {
  const label = "Application Snapshot workflowPackageLock";
  const source = record(value, label, ["version", "contentDigest", "files", "packageSkills"]);
  if (source.version !== 1 || !Array.isArray(source.files) || !Array.isArray(source.packageSkills)) invalid(label);
  return {
    version: 1,
    contentDigest: digest(source.contentDigest, `${label}.contentDigest`),
    files: source.files.map((file, index) => {
      const item = record(file, `${label}.files[${index}]`, ["path", "digest"]);
      return { path: text(item.path, `${label}.files[${index}].path`), digest: digest(item.digest, `${label}.files[${index}].digest`) };
    }),
    packageSkills: source.packageSkills.map((skill, index) => {
      const item = record(skill, `${label}.packageSkills[${index}]`, ["ref", "digest"]);
      return { ref: text(item.ref, `${label}.packageSkills[${index}].ref`), digest: digest(item.digest, `${label}.packageSkills[${index}].digest`) };
    }),
  };
}

function parseGatePolicy(value: unknown): ProjectGatePolicy {
  const source = record(value, "Application Snapshot gatePolicy", ["requiredGateIds", "configuredGateIds"]);
  const requiredGateIds = strings(source.requiredGateIds, "Application Snapshot gatePolicy.requiredGateIds");
  const configuredGateIds = strings(source.configuredGateIds, "Application Snapshot gatePolicy.configuredGateIds");
  if (requiredGateIds.some((id) => !configuredGateIds.includes(id))) invalid("Application Snapshot gatePolicy.requiredGateIds");
  return { requiredGateIds, configuredGateIds };
}

function parseProfileId(value: unknown, label: string): ProfileId {
  if (value !== "quick" && value !== "standard" && value !== "governed") invalid(label);
  return value;
}

export function parseApplicationSnapshot(value: unknown): ApplicationSnapshot {
  try {
    const source = record(value, "Application Snapshot", [
      "version", "workflowRef", "packageDigest", "selectedProfile", "profiles", "workflowPackageLock", "skillLock",
      "skillResolution", "gatePolicy", "changePolicy", "source", "gates", "leaseTtlSeconds", "maxStageRetries", "createdAt",
    ]);
    if (source.version !== 1) invalid("Application Snapshot version");
    const selectedProfile = parseProfileId(source.selectedProfile, "Application Snapshot selectedProfile");
    const rawProfiles = record(source.profiles, "Application Snapshot profiles", ["quick", "standard", "governed"]);
    const profiles = {
      quick: parseSnapshotProfile(rawProfiles.quick, "quick"),
      standard: parseSnapshotProfile(rawProfiles.standard, "standard"),
      governed: parseSnapshotProfile(rawProfiles.governed, "governed"),
    };
    const workflowPackageLock = parseWorkflowPackageLock(source.workflowPackageLock);
    const packageDigest = digest(source.packageDigest, "Application Snapshot packageDigest");
    if (packageDigest !== workflowPackageLock.contentDigest) invalid("Application Snapshot packageDigest");
    const skillResolution = record(source.skillResolution, "Application Snapshot skillResolution", ["provider", "additionalGlobalRootIds"]);
    const providers: SkillProvider[] = ["codex", "claude", "cursor", "generic"];
    if (!providers.includes(skillResolution.provider as SkillProvider)) invalid("Application Snapshot skillResolution.provider");
    if (!Array.isArray(source.gates)) invalid("Application Snapshot gates");
    const gates = source.gates.map((gate, index) => {
      const item = record(gate, `Application Snapshot gates[${index}]`, ["id", "evidence"]);
      if (item.evidence !== "trusted" && item.evidence !== "attested") invalid(`Application Snapshot gates[${index}].evidence`);
      return {
        id: text(item.id, `Application Snapshot gates[${index}].id`),
        evidence: item.evidence as "trusted" | "attested",
      };
    });
    const createdAt = text(source.createdAt, "Application Snapshot createdAt");
    if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) invalid("Application Snapshot createdAt");
    const changePolicy = parseChangePolicy(source.changePolicy, "Application Snapshot changePolicy");
    if (JSON.stringify(changePolicy) !== JSON.stringify(profiles[selectedProfile].changePolicy)) invalid("Application Snapshot changePolicy");
    return {
      version: 1,
      workflowRef: text(source.workflowRef, "Application Snapshot workflowRef"),
      packageDigest,
      selectedProfile,
      profiles,
      workflowPackageLock,
      skillLock: parseSkillLock(source.skillLock),
      skillResolution: {
        provider: skillResolution.provider as SkillProvider,
        additionalGlobalRootIds: strings(skillResolution.additionalGlobalRootIds, "Application Snapshot skillResolution.additionalGlobalRootIds").map((id) => {
          if (!/^[a-z][a-z0-9-]{0,62}$/u.test(id)) invalid("Application Snapshot skillResolution.additionalGlobalRootIds");
          return id;
        }),
      },
      gatePolicy: parseGatePolicy(source.gatePolicy),
      changePolicy,
      source: parseArtifactReference(source.source, "Application Snapshot source"),
      gates,
      leaseTtlSeconds: integer(source.leaseTtlSeconds, "Application Snapshot leaseTtlSeconds", 60, 86_400),
      maxStageRetries: integer(source.maxStageRetries, "Application Snapshot maxStageRetries", 0, 10),
      createdAt,
    };
  } catch (error) {
    if (error instanceof ApplicationSnapshotError) throw error;
    throw new ApplicationSnapshotError(error instanceof Error ? error.message : "Application Snapshot 无法解析。");
  }
}

export function snapshotStep(step: CompiledStep, skills: ReadonlyMap<string, ResolvedSkillDescriptor>): SnapshotStep {
  return {
    id: step.id,
    uses: step.uses,
    ...(step.actorRole === undefined ? {} : { actorRole: step.actorRole }),
    securityClass: step.securityClass,
    needs: [...step.needs],
    enabled: step.enabled,
    skills: step.skills.map((skill) => skills.get(skill.requestedRef) ?? skills.get(skill.ref)!),
    inputs: step.inputs.map((input) => ({ ...input })),
    outputs: step.outputs.map((output) => ({ ...output })),
    gates: [...step.gates],
    approval: step.approval,
    authorizationRequired: step.authorizationRequired,
    ...(step.artifactLevel === undefined ? {} : { artifactLevel: step.artifactLevel }),
    ...(step.objective === undefined ? {} : { objective: step.objective }),
    ...(step.expectedOutcome === undefined ? {} : { expectedOutcome: step.expectedOutcome }),
    ...(step.when === undefined ? {} : { when: step.when }),
    ...(step.action === undefined ? {} : { action: step.action }),
    ...(step.until === undefined ? {} : { until: step.until }),
    ...(step.retry === undefined ? {} : { retry: { ...step.retry } }),
    ...(step.maxIterations === undefined ? {} : { maxIterations: step.maxIterations }),
    ...(step.independentReviewActor === undefined ? {} : { independentReviewActor: step.independentReviewActor }),
    steps: step.steps.map((child) => snapshotStep(child, skills)),
  };
}

export function snapshotProfile(workflow: CompiledWorkflow, skills: ReadonlyMap<string, ResolvedSkillDescriptor>): SnapshotProfile {
  return {
    id: workflow.profile.id as ProfileId,
    order: [...workflow.order],
    steps: workflow.steps.map((step) => snapshotStep(step, skills)),
    publishing: { ...workflow.profile.publishing },
    audit: { ...workflow.profile.audit },
    changePolicy: { ...workflow.changePolicy, allowedPaths: [...workflow.changePolicy.allowedPaths] },
  };
}
