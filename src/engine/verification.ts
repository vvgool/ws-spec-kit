import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as canonicalizeModule from "canonicalize";
import { parse } from "yaml";

import { computeWorkspaceTreeDigest, sha256 } from "../domain/digests.js";
import { readControlPlane, type RuntimeProjection } from "../storage/control-plane.js";
import { mutateControlPlane, transitionRuntime } from "./scheduler.js";

const execute = promisify(execFile);
const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

export interface TrustedEvidence { evidenceId: string; level: "trusted"; stageId: string; gateId: string; codeRevision: string; baselineTreeDigest: string; workspaceTreeDigest: string; configDigest: string; attemptId: string; result: "passed" | "failed"; recordHash: string; exitCode: number; stdout: string; stderr: string }
export class VerificationError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "VerificationError"; } }

async function fixture(cwd: string, workItemId: string) {
  const projection = await readControlPlane(cwd, workItemId); const locatorRoot = path.dirname(projection.controlPlane);
  const locator = JSON.parse(await readFile(path.join(locatorRoot, "locator.json"), "utf8")) as { worktree: string };
  const cache = JSON.parse(await readFile(path.resolve(projection.controlPlane, "../../../repository.json"), "utf8")) as { repositoryRoot: string };
  const itemRoot = path.join(cache.repositoryRoot, locator.worktree, ".wsspec", "work-items", workItemId);
  const manifest = parse(await readFile(path.join(itemRoot, "work-item.yaml"), "utf8")) as { execution: { baselineRevision: string; baselineTreeDigest: string; configDigest: string } };
  const config = parse(await readFile(path.join(itemRoot, "snapshot/config.yaml"), "utf8")) as { quality: { gates: Record<string, { command: string[]; timeoutSeconds: number; inheritEnv?: string[]; env?: Record<string, string>; required: boolean }> } };
  return { projection, worktree: path.join(cache.repositoryRoot, locator.worktree), manifest, config };
}

export async function runTrustedGate(input: { cwd: string; workItemId: string; stageId: string; attemptId: string; gateId: string }): Promise<TrustedEvidence> {
  const data = await fixture(input.cwd, input.workItemId); const gate = data.config.quality.gates[input.gateId];
  if (gate === undefined) throw new VerificationError("WSSPEC_GATE_NOT_FOUND", `找不到 Gate ${input.gateId}。`);
  const env: Record<string, string> = { ...(gate.env ?? {}) }; for (const name of gate.inheritEnv ?? []) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  let exitCode = 0, stdout = "", stderr = "";
  try { const result = await execute(gate.command[0]!, gate.command.slice(1), { cwd: data.worktree, env, timeout: gate.timeoutSeconds * 1000, maxBuffer: 1024 * 1024 }); stdout = result.stdout; stderr = result.stderr; }
  catch (error) { const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string }; exitCode = typeof failure.code === "number" ? failure.code : -1; stdout = failure.stdout ?? ""; stderr = failure.stderr ?? failure.message; }
  const unsigned = { evidenceId: `evidence-${crypto.randomUUID()}`, level: "trusted" as const, stageId: input.stageId, gateId: input.gateId, codeRevision: data.manifest.execution.baselineRevision, baselineTreeDigest: data.manifest.execution.baselineTreeDigest, workspaceTreeDigest: await computeWorkspaceTreeDigest(data.worktree), configDigest: data.manifest.execution.configDigest, attemptId: input.attemptId, result: exitCode === 0 ? "passed" as const : "failed" as const, exitCode, stdout: stdout.slice(0, 65536), stderr: stderr.slice(0, 65536) };
  const content = canonicalize(unsigned); if (content === undefined) throw new VerificationError("WSSPEC_EVIDENCE_INVALID", "Evidence 无法规范化。");
  const evidence: TrustedEvidence = { ...unsigned, recordHash: sha256(content) };
  return mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "evidence.recorded", idempotencyKey: `evidence:${evidence.evidenceId}`,
    stageId: input.stageId, attemptId: input.attemptId, operationInput: evidence,
    mutate: async (current) => {
      if (await computeWorkspaceTreeDigest(data.worktree) !== evidence.workspaceTreeDigest) throw new VerificationError("WSSPEC_WORKSPACE_CHANGED", "Gate 执行后工作区发生变化，Evidence 未记录。");
      return { projection: { ...current, evidence: { ...current.evidence, [evidence.evidenceId]: evidence } }, value: evidence };
    },
  });
}

export async function recordReportedEvidence(input: { cwd: string; workItemId: string; stageId: string; attemptId: string; gateId: string; claimedLevel?: string; result: "passed" | "failed" }): Promise<{ evidenceId: string; level: "reported"; result: "passed" | "failed"; recordHash: string }> {
  const data = await fixture(input.cwd, input.workItemId);
  const unsigned = { evidenceId: `evidence-${crypto.randomUUID()}`, level: "reported" as const, stageId: input.stageId, gateId: input.gateId, attemptId: input.attemptId, result: input.result, workspaceTreeDigest: await computeWorkspaceTreeDigest(data.worktree) };
  const content = canonicalize(unsigned); if (content === undefined) throw new VerificationError("WSSPEC_EVIDENCE_INVALID", "Evidence 无法规范化。");
  const evidence = { ...unsigned, recordHash: sha256(content) };
  return mutateControlPlane({
    cwd: input.cwd, workItemId: input.workItemId, eventType: "evidence.recorded", idempotencyKey: `evidence:${evidence.evidenceId}`,
    stageId: input.stageId, attemptId: input.attemptId, operationInput: evidence,
    mutate: (current) => ({ projection: { ...current, evidence: { ...current.evidence, [evidence.evidenceId]: evidence } }, value: evidence }),
  });
}

export async function verifyWorkItem(input: { cwd: string; workItemId: string }): Promise<RuntimeProjection> {
  let data = await fixture(input.cwd, input.workItemId);
  if (data.projection.workItem.status === "verified") {
    const current = await computeWorkspaceTreeDigest(data.worktree); const trusted = Object.values(data.projection.evidence) as TrustedEvidence[];
    if (trusted.some((evidence) => evidence.result === "passed" && evidence.workspaceTreeDigest === current)) return data.projection;
    await transitionRuntime({ cwd: input.cwd, workItemId: input.workItemId, scope: "work-item", to: "blocked", idempotencyKey: `workspace-invalid:${current}` });
    throw new VerificationError("WSSPEC_WORKSPACE_CHANGED", "已验证工作区发生变化，旧 Evidence 已失效。");
  }
  if (data.projection.workItem.status === "blocked") await transitionRuntime({ cwd: input.cwd, workItemId: input.workItemId, scope: "work-item", to: "verifying", idempotencyKey: `retry-verify:${data.projection.lastSequence}` });
  else await transitionRuntime({ cwd: input.cwd, workItemId: input.workItemId, scope: "work-item", to: "verifying", idempotencyKey: `verify:${data.projection.lastSequence}` });
  const gates = Object.entries(data.config.quality.gates); const attemptId = `attempt-${crypto.randomUUID()}`;
  for (const [gateId, gate] of gates) {
    const evidence = await runTrustedGate({ ...input, stageId: "verify", attemptId, gateId });
    if (gate.required && evidence.result !== "passed") { await transitionRuntime({ cwd: input.cwd, workItemId: input.workItemId, scope: "work-item", to: "blocked", idempotencyKey: `gate-failed:${evidence.evidenceId}` }); throw new VerificationError("WSSPEC_REQUIRED_GATE_FAILED", `必需 Gate ${gateId} 未通过。`); }
  }
  return transitionRuntime({ cwd: input.cwd, workItemId: input.workItemId, scope: "work-item", to: "verified", idempotencyKey: `verified:${attemptId}` });
}
