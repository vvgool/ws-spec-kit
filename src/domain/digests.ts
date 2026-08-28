import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

import { repositoryRoot, runGitRaw } from "../storage/git.js";

export interface TreeEntry {
  path: string;
  type: "file" | "symlink" | "deleted";
  mode: "100644" | "100755" | "120000" | "deleted";
  digest?: string;
  target?: string;
}

export function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function volatileRuntimePath(candidate: string): boolean {
  return /^\.wsspec\/work-items\/[^/]+\/control-plane\/(?:runtime\.json|events\.jsonl|runtime\.lock)$/u.test(candidate);
}

function artifactPath(candidate: string): boolean {
  return /^\.wsspec\/work-items\/[^/]+\/artifacts\//u.test(candidate);
}

async function snapshotPaths(root: string, paths: readonly string[]): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  for (const relativePath of paths) {
    const absolutePath = path.join(root, relativePath);
    try {
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", mode: "120000", target: await readlink(absolutePath) });
      } else if (stat.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
          digest: sha256(await readFile(absolutePath)),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries.push({ path: relativePath, type: "deleted", mode: "deleted" });
      else throw error;
    }
  }
  return entries;
}

async function listedPaths(root: string): Promise<string[]> {
  const output = await runGitRaw(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return output.split("\0").filter((candidate) => candidate !== "")
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

async function artifactPaths(root: string): Promise<string[]> {
  const itemRoot = path.join(root, ".wsspec", "work-items");
  const result: string[] = [];
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), childRelative);
      else result.push(childRelative);
    }
  };
  let items: Dirent[];
  try { items = await readdir(itemRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  items.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const item of items) {
    if (!item.isDirectory()) continue;
    const artifacts = path.join(itemRoot, item.name, "artifacts");
    const relative = `.wsspec/work-items/${item.name}/artifacts`;
    let stat;
    try { stat = await lstat(artifacts); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isDirectory()) await walk(artifacts, relative);
    else result.push(relative);
  }
  return result.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

async function authorityArtifactPaths(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), childRelative);
      else result.push(childRelative);
    }
  };
  try { await walk(path.join(root, "artifacts"), "artifacts"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return result;
}

export async function computeWorkspaceSnapshot(cwd: string): Promise<TreeEntry[]> {
  const root = await repositoryRoot(cwd);
  const paths = (await listedPaths(root)).filter((candidate) => !artifactPath(candidate)
    && !volatileRuntimePath(candidate) && !candidate.startsWith(".wsspec/archive/"));
  return snapshotPaths(root, paths);
}

export async function computeWorkspaceTreeDigest(cwd: string): Promise<string> {
  const entries = await computeWorkspaceSnapshot(cwd);
  return sha256(`${JSON.stringify({ version: 1, entries })}\n`);
}

export async function computeArtifactTreeDigest(cwd: string, artifactRoot?: string): Promise<string> {
  const root = artifactRoot ?? await repositoryRoot(cwd);
  const entries = artifactRoot === undefined
    ? await snapshotPaths(root, await artifactPaths(root))
    : await snapshotPaths(root, await authorityArtifactPaths(root));
  return sha256(`${JSON.stringify({ version: 1, entries })}\n`);
}
