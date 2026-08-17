import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { computeArtifactContentHash } from "../../src/domain/artifacts.js";
import { decideArtifactApproval, requestArtifactApproval } from "../../src/engine/approvals.js";
import { transitionRuntime } from "../../src/engine/scheduler.js";
import { initializeControlPlane, readControlPlane } from "../../src/storage/control-plane.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "../integration/helpers/git.js";

function run(command: string, args: string[], cwd: string, input = ""): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, output })); child.stdin.end(input);
  });
}

async function approvalFixture() {
  const root = await createGitRepository(); await initRepository(root); await mkdir(path.join(root, ".wsspec"), { recursive: true });
  await writeFile(path.join(root, ".wsspec/workflow.yaml"), `version: 1\nworkflow: { id: approval-e2e }\nstages:\n  - { id: define, kind: define, owner: agent, uses: artifact.generate, output: [specification], approval: { required: true, provider: interactive } }\n`);
  await writeFile(path.join(root, ".wsspec/config.yaml"), `version: 1\ntrigger: { mode: suggest }\ngit:\n  worktrees: { enabled: true, root: .worktrees, branchPrefix: wspec/ }\nruntime: { claimTtlSeconds: 60, maxStageRetries: 3 }\nquality:\n  gates:\n    test: { command: [${process.execPath}, -e, process.exit(0)], cwd: worktree, timeoutSeconds: 10, required: true, evidence: trusted }\n`);
  await git(root, "add", "."); await git(root, "commit", "-m", "approval e2e"); const workItemId = `WSS-TTY-${crypto.randomUUID()}` as `WSS-${string}`;
  const item = await createWorkItem({ root, workItemId, title: "TTY", source: { type: "prompt", content: "TTY" } }); const worktree = path.join(root, item.execution.worktree); await initializeControlPlane({ cwd: root, workItemId, stages: ["define"] });
  await transitionRuntime({ cwd: root, workItemId, scope: "work-item", to: "active", idempotencyKey: "active" }); for (const [to, key] of [["ready", "ready"], ["running", "run"], ["validating", "validate"]] as const) await transitionRuntime({ cwd: root, workItemId, scope: "stage", stageId: "define", to, idempotencyKey: key });
  const body = ["# 规格", "", "## 目标与背景", "目标", "## 范围", "范围", "## 需求", "需求", "## 验收条件", "条件", "## 约束", "约束", "## 排除项", "无", "## 开放问题", "无", ""].join("\n"); const metadata = { artifactType: "specification", schemaVersion: 1 as const, workItemId, stageId: "define", attemptId: "attempt-tty", revision: 1 }; const contentHash = computeArtifactContentHash(metadata, body); const artifactPath = "artifacts/specification.md";
  await mkdir(path.join(worktree, "artifacts")); await writeFile(path.join(worktree, artifactPath), `---\nartifactType: specification\nschemaVersion: 1\nworkItemId: ${workItemId}\nstageId: define\nattemptId: attempt-tty\nrevision: 1\ncontentHash: ${contentHash}\n---\n${body}`); const request = await requestArtifactApproval({ cwd: root, workItemId, stageId: "define", attemptId: "attempt-tty", artifactPath }); return { root, worktree, workItemId, requestId: request.requestId };
}

test("approval CLI rejects pipes and --yes before reading a decision", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const piped = await run(process.execPath, ["--import", "tsx", "src/cli/main.ts", "approve", "missing", "missing"], root, "approve\n");
  assert.notEqual(piped.code, 0); assert.match(piped.output, /WSSPEC_INTERACTIVE_TTY_REQUIRED/);
  const flag = await run(process.execPath, ["--import", "tsx", "src/cli/main.ts", "approve", "missing", "missing", "--yes"], root);
  assert.notEqual(flag.code, 0); assert.match(flag.output, /WSSPEC_INTERACTIVE_TTY_REQUIRED/);
});

test("approval engine accepts a decision only when its terminal boundary is TTY", async () => {
  await assert.rejects(decideArtifactApproval({ cwd: process.cwd(), workItemId: "missing", requestId: "missing", decision: "approve", terminal: process.stdin }), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_INTERACTIVE_TTY_REQUIRED");
});

test("approval CLI approves and rejects through an allocated pseudo-terminal", async () => {
  const project = path.resolve(import.meta.dirname, "../..");
  for (const decision of ["approve", "reject"] as const) {
    const fixture = await approvalFixture();
    const loader = path.join(project, "node_modules/tsx/dist/loader.mjs");
    const program = `set timeout 10\nspawn ${process.execPath} --import ${loader} ${project}/src/cli/main.ts ${decision} ${fixture.workItemId} ${fixture.requestId}\nexpect "输入 ${decision}"\nsend "${decision}\\r"\nexpect eof\ncatch wait result\nexit [lindex $result 3]`;
    const result = await run("expect", ["-c", program], fixture.worktree);
    assert.equal(result.code, 0, result.output); assert.match(result.output, /contentHash/); assert.match(result.output, /outputWorkspaceTreeDigest/); assert.match(result.output, /invalidationScope/); assert.match(result.output, /diff/);
    const projection = await readControlPlane(fixture.root, fixture.workItemId); assert.equal(projection.approvals[fixture.requestId]?.status, decision === "approve" ? "approved" : "rejected");
  }
});
