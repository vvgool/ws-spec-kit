import { sha256 } from "../domain/digests.js";
import type { RuntimeProjection, RuntimeClaim } from "../storage/control-plane.js";
import { readEvents } from "../storage/events.js";
import type { TrustedEvidence } from "../engine/tdd/types.js";
import { tddRedEvidenceKey } from "../engine/verification.js";
function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function workspaceSnapshotDigest(snapshot: RuntimeClaim["workspaceSnapshot"]): string {
  const entries = snapshot.map(entry => entry.type === "file" ? { path: entry.path, type: entry.type, mode: entry.mode, digest: entry.digest }
    : entry.type === "symlink" ? { path: entry.path, type: entry.type, mode: entry.mode, target: entry.target }
    : { path: entry.path, type: entry.type, mode: entry.mode });
  return sha256(`${JSON.stringify({ version: 1, entries })}\n`);
}
// Recover only an engine-recorded implementation baseline bound to this Red.
// Historical events also cover installations that already discarded expired Claims.
export async function implementationBaseline(projection: RuntimeProjection): Promise<RuntimeClaim | undefined> {
  const key = tddRedEvidenceKey(projection.workItemId);
  const red = projection.evidence[key] as TrustedEvidence | undefined;
  if (red === undefined) return undefined;
  const recovery = objectRecord(projection.evidence["testing.red-revalidation"]);
  const recovered = recovery?.baseline as RuntimeClaim | undefined;
  if (recovery?.redEvidenceId === red.evidenceId && recovered?.stageId === "implement"
    && recovered.inputWorkspaceTreeDigest === red.workspaceDigest && Array.isArray(recovered.workspaceSnapshot)
    && workspaceSnapshotDigest(recovered.workspaceSnapshot) === red.workspaceDigest) return recovered;
  const events = await readEvents(projection.controlPlane);
  for (let index = events.length - 1; index >= 0; index--) {
    const snapshot = objectRecord(objectRecord(events[index]?.result)?.projection);
    if (snapshot === undefined) continue;
    const historicalRed = objectRecord(objectRecord(snapshot.evidence)?.[key]);
    if (historicalRed?.evidenceId !== red.evidenceId) break;
    const claim = objectRecord(objectRecord(snapshot.claims)?.implement) as unknown as RuntimeClaim | undefined;
    if (claim?.stageId === "implement" && claim.inputWorkspaceTreeDigest === red.workspaceDigest
      && Array.isArray(claim.workspaceSnapshot) && workspaceSnapshotDigest(claim.workspaceSnapshot) === red.workspaceDigest) return claim;
  }
  return undefined;
}
