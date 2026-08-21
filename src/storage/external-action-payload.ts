import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import type { ExternalActionName, ExternalActionRequest, ExternalActionTarget } from "../engine/external-effects/authorization.js";
import { canonicalDigest } from "../engine/external-effects/idempotency.js";
import { inspectDecodedCredentialSurface } from "../registry/connectors/secret-detector.js";

const maximumPayloadArtifactBytes = 1024 * 1024;

interface ExternalActionPayloadEnvelope {
  version: 1;
  kind: "external-action-payload";
  workItemId: string;
  stepId: string;
  attemptId: string;
  provider: string;
  action: ExternalActionName;
  target: ExternalActionTarget;
  payloadDigest: `sha256:${string}`;
  payload: unknown;
}

export interface PreparedExternalActionPayload {
  digest: `sha256:${string}`;
  content: string;
}

export class ExternalActionPayloadError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExternalActionPayloadError";
  }
}

function invalid(code: `WSSPEC_${string}` = "WSSPEC_EXTERNAL_PAYLOAD_ARTIFACT_INVALID"): never {
  throw new ExternalActionPayloadError(code, "外部动作 payload 工件无效或与授权身份不匹配。");
}

function artifactFilename(directory: string, digest: `sha256:${string}`): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) return invalid();
  return path.join(directory, `${digest.slice("sha256:".length)}.json`);
}

async function secureArtifactDirectory(controlPlane: string): Promise<string> {
  const canonicalControlPlane = await realpath(controlPlane);
  const secureChildDirectory = async (parent: string, name: string): Promise<string> => {
    const directory = path.join(parent, name);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return invalid();
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return invalid();
    const canonical = await realpath(directory);
    if (canonical !== directory || path.dirname(canonical) !== parent) return invalid();
    return canonical;
  };
  const externalActions = await secureChildDirectory(canonicalControlPlane, "external-actions");
  const payloads = await secureChildDirectory(externalActions, "payloads");
  if (!payloads.startsWith(`${canonicalControlPlane}${path.sep}`)) {
    return invalid();
  }
  return payloads;
}

function envelope(input: {
  workItemId: string;
  stepId: string;
  attemptId: string;
  provider: string;
  action: ExternalActionName;
  target: ExternalActionTarget;
  payload: unknown;
}): ExternalActionPayloadEnvelope {
  const serialized = JSON.stringify(input.payload);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maximumPayloadArtifactBytes
    || !inspectDecodedCredentialSurface(serialized, {
      maximumBytes: maximumPayloadArtifactBytes,
      maximumDecodeRounds: 4,
    }).ok) {
    return invalid("WSSPEC_EXTERNAL_PAYLOAD_INVALID");
  }
  return {
    version: 1,
    kind: "external-action-payload",
    workItemId: input.workItemId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    provider: input.provider,
    action: input.action,
    target: { ...input.target },
    payloadDigest: canonicalDigest(input.payload),
    payload: input.payload,
  };
}

function parseEnvelope(value: unknown): ExternalActionPayloadEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const source = value as Record<string, unknown>;
  const keys = ["action", "attemptId", "kind", "payload", "payloadDigest", "provider", "stepId", "target", "version", "workItemId"];
  if (Object.keys(source).sort().join("\0") !== keys.sort().join("\0")
    || source.version !== 1 || source.kind !== "external-action-payload"
    || typeof source.workItemId !== "string" || typeof source.stepId !== "string"
    || typeof source.attemptId !== "string" || typeof source.provider !== "string"
    || !["git.commit", "issue.update", "knowledge.publish", "issue.close"].includes(source.action as string)
    || source.target === null || typeof source.target !== "object" || Array.isArray(source.target)
    || typeof source.payloadDigest !== "string") return invalid();
  const target = source.target as Record<string, unknown>;
  if (Object.keys(target).sort().join("\0") !== "kind\0stableId"
    || !["repository", "issue", "knowledge"].includes(target.kind as string) || typeof target.stableId !== "string") return invalid();
  const result = source as unknown as ExternalActionPayloadEnvelope;
  if (canonicalDigest(result.payload) !== result.payloadDigest) return invalid();
  return result;
}

async function readArtifact(filename: string, expectedDigest: `sha256:${string}`): Promise<ExternalActionPayloadEnvelope> {
  let before;
  try { before = await lstat(filename, { bigint: true }); }
  catch { return invalid(); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n || before.size < 1n
    || before.size > BigInt(maximumPayloadArtifactBytes)) return invalid();
  const canonical = await realpath(filename);
  if (canonical !== filename) return invalid();
  const content = await readFile(filename, "utf8");
  const after = await lstat(filename, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) return invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { return invalid(); }
  const result = parseEnvelope(parsed);
  if (canonicalDigest(result) !== expectedDigest) return invalid();
  return result;
}

export function prepareExternalActionPayload(input: {
  workItemId: string;
  stepId: string;
  attemptId: string;
  provider: string;
  action: ExternalActionName;
  target: ExternalActionTarget;
  payload: unknown;
}): PreparedExternalActionPayload {
  const value = envelope(input);
  const digest = canonicalDigest(value);
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content, "utf8") > maximumPayloadArtifactBytes) {
    return invalid("WSSPEC_EXTERNAL_PAYLOAD_INVALID");
  }
  return { digest, content };
}

export async function persistExternalActionPayload(input: {
  controlPlane: string;
  artifact: PreparedExternalActionPayload;
}): Promise<{ digest: `sha256:${string}`; created: boolean }> {
  let parsed: unknown;
  try { parsed = JSON.parse(input.artifact.content); }
  catch { return invalid(); }
  const value = parseEnvelope(parsed);
  if (canonicalDigest(value) !== input.artifact.digest) return invalid();
  const directory = await secureArtifactDirectory(input.controlPlane);
  const filename = artifactFilename(directory, input.artifact.digest);
  let handle;
  let created = false;
  try {
    handle = await open(filename, "wx", 0o600);
    created = true;
    await handle.writeFile(input.artifact.content, "utf8");
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (created) await unlink(filename).catch(() => undefined);
      if (error instanceof ExternalActionPayloadError) throw error;
      return invalid();
    }
  } finally {
    await handle?.close();
  }
  await readArtifact(filename, input.artifact.digest);
  return { digest: input.artifact.digest, created };
}

export async function removeExternalActionPayload(input: {
  controlPlane: string;
  digest: `sha256:${string}`;
}): Promise<void> {
  const directory = await secureArtifactDirectory(input.controlPlane);
  const filename = artifactFilename(directory, input.digest);
  try {
    await unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function loadExternalActionPayload(input: {
  controlPlane: string;
  request: ExternalActionRequest;
}): Promise<unknown> {
  const directory = await secureArtifactDirectory(input.controlPlane);
  const value = await readArtifact(artifactFilename(directory, input.request.payloadArtifactDigest), input.request.payloadArtifactDigest);
  if (value.workItemId !== input.request.workItemId || value.stepId !== input.request.stepId
    || value.attemptId !== input.request.attemptId || value.provider !== input.request.provider
    || value.action !== input.request.action || value.target.kind !== input.request.target.kind
    || value.target.stableId !== input.request.target.stableId || value.payloadDigest !== input.request.payloadDigest) return invalid();
  return value.payload;
}
