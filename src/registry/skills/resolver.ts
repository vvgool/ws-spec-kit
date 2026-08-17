import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../../domain/digests.js";
import { builtinResourcesRoot, loadBuiltinCatalog } from "../../resources/catalog.js";
import { assertContainedPath } from "../../workflow-package/path-boundary.js";
import { workflowPackageContentDigest } from "../../workflow-package/lock.js";
import { WorkflowPackageError } from "../../workflow-package/types.js";
import type { WorkflowSkillBinding } from "../../workflow-package/types.js";
import type { ResolvedSkill, ResolvedSkillFallback, SkillCandidate, SkillLockEntry, SkillProvider, SkillResolverContext, SkillSource } from "./types.js";
import { SkillResolutionError } from "./types.js";

interface ParsedSkillRef {
  ref: string;
  source: SkillSource;
  segments: string[];
}

interface ResolvedReference {
  ref: string;
  source: SkillSource;
  rootId: string;
  entrypoint: string;
  digest: string;
  candidates: SkillCandidate[];
}

interface SearchRoot {
  rootId: string;
  directory: string;
}

const defaultGlobalRoots: Record<SkillProvider, string[]> = {
  codex: [".agents/skills"],
  claude: [".claude/skills"],
  cursor: [".agents/skills", ".cursor/skills", ".claude/skills", ".codex/skills"],
  generic: [],
};

function error(code: `WSSPEC_${string}`, message: string): never {
  throw new SkillResolutionError(code, message);
}

function parseSkillRef(ref: string): ParsedSkillRef {
  const match = /^(builtin|package|global|project):\/\/(.*)$/.exec(ref);
  if (match === null) error("WSSPEC_SKILL_REF_INVALID", "Skill 引用必须使用受支持的显式来源 URI。");
  const source = match[1]! as SkillSource;
  const rawPath = match[2]!;
  if (rawPath === "" || rawPath.includes("%") || rawPath.includes("\\")) error("WSSPEC_SKILL_REF_INVALID", "Skill URI 路径无效。");
  const segments = rawPath.split("/");
  if (segments.some((segment) => !/^[a-z0-9][a-z0-9-]*$/.test(segment))) error("WSSPEC_SKILL_REF_INVALID", "Skill URI 每个路径段只能包含小写字母、数字和连字符。");
  if (source !== "global" && (segments.length !== 2 || segments[0] !== "skills")) error("WSSPEC_SKILL_REF_INVALID", `${source} Skill 必须使用 ${source}://skills/<name>。`);
  return { ref, source, segments };
}

async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw caught;
  }
}

async function assertSkillPath(root: string, target: string): Promise<void> {
  await assertContainedPath(root, target, {
    invalid: "WSSPEC_SKILL_PATH_INVALID",
    escape: "WSSPEC_SKILL_PATH_ESCAPE",
  }, "Skill 路径");
}

interface SkillDigestFile {
  path: string;
  digest: string;
}

async function collectSkillFiles(declaredRoot: string, skillDirectory: string): Promise<SkillDigestFile[]> {
  const files: SkillDigestFile[] = [];
  const activeDirectories = new Set<string>();

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    await assertSkillPath(declaredRoot, directory);
    const canonical = await realpath(directory);
    if (activeDirectories.has(canonical)) error("WSSPEC_SKILL_PATH_INVALID", "Skill 目录包含循环符号链接。");
    activeDirectories.add(canonical);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      await assertSkillPath(declaredRoot, absolute);
      const target = await stat(absolute);
      if (target.isDirectory()) await visit(absolute, relative);
      else if (target.isFile()) files.push({ path: relative, digest: sha256(await readFile(absolute)) });
      else error("WSSPEC_SKILL_PATH_INVALID", `Skill 内容 ${relative} 不是普通文件或目录。`);
    }
    activeDirectories.delete(canonical);
  };

  await visit(skillDirectory, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function skillDirectoryDigest(declaredRoot: string, skillDirectory: string): Promise<string> {
  const files = await collectSkillFiles(declaredRoot, skillDirectory);
  return sha256(`${JSON.stringify({ version: 1, files })}\n`);
}

async function candidate(root: SearchRoot, segments: string[]): Promise<(SkillCandidate & { entrypoint: string }) | undefined> {
  if (!path.isAbsolute(root.directory)) error("WSSPEC_SKILL_PATH_INVALID", "Skill 搜索根必须是绝对路径。");
  if (!(await exists(root.directory))) return undefined;
  try {
    if (!(await stat(root.directory)).isDirectory()) error("WSSPEC_SKILL_PATH_INVALID", "Skill 搜索根必须是目录。");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") error("WSSPEC_SKILL_PATH_ESCAPE", "Skill 搜索根是悬空符号链接。");
    throw caught;
  }
  const skillDirectory = path.join(root.directory, ...segments);
  const entrypoint = path.join(skillDirectory, "SKILL.md");
  if (!(await exists(skillDirectory))) return undefined;
  await assertSkillPath(root.directory, skillDirectory);
  if (!(await stat(skillDirectory)).isDirectory()) error("WSSPEC_SKILL_PATH_INVALID", "Skill 必须是目录。");
  if (!(await exists(entrypoint))) return undefined;
  await assertSkillPath(root.directory, entrypoint);
  if (!(await stat(entrypoint)).isFile()) error("WSSPEC_SKILL_PATH_INVALID", "Skill 必须包含普通文件 SKILL.md。");
  return { rootId: root.rootId, entrypoint, digest: await skillDirectoryDigest(root.directory, skillDirectory) };
}

function globalRoots(context: SkillResolverContext): SearchRoot[] {
  if (!path.isAbsolute(context.home)) error("WSSPEC_SKILL_PATH_INVALID", "Skill Resolver home 必须是绝对路径。");
  const defaults = defaultGlobalRoots[context.provider].map((relative, index) => ({
    rootId: `${context.provider}:default:${index}`,
    directory: path.join(context.home, ...relative.split("/")),
  }));
  const additional = (context.additionalGlobalRoots ?? []).map((configured, index) => {
    let directory: string;
    if (path.isAbsolute(configured)) directory = path.resolve(configured);
    else if (configured === "~") directory = context.home;
    else if (configured.startsWith("~/")) directory = path.resolve(context.home, configured.slice(2));
    else error("WSSPEC_SKILL_PATH_INVALID", "附加 Global Skill 根必须是绝对路径或 ~/ 路径。");
    return { rootId: `${context.provider}:additional:${index}`, directory };
  });
  return [...defaults, ...additional];
}

async function resolveGlobal(parsed: ParsedSkillRef, context: SkillResolverContext): Promise<ResolvedReference | undefined> {
  const found = (await Promise.all(globalRoots(context).map((root) => candidate(root, parsed.segments)))).filter((item): item is SkillCandidate & { entrypoint: string } => item !== undefined);
  if (found.length === 0) return undefined;
  if (new Set(found.map(({ digest }) => digest)).size !== 1) error("WSSPEC_SKILL_AMBIGUOUS", `Global Skill ${parsed.ref} 在多个根中内容不一致。`);
  const selected = found[0]!;
  return {
    ref: parsed.ref,
    source: "global",
    rootId: selected.rootId,
    entrypoint: selected.entrypoint,
    digest: selected.digest,
    candidates: found.map(({ rootId, digest }) => ({ rootId, digest })),
  };
}

async function resolveBuiltin(parsed: ParsedSkillRef): Promise<ResolvedReference | undefined> {
  const id = parsed.segments[1]!;
  const catalog = await loadBuiltinCatalog();
  const skill = catalog.skills.find((item) => item.id === id);
  if (skill === undefined) return undefined;
  const skillsRoot = path.join(builtinResourcesRoot(), "skills");
  const skillDirectory = path.join(skillsRoot, id);
  await assertSkillPath(skillsRoot, skillDirectory);
  await assertSkillPath(skillsRoot, skill.entry);
  const digest = await skillDirectoryDigest(skillsRoot, skillDirectory);
  return { ref: parsed.ref, source: "builtin", rootId: "builtin", entrypoint: skill.entry, digest, candidates: [{ rootId: "builtin", digest }] };
}

async function resolvePackage(parsed: ParsedSkillRef, context: SkillResolverContext): Promise<ResolvedReference | undefined> {
  const id = parsed.segments[1]!;
  if (!context.package.manifest.skills.includes(id)) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED", "Skill 未在当前 Workflow Package Manifest 中声明。");
  const declared = context.package.packageSkills.get(parsed.ref);
  if (declared === undefined) throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_SKILL_UNDECLARED", "Skill 未进入当前 Workflow Package 文件清单。");
  const expectedEntrypoint = path.join(context.package.root, "skills", id, "SKILL.md");
  if (path.resolve(declared.entrypoint) !== path.resolve(expectedEntrypoint)) error("WSSPEC_SKILL_PATH_INVALID", "Package Skill 入口与当前 Package 不一致。");
  const skillDirectory = path.join(context.package.root, "skills", id);
  await assertSkillPath(context.package.root, skillDirectory);
  await assertSkillPath(context.package.root, expectedEntrypoint);
  const prefix = `skills/${id}/`;
  const snapshotFiles = context.package.files.filter(({ path: relative }) => relative.startsWith(prefix));
  const snapshotDigest = workflowPackageContentDigest(snapshotFiles);
  const currentFiles = (await collectSkillFiles(context.package.root, skillDirectory)).map((file) => ({
    path: `${prefix}${file.path}`,
    digest: file.digest,
  }));
  const currentDigest = workflowPackageContentDigest(currentFiles);
  if (snapshotDigest !== declared.digest || currentDigest !== declared.digest) {
    throw new WorkflowPackageError("WSSPEC_WORKFLOW_PACKAGE_LOCK_INVALID", "Package Skill 当前内容与 WorkflowPackage 快照不一致。");
  }
  const candidate = { rootId: "package", digest: declared.digest };
  return { ref: parsed.ref, source: "package", rootId: candidate.rootId, entrypoint: expectedEntrypoint, digest: candidate.digest, candidates: [candidate] };
}

async function resolveProject(parsed: ParsedSkillRef, context: SkillResolverContext): Promise<ResolvedReference | undefined> {
  if (!path.isAbsolute(context.projectRoot)) error("WSSPEC_SKILL_PATH_INVALID", "Skill Resolver projectRoot 必须是绝对路径。");
  const projectSkillsRoot = path.join(context.projectRoot, ".wsspec", "skills");
  const found = await candidate({ rootId: "project", directory: projectSkillsRoot }, parsed.segments.slice(1));
  if (found === undefined) return undefined;
  return { ref: parsed.ref, source: "project", rootId: found.rootId, entrypoint: found.entrypoint, digest: found.digest, candidates: [{ rootId: found.rootId, digest: found.digest }] };
}

async function resolveReference(ref: string, context: SkillResolverContext): Promise<ResolvedReference | undefined> {
  const parsed = parseSkillRef(ref);
  if (parsed.source === "builtin") return resolveBuiltin(parsed);
  if (parsed.source === "package") return resolvePackage(parsed, context);
  if (parsed.source === "project") return resolveProject(parsed, context);
  return resolveGlobal(parsed, context);
}

function fallbackDescriptor(fallback: ResolvedReference): ResolvedSkillFallback {
  return { ref: fallback.ref, source: fallback.source, rootId: fallback.rootId, digest: fallback.digest };
}

function assertLockIdentity(lock: SkillLockEntry, binding: WorkflowSkillBinding, context: SkillResolverContext): void {
  if (lock.requested !== binding.ref || lock.provider !== context.provider || lock.required !== (binding.required ?? true)) {
    error("WSSPEC_SKILL_LOCK_CHANGED", "Skill Lock 与当前绑定或 Provider 不一致。");
  }
}

function assertSelectedLock(lock: SkillLockEntry, selected: ResolvedReference, usedFallback: boolean): void {
  if (lock.resolved !== selected.ref || lock.digest !== selected.digest || lock.rootId !== selected.rootId || lock.usedFallback !== usedFallback) {
    error("WSSPEC_SKILL_LOCK_CHANGED", "Skill 当前解析结果与已有 Lock 不一致。");
  }
}

export function resolveSkill(binding: WorkflowSkillBinding & { required: false }, context: SkillResolverContext): Promise<ResolvedSkill | undefined>;
export function resolveSkill(binding: WorkflowSkillBinding & { required?: true }, context: SkillResolverContext): Promise<ResolvedSkill>;
export function resolveSkill(binding: WorkflowSkillBinding, context: SkillResolverContext): Promise<ResolvedSkill | undefined>;
export async function resolveSkill(binding: WorkflowSkillBinding, context: SkillResolverContext): Promise<ResolvedSkill | undefined> {
  const requested = parseSkillRef(binding.ref);
  if (binding.fallback !== undefined) {
    const fallbackRef = parseSkillRef(binding.fallback);
    if (requested.source !== "global" || fallbackRef.source !== "builtin") error("WSSPEC_SKILL_FALLBACK_INVALID", "首版只允许 Global Skill 显式回退到 Builtin Skill。");
  }
  const required = binding.required ?? true;
  let locked: SkillLockEntry | undefined;
  if (context.lock !== undefined) {
    const matches = context.lock.skills.filter(({ requested }) => requested === binding.ref);
    if (matches.length !== 1) error("WSSPEC_SKILL_LOCK_CHANGED", "Skill Lock 缺少当前绑定或包含重复绑定。");
    locked = matches[0]!;
    assertLockIdentity(locked, binding, context);
  }
  const [primary, fallback] = await Promise.all([
    resolveReference(binding.ref, context),
    binding.fallback === undefined ? Promise.resolve(undefined) : resolveReference(binding.fallback, context),
  ]);

  let selected = primary;
  let usedFallback = false;
  if (selected === undefined && fallback !== undefined) {
    selected = fallback;
    usedFallback = true;
  }
  if (selected === undefined) {
    if (!required) return undefined;
    error("WSSPEC_SKILL_NOT_FOUND", `找不到必需 Skill ${binding.ref}${binding.fallback === undefined ? "" : " 或其 fallback"}。`);
  }

  if (locked !== undefined) {
    assertSelectedLock(locked, selected, usedFallback);
    if (usedFallback) {
      if (locked.fallback !== selected.ref || locked.fallbackDigest !== selected.digest) {
        error("WSSPEC_SKILL_LOCK_CHANGED", "Global Skill fallback 未锁定或摘要已变化。");
      }
    }
  }

  return {
    requestedRef: binding.ref,
    ref: selected.ref,
    source: selected.source,
    provider: context.provider,
    rootId: selected.rootId,
    entrypoint: selected.entrypoint,
    digest: selected.digest,
    candidates: selected.candidates,
    required,
    usedFallback,
    ...(fallback === undefined ? {} : { fallback: fallbackDescriptor(fallback) }),
  };
}
