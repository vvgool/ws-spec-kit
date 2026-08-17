import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { sha256 } from "../domain/digests.js";
import { builtinResourcesRoot, loadBuiltinCatalog } from "../resources/catalog.js";
import { lockWorkflowPackage, workflowPackageContentDigest } from "./lock.js";
import { assertContainedPath } from "./path-boundary.js";
import type { ProfileDefinition, WorkflowDefinition, WorkflowManifest, WorkflowPackage, WorkflowPackageFile, WorkflowPackageLock, WorkflowStep } from "./types.js";
import { WorkflowPackageError } from "./types.js";
import { parseProfileV1, parseWorkflowV1 } from "./workflow-v1.js";

export interface LoadWorkflowPackageInput { root: string; ref: string }

interface BuiltinProvenance { ref: string; snapshot: string }
const builtinProvenance = new WeakMap<WorkflowPackage, BuiltinProvenance>();

function normalizedPackageSnapshot(pkg: WorkflowPackage): string {
  return JSON.stringify({
    ref: pkg.ref,
    root: pkg.root,
    manifest: pkg.manifest,
    workflow: pkg.workflow,
    profiles: [...pkg.profiles.entries()].sort(([left], [right]) => left.localeCompare(right)),
    packageSkills: [...pkg.packageSkills.entries()].sort(([left], [right]) => left.localeCompare(right)),
    files: [...pkg.files].sort((left, right) => left.path.localeCompare(right.path)),
    contentDigest: pkg.contentDigest,
  });
}

export async function builtinWorkflowPackageProvenance(pkg: WorkflowPackage): Promise<BuiltinProvenance | undefined> {
  const provenance = builtinProvenance.get(pkg);
  if (provenance === undefined || provenance.ref !== pkg.ref || !pkg.ref.startsWith("builtin://")) return undefined;
  const canonical = await loadWorkflowPackage({ root: pkg.root, ref: provenance.ref });
  const currentSnapshot = normalizedPackageSnapshot(pkg);
  const canonicalSnapshot = normalizedPackageSnapshot(canonical);
  if (currentSnapshot !== provenance.snapshot || currentSnapshot !== canonicalSnapshot) return undefined;
  return provenance;
}

function error(code: `WSSPEC_${string}`, message: string): never { throw new WorkflowPackageError(code, message); }

function normalizeRef(ref: string): { source: "builtin" | "project"; id: string } {
  const match = /^(builtin|project):\/\/workflows\/([^/]+)$/.exec(ref);
  if (!match || match[2] === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(match[2])) error("WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID", "Workflow Package 引用必须是受支持来源下的单层逻辑名称。");
  return { source: match![1]! as "builtin" | "project", id: match![2]! };
}

async function assertContained(root: string, target: string): Promise<void> {
  await assertContainedPath(root, target, {
    invalid: "WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID",
    escape: "WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE",
  }, "Workflow Package 路径");
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

async function collectTreeFiles(root: string, relativeDirectory: string, optionalRoot: boolean): Promise<string[]> {
  const directory = path.join(root, relativeDirectory);
  try { await assertContained(root, directory); }
  catch (caught) { if (optionalRoot && (caught as NodeJS.ErrnoException).code === "ENOENT") return []; throw caught; }
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    const absolute = path.join(root, relative);
    await assertContained(root, absolute);
    const target = await stat(absolute);
    if (target.isDirectory()) files.push(...await collectTreeFiles(root, relative, false));
    else {
      const source = await lstat(absolute);
      if (source.isFile() || source.isSymbolicLink()) files.push(relative);
    }
  }
  return files;
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
  const visit = (steps: WorkflowStep[]): void => {
    for (const step of steps) {
      for (const binding of step.skills ?? []) if (binding.ref.startsWith("package://skills/") && !packageSkills.has(binding.ref)) error("WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED", "Workflow 引用了 Manifest 未声明的 Package Skill。");
      visit(step.steps ?? []);
    }
  };
  visit(workflow.steps);
}

export async function loadWorkflowPackage(input: LoadWorkflowPackageInput): Promise<WorkflowPackage> {
  const parsedRef = normalizeRef(input.ref);
  const sourceRoot = parsedRef.source === "builtin" ? builtinResourcesRoot() : path.resolve(input.root);
  if (parsedRef.source === "builtin" && !(await loadBuiltinCatalog()).workflows.some((workflow) => workflow.workflow.id === parsedRef.id)) error("WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND", "内置 Workflow Package 不存在。");
  let packagesRoot: string;
  if (parsedRef.source === "builtin") {
    packagesRoot = path.join(sourceRoot, "workflows");
    await assertContained(sourceRoot, packagesRoot);
  } else {
    const projectConfigurationRoot = path.join(sourceRoot, ".wsspec");
    await assertContained(sourceRoot, projectConfigurationRoot);
    packagesRoot = path.join(projectConfigurationRoot, "workflows");
    await assertContained(projectConfigurationRoot, packagesRoot);
  }
  const packageRoot = path.resolve(packagesRoot, parsedRef.id);
  await assertContained(packagesRoot, packageRoot);
  const manifest = parseManifest(await readYaml(path.join(packageRoot, "manifest.yaml"), "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_MISSING", "manifest.yaml"));
  const workflow = parseWorkflowV1(await readYaml(path.join(packageRoot, manifest.entry), "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_MISSING", manifest.entry));
  if (manifest.id !== workflow.workflow.id) error("WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest 与 Workflow 的 id 必须一致。");
  const profiles = new Map<string, ProfileDefinition>();
  for (const id of manifest.profiles) {
    const profile = parseProfileV1(await readYaml(path.join(packageRoot, "profiles", `${id}.yaml`), "WSSPEC_WORKFLOW_PACKAGE_PROFILE_MISSING", `profiles/${id}.yaml`));
    if (profile.profile.id !== id || profile.profile.workflow !== workflow.workflow.id) error("WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID", "Profile 必须绑定当前 Workflow。");
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
    const skillFiles = new Map<string, WorkflowPackageFile>();
    for (const relative of await collectTreeFiles(packageRoot, skillDirectory, true)) {
      const file = await collectFile(packageRoot, relative);
      skillFiles.set(file.path, file);
    }
    const entrypoint = path.posix.join(skillDirectory, "SKILL.md");
    const entryFile = await collectFile(packageRoot, entrypoint, "WSSPEC_WORKFLOW_PACKAGE_SKILL_MISSING");
    skillFiles.set(entryFile.path, entryFile);
    for (const file of skillFiles.values()) add(file);
    packageSkills.set(`package://skills/${id}`, { entrypoint: path.join(packageRoot, entrypoint), digest: workflowPackageContentDigest([...skillFiles.values()]) });
  }
  validatePackageSkillReferences(workflow, packageSkills);
  for (const directory of ["schemas", "templates"]) for (const relative of await collectTreeFiles(packageRoot, directory, true)) add(await collectFile(packageRoot, relative));
  const files = [...allFiles.values()].sort((left, right) => left.path.localeCompare(right.path));
  const pkg: WorkflowPackage = { ref: input.ref, root: packageRoot, manifest, workflow, profiles, packageSkills, files, contentDigest: workflowPackageContentDigest(files) };
  await validateExistingLock(packageRoot, lockWorkflowPackage(pkg));
  if (parsedRef.source === "builtin") { builtinProvenance.set(pkg, { ref: pkg.ref, snapshot: normalizedPackageSnapshot(pkg) }); return deepFreeze(pkg); }
  return pkg;
}
