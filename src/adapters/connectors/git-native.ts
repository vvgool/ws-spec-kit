import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  failGitCommit,
  GitCommitError,
  type GitCommitApproval,
  type GitCommitReceipt,
  validateGitCommitApproval,
} from "../../registry/connectors/git-commit.js";

const timeoutMs = 30_000;
const maximumOutputBytes = 16 * 1024 * 1024;
const safeEnvironmentNames = ["LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "TERM", "TZ"] as const;

export interface GitCommitInput {
  executable: string;
  approval: GitCommitApproval;
  environment?: Readonly<Partial<Record<"HOME" | "XDG_CONFIG_HOME", string | undefined>>>;
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
}

interface FileIdentity {
  exists: boolean;
  dev?: bigint;
  ino?: bigint;
  size?: bigint;
  mtimeNs?: bigint;
  digest?: string;
}

function sha256(value: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function text(result: GitResult): string {
  return result.stdout.toString("utf8").trim();
}

function byteSort(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function strictEnvironment(input: GitCommitInput["environment"], index?: string): NodeJS.ProcessEnv {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Object.values(Object.getOwnPropertyDescriptors(input)).some((descriptor) => !descriptor.enumerable || !("value" in descriptor)))) {
    return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "Git commit 进程环境参数无效。");
  }
  const inherited = Object.fromEntries(safeEnvironmentNames.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  const configured: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    if ((name !== "HOME" && name !== "XDG_CONFIG_HOME") || (value !== undefined && (!path.isAbsolute(value) || value.includes("\0")))) {
      return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "Git commit 进程环境参数无效。");
    }
    if (value !== undefined) configured[name] = value;
  }
  return {
    ...inherited,
    ...configured,
    PATH: "/usr/bin:/bin",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
  };
}

async function canonicalExecutable(value: string): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
    return failGitCommit("WSSPEC_GIT_EXECUTABLE_INVALID", "Git executable 必须是规范绝对路径。");
  }
  try {
    const canonical = await realpath(value);
    const info = await lstat(value);
    if (canonical !== value || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) throw new Error("invalid");
    return canonical;
  } catch {
    return failGitCommit("WSSPEC_GIT_EXECUTABLE_INVALID", "Git executable 不存在、不可执行或包含符号链接歧义。");
  }
}

async function runGit(input: {
  executable: string;
  cwd: string;
  argv: readonly string[];
  environment: NodeJS.ProcessEnv;
  stdin?: Buffer | string;
}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform === "darwin" || process.platform === "linux";
    const child = spawn(input.executable, ["-c", "core.fsmonitor=false", ...input.argv], {
      cwd: input.cwd,
      env: input.environment,
      detached,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let termination: GitCommitError | undefined;
    const terminate = (error: GitCommitError): void => {
      if (settled || termination !== undefined) return;
      termination = error;
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code !== "ESRCH") {
          termination = new GitCommitError("WSSPEC_GIT_PROCESS_FAILED", "Git 子进程组无法清理。");
        }
      }
    };
    const timer = setTimeout(() => {
      terminate(new GitCommitError("WSSPEC_GIT_PROCESS_FAILED", "Git 命令执行超时。"));
    }, timeoutMs);
    timer.unref();
    const capture = (target: Buffer[]) => (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        terminate(new GitCommitError("WSSPEC_GIT_PROCESS_FAILED", "Git 命令输出超过上限。"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitCommitError("WSSPEC_GIT_PROCESS_FAILED", "无法启动 Git 命令。"));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if (termination !== undefined) {
        reject(termination);
        return;
      }
      const stdoutValue = Buffer.concat(stdout);
      const stderrValue = Buffer.concat(stderr);
      if (code !== 0 || signal !== null) {
        reject(new GitCommitError("WSSPEC_GIT_PROCESS_FAILED", "Git 命令执行失败。"));
        return;
      }
      resolve({ stdout: stdoutValue, stderr: stderrValue });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.stdin);
  });
}

async function canonicalRepositoryPath(value: string): Promise<string> {
  try {
    const canonical = await realpath(value);
    const info = await lstat(value);
    if (canonical !== value || !info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid");
    return canonical;
  } catch {
    return failGitCommit("WSSPEC_GIT_REPOSITORY_MISMATCH", "批准的仓库路径不存在、非目录或包含符号链接歧义。");
  }
}

async function optionalIdentity(filename: string): Promise<FileIdentity> {
  try {
    const info = await lstat(filename, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) return { exists: true, dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs };
    return {
      exists: true,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeNs: info.mtimeNs,
      digest: sha256(await readFile(filename)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.exists === right.exists && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.digest === right.digest;
}

function nulPaths(value: Buffer): string[] {
  const decoded = value.toString("utf8");
  if (decoded.includes("\uFFFD")) return failGitCommit("WSSPEC_GIT_PATH_INVALID", "Git 路径不是有效 UTF-8。");
  return decoded === "" ? [] : decoded.split("\0").filter((part) => part !== "");
}

async function assertApprovedPaths(root: string, approval: Readonly<GitCommitApproval>, git: (argv: readonly string[], stdin?: Buffer | string) => Promise<GitResult>): Promise<void> {
  for (const filename of approval.files) {
    let current = root;
    for (const part of filename.split("/")) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (current !== path.join(root, filename) && !info.isDirectory())) {
          return failGitCommit("WSSPEC_GIT_PATH_INVALID", "批准文件路径包含符号链接或非目录父级。");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    const baselineEntries = nulPaths((await git([
      "--literal-pathspecs", "ls-tree", "-z", approval.baselineRevision, "--", filename,
    ])).stdout);
    if (baselineEntries.length === 0) continue;
    if (baselineEntries.length !== 1) {
      return failGitCommit("WSSPEC_GIT_PATH_INVALID", "批准文件在 baseline 中的条目无法安全解析。");
    }
    const separator = baselineEntries[0]!.indexOf("\t");
    const metadata = separator === -1 ? [] : baselineEntries[0]!.slice(0, separator).split(" ");
    const baselinePath = separator === -1 ? "" : baselineEntries[0]!.slice(separator + 1);
    if (metadata.length !== 3 || (metadata[0] !== "100644" && metadata[0] !== "100755")
      || metadata[1] !== "blob" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(metadata[2]!) || baselinePath !== filename) {
      return failGitCommit("WSSPEC_GIT_PATH_INVALID", "批准文件在 baseline 中必须是普通 Git blob。");
    }
  }
}

async function assertNoExternalFilters(
  approval: Readonly<GitCommitApproval>,
  git: (argv: readonly string[], stdin?: Buffer | string) => Promise<GitResult>,
): Promise<void> {
  const values = nulPaths((await git(
    ["check-attr", "-z", "--stdin", "filter"],
    Buffer.from(`${approval.files.join("\0")}\0`, "utf8"),
  )).stdout);
  if (values.length !== approval.files.length * 3) {
    return failGitCommit("WSSPEC_GIT_PATH_INVALID", "无法安全确认批准文件的 Git attributes。");
  }
  for (let index = 0; index < values.length; index += 3) {
    const filename = values[index];
    const attribute = values[index + 1];
    const value = values[index + 2];
    if (filename !== approval.files[index / 3] || attribute !== "filter" || (value !== "unspecified" && value !== "unset")) {
      return failGitCommit("WSSPEC_GIT_PATH_INVALID", "批准文件不能使用可执行外部命令的 Git clean filter。");
    }
  }
}

async function assertSafeRepositoryState(commonDir: string): Promise<void> {
  for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
    try {
      await lstat(path.join(commonDir, marker));
      return failGitCommit("WSSPEC_GIT_STATE_UNSAFE", "仓库正在 merge 或 rebase，不能执行批准的 commit。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function actualDirtyFiles(git: (argv: readonly string[], stdin?: Buffer | string) => Promise<GitResult>): Promise<string[]> {
  const records = nulPaths((await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).stdout);
  return byteSort(records.map((record) => {
    if (record.length < 4 || record[2] !== " ") return failGitCommit("WSSPEC_GIT_STATE_UNSAFE", "Git status 输出无法安全解析。");
    return record.slice(3);
  }));
}

async function actualWorktreeDrift(git: (argv: readonly string[], stdin?: Buffer | string) => Promise<GitResult>): Promise<string[]> {
  const tracked = nulPaths((await git([
    "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--",
  ])).stdout);
  const untracked = nulPaths((await git(["ls-files", "--others", "--exclude-standard", "-z", "--"])).stdout);
  return byteSort([...new Set([...tracked, ...untracked])]);
}

async function worktreeDriftFromTree(input: {
  executable: string;
  root: string;
  environment: GitCommitInput["environment"];
  treeish: string;
}): Promise<string[]> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wspec-git-readback-"));
  const readbackEnvironment = strictEnvironment(input.environment, path.join(temporary, "index"));
  const git = (argv: readonly string[], stdin?: Buffer | string): Promise<GitResult> => runGit({
    executable: input.executable,
    cwd: input.root,
    argv,
    environment: readbackEnvironment,
    ...(stdin === undefined ? {} : { stdin }),
  });
  try {
    await git(["read-tree", input.treeish]);
    return await actualWorktreeDrift(git);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function diffArgv(left: string, right?: string): string[] {
  return [
    "diff",
    ...(right === undefined ? ["--cached"] : []),
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    left,
    ...(right === undefined ? [] : [right]),
    "--",
  ];
}

async function stagedProposal(input: {
  approval: Readonly<GitCommitApproval>;
  gitWithIndex: (argv: readonly string[], stdin?: Buffer | string) => Promise<GitResult>;
}): Promise<{ files: string[]; diffDigest: `sha256:${string}`; treeOid: string }> {
  await input.gitWithIndex(["read-tree", input.approval.baselineRevision]);
  await input.gitWithIndex(
    ["--literal-pathspecs", "add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
    Buffer.from(`${input.approval.files.join("\0")}\0`, "utf8"),
  );
  const stagedEntries = nulPaths((await input.gitWithIndex(["ls-files", "--stage", "-z"])).stdout);
  for (const entry of stagedEntries) {
    const match = /^(\d{6}) [a-f0-9]{40,64} [0-3]\t(.+)$/u.exec(entry);
    if (match === null) return failGitCommit("WSSPEC_GIT_PATH_INVALID", "临时 index 包含无法安全解析的条目。");
    if (input.approval.files.includes(match[2]!) && match[1] !== "100644" && match[1] !== "100755") {
      return failGitCommit("WSSPEC_GIT_PATH_INVALID", "批准文件只能提交普通 Git blob。");
    }
  }
  const files = byteSort(nulPaths((await input.gitWithIndex([
    "diff-index", "--cached", "--name-only", "-z", "--no-renames", input.approval.baselineRevision, "--",
  ])).stdout));
  const diffDigest = sha256((await input.gitWithIndex(diffArgv(input.approval.baselineRevision))).stdout);
  const treeOid = text(await input.gitWithIndex(["write-tree"]));
  return { files, diffDigest, treeOid };
}

export async function commitGitChanges(input: GitCommitInput): Promise<GitCommitReceipt> {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Reflect.ownKeys(input).some((key) => typeof key !== "string" || !["approval", "environment", "executable"].includes(key))
    || !Object.hasOwn(input, "approval") || !Object.hasOwn(input, "executable")
    || Object.values(Object.getOwnPropertyDescriptors(input)).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) {
    return failGitCommit("WSSPEC_GIT_REQUEST_INVALID", "Git commit 执行输入无效。");
  }
  const approval = validateGitCommitApproval(input.approval);
  const executable = await canonicalExecutable(input.executable);
  const root = await canonicalRepositoryPath(approval.repositoryRoot);
  const commonDir = await canonicalRepositoryPath(approval.repositoryCommonDir);
  const baseEnvironment = strictEnvironment(input.environment);
  const git = (argv: readonly string[], stdin?: Buffer | string): Promise<GitResult> => runGit({ executable, cwd: root, argv, environment: baseEnvironment, ...(stdin === undefined ? {} : { stdin }) });
  const actualRoot = await canonicalRepositoryPath(text(await git(["rev-parse", "--path-format=absolute", "--show-toplevel"])));
  const actualCommonDir = await canonicalRepositoryPath(text(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])));
  if (actualRoot !== root || actualCommonDir !== commonDir) {
    return failGitCommit("WSSPEC_GIT_REPOSITORY_MISMATCH", "当前仓库与批准的 root/common-dir 不一致。");
  }
  const gitDir = await canonicalRepositoryPath(text(await git(["rev-parse", "--path-format=absolute", "--git-dir"])));
  await assertSafeRepositoryState(commonDir);
  if (gitDir !== commonDir) await assertSafeRepositoryState(gitDir);
  const head = text(await git(["rev-parse", "--verify", "HEAD^{commit}"]));
  if (head !== approval.baselineRevision) {
    return failGitCommit("WSSPEC_GIT_BASELINE_CHANGED", "仓库 HEAD 已偏离批准的 baseline，必须重新审批。");
  }
  await assertApprovedPaths(root, approval, git);
  await assertNoExternalFilters(approval, git);

  const userIndex = path.join(gitDir, "index");
  const indexBefore = await optionalIdentity(userIndex);
  const realIndexDirtyFiles = await actualDirtyFiles(git);
  if (!sameIdentity(indexBefore, await optionalIdentity(userIndex))) {
    return failGitCommit("WSSPEC_GIT_READBACK_MISMATCH", "只读检查期间用户 Git index 发生变化，不能继续 commit。");
  }
  if (realIndexDirtyFiles.some((filename) => !approval.files.includes(filename))) {
    return failGitCommit("WSSPEC_GIT_UNAUTHORIZED_DIRTY_FILES", "用户 Git index 或工作树包含批准列表之外的脏文件。");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wspec-git-commit-"));
  const temporaryIndex = path.join(temporary, "index");
  const indexEnvironment = strictEnvironment(input.environment, temporaryIndex);
  const gitWithIndex = (argv: readonly string[], stdin?: Buffer | string): Promise<GitResult> => runGit({
    executable,
    cwd: root,
    argv,
    environment: indexEnvironment,
    ...(stdin === undefined ? {} : { stdin }),
  });
  try {
    const proposal = await stagedProposal({ approval, gitWithIndex });
    const dirtyFiles = await actualDirtyFiles(gitWithIndex);
    const unauthorized = dirtyFiles.filter((filename) => !approval.files.includes(filename));
    if (unauthorized.length !== 0) {
      return failGitCommit("WSSPEC_GIT_UNAUTHORIZED_DIRTY_FILES", "仓库包含批准列表之外的脏文件。");
    }
    if (proposal.files.length === 0) return failGitCommit("WSSPEC_GIT_EMPTY_COMMIT", "批准文件没有可提交差异。");
    if (!sameFiles(proposal.files, approval.files)) {
      return failGitCommit("WSSPEC_GIT_FILE_SET_MISMATCH", "实际差异文件与批准文件列表不完全一致。");
    }
    if (proposal.diffDigest !== approval.diffDigest) {
      return failGitCommit("WSSPEC_GIT_DIFF_MISMATCH", "实际 diff 摘要已偏离批准值，必须重新审批。");
    }

    if (text(await git(["rev-parse", "--verify", "HEAD^{commit}"])) !== approval.baselineRevision) {
      return failGitCommit("WSSPEC_GIT_BASELINE_CHANGED", "commit 前 HEAD 已偏离批准的 baseline，必须重新审批。");
    }
    const dirtyBeforeCommit = await actualDirtyFiles(gitWithIndex);
    if (dirtyBeforeCommit.some((filename) => !approval.files.includes(filename))) {
      return failGitCommit("WSSPEC_GIT_UNAUTHORIZED_DIRTY_FILES", "commit 前出现批准列表之外的脏文件。");
    }
    const refreshed = await stagedProposal({ approval, gitWithIndex });
    if (!sameFiles(refreshed.files, approval.files) || refreshed.diffDigest !== approval.diffDigest || refreshed.treeOid !== proposal.treeOid) {
      return failGitCommit("WSSPEC_GIT_DIFF_MISMATCH", "commit 前批准内容发生变化，必须重新审批。");
    }

    try {
      await gitWithIndex(["-c", "commit.gpgSign=false", "commit", "--file=-", "--cleanup=verbatim"], `${approval.message}\n`);
    } catch (error) {
      let hookChangedContent = false;
      try {
        const hookTree = text(await gitWithIndex(["write-tree"]));
        const hookDigest = sha256((await gitWithIndex(diffArgv(approval.baselineRevision))).stdout);
        hookChangedContent = hookTree !== proposal.treeOid || hookDigest !== approval.diffDigest;
      } catch {}
      try {
        const hookWorktree = await worktreeDriftFromTree({
          executable,
          root,
          environment: input.environment,
          treeish: proposal.treeOid,
        });
        const hookHead = text(await git(["rev-parse", "--verify", "HEAD^{commit}"]));
        hookChangedContent ||= hookWorktree.length !== 0 || hookHead !== approval.baselineRevision
          || !sameIdentity(indexBefore, await optionalIdentity(userIndex));
      } catch {}
      if (hookChangedContent) {
        return failGitCommit("WSSPEC_GIT_REAPPROVAL_REQUIRED", "Git hook 在失败前修改了内容，必须基于新 diff 重新审批。");
      }
      throw error;
    }
    const commitOid = text(await git(["rev-parse", "--verify", "HEAD^{commit}"]));
    const ancestry = text(await git(["rev-list", "--parents", "-n", "1", commitOid])).split(/\s+/u);
    if (ancestry.length !== 2 || ancestry[0] !== commitOid || ancestry[1] !== approval.baselineRevision) {
      return failGitCommit("WSSPEC_GIT_READBACK_MISMATCH", "Git commit 成功后的 parent 回读不一致，不能形成成功 Receipt。");
    }
    const parentOid = ancestry[1];
    const treeOid = text(await git(["rev-parse", "--verify", `${commitOid}^{tree}`]));
    const files = byteSort(nulPaths((await git([
      "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", parentOid, commitOid, "--",
    ])).stdout));
    const readBackDigest = sha256((await git(diffArgv(parentOid, commitOid))).stdout);
    const readBackMessage = (await git(["show", "-s", "--format=%B", commitOid])).stdout.toString("utf8").replace(/\n+$/u, "");
    const indexAfter = await optionalIdentity(userIndex);
    const worktreeAfter = await worktreeDriftFromTree({
      executable,
      root,
      environment: input.environment,
      treeish: commitOid,
    });
    const hookWorktreeDrift = worktreeAfter.length !== 0;

    if (parentOid !== approval.baselineRevision || !sameIdentity(indexBefore, indexAfter)) {
      return failGitCommit("WSSPEC_GIT_READBACK_MISMATCH", "Git commit 成功后的 OID、tree、文件或摘要回读不一致，不能形成成功 Receipt。");
    }
    if (treeOid !== proposal.treeOid || !sameFiles(files, approval.files) || readBackDigest !== approval.diffDigest
      || readBackMessage !== approval.message || hookWorktreeDrift) {
      return failGitCommit("WSSPEC_GIT_REAPPROVAL_REQUIRED", "Git hook 修改了批准内容，必须基于新 diff 重新审批。");
    }
    return Object.freeze({
      version: 1,
      kind: "git-commit-receipt",
      provider: "git-native",
      action: "git.commit",
      repositoryCommonDir: commonDir,
      baselineRevision: approval.baselineRevision,
      messageDigest: sha256(approval.message),
      diffDigest: approval.diffDigest,
      commitOid,
      parentOid,
      treeOid,
      files: Object.freeze(files) as unknown as string[],
      readBackDigest,
      status: "verified",
      verifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof GitCommitError) throw error;
    return failGitCommit("WSSPEC_GIT_COMMIT_FAILED", "Git commit Provider 执行失败。");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
