import path from "node:path";
import { parse } from "yaml";

import { readArtifact } from "../../domain/artifacts.js";
import type { LoopProjection } from "../../domain/states.js";
import type { ArtifactReference } from "../../protocol/work-package.js";

export interface LoopStepInstance {
  loopId: string;
  iteration: number;
  stepId: string;
}

export class LoopControlError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "LoopControlError";
  }
}

const sourceId = "[a-z][a-z0-9-]{0,62}";
const instancePattern = new RegExp(`^(${sourceId}):([1-9][0-9]*):(${sourceId})$`, "u");

export function loopStepInstanceId(loopId: string, iteration: number, stepId: string): string {
  return `${loopId}:${iteration}:${stepId}`;
}

export function parseLoopStepInstanceId(value: string): LoopStepInstance | undefined {
  const match = instancePattern.exec(value);
  if (match === null) return undefined;
  const iteration = Number(match[2]);
  if (!Number.isSafeInteger(iteration)) return undefined;
  return { loopId: match[1]!, iteration, stepId: match[3]! };
}

export function startLoop(loopId: string, maxIterations: number): LoopProjection {
  return { loopId, iteration: 1, maxIterations, status: "running" };
}

export function advanceLoop(loop: LoopProjection): LoopProjection {
  if (loop.status !== "running" || loop.iteration >= loop.maxIterations) {
    throw new LoopControlError("WSSPEC_LOOP_PROJECTION_INVALID", `循环 ${loop.loopId} 不能进入下一轮。`);
  }
  return { ...loop, iteration: loop.iteration + 1 };
}

export function succeedLoop(loop: LoopProjection): LoopProjection {
  return { ...loop, status: "succeeded" };
}

export function blockLoop(loop: LoopProjection): LoopProjection {
  return { ...loop, status: "blocked" };
}

export function loopLimitProblem(loop: LoopProjection) {
  return {
    code: "WSSPEC_LOOP_MAX_ITERATIONS_REACHED" as const,
    message: `循环 ${loop.loopId} 已达到最大轮数 ${loop.maxIterations}，仍未满足退出条件。`,
    retryable: false,
  };
}

function findingsBlock(body: string): Record<string, unknown> {
  const heading = /^#{1,6}\s+Findings\s*$/mu.exec(body);
  if (heading === null) throw new LoopControlError("WSSPEC_LOOP_ARTIFACT_INVALID", "Review Result 缺少 Findings 章节。");
  const after = body.slice(heading.index + heading[0].length).replace(/^\r?\n/u, "");
  const nextHeading = /^#{1,6}\s+/mu.exec(after);
  const section = after.slice(0, nextHeading?.index ?? after.length);
  const fenced = /```yaml\s*\n([\s\S]*?)\n```/u.exec(section);
  const value = fenced === null ? undefined : parse(fenced[1]!);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LoopControlError("WSSPEC_LOOP_ARTIFACT_INVALID", "Review Result 的 Findings 结构无效。");
  }
  return value as Record<string, unknown>;
}

async function reviewApproved(worktree: string, reference: ArtifactReference): Promise<boolean> {
  if (reference.path === undefined) throw new LoopControlError("WSSPEC_LOOP_ARTIFACT_INVALID", "Review Result 缺少持久化路径。");
  const artifact = await readArtifact(path.join(worktree, reference.path));
  const findings = findingsBlock(artifact.body).findings;
  if (!Array.isArray(findings)) throw new LoopControlError("WSSPEC_LOOP_ARTIFACT_INVALID", "Review Result 的 findings 必须是数组。");
  return findings.every((finding) => {
    return finding !== null
      && typeof finding === "object"
      && !Array.isArray(finding)
      && (finding as Record<string, unknown>).disposition !== "open";
  });
}

export async function projectArtifactValues(
  worktree: string,
  artifacts: readonly ArtifactReference[],
): Promise<Record<string, Record<string, unknown>>> {
  const selected = new Map<string, ArtifactReference>();
  for (const artifact of artifacts) {
    const current = selected.get(artifact.artifactType);
    if ((artifact.revision ?? 0) >= (current?.revision ?? 0)) selected.set(artifact.artifactType, artifact);
  }
  const values: Record<string, Record<string, unknown>> = {};
  for (const artifact of selected.values()) {
    values[artifact.artifactType] = {
      exists: true,
      ...(artifact.contentHash === undefined ? {} : { digest: artifact.contentHash }),
      ...(artifact.artifactType === "review-result" ? { approved: await reviewApproved(worktree, artifact) } : {}),
    };
  }
  return values;
}
