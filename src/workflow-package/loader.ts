import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { sha256 } from "../domain/digests.js";
import { builtinResourcesRoot, loadBuiltinCatalog, type BuiltinCatalog } from "../resources/catalog.js";
import { lockWorkflowPackage, workflowPackageContentDigest } from "./lock.js";
import type { ProfileDefinition, WorkflowDefinition, WorkflowManifest, WorkflowPackage, WorkflowPackageFile, WorkflowPackageLock } from "./types.js";
import { WorkflowPackageError } from "./types.js";

export interface LoadWorkflowPackageInput {
  root: string;
  ref: string;
  catalog?: BuiltinCatalog;
  builtinRoot?: string;
}

function invalidPath(message: string): never {
  throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID", message);
}

function normalizeRef(ref: string): { source: "builtin" | "project"; id: string } {
  const match = /^(builtin|project):\/\/workflows\/([^/]+)$/.exec(ref);
  if (!match || match[2] === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(match[2])) invalidPath("Workflow Package 引用必须是受支持来源下的单层逻辑名称。");
  return { source: match![1]! as "builtin" | "project", id: match![2]! };
}

async function assertContained(root: string, target: string, code: "WSSPEC_WORKFLOW_PACKAGE_PATH_INVALID" | "WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE"): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new WorkflowPackageError(code, "Workflow Package 路径越出允许边界。");
  }
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const realRelative = path.relative(realRoot, realTarget);
  if (realRelative === "" || realRelative.startsWith(`..${path.sep}`) || realRelative === ".." || path.isAbsolute(realRelative)) {
    throw new WorkflowPackageError(code, "Workflow Package 的真实路径越出允许边界。");
  }
}

async function readYaml(filename: string): Promise<unknown> {
  try {
    return parse(await readFile(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_MANIFEST_MISSING", "Workflow Package 缺少 manifest.yaml。");
    throw error;
  }
}

function requireRecord(value: unknown, code: `WSSPEC_${string}`, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WorkflowPackageError(code, `${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, code: `WSSPEC_${string}`, label: string): string {
  if (typeof value !== "string" || value === "") throw new WorkflowPackageError(code, `${label} 必须是非空字符串。`);
  return value;
}

function optionalNames(value: unknown, code: `WSSPEC_${string}`, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item))) {
    throw new WorkflowPackageError(code, `${label} 必须是逻辑名称数组。`);
  }
  return [...new Set(value)].sort();
}

async function collectTreeFiles(root: string, relativeDirectory: string): Promise<string[]> {
  const directory = path.join(root, relativeDirectory);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(root, relative);
      await assertContained(root, absolute, "WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE");
      const stat = await lstat(absolute);
      if (stat.isDirectory()) files.push(...await collectTreeFiles(root, relative));
      else if (stat.isFile() || stat.isSymbolicLink()) files.push(relative);
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function collectFile(root: string, relative: string): Promise<WorkflowPackageFile> {
  const absolute = path.join(root, relative);
  await assertContained(root, absolute, "WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE");
  const stat = await lstat(absolute);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_FILE_INVALID", `Package 文件 ${relative} 不存在或不是普通文件。`);
  return { path: relative.split(path.sep).join("/"), digest: sha256(await readFile(absolute)) };
}

function parseManifest(value: unknown): WorkflowManifest {
  const manifest = requireRecord(value, "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "manifest.yaml");
  if (manifest.version !== 1) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Workflow Package Manifest v1。");
  const id = requireString(manifest.id, "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest id");
  const entry = requireString(manifest.entry, "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest entry");
  if (path.isAbsolute(entry) || entry.includes("..") || entry !== "workflow.yaml") invalidPath("Manifest entry 必须为 workflow.yaml。");
  return { ...manifest, version: 1, id, entry, profiles: optionalNames(manifest.profiles, "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest profiles"), skills: optionalNames(manifest.skills, "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest skills"), capabilities: optionalNames(manifest.capabilities, "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest capabilities"), externalSideEffects: optionalNames(manifest.externalSideEffects, "WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest externalSideEffects") };
}

function parseWorkflow(value: unknown): WorkflowDefinition {
  const workflow = requireRecord(value, "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID", "workflow.yaml");
  if (workflow.version !== 1) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Workflow v1。");
  return { ...workflow, version: 1, id: requireString(workflow.id, "WSSPEC_WORKFLOW_PACKAGE_WORKFLOW_INVALID", "Workflow id") };
}

function parseProfile(value: unknown): ProfileDefinition {
  const profile = requireRecord(value, "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID", "Profile");
  if (profile.version !== 1) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_VERSION_UNSUPPORTED", "只支持 Profile v1。");
  return { ...profile, version: 1, id: requireString(profile.id, "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID", "Profile id"), workflow: requireString(profile.workflow, "WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID", "Profile workflow") };
}

async function validateExistingLock(root: string, expected: WorkflowPackageLock): Promise<void> {
  const filename = path.join(root, "workflow.lock");
  try {
    const value = parse(await readFile(filename, "utf8"));
    const lock = requireRecord(value, "WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock");
    const allowed = new Set(["version", "contentDigest", "files", "packageSkills"]);
    if (Object.keys(lock).some((key) => !allowed.has(key)) || lock.version !== 1 || typeof lock.contentDigest !== "string" || !Array.isArray(lock.files) || !Array.isArray(lock.packageSkills)) {
      throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock 包含不支持或无效字段。");
    }
    if (lock.contentDigest !== expected.contentDigest || JSON.stringify(lock.files) !== JSON.stringify(expected.files) || JSON.stringify(lock.packageSkills) !== JSON.stringify(expected.packageSkills)) {
      throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "workflow.lock 与当前 Package 内容不一致。");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function validatePackageSkillReferences(workflow: WorkflowDefinition, packageSkills: Map<string, { entrypoint: string; digest: string }>): void {
  if (!Array.isArray(workflow.steps)) return;
  for (const step of workflow.steps) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
    const skills = (step as Record<string, unknown>).skills;
    if (!Array.isArray(skills)) continue;
    for (const ref of skills) {
      if (typeof ref === "string" && ref.startsWith("package://skills/") && !packageSkills.has(ref)) {
        throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED", "Workflow 引用了 Manifest 未声明的 Package Skill。");
      }
    }
  }
}

export async function loadWorkflowPackage(input: LoadWorkflowPackageInput): Promise<WorkflowPackage> {
  const parsedRef = normalizeRef(input.ref);
  const catalog = input.catalog ?? await loadBuiltinCatalog();
  if (parsedRef.source === "builtin" && !catalog.workflows.some((workflow) => workflow.id === parsedRef.id)) {
    throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND", "内置 Workflow Package 不存在。");
  }
  const sourceRoot = parsedRef.source === "builtin" ? input.builtinRoot ?? builtinResourcesRoot() : input.root;
  const packagesRoot = parsedRef.source === "builtin" ? path.join(sourceRoot, "workflows") : path.join(sourceRoot, ".wsspec", "workflows");
  const packageRoot = path.resolve(packagesRoot, parsedRef.id);
  const lexicalRelative = path.relative(packagesRoot, packageRoot);
  if (lexicalRelative === "" || lexicalRelative.startsWith(`..${path.sep}`) || lexicalRelative === ".." || path.isAbsolute(lexicalRelative)) {
    invalidPath("Workflow Package 路径越出允许边界。");
  }
  await assertContained(packagesRoot, packageRoot, "WSSPEC_WORKFLOW_PACKAGE_PATH_ESCAPE");

  const manifest = parseManifest(await readYaml(path.join(packageRoot, "manifest.yaml")));
  const workflow = parseWorkflow(await readYaml(path.join(packageRoot, manifest.entry)));
  if (manifest.id !== workflow.id) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_MANIFEST_INVALID", "Manifest 与 Workflow 的 id 必须一致。");

  const profiles = new Map<string, ProfileDefinition>();
  for (const id of manifest.profiles) {
    const profile = parseProfile(await readYaml(path.join(packageRoot, "profiles", `${id}.yaml`)));
    if (profile.id !== id || profile.workflow !== workflow.id) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_PROFILE_INVALID", "Profile 必须绑定当前 Workflow。");
    profiles.set(id, profile);
  }

  const packageSkills = new Map<string, { entrypoint: string; digest: string }>();
  for (const id of manifest.skills ?? []) {
    const relative = path.posix.join("skills", id, "SKILL.md");
    const file = await collectFile(packageRoot, relative);
    packageSkills.set(`package://skills/${id}`, { entrypoint: path.join(packageRoot, relative), digest: file.digest });
  }
  validatePackageSkillReferences(workflow, packageSkills);

  const files = [
    await collectFile(packageRoot, "manifest.yaml"),
    await collectFile(packageRoot, manifest.entry),
    ...await Promise.all([...profiles.keys()].map((id) => collectFile(packageRoot, path.posix.join("profiles", `${id}.yaml`)))),
    ...await Promise.all([...packageSkills.keys()].map((ref) => collectFile(packageRoot, path.posix.join("skills", ref.slice("package://skills/".length), "SKILL.md")))),
    ...await Promise.all((await collectTreeFiles(packageRoot, "schemas")).map((relative) => collectFile(packageRoot, relative))),
    ...await Promise.all((await collectTreeFiles(packageRoot, "templates")).map((relative) => collectFile(packageRoot, relative))),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const pkg: WorkflowPackage = { ref: input.ref, root: packageRoot, manifest, workflow, profiles, packageSkills, files, contentDigest: workflowPackageContentDigest(files) };
  await validateExistingLock(packageRoot, lockWorkflowPackage(pkg));
  return pkg;
}
