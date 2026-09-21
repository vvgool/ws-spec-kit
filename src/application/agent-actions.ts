import { isDeepStrictEqual } from "node:util";
import os from "node:os";

import type { AcquireInput, AgentAction, InspectInput, SubmitResult, WorkItemView } from "../protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../protocol/work-package.js";
import { workPackageIdentityDigest } from "../domain/work-package-identity.js";
import { sha256 } from "../domain/digests.js";
import { canonicalDigest } from "../engine/external-effects/idempotency.js";
import { readEvents, type StoredEvent } from "../storage/events.js";
import { resolveWorkItemContext, type RuntimeProjection } from "../storage/control-plane.js";
import { submissionArtifactsOwnedByEngine } from "./submit.js";
import { validate } from "../schemas/index.js";
import { createApplication, type ApplicationDependencies } from "./application.js";
import { createApplicationArtifact, readArtifactDraftDigest } from "./artifact.js";
import { loadApplicationState, type ApplicationState } from "./state.js";
import { recoverApplication } from "./recover.js";
import { resumeActiveApplication, type ApplicationAttemptRecord } from "./acquire.js";

export type AgentContinueResult = AgentAction | { action: "guidance"; view: WorkItemView };
export interface AgentCompleteInput extends AcquireInput {
  /** The original grant returned by continue/acquire; never inferred from the latest task. */
  workPackage: WorkPackage;
  outputs: Array<{ outputId: string; contentFile: string }>;
  result: Omit<SubmitResult, "artifacts">;
}

export class AgentActionsError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(message);
    this.name = "AgentActionsError";
  }
}

function fail(code: `WSSPEC_${string}`, message: string): never { throw new AgentActionsError(code, message); }
function assertActor(actor: string): void {
  if (typeof actor !== "string" || !actor.trim()) fail("WSSPEC_ACTIVE_CLAIM_INVALID", "必须提供明确的 actor。");
}

function activePackage(state: ApplicationState, actor: string, now: Date): WorkPackage | undefined {
  const claims = Object.entries(state.projection.claims);
  if (claims.length === 0) return undefined;
  if (claims.length !== 1) fail("WSSPEC_ACTIVE_CLAIM_INVALID", "存在多个 Claim，无法自动选择当前执行包。");
  const [key, claim] = claims[0]!;
  if (claim.actor !== actor) fail("WSSPEC_STAGE_ALREADY_CLAIMED", "当前步骤属于其他 actor，不能接管。");
  if (!Number.isFinite(Date.parse(claim.expiresAt)) || Date.parse(claim.expiresAt) <= now.getTime()) {
    fail("WSSPEC_ATTEMPT_NOT_ACTIVE", "当前 Lease 已过期；请显式 acquire 重新领取并使用新 Work Package，continue 不自动重领。");
  }
  const context = state.projection.contexts[key] as ApplicationAttemptRecord | undefined;
  const wp = context?.workPackage;
  if (wp === undefined || wp.workItemId !== state.item.workItemId || wp.stepId !== claim.stageId
    || wp.attemptId !== claim.attemptId || wp.lease.token !== claim.claimToken
    || wp.lease.expiresAt !== claim.expiresAt || workPackageIdentityDigest(wp) !== claim.workPackageDigest) {
    fail("WSSPEC_ACTIVE_CLAIM_INVALID", "当前 Claim 与 Work Package 不一致。");
  }
  return wp;
}

async function assertProjectionAuthority(state: ApplicationState): Promise<StoredEvent[]> {
  const events = await readEvents(state.projection.controlPlane);
  const tip = events.at(-1);
  if (state.projection.lastSequence !== events.length || state.projection.lastEventHash !== (tip?.eventHash ?? null)) {
    fail("WSSPEC_ACTIVE_CLAIM_INVALID", "投影未绑定当前事件日志，请先显式 inspect 恢复。");
  }
  const latest = [...events].reverse().map(event => (event.result as { projection?: { claims?: unknown; contexts?: unknown } }).projection)
    .find(projection => projection !== undefined);
  if (latest !== undefined && (!isDeepStrictEqual(latest.claims, state.projection.claims)
    || !isDeepStrictEqual(latest.contexts, state.projection.contexts))) {
    fail("WSSPEC_ACTIVE_CLAIM_INVALID", "Claim 或 Context 偏离权威事件，拒绝自动恢复。");
  }
  return events;
}

function historicalBinding(events: StoredEvent[], wp: WorkPackage, actor: string): void {
  for (const event of [...events].reverse()) {
    const result = event.result as { projection?: { contexts?: Record<string, ApplicationAttemptRecord>; claims?: Record<string, { actor: string; attemptId: string }> } };
    for (const [key, context] of Object.entries(result.projection?.contexts ?? {})) {
      if (context.workPackage?.attemptId !== wp.attemptId) continue;
      const owner = context.actor ?? result.projection?.claims?.[key]?.actor;
      if (owner !== actor) fail("WSSPEC_STAGE_ALREADY_CLAIMED", "原 Attempt 属于其他 actor。");
      if (!isDeepStrictEqual(context.workPackage, wp)) fail("WSSPEC_ACTIVE_CLAIM_INVALID", "提交必须使用原始 Work Package。");
      return;
    }
  }
  fail("WSSPEC_ATTEMPT_NOT_ACTIVE", "找不到该 Work Package 的原始执行授权。");
}

async function replayArtifact(state: ApplicationState, wp: WorkPackage, output: WorkPackage["requiredOutputs"][number], contentFile: string, events: StoredEvent[]): Promise<ArtifactReference> {
  if (wp.artifactAuthoring === undefined) fail("WSSPEC_ARTIFACT_AUTHORING_UNAVAILABLE", "Work Package 未提供 Artifact authoring。");
  // Read-only grants author in the source repository, even after a later step materializes a worktree.
  const draftRoot = wp.workspace.materialized ? state.worktree
    : (await resolveWorkItemContext(state.worktree, wp.workItemId)).repositoryRoot;
  const sourceDigest = await readArtifactDraftDigest(draftRoot, contentFile, wp.artifactAuthoring);
  const event = events.find(candidate => candidate.idempotencyKey === `artifact:${wp.stepId}:${wp.attemptId}:${output.outputId}`);
  const expectedDigest = canonicalDigest({ workItemId: wp.workItemId, stepId: wp.stepId, attemptId: wp.attemptId,
    leaseDigest: sha256(wp.lease.token), artifactType: output.artifactType, outputId: output.outputId,
    ...(output.contentLevel === undefined ? {} : { contentLevel: output.contentLevel }), sourceDigest });
  if (event === undefined || event.inputDigest !== expectedDigest) fail("WSSPEC_ARTIFACT_CONFLICT", "重试的输出内容与原 Attempt 不一致。");
  const value = (event.result as { value: ArtifactReference }).value;
  return { artifactType: value.artifactType, outputId: value.outputId!, schemaVersion: value.schemaVersion,
    path: value.path!, mediaType: value.mediaType!, revision: value.revision!, contentHash: value.contentHash!,
    ...(value.contentLevel === undefined ? {} : { contentLevel: value.contentLevel }) };
}

/** Convenience operations retain the original application gates and never authorize a decision. */
export function createAgentActions(dependencies: ApplicationDependencies = {}) {
  const app = createApplication({ ...dependencies, preserveActiveClaim: true });
  const now = dependencies.now ?? (() => new Date());
  return {
    status: (input: InspectInput): Promise<WorkItemView> => app.inspect(input),
    async continue(input: AcquireInput): Promise<AgentContinueResult> {
      assertActor(input.actor);
      // inspect may recover abandoned leases; reject an expired grant before that mutation.
      const before = await loadApplicationState(input.root, input.workItemId);
      await assertProjectionAuthority(before);
      if (Object.keys(before.projection.claims).length > 0) {
        activePackage(before, input.actor, now());
        const active = await resumeActiveApplication(input, { now, home: dependencies.home ?? os.homedir() });
        if (active !== undefined) return active;
      }
      let view = await app.inspect({ root: input.root, workItemId: input.workItemId });
      if (view.nextAction.kind === "retry-test-gate" || view.nextAction.kind === "revalidate-red") {
        view = await recoverApplication({ ...input, reason: "按当前恢复指引继续任务" });
      }
      if (view.nextAction.kind !== "acquire") return { action: "guidance", view };
      const resumed = await resumeActiveApplication(input, { now, home: dependencies.home ?? os.homedir() });
      if (resumed !== undefined) return resumed;
      return app.acquire(input);
    },
    async complete(input: AgentCompleteInput): Promise<AgentAction> {
      assertActor(input.actor);
      const wp = validate<WorkPackage>(input.workPackage?.version === 1 ? "builtin.work-package.v1" : "builtin.work-package.v2", input.workPackage);
      if (wp.workItemId !== input.workItemId) fail("WSSPEC_ATTEMPT_NOT_ACTIVE", "Work Package 与显式 Work Item 不匹配。");
      validate("builtin.submit-result.v1", { ...input.result, artifacts: [] });
      if (!Array.isArray(input.outputs) || input.outputs.some(output => !output || typeof output.outputId !== "string" || typeof output.contentFile !== "string")
        || new Set(input.outputs.map(output => output.outputId)).size !== input.outputs.length) {
        fail("WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED", "outputs 必须提供唯一 outputId 及 contentFile。");
      }
      if (input.outputs.some(output => !wp.requiredOutputs.some(required => required.outputId === output.outputId))) {
        fail("WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED", "输出不属于原始 Work Package。");
      }
      const state = await loadApplicationState(input.root, input.workItemId);
      const authoritativeEvents = await assertProjectionAuthority(state);
      const replay = state.projection.idempotency[`submit:${wp.attemptId}`] !== undefined;
      const events = replay ? authoritativeEvents : [];
      if (replay) historicalBinding(events, wp, input.actor);
      else {
        const active = activePackage(state, input.actor, now());
        if (active === undefined || active.attemptId !== wp.attemptId) fail("WSSPEC_ATTEMPT_NOT_ACTIVE", "Attempt 已失效，请使用当前 Work Package。");
        if (!isDeepStrictEqual(active, wp)) fail("WSSPEC_ACTIVE_CLAIM_INVALID", "提交必须使用原始 Work Package，不能修改授权内容。");
      }
      let submissionProjection = state.projection;
      if (replay) {
        const original = [...events].reverse().map(event => (event.result as { projection?: RuntimeProjection }).projection)
          .find(projection => projection !== undefined && Object.values(projection.claims).some(claim => claim.attemptId === wp.attemptId));
        if (original === undefined) fail("WSSPEC_ATTEMPT_NOT_ACTIVE", "原 Attempt 的执行投影缺失。");
        submissionProjection = { ...state.projection, ...original };
      }
      const engineOwned = submissionArtifactsOwnedByEngine(state, wp.stepId, submissionProjection);
      if (engineOwned && input.outputs.length > 0) fail("WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED", "此步骤的证据必须由可信引擎生成，不接受 Agent 编写的输出文件。");
      const artifacts: ArtifactReference[] = [];
      for (const output of engineOwned ? [] : wp.requiredOutputs) {
        const draft = input.outputs.find(candidate => candidate.outputId === output.outputId);
        if (draft !== undefined) {
          artifacts.push(replay ? await replayArtifact(state, wp, output, draft.contentFile, events)
            : await createApplicationArtifact({ root: input.root, workItemId: input.workItemId, stepId: wp.stepId,
              attemptId: wp.attemptId, leaseToken: wp.lease.token, artifactType: output.artifactType,
              outputId: draft.outputId, contentFile: draft.contentFile }, { now }));
        } else {
          const existing = wp.artifacts.filter(artifact => artifact.artifactType === output.artifactType
            && (output.outputId === undefined || artifact.outputId === output.outputId));
          if (existing.length === 1) artifacts.push(existing[0]!);
          else if (input.result.status === "completed") fail("WSSPEC_ARTIFACT_OUTPUT_NOT_REQUIRED", `缺少输出 ${output.outputId ?? output.artifactType} 的 contentFile。`);
        }
      }
      return app.submit({ root: input.root, workItemId: input.workItemId, stepId: wp.stepId, attemptId: wp.attemptId,
        leaseToken: wp.lease.token, result: { ...input.result, artifacts } });
    },
  };
}
