import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runWorkflowCommand } from "../../src/adapters/cli/workflow.js";
import { initRepository } from "../../src/storage/repository.js";
import { createGitRepository } from "../integration/helpers/git.js";

test("Workflow 命令列出、展示、校验内置 Package，并且拒绝不存在的 Package", async () => {
  const root = await createGitRepository();
  const listed = await runWorkflowCommand({ root, argv: ["list"] }) as { workflows: Array<{ ref: string }> };
  assert.deepEqual(listed.workflows.map(({ ref }) => ref), [
    "builtin://workflows/documentation-delivery",
    "builtin://workflows/feature-delivery",
  ]);
  const shown = await runWorkflowCommand({ root, argv: ["show", "builtin://workflows/feature-delivery"] }) as { workflow: { ref: string } };
  assert.equal(shown.workflow.ref, "builtin://workflows/feature-delivery");
  const validated = await runWorkflowCommand({ root, argv: ["validate", "builtin://workflows/documentation-delivery"] }) as { valid: boolean };
  assert.equal(validated.valid, true);
  await assert.rejects(runWorkflowCommand({ root, argv: ["show", "builtin://workflows/missing"] }), /WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND/);
});

test("workflow eject 原子复制内置 Package 且拒绝覆盖已有目标", async () => {
  const root = await createGitRepository();
  const target = path.join(await mkdtemp(path.join(os.tmpdir(), "wspec-eject-")), "feature-delivery");
  const first = await runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] }) as { target: string };
  assert.equal(first.target, target);
  await assert.rejects(runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] }), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS");
});

test("workflow use 先校验后请求信任，未确认时不修改项目选择", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const target = path.join(root, ".wsspec", "workflows", "feature-delivery");
  await runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] });
  const before = await readFile(path.join(root, ".wsspec", "workflow.yaml"), "utf8");
  await assert.rejects(
    runWorkflowCommand({ root, argv: ["use", "project://workflows/feature-delivery"], interactive: false }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_WORKFLOW_TRUST_REQUIRED",
  );
  const blocked = await runWorkflowCommand({ root, argv: ["use", "project://workflows/feature-delivery"], interactive: true, actor: "reviewer" }) as { status: string; trust: { packageDigest: string; capabilityDigest: string } };
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.trust.packageDigest, /^sha256:/);
  assert.match(blocked.trust.capabilityDigest, /^sha256:/);
  assert.equal(await readFile(path.join(root, ".wsspec", "workflow.yaml"), "utf8"), before);
});
