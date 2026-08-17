import { readFile } from "node:fs/promises";
import path from "node:path";
import * as canonicalizeModule from "canonicalize";
import { parse } from "yaml";

import { computeWorkspaceSnapshot, computeWorkspaceTreeDigest, sha256 } from "../domain/digests.js";
import { transitionStage } from "../domain/states.js";
import { readControlPlane, type RuntimeClaim } from "../storage/control-plane.js";
import { mutateControlPlane } from "./scheduler.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

export interface Claim extends RuntimeClaim {
  cwd: string;
  workItemId: string;
  worktree: string;
}

export interface StageContext {
  version: 1;
  workItemId: string;
  stageId: string;
  attemptId: string;
  claimToken: string;
  claimExpiresAt: string;
  workflowDigest: string;
  configDigest: string;
  baselineTreeDigest: string;
  inputWorkspaceTreeDigest: string;
  contextDigest: string;
  objective: string;
  inputs: unknown[];
  expectedOutputs: Array<{ artifactType: string; schemaVersion: 1 }>;
  allowedPaths: string[];
  gates: string[];
  resultSchema: "builtin.stage-result.v1";
}

export class ClaimError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ClaimError"; }
}

async function locations(cwd: string, workItemId: string): Promise<{ worktree: string; manifest: string; workflow: string; config: string }> {
  const projection = await readControlPlane(cwd, workItemId);
  const locatorRoot = path.dirname(projection.controlPlane);
  const locator = JSON.parse(await readFile(path.join(locatorRoot, "locator.json"), "utf8")) as { worktree: string };
  const cache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryRoot: string; repositoryId: string };
  if (cache.repositoryId !== projection.repositoryId) throw new ClaimError("WSSPEC_REPOSITORY_ID_MISMATCH", "仓库身份不一致。");
  const itemRoot = path.join(cache.repositoryRoot, locator.worktree, ".wsspec", "work-items", workItemId);
  return { worktree: path.join(cache.repositoryRoot, locator.worktree), manifest: path.join(itemRoot, "work-item.yaml"), workflow: path.join(itemRoot, "snapshot", "workflow.yaml"), config: path.join(itemRoot, "snapshot", "config.yaml") };
}

export async function claimStage(input: { cwd: string; workItemId: string; stageId: string; actor: string; allowedPaths?: string[]; now?: string }): Promise<Claim> {
  const place = await locations(input.cwd, input.workItemId);
  const claim = await mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "claim.created", idempotencyKey: `claim:${crypto.randomUUID()}`,
    stageId: input.stageId, actor: input.actor, operationInput: { stageId: input.stageId, actor: input.actor, now: input.now ?? null, allowedPaths: input.allowedPaths ?? [""] },
    mutate: async (projection) => {
    const existing = projection.claims[input.stageId];
    const now = new Date(input.now ?? Date.now());
    if (existing !== undefined) {
      if (new Date(existing.expiresAt) > now) throw new ClaimError("WSSPEC_STAGE_ALREADY_CLAIMED", `Stage ${input.stageId} 已被领取。`);
      projection = { ...projection, stages: { ...projection.stages, [input.stageId]: transitionStage(projection.stages[input.stageId]!, { type: "transition", to: "ready" }) }, claims: { ...projection.claims }, contexts: { ...projection.contexts } };
      delete projection.claims[input.stageId]; delete projection.contexts[input.stageId];
    }
    if (projection.stages[input.stageId]?.status !== "ready") throw new ClaimError("WSSPEC_STAGE_NOT_READY", `Stage ${input.stageId} 当前不可领取。`);
    const config = parse(await readFile(place.config, "utf8")) as { runtime: { claimTtlSeconds: number } };
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const claimToken = crypto.randomUUID();
    const inputWorkspaceTreeDigest = await computeWorkspaceTreeDigest(place.worktree);
    const claim: RuntimeClaim = {
      stageId: input.stageId,
      attemptId,
      claimToken,
      actor: input.actor,
      claimedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.runtime.claimTtlSeconds * 1000).toISOString(),
      inputWorkspaceTreeDigest,
      allowedPaths: input.allowedPaths ?? [""],
      workspaceSnapshot: await computeWorkspaceSnapshot(place.worktree),
    };
    projection = { ...projection, stages: { ...projection.stages, [input.stageId]: transitionStage(projection.stages[input.stageId]!, { type: "transition", to: "claimed" }) }, claims: { ...projection.claims, [input.stageId]: claim } };
    return { projection, value: claim };
  }});
  return { ...claim, cwd: input.cwd, workItemId: input.workItemId, worktree: place.worktree };
}

export async function buildStageContext(claim: Claim): Promise<StageContext> {
  const projection = await readControlPlane(claim.cwd, claim.workItemId);
  const active = projection.claims[claim.stageId];
  if (active?.attemptId !== claim.attemptId || active.claimToken !== claim.claimToken) throw new ClaimError("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 已失效。");
  const place = await locations(claim.cwd, claim.workItemId);
  const [manifestText, workflowText] = await Promise.all([readFile(place.manifest, "utf8"), readFile(place.workflow, "utf8")]);
  const manifest = parse(manifestText) as { execution: { workflowDigest: string; configDigest: string; baselineTreeDigest: string } };
  const workflow = parse(workflowText) as { stages: Array<{ id: string; uses: string; output?: string[]; gates?: string[] }> };
  const stage = workflow.stages.find((candidate) => candidate.id === claim.stageId);
  if (stage === undefined) throw new ClaimError("WSSPEC_STAGE_NOT_FOUND", `找不到 Stage ${claim.stageId}。`);
  const unsigned = {
    version: 1 as const, workItemId: claim.workItemId, stageId: claim.stageId, attemptId: claim.attemptId,
    claimToken: claim.claimToken, claimExpiresAt: claim.expiresAt, ...manifest.execution,
    inputWorkspaceTreeDigest: claim.inputWorkspaceTreeDigest, objective: stage.uses, inputs: [],
    expectedOutputs: (stage.output ?? []).map((artifactType) => ({ artifactType, schemaVersion: 1 as const })),
    allowedPaths: claim.allowedPaths, gates: stage.gates ?? [], resultSchema: "builtin.stage-result.v1" as const,
  };
  const content = canonicalize(unsigned);
  if (content === undefined) throw new ClaimError("WSSPEC_CONTEXT_INVALID", "Context 无法规范化。");
  const context: StageContext = { ...unsigned, contextDigest: sha256(content) };
  return mutateControlPlane({
    cwd: claim.cwd, workItemId: claim.workItemId, eventType: "context.created", idempotencyKey: `context:${claim.attemptId}`,
    stageId: claim.stageId, attemptId: claim.attemptId, actor: claim.actor, operationInput: { stageId: claim.stageId, attemptId: claim.attemptId, contextDigest: context.contextDigest },
    mutate: (current) => {
      const currentClaim = current.claims[claim.stageId];
      if (currentClaim?.attemptId !== claim.attemptId || currentClaim.claimToken !== claim.claimToken) throw new ClaimError("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 已失效。");
      return { projection: { ...current, contexts: { ...current.contexts, [claim.stageId]: context } }, value: context };
    },
  });
}

export async function renewClaim(input: { cwd: string; workItemId: string; stageId: string; attemptId: string; claimToken: string; now?: string }): Promise<RuntimeClaim> {
  const place = await locations(input.cwd, input.workItemId);
  return mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "claim.renewed", idempotencyKey: `renew:${input.attemptId}:${input.now ?? "now"}`,
    stageId: input.stageId, attemptId: input.attemptId, operationInput: { stageId: input.stageId, attemptId: input.attemptId, now: input.now ?? null },
    mutate: async (projection) => {
    const claim = projection.claims[input.stageId];
    if (claim?.attemptId !== input.attemptId || claim.claimToken !== input.claimToken) throw new ClaimError("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 或 Claim 令牌已经失效。");
    const now = new Date(input.now ?? Date.now());
    if (new Date(claim.expiresAt) <= now) throw new ClaimError("WSSPEC_CLAIM_EXPIRED", "Claim 已过期。");
    const config = parse(await readFile(place.config, "utf8")) as { runtime: { claimTtlSeconds: number } };
    const renewed = { ...claim, expiresAt: new Date(now.getTime() + config.runtime.claimTtlSeconds * 1000).toISOString() };
    return { projection: { ...projection, claims: { ...projection.claims, [input.stageId]: renewed } }, value: renewed };
  }});
}

export async function releaseClaim(input: { cwd: string; workItemId: string; stageId: string; attemptId: string; claimToken: string }): Promise<void> {
  await mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "claim.released", idempotencyKey: `release:${input.attemptId}`,
    stageId: input.stageId, attemptId: input.attemptId, operationInput: { stageId: input.stageId, attemptId: input.attemptId },
    mutate: (projection) => {
    const claim = projection.claims[input.stageId];
    if (claim?.attemptId !== input.attemptId || claim.claimToken !== input.claimToken) throw new ClaimError("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 或 Claim 令牌已经失效。");
    projection = { ...projection, stages: { ...projection.stages, [input.stageId]: transitionStage(projection.stages[input.stageId]!, { type: "transition", to: "ready" }) }, claims: { ...projection.claims }, contexts: { ...projection.contexts } };
    delete projection.claims[input.stageId];
    delete projection.contexts[input.stageId];
    return { projection, value: undefined };
  }});
}
