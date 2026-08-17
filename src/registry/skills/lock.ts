import type { ResolvedSkill, SkillLock, SkillLockEntry } from "./types.js";

function lockEntry(resolved: ResolvedSkill): SkillLockEntry {
  return {
    requested: resolved.requestedRef,
    resolved: resolved.ref,
    source: resolved.source,
    provider: resolved.provider,
    rootId: resolved.rootId,
    digest: resolved.digest,
    candidates: resolved.candidates.map(({ rootId, digest }) => ({ rootId, digest })),
    required: resolved.required,
    usedFallback: resolved.usedFallback,
    ...(resolved.fallback === undefined ? {} : {
      fallback: resolved.fallback.ref,
      fallbackDigest: resolved.fallback.digest,
      fallbackSource: resolved.fallback.source,
      fallbackRootId: resolved.fallback.rootId,
    }),
  };
}

export function createSkillLock(resolved: ResolvedSkill | readonly ResolvedSkill[]): SkillLock {
  const skills = (Array.isArray(resolved) ? resolved : [resolved])
    .map(lockEntry)
    .sort((left, right) => left.requested.localeCompare(right.requested));
  if (new Set(skills.map(({ requested }) => requested)).size !== skills.length) {
    throw new TypeError("Skill Lock 不允许重复 requested 引用。");
  }
  return { version: 1, skills };
}
