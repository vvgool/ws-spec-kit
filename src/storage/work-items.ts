import { access, lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { runGit } from "./git.js";
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

export interface CreateWorkItemInput {
  root: string;
  workItemId: WorkItemId;
  title: string;
  source: PromptSource | FileSource;
  createdAt?: string;
  capturedSource?: {
    type: "prompt" | "file";
    origin: string;
    text: string;
    contentDigest: string;
  };
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
    baselineRevision: string;
    baselineTreeDigest: string;
    workflowDigest: string;
    configDigest: string;
    schemaDigest: string;
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

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicSchemas = path.join(packageRoot, "schemas");
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
    return source.type === "prompt"
      ? { type: "user.prompt", text: source.content }
      : { type: "local.file", path: source.path };
  }
  const captured = input.capturedSource;
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

async function snapshotSchemas(target: string): Promise<string> {
  const names = (await readdir(publicSchemas)).filter((name) => name.endsWith(".schema.json")).sort();
  const contents: string[] = [];
  await mkdir(target, { recursive: true });
  for (const name of names) {
    const content = await readFile(path.join(publicSchemas, name), "utf8");
    contents.push(`${name}\0${content}`);
    await writeFileAtomic(path.join(target, name), content);
  }
  return sha256(contents.join("\0"));
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

  await mkdir(worktreeRoot.absolute, { recursive: true });
  await assertRealPathContained(root, worktreeRoot.absolute);

  const createdAt = input.createdAt ?? new Date().toISOString();
  const baselineRevision = await runGit(root, ["rev-parse", "HEAD"]);
  const ownerToken = crypto.randomUUID();

  await runGit(root, ["worktree", "add", "-b", branch, worktree, baselineRevision]);
  try {
    const baselineTreeDigest = await computeWorkspaceTreeDigest(worktree);
    const itemRoot = path.join(worktree, ".wsspec", "work-items", input.workItemId);
    const snapshotRoot = path.join(itemRoot, "snapshot");
    await writeFileAtomic(path.join(snapshotRoot, "workflow.yaml"), workflowText);
    await writeFileAtomic(path.join(snapshotRoot, "config.yaml"), portableConfigText);
    const schemaDigest = await snapshotSchemas(path.join(snapshotRoot, "schemas"));
    const source = await captureRequirement({
      repositoryRoot: root,
      artifactRoot: worktree,
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
        baselineRevision,
        baselineTreeDigest,
        workflowDigest: sha256(workflowText),
        configDigest: sha256(portableConfigText),
        schemaDigest,
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
          snapshot: `.wsspec/work-items/${input.workItemId}/snapshot`,
        },
        null,
        2,
      )}\n`,
    );
    Object.defineProperty(workItem, creationOwner, { value: ownerToken });
    return workItem;
  } catch (error) {
    try {
      await rollbackWorktreeResources({
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
