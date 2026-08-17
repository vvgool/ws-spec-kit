import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { sha256 } from "../domain/digests.js";
import { builtinResourcesRoot, loadBuiltinCatalog } from "../resources/catalog.js";
import { lockWorkflowPackage, workflowPackageContentDigest } from "./lock.js";
import type { ProfileDefinition, WorkflowChangePolicy, WorkflowDefinition, WorkflowGate, WorkflowManifest, WorkflowPackage, WorkflowPackageFile, WorkflowPackageLock, WorkflowStep } from "./types.js";
import { WorkflowPackageError } from "./types.js";

export interface LoadWorkflowPackageInput { root: string; ref: string }

interface BuiltinProvenance { ref: string; root: string; contentDigest: string; capabilityDigest: string }
const builtinProvenance = new WeakMap<WorkflowPackage, BuiltinProvenance>();

function manifestCapabilityDigest(manifest: WorkflowManifest): string {
  const capabilities = [...new Set([...manifest.capabilities, ...manifest.externalSideEffects])].sort();
  return sha256(`${JSON.stringify({ version: 1, capabilities })}\n`);
}

export function builtinWorkflowPackageProvenance(pkg: WorkflowPackage): BuiltinProvenance | undefined {
  const provenance = builtinProvenance.get(pkg);
  if (provenance === undefined || provenance.ref !== pkg.ref || provenance.root !== pkg.root || provenance.contentDigest !== pkg.contentDigest || provenance.capabilityDigest !== manifestCapabilityDigest(pkg.manifest)) return undefined;
  return provenance;
}

function error(code: `WSSPEC_${string}`, message: string): never { throw new WorkflowPackageError(code, message); }

function normalizeRef(ref: string): { source: "builtin" | "project"; id: string } {
  const match = /^(builtin|project):\/\/workflows\/([^/]+)$/.exec(ref);
  if (!match || match[2] === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(match[2])) error("WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID", "Workflow Package 引用必须是受支持来源下的单层逻辑名称。");
  return { source: match![1]! as "builtin" | "project", id: match![2]! };
}

async function assertContained(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) error("WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID", "Workflow Package 路径越出允许边界。");
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const realRelative = path.relative(realRoot, realTarget);
  if (realRelative === "" || realRelative.startsWith(`..${path.sep}`) || realRelative === ".." || path.isAbsolute(realRelative)) error("WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE", "Workflow Package 的真实路径越出允许边界。");
}

async function readYaml(filename: string, missingCode: `WSSPEC_${string}`, label: string): Promise<unknown> {
  try { return parse(await readFile(filename, "utf8")); }
  catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") error(missingCode, `Workflow Package 缺少 ${label}。`);
    throw caught;
  }
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

function names(value: unknown, code: `WSSPEC_${string}`, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item))) error(code, `${label} 必须是逻辑名称数组。`);
  return [...new Set(value)].sort();
}

function strings(value: unknown, code: `WSSPEC_${string}`, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) error(code, `${label} 必须是非空字符串数组。`);
  return [...value];
}

async function collectTreeFiles(root: string, relativeDirectory: string): Promise<string[]> {
  const directory = path.join(root, relativeDirectory);
  try { await assertContained(root, directory); }
  catch (caught) { if ((caught as NodeJS.ErrnoException).code === "ENOENT") return []; throw caught; }
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(root, relative);
      await assertContained(root, absolute);
      if ((await stat(absolute)).isDirectory()) files.push(...await collectTreeFiles(root, relative));
      else if ((await lstat(absolute)).isFile() || (await lstat(absolute)).isSymbolicLink()) files.push(relative);
    }
    return files;
  } catch (caught) { throw caught; }
}

async function collectFile(root: string, relative: string, missingCode: `WSSPEC_${string}` = "WSSPEC_WORKFLOW_PACKAGE_FILE_MISSING"): Promise<WorkflowPackageFile> {
  const absolute = path.join(root, relative);
  try { await assertContained(root, absolute); }
  catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") error(missingCode, `Workflow Package 缺少 ${relative}。`);
    throw caught;
  }
  if (!(await stat(absolute)).isFile()) error("WSSPEC_WORKFLOW_PACKAGE_FILE_INVALID", `Package 文件 ${relative} 不是普通文件。`);
  return { path: relative.split(path.sep).join("/"), digest: sha256(await readFile(absolute)) };
}

function parseManifest(value: unknown): WorkflowManifest {
  const code = "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID" as const;
  const source = record(value, code, "manifest.yaml", ["version", "id", "description", "entry", "profiles", "skills", "capabilities", "externalSideEffects", "connectors"]);
  if (source.version !== 1) error("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Workflow Package Manifest v1。");
  if (string(source.entry, code, "Manifest entry") !== "workflow.yaml") error("WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID", "Manifest entry 必须为 workflow.yaml。");
  const description = source.description === undefined ? undefined : string(source.description, code, "Manifest description");
  return { version: 1, id: string(source.id, code, "Manifest id"), ...(description === undefined ? {} : { description }), entry: "workflow.yaml", profiles: names(source.profiles, code, "Manifest profiles"), skills: names(source.skills, code, "Manifest skills"), capabilities: names(source.capabilities, code, "Manifest capabilities"), externalSideEffects: names(source.externalSideEffects, code, "Manifest externalSideEffects"), connectors: names(source.connectors, code, "Manifest connectors") };
}

function parseStep(value: unknown): WorkflowStep {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "Workflow Step", ["id", "uses", "needs", "when", "retry", "loop", "approval", "inputs", "outputs", "skills", "action", "objective", "expectedOutcome", "until", "maxIterations", "steps"]);
  if (source.skills !== undefined && (!Array.isArray(source.skills) || source.skills.some((skill) => typeof skill !== "string" && (skill === null || typeof skill !== "object" || Array.isArray(skill) || Object.keys(skill).some((key) => !["ref", "required", "fallback"].includes(key)) || typeof (skill as Record<string, unknown>).ref !== "string")))) error(code, "Step skills 必须是引用或绑定对象数组。");
  return { ...(source as unknown as WorkflowStep), id: string(source.id, code, "Step id"), skills: (source.skills ?? []) as WorkflowStep["skills"] };
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

function parseWorkflow(value: unknown): WorkflowDefinition {
  const code = "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID" as const;
  const source = record(value, code, "workflow.yaml", ["version", "id", "inputs", "steps", "gates", "changePolicy"]);
  if (source.version !== 1) error("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Workflow v1。");
  if (!Array.isArray(source.steps) || (source.gates !== undefined && !Array.isArray(source.gates))) error(code, "Workflow steps 和 gates 必须是数组。");
  const changePolicy = source.changePolicy === undefined ? undefined : parseChangePolicy(source.changePolicy);
  return { ...(source as unknown as WorkflowDefinition), version: 1, id: string(source.id, code, "Workflow id"), steps: source.steps.map(parseStep), gates: (source.gates ?? []).map(parseGate), ...(changePolicy === undefined ? {} : { changePolicy }) };
}

function parseProfile(value: unknown): ProfileDefinition {
  const code = "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID" as const;
  const source = record(value, code, "Profile", ["version", "id", "workflow", "design", "reviewIterations", "audit", "profile", "steps", "publishing"]);
  if (source.version !== 1) error("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Profile v1。");
  if (source.design !== undefined && typeof source.design !== "boolean") error(code, "Profile design 必须是布尔值。");
  const reviewIterations = source.reviewIterations;
  const audit = source.audit;
  if (reviewIterations !== undefined && (typeof reviewIterations !== "number" || !Number.isSafeInteger(reviewIterations) || reviewIterations < 1)) error(code, "Profile reviewIterations 必须是正整数。");
  if (audit !== undefined && audit !== "standard" && audit !== "complete" && (audit === null || typeof audit !== "object" || Array.isArray(audit) || Object.keys(audit).some((key) => key !== "level") || !["standard", "complete"].includes((audit as { level?: unknown }).level as string))) error(code, "Profile audit 不受支持。");
  const identity = source.profile === undefined ? source : record(source.profile, code, "Profile profile", ["id", "workflow"]);
  return { version: 1, id: string(identity.id, code, "Profile id"), workflow: string(identity.workflow, code, "Profile workflow"), ...(source.design === undefined ? {} : { design: source.design }), ...(reviewIterations === undefined ? {} : { reviewIterations: reviewIterations as number }), ...(audit === undefined ? {} : { audit: audit as Exclude<ProfileDefinition["audit"], undefined> }), ...(source.steps === undefined ? {} : { steps: source.steps }), ...(source.publishing === undefined ? {} : { publishing: source.publishing }) } as ProfileDefinition;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (value instanceof Map) { for (const [key, item] of value) { deepFreeze(key); deepFreeze(item); } Object.defineProperties(value, { set: { value: () => { throw new TypeError("不可修改内置 Workflow Package 快照。"); } }, delete: { value: () => { throw new TypeError("不可修改内置 Workflow Package 快照。"); } }, clear: { value: () => { throw new TypeError("不可修改内置 Workflow Package 快照。"); } } }); }
    else for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function parseFile(value: unknown): WorkflowPackageFile {
  const source = record(value, "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock files 项", ["path", "digest"]);
  return { path: string(source.path, "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock files.path"), digest: string(source.digest, "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock files.digest") };
}

function parseLockSkill(value: unknown): { ref: string; digest: string } {
  const source = record(value, "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock packageSkills 项", ["ref", "digest"]);
  return { ref: string(source.ref, "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock packageSkills.ref"), digest: string(source.digest, "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock packageSkills.digest") };
}

async function validateExistingLock(root: string, expected: WorkflowPackageLock): Promise<void> {
  const filename = path.join(root, "workflow.lock");
  let value: unknown;
  try { value = await readYaml(filename, "WSSPEC_WORKFLOW_PACKAGE_LOCK_MISSING", "workflow.lock"); }
  catch (caught) { if ((caught as WorkflowPackageError).code === "WSSPEC_WORKFLOW_PACKAGE_LOCK_MISSING") return; throw caught; }
  const source = record(value, "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock", ["version", "contentDigest", "files", "packageSkills"]);
  if (source.version !== 1 || typeof source.contentDigest !== "string" || !Array.isArray(source.files) || !Array.isArray(source.packageSkills)) error("WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock 包含不支持或无效字段。");
  const lock: WorkflowPackageLock = { version: 1, contentDigest: source.contentDigest, files: source.files.map(parseFile), packageSkills: source.packageSkills.map(parseLockSkill) };
  if (JSON.stringify(lock) !== JSON.stringify(expected)) error("WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock 与当前 Package 内容不一致。");
}

function validatePackageSkillReferences(workflow: WorkflowDefinition, packageSkills: Map<string, { entrypoint: string; digest: string }>): void {
  for (const step of workflow.steps) for (const binding of step.skills) {
    const ref = typeof binding === "string" ? binding : binding.ref;
    if (ref.startsWith("package://skills/") && !packageSkills.has(ref)) error("WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED", "Workflow 引用了 Manifest 未声明的 Package Skill。");
  }
}

export async function loadWorkflowPackage(input: LoadWorkflowPackageInput): Promise<WorkflowPackage> {
  const parsedRef = normalizeRef(input.ref);
  const sourceRoot = parsedRef.source === "builtin" ? builtinResourcesRoot() : input.root;
  if (parsedRef.source === "builtin" && !(await loadBuiltinCatalog()).workflows.some((workflow) => workflow.id === parsedRef.id)) error("WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND", "内置 Workflow Package 不存在。");
  const packagesRoot = parsedRef.source === "builtin" ? path.join(sourceRoot, "workflows") : path.join(sourceRoot, ".wsspec", "workflows");
  const packageRoot = path.resolve(packagesRoot, parsedRef.id);
  await assertContained(packagesRoot, packageRoot);
  const manifest = parseManifest(await readYaml(path.join(packageRoot, "manifest.yaml"), "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_MISSING", "manifest.yaml"));
  const workflow = parseWorkflow(await readYaml(path.join(packageRoot, manifest.entry), "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_MISSING", manifest.entry));
  if (manifest.id !== workflow.id) error("WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest 与 Workflow 的 id 必须一致。");
  const profiles = new Map<string, ProfileDefinition>();
  for (const id of manifest.profiles) {
    const profile = parseProfile(await readYaml(path.join(packageRoot, "profiles", `${id}.yaml`), "WSSPEC_WORKFLOW_PACKAGE_PROFILE_MISSING", `profiles/${id}.yaml`));
    if (profile.id !== id || profile.workflow !== workflow.id) error("WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID", "Profile 必须绑定当前 Workflow。");
    profiles.set(id, profile);
  }
  const packageSkills = new Map<string, { entrypoint: string; digest: string }>();
  const allFiles = new Map<string, WorkflowPackageFile>();
  const add = (file: WorkflowPackageFile) => allFiles.set(file.path, file);
  add(await collectFile(packageRoot, "manifest.yaml", "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_MISSING"));
  add(await collectFile(packageRoot, manifest.entry, "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_MISSING"));
  for (const id of profiles.keys()) add(await collectFile(packageRoot, path.posix.join("profiles", `${id}.yaml`), "WSSPEC_WORKFLOW_PACKAGE_PROFILE_MISSING"));
  for (const id of manifest.skills) {
    const skillDirectory = path.posix.join("skills", id);
    const skillFiles = await Promise.all((await collectTreeFiles(packageRoot, skillDirectory)).map((relative) => collectFile(packageRoot, relative)));
    const entrypoint = path.posix.join(skillDirectory, "SKILL.md");
    if (!skillFiles.some((file) => file.path === entrypoint)) await collectFile(packageRoot, entrypoint, "WSSPEC_WORKFLOW_PACKAGE_SKILL_MISSING");
    for (const file of skillFiles) add(file);
    packageSkills.set(`package://skills/${id}`, { entrypoint: path.join(packageRoot, entrypoint), digest: workflowPackageContentDigest(skillFiles) });
  }
  validatePackageSkillReferences(workflow, packageSkills);
  for (const directory of ["schemas", "templates"]) for (const relative of await collectTreeFiles(packageRoot, directory)) add(await collectFile(packageRoot, relative));
  const files = [...allFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
  const pkg: WorkflowPackage = { ref: input.ref, root: packageRoot, manifest, workflow, profiles, packageSkills, files, contentDigest: workflowPackageContentDigest(files) };
  await validateExistingLock(packageRoot, lockWorkflowPackage(pkg));
  if (parsedRef.source === "builtin") { builtinProvenance.set(pkg, { ref: pkg.ref, root: pkg.root, contentDigest: pkg.contentDigest, capabilityDigest: manifestCapabilityDigest(pkg.manifest) }); return deepFreeze(pkg); }
  return pkg;
}
