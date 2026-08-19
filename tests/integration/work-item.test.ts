import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { computeWorkspaceTreeDigest } from "../../src/domain/digests.js";
import { validate } from "../../src/schemas/index.js";
import { initRepository } from "../../src/storage/repository.js";
import { WorkItemError, createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "./helpers/git.js";

const workflow = "version: 1\nactiveWorkflow: { ref: builtin://workflows/feature-delivery, version: 1 }\nprofile: standard\n";

const config = `version: 1
trigger:
  mode: suggest
git:
  worktrees:
    enabled: true
    root: .worktrees
    branchPrefix: wspec/
runtime:
  claimTtlSeconds: 1800
  maxStageRetries: 3
quality:
  gates:
    test:
      command: [npm, test]
      cwd: worktree
      timeoutSeconds: 900
      required: true
      evidence: trusted
`;

async function prepareRepository(): Promise<string> {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "workflow.yaml"), workflow, "utf8");
  await writeFile(path.join(root, ".wsspec", "config.yaml"), config, "utf8");
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "chore: configure wspec");
  return root;
}

test("creates an isolated Work Item with immutable prompt source and snapshots", async () => {
  const root = await prepareRepository();
  const workItem = await createWorkItem({
    root,
    workItemId: "WSS-20260816-001",
    title: "支付重试",
    source: { type: "prompt", content: "实现支付重试" },
    createdAt: "2026-08-16T10:00:00+08:00",
  });
  const worktree = path.join(root, ".worktrees", workItem.workItemId);
  const itemRoot = path.join(worktree, ".wsspec", "work-items", workItem.workItemId);
  const manifest = parse(await readFile(path.join(itemRoot, "work-item.yaml"), "utf8")) as unknown;
  const source = JSON.parse(await readFile(path.join(itemRoot, workItem.source.snapshot), "utf8")) as {
    type: string;
    body: string;
    contentDigest: string;
  };

  assert.deepEqual(validate("builtin.work-item.v1", manifest), manifest);
  assert.equal(source.type, "user.prompt");
  assert.equal(source.body, "实现支付重试");
  assert.match(source.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await git(root, "worktree", "list", "--porcelain").then((value) => value.includes(worktree)), true);
  assert.equal(await git(root, "show-ref", "--verify", "refs/heads/wspec/WSS-20260816-001").then(() => true), true);
  await access(path.join(itemRoot, "snapshot", "workflow.yaml"));
  await access(path.join(itemRoot, "snapshot", "config.yaml"));
  await access(path.join(itemRoot, "snapshot", "schemas", "builtin-workflow-selection-v1.schema.json"));

  const commonDir = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const locator = JSON.parse(
    await readFile(path.join(commonDir, "wsspec", "work-items", workItem.workItemId, "locator.json"), "utf8"),
  ) as { repositoryId: string; workItemId: string; worktree: string };
  assert.equal(locator.repositoryId, workItem.repositoryId);
  assert.equal(locator.workItemId, workItem.workItemId);
  assert.equal(locator.worktree, `.worktrees/${workItem.workItemId}`);
});

test("captures Markdown file content instead of retaining a mutable source path", async () => {
  const root = await prepareRepository();
  await writeFile(path.join(root, "requirement.md"), "# Requirement\n\nRetry payment.\n", "utf8");

  const workItem = await createWorkItem({
    root,
    workItemId: "WSS-20260816-002",
    title: "支付重试文档",
    source: { type: "file", path: "requirement.md" },
    createdAt: "2026-08-16T10:01:00+08:00",
  });
  const snapshotPath = path.join(root, ".worktrees", workItem.workItemId, ".wsspec", "work-items", workItem.workItemId, workItem.source.snapshot);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { stableId: string; body: string };

  assert.equal(snapshot.stableId, "requirement.md");
  assert.match(snapshot.body, /Retry payment/);
});

test("baseline digest is measured from the created worktree when the caller is dirty", async (t) => {
  const cases: Array<[string, (root: string) => Promise<void>]> = [
    ["tracked content", async (root) => { await writeFile(path.join(root, "README.md"), "dirty tracked\n", "utf8"); }],
    ["untracked file", async (root) => { await writeFile(path.join(root, "untracked.txt"), "dirty untracked\n", "utf8"); }],
    ["executable mode", async (root) => { await chmod(path.join(root, "README.md"), 0o755); }],
    ["symlink", async (root) => { await symlink("README.md", path.join(root, "readme-link")); }],
  ];

  for (const [index, [name, makeDirty]] of cases.entries()) {
    await t.test(name, async () => {
      const root = await prepareRepository();
      await makeDirty(root);
      const callerDigest = await computeWorkspaceTreeDigest(root);
      const workItem = await createWorkItem({
        root,
        workItemId: `WSS-DIRTY-${index + 1}`,
        title: `Dirty caller ${name}`,
        source: { type: "prompt", content: "measure the created worktree" },
        createdAt: "2026-08-17T12:00:00.000Z",
      });
      const worktree = path.join(root, workItem.execution.worktree);
      await rm(path.join(worktree, ".wsspec", "work-items", workItem.workItemId), { recursive: true });
      const worktreeDigest = await computeWorkspaceTreeDigest(worktree);

      assert.notEqual(callerDigest, worktreeDigest);
      assert.equal(workItem.execution.baselineTreeDigest, worktreeDigest);
    });
  }
});

test("duplicate Work Item IDs fail without overwriting the existing snapshot", async () => {
  const root = await prepareRepository();
  const input = {
    root,
    workItemId: "WSS-20260816-003" as const,
    title: "First",
    source: { type: "prompt" as const, content: "first" },
    createdAt: "2026-08-16T10:02:00+08:00",
  };
  await createWorkItem(input);

  await assert.rejects(
    createWorkItem({ ...input, title: "Second", source: { type: "prompt", content: "second" } }),
    (error: unknown) => error instanceof WorkItemError && error.code === "WSSPEC_WORK_ITEM_ID_CONFLICT",
  );
  const manifestPath = path.join(
    root,
    ".worktrees",
    input.workItemId,
    ".wsspec",
    "work-items",
    input.workItemId,
    "work-item.yaml",
  );
  assert.match(await readFile(manifestPath, "utf8"), /title: First/);
});

test("an existing target branch fails closed before creating a worktree", async () => {
  const root = await prepareRepository();
  await git(root, "branch", "wspec/WSS-20260816-004");

  await assert.rejects(
    createWorkItem({
      root,
      workItemId: "WSS-20260816-004",
      title: "Conflict",
      source: { type: "prompt", content: "conflict" },
      createdAt: "2026-08-16T10:03:00+08:00",
    }),
    (error: unknown) => error instanceof WorkItemError && error.code === "WSSPEC_WORK_ITEM_ID_CONFLICT",
  );
});

test("file sources cannot escape the repository through a symlink", async () => {
  const root = await prepareRepository();
  const outside = path.join(os.tmpdir(), `wspec-secret-${crypto.randomUUID()}.md`);
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, path.join(root, "linked.md"));

  await assert.rejects(
    createWorkItem({
      root,
      workItemId: "WSS-20260816-005",
      title: "Escaping source",
      source: { type: "file", path: "linked.md" },
      createdAt: "2026-08-16T10:04:00+08:00",
    }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SOURCE_PATH_INVALID",
  );
});

test("worktree roots cannot escape the repository through a symlink", async () => {
  const root = await prepareRepository();
  const outside = path.join(os.tmpdir(), `wspec-worktrees-${crypto.randomUUID()}`);
  await mkdir(outside);
  await symlink(outside, path.join(root, ".worktrees"));

  await assert.rejects(
    createWorkItem({
      root,
      workItemId: "WSS-20260816-006",
      title: "Escaping worktree",
      source: { type: "prompt", content: "escape" },
      createdAt: "2026-08-16T10:05:00+08:00",
    }),
    (error: unknown) => error instanceof WorkItemError && error.code === "WSSPEC_CONTROL_PLANE_INVALID",
  );
  await assert.rejects(access(path.join(outside, "WSS-20260816-006")));
});
