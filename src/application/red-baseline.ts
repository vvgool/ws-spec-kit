import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeWorkspaceTreeDigest, sha256, type TreeEntry } from "../domain/digests.js";
import { resolveRepositoryRegularFile, isRepositoryRelativePattern } from "../domain/repository-path.js";
import { VerificationError } from "../engine/tdd/types.js";

const execute = promisify(execFile);
const invalid = (message: string): never => { throw new VerificationError("WSSPEC_TDD_EVIDENCE_INVALIDATED", message); };

// Copies only verified historical bytes. Nothing in the implementation worktree is rewritten.
export async function withRedBaseline<T>(input: {
  worktree: string; revision: string; snapshot: TreeEntry[]; digest: string;
}, use: (directory: string) => Promise<T>): Promise<T> {
  const source = await realpath(input.worktree);
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-red-baseline-")));
  const target = path.join(temporary, "workspace");
  try {
    await execute("git", ["clone", "--shared", "--no-checkout", "--", source, target]);
    await execute("git", ["read-tree", input.revision], { cwd: target });
    const directories = new Set([""]);
    for (const entry of input.snapshot) {
      if (!isRepositoryRelativePattern(entry.path) || /[*?]/u.test(entry.path)
        || entry.path.split("/").some(part => part === ".git" || part === "node_modules")) invalid(`无法安全重建基线路径：${entry.path}`);
      const destination = path.join(target, entry.path);
      let parent = path.posix.dirname(entry.path);
      while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
      if (entry.type === "deleted") continue;
      if (entry.type !== "file") invalid(`基线包含不支持的软链接：${entry.path}`);
      let bytes: Buffer | undefined;
      try {
        const current = await readFile(await resolveRepositoryRegularFile(source, entry.path));
        if (sha256(current) === entry.digest) bytes = current;
      } catch { /* Try the immutable Git baseline next. */ }
      if (bytes === undefined) {
        try {
          const result = await execute("git", ["show", `${input.revision}:${entry.path}`], { cwd: source, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
          if (sha256(result.stdout) === entry.digest) bytes = result.stdout;
        } catch { /* Missing historical content is not reconstructed by guessing. */ }
      }
      if (bytes === undefined) invalid(`原 Red 文件无法按摘要重建：${entry.path}。请保留已有实现并恢复该基线文件来源。`);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes!);
      await chmod(destination, entry.mode === "100755" ? 0o755 : 0o644);
    }
    // Dependency trees are copied (reflink where available), never linked back to mutable source.
    // Relative pnpm workspace links then resolve into the reconstructed workspace.
    for (const directory of [...directories].sort()) {
      const relative = path.posix.join(directory, "node_modules");
      const original = path.join(source, relative);
      try { await lstat(original); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (await realpath(original) !== original) invalid(`依赖目录经过外部软链接，无法隔离重建：${relative}`);
      await cp(original, path.join(target, relative), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    }
    async function relocateLinks(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (directory === target && entry.name === ".git") continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await relocateLinks(filename);
        else if (entry.isSymbolicLink()) {
          const relative = path.relative(target, filename);
          const originalTarget = await realpath(path.join(source, relative))
            .catch(() => invalid(`隔离依赖软链接无法解析：${relative}`));
          if (!originalTarget.startsWith(`${source}${path.sep}`)) invalid(`隔离依赖指向工作区之外：${relative}`);
          await rm(filename);
          await symlink(path.join(target, path.relative(source, originalTarget)), filename);
          const resolved = await realpath(filename).catch(() => invalid(`隔离依赖软链接无法解析：${relative}`));
          if (!resolved.startsWith(`${target}${path.sep}`)) invalid(`隔离依赖指向工作区之外：${relative}`);
        }
      }
    }
    await relocateLinks(target);
    // Ignore copied dependencies even when the project omitted its ignore rule.
    await writeFile(path.join(target, ".git/info/exclude"), "node_modules/\n", { flag: "a" });
    if (await computeWorkspaceTreeDigest(target) !== input.digest) invalid("隔离目录无法精确重建原 Red 工作区摘要。");
    return await use(target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
