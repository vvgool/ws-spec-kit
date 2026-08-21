import { canonicalDigest, externalIdempotencyKey } from "./idempotency.js";
import { validate } from "../../schemas/index.js";
import { inspectDecodedCredentialSurface } from "../../registry/connectors/secret-detector.js";

export type ExternalActionName = "git.commit" | "issue.update" | "knowledge.publish" | "issue.close";
export type ExternalTargetKind = "repository" | "issue" | "knowledge";
export type ExternalEffectKind = "issue.comment";
export type GovernedActionSecurityClass = "local-write" | "external-write";

export interface ExternalActionTarget {
  kind: ExternalTargetKind;
  stableId: string;
}

export interface ExternalActionRequest {
  version: 1;
  requestId: string;
  workItemId: string;
  stepId: string;
  attemptId: string;
  provider: string;
  action: ExternalActionName;
  securityClass: GovernedActionSecurityClass;
  target: ExternalActionTarget;
  externalEffectKind?: ExternalEffectKind;
  payloadDigest: `sha256:${string}`;
  expectedContentDigest: `sha256:${string}`;
  payloadArtifactDigest: `sha256:${string}`;
  bindingDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`;
  artifactDigests: `sha256:${string}`[];
  idempotencyKey: string;
  profile: string;
  profileDigest: `sha256:${string}`;
  workspaceDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  sideEffects: string[];
  createdAt: string;
  expiresAt: string;
  requestDigest: `sha256:${string}`;
}

export interface ExternalActionGrant {
  version: 1;
  grantId: string;
  requestId: string;
  requestDigest: `sha256:${string}`;
  workItemId: string;
  stepId: string;
  attemptId: string;
  provider: string;
  action: ExternalActionName;
  securityClass: GovernedActionSecurityClass;
  target: ExternalActionTarget;
  externalEffectKind?: ExternalEffectKind;
  payloadDigest: `sha256:${string}`;
  expectedContentDigest: `sha256:${string}`;
  payloadArtifactDigest: `sha256:${string}`;
  bindingDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`;
  artifactDigests: `sha256:${string}`[];
  idempotencyKey: string;
  actor: string;
  approvalDigest: `sha256:${string}`;
  profile: string;
  profileDigest: `sha256:${string}`;
  workspaceDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  decidedAt: string;
  expiresAt: string;
  grantDigest: `sha256:${string}`;
}

export interface ExternalWriteReceipt {
  version: 1;
  kind: "external-write-receipt";
  requestId: string;
  requestDigest: `sha256:${string}`;
  grantDigest: `sha256:${string}`;
  workItemId: string;
  stepId: string;
  attemptId: string;
  provider: string;
  action: ExternalActionName;
  target: ExternalActionTarget;
  externalEffectKind?: ExternalEffectKind;
  externalEffectId?: string;
  payloadDigest: `sha256:${string}`;
  expectedContentDigest: `sha256:${string}`;
  bindingDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`;
  artifactDigests: `sha256:${string}`[];
  idempotencyKey: string;
  publishedContentDigest: `sha256:${string}`;
  readBackContentDigest: `sha256:${string}`;
  status: "verified";
  verifiedAt: string;
}

export type ExternalActionState =
  | { status: "prepared"; request: ExternalActionRequest }
  | { status: "approved"; request: ExternalActionRequest; grant: ExternalActionGrant }
  | { status: "executing"; request: ExternalActionRequest; grant: ExternalActionGrant; dispatch: "not_sent" | "sent_or_unknown"; startedAt: string; executionOwner?: string; dispatchedAt?: string }
  | { status: "reconciliation_required"; request: ExternalActionRequest; grant: ExternalActionGrant; reason: string; requiredAt: string; lastCheckedAt?: string }
  | { status: "verified"; request: ExternalActionRequest; grant: ExternalActionGrant; receipt: ExternalWriteReceipt }
  | { status: "failed"; request: ExternalActionRequest; grant: ExternalActionGrant; reason: string; failedAt: string };

export class ExternalAuthorizationError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExternalAuthorizationError";
  }
}

function timestamp(value: string, code: `WSSPEC_${string}`): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ExternalAuthorizationError(code, "外部动作时间无效。");
  return parsed;
}

function nonEmpty(value: string, code: `WSSPEC_${string}`): string {
  if (value === "" || value.includes("\0")) throw new ExternalAuthorizationError(code, "外部动作身份字段无效。");
  return value;
}

function assertCredentialFreeMetadata(values: readonly string[]): void {
  for (const value of values) {
    const inspected = inspectDecodedCredentialSurface(value);
    if (!inspected.ok && (inspected.reason === "credential" || inspected.reason === "decode-limit")) {
      throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_REQUEST_INVALID", "外部动作审批元数据不能包含凭据样式内容。");
    }
  }
}

export function createExternalActionRequest(input: Omit<ExternalActionRequest, "requestId" | "payloadDigest" | "idempotencyKey" | "requestDigest"> & {
  payload: unknown;
  idempotencyKey?: string;
}): ExternalActionRequest {
  nonEmpty(input.workItemId, "WSSPEC_EXTERNAL_REQUEST_INVALID");
  nonEmpty(input.stepId, "WSSPEC_EXTERNAL_REQUEST_INVALID");
  nonEmpty(input.attemptId, "WSSPEC_EXTERNAL_REQUEST_INVALID");
  nonEmpty(input.provider, "WSSPEC_EXTERNAL_REQUEST_INVALID");
  nonEmpty(input.target.stableId, "WSSPEC_EXTERNAL_REQUEST_INVALID");
  assertCredentialFreeMetadata([input.provider, input.target.stableId, ...input.sideEffects]);
  const localGit = input.action === "git.commit" && input.securityClass === "local-write" && input.target.kind === "repository";
  const external = input.action !== "git.commit" && input.securityClass === "external-write"
    && (input.action === "knowledge.publish") === (input.target.kind === "knowledge")
    && input.target.kind !== "repository";
  if (!localGit && !external) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_TARGET_INVALID", "外部动作与稳定目标类型不一致。");
  }
  if (input.externalEffectKind !== undefined
    && (input.externalEffectKind !== "issue.comment" || input.action !== "issue.update" || input.target.kind !== "issue")) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_TARGET_INVALID", "外部 effect 类型与动作或稳定目标不一致。");
  }
  if (timestamp(input.expiresAt, "WSSPEC_EXTERNAL_REQUEST_INVALID") <= timestamp(input.createdAt, "WSSPEC_EXTERNAL_REQUEST_INVALID")) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_REQUEST_INVALID", "外部动作请求有效期无效。");
  }
  const payloadDigest = canonicalDigest(input.payload);
  const derivedKey = externalIdempotencyKey({ ...input, payloadDigest });
  const idempotencyKey = input.idempotencyKey ?? derivedKey;
  const requestId = `external-request-${canonicalDigest({ idempotencyKey }, "WSSPEC_EXTERNAL_REQUEST_INVALID").slice("sha256:".length)}`;
  const unsigned = {
    version: 1 as const,
    requestId,
    workItemId: input.workItemId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    provider: input.provider,
    action: input.action,
    securityClass: input.securityClass,
    target: { ...input.target },
    ...(input.externalEffectKind === undefined ? {} : { externalEffectKind: input.externalEffectKind }),
    payloadDigest,
    expectedContentDigest: input.expectedContentDigest,
    payloadArtifactDigest: input.payloadArtifactDigest,
    bindingDigest: input.bindingDigest,
    inputDigest: input.inputDigest,
    artifactDigests: [...input.artifactDigests].sort(),
    idempotencyKey,
    profile: input.profile,
    profileDigest: input.profileDigest,
    workspaceDigest: input.workspaceDigest,
    configDigest: input.configDigest,
    sideEffects: [...input.sideEffects],
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  return { ...unsigned, requestDigest: canonicalDigest(unsigned, "WSSPEC_EXTERNAL_REQUEST_INVALID") };
}

export function createExternalActionGrant(input: {
  request: ExternalActionRequest;
  actor: string;
  approvalDigest: `sha256:${string}`;
  profile: string;
  profileDigest: `sha256:${string}`;
  workspaceDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  decidedAt: string;
  expiresAt: string;
}): ExternalActionGrant {
  const request = input.request;
  if (timestamp(input.decidedAt, "WSSPEC_EXTERNAL_GRANT_INVALID") >= timestamp(request.expiresAt, "WSSPEC_EXTERNAL_REQUEST_EXPIRED")) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_REQUEST_EXPIRED", "外部动作请求已过期。");
  }
  if (timestamp(input.expiresAt, "WSSPEC_EXTERNAL_GRANT_INVALID") <= timestamp(input.decidedAt, "WSSPEC_EXTERNAL_GRANT_INVALID")
    || timestamp(input.expiresAt, "WSSPEC_EXTERNAL_GRANT_INVALID") > timestamp(request.expiresAt, "WSSPEC_EXTERNAL_GRANT_INVALID")) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_GRANT_INVALID", "外部动作 Grant 有效期无效。");
  }
  if (input.approvalDigest !== request.requestDigest || input.profile !== request.profile || input.profileDigest !== request.profileDigest
    || input.workspaceDigest !== request.workspaceDigest || input.configDigest !== request.configDigest) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_GRANT_MISMATCH", "Grant 上下文与外部动作请求不一致。");
  }
  const unsigned = {
    version: 1 as const,
    grantId: `external-grant-${request.requestDigest.slice("sha256:".length)}`,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    workItemId: request.workItemId,
    stepId: request.stepId,
    attemptId: request.attemptId,
    provider: request.provider,
    action: request.action,
    securityClass: request.securityClass,
    target: { ...request.target },
    ...(request.externalEffectKind === undefined ? {} : { externalEffectKind: request.externalEffectKind }),
    payloadDigest: request.payloadDigest,
    expectedContentDigest: request.expectedContentDigest,
    payloadArtifactDigest: request.payloadArtifactDigest,
    bindingDigest: request.bindingDigest,
    inputDigest: request.inputDigest,
    artifactDigests: [...request.artifactDigests],
    idempotencyKey: request.idempotencyKey,
    actor: nonEmpty(input.actor, "WSSPEC_EXTERNAL_GRANT_INVALID"),
    approvalDigest: input.approvalDigest,
    profile: input.profile,
    profileDigest: input.profileDigest,
    workspaceDigest: input.workspaceDigest,
    configDigest: input.configDigest,
    decidedAt: input.decidedAt,
    expiresAt: input.expiresAt,
  };
  return { ...unsigned, grantDigest: canonicalDigest(unsigned, "WSSPEC_EXTERNAL_GRANT_INVALID") };
}

export function assertGrantAuthorizes(request: ExternalActionRequest, grant: ExternalActionGrant, now: Date): void {
  const { grantDigest, ...unsigned } = grant;
  const exact = grant.requestId === request.requestId && grant.requestDigest === request.requestDigest
    && grant.workItemId === request.workItemId && grant.stepId === request.stepId && grant.attemptId === request.attemptId
    && grant.provider === request.provider && grant.action === request.action && grant.securityClass === request.securityClass
    && grant.target.kind === request.target.kind && grant.target.stableId === request.target.stableId
    && grant.externalEffectKind === request.externalEffectKind
    && grant.payloadDigest === request.payloadDigest && grant.payloadArtifactDigest === request.payloadArtifactDigest
    && grant.expectedContentDigest === request.expectedContentDigest
    && grant.bindingDigest === request.bindingDigest && grant.inputDigest === request.inputDigest
    && JSON.stringify(grant.artifactDigests) === JSON.stringify(request.artifactDigests)
    && grant.idempotencyKey === request.idempotencyKey && grant.approvalDigest === request.requestDigest
    && grant.profile === request.profile && grant.profileDigest === request.profileDigest
    && grant.workspaceDigest === request.workspaceDigest && grant.configDigest === request.configDigest
    && grantDigest === canonicalDigest(unsigned, "WSSPEC_EXTERNAL_GRANT_INVALID");
  if (!exact) throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_GRANT_MISMATCH", "Grant 不能授权当前外部动作请求。");
  if (now.getTime() >= timestamp(grant.expiresAt, "WSSPEC_EXTERNAL_GRANT_INVALID")) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_GRANT_EXPIRED", "外部动作 Grant 已过期。");
  }
}

export function transitionExternalAction(current: ExternalActionState, next: ExternalActionState): ExternalActionState {
  const allowed = (current.status === "prepared" && (next.status === "approved" || next.status === "reconciliation_required"))
    || (current.status === "approved" && (next.status === "executing" || next.status === "reconciliation_required"))
    || (current.status === "executing" && (next.status === "executing" || next.status === "verified" || next.status === "reconciliation_required"))
    || (current.status === "reconciliation_required" && (next.status === "reconciliation_required" || next.status === "verified" || next.status === "failed"));
  if (!allowed || current.request.requestId !== next.request.requestId || current.request.requestDigest !== next.request.requestDigest) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_STATE_TRANSITION_INVALID", `禁止外部动作状态跃迁 ${current.status} -> ${next.status}。`);
  }
  return next;
}

export function assertExternalActionProjection(
  actions: Readonly<Record<string, ExternalActionState>>,
  idempotency: Readonly<Record<string, string>>,
): void {
  const expectedIdempotency: Record<string, string> = {};
  for (const [requestId, state] of Object.entries(actions)) {
    const request = validate<ExternalActionRequest>("builtin.external-action-request.v1", state.request);
    const { requestDigest, ...unsignedRequest } = request;
    const expectedRequestId = `external-request-${canonicalDigest({ idempotencyKey: request.idempotencyKey }).slice("sha256:".length)}`;
    if (requestId !== request.requestId || request.requestId !== expectedRequestId
      || request.requestDigest !== canonicalDigest(unsignedRequest, "WSSPEC_EXTERNAL_REQUEST_INVALID")
      || request.idempotencyKey !== externalIdempotencyKey(request)) {
      throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PROJECTION_INVALID", "外部动作请求投影身份或摘要无效。");
    }
    if (expectedIdempotency[request.idempotencyKey] !== undefined) {
      throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PROJECTION_INVALID", "外部动作投影包含重复幂等身份。");
    }
    expectedIdempotency[request.idempotencyKey] = request.requestId;
    if (state.status === "prepared") continue;
    const grant = validate<ExternalActionGrant>("builtin.external-action-grant.v1", state.grant);
    assertGrantAuthorizes(request, grant, new Date(grant.decidedAt));
    if (state.status === "approved") continue;
    if (state.status === "executing") {
      if (state.executionOwner !== undefined && state.executionOwner === "") {
        throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PROJECTION_INVALID", "外部动作执行 owner 无效。");
      }
      if (state.dispatch === "sent_or_unknown" && state.dispatchedAt === undefined) {
        throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PROJECTION_INVALID", "外部动作 dispatch 投影缺少时间证据。");
      }
      continue;
    }
    if (state.status === "reconciliation_required") {
      if (state.reason === "" || !Number.isFinite(Date.parse(state.requiredAt))) {
        throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PROJECTION_INVALID", "协调恢复投影无效。");
      }
      continue;
    }
    if (state.status === "failed") {
      if (state.reason === "" || !Number.isFinite(Date.parse(state.failedAt))) {
        throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PROJECTION_INVALID", "外部动作失败投影无效。");
      }
      continue;
    }
    const receipt = validate<ExternalWriteReceipt>("builtin.external-write-receipt.v1", state.receipt);
    if (receipt.requestId !== request.requestId || receipt.requestDigest !== request.requestDigest
      || receipt.grantDigest !== grant.grantDigest || receipt.workItemId !== request.workItemId
      || receipt.stepId !== request.stepId || receipt.attemptId !== request.attemptId
      || receipt.provider !== request.provider || receipt.action !== request.action
      || receipt.target.kind !== request.target.kind || receipt.target.stableId !== request.target.stableId
      || receipt.externalEffectKind !== request.externalEffectKind
      || (request.externalEffectKind === "issue.comment") !== (receipt.externalEffectId !== undefined)
      || receipt.payloadDigest !== request.payloadDigest || receipt.expectedContentDigest !== request.expectedContentDigest
      || receipt.bindingDigest !== request.bindingDigest
      || receipt.inputDigest !== request.inputDigest || JSON.stringify(receipt.artifactDigests) !== JSON.stringify(request.artifactDigests)
      || receipt.idempotencyKey !== request.idempotencyKey
      || receipt.publishedContentDigest !== request.expectedContentDigest
      || receipt.readBackContentDigest !== request.expectedContentDigest) {
      throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PROJECTION_INVALID", "外部写入 Receipt 未绑定当前请求和 Grant。");
    }
  }
  if (JSON.stringify(Object.entries(idempotency).sort()) !== JSON.stringify(Object.entries(expectedIdempotency).sort())) {
    throw new ExternalAuthorizationError("WSSPEC_EXTERNAL_PROJECTION_INVALID", "外部动作幂等索引与请求投影不一致。");
  }
}
