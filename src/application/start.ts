import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import { parse, stringify } from "yaml";

import { sha256 } from "../domain/digests.js";
import type { ProfileId } from "../domain/workflow.js";
import { compileWorkflow, type ProjectGatePolicy } from "../engine/compiler.js";
import { selectProfile } from "../policy/profile.js";
import type { StartInput, StartResult, WorkflowProfile } from "../protocol/application.js";
import type { ResolvedSkillDescriptor } from "../protocol/work-package.js";
import { captureLocalRequirement } from "../registry/connectors/local-requirement.js";
import { createSkillLock } from "../registry/skills/lock.js";
import { resolveSkill } from "../registry/skills/resolver.js";
import type { ResolvedSkill, SkillProvider } from "../registry/skills/types.js";
import { loadBuiltinCatalog } from "../resources/catalog.js";
import { validate } from "../schemas/index.js";
import { initializeControlPlane, writeApplicationAnchor } from "../storage/control-plane.js";
import { writeFileAtomic } from "../storage/files.js";
import { loadRepository } from "../storage/repository.js";
import { createWorkItem, creationOwnerForWorkItem, rollbackCreatedWorkItem, type WorkItem } from "../storage/work-items.js";
import { loadWorkflowPackage } from "../workflow-package/loader.js";
import { lockWorkflowPackage } from "../workflow-package/lock.js";
import { evaluateWorkflowTrust } from "../workflow-package/trust.js";
import type { WorkflowPackage, WorkflowStep } from "../workflow-package/types.js";
import { snapshotProfile, type ApplicationSnapshot, type SnapshotProfile } from "./snapshot.js";

export interface StartDependencies {
  provider: SkillProvider;
  home: string;
  now(): Date;
  workflowTrust?: { interactive: boolean; actor: string };
}

export class ApplicationStartError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string, readonly details?: unknown) {
    super(`${code}: ${message}`);
    this.name = "ApplicationStartError";
  }
}

export interface ProjectConfiguration {
  leaseTtlSeconds: number;
  maxStageRetries: number;
  gatePolicy: ProjectGatePolicy;
  documentationAllowedPaths?: string[];
  additionalGlobalRoots?: string[];
  worktreeRoot: string;
  branchPrefix: string;
}

function allWorkflowSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [step, ...allWorkflowSteps(step.steps ?? [])]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "") ? [...new Set(value)] : undefined;
}

export function projectConfiguration(raw: unknown, pkg: WorkflowPackage): ProjectConfiguration {
  const source = validate<Record<string, unknown>>("builtin.application-project-config.v1", raw);
  const quality = record(source.quality);
  const gates = quality === undefined ? undefined : record(quality.gates);
  const defaultGate = pkg.workflow.workflow.id === "documentation-delivery" ? "docs.integrity" : "test";
  let gatePolicy: ProjectGatePolicy;
  if (gates === undefined) {
    gatePolicy = { requiredGateIds: [defaultGate], configuredGateIds: [defaultGate] };
  } else {
    const configuredGateIds = Object.keys(gates).sort();
    if (configuredGateIds.length === 0) throw new ApplicationStartError("WSSPEC_PROJECT_GATE_POLICY_INVALID", "项目不能用空 Gate 配置绕过 Workflow 安全策略。 ");
    const requiredGateIds = configuredGateIds.filter((id) => record(gates[id])?.required === true);
    if (requiredGateIds.length === 0) throw new ApplicationStartError("WSSPEC_PROJECT_GATE_POLICY_INVALID", "项目必须明确至少一个 required Gate。 ");
    gatePolicy = { requiredGateIds, configuredGateIds };
  }
  const runtime = record(source.runtime);
  const claimTtlSeconds = runtime?.claimTtlSeconds;
  const maxStageRetries = runtime?.maxStageRetries;
  const git = record(source.git);
  const worktrees = record(git?.worktrees);
  const documentation = record(source.documentation);
  const skills = record(source.skills);
  return {
    leaseTtlSeconds: typeof claimTtlSeconds === "number" && Number.isInteger(claimTtlSeconds) && claimTtlSeconds >= 60 ? claimTtlSeconds : 60,
    maxStageRetries: typeof maxStageRetries === "number" && Number.isInteger(maxStageRetries) && maxStageRetries >= 0 && maxStageRetries <= 10 ? maxStageRetries : 3,
    gatePolicy,
    ...(stringArray(documentation?.allowedPaths) === undefined ? {} : { documentationAllowedPaths: stringArray(documentation?.allowedPaths)! }),
    ...(stringArray(skills?.additionalGlobalRoots) === undefined ? {} : { additionalGlobalRoots: stringArray(skills?.additionalGlobalRoots)! }),
    worktreeRoot: typeof worktrees?.root === "string" ? worktrees.root : ".worktrees",
    branchPrefix: typeof worktrees?.branchPrefix === "string" ? worktrees.branchPrefix : "wspec/",
  };
}

function workflowSelection(value: unknown): { ref: string; profile: WorkflowProfile } {
  const source = validate<Record<string, unknown>>("builtin.workflow-selection.v1", value);
  const active = record(source.activeWorkflow)!;
  return { ref: active.ref as string, profile: (source.profile ?? "auto") as WorkflowProfile };
}

export async function resolveProjectWorkflowContext(input: {
  root: string;
  pkg: WorkflowPackage;
  provider: SkillProvider;
  home: string;
  config?: unknown;
}): Promise<{ configuration: ProjectConfiguration; skills: ResolvedSkill[] }> {
  let rawConfig = input.config;
  if (rawConfig === undefined) {
    try {
      rawConfig = parse(await readFile(path.join(input.root, ".wsspec", "config.yaml"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      rawConfig = { version: 1 };
    }
  }
  const configuration = projectConfiguration(rawConfig, input.pkg);
  const bindings = new Map(allWorkflowSteps(input.pkg.workflow.steps).flatMap((step) => (step.skills ?? []).map((binding) => [binding.ref, binding])));
  const skills = (await Promise.all([...bindings.values()].map((binding) => resolveSkill(binding, {
    provider: input.provider,
    projectRoot: input.root,
    home: input.home,
    package: input.pkg,
    stepStatus: "not_started",
    ...(configuration.additionalGlobalRoots === undefined ? {} : { additionalGlobalRoots: configuration.additionalGlobalRoots }),
  })))).filter((skill): skill is ResolvedSkill => skill !== undefined);
  return { configuration, skills };
}

function portableSkill(skill: ResolvedSkill, catalog: Awaited<ReturnType<typeof loadBuiltinCatalog>>): ResolvedSkillDescriptor {
  const id = skill.ref.split("/").at(-1)!;
  const builtin = catalog.skills.find((candidate) => candidate.id === id);
  return {
    ref: skill.ref,
    version: builtin?.version ?? "locked",
    digest: skill.digest,
    description: builtin?.description ?? `Locked workflow skill ${skill.ref}`,
  };
}

async function snapshotWorkflowPackage(pkg: WorkflowPackage, target: string): Promise<void> {
  for (const file of pkg.files) {
    const destination = path.join(target, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFileAtomic(destination, await readFile(path.join(pkg.root, file.path), "utf8"));
  }
}

async function copySkillDirectory(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const input = path.join(source, entry.name);
    const output = path.join(target, entry.name);
    const current = await stat(input);
    if (current.isDirectory()) await copySkillDirectory(input, output);
    else if (current.isFile()) {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFileAtomic(output, await readFile(input, "utf8"));
    }
  }
}

async function snapshotSkills(skills: readonly ResolvedSkill[], target: string): Promise<void> {
  for (const skill of skills) {
    if (skill.source !== "builtin" && skill.source !== "project") continue;
    const id = skill.ref.split("/").at(-1)!;
    const destination = path.join(target, skill.source, id);
    await copySkillDirectory(path.dirname(skill.entrypoint), destination);
  }
}

function titleFor(text: string, origin: string): string {
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim() !== "")?.trim();
  return (firstLine ?? origin).slice(0, 120);
}

export async function startApplication(input: StartInput, dependencies: StartDependencies): Promise<StartResult> {
  validate("builtin.application-start-input.v1", input);
  const identity = await loadRepository(input.root);
  const [workflowText, configText] = await Promise.all([
    readFile(path.join(identity.repositoryRoot, ".wsspec", "workflow.yaml"), "utf8"),
    readFile(path.join(identity.repositoryRoot, ".wsspec", "config.yaml"), "utf8"),
  ]);
  const projectWorkflow = workflowSelection(parse(workflowText));
  const workflowRef = input.workflowRef ?? projectWorkflow.ref;
  const pkg = await loadWorkflowPackage({ root: identity.repositoryRoot, ref: workflowRef });
  const trust = dependencies.workflowTrust?.interactive === true
    ? await evaluateWorkflowTrust({ root: identity.repositoryRoot, pkg, interactive: true, actor: dependencies.workflowTrust.actor, channel: "interactive" })
    : await evaluateWorkflowTrust({ root: identity.repositoryRoot, pkg, interactive: false });
  if (trust.status === "approval_required") throw new ApplicationStartError("WSSPEC_WORKFLOW_TRUST_REQUIRED", "Workflow Package 需要交互信任决定。 ", trust.summary);
  if (trust.status === "rejected") throw new ApplicationStartError("WSSPEC_WORKFLOW_TRUST_REJECTED", "Workflow Package 已被拒绝。 ");

  const { configuration, skills: resolved } = await resolveProjectWorkflowContext({
    root: identity.repositoryRoot,
    pkg,
    provider: dependencies.provider,
    home: dependencies.home,
    config: parse(configText),
  });
  const catalog = await loadBuiltinCatalog();
  const descriptors = new Map<string, ResolvedSkillDescriptor>();
  for (const skill of resolved) {
    const descriptor = portableSkill(skill, catalog);
    descriptors.set(skill.requestedRef, descriptor);
    descriptors.set(skill.ref, descriptor);
  }
  const profiles = {} as Record<ProfileId, SnapshotProfile>;
  for (const profileId of ["quick", "standard", "governed"] as const) {
    const compiled = compileWorkflow(pkg, {
      id: profileId,
      skills: resolved,
      ...(configuration.documentationAllowedPaths === undefined ? {} : { documentationAllowedPaths: configuration.documentationAllowedPaths }),
    }, configuration.gatePolicy);
    profiles[profileId] = snapshotProfile(compiled, descriptors);
  }
  const requestedProfile = input.profile ?? projectWorkflow.profile;
  const selected = requestedProfile === "auto" ? selectProfile({ mode: "auto", phase: "intake", risk: null }).id : requestedProfile;
  const requirement = await captureLocalRequirement(identity.repositoryRoot, input.source);
  if (input.source.type === "issue") {
    throw new ApplicationStartError("WSSPEC_SOURCE_TYPE_UNSUPPORTED", "当前阶段只支持 Prompt 和仓库内 Markdown/TXT 来源。 ");
  }
  const workItemId = `WSS-${ulid()}` as `WSS-${string}`;
  const createdAt = dependencies.now().toISOString();
  let item: WorkItem | undefined;
  try {
    item = await createWorkItem({
      root: identity.repositoryRoot,
      workItemId,
      title: titleFor(requirement.text, requirement.origin),
      source: input.source.type === "prompt" ? { type: "prompt", content: input.source.text } : { type: "file", path: input.source.path },
      createdAt,
      capturedSource: requirement,
      application: {
        workflowText,
        configText,
        worktreeRoot: configuration.worktreeRoot,
        branchPrefix: configuration.branchPrefix,
      },
    });
    const worktree = path.join(identity.repositoryRoot, item.execution.worktree);
    const itemRoot = path.join(worktree, ".wsspec", "work-items", workItemId);
    const sourceReference = {
      artifactType: "requirement-source",
      schemaVersion: 1,
      path: `.wsspec/work-items/${workItemId}/source/source.json`,
      revision: 1,
      contentHash: item.source.contentDigest,
      mediaType: "application/json",
    } as const;
    const snapshot: ApplicationSnapshot = {
      version: 1,
      workflowRef,
      packageDigest: pkg.contentDigest,
      selectedProfile: selected,
      profiles,
      workflowPackageLock: lockWorkflowPackage(pkg),
      skillLock: createSkillLock(resolved),
      skillResolution: {
        provider: dependencies.provider,
        additionalGlobalRoots: configuration.additionalGlobalRoots ?? [],
      },
      gatePolicy: configuration.gatePolicy,
      changePolicy: profiles[selected].changePolicy,
      source: sourceReference,
      gates: pkg.workflow.gates.map(({ id, evidence }) => ({ id, evidence })),
      leaseTtlSeconds: configuration.leaseTtlSeconds,
      maxStageRetries: configuration.maxStageRetries,
      createdAt,
    };
    await snapshotWorkflowPackage(pkg, path.join(itemRoot, "snapshot", "workflow"));
    await unlink(path.join(itemRoot, "snapshot", "workflow.yaml"));
    await snapshotSkills(resolved, path.join(itemRoot, "snapshot", "skills"));
    await writeFileAtomic(path.join(itemRoot, "snapshot", "workflow.lock.json"), `${JSON.stringify(snapshot.workflowPackageLock, null, 2)}\n`);
    await writeFileAtomic(path.join(itemRoot, "snapshot", "skill.lock.json"), `${JSON.stringify(snapshot.skillLock, null, 2)}\n`);
    const applicationText = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFileAtomic(path.join(itemRoot, "snapshot", "application.json"), applicationText);
    const applicationItem: WorkItem = { ...item, execution: { ...item.execution, workflowDigest: sha256(applicationText) } };
    const manifestText = stringify(applicationItem, { lineWidth: 0 });
    await writeFileAtomic(path.join(itemRoot, "work-item.yaml"), manifestText);
    await writeApplicationAnchor({
      cwd: identity.repositoryRoot,
      workItemId,
      manifestDigest: sha256(manifestText),
      ownerToken: creationOwnerForWorkItem(item),
    });

    const initialStages = Object.fromEntries(profiles[selected].steps.map((step) => [
      step.id,
      { status: !step.enabled ? "skipped" : step.needs.length === 0 ? "ready" : "pending" },
    ])) as Record<string, { status: "skipped" | "ready" | "pending" }>;
    await initializeControlPlane({ cwd: identity.repositoryRoot, workItemId, stages: profiles[selected].order, initialWorkItem: { status: "active" }, initialStages });
    return { workItemId, workflowRef, profile: selected };
  } catch (error) {
    if (item !== undefined) {
      try {
        await rollbackCreatedWorkItem({ root: identity.repositoryRoot, item });
      } catch (rollbackError) {
        throw new ApplicationStartError("WSSPEC_START_ROLLBACK_FAILED", "Start 失败且无法安全回滚新建 Work Item。", { error, rollbackError });
      }
    }
    throw error;
  }
}
