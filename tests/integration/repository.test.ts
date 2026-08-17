import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeWorkspaceTreeDigest } from "../../src/domain/digests.js";
import { RepositoryError, initRepository, loadRepository } from "../../src/storage/repository.js";
import { createGitRepository, git } from "./helpers/git.js";

test("repository initialization creates a stable committed identity and common-dir cache", async () => {
  const root = await createGitRepository();

  const initialized = await initRepository(root);
  const loaded = await loadRepository(root);
  const repositoryYaml = await readFile(path.join(root, ".wsspec", "repository.yaml"), "utf8");
  const commonDir = path.resolve(root, await git(root, "rev-parse", "--git-common-dir"));
  const cache = JSON.parse(await readFile(path.join(commonDir, "wsspec", "repository.json"), "utf8")) as {
    repositoryId: string;
  };

  assert.match(initialized.repositoryId, /^repo-[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(loaded.repositoryId, initialized.repositoryId);
  assert.match(repositoryYaml, new RegExp(`repositoryId: ${initialized.repositoryId}`));
  assert.equal(cache.repositoryId, initialized.repositoryId);
});

test("a clone preserves repository identity and creates only a local cache", async () => {
  const source = await createGitRepository();
  const identity = await initRepository(source);
  await git(source, "add", ".wsspec/repository.yaml");
  await git(source, "commit", "-m", "chore: initialize wspec");
  const clone = path.join(os.tmpdir(), `wspec-clone-${crypto.randomUUID()}`);
  await git(os.tmpdir(), "clone", source, clone);

  const cloned = await loadRepository(clone);

  assert.equal(cloned.repositoryId, identity.repositoryId);
});

test("repository cache mismatch fails closed", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const commonDir = path.resolve(root, await git(root, "rev-parse", "--git-common-dir"));
  await writeFile(
    path.join(commonDir, "wsspec", "repository.json"),
    `${JSON.stringify({ version: 1, repositoryId: "repo-00000000000000000000000000", repositoryRoot: root })}\n`,
    "utf8",
  );

  await assert.rejects(
    loadRepository(root),
    (error: unknown) => error instanceof RepositoryError && error.code === "WSPEC_REPOSITORY_ID_MISMATCH",
  );
});

test("workspace digest covers content, deletion, executable mode, symlinks and untracked files", async () => {
  const root = await createGitRepository();
  const initial = await computeWorkspaceTreeDigest(root);

  await writeFile(path.join(root, "untracked.txt"), "one\n", "utf8");
  const withUntracked = await computeWorkspaceTreeDigest(root);
  assert.notEqual(withUntracked, initial);

  await writeFile(path.join(root, "untracked.txt"), "two\n", "utf8");
  assert.notEqual(await computeWorkspaceTreeDigest(root), withUntracked);

  await chmod(path.join(root, "README.md"), 0o755);
  const executable = await computeWorkspaceTreeDigest(root);
  assert.notEqual(executable, withUntracked);

  await symlink("README.md", path.join(root, "readme-link"));
  const linked = await computeWorkspaceTreeDigest(root);
  assert.notEqual(linked, executable);

  await writeFile(path.join(root, "README.md"), "changed\n", "utf8");
  const changedTracked = await computeWorkspaceTreeDigest(root);
  assert.notEqual(changedTracked, linked);

  await unlink(path.join(root, "README.md"));
  assert.notEqual(await computeWorkspaceTreeDigest(root), changedTracked);
});

test("ignored files do not affect the workspace digest", async () => {
  const root = await createGitRepository();
  await writeFile(path.join(root, ".gitignore"), ".worktrees/\nignored.log\n", "utf8");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "test: ignore log");
  const before = await computeWorkspaceTreeDigest(root);

  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(path.join(root, "ignored.log"), "secret\n", "utf8");
  const after = await computeWorkspaceTreeDigest(root);

  assert.equal(after, before);
});

test("workspace digest preserves whitespace in Git paths", async () => {
  const root = await createGitRepository();
  const filename = path.join(root, " leading.txt");
  await writeFile(filename, "one\n", "utf8");
  const before = await computeWorkspaceTreeDigest(root);

  await writeFile(filename, "two\n", "utf8");

  assert.notEqual(await computeWorkspaceTreeDigest(root), before);
});
