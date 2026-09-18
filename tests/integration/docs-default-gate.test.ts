import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../../src/cli/commands/core.js";
import { initRepository } from "../../src/storage/repository.js";
import { readControlPlane } from "../../src/storage/control-plane.js";
import { createGitRepository, git } from "./helpers/git.js";
import { completedResult, requireExecute, worktreeFor } from "./helpers/control-runtime.js";
import type { AgentAction } from "../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../src/protocol/work-package.js";

async function submit(root: string, tree: string, pkg: WorkPackage, modifiedFiles: string[] = [], rejectReview = false) {
  const refs: ArtifactReference[] = [];
  const drafts = path.join(tree, `.wsspec/work-items/${pkg.workItemId}/drafts`);
  await mkdir(drafts, { recursive: true });
  for (const output of pkg.requiredOutputs) {
    if (output.artifactType === "requirement-source") { refs.push(pkg.artifacts.find(a => a.artifactType === "requirement-source")!); continue; }
    const file = path.join(drafts, `${output.outputId}.md`);
    const body = output.artifactType === "review-result"
      ? '# Findings\n\n```yaml\nfindings: '+(rejectReview ? '\n  - id: finding-1\n    severity: P1\n    description: Fix documentation\n    evidence: observed\n    path: docs/new.md\n    disposition: open' : '[]')+'\n```\n'
      : output.artifactType === "tasks" ? '# 任务\n```yaml\ntasks:\n  - id: docs\n    status: pending\n    dependencies: []\n    completion: docs validated\n```\n' : '# 目标与背景\nDocument changes.\n# 范围\nDocumentation.\n# 需求\nValid docs.\n# 验收条件\nIntegrity.\n# 约束\nLocal.\n# 排除项\nNone.\n# 开放问题\nNone.\n';
    await writeFile(file, body);
    refs.push(await runCommand(root, ["artifact", "create", "--work-item", pkg.workItemId, "--step", pkg.stepId, "--attempt", pkg.attemptId, "--lease-token", pkg.lease.token, "--artifact-type", output.artifactType, "--output", output.outputId!, "--content-file", path.relative(tree, file)]) as ArtifactReference);
  }
  const resultPath = path.join(drafts, "submit.json");
  await writeFile(resultPath, JSON.stringify({ ...completedResult(pkg, refs), modifiedFiles }));
  return runCommand(root, ["submit", pkg.workItemId, "--step", pkg.stepId, "--attempt", pkg.attemptId, "--lease", pkg.lease.token, "--result", resultPath, "--actor", "docs-agent"]) as Promise<AgentAction>;
}

test("default CLI records trusted docs integrity and rechecks new loop files and deletions", async () => {
  const root = await createGitRepository();
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs/obsolete.md"), "# Obsolete\n");
  await initRepository(root);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "seed docs");
  const started = await runCommand(root, ["start", "--prompt", "Update docs", "--workflow", "builtin://workflows/documentation-delivery", "--profile", "quick"]) as { workItemId: string };
  let action = await runCommand(root, ["acquire", started.workItemId, "--actor", "docs-agent"]) as AgentAction;
  const tree = await worktreeFor(root, started.workItemId);
  for (let count = 0; count < 12; count++) {
    const pkg = requireExecute(action);
    if (pkg.stepId === "edit-document") {
      await writeFile(path.join(tree, "docs/new.md"), "# New\n");
      await rm(path.join(tree, "docs/obsolete.md"));
      action = await submit(root, tree, pkg, ["docs/new.md", "docs/obsolete.md"]);
    } else if (pkg.stepId.endsWith(":review")) { action = await submit(root, tree, pkg, [], true); }
    else if (pkg.stepId.endsWith(":fix")) {
      await writeFile(path.join(tree, "docs/loop.txt"), "<<<<<<< unresolved\n");
      action = await submit(root, tree, pkg, ["docs/loop.txt"]);
    } else if (pkg.stepId.endsWith(":verify")) {
      const before = await readControlPlane(root, started.workItemId);
      assert.equal((before.evidence["verify-document:gate:docs.integrity"] as { level: string }).level, "trusted");
      action = await submit(root, tree, pkg);
      const after = await readControlPlane(root, started.workItemId);
      assert.equal(after.evidence["verify-document:gate:docs.integrity"], undefined);
      const result = (after.contexts[pkg.stepId] as { result: { status: string; failureCode: string; summary: string } }).result;
      assert.equal(result.status, "failed");
      assert.equal(result.failureCode, "WSSPEC_STEP_FAILED");
      assert.match(result.summary, /docs\/loop.txt/);
      assert.equal(action.action, "blocked");
      const retry = requireExecute(await runCommand(root, ["acquire", started.workItemId, "--actor", "docs-agent"]) as AgentAction);
      assert.equal(retry.stepId, pkg.stepId);
      await writeFile(path.join(tree, "docs/loop.txt"), "Resolved documentation.\n");
      await submit(root, tree, retry, ["docs/loop.txt"]);
      const recovered = await readControlPlane(root, started.workItemId);
      const evidence = recovered.evidence["verify-document:gate:docs.integrity"] as { evidenceId: string; result: string };
      assert.equal(evidence.result, "passed");
      assert.equal(evidence.evidenceId, `evidence-docs-${retry.attemptId}`);
      return;
    } else { action = await submit(root, tree, pkg); }
  }
  assert.fail("did not reach loop verification");
});
