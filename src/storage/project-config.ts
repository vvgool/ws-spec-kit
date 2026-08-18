import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import type { AdditionalGlobalRoot } from "../registry/skills/types.js";
import { validate } from "../schemas/index.js";

export class ProjectConfigError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProjectConfigError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function additionalGlobalRootsFromConfig(raw: unknown): AdditionalGlobalRoot[] {
  const source = validate<Record<string, unknown>>("builtin.application-project-config.v1", raw);
  const skills = record(source.skills);
  const configured = skills?.additionalGlobalRoots;
  if (configured === undefined) return [];
  const roots = (configured as Array<{ id: string; path: string }>).map((root) => ({ ...root }));
  if (new Set(roots.map(({ id }) => id)).size !== roots.length) {
    throw new ProjectConfigError("WSSPEC_PROJECT_CONFIG_INVALID", "附加 Global Skill 根 ID 不能重复。");
  }
  return roots;
}

export function portableProjectConfigText(raw: unknown): string {
  const source = structuredClone(validate<Record<string, unknown>>("builtin.application-project-config.v1", raw));
  const skills = record(source.skills);
  const roots = additionalGlobalRootsFromConfig(source);
  if (skills !== undefined && roots.length > 0) {
    skills.additionalGlobalRoots = roots.map(({ id }) => ({ id }));
  }
  return stringify(validate("builtin.application-project-config-snapshot.v1", source), { lineWidth: 0 });
}

export async function rebindAdditionalGlobalRoots(input: {
  root: string;
  rootIds: readonly string[];
}): Promise<AdditionalGlobalRoot[]> {
  if (input.rootIds.length === 0) return [];
  let configText: string;
  try {
    configText = await readFile(path.join(input.root, ".wsspec", "config.yaml"), "utf8");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectConfigError("WSSPEC_GLOBAL_ROOT_NOT_CONFIGURED", "当前 host 缺少 Global Skill 根绑定配置。");
    }
    throw caught;
  }
  const raw = parse(configText);
  const configured = new Map(additionalGlobalRootsFromConfig(raw).map((root) => [root.id, root]));
  return input.rootIds.map((id) => {
    const root = configured.get(id);
    if (root === undefined) {
      throw new ProjectConfigError("WSSPEC_GLOBAL_ROOT_NOT_CONFIGURED", `当前 host 配置未绑定 Global Skill 根 ${id}。`);
    }
    return root;
  });
}
