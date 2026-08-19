import * as canonicalizeModule from "canonicalize";

import { sha256 } from "./digests.js";
import type { ArtifactReference, WorkPackage } from "../protocol/work-package.js";
import { validate } from "../schemas/index.js";

export type ExternalTarget = "issue" | "knowledge";

export interface ExternalBinding {
  version: 1;
  kind: "external-binding";
  target: ExternalTarget;
  exists: true;
  stableId: string;
  externalWorkItemId: string;
  publishStepId: string;
  publishAttemptId: string;
  publishInputDigest: string;
  expectedPublishedContentDigest: string;
}

export interface ExternalReceipt {
  version: 1;
  kind: "external-receipt";
  target: ExternalTarget;
  stableId: string;
  externalWorkItemId: string;
  publishStepId: string;
  publishAttemptId: string;
  publishInputDigest: string;
  publishedContentDigest: string;
  readBackContentDigest: string;
  status: "confirmed";
  readBackStatus: "confirmed" | "stale" | "failed";
}

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseExternalReceipt(value: unknown): ExternalReceipt | undefined {
  try { return validate<ExternalReceipt>("builtin.external-receipt.v1", value); }
  catch { return undefined; }
}

export function parseExternalBinding(value: unknown): ExternalBinding | undefined {
  try { return validate<ExternalBinding>("builtin.external-binding.v1", value); }
  catch { return undefined; }
}

function normalizedArtifacts(artifacts: readonly ArtifactReference[]): ArtifactReference[] {
  if (artifacts.length === 0 || artifacts.some((artifact) => typeof artifact.contentHash !== "string" || artifact.contentHash === "")) {
    throw new Error("External publish input 必须包含至少一个具有内容摘要的 Artifact。");
  }
  return artifacts.map((artifact) => ({
    artifactType: artifact.artifactType,
    schemaVersion: artifact.schemaVersion,
    ...(artifact.path === undefined ? {} : { path: artifact.path.replaceAll("\\", "/") }),
    ...(artifact.revision === undefined ? {} : { revision: artifact.revision }),
    ...(artifact.contentHash === undefined ? {} : { contentHash: artifact.contentHash }),
    ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
    ...(artifact.contentLevel === undefined ? {} : { contentLevel: artifact.contentLevel }),
  })).sort((left, right) => Buffer.from(JSON.stringify(left)).compare(Buffer.from(JSON.stringify(right))));
}

export function externalPublishTarget(action: string | undefined): ExternalTarget | undefined {
  if (action === "issue.update") return "issue";
  if (action === "knowledge.publish") return "knowledge";
  return undefined;
}

export function createExternalBinding(input: {
  target: ExternalTarget;
  workPackage: WorkPackage;
  discoveryBinding: unknown;
}): ExternalBinding {
  const discovery = record(input.discoveryBinding);
  if (discovery?.exists !== true || typeof discovery.stableId !== "string" || discovery.stableId === ""
    || typeof discovery.externalWorkItemId !== "string" || discovery.externalWorkItemId !== input.workPackage.workItemId) {
    throw new Error(`External ${input.target} discovery binding 缺少当前 Work Item 的稳定身份。`);
  }
  const artifacts = normalizedArtifacts(input.workPackage.artifacts);
  const content = canonicalize({ version: 1, target: input.target, artifacts });
  const publishInput = canonicalize({
    version: 1,
    target: input.target,
    workItemId: input.workPackage.workItemId,
    stepId: input.workPackage.stepId,
    attemptId: input.workPackage.attemptId,
    artifacts,
  });
  if (content === undefined || publishInput === undefined) throw new Error(`External ${input.target} publish input 无法规范化。`);
  return {
    version: 1,
    kind: "external-binding",
    target: input.target,
    exists: true,
    stableId: discovery.stableId,
    externalWorkItemId: discovery.externalWorkItemId,
    publishStepId: input.workPackage.stepId,
    publishAttemptId: input.workPackage.attemptId,
    publishInputDigest: sha256(publishInput),
    expectedPublishedContentDigest: sha256(content),
  };
}

export function externalReceiptValues(evidence: Readonly<Record<string, unknown>>): unknown[] {
  return Object.entries(evidence).filter(([key, value]) => key.startsWith("external-receipt:") || record(value)?.kind === "external-receipt")
    .map(([, value]) => value);
}

export function externalBindingValues(evidence: Readonly<Record<string, unknown>>): unknown[] {
  return Object.entries(evidence).filter(([key, value]) => key.startsWith("external-binding:") || record(value)?.kind === "external-binding")
    .map(([, value]) => value);
}

export function assertExternalReceipts(evidence: Readonly<Record<string, unknown>>, code: `WSSPEC_${string}`): void {
  const invalidBinding = Object.entries(evidence)
    .filter(([key, value]) => key.startsWith("external-binding:") || record(value)?.kind === "external-binding")
    .some(([key, value]) => {
      const binding = parseExternalBinding(value);
      return binding === undefined
        || key !== `external-binding:${binding.target}`;
    });
  const invalidReceipt = Object.entries(evidence)
    .filter(([key, value]) => key.startsWith("external-receipt:") || record(value)?.kind === "external-receipt")
    .some(([key, value]) => {
      const receipt = parseExternalReceipt(value);
      if (receipt === undefined) return true;
      return key !== `external-receipt:${receipt.target}`
        || !externalReceiptMatches({
          receipt,
          target: receipt.target,
          binding: evidence[`external-binding:${receipt.target}`],
          readBackRequired: true,
        });
    });
  if (invalidBinding || invalidReceipt) {
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
  const binding = parseExternalBinding(input.binding);
  return receipt !== undefined
    && binding !== undefined
    && receipt.target === input.target
    && binding.target === input.target
    && receipt.stableId === binding.stableId
    && receipt.externalWorkItemId === binding.externalWorkItemId
    && receipt.publishStepId === binding.publishStepId
    && receipt.publishAttemptId === binding.publishAttemptId
    && receipt.publishInputDigest === binding.publishInputDigest
    && receipt.publishedContentDigest === binding.expectedPublishedContentDigest
    && receipt.readBackContentDigest === binding.expectedPublishedContentDigest
    && receipt.status === "confirmed"
    && (!input.readBackRequired || (receipt.readBackStatus === "confirmed"
      && receipt.readBackContentDigest === receipt.publishedContentDigest));
}
