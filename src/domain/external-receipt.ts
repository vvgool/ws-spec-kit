import { validate } from "../schemas/index.js";

export type ExternalTarget = "issue" | "knowledge";

export interface ExternalReceipt {
  version: 1;
  kind: "external-receipt";
  target: ExternalTarget;
  stableId: string;
  externalWorkItemId: string;
  publishedContentDigest: string;
  readBackContentDigest: string;
  status: "confirmed";
  readBackStatus: "confirmed" | "stale" | "failed";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseExternalReceipt(value: unknown): ExternalReceipt | undefined {
  try { return validate<ExternalReceipt>("builtin.external-receipt.v1", value); }
  catch { return undefined; }
}

export function externalReceiptValues(evidence: Readonly<Record<string, unknown>>): unknown[] {
  return Object.entries(evidence).filter(([key, value]) => key.startsWith("external-receipt:") || record(value)?.kind === "external-receipt")
    .map(([, value]) => value);
}

export function assertExternalReceipts(evidence: Readonly<Record<string, unknown>>, code: `WSSPEC_${string}`): void {
  if (externalReceiptValues(evidence).some((value) => parseExternalReceipt(value) === undefined)) {
    const error = new Error("External receipt 不符合严格身份与内容摘要契约。") as Error & { code: string };
    error.code = code;
    throw error;
  }
}

export function externalReceiptMatches(input: {
  receipt: unknown;
  target: ExternalTarget;
  binding: unknown;
  readBackRequired: boolean;
}): boolean {
  const receipt = parseExternalReceipt(input.receipt);
  const binding = record(input.binding);
  return receipt !== undefined
    && binding?.exists === true
    && typeof binding.stableId === "string"
    && typeof binding.externalWorkItemId === "string"
    && receipt.target === input.target
    && receipt.stableId === binding.stableId
    && receipt.externalWorkItemId === binding.externalWorkItemId
    && receipt.status === "confirmed"
    && (!input.readBackRequired || (receipt.readBackStatus === "confirmed"
      && receipt.readBackContentDigest === receipt.publishedContentDigest));
}
