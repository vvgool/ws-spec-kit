import type { SnapshotProfile, SnapshotStep } from "../application/state.js";
import type { RuntimeProjection } from "../storage/control-plane.js";
import { parseLoopStepInstanceId } from "./control/loop.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function completedActor(value: unknown): { completed: boolean; actor?: string } {
  const source = record(value) as { actor?: unknown; result?: { status?: unknown } } | undefined;
  return {
    completed: source?.result?.status === "completed",
    ...(typeof source?.actor === "string" && source.actor !== "" ? { actor: source.actor } : {}),
  };
}

function topLevelWasSkipped(projection: RuntimeProjection, step: SnapshotStep): boolean {
  return projection.stages[step.id]?.status === "skipped"
    || record(projection.contexts[step.id])?.skipped === true;
}

export function implementationActors(input: {
  profile: SnapshotProfile;
  projection: RuntimeProjection;
  loopId: string;
  iteration: number;
}): ReadonlySet<string> | undefined {
  const actors = new Set<string>();
  const implementationSteps = input.profile.steps.filter((step) => {
    return step.enabled && step.actorRole === "implementation" && !topLevelWasSkipped(input.projection, step);
  });
  if (implementationSteps.length === 0) return undefined;
  for (const step of implementationSteps) {
    const candidate = completedActor(input.projection.contexts[step.id]);
    if (!candidate.completed || candidate.actor === undefined) return undefined;
    actors.add(candidate.actor);
  }
  const loop = input.profile.steps.find(({ id }) => id === input.loopId);
  const fixStepIds = new Set(loop?.steps.filter(({ actorRole }) => actorRole === "fix").map(({ id }) => id) ?? []);
  for (const [stepInstanceId, value] of Object.entries(input.projection.contexts)) {
    const parsed = parseLoopStepInstanceId(stepInstanceId);
    if (parsed?.loopId !== input.loopId || !fixStepIds.has(parsed.stepId) || parsed.iteration >= input.iteration) continue;
    const candidate = completedActor(value);
    if (!candidate.completed) continue;
    if (candidate.actor === undefined) return undefined;
    actors.add(candidate.actor);
  }
  return actors.size === 0 ? undefined : actors;
}

export function completedReviewActors(input: {
  loop: SnapshotStep;
  projection: RuntimeProjection;
}): Array<{ iteration: number; actor?: string }> {
  const reviewStepIds = new Set(input.loop.steps.filter(({ actorRole }) => actorRole === "review").map(({ id }) => id));
  return Object.entries(input.projection.contexts)
    .map(([stepInstanceId, value]) => ({ parsed: parseLoopStepInstanceId(stepInstanceId), candidate: completedActor(value) }))
    .filter(({ parsed, candidate }) => parsed?.loopId === input.loop.id && reviewStepIds.has(parsed.stepId) && candidate.completed)
    .map(({ parsed, candidate }) => ({ iteration: parsed!.iteration, ...(candidate.actor === undefined ? {} : { actor: candidate.actor }) }));
}
