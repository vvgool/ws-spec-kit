import { computeWorkspaceSnapshot, computeWorkspaceTreeDigest } from "../domain/digests.js";
import { verifyArtifact } from "../domain/artifacts.js";
import { transitionStage } from "../domain/states.js";
import { validate } from "../schemas/index.js";
import { readControlPlane, type RuntimeProjection } from "../storage/control-plane.js";
import { mutateControlPlane, transitionRuntime } from "./scheduler.js";
import type { StageContext } from "./claims.js";

export class StageResultError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "StageResultError"; }
}

function permitted(file: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => allowed === "" || file === allowed.replace(/\/$/, "") || file.startsWith(allowed.endsWith("/") ? allowed : `${allowed}/`));
}

export async function completeStage(input: { cwd: string; context: StageContext; result: unknown }): Promise<RuntimeProjection> {
  const result = validate<Record<string, unknown>>("builtin.stage-result.v1", input.result);
  const projection = await readControlPlane(input.cwd, input.context.workItemId);
  const claim = projection.claims[input.context.stageId];
  if (claim?.attemptId !== input.context.attemptId || claim.claimToken !== input.context.claimToken) throw new StageResultError("WSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 或 Claim 令牌已经失效。");
  if (result.contextDigest !== input.context.contextDigest || result.inputWorkspaceTreeDigest !== input.context.inputWorkspaceTreeDigest) throw new StageResultError("WSPEC_CONTEXT_STALE", "Result 与当前 Context 不匹配。");
  const worktree = await worktreeFor(input.cwd, input.context.workItemId);
  const output = await computeWorkspaceTreeDigest(worktree);
  if (result.outputWorkspaceTreeDigest !== output) throw new StageResultError("WSPEC_OUTPUT_DIGEST_MISMATCH", "Result 声明的输出工作区摘要不真实。");
  const current = await computeWorkspaceSnapshot(worktree);
  const before = new Map(claim.workspaceSnapshot.map((entry) => [entry.path, JSON.stringify(entry)]));
  const after = new Map(current.map((entry) => [entry.path, JSON.stringify(entry)]));
  const changed = new Set([...before.keys(), ...after.keys()].filter((file) => before.get(file) !== after.get(file)));
  if ([...changed].some((file) => !permitted(file, claim.allowedPaths))) throw new StageResultError("WSPEC_ALLOWED_PATHS_VIOLATION", "Attempt 修改了 allowedPaths 以外的文件。");
  const artifacts = result.artifacts as Array<{ artifactType?: string; path?: string }>;
  for (const expected of input.context.expectedOutputs) {
    const artifact = artifacts.find((candidate) => candidate.artifactType === expected.artifactType && typeof candidate.path === "string");
    if (artifact?.path === undefined) throw new StageResultError("WSPEC_REQUIRED_ARTIFACT_MISSING", `缺少必需 Artifact：${expected.artifactType}`);
    await verifyArtifact(pathFor(worktree, artifact.path), { repositoryRoot: worktree, artifactType: expected.artifactType, workItemId: input.context.workItemId, stageId: input.context.stageId, attemptId: input.context.attemptId });
  }
  return transitionRuntime({ cwd: input.cwd, workItemId: input.context.workItemId, scope: "stage", stageId: input.context.stageId, to: "validating", idempotencyKey: `complete:${input.context.attemptId}` });
}

function pathFor(root: string, relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new StageResultError("WSPEC_ARTIFACT_REFERENCE_INVALID", "Artifact 路径必须位于工作区内。");
  return `${root}/${normalized}`;
}

async function worktreeFor(cwd: string, workItemId: string): Promise<string> {
  const projection = await readControlPlane(cwd, workItemId);
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  const cache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryRoot: string };
  return path.join(cache.repositoryRoot, locator.worktree);
}

export async function invalidateFromArtifact(input: { cwd: string; workItemId: string; stageId: string }): Promise<RuntimeProjection> {
  const worktree = await worktreeFor(input.cwd, input.workItemId);
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const workflow = parse(await readFile(`${worktree}/.wsspec/work-items/${input.workItemId}/snapshot/workflow.yaml`, "utf8")) as { stages: Array<{ id: string; needs?: string[] }> };
  const affected = new Set([input.stageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of workflow.stages) {
      if (!affected.has(stage.id) && (stage.needs ?? []).some((dependency) => affected.has(dependency))) {
        affected.add(stage.id); changed = true;
      }
    }
  }
  await mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "projection.invalidated", idempotencyKey: `invalidate:${input.stageId}`,
    stageId: input.stageId, operationInput: { stageId: input.stageId, affected: [...affected].sort() },
    mutate: (current) => {
    let projection = { ...current, stages: { ...current.stages }, claims: { ...current.claims }, contexts: { ...current.contexts }, approvals: { ...current.approvals }, evidence: { ...current.evidence } };
    if (projection.stages[input.stageId] === undefined) throw new StageResultError("WSPEC_STAGE_NOT_FOUND", `找不到 Stage ${input.stageId}。`);
    for (const stageId of affected) {
      if (projection.stages[stageId]?.status === "cancelled" || projection.stages[stageId]?.status === "invalidated") continue;
      projection.stages[stageId] = transitionStage(projection.stages[stageId]!, { type: "transition", to: "invalidated" });
      delete projection.claims[stageId];
      delete projection.contexts[stageId];
      for (const [requestId, approval] of Object.entries(projection.approvals)) if (approval.stageId === stageId) delete projection.approvals[requestId];
      for (const [evidenceId, evidence] of Object.entries(projection.evidence)) if ((evidence as { stageId?: string }).stageId === stageId) delete projection.evidence[evidenceId];
    }
    return { projection, value: { invalidatedStages: [...affected].sort() } };
  }});
  return readControlPlane(input.cwd, input.workItemId);
}
