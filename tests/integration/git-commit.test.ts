import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { commitGitChanges, reconcileGitCommit } from "../../src/adapters/connectors/git-native.js";
import {
  GitCommitError,
  gitCommitManifest,
  type GitCommitApproval,
} from "../../src/registry/connectors/git-commit.js";
import { ConnectorRegistry, ConnectorRegistryError } from "../../src/registry/connectors/registry.js";
import { createGitRepository, git } from "./helpers/git.js";

const execFileAsync = promisify(execFile);

async function gitExecutable(): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/env", ["which", "git"], { encoding: "utf8" });
  return realpath(stdout.trim());
}

async function sha256GitDiff(root: string, baseline: string, files: readonly string[]): Promise<`sha256:${string}`> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wspec-git-approval-"));
  const index = path.join(temporary, "index");
  const pathspec = path.join(temporary, "pathspec");
  const executable = await gitExecutable();
  const env = { PATH: "/usr/bin:/bin", GIT_INDEX_FILE: index };
  try {
    await writeFile(pathspec, Buffer.from(`${files.join("\0")}\0`, "utf8"));
    await execFileAsync(executable, ["read-tree", baseline], { cwd: root, env });
    await execFileAsync(executable, ["--literal-pathspecs", "add", "--all", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"], { cwd: root, env });
    const { stdout } = await execFileAsync(executable, [
      "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--src-prefix=a/", "--dst-prefix=b/", baseline, "--",
    ], { cwd: root, env, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return `sha256:${createHash("sha256").update(stdout).digest("hex")}`;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function fixture(files: Readonly<Record<string, string>> = { "src/a.txt": "before\n", "src/b.txt": "before\n" }) {
  const root = await createGitRepository();
  for (const [filename, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), contents, "utf8");
  }
  if (Object.keys(files).length !== 0) {
    await git(root, "add", ".");
    await git(root, "commit", "-m", "test: add files");
  }
  const baselineRevision = await git(root, "rev-parse", "HEAD");
  const repositoryCommonDir = await realpath(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  return { root: await realpath(root), baselineRevision, repositoryCommonDir, executable: await gitExecutable() };
}

async function gitlinkFixture() {
  const setup = await fixture({});
  const targetOid = await git(setup.root, "rev-parse", "HEAD");
  await git(setup.root, "update-index", "--add", "--cacheinfo", `160000,${targetOid},submodule`);
  await git(setup.root, "commit", "-m", "test: add gitlink");
  setup.baselineRevision = await git(setup.root, "rev-parse", "HEAD");
  return setup;
}

async function approval(input: Awaited<ReturnType<typeof fixture>>, files: readonly string[], message = "feat: approved change"): Promise<GitCommitApproval> {
  return {
    repositoryRoot: input.root,
    repositoryCommonDir: input.repositoryCommonDir,
    baselineRevision: input.baselineRevision,
    files: [...files],
    message,
    diffDigest: await sha256GitDiff(input.root, input.baselineRevision, files),
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof GitCommitError && error.code === code;
}

test("git.commit creates the approved commit, verifies its identity, and leaves the user's index unchanged", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "staged user version\n", "utf8");
  await git(setup.root, "add", "src/a.txt");
  await writeFile(path.join(setup.root, "src/a.txt"), "approved worktree version\n", "utf8");
  const beforeIndex = await readFile(path.join(setup.repositoryCommonDir, "index"));
  const input = await approval(setup, ["src/a.txt"]);

  const receipt = await commitGitChanges({ executable: setup.executable, approval: input });

  assert.equal(receipt.kind, "git-commit-receipt");
  assert.equal(receipt.provider, "git-native");
  assert.equal(receipt.action, "git.commit");
  assert.equal(receipt.parentOid, setup.baselineRevision);
  assert.equal(receipt.commitOid, await git(setup.root, "rev-parse", "HEAD"));
  assert.equal(receipt.treeOid, await git(setup.root, "rev-parse", "HEAD^{tree}"));
  assert.deepEqual(receipt.files, ["src/a.txt"]);
  assert.equal(receipt.diffDigest, input.diffDigest);
  assert.equal(receipt.readBackDigest, input.diffDigest);
  assert.equal(await git(setup.root, "show", "HEAD:src/a.txt"), "approved worktree version");
  assert.deepEqual(await readFile(path.join(setup.repositoryCommonDir, "index")), beforeIndex);
});

test("git.commit reconciliation verifies the exact approved commit without another mutation", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  const receipt = await commitGitChanges({ executable: setup.executable, approval: input });

  const readBack = await reconcileGitCommit({ executable: setup.executable, approval: input });

  assert.equal(readBack.outcome, "verified");
  if (readBack.outcome !== "verified") throw new Error("expected verified git reconciliation");
  assert.equal(readBack.commitOid, receipt.commitOid);
  assert.equal(readBack.repositoryCommonDir, input.repositoryCommonDir);
  assert.equal(readBack.diffDigest, input.diffDigest);
  assert.deepEqual(readBack.files, input.files);
  assert.equal(await git(setup.root, "rev-list", "--count", `${setup.baselineRevision}..HEAD`), "1");
});

test("git.commit reconciliation remains unknown while HEAD is still the approved baseline", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);

  assert.deepEqual(
    await reconcileGitCommit({ executable: setup.executable, approval: input }),
    { outcome: "unknown" },
  );
  assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
});

test("git.commit reconciliation fails closed for a non-approved HEAD", async (t) => {
  await t.test("wrong parent", async () => {
    const setup = await fixture();
    await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
    const input = await approval(setup, ["src/a.txt"]);
    await git(setup.root, "commit", "--allow-empty", "-m", "unapproved intermediate");
    await git(setup.root, "add", "src/a.txt");
    await git(setup.root, "commit", "-m", input.message);

    assert.deepEqual(await reconcileGitCommit({ executable: setup.executable, approval: input }), { outcome: "failed" });
  });

  await t.test("merge commit", async () => {
    const setup = await fixture();
    await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
    const input = await approval(setup, ["src/a.txt"]);
    const committed = await commitGitChanges({ executable: setup.executable, approval: input });
    const merge = await git(
      setup.root,
      "commit-tree",
      committed.treeOid,
      "-p",
      setup.baselineRevision,
      "-p",
      committed.commitOid,
      "-m",
      input.message,
    );
    await git(setup.root, "update-ref", "HEAD", merge, committed.commitOid);

    assert.deepEqual(await reconcileGitCommit({ executable: setup.executable, approval: input }), { outcome: "failed" });
  });

  for (const current of ["wrong message", "wrong files", "wrong diff"] as const) await t.test(current, async () => {
    const setup = await fixture();
    await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
    const input = await approval(setup, ["src/a.txt"]);
    if (current === "wrong files") await writeFile(path.join(setup.root, "src/b.txt"), "also changed\n", "utf8");
    if (current === "wrong diff") await writeFile(path.join(setup.root, "src/a.txt"), "different\n", "utf8");
    await git(setup.root, "add", "src/a.txt", ...(current === "wrong files" ? ["src/b.txt"] : []));
    await git(setup.root, "commit", "-m", current === "wrong message" ? "different message" : input.message);

    assert.deepEqual(await reconcileGitCommit({ executable: setup.executable, approval: input }), { outcome: "failed" });
  });
});

test("git.commit rejects dirty files outside the exact approval list before moving HEAD", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  await writeFile(path.join(setup.root, "src/b.txt"), "not approved\n", "utf8");

  await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_UNAUTHORIZED_DIRTY_FILES"));
  assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
});

test("git.commit rejects an unapproved change that exists only in the user's real index", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  await writeFile(path.join(setup.root, "src/b.txt"), "staged but not approved\n", "utf8");
  await git(setup.root, "add", "src/b.txt");
  await writeFile(path.join(setup.root, "src/b.txt"), "before\n", "utf8");
  const beforeIndex = await readFile(path.join(setup.repositoryCommonDir, "index"));

  await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_UNAUTHORIZED_DIRTY_FILES"));
  assert.deepEqual(await readFile(path.join(setup.repositoryCommonDir, "index")), beforeIndex);
  assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
});

test("git.commit rejects baseline and approved diff drift before moving HEAD", async (t) => {
  await t.test("baseline changed", async () => {
    const setup = await fixture();
    await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
    const input = await approval(setup, ["src/a.txt"]);
    await git(setup.root, "commit", "--allow-empty", "-m", "test: concurrent commit");
    const changedHead = await git(setup.root, "rev-parse", "HEAD");

    await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_BASELINE_CHANGED"));
    assert.equal(await git(setup.root, "rev-parse", "HEAD"), changedHead);
  });

  await t.test("diff changed", async () => {
    const setup = await fixture();
    await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
    const input = await approval(setup, ["src/a.txt"]);
    await writeFile(path.join(setup.root, "src/a.txt"), "drifted after approval\n", "utf8");

    await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_DIFF_MISMATCH"));
    assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
  });
});

test("git.commit rejects empty or inexact approved file sets", async (t) => {
  await t.test("empty commit", async () => {
    const setup = await fixture();
    const input = await approval(setup, ["src/a.txt"]);
    await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_EMPTY_COMMIT"));
  });

  await t.test("approval includes an unchanged file", async () => {
    const setup = await fixture();
    await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
    const input = await approval(setup, ["src/a.txt", "src/b.txt"]);
    await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_FILE_SET_MISMATCH"));
  });
});

test("git.commit rejects merge and rebase state", async (t) => {
  for (const state of ["MERGE_HEAD", "rebase-merge"] as const) {
    await t.test(state, async () => {
      const setup = await fixture();
      await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
      const input = await approval(setup, ["src/a.txt"]);
      const marker = path.join(setup.repositoryCommonDir, state);
      if (state === "rebase-merge") await mkdir(marker);
      else await writeFile(marker, `${setup.baselineRevision}\n`, "utf8");

      await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_STATE_UNSAFE"));
      assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
    });
  }

  await t.test("linked worktree merge state", async () => {
    const setup = await fixture();
    const worktree = `${setup.root}-linked`;
    await git(setup.root, "worktree", "add", "-b", "linked-test", worktree);
    await writeFile(path.join(worktree, "src/a.txt"), "approved\n", "utf8");
    const linkedSetup = {
      ...setup,
      root: await realpath(worktree),
      baselineRevision: await git(worktree, "rev-parse", "HEAD"),
    };
    const input = await approval(linkedSetup, ["src/a.txt"]);
    const worktreeGitDir = await realpath(await git(worktree, "rev-parse", "--path-format=absolute", "--git-dir"));
    await writeFile(path.join(worktreeGitDir, "MERGE_HEAD"), `${linkedSetup.baselineRevision}\n`, "utf8");

    await assert.rejects(commitGitChanges({ executable: linkedSetup.executable, approval: input }), hasCode("WSSPEC_GIT_STATE_UNSAFE"));
  });
});

test("git.commit rejects escaping, non-canonical, and symlink-ambiguous paths", async (t) => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const valid = await approval(setup, ["src/a.txt"]);
  for (const files of [["../outside"], ["/tmp/outside"], ["src/../src/a.txt"], ["src\\a.txt"]]) {
    await assert.rejects(
      commitGitChanges({ executable: setup.executable, approval: { ...valid, files } }),
      hasCode("WSSPEC_GIT_PATH_INVALID"),
    );
  }

  await t.test("repository root aliases are rejected", async () => {
    const alias = `${setup.root}-alias`;
    await symlink(setup.root, alias);
    await assert.rejects(
      commitGitChanges({ executable: setup.executable, approval: { ...valid, repositoryRoot: alias } }),
      hasCode("WSSPEC_GIT_REPOSITORY_MISMATCH"),
    );
  });

  await t.test("tracked symlinks are rejected", async () => {
    const linked = await fixture({});
    await writeFile(path.join(linked.root, "target.txt"), "target\n", "utf8");
    await symlink("target.txt", path.join(linked.root, "link.txt"));
    await git(linked.root, "add", "target.txt", "link.txt");
    await git(linked.root, "commit", "-m", "test: add symlink");
    linked.baselineRevision = await git(linked.root, "rev-parse", "HEAD");
    await writeFile(path.join(linked.root, "target.txt"), "changed\n", "utf8");
    const linkedApproval = await approval(linked, ["link.txt", "target.txt"]);
    await assert.rejects(
      commitGitChanges({ executable: linked.executable, approval: linkedApproval }),
      hasCode("WSSPEC_GIT_PATH_INVALID"),
    );
  });
});

test("git.commit runs normal hooks but returns no success receipt when a hook changes approved content", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  const hook = path.join(setup.repositoryCommonDir, "hooks/pre-commit");
  await writeFile(hook, "#!/bin/sh\nprintf 'hook mutation\\n' >> src/a.txt\ngit add -- src/a.txt\n", "utf8");
  await chmod(hook, 0o755);

  await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_REAPPROVAL_REQUIRED"));
  assert.equal(await git(setup.root, "show", "HEAD:src/a.txt"), "approved\nhook mutation");
});

test("git.commit requires reapproval when a failing hook changes content before aborting", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  const hook = path.join(setup.repositoryCommonDir, "hooks/pre-commit");
  await writeFile(hook, "#!/bin/sh\nprintf 'hook mutation\\n' >> src/a.txt\nexit 1\n", "utf8");
  await chmod(hook, 0o755);

  await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_REAPPROVAL_REQUIRED"));
  assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
});

test("git.commit never exposes hook stderr through public errors or receipts", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  const secrets = [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "cookie-session-secret-123456",
    "authorization-bearer-secret-123456",
    "arbitrary-secret-marker-123456",
  ];
  const hook = path.join(setup.repositoryCommonDir, "hooks/pre-commit");
  await writeFile(hook, [
    "#!/bin/sh",
    `printf '%s\\n' '${secrets[0]}' >&2`,
    `printf '%s\\n' 'Cookie: session=${secrets[1]}' >&2`,
    `printf '%s\\n' 'Authorization: Bearer ${secrets[2]}' >&2`,
    `printf '%s\\n' '${secrets[3]}' >&2`,
    "rm \"$GIT_INDEX_FILE\"",
    "mkdir \"$GIT_INDEX_FILE\"",
    "exit 1",
    "",
  ].join("\n"), "utf8");
  await chmod(hook, 0o755);

  let receipt: unknown;
  let observedError: unknown;
  try {
    receipt = await commitGitChanges({ executable: setup.executable, approval: input });
  } catch (error) {
    observedError = error;
  }

  assert.equal(receipt, undefined);
  assert.ok(observedError instanceof GitCommitError);
  assert.equal(observedError.code, "WSSPEC_GIT_PROCESS_FAILED");
  assert.equal(observedError.message, "WSSPEC_GIT_PROCESS_FAILED: Git 命令执行失败。");
  const observable = JSON.stringify({
    name: observedError.name,
    code: observedError.code,
    message: observedError.message,
    receipt,
  });
  for (const secret of secrets) assert.equal(observable.includes(secret), false);
});

test("git.commit requires reapproval when a hook creates an unapproved dirty file", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  const hook = path.join(setup.repositoryCommonDir, "hooks/post-commit");
  await writeFile(hook, "#!/bin/sh\nprintf 'not approved\\n' > hook-output.txt\n", "utf8");
  await chmod(hook, 0o755);

  await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_REAPPROVAL_REQUIRED"));
  assert.equal(await readFile(path.join(setup.root, "hook-output.txt"), "utf8"), "not approved\n");
});

test("git.commit verifies post-hook worktree state with an index hooks cannot flag away", async (t) => {
  for (const flag of ["--skip-worktree", "--assume-unchanged"] as const) {
    await t.test(flag, async () => {
      const setup = await fixture();
      await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
      const input = await approval(setup, ["src/a.txt"]);
      const hook = path.join(setup.repositoryCommonDir, "hooks/post-commit");
      await writeFile(hook, `#!/bin/sh\ngit update-index ${flag} src/b.txt\nprintf 'hook drift\\n' > src/b.txt\n`, "utf8");
      await chmod(hook, 0o755);

      await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_REAPPROVAL_REQUIRED"));
      assert.equal(await readFile(path.join(setup.root, "src/b.txt"), "utf8"), "hook drift\n");
    });
  }
});

test("git.commit treats an exact unique file list as a set and canonicalizes receipt order", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved a\n", "utf8");
  await writeFile(path.join(setup.root, "src/b.txt"), "approved b\n", "utf8");
  const sorted = await approval(setup, ["src/a.txt", "src/b.txt"]);

  const receipt = await commitGitChanges({
    executable: setup.executable,
    approval: { ...sorted, files: ["src/b.txt", "src/a.txt"] },
  });
  assert.deepEqual(receipt.files, ["src/a.txt", "src/b.txt"]);
});

test("git.commit fails closed when post-commit read-back no longer describes the approved commit", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  const hook = path.join(setup.repositoryCommonDir, "hooks/post-commit");
  await writeFile(hook, "#!/bin/sh\nrm \"$0\"\ngit commit --allow-empty -m 'hook: moved head' >/dev/null\n", "utf8");
  await chmod(hook, 0o755);

  await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_READBACK_MISMATCH"));
  assert.notEqual(await git(setup.root, "rev-parse", "HEAD^"), setup.baselineRevision);
});

test("git.commit rejects a post-commit hook that replaces HEAD with an approved-looking merge commit", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  const hook = path.join(setup.repositoryCommonDir, "hooks/post-commit");
  await writeFile(hook, [
    "#!/bin/sh",
    "tree=$(git rev-parse 'HEAD^{tree}')",
    "first=$(git rev-parse 'HEAD^')",
    "second=$(git rev-parse HEAD)",
    "merge=$(printf 'feat: approved change\\n' | git commit-tree \"$tree\" -p \"$first\" -p \"$second\")",
    "git update-ref HEAD \"$merge\" \"$second\"",
    "",
  ].join("\n"), "utf8");
  await chmod(hook, 0o755);

  await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_READBACK_MISMATCH"));
  assert.equal((await git(setup.root, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ").length, 3);
});

test("git.commit rejects baseline gitlinks when the approved change deletes or replaces them", async (t) => {
  await t.test("delete", async () => {
    const setup = await gitlinkFixture();
    const input = await approval(setup, ["submodule"]);

    await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_PATH_INVALID"));
    assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
  });

  await t.test("replace with a regular file", async () => {
    const setup = await gitlinkFixture();
    await writeFile(path.join(setup.root, "submodule"), "replacement\n", "utf8");
    const input = await approval(setup, ["submodule"]);

    await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_PATH_INVALID"));
    assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
  });
});

test("git-native registers only git.commit and rejects push, merge, and release surfaces", () => {
  const registry = new ConnectorRegistry().register(gitCommitManifest);
  assert.equal(registry.resolve("git.commit", "git-native").securityClass, "local-write");
  for (const capability of ["git.push", "git.merge", "release.publish"]) {
    assert.throws(
      () => registry.resolve(capability, "git-native"),
      (error: unknown) => error instanceof ConnectorRegistryError && error.code === "WSSPEC_CONNECTOR_CAPABILITY_NOT_FOUND",
    );
  }
});

test("git.commit rejects malformed execution objects with a stable public error", async () => {
  const setup = await fixture();
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  for (const malformed of [
    { approval: input },
    { executable: setup.executable, approval: input, operation: "push" },
    { executable: setup.executable, approval: { ...input, operation: "merge" } },
  ]) {
    await assert.rejects(
      commitGitChanges(malformed as never),
      (error: unknown) => error instanceof GitCommitError && ["WSSPEC_GIT_REQUEST_INVALID", "WSSPEC_GIT_EXECUTABLE_INVALID"].includes(error.code),
    );
  }
});

test("git.commit rejects clean filters before Git can execute user-configured shell", async () => {
  const setup = await fixture({ ".gitattributes": "src/a.txt filter=unsafe\n", "src/a.txt": "before\n" });
  await writeFile(path.join(setup.root, "src/a.txt"), "approved\n", "utf8");
  const input = await approval(setup, ["src/a.txt"]);
  const marker = path.join(setup.root, "filter-ran.txt");
  await git(setup.root, "config", "filter.unsafe.clean", `touch '${marker}'; cat`);

  await assert.rejects(commitGitChanges({ executable: setup.executable, approval: input }), hasCode("WSSPEC_GIT_PATH_INVALID"));
  await assert.rejects(readFile(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(await git(setup.root, "rev-parse", "HEAD"), setup.baselineRevision);
});
