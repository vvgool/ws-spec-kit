import { readFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";

import { testPathRules } from "../engine/tdd/types.js";
import { parse, stringify } from "yaml";

import type { RepositoryId } from "../domain/ids.js";
import { writeFileAtomic } from "./files.js";
import { gitCommonDir, repositoryRoot } from "./git.js";

export interface RepositoryIdentity {
  version: 1;
  repositoryId: RepositoryId;
  repositoryRoot: string;
  commonDir: string;
}

export class RepositoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

const repositoryIdPattern = /^repo-[0-9A-HJKMNP-TV-Z]{26}$/;

async function writeDefaultIfMissing(filename: string, content: string): Promise<void> {
  try {
    await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFileAtomic(filename, content);
  }
}

async function readIdentityFile(root: string): Promise<{ version: 1; repositoryId: RepositoryId }> {
  const filename = path.join(root, ".wsspec", "repository.yaml");
  let content: string;
  try {
    content = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RepositoryError("WSSPEC_REPOSITORY_NOT_INITIALIZED", "当前 Git 仓库尚未初始化 WSSpecKit。");
    }
    throw error;
  }
  const value = parse(content) as Record<string, unknown>;
  if (value.version !== 1 || typeof value.repositoryId !== "string" || !repositoryIdPattern.test(value.repositoryId)) {
    throw new RepositoryError("WSSPEC_REPOSITORY_ID_INVALID", ".wsspec/repository.yaml 不符合 Work Item v1。 ");
  }
  if (Object.keys(value).some((key) => key !== "version" && key !== "repositoryId")) {
    throw new RepositoryError("WSSPEC_REPOSITORY_ID_INVALID", ".wsspec/repository.yaml 包含未知字段。");
  }
  return { version: 1, repositoryId: value.repositoryId as RepositoryId };
}

async function synchronizeCache(identity: RepositoryIdentity): Promise<void> {
  const filename = path.join(identity.commonDir, "wsspec", "repository.json");
  try {
    const cached = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
    if (cached.repositoryId !== identity.repositoryId) {
      throw new RepositoryError("WSSPEC_REPOSITORY_ID_MISMATCH", "已提交仓库身份与 Git common-dir 缓存不一致。");
    }
    return;
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFileAtomic(
    filename,
    `${JSON.stringify({ version: 1, repositoryId: identity.repositoryId, repositoryRoot: identity.repositoryRoot }, null, 2)}\n`,
  );
}

export async function loadRepository(cwd: string): Promise<RepositoryIdentity> {
  let root: string;
  let commonDir: string;
  try {
    root = await repositoryRoot(cwd);
    commonDir = await gitCommonDir(cwd);
  } catch {
    throw new RepositoryError("WSSPEC_GIT_REPOSITORY_REQUIRED", "WSSpecKit 只能在 Git 仓库中运行。");
  }
  const file = await readIdentityFile(root);
  const identity: RepositoryIdentity = { ...file, repositoryRoot: root, commonDir };
  await synchronizeCache(identity);
  return identity;
}

export async function isRepositoryInitialized(cwd: string): Promise<boolean> {
  let root: string;
  try {
    root = await repositoryRoot(cwd);
  } catch {
    throw new RepositoryError("WSSPEC_GIT_REPOSITORY_REQUIRED", "WSSpecKit 只能在 Git 仓库中运行。");
  }
  try {
    await readIdentityFile(root);
    return true;
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "WSSPEC_REPOSITORY_NOT_INITIALIZED") return false;
    throw error;
  }
}

export async function initRepository(cwd: string): Promise<RepositoryIdentity> {
  let root: string;
  let commonDir: string;
  try {
    root = await repositoryRoot(cwd);
    commonDir = await gitCommonDir(cwd);
  } catch {
    throw new RepositoryError("WSSPEC_GIT_REPOSITORY_REQUIRED", "请先显式初始化 Git 仓库。");
  }
  const filename = path.join(root, ".wsspec", "repository.yaml");
  try {
    await readFile(filename, "utf8");
    return loadRepository(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const repositoryId = `repo-${ulid()}` as RepositoryId;
  await writeFileAtomic(filename, stringify({ version: 1, repositoryId }, { lineWidth: 0 }));
  await writeDefaultIfMissing(path.join(root, ".wsspec", "config.yaml"), stringify({
    version: 1,
    testing: { pathRules: [...testPathRules] },
  }, { lineWidth: 0 }));
  await writeDefaultIfMissing(path.join(root, ".wsspec", "workflow.yaml"), stringify({
    version: 1,
    activeWorkflow: { ref: "builtin://workflows/feature-delivery", version: 1 },
    profile: "auto",
  }, { lineWidth: 0 }));
  const identity: RepositoryIdentity = { version: 1, repositoryId, repositoryRoot: root, commonDir };
  await synchronizeCache(identity);
  return identity;
}
