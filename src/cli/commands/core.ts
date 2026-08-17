import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { claimStage, buildStageContext, type Claim } from "../../engine/claims.js";
import { completeStage } from "../../engine/results.js";
import { verifyWorkItem } from "../../engine/verification.js";
import { closeWorkItem } from "../../engine/archive.js";
import { transitionRuntime } from "../../engine/scheduler.js";
import { advanceWorkflow } from "../../engine/orchestrator.js";
import { workflowFor } from "../../engine/orchestrator.js";
import { requestArtifactApproval } from "../../engine/approvals.js";
import { compileWorkflow, type ProjectConfig } from "../../engine/compiler.js";
import type { Workflow } from "../../domain/workflow.js";
import { initializeControlPlane, readControlPlane, recoverControlPlane } from "../../storage/control-plane.js";
import { initRepository } from "../../storage/repository.js";
import { createWorkItem } from "../../storage/work-items.js";

export class CliError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "CliError"; } }

function required(args: string[], index: number, name: string): string { const value = args[index]; if (value === undefined) throw new CliError("WSPEC_ARGUMENT_REQUIRED", `缺少参数 ${name}。`); return value; }

export async function runCommand(cwd: string, argv: string[], _json = false): Promise<unknown> {
  const [command, ...args] = argv.filter((arg) => arg !== "--json");
  if (command === "issues" || command === "knowledge") throw new CliError("WSPEC_FEATURE_NOT_AVAILABLE", `${command} 属于 M2，当前版本不可用。`);
  if (command === "init") return initRepository(cwd);
  if (command === "new" || command === "new-file") {
    const workItemId = required(args, 0, "workItemId") as `WSK-${string}`; const title = required(args, 1, "title"); const source = required(args, 2, "source");
    const workflowSource = parse(await readFile(path.join(cwd, ".wsspec/workflow.yaml"), "utf8")) as Workflow;
    const configSource = parse(await readFile(path.join(cwd, ".wsspec/config.yaml"), "utf8")) as ProjectConfig;
    compileWorkflow(workflowSource, configSource);
    const item = await createWorkItem({ root: cwd, workItemId, title, source: command === "new" ? { type: "prompt", content: source } : { type: "file", path: source } });
    const workflow = parse(await readFile(path.join(cwd, item.execution.worktree, ".wsspec/work-items", workItemId, "snapshot/workflow.yaml"), "utf8")) as { stages: Array<{ id: string }> };
    await initializeControlPlane({ cwd, workItemId, stages: workflow.stages.map((stage) => stage.id) });
    await transitionRuntime({ cwd, workItemId, scope: "work-item", to: "active", idempotencyKey: "work-item-created" });
    return item;
  }
  const workItemId = required(args, 0, "workItemId");
  if (command === "status") {
    const projection = await readControlPlane(cwd, workItemId);
    return {
      version: projection.version,
      repositoryId: projection.repositoryId,
      workItemId: projection.workItemId,
      workItem: projection.workItem,
      stages: projection.stages,
      lastSequence: projection.lastSequence,
      lastEventHash: projection.lastEventHash,
      claims: Object.fromEntries(Object.entries(projection.claims).map(([stageId, claim]) => [stageId, { stageId: claim.stageId, attemptId: claim.attemptId, actor: claim.actor, claimedAt: claim.claimedAt, expiresAt: claim.expiresAt }])),
      approvals: projection.approvals,
      evidence: projection.evidence,
      readOnly: projection.readOnly,
    };
  }
  if (command === "recover") return recoverControlPlane({ cwd, workItemId });
  if (command === "verify") return verifyWorkItem({ cwd, workItemId });
  if (command === "close") return closeWorkItem({ cwd, workItemId });
  if (command === "next") return advanceWorkflow(cwd, workItemId);
  if (command === "claim") return claimStage({ cwd, workItemId, stageId: required(args, 1, "stageId"), actor: required(args, 2, "actor") });
  if (command === "context") {
    const stageId = required(args, 1, "stageId"); const projection = await readControlPlane(cwd, workItemId); const claim = projection.claims[stageId];
    if (claim === undefined) throw new CliError("WSPEC_ATTEMPT_NOT_ACTIVE", "Stage 没有活动 Claim。");
    const context = await buildStageContext({ ...claim, cwd, workItemId, worktree: "" } satisfies Claim);
    await transitionRuntime({ cwd, workItemId, scope: "stage", stageId, to: "running", idempotencyKey: `start:${claim.attemptId}` });
    return context;
  }
  if (command === "complete") {
    const stageId = required(args, 1, "stageId"); const resultPath = required(args, 2, "result"); const projection = await readControlPlane(cwd, workItemId); const context = projection.contexts[stageId];
    if (context === undefined) throw new CliError("WSPEC_CONTEXT_STALE", "Stage 没有活动 Context。");
    const result = JSON.parse(await readFile(path.resolve(cwd, resultPath), "utf8")) as { attemptId: string; artifacts?: Array<{ path?: string }> };
    await completeStage({ cwd, context: context as never, result });
    const stage = (await workflowFor(cwd, workItemId)).stages.find((candidate) => candidate.id === stageId);
    if (stage?.approval?.required === true) {
      const artifactPath = result.artifacts?.[0]?.path; if (artifactPath === undefined) throw new CliError("WSPEC_REQUIRED_ARTIFACT_MISSING", "审批 Stage 缺少 Artifact。");
      return requestArtifactApproval({ cwd, workItemId, stageId, attemptId: result.attemptId, artifactPath });
    }
    return transitionRuntime({ cwd, workItemId, scope: "stage", stageId, to: "succeeded", idempotencyKey: `validated:${result.attemptId}` });
  }
  throw new CliError("WSPEC_COMMAND_UNKNOWN", `未知命令：${command ?? ""}`);
}
