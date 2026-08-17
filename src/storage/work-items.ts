import { access, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

import { computeWorkspaceTreeDigest, sha256 } from "../domain/digests.js";
import type { RepositoryId, WorkItemId } from "../domain/ids.js";
import { validate } from "../schemas/index.js";
import { writeFileAtomic } from "./files.js";
import { runGit } from "./git.js";
import { loadRepository } from "./repository.js";

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
    type: "prompt" | "file";
    snapshot: string;
    contentDigest: string;
  };
  bindings: { issue: null; knowledge: null };
}

export class WorkItemError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkItemError";
  }
}

interface SnapshotSource {
  version: 1;
  type: "prompt" | "file";
  capturedAt: string;
  origin: string;
  content: { text: string };
  contentDigest: string;
}

interface ParsedConfig {
  git: { worktrees: { root: string; branchPrefix: string } };
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicSchemas = path.join(packageRoot, "schemas");
const workItemIdPattern = /^WSS-[A-Za-z0-9-]+$/;

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

async function snapshotSource(root: string, source: PromptSource | FileSource, capturedAt: string): Promise<SnapshotSource> {
  let origin: string;
  let text: string;
  if (source.type === "prompt") {
    origin = "prompt";
    text = source.content;
  } else {
    const absolute = path.resolve(root, source.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new WorkItemError("WSSPEC_SOURCE_PATH_INVALID", "需求来源必须位于当前仓库内。");
    }
    const [realRoot, realSource] = await Promise.all([realpath(root), realpath(absolute)]);
    const realRelative = path.relative(realRoot, realSource);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new WorkItemError("WSSPEC_SOURCE_PATH_INVALID", "需求来源的真实路径越出当前仓库。");
    }
    if (![".md", ".txt"].includes(path.extname(relative).toLowerCase())) {
      throw new WorkItemError("WSSPEC_SOURCE_TYPE_UNSUPPORTED", "M1 只支持 Markdown 和 TXT 文件来源。");
    }
    origin = relative.split(path.sep).join("/");
    text = await readFile(absolute, "utf8");
  }
  if (text.trim() === "") {
    throw new WorkItemError("WSSPEC_SOURCE_EMPTY", "需求来源不能为空。");
  }
  return { version: 1, type: source.type, capturedAt, origin, content: { text }, contentDigest: sha256(text) };
}

async function readProjectContracts(root: string): Promise<{
  workflowText: string;
  configText: string;
  config: ParsedConfig;
}> {
  const workflowText = await readFile(path.join(root, ".wsspec", "workflow.yaml"), "utf8");
  const configText = await readFile(path.join(root, ".wsspec", "config.yaml"), "utf8");
  validate("builtin.workflow.v1", parse(workflowText));
  const config = validate<ParsedConfig>("builtin.project-config.v1", parse(configText));
  return { workflowText, configText, config };
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

export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
  if (!workItemIdPattern.test(input.workItemId) || input.title.trim() === "") {
    throw new WorkItemError("WSSPEC_WORK_ITEM_INVALID", "Work Item ID 或标题不合法。");
  }
  const identity = await loadRepository(input.root);
  const root = identity.repositoryRoot;
  const { workflowText, configText, config } = await readProjectContracts(root);
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
  const source = await snapshotSource(root, input.source, createdAt);
  const baselineRevision = await runGit(root, ["rev-parse", "HEAD"]);
  const baselineTreeDigest = await computeWorkspaceTreeDigest(root);

  await runGit(root, ["worktree", "add", "-b", branch, worktree, baselineRevision]);

  const itemRoot = path.join(worktree, ".wsspec", "work-items", input.workItemId);
  const snapshotRoot = path.join(itemRoot, "snapshot");
  await writeFileAtomic(path.join(snapshotRoot, "workflow.yaml"), workflowText);
  await writeFileAtomic(path.join(snapshotRoot, "config.yaml"), configText);
  const schemaDigest = await snapshotSchemas(path.join(snapshotRoot, "schemas"));
  await writeFileAtomic(path.join(itemRoot, "source", "source.json"), `${JSON.stringify(source, null, 2)}\n`);

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
      configDigest: sha256(configText),
      schemaDigest,
    },
    source: {
      type: source.type,
      snapshot: "source/source.json",
      contentDigest: source.contentDigest,
    },
    bindings: { issue: null, knowledge: null },
  };
  validate("builtin.work-item.v1", workItem);
  await writeFileAtomic(path.join(itemRoot, "work-item.yaml"), stringify(workItem, { lineWidth: 0 }));
  await writeFileAtomic(
    locator,
    `${JSON.stringify(
      {
        version: 1,
        repositoryId: identity.repositoryId,
        workItemId: input.workItemId,
        worktree: worktreeRelative,
        snapshot: `.wsspec/work-items/${input.workItemId}/snapshot`,
      },
      null,
      2,
    )}\n`,
  );
  return workItem;
}
