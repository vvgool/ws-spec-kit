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
  fallback?: ResolvedSkillFallback;
}

export interface SkillLockEntry {
  requested: string;
  resolved: string;
  source: SkillSource;
  provider: SkillProvider;
  rootId: string;
  digest: string;
  candidates: SkillCandidate[];
  required: boolean;
  usedFallback: boolean;
  fallback?: string;
  fallbackDigest?: string;
  fallbackSource?: SkillSource;
  fallbackRootId?: string;
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
  additionalGlobalRoots?: string[];
  lock?: SkillLock;
}

export type SkillBinding = WorkflowSkillBinding;

export class SkillResolutionError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "SkillResolutionError";
  }
}
