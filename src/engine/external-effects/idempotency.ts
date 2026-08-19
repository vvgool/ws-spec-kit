import * as canonicalizeModule from "canonicalize";

import { sha256 } from "../../domain/digests.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

export class ExternalIdempotencyError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExternalIdempotencyError";
  }
}

export function canonicalDigest(value: unknown, code: `WSSPEC_${string}` = "WSSPEC_EXTERNAL_PAYLOAD_INVALID"): `sha256:${string}` {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new ExternalIdempotencyError(code, "外部动作输入无法规范化。");
  return sha256(encoded) as `sha256:${string}`;
}

export interface ExternalIdempotencyIdentity {
  workItemId: string;
  stepId: string;
  provider: string;
  action: string;
  target: { stableId: string };
  payloadDigest: string;
}

export function externalIdempotencyKey(input: ExternalIdempotencyIdentity): string {
  return `external:${canonicalDigest({
    workItemId: input.workItemId,
    stepId: input.stepId,
    provider: input.provider,
    action: input.action,
    targetStableId: input.target.stableId,
    payloadDigest: input.payloadDigest,
  }, "WSSPEC_EXTERNAL_IDEMPOTENCY_INVALID").slice("sha256:".length)}`;
}
