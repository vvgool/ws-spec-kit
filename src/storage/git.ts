import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await runGitRaw(cwd, args)).trim();
}

export async function runGitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function gitCommonDir(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}
