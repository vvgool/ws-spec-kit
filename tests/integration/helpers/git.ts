import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

export async function createGitRepository(): Promise<string> {
  const root = path.join(os.tmpdir(), `wspec-git-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "WSSpecKit Test");
  await git(root, "config", "user.email", "wspec@example.invalid");
  await writeFile(path.join(root, ".gitignore"), ".worktrees/\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "test: initialize fixture");
  return root;
}
