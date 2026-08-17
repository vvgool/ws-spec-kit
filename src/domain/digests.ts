import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
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

export async function computeWorkspaceSnapshot(cwd: string): Promise<TreeEntry[]> {
  const root = await repositoryRoot(cwd);
  const output = await runGitRaw(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const paths = output.split("\0").filter(Boolean).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        entries.push({ path: relativePath, type: "deleted", mode: "deleted" });
      } else {
        throw error;
      }
    }
  }

  return entries;
}

export async function computeWorkspaceTreeDigest(cwd: string): Promise<string> {
  const entries = await computeWorkspaceSnapshot(cwd);
  return sha256(`${JSON.stringify({ version: 1, entries })}\n`);
}
