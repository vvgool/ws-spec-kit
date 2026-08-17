import type { ProfileId } from "../domain/workflow.js";

export type RiskLevel = "low" | "medium" | "high";
export type ProfileMode = "auto" | ProfileId;
export type ProfileSelectionPhase = "intake" | "post-explore";

export interface ResolvedProfile {
  id: ProfileId;
  provisional: boolean;
  source: "explicit" | "provisional" | "risk" | "unknown";
}

export interface ProfileDecision {
  profile: ProfileId;
  upgraded: boolean;
  affectedSteps: string[];
}

const strength: Record<ProfileId, number> = { quick: 0, standard: 1, governed: 2 };

export function selectProfile(input: { mode: ProfileMode; phase: ProfileSelectionPhase; risk: RiskLevel | null }): ResolvedProfile {
  if (input.mode !== "auto") return { id: input.mode, provisional: false, source: "explicit" };
  if (input.phase === "intake") return { id: "quick", provisional: true, source: "provisional" };
  if (input.risk === null) return { id: "standard", provisional: false, source: "unknown" };
  return {
    id: input.risk === "low" ? "quick" : input.risk === "medium" ? "standard" : "governed",
    provisional: false,
    source: "risk",
  };
}

export function evaluateProfileUpgrade(input: { current: ProfileId; minimum: ProfileId; affectedSteps?: readonly string[] }): ProfileDecision {
  const upgraded = strength[input.minimum] > strength[input.current];
  return {
    profile: upgraded ? input.minimum : input.current,
    upgraded,
    affectedSteps: upgraded ? [...new Set(input.affectedSteps ?? [])].sort() : [],
  };
}
