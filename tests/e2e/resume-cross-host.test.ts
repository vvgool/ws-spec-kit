import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../src/cli/commands/core.js";
import { computeArtifactContentHash } from "../../src/domain/artifacts.js";
import { computeWorkspaceTreeDigest } from "../../src/domain/digests.js";
import { decideArtifactApproval } from "../../src/engine/approvals.js";
import { createGitRepository, git } from "../integration/helpers/git.js";

const bodies: Record<string, string> = {
  specification: ["# Specification", "## 目标与背景", "目标", "## 范围", "范围", "## 需求", "需求", "## 验收条件", "条件", "## 约束", "约束", "## 排除项", "无", "## 开放问题", "无", ""].join("\n"),
  design: ["# Design", "## 上下文与架构", "架构", "## 组件职责和边界", "边界", "## 接口与数据契约", "契约", "## 安全与权限", "安全", "## 失败与恢复", "恢复", "## 兼容或迁移", "兼容", "## 测试策略", "测试", "## 已知权衡", "权衡", ""].join("\n"),
  plan: ["# Plan", "## 有序交付任务", "任务", "## 任务依赖", "依赖", "## 精确文件范围", "范围", "## 验证方式", "验证", "## 人工检查点", "检查", "## 回滚方式", "回滚", ""].join("\n"),
  "implementation-result": ["# Implementation", "## 实际改动", "改动", "## 修改文件", "文件", "## 计划偏差", "无", "## 验证摘要", "摘要", "## 未完成项", "无", "## 残余风险", "无", ""].join("\n"),
  "review-result": ["# Review", "## Findings", "```yaml", "findings: []", "```", ""].join("\n"),
};

async function finishAgentStages(root: string, worktree: string, workItemId: string): Promise<void> {
  const outputs: Record<string, string> = { define: "specification", design: "design", plan: "plan", build: "implementation-result", review: "review-result" };
  for (const stageId of Object.keys(outputs)) {
    const next = await runCommand(worktree, ["next", workItemId], true) as { stageId?: string }; assert.equal(next.stageId, stageId);
    const claim = await runCommand(worktree, ["claim", workItemId, stageId, "codex"], true) as { attemptId: string };
    const context = await runCommand(worktree, ["context", workItemId, stageId], true) as { workflowDigest: string; contextDigest: string; baselineTreeDigest: string; inputWorkspaceTreeDigest: string };
    const artifactType = outputs[stageId]!; const artifactPath = `artifacts/${artifactType}.md`; await mkdir(path.join(worktree, "artifacts"), { recursive: true }); const metadata = { artifactType, schemaVersion: 1 as const, workItemId, stageId, attemptId: claim.attemptId, revision: 1 }; const contentHash = computeArtifactContentHash(metadata, bodies[artifactType]!);
    await writeFile(path.join(worktree, artifactPath), `---\nartifactType: ${artifactType}\nschemaVersion: 1\nworkItemId: ${workItemId}\nstageId: ${stageId}\nattemptId: ${claim.attemptId}\nrevision: 1\ncontentHash: ${contentHash}\n---\n${bodies[artifactType]}`);
    const result = { version: 1, workItemId, stageId, attemptId: claim.attemptId, workflowDigest: context.workflowDigest, contextDigest: context.contextDigest, baselineTreeDigest: context.baselineTreeDigest, inputWorkspaceTreeDigest: context.inputWorkspaceTreeDigest, outputWorkspaceTreeDigest: await computeWorkspaceTreeDigest(worktree), status: "completed", summary: "完成", modifiedFiles: [artifactPath], artifacts: [{ artifactType, schemaVersion: 1, path: artifactPath, revision: 1, contentHash, mediaType: "text/markdown" }], commands: [], evidence: [], externalWrites: [], remainingRisks: [] };
    const resultPath = path.join(os.tmpdir(), `wspec-result-${crypto.randomUUID()}.json`); await writeFile(resultPath, JSON.stringify(result)); const completed = await runCommand(worktree, ["complete", workItemId, stageId, resultPath], true) as { requestId?: string };
    if (completed.requestId !== undefined) await decideArtifactApproval({ cwd: root, workItemId, requestId: completed.requestId, decision: "approve", terminal: { isTTY: true } });
  }
}

test("a second host worktree reads and continues the same shared Work Item", async () => {
  const root = await createGitRepository(); await mkdir(path.join(root, ".wsspec"));
  await writeFile(path.join(root, ".wsspec/workflow.yaml"), `version: 1\nworkflow: { id: resume }\nstages:\n  - { id: define, kind: define, owner: agent, uses: artifact.generate, output: [specification], approval: { required: true, provider: interactive } }\n  - { id: design, kind: design, owner: agent, uses: artifact.generate, needs: [define], input: [specification], output: [design], approval: { required: true, provider: interactive } }\n  - { id: plan, kind: plan, owner: agent, uses: task.plan, needs: [design], input: [specification, design], output: [plan], approval: { required: true, provider: interactive } }\n  - { id: build, kind: implement, owner: agent, uses: engineering.implement, needs: [plan], input: [specification, design, plan], output: [implementation-result] }\n  - { id: review, kind: review, owner: agent, uses: engineering.review, needs: [build], input: [specification, design, implementation-result], output: [review-result] }\n  - { id: verify, kind: verify, owner: engine, uses: quality.verify, needs: [review], input: [implementation-result, review-result], gates: [test], output: [verification-result] }\n  - { id: close, kind: close, owner: engine, uses: work-item.close, needs: [verify] }\n`);
  await writeFile(path.join(root, ".wsspec/config.yaml"), `version: 1\ntrigger: { mode: suggest }\ngit:\n  worktrees: { enabled: true, root: .worktrees, branchPrefix: wspec/ }\nruntime: { claimTtlSeconds: 60, maxStageRetries: 3 }\nquality:\n  gates:\n    test: { command: [${process.execPath}, -e, process.exit(0)], cwd: worktree, timeoutSeconds: 10, required: true, evidence: trusted }\n`);
  await git(root, "add", "."); await git(root, "commit", "-m", "e2e fixture"); await runCommand(root, ["init"], true); await git(root, "add", ".wsspec/repository.yaml"); await git(root, "commit", "-m", "initialize wspec identity"); await runCommand(root, ["new", "WSS-E2E", "E2E", "prompt requirement"], true);
  const worktree = path.join(root, ".worktrees/WSS-E2E"); const fromRoot = await runCommand(root, ["status", "WSS-E2E"], true); const fromWorktree = await runCommand(worktree, ["status", "WSS-E2E"], true);
  assert.deepEqual(fromWorktree, fromRoot);
  assert.doesNotMatch(JSON.stringify(fromRoot), /controlPlane|claimToken|ownerToken|\/private\/|\/Users\//);
  await finishAgentStages(root, worktree, "WSS-E2E");
  const closed = await runCommand(worktree, ["next", "WSS-E2E"], true) as { status: string }; assert.equal(closed.status, "closed");
  await writeFile(path.join(root, "requirement.md"), "# Requirement\n\nDeliver from Markdown.\n"); await git(root, "add", "requirement.md"); await git(root, "commit", "-m", "add requirement");
  await runCommand(root, ["new-file", "WSS-E2E-FILE", "File E2E", "requirement.md"], true);
  await finishAgentStages(root, path.join(root, ".worktrees/WSS-E2E-FILE"), "WSS-E2E-FILE");
  const fileClosed = await runCommand(path.join(root, ".worktrees/WSS-E2E-FILE"), ["next", "WSS-E2E-FILE"], true) as { status: string }; assert.equal(fileClosed.status, "closed");
});

test("M2 collaboration commands fail explicitly instead of exposing partial behavior", async () => {
  await assert.rejects(runCommand(process.cwd(), ["issues"], true), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_FEATURE_NOT_AVAILABLE");
  await assert.rejects(runCommand(process.cwd(), ["knowledge"], true), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_FEATURE_NOT_AVAILABLE");
});
