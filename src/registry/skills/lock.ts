import path from "node:path";

import type { ResolvedSkill, ResolvedSkillFallback, ResolvedSkillPrimary, SkillCandidate, SkillLock, SkillLockEntry, SkillLockSelected, SkillProvider, SkillSource } from "./types.js";
import { SkillResolutionError } from "./types.js";

const providers = ["codex", "claude", "cursor", "generic"] as const;
const sources = ["builtin", "package", "global", "project"] as const;

function invalid(message: string): never {
  throw new SkillResolutionError("WSSPEC_SKILL_LOCK_INVALID", message);
}

function record(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} 必须是对象。`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) invalid(`${label} 包含未知字段。`);
  return result;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") invalid(`${label} 必须是非空字符串。`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} 必须是布尔值。`);
  return value;
}

function provider(value: unknown, label: string): SkillProvider {
  if (!providers.includes(value as SkillProvider)) invalid(`${label} 不是受支持 Provider。`);
  return value as SkillProvider;
}

function source(value: unknown, label: string): SkillSource {
  if (!sources.includes(value as SkillSource)) invalid(`${label} 不是受支持来源。`);
  return value as SkillSource;
}

function selection(value: unknown, label: string): SkillLockEntry["selection"] {
  if (value !== "primary" && value !== "fallback") invalid(`${label} 不是受支持的选择状态。`);
  return value;
}

function skillRef(value: unknown, label: string): { ref: string; source: SkillSource } {
  const ref = string(value, label);
  const match = /^(builtin|package|global|project):\/\/(.*)$/.exec(ref);
  if (match === null) invalid(`${label} 不是有效 Skill URI。`);
  const refSource = match[1]! as SkillSource;
  const rawPath = match[2]!;
  const segments = rawPath.split("/");
  if (rawPath === "" || rawPath.includes("%") || rawPath.includes("\\") || segments.some((segment) => !/^[a-z0-9][a-z0-9-]*$/.test(segment))) invalid(`${label} 不是有效 Skill URI。`);
  if (refSource !== "global" && (segments.length !== 2 || segments[0] !== "skills")) invalid(`${label} 不是有效 Skill URI。`);
  return { ref, source: refSource };
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) invalid(`${label} 必须是 sha256 摘要。`);
  return result;
}

function rootId(value: unknown, refSource: SkillSource, host: SkillProvider, label: string): string {
  const result = string(value, label);
  const defaultLimits: Record<SkillProvider, number> = { codex: 1, claude: 1, cursor: 4, generic: 0 };
  const defaultMatch = new RegExp(`^${host}:default:(0|[1-9][0-9]*)$`).exec(result);
  const additionalMatch = new RegExp(`^${host}:additional:[a-z][a-z0-9-]{0,62}$`).exec(result);
  const validGlobal = (defaultMatch !== null && Number(defaultMatch[1]) < defaultLimits[host]) || additionalMatch !== null;
  const valid = refSource === "builtin"
    ? result === "builtin"
    : refSource === "package"
      ? result === "package"
      : refSource === "project"
        ? result === "project"
        : validGlobal;
  if (!valid) invalid(`${label} 必须是可移植逻辑标识。`);
  return result;
}

function candidate(value: unknown, refSource: SkillSource, host: SkillProvider, label: string): SkillCandidate {
  const item = record(value, label, ["rootId", "digest"]);
  return { rootId: rootId(item.rootId, refSource, host, `${label}.rootId`), digest: digest(item.digest, `${label}.digest`) };
}

function candidates(value: unknown, refSource: SkillSource, host: SkillProvider, label: string): SkillCandidate[] {
  if (!Array.isArray(value)) invalid(`${label} 必须是数组。`);
  return value.map((item, index) => candidate(item, refSource, host, `${label}[${index}]`));
}

function fallback(value: unknown, host: SkillProvider, label: string): SkillLockEntry["fallback"] {
  const item = record(value, label, ["ref", "source", "rootId", "digest"]);
  const parsedRef = skillRef(item.ref, `${label}.ref`);
  const itemSource = source(item.source, `${label}.source`);
  if (parsedRef.source !== itemSource || itemSource !== "builtin") invalid(`${label} 必须是 Builtin fallback。`);
  return {
    ref: parsedRef.ref,
    source: itemSource,
    rootId: rootId(item.rootId, itemSource, host, `${label}.rootId`),
    digest: digest(item.digest, `${label}.digest`),
  };
}

function selected(value: unknown, label: string): SkillLockSelected {
  const item = record(value, label, ["ref", "source", "provider", "rootId", "digest"]);
  const parsedRef = skillRef(item.ref, `${label}.ref`);
  const itemSource = source(item.source, `${label}.source`);
  const host = provider(item.provider, `${label}.provider`);
  if (parsedRef.source !== itemSource) invalid(`${label} ref 与 source 不一致。`);
  return {
    ref: parsedRef.ref,
    source: itemSource,
    provider: host,
    rootId: rootId(item.rootId, itemSource, host, `${label}.rootId`),
    digest: digest(item.digest, `${label}.digest`),
  };
}

function lockEntry(value: unknown, index: number): SkillLockEntry {
  const label = `Skill Lock skills[${index}]`;
  const item = record(value, label, ["requested", "resolved", "source", "provider", "rootId", "digest", "candidates", "required", "fallback", "selection", "selected"]);
  const requested = skillRef(item.requested, `${label}.requested`);
  const resolved = skillRef(item.resolved, `${label}.resolved`);
  const itemSource = source(item.source, `${label}.source`);
  const host = provider(item.provider, `${label}.provider`);
  if (requested.ref !== resolved.ref || requested.source !== itemSource || resolved.source !== itemSource) invalid(`${label} 必须固定记录 requested 主项身份。`);
  const lockedCandidates = candidates(item.candidates, itemSource, host, `${label}.candidates`);
  const hasRoot = item.rootId !== undefined;
  const hasDigest = item.digest !== undefined;
  if (hasRoot !== hasDigest) invalid(`${label}.rootId 与 digest 必须同时存在。`);
  let lockedRoot: string | undefined;
  let lockedDigest: string | undefined;
  if (hasRoot) {
    lockedRoot = rootId(item.rootId, itemSource, host, `${label}.rootId`);
    lockedDigest = digest(item.digest, `${label}.digest`);
    if (lockedCandidates.length === 0 || !lockedCandidates.some((entry) => entry.rootId === lockedRoot && entry.digest === lockedDigest)) invalid(`${label} 主项必须出现在 candidates 中。`);
    if (new Set(lockedCandidates.map((entry) => entry.rootId)).size !== lockedCandidates.length || lockedCandidates.some((entry) => entry.digest !== lockedDigest)) invalid(`${label}.candidates 必须是同摘要的唯一逻辑根。`);
  } else if (lockedCandidates.length !== 0) invalid(`${label} 未锁主项时 candidates 必须为空。`);
  const lockedFallback = item.fallback === undefined ? undefined : fallback(item.fallback, host, `${label}.fallback`);
  if (lockedFallback !== undefined && itemSource !== "global") invalid(`${label} 只有 Global 主项可以声明 fallback。`);
  if (lockedRoot === undefined && lockedFallback === undefined) invalid(`${label} 必须锁定主项或 fallback。`);
  const lockedSelection = selection(item.selection, `${label}.selection`);
  const lockedSelected = selected(item.selected, `${label}.selected`);
  const selectedBaseline = lockedSelection === "primary"
    ? (lockedRoot === undefined ? undefined : { ref: requested.ref, source: itemSource, rootId: lockedRoot, digest: lockedDigest! })
    : lockedFallback;
  if (selectedBaseline === undefined
    || lockedSelected.provider !== host
    || lockedSelected.ref !== selectedBaseline.ref
    || lockedSelected.source !== selectedBaseline.source
    || lockedSelected.rootId !== selectedBaseline.rootId
    || lockedSelected.digest !== selectedBaseline.digest) {
    invalid(`${label}.selected 与 selection 指定的基线不一致。`);
  }
  return {
    requested: requested.ref,
    resolved: resolved.ref,
    source: itemSource,
    provider: host,
    ...(lockedRoot === undefined ? {} : { rootId: lockedRoot, digest: lockedDigest! }),
    candidates: lockedCandidates,
    required: boolean(item.required, `${label}.required`),
    ...(lockedFallback === undefined ? {} : { fallback: lockedFallback }),
    selection: lockedSelection,
    selected: lockedSelected,
  };
}

export function parseSkillLock(value: unknown): SkillLock {
  const lock = record(value, "Skill Lock", ["version", "skills"]);
  if (lock.version !== 1) invalid("只支持 Skill Lock v1。");
  if (!Array.isArray(lock.skills)) invalid("Skill Lock skills 必须是数组。");
  const skills = lock.skills.map(lockEntry).sort((left, right) => left.requested.localeCompare(right.requested));
  if (new Set(skills.map(({ requested }) => requested)).size !== skills.length) invalid("Skill Lock 不允许重复 requested 引用。");
  return { version: 1, skills };
}

function strictFallback(value: unknown, label: string, host: SkillProvider): ResolvedSkillFallback {
  const item = record(value, label, ["ref", "source", "rootId", "digest"]);
  const parsed = skillRef(item.ref, `${label}.ref`);
  const itemSource = source(item.source, `${label}.source`);
  if (parsed.source !== itemSource) invalid(`${label} ref 与 source 不一致。`);
  return { ref: parsed.ref, source: itemSource, rootId: rootId(item.rootId, itemSource, host, `${label}.rootId`), digest: digest(item.digest, `${label}.digest`) };
}

function strictPrimary(value: unknown, label: string, host: SkillProvider): ResolvedSkillPrimary {
  const item = record(value, label, ["ref", "source", "rootId", "digest", "candidates"]);
  const parsed = skillRef(item.ref, `${label}.ref`);
  const itemSource = source(item.source, `${label}.source`);
  if (parsed.source !== itemSource) invalid(`${label} ref 与 source 不一致。`);
  const descriptor = {
    ref: parsed.ref,
    source: itemSource,
    rootId: rootId(item.rootId, itemSource, host, `${label}.rootId`),
    digest: digest(item.digest, `${label}.digest`),
  };
  const resultCandidates = candidates(item.candidates, itemSource, host, `${label}.candidates`);
  if (resultCandidates.length === 0 || !resultCandidates.some((entry) => entry.rootId === descriptor.rootId && entry.digest === descriptor.digest)) invalid(`${label} 必须出现在 candidates 中。`);
  return { ...descriptor, candidates: resultCandidates };
}

function resolvedSkill(value: unknown, index: number): ResolvedSkill {
  const label = `Resolved Skill[${index}]`;
  const item = record(value, label, ["requestedRef", "ref", "source", "provider", "rootId", "entrypoint", "digest", "candidates", "required", "usedFallback", "primary", "fallback"]);
  const requested = skillRef(item.requestedRef, `${label}.requestedRef`);
  const selected = skillRef(item.ref, `${label}.ref`);
  const selectedSource = source(item.source, `${label}.source`);
  const host = provider(item.provider, `${label}.provider`);
  if (selected.source !== selectedSource) invalid(`${label} ref 与 source 不一致。`);
  const selectedRoot = rootId(item.rootId, selectedSource, host, `${label}.rootId`);
  const selectedDigest = digest(item.digest, `${label}.digest`);
  const selectedCandidates = candidates(item.candidates, selectedSource, host, `${label}.candidates`);
  if (!selectedCandidates.some((entry) => entry.rootId === selectedRoot && entry.digest === selectedDigest)) invalid(`${label} 当前项必须出现在 candidates 中。`);
  const entrypoint = string(item.entrypoint, `${label}.entrypoint`);
  if (!path.isAbsolute(entrypoint)) invalid(`${label}.entrypoint 必须是绝对运行时路径。`);
  const primary = item.primary === undefined ? undefined : strictPrimary(item.primary, `${label}.primary`, host);
  const resolvedFallback = item.fallback === undefined ? undefined : strictFallback(item.fallback, `${label}.fallback`, host);
  const usedFallback = boolean(item.usedFallback, `${label}.usedFallback`);
  if (primary !== undefined && (primary.ref !== requested.ref || primary.source !== requested.source)) invalid(`${label}.primary 必须描述 requested 主项。`);
  if (resolvedFallback !== undefined && (requested.source !== "global" || resolvedFallback.source !== "builtin")) invalid(`${label}.fallback 来源不受支持。`);
  if (usedFallback) {
    if (resolvedFallback === undefined || selected.ref !== resolvedFallback.ref || selectedDigest !== resolvedFallback.digest || selectedRoot !== resolvedFallback.rootId) invalid(`${label} fallback 选择状态不一致。`);
  } else if (primary === undefined || selected.ref !== requested.ref || selectedDigest !== primary.digest || selectedRoot !== primary.rootId) invalid(`${label} 主项选择状态不一致。`);
  return {
    requestedRef: requested.ref,
    ref: selected.ref,
    source: selectedSource,
    provider: host,
    rootId: selectedRoot,
    entrypoint,
    digest: selectedDigest,
    candidates: selectedCandidates,
    required: boolean(item.required, `${label}.required`),
    usedFallback,
    ...(primary === undefined ? {} : { primary }),
    ...(resolvedFallback === undefined ? {} : { fallback: resolvedFallback }),
  };
}

export function createSkillLock(resolved: ResolvedSkill | readonly ResolvedSkill[]): SkillLock {
  const inputs = Array.isArray(resolved) ? resolved : [resolved];
  const entries = inputs.map(resolvedSkill).map((item): SkillLockEntry => {
    const requested = skillRef(item.requestedRef, "Resolved Skill requestedRef");
    return {
      requested: requested.ref,
      resolved: requested.ref,
      source: requested.source,
      provider: item.provider,
      ...(item.primary === undefined ? {} : { rootId: item.primary.rootId, digest: item.primary.digest }),
      candidates: item.primary?.candidates ?? [],
      required: item.required,
      ...(item.fallback === undefined ? {} : { fallback: { ...item.fallback } }),
      selection: item.usedFallback ? "fallback" : "primary",
      selected: {
        ref: item.ref,
        source: item.source,
        provider: item.provider,
        rootId: item.rootId,
        digest: item.digest,
      },
    };
  });
  return parseSkillLock({ version: 1, skills: entries });
}
