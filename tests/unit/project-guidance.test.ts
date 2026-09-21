import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, link, realpath, rm, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { manageProjectGuidance, transformProjectGuidance } from "../../src/adapters/skills/project-guidance.js";

test("guidance setup is idempotent and remove preserves original bytes including newline style", () => {
  for (const original of ["", "# Existing", "# Existing\n", "# Existing\r\n\r\n"]) {
    const added = transformProjectGuidance(original, "setup");
    assert.match(added, /wsspeckit:begin/);
    assert.match(added, /wspec continue/);
    assert.equal(transformProjectGuidance(added, "setup"), added);
    assert.equal(transformProjectGuidance(added, "remove"), original);
  }
});

test("guidance preserves content appended after block", () => {
  const added = transformProjectGuidance("# Existing\n", "setup") + "\n# Later\n";
  assert.equal(transformProjectGuidance(added, "remove"), "# Existing\n\n# Later\n");
});

test("guidance rejects modified, unknown, duplicate and damaged markers", () => {
  const canonical = transformProjectGuidance("", "setup");
  for (const text of [canonical.replace("wspec continue", "evil"), canonical + canonical,
    "<!-- wsspeckit:begin -->", "<!-- wsspeckit:end -->", "<!-- wsspeckit:unknown -->"]) {
    assert.throws(() => transformProjectGuidance(text, "setup"), /区块/);
    assert.throws(() => transformProjectGuidance(text, "remove"), /区块/);
  }
});

test("project guidance filesystem lifecycle, dry run and unsafe file refusal", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-guidance-")));
  const target = path.join(root, "AGENTS.md");
  try {
    const preview = await manageProjectGuidance({ root, operation: "setup", dryRun: true });
    assert.equal(preview.changed, true);
    await assert.rejects(readFile(target));
    await writeFile(target, "# Mine\r\n");
    await manageProjectGuidance({ root, operation: "setup" });
    assert.equal((await manageProjectGuidance({ root, operation: "setup" })).changed, false);
    await manageProjectGuidance({ root, operation: "remove" });
    assert.equal(await readFile(target, "utf8"), "# Mine\r\n");
    await rm(target);
    await writeFile(path.join(root, "outside"), "private");
    await symlink(path.join(root, "outside"), target);
    await assert.rejects(manageProjectGuidance({ root, operation: "setup" }));
    await rm(target);
    await link(path.join(root, "outside"), target);
    await assert.rejects(manageProjectGuidance({ root, operation: "setup" }));
    assert.equal(await readFile(path.join(root, "outside"), "utf8"), "private");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project guidance refuses directory links, competing locks and user-edited blocks without changing files", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-guidance-")));
  const target = path.join(root, "AGENTS.md");
  try {
    await writeFile(target, "# Mine\n");
    await writeFile(path.join(root, ".wsspeckit-guidance.lock"), "other operation");
    await assert.rejects(manageProjectGuidance({ root, operation: "setup" }));
    assert.equal(await readFile(target, "utf8"), "# Mine\n");
    assert.equal(await readFile(path.join(root, ".wsspeckit-guidance.lock"), "utf8"), "other operation");
    await rm(path.join(root, ".wsspeckit-guidance.lock"));
    await symlink(root, path.join(root, "alias"));
    await assert.rejects(manageProjectGuidance({ root: path.join(root, "alias"), operation: "setup" }));
    const modified = transformProjectGuidance("# Mine\n", "setup").replace("wspec continue", "custom command");
    await writeFile(target, modified);
    await assert.rejects(manageProjectGuidance({ root, operation: "remove" }));
    assert.equal(await readFile(target, "utf8"), modified);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent guidance setup never duplicates or discards original instructions", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-guidance-")));
  try {
    await writeFile(path.join(root, "AGENTS.md"), "# Original\n");
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => manageProjectGuidance({ root, operation: "setup" })));
    assert.ok(attempts.some(result => result.status === "fulfilled"));
    const result = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.equal(result, transformProjectGuidance("# Original\n", "setup"));
    await manageProjectGuidance({ root, operation: "remove" });
    assert.equal(await readFile(path.join(root, "AGENTS.md"), "utf8"), "# Original\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("guidance rejects oversized resulting document before mutation, including dry run", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-guidance-")));
  const target = path.join(root, "AGENTS.md");
  try {
    const original = "x".repeat(1_048_576);
    await writeFile(target, original);
    await assert.rejects(manageProjectGuidance({ root, operation: "setup", dryRun: true }), /上限/);
    assert.equal(await readFile(target, "utf8"), original);
    await assert.rejects(manageProjectGuidance({ root, operation: "setup" }), /上限/);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal((await manageProjectGuidance({ root, operation: "remove" })).changed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("successful replacement preserves old inode for concurrent editor file descriptors", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-guidance-")));
  const target = path.join(root, "AGENTS.md");
  try {
    await writeFile(target, "# Original\n");
    const editor = await open(target, "r+");
    try {
      const result = await manageProjectGuidance({ root, operation: "setup" });
      assert.ok(result.recoveryFile);
      await editor.write("# Edited!!\n", 0, "utf8");
      await editor.sync();
      assert.equal(await readFile(result.recoveryFile, "utf8"), "# Edited!!\n");
      assert.equal(await readFile(target, "utf8"), transformProjectGuidance("# Original\n", "setup"));
      assert.equal((await manageProjectGuidance({ root, operation: "setup" })).recoveryFile, undefined);
    } finally { await editor.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery filename collision never removes a file this operation did not create", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-guidance-")));
  const target = path.join(root, "AGENTS.md");
  const recoveryId = "00000000-0000-4000-8000-000000000000";
  const recoveryFile = path.join(root, `.wsspeckit-guidance-recovery-${recoveryId}.md`);
  try {
    await writeFile(target, "# Original\n");
    await writeFile(recoveryFile, "# Existing recovery\n");
    await assert.rejects(manageProjectGuidance({ root, operation: "setup" }, { randomUUID: () => recoveryId }));
    assert.equal(await readFile(target, "utf8"), "# Original\n");
    assert.equal(await readFile(recoveryFile, "utf8"), "# Existing recovery\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
