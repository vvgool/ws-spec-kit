import { computeWorkspaceTreeDigest } from "../domain/digests.js";
import {
  assertGrantAuthorizes,
  createExternalActionGrant,
  createExternalActionRequest,
  ExternalAuthorizationError,
  transitionExternalAction,
  type ExternalActionGrant,
  type ExternalActionName,
  type ExternalActionRequest,
  type ExternalActionState,
  type ExternalActionTarget,
  type ExternalWriteReceipt,
} from "../engine/external-effects/authorization.js";
import { canonicalDigest, externalIdempotencyKey, ExternalIdempotencyError } from "../engine/external-effects/idempotency.js";
import { ControlPlaneError, mutateControlPlane } from "../engine/scheduler.js";
import { readControlPlane, type RuntimeProjection } from "../storage/control-plane.js";
import { persistExternalActionPayload } from "../storage/external-action-payload.js";
import { loadApplicationState, selectedProfile } from "./state.js";
import { validate } from "../schemas/index.js";

export { ExternalAuthorizationError as ExternalActionError } from "../engine/external-effects/authorization.js";
export type { ExternalActionGrant, ExternalActionName, ExternalActionRequest, ExternalActionState, ExternalWriteReceipt } from "../engine/external-effects/authorization.js";

export interface ExternalActionPrepareInput {
  root: string;
  workItemId: string;
  stepId: string;
  attemptId: string;
  provider: string;
  action: ExternalActionName;
  securityClass: "external-write";
  target: ExternalActionTarget;
  payload: unknown;
  bindingDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`;
  artifactDigests: `sha256:${string}`[];
  idempotencyKey?: string;
  sideEffects: string[];
  createdAt: string;
  expiresAt: string;
  actor: string;
}

export interface ExternalActionApprovalSummary {
  provider: string;
  action: ExternalActionName;
  target: ExternalActionTarget;
  digest: `sha256:${string}`;
  sideEffects: string[];
}

export interface ExternalActionRejection {
  requestId: string;
  requestDigest: `sha256:${string}`;
  actor: string;
  rejectedAt: string;
}

export function externalActionRejectionKey(requestId: string): string {
  return `external-rejection:${requestId}`;
}

export type ExternalReadBack =
  | { outcome: "verified"; targetStableId: string; contentDigest: `sha256:${string}`; checkedAt: string }
  | { outcome: "failed"; checkedAt: string; reason?: string }
  | { outcome: "unknown"; checkedAt: string; reason?: string };

export interface ExternalActionExecutor {
  execute(input: {
    root: string;
    request: ExternalActionRequest;
    grant: ExternalActionGrant;
    payload: unknown;
    markDispatched(): Promise<void>;
  }): Promise<{ targetStableId: string; contentDigest: `sha256:${string}`; verifiedAt: string }>;
  reconcile(input: { root: string; request: ExternalActionRequest; grant: ExternalActionGrant }): Promise<ExternalReadBack>;
}

function asExternalError(error: unknown): never {
  if (error instanceof ExternalAuthorizationError) throw error;
  if (error instanceof ExternalIdempotencyError) {
    throw new ExternalAuthorizationError(error.code, error.message.replace(/^WSSPEC_[A-Z_]+:\s*/u, ""));
  }
  if (error instanceof ControlPlaneError && error.code === "WSSPEC_IDEMPOTENCY_CONFLICT") {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT", "外部幂等键已绑定不同请求。");
  }
  throw error;
}

function currentAction(projection: RuntimeProjection, requestId: string): ExternalActionState {
  const action = projection.externalActions[requestId];
  if (action === undefined) throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_REQUEST_NOT_FOUND", "外部动作请求不存在。");
  return action;
}

function assertActiveAttempt(
  projection: RuntimeProjection,
  input: Pick<ExternalActionRequest, "stepId" | "attemptId">,
  at: Date,
): void {
  const claim = projection.claims[input.stepId];
  const context = projection.contexts[input.stepId] as { workPackage?: { stepId?: unknown; attemptId?: unknown; lease?: { token?: unknown } } } | undefined;
  if (claim?.attemptId !== input.attemptId || claim.stageId !== input.stepId
    || context?.workPackage?.stepId !== input.stepId || context.workPackage.attemptId !== input.attemptId
    || context.workPackage.lease?.token !== claim.claimToken || new Date(claim.expiresAt) <= at) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_ATTEMPT_MISMATCH", "外部动作未绑定当前未过期的活动 Attempt/Lease。");
  }
}

async function assertCurrentRequestContext(
  state: Awaited<ReturnType<typeof loadApplicationState>>,
  projection: RuntimeProjection,
  request: ExternalActionRequest,
): Promise<void> {
  const profile = state.snapshot.profiles[projection.profile.selected];
  const workspaceDigest = await computeWorkspaceTreeDigest(state.worktree);
  if (profile === undefined || request.profile !== profile.id
    || request.profileDigest !== canonicalDigest(profile, "WSSPEC_EXTERNAL_GRANT_MISMATCH")
    || request.workspaceDigest !== workspaceDigest
    || request.configDigest !== state.item.execution.configDigest) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_GRANT_MISMATCH", "外部动作授权上下文已变化，必须重新准备请求并审批。");
  }
}

export function externalActionApprovalSummary(request: ExternalActionRequest): ExternalActionApprovalSummary {
  return {
    provider: request.provider,
    action: request.action,
    target: { ...request.target },
    digest: request.payloadDigest,
    sideEffects: [...request.sideEffects],
  };
}

export async function prepareExternalAction(input: ExternalActionPrepareInput): Promise<ExternalActionState> {
  try {
    const state = await loadApplicationState(input.root, input.workItemId);
    const profile = selectedProfile(state.snapshot);
    const payloadArtifactDigest = await persistExternalActionPayload({
      controlPlane: state.projection.controlPlane,
      workItemId: input.workItemId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      provider: input.provider,
      action: input.action,
      target: input.target,
      payload: input.payload,
    });
    const request = validate<ExternalActionRequest>("builtin.external-action-request.v1", createExternalActionRequest({
      version: 1,
      workItemId: input.workItemId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      provider: input.provider,
      action: input.action,
      securityClass: input.securityClass,
      target: input.target,
      payload: input.payload,
      payloadArtifactDigest,
      bindingDigest: input.bindingDigest,
      inputDigest: input.inputDigest,
      artifactDigests: input.artifactDigests,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      profile: profile.id,
      profileDigest: canonicalDigest(profile, "WSSPEC_EXTERNAL_REQUEST_INVALID"),
      workspaceDigest: await computeWorkspaceTreeDigest(state.worktree) as `sha256:${string}`,
      configDigest: state.item.execution.configDigest as `sha256:${string}`,
      sideEffects: input.sideEffects,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    }));
    const derivedKey = externalIdempotencyKey(request);
    const before = await readControlPlane(input.root, input.workItemId);
    const existingRequestId = before.externalActionIdempotency[request.idempotencyKey];
    if (existingRequestId !== undefined) {
      const existing = currentAction(before, existingRequestId);
      if (existing.request.requestDigest !== request.requestDigest) {
        throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT", "外部幂等键已绑定不同请求。");
      }
      return existing;
    }
    return await mutateControlPlane({
      cwd: input.root,
      workItemId: input.workItemId,
      eventType: "external-action.prepared",
      idempotencyKey: `external-action:prepare:${request.idempotencyKey}:${request.requestDigest}`,
      actor: input.actor,
      stageId: input.stepId,
      attemptId: input.attemptId,
      operationInput: request,
      mutate: (projection) => {
        const existingRequestId = projection.externalActionIdempotency[request.idempotencyKey];
        if (existingRequestId !== undefined) {
          const existing = currentAction(projection, existingRequestId);
          if (existing.request.requestDigest !== request.requestDigest) {
            throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT", "外部幂等键已绑定不同请求。");
          }
          return { projection, value: existing };
        }
        const conflicting = Object.values(projection.externalActions).find((candidate) =>
          candidate.request.workItemId === request.workItemId
          && candidate.request.stepId === request.stepId
          && candidate.request.attemptId === request.attemptId
          && candidate.request.provider === request.provider
          && candidate.request.action === request.action
          && candidate.request.target.kind === request.target.kind
          && candidate.request.target.stableId === request.target.stableId);
        if (conflicting !== undefined) {
          throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_IDEMPOTENCY_CONFLICT", "同一 Attempt 的外部动作已绑定不同 payload。");
        }
        assertActiveAttempt(projection, request, new Date(input.createdAt));
        if (input.idempotencyKey !== undefined && input.idempotencyKey !== derivedKey) {
          throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_IDEMPOTENCY_INVALID", "外部幂等键不符合规范身份生成规则。");
        }
        const prepared = { status: "prepared" as const, request };
        return {
          projection: {
            ...projection,
            externalActions: { ...projection.externalActions, [request.requestId]: prepared },
            externalActionIdempotency: { ...projection.externalActionIdempotency, [request.idempotencyKey]: request.requestId },
          },
          value: prepared,
        };
      },
    });
  } catch (error) {
    return asExternalError(error);
  }
}

export async function approveExternalAction(input: {
  root: string;
  workItemId: string;
  requestId: string;
  expectedRequestDigest: string;
  actor: string;
  approvalDigest: `sha256:${string}`;
  profile: string;
  profileDigest: `sha256:${string}`;
  workspaceDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  decidedAt: string;
  expiresAt: string;
  terminal: { isTTY?: boolean };
}): Promise<Extract<ExternalActionState, { status: "approved" }>> {
  if (input.terminal.isTTY !== true) throw new ExternalAuthorizationError("WSSPEC_INTERACTIVE_TTY_REQUIRED", "外部动作授权必须来自真实交互式 TTY。");
  const applicationState = await loadApplicationState(input.root, input.workItemId);
  const current = currentAction(applicationState.projection, input.requestId);
  if (current.request.requestDigest !== input.expectedRequestDigest) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_REQUEST_DIGEST_MISMATCH", "外部动作审批摘要不匹配。");
  }
  if (current.status !== "prepared" && current.status !== "approved") {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "只有 prepared 外部动作可以授权。");
  }
  let grant: ExternalActionGrant;
  try {
    grant = validate<ExternalActionGrant>("builtin.external-action-grant.v1", createExternalActionGrant({
      request: current.request,
      actor: input.actor,
      approvalDigest: input.approvalDigest,
      profile: input.profile,
      profileDigest: input.profileDigest,
      workspaceDigest: input.workspaceDigest,
      configDigest: input.configDigest,
      decidedAt: input.decidedAt,
      expiresAt: input.expiresAt,
    }));
  } catch (error) {
    return asExternalError(error);
  }
  assertActiveAttempt(await readControlPlane(input.root, input.workItemId), current.request, new Date(input.decidedAt));
  return mutateControlPlane({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: "external-action.approved",
    idempotencyKey: `external-action:approve:${input.requestId}`,
    actor: input.actor,
    stageId: current.request.stepId,
    attemptId: current.request.attemptId,
    operationInput: grant,
    mutate: async (projection) => {
      const action = currentAction(projection, input.requestId);
      if (action.status !== "prepared") throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "只有 prepared 外部动作可以授权。");
      assertActiveAttempt(projection, action.request, new Date(input.decidedAt));
      await assertCurrentRequestContext(applicationState, projection, action.request);
      const approved = transitionExternalAction(action, { status: "approved", request: action.request, grant }) as Extract<ExternalActionState, { status: "approved" }>;
      return { projection: { ...projection, externalActions: { ...projection.externalActions, [input.requestId]: approved } }, value: approved };
    },
  });
}

export async function rejectExternalAction(input: {
  root: string;
  workItemId: string;
  requestId: string;
  expectedRequestDigest: string;
  actor: string;
  rejectedAt: string;
  terminal: { isTTY?: boolean };
}): Promise<ExternalActionRejection> {
  if (input.terminal.isTTY !== true) throw new ExternalAuthorizationError("WSSPEC_INTERACTIVE_TTY_REQUIRED", "外部动作拒绝决定必须来自真实交互式 TTY。");
  const initial = currentAction(await readControlPlane(input.root, input.workItemId), input.requestId);
  return mutateControlPlane({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: "external-action.rejected",
    idempotencyKey: `external-action:reject:${input.requestId}`,
    actor: input.actor,
    stageId: initial.request.stepId,
    attemptId: initial.request.attemptId,
    operationInput: {
      requestId: input.requestId,
      expectedRequestDigest: input.expectedRequestDigest,
      rejectedAt: input.rejectedAt,
    },
    mutate: (projection) => {
      const action = currentAction(projection, input.requestId);
      if (action.request.requestDigest !== input.expectedRequestDigest) {
        throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_REQUEST_DIGEST_MISMATCH", "外部动作拒绝摘要不匹配。");
      }
      if (action.status !== "prepared") {
        throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "只有 prepared 外部动作可以拒绝。");
      }
      assertActiveAttempt(projection, action.request, new Date(input.rejectedAt));
      const rejection: ExternalActionRejection = {
        requestId: action.request.requestId,
        requestDigest: action.request.requestDigest,
        actor: input.actor,
        rejectedAt: input.rejectedAt,
      };
      return {
        projection: {
          ...projection,
          evidence: { ...projection.evidence, [externalActionRejectionKey(input.requestId)]: rejection },
        },
        value: rejection,
      };
    },
  });
}

async function persistAction(input: {
  root: string;
  workItemId: string;
  requestId: string;
  eventType: "external-action.executing" | "external-action.dispatched" | "external-action.verified" | "external-action.reconciliation-required" | "external-action.reconciled";
  suffix: string;
  actor?: string;
  operationInput: unknown;
  update(current: ExternalActionState, projection: RuntimeProjection): ExternalActionState | Promise<ExternalActionState>;
}): Promise<ExternalActionState> {
  return mutateControlPlane({
    cwd: input.root,
    workItemId: input.workItemId,
    eventType: input.eventType,
    idempotencyKey: `external-action:${input.suffix}:${input.requestId}`,
    actor: input.actor ?? "external-coordinator",
    operationInput: input.operationInput,
    mutate: async (projection) => {
      const current = currentAction(projection, input.requestId);
      const next = await input.update(current, projection);
      return { projection: { ...projection, externalActions: { ...projection.externalActions, [input.requestId]: next } }, value: next };
    },
  });
}

function receipt(request: ExternalActionRequest, grant: ExternalActionGrant, input: {
  targetStableId: string;
  contentDigest: `sha256:${string}`;
  verifiedAt: string;
}): ExternalWriteReceipt {
  if (input.targetStableId !== request.target.stableId || input.contentDigest !== request.payloadDigest) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_READBACK_MISMATCH", "外部回读的稳定目标或内容摘要不一致。");
  }
  return validate<ExternalWriteReceipt>("builtin.external-write-receipt.v1", {
    version: 1,
    kind: "external-write-receipt",
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    grantDigest: grant.grantDigest,
    workItemId: request.workItemId,
    stepId: request.stepId,
    attemptId: request.attemptId,
    provider: request.provider,
    action: request.action,
    target: { ...request.target },
    payloadDigest: request.payloadDigest,
    bindingDigest: request.bindingDigest,
    inputDigest: request.inputDigest,
    artifactDigests: [...request.artifactDigests],
    idempotencyKey: request.idempotencyKey,
    readBackContentDigest: input.contentDigest,
    status: "verified",
    verifiedAt: input.verifiedAt,
  });
}

async function reconciliationRequired(input: { root: string; workItemId: string; requestId: string; now: string }): Promise<Extract<ExternalActionState, { status: "reconciliation_required" }>> {
  return persistAction({
    ...input,
    eventType: "external-action.reconciliation-required",
    suffix: "reconciliation-required",
    operationInput: { reason: "provider outcome unknown after dispatch", requiredAt: input.now },
    update: (current) => {
      if (current.status === "reconciliation_required") return current;
      if (current.status !== "executing" || current.dispatch !== "sent_or_unknown") {
        throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "只有可能已发送的 executing 动作需要协调恢复。");
      }
      return transitionExternalAction(current, {
        status: "reconciliation_required",
        request: current.request,
        grant: current.grant,
        reason: "provider outcome unknown after dispatch",
        requiredAt: input.now,
      });
    },
  }) as Promise<Extract<ExternalActionState, { status: "reconciliation_required" }>>;
}

export async function executeExternalAction(input: {
  root: string;
  workItemId: string;
  requestId: string;
  payload: unknown;
  executor: ExternalActionExecutor;
  now: string;
}): Promise<Extract<ExternalActionState, { status: "executing" | "verified" | "reconciliation_required" }>> {
  const applicationState = await loadApplicationState(input.root, input.workItemId);
  let current = currentAction(applicationState.projection, input.requestId);
  if (current.status === "verified") return current;
  assertActiveAttempt(await readControlPlane(input.root, input.workItemId), current.request, new Date(input.now));
  if (current.status === "reconciliation_required") throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED", "外部动作结果未知，禁止自动重发。");
  if (current.status === "failed" || current.status === "prepared") throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "外部动作尚未获得有效 Grant 或已失败。");
  if (canonicalDigest(input.payload) !== current.request.payloadDigest) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PAYLOAD_MISMATCH", "执行 payload 与批准摘要不一致。");
  }
  assertGrantAuthorizes(current.request, current.grant, new Date(input.now));
  const executionOwner = `external-execution-${crypto.randomUUID()}`;
  if (current.status === "approved" || (current.status === "executing" && current.dispatch === "not_sent")) {
    const claimed = await mutateControlPlane<{ action: ExternalActionState; owned: boolean }>({
      cwd: input.root,
      workItemId: input.workItemId,
      eventType: "external-action.executing",
      idempotencyKey: `external-action:execution-owner:${input.requestId}:${executionOwner}`,
      actor: "external-coordinator",
      stageId: current.request.stepId,
      attemptId: current.request.attemptId,
      operationInput: { executionOwner, startedAt: input.now },
      mutate: async (projection) => {
        const action = currentAction(projection, input.requestId);
        if (action.status === "executing" && action.dispatch === "not_sent" && action.executionOwner !== undefined) {
          return { projection, value: { action, owned: false as const } };
        }
        if (action.status !== "approved" && (action.status !== "executing" || action.dispatch !== "not_sent")) {
          return { projection, value: { action, owned: false as const } };
        }
        assertActiveAttempt(projection, action.request, new Date(input.now));
        await assertCurrentRequestContext(applicationState, projection, action.request);
        const executing = action.status === "approved"
          ? transitionExternalAction(action, {
            status: "executing", request: action.request, grant: action.grant, dispatch: "not_sent",
            startedAt: input.now, executionOwner,
          })
          : { ...action, startedAt: input.now, executionOwner };
        return {
          projection: { ...projection, externalActions: { ...projection.externalActions, [input.requestId]: executing } },
          value: { action: executing, owned: true as const },
        };
      },
    });
    current = claimed.action;
    if (!claimed.owned) return current as Extract<ExternalActionState, { status: "executing" }>;
  }
  if (current.status !== "executing" || current.dispatch !== "not_sent" || current.executionOwner !== executionOwner) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED", "外部动作可能已发送，禁止自动重发。");
  }
  const executionProjection = await readControlPlane(input.root, input.workItemId);
  assertActiveAttempt(executionProjection, current.request, new Date(input.now));
  await assertCurrentRequestContext(applicationState, executionProjection, current.request);
  let dispatched = false;
  const markDispatched = async (): Promise<void> => {
    const dispatchedState = await persistAction({
      ...input,
      eventType: "external-action.dispatched",
      suffix: "dispatched",
      operationInput: { dispatchedAt: input.now },
      update: (action) => {
        if (action.status !== "executing" || action.dispatch !== "not_sent" || action.executionOwner !== executionOwner) {
          throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "外部动作 dispatch 边界重复或无效。");
        }
        return transitionExternalAction(action, { ...action, dispatch: "sent_or_unknown", dispatchedAt: input.now });
      },
    });
    dispatched = dispatchedState.status === "executing" && dispatchedState.dispatch === "sent_or_unknown";
  };
  let readBack: Awaited<ReturnType<ExternalActionExecutor["execute"]>>;
  try {
    readBack = await input.executor.execute({ root: input.root, request: current.request, grant: current.grant, payload: input.payload, markDispatched });
  } catch (error) {
    const stored = currentAction(await readControlPlane(input.root, input.workItemId), input.requestId);
    if (dispatched || (stored.status === "executing" && stored.dispatch === "sent_or_unknown")) {
      return reconciliationRequired(input);
    }
    await persistAction({
      ...input,
      eventType: "external-action.executing",
      suffix: `execution-owner-released:${executionOwner}`,
      operationInput: { releasedAt: input.now },
      update: (action) => {
        if (action.status !== "executing" || action.dispatch !== "not_sent" || action.executionOwner !== executionOwner) return action;
        const { executionOwner: _released, ...released } = action;
        return released;
      },
    });
    throw new ExternalAuthorizationError(
      "WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED",
      "Provider 在 dispatch 前失败，未确认任何外部写入。",
    );
  }
  const stored = currentAction(await readControlPlane(input.root, input.workItemId), input.requestId);
  if (!dispatched || stored.status !== "executing" || stored.dispatch !== "sent_or_unknown") {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_DISPATCH_EVIDENCE_MISSING", "Provider 未记录 dispatch 边界，不能确认执行结果。");
  }
  let confirmed: ExternalWriteReceipt;
  try { confirmed = receipt(stored.request, stored.grant, readBack); }
  catch { return reconciliationRequired(input); }
  return persistAction({
    ...input,
    eventType: "external-action.verified",
    suffix: "verified",
    operationInput: confirmed,
    update: (action) => {
      if (action.status !== "executing" || action.dispatch !== "sent_or_unknown" || action.executionOwner !== executionOwner) throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "只有 dispatch owner 的 executing 动作可被验证。");
      return transitionExternalAction(action, { status: "verified", request: action.request, grant: action.grant, receipt: confirmed });
    },
  }) as Promise<Extract<ExternalActionState, { status: "verified" }>>;
}

export async function reconcileExternalAction(input: {
  root: string;
  workItemId: string;
  requestId: string;
  executor: ExternalActionExecutor;
  now: string;
}): Promise<Extract<ExternalActionState, { status: "verified" | "failed" | "reconciliation_required" }>> {
  const current = currentAction(await readControlPlane(input.root, input.workItemId), input.requestId);
  if (current.status === "verified" || current.status === "failed") return current;
  if (current.status !== "reconciliation_required") throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_RECONCILIATION_NOT_REQUIRED", "当前外部动作不允许协调回查。");
  let readBack: ExternalReadBack;
  try {
    readBack = await input.executor.reconcile({ root: input.root, request: current.request, grant: current.grant });
  } catch {
    throw new ExternalAuthorizationError(
      "WSSPEC_EXTERNAL_PROVIDER_RECONCILIATION_FAILED",
      "Provider 只读协调回查失败，未改变外部动作状态。",
    );
  }
  if (readBack.outcome === "unknown") {
    const safeReadBack = { outcome: "unknown" as const, checkedAt: input.now };
    return persistAction({
      ...input,
      eventType: "external-action.reconciled",
      suffix: `reconciled-unknown:${canonicalDigest(safeReadBack).slice("sha256:".length)}`,
      operationInput: safeReadBack,
      update: (action) => action.status !== "reconciliation_required" ? action : { ...action, lastCheckedAt: input.now },
    }) as Promise<Extract<ExternalActionState, { status: "reconciliation_required" }>>;
  }
  if (readBack.outcome === "failed") {
    const safeReadBack = { outcome: "failed" as const, checkedAt: input.now };
    return persistAction({
      ...input,
      eventType: "external-action.reconciled",
      suffix: `reconciled-failed:${canonicalDigest(safeReadBack).slice("sha256:".length)}`,
      operationInput: safeReadBack,
      update: (action) => {
        if (action.status !== "reconciliation_required") throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "协调失败结果需要 reconciliation_required 状态。");
        return transitionExternalAction(action, {
          status: "failed",
          request: action.request,
          grant: action.grant,
          reason: "provider read-back did not verify approved content",
          failedAt: input.now,
        });
      },
    }) as Promise<Extract<ExternalActionState, { status: "failed" }>>;
  }
  let confirmed: ExternalWriteReceipt;
  try { confirmed = receipt(current.request, current.grant, { targetStableId: readBack.targetStableId, contentDigest: readBack.contentDigest, verifiedAt: input.now }); }
  catch {
    return persistAction({
      ...input,
      eventType: "external-action.reconciled",
      suffix: `reconciled-mismatch:${canonicalDigest({ outcome: "unknown", checkedAt: input.now }).slice("sha256:".length)}`,
      operationInput: { outcome: "unknown", checkedAt: input.now },
      update: (action) => action.status !== "reconciliation_required" ? action : { ...action, lastCheckedAt: input.now },
    }) as Promise<Extract<ExternalActionState, { status: "reconciliation_required" }>>;
  }
  return persistAction({
    ...input,
    eventType: "external-action.reconciled",
    suffix: `reconciled-verified:${canonicalDigest(confirmed).slice("sha256:".length)}`,
    operationInput: confirmed,
    update: (action) => {
      if (action.status !== "reconciliation_required") throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", "协调确认需要 reconciliation_required 状态。");
      return transitionExternalAction(action, { status: "verified", request: action.request, grant: action.grant, receipt: confirmed });
    },
  }) as Promise<Extract<ExternalActionState, { status: "verified" }>>;
}
