import type { WorkflowPackage, WorkflowSkillBinding } from "../../workflow-package/types.js";

export type SkillSource = "builtin" | "package" | "global" | "project";
export type SkillProvider = "codex" | "claude" | "cursor" | "generic";

export interface SkillCandidate {
  rootId: string;
  digest: string;
}

export interface ResolvedSkillFallback {
  ref: string;
  source: SkillSource;
  rootId: string;
  digest: string;
}

export interface ResolvedSkillPrimary extends ResolvedSkillFallback {
  candidates: SkillCandidate[];
}

export interface ResolvedSkill {
  requestedRef: string;
  ref: string;
  source: SkillSource;
  provider: SkillProvider;
  rootId: string;
  entrypoint: string;
  digest: string;
  candidates: SkillCandidate[];
  required: boolean;
  usedFallback: boolean;
  primary?: ResolvedSkillPrimary;
  fallback?: ResolvedSkillFallback;
}

export interface SkillLockFallback {
  ref: string;
  source: SkillSource;
  rootId: string;
  digest: string;
}

export type SkillLockSelection = "primary" | "fallback";

export interface SkillLockSelected extends SkillLockFallback {
  provider: SkillProvider;
}

export interface SkillLockEntry {
  requested: string;
  resolved: string;
  source: SkillSource;
  provider: SkillProvider;
  rootId?: string;
  digest?: string;
  candidates: SkillCandidate[];
  required: boolean;
  fallback?: SkillLockFallback;
  selection: SkillLockSelection;
  selected: SkillLockSelected;
}

export interface SkillLock {
  version: 1;
  skills: SkillLockEntry[];
}

export interface SkillResolverContext {
  provider: SkillProvider;
  projectRoot: string;
  home: string;
  package: WorkflowPackage;
  stepStatus: "not_started" | "started";
  additionalGlobalRoots?: string[];
  lock?: unknown;
}

export type SkillBinding = WorkflowSkillBinding;

export class SkillResolutionError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "SkillResolutionError";
  }
}
