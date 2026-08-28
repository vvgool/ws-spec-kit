import { access, cp, lstat, mkdir, open, readFile, realpath, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

import { computeWorkspaceTreeDigest, sha256 } from "../domain/digests.js";
import type { RepositoryId, WorkItemId } from "../domain/ids.js";
import {
  captureRequirement,
  requirementTitle,
  sourceArtifactReference,
  type CaptureRequirementSource,
  type NormalizedRequirementSource,
} from "../registry/connectors/requirement-source.js";
import { validate } from "../schemas/index.js";
import { writeFileAtomic } from "./files.js";
import { runGit, runGitRaw } from "./git.js";
import { portableProjectConfigText } from "./project-config.js";
import { loadRepository, type RepositoryIdentity } from "./repository.js";

interface PromptSource {
  type: "prompt";
  content: string;
}

interface FileSource {
  type: "file";
  path: string;
}

interface ExternalSource {
  type: "issue";
  provider: string;
  id: string;
  url?: string;
}

type ExternalCapturedSource = Omit<NormalizedRequirementSource, "type"> & {
  type: "github.issue" | "gitlab.issue" | "feishu.document";
};

export interface CreateWorkItemInput {
  root: string;
  workItemId: WorkItemId;
  title: string;
  source: PromptSource | FileSource | ExternalSource;
  createdAt?: string;
  materialize?: boolean;
  capturedSource?: {
    type: "prompt" | "file";
    origin: string;
    text: string;
    contentDigest: string;
  } | ExternalCapturedSource;
  application?: {
    workflowText: string;
    configText: string;
    worktreeRoot?: string;
    branchPrefix?: string;
  };
}

export interface WorkItem {
  version: 1;
  workItemId: WorkItemId;
  repositoryId: RepositoryId;
  title: string;
  createdAt: string;
  status: "active";
  execution: {
    worktree: string;
    branch: string;
    materialized?: boolean;
    baselineRevision: string;
    baselineTreeDigest: string;
    workflowDigest: string;
    configDigest: string;
    schemaDigest?: string;
  };
  source: {
    type: NormalizedRequirementSource["type"];
    artifactId: string;
    snapshot: string;
    contentDigest: string;
    artifactDigest: string;
  };
  bindings: { issue: null; knowledge: null };
}

export class WorkItemError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkItemError";
  }
}

interface ParsedConfig {
  git: { worktrees: { root: string; branchPrefix: string } };
}

const workItemIdPattern = /^WSS-[A-Za-z0-9-]+$/;
const creationOwner = Symbol("wsspec.creationOwner");
type OwnedWorkItem = WorkItem & { [creationOwner]?: string };

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await runGit(root, ["show-ref", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function baselineTreeDigestForRevision(root: string, revision: string): Promise<string> {
  const raw = await runGitRaw(root, ["ls-tree", "-r", "-z", revision]);
  const entries: Array<Record<string, string>> = [];
  for (const record of raw.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new WorkItemError("WSSPEC_GIT_PROCESS_FAILED", "Baseline Git tree 条目不合法。");
    const parts = record.slice(0, separator).split(" ");
    const mode = parts[0];
    const type = parts[1];
    const object = parts[2];
    const relativePath = record.slice(separator + 1);
    if (!mode || !type || !object || !relativePath) throw new WorkItemError("WSSPEC_GIT_PROCESS_FAILED", "Baseline Git tree 条目不完整。");
    const content = await runGitRaw(root, ["cat-file", "blob", object!]);
    entries.push(mode === "120000"
      ? { path: relativePath, type: "symlink", mode, target: content }
      : { path: relativePath, type: "file", mode, digest: sha256(content) });
  }
  entries.sort((left, right) => Buffer.from(left.path ?? "").compare(Buffer.from(right.path ?? "")));
  return sha256(`${JSON.stringify({ version: 1, entries })}\n`);
}

function repositoryRelativePath(root: string, configuredPath: string): { absolute: string; relative: string } {
  if (path.isAbsolute(configuredPath)) {
    throw new WorkItemError("WSSPEC_CONTROL_PLANE_INVALID", "M1 worktree root 必须是仓库相对路径。");
  }
  const absolute = path.resolve(root, configuredPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new WorkItemError("WSSPEC_CONTROL_PLANE_INVALID", "worktree 路径越出仓库允许边界。");
  }
  return { absolute, relative: relative.split(path.sep).join("/") };
}

async function assertRealPathContained(root: string, target: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new WorkItemError("WSSPEC_CONTROL_PLANE_INVALID", "worktree 根目录的真实路径越出仓库允许边界。");
  }
}

function requirementCaptureSource(input: CreateWorkItemInput): CaptureRequirementSource {
  const source = input.source;
  if (input.capturedSource === undefined) {
    if (source.type === "issue") {
      throw new WorkItemError("WSSPEC_SOURCE_SNAPSHOT_INVALID", "外部需求来源必须先经过 Connector 捕获。 ");
    }
    return source.type === "prompt"
      ? { type: "user.prompt", text: source.content }
      : { type: "local.file", path: source.path };
  }
  const captured = input.capturedSource;
  if (source.type === "issue") {
    if (captured.type === "prompt" || captured.type === "file") {
      throw new WorkItemError("WSSPEC_SOURCE_SNAPSHOT_INVALID", "外部预捕获来源与 Work Item 输入不一致。 ");
    }
    const expectedProvider = captured.type === "github.issue" ? ["github", "github-cli"]
      : captured.type === "gitlab.issue" ? ["gitlab", "gitlab-cli"]
        : ["feishu", "lark-cli"];
    if (!expectedProvider.includes(source.provider)) {
      throw new WorkItemError("WSSPEC_SOURCE_SNAPSHOT_INVALID", "外部预捕获来源 Provider 不一致。 ");
    }
    return captured as ExternalCapturedSource;
  }
  if (captured.type !== "prompt" && captured.type !== "file") {
    throw new WorkItemError("WSSPEC_SOURCE_SNAPSHOT_INVALID", "本地预捕获来源与 Work Item 输入不一致。 ");
  }
  if (captured.type !== source.type || captured.origin === "" || captured.text.trim() === "" || sha256(captured.text) !== captured.contentDigest) {
    throw new WorkItemError("WSSPEC_SOURCE_SNAPSHOT_INVALID", "预捕获需求来源与 Work Item 输入不一致。");
  }
  return {
    type: captured.type === "prompt" ? "user.prompt" : "local.file",
    stableId: captured.type === "prompt" ? captured.contentDigest : captured.origin,
    title: requirementTitle(captured.text),
    body: captured.text,
    metadata: {},
  };
}

async function readProjectContracts(root: string, application?: CreateWorkItemInput["application"]): Promise<{
  workflowText: string;
  configText: string;
  config: ParsedConfig;
}> {
  if (application !== undefined) {
    return {
      workflowText: application.workflowText,
      configText: application.configText,
      config: { git: { worktrees: { root: application.worktreeRoot ?? ".worktrees", branchPrefix: application.branchPrefix ?? "wspec/" } } },
    };
  }
  const workflowText = await readFile(path.join(root, ".wsspec", "workflow.yaml"), "utf8");
  const configText = await readFile(path.join(root, ".wsspec", "config.yaml"), "utf8");
  validate("builtin.workflow-selection.v1", parse(workflowText));
  const config = validate<Record<string, unknown>>("builtin.application-project-config.v1", parse(configText));
  const git = config.git as { worktrees?: { root?: string; branchPrefix?: string } } | undefined;
  return {
    workflowText,
    configText,
    config: { git: { worktrees: { root: git?.worktrees?.root ?? ".worktrees", branchPrefix: git?.worktrees?.branchPrefix ?? "wspec/" } } },
  };
}

async function writeFileExclusive(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeOwnedApplicationControlPlane(input: {
  workItemRoot: string;
  repositoryId: string;
  workItemId: string;
  ownerToken: string;
}): Promise<void> {
  const controlPlane = path.join(input.workItemRoot, "control-plane");
  let target;
  try {
    target = await lstat(controlPlane);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!target.isDirectory()) return;
  const anchorPath = path.join(controlPlane, "application-anchor.json");
  let anchor: Record<string, unknown>;
  try {
    anchor = JSON.parse(await readFile(anchorPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (anchor.version !== 1 || anchor.workItemId !== input.workItemId || anchor.ownerToken !== input.ownerToken) return;

  const runtimePath = path.join(controlPlane, "runtime.json");
  try {
    const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as Record<string, unknown>;
    if (runtime.repositoryId === input.repositoryId && runtime.workItemId === input.workItemId) await unlink(runtimePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  await unlink(anchorPath);
  await rmdir(controlPlane).catch((error: unknown) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  });
}

export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
  if (!workItemIdPattern.test(input.workItemId) || input.title.trim() === "") {
    throw new WorkItemError("WSSPEC_WORK_ITEM_INVALID", "Work Item ID 或标题不合法。");
  }
  const identity = await loadRepository(input.root);
  const root = identity.repositoryRoot;
  const { workflowText, configText, config } = await readProjectContracts(root, input.application);
  const portableConfigText = portableProjectConfigText(parse(configText));
  const worktreeRoot = repositoryRelativePath(root, config.git.worktrees.root);
  const branch = `${config.git.worktrees.branchPrefix}${input.workItemId}`;
  const worktree = path.join(worktreeRoot.absolute, input.workItemId);
  const worktreeRelative = `${worktreeRoot.relative}/${input.workItemId}`;
  const locator = path.join(identity.commonDir, "wsspec", "work-items", input.workItemId, "locator.json");

  if ((await exists(worktree)) || (await exists(locator)) || (await branchExists(root, branch))) {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ID_CONFLICT", `Work Item 目标已存在：${input.workItemId}`);
  }

  const materialize = input.materialize ?? true;
  if (materialize) {
    await mkdir(worktreeRoot.absolute, { recursive: true });
    await assertRealPathContained(root, worktreeRoot.absolute);
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const baselineRevision = await runGit(root, ["rev-parse", "HEAD"]);
  const ownerToken = crypto.randomUUID();

  if (materialize) await runGit(root, ["worktree", "add", "-b", branch, worktree, baselineRevision]);
  try {
    const baselineTreeDigest = materialize ? await computeWorkspaceTreeDigest(worktree) : await baselineTreeDigestForRevision(root, baselineRevision);
    const itemRoot = materialize
      ? path.join(worktree, ".wsspec", "work-items", input.workItemId)
      : path.join(identity.commonDir, "wsspec", "work-items", input.workItemId, "authority");
    const snapshotRoot = path.join(itemRoot, "snapshot");
    await writeFileAtomic(path.join(snapshotRoot, "config.yaml"), portableConfigText);
    const source = await captureRequirement({
      repositoryRoot: root,
      artifactRoot: materialize ? worktree : itemRoot,
      ...(materialize ? {} : {
        artifactRootRepositoryRoot: identity.commonDir,
        artifactPathPrefix: `.wsspec/work-items/${input.workItemId}`,
      }),
      workItemId: input.workItemId,
      source: requirementCaptureSource(input),
    });
    const sourceReference = sourceArtifactReference(input.workItemId, source);
    const itemRelativeSource = path.posix.relative(`.wsspec/work-items/${input.workItemId}`, sourceReference.path);

    const workItem: WorkItem = {
      version: 1,
      workItemId: input.workItemId,
      repositoryId: identity.repositoryId,
      title: input.title,
      createdAt,
      status: "active",
      execution: {
        worktree: worktreeRelative,
        branch,
        materialized: materialize,
        baselineRevision,
        baselineTreeDigest,
        workflowDigest: sha256(workflowText),
        configDigest: sha256(portableConfigText),
      },
      source: {
        type: source.type,
        artifactId: source.artifactId,
        snapshot: itemRelativeSource,
        contentDigest: source.contentDigest,
        artifactDigest: sourceReference.contentHash,
      },
      bindings: { issue: null, knowledge: null },
    };
    validate("builtin.work-item.v1", workItem);
    await writeFileAtomic(path.join(itemRoot, "work-item.yaml"), stringify(workItem, { lineWidth: 0 }));
    await writeFileExclusive(
      locator,
      `${JSON.stringify(
        {
          version: 1,
          repositoryId: identity.repositoryId,
          workItemId: input.workItemId,
          worktree: worktreeRelative,
          ownerToken,
          ...(materialize ? {} : { authorityRoot: "authority" }),
          materialized: materialize,
          snapshot: materialize ? `.wsspec/work-items/${input.workItemId}/snapshot` : "authority/snapshot",
        },
        null,
        2,
      )}\n`,
    );
    Object.defineProperty(workItem, creationOwner, { value: ownerToken });
    return workItem;
  } catch (error) {
    try {
      if (!materialize) {
        await rm(path.join(identity.commonDir, "wsspec", "work-items", input.workItemId), { recursive: true }).catch(() => undefined);
      } else await rollbackWorktreeResources({
        identity,
        workItemId: input.workItemId,
        worktree: worktreeRelative,
        branch,
        baselineRevision,
        ownerToken,
        locatorMode: "creating",
      });
    } catch {
      throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_FAILED", "Work Item 创建失败且无法安全回滚。");
    }
    throw error;
  }
}

/** Materialize a delayed Work Item. The caller must hold its control-plane lock. */
export async function materializeWorkItem(input: { root: string; item: WorkItem }): Promise<WorkItem> {
  const identity = await loadRepository(input.root);
  if (input.item.repositoryId !== identity.repositoryId) {
    throw new WorkItemError("WSSPEC_REPOSITORY_ID_MISMATCH", "Work Item 与当前仓库身份不一致。");
  }
  if (input.item.execution.materialized !== false) return input.item;
  const worktree = path.resolve(identity.repositoryRoot, input.item.execution.worktree);
  await mkdir(path.dirname(worktree), { recursive: true });
  await assertRealPathContained(identity.repositoryRoot, path.dirname(worktree));
  if (await exists(worktree) || await branchExists(identity.repositoryRoot, input.item.execution.branch)) {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ID_CONFLICT", `Work Item 目标已存在：${input.item.workItemId}`);
  }
  const workItemRoot = path.join(identity.commonDir, "wsspec", "work-items", input.item.workItemId);
  const manifestPath = path.join(workItemRoot, "authority", "work-item.yaml");
  const locatorPath = path.join(workItemRoot, "locator.json");
  const anchorPath = path.join(workItemRoot, "control-plane", "application-anchor.json");
  const [originalManifest, originalLocator] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(locatorPath, "utf8"),
  ]);
  const locator = JSON.parse(originalLocator) as Record<string, unknown>;
  if (locator.version !== 1 || locator.repositoryId !== identity.repositoryId || locator.workItemId !== input.item.workItemId
    || locator.worktree !== input.item.execution.worktree || locator.ownerToken === undefined
    || locator.authorityRoot !== "authority" || locator.materialized !== false) {
    throw new WorkItemError("WSSPEC_WORK_ITEM_LOCATION_INVALID", "未物化 Work Item locator 与 authority 不一致。");
  }
  let originalAnchor: string | undefined;
  try { originalAnchor = await readFile(anchorPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    await runGit(identity.repositoryRoot, ["worktree", "add", "-b", input.item.execution.branch, worktree, input.item.execution.baselineRevision]);
    const updated: WorkItem = { ...input.item, execution: { ...input.item.execution, materialized: true } };
    validate("builtin.work-item.v1", updated);
    await writeFileAtomic(manifestPath, stringify(updated, { lineWidth: 0 }));
    await writeFileAtomic(locatorPath, `${JSON.stringify({ ...locator, materialized: true }, null, 2)}\n`);
    if (originalAnchor !== undefined) {
      const anchor = JSON.parse(originalAnchor) as Record<string, unknown>;
      await writeFileAtomic(anchorPath, `${JSON.stringify({ ...anchor, manifestDigest: sha256(stringify(updated, { lineWidth: 0 })) }, null, 2)}\n`);
    }
    const worktreeItemRoot = path.join(worktree, ".wsspec", "work-items", input.item.workItemId);
    await mkdir(path.dirname(worktreeItemRoot), { recursive: true });
    await cp(path.join(workItemRoot, "authority"), worktreeItemRoot, { recursive: true, force: false });
    await writeFileAtomic(path.join(worktreeItemRoot, "work-item.yaml"), stringify(updated, { lineWidth: 0 }));
    return updated;
  } catch (error) {
    const restored = await Promise.allSettled([
      writeFileAtomic(manifestPath, originalManifest),
      writeFileAtomic(locatorPath, originalLocator),
      ...(originalAnchor === undefined ? [] : [writeFileAtomic(anchorPath, originalAnchor)]),
    ]);
    const worktreeRemoved = await exists(worktree)
      ? await runGit(identity.repositoryRoot, ["worktree", "remove", "--force", worktree]).then(() => true, () => false)
      : true;
    const branchRemoved = worktreeRemoved && await branchExists(identity.repositoryRoot, input.item.execution.branch)
      ? await runGit(identity.repositoryRoot, ["branch", "-D", "--", input.item.execution.branch]).then(() => true, () => false)
      : worktreeRemoved;
    if (restored.some(({ status }) => status === "rejected") || !worktreeRemoved || !branchRemoved) {
      throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_FAILED", "Worktree 物化失败且无法安全回滚。");
    }
    throw error;
  }
}

async function rollbackWorktreeResources(input: {
  identity: RepositoryIdentity;
  workItemId: WorkItemId;
  worktree: string;
  branch: string;
  baselineRevision: string;
  ownerToken: string;
  locatorMode: "creating" | "published";
}): Promise<void> {
  if (!workItemIdPattern.test(input.workItemId)) {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "回滚目标与当前仓库身份不一致。");
  }
  const expectedWorktree = path.resolve(input.identity.repositoryRoot, input.worktree);
  const [realRoot, realWorktree] = await Promise.all([realpath(input.identity.repositoryRoot), realpath(expectedWorktree)]);
  const relative = path.relative(realRoot, realWorktree);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "回滚 worktree 越出仓库边界。");
  }
  const workItemRoot = path.join(input.identity.commonDir, "wsspec", "work-items", input.workItemId);
  const locatorPath = path.join(workItemRoot, "locator.json");
  const expectedLocator = {
    repositoryId: input.identity.repositoryId,
    workItemId: input.workItemId,
    worktree: input.worktree,
    ownerToken: input.ownerToken,
  };
  const locatorOwnership = async (): Promise<"absent" | "owned" | "foreign"> => {
    let target;
    try {
      target = await lstat(locatorPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    if (!target.isFile()) return "foreign";
    let locator: Record<string, unknown>;
    try {
      locator = JSON.parse(await readFile(locatorPath, "utf8")) as Record<string, unknown>;
    } catch {
      return "foreign";
    }
    return locator.repositoryId !== expectedLocator.repositoryId
      || locator.workItemId !== expectedLocator.workItemId
      || locator.worktree !== expectedLocator.worktree
      || locator.ownerToken !== expectedLocator.ownerToken
      ? "foreign"
      : "owned";
  };
  const initialLocator = await locatorOwnership();
  if (input.locatorMode === "published" && initialLocator !== "owned") {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "回滚 locator 与本次创建身份不一致。");
  }
  const worktrees = await runGit(input.identity.repositoryRoot, ["worktree", "list", "--porcelain"]);
  const registered = worktrees.split(/\n\n/u).find((entry) => entry.split("\n")[0] === `worktree ${realWorktree}`);
  if (registered === undefined || !registered.split("\n").includes(`branch refs/heads/${input.branch}`)) {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "回滚 worktree 与预期 branch 绑定不一致。");
  }
  const branchRef = `refs/heads/${input.branch}`;
  if (await runGit(input.identity.repositoryRoot, ["rev-parse", branchRef]) !== input.baselineRevision) {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "回滚 branch 已产生新 revision，拒绝删除。");
  }
  await runGit(input.identity.repositoryRoot, ["worktree", "remove", "--force", realWorktree]);
  if (await runGit(input.identity.repositoryRoot, ["rev-parse", branchRef]) !== input.baselineRevision) {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "回滚 branch 在 worktree 移除期间发生变化，拒绝删除。");
  }
  const finalLocator = await locatorOwnership();
  if (input.locatorMode === "published" && finalLocator !== "owned") {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "回滚期间 locator 已变化，拒绝继续删除 branch。");
  }
  await runGit(input.identity.repositoryRoot, ["branch", "-D", "--", input.branch]);
  if (finalLocator === "owned") await unlink(locatorPath);
  await removeOwnedApplicationControlPlane({
    workItemRoot,
    repositoryId: input.identity.repositoryId,
    workItemId: input.workItemId,
    ownerToken: input.ownerToken,
  });
  await rmdir(workItemRoot).catch((error: unknown) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  });
}

export function creationOwnerForWorkItem(item: WorkItem): string {
  const ownerToken = (item as OwnedWorkItem)[creationOwner];
  if (ownerToken === undefined) throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "Work Item 缺少本次创建 owner 身份。");
  return ownerToken;
}

export async function rollbackCreatedWorkItem(input: { root: string; item: WorkItem }): Promise<void> {
  const identity = await loadRepository(input.root);
  if (input.item.repositoryId !== identity.repositoryId) {
    throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "回滚目标与当前仓库身份不一致。");
  }
  const ownerToken = creationOwnerForWorkItem(input.item);
  if (input.item.execution.materialized === false) {
    const workItemRoot = path.join(identity.commonDir, "wsspec", "work-items", input.item.workItemId);
    const locatorPath = path.join(workItemRoot, "locator.json");
    let locator: Record<string, unknown>;
    try {
      locator = JSON.parse(await readFile(locatorPath, "utf8")) as Record<string, unknown>;
    } catch {
      throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "未物化 Work Item locator 不可验证。");
    }
    if (locator.repositoryId !== identity.repositoryId || locator.workItemId !== input.item.workItemId
      || locator.ownerToken !== ownerToken || locator.materialized !== false) {
      throw new WorkItemError("WSSPEC_WORK_ITEM_ROLLBACK_REFUSED", "未物化 Work Item locator 与本次创建身份不一致。");
    }
    await removeOwnedApplicationControlPlane({
      workItemRoot,
      repositoryId: identity.repositoryId,
      workItemId: input.item.workItemId,
      ownerToken,
    });
    await rm(workItemRoot, { recursive: true });
    return;
  }
  await rollbackWorktreeResources({
    identity,
    workItemId: input.item.workItemId,
    worktree: input.item.execution.worktree,
    branch: input.item.execution.branch,
    baselineRevision: input.item.execution.baselineRevision,
    ownerToken,
    locatorMode: "published",
  });
}
