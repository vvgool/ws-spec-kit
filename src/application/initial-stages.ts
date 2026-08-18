import type { StageState } from "../domain/states.js";
import type { SnapshotProfile } from "./snapshot.js";

export function deriveInitialStages(profile: Pick<SnapshotProfile, "steps">): Record<string, StageState> {
  return Object.fromEntries(profile.steps.map((step) => [
    step.id,
    { status: !step.enabled ? "skipped" : step.needs.length === 0 && step.when === undefined ? "ready" : "pending" },
  ])) as Record<string, StageState>;
}
