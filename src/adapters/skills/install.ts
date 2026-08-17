import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { sha256 } from "../../domain/digests.js";
import { writeFileAtomic } from "../../storage/files.js";
import { CliAdapterError } from "../cli/output.js";
import { claudeDriverTarget } from "./claude.js";
import { codexDriverTarget } from "./codex.js";
import { cursorDriverTarget } from "./cursor.js";
import { genericDriverTarget } from "./generic.js";

export type DriverAgent = "codex" | "claude" | "cursor" | "generic";
export interface InstallDriverSkillInput { agent: DriverAgent; home: string; target?: string; dryRun?: boolean }
export interface InstallDriverSkillResult { agent: DriverAgent; target: string; dryRun: boolean }
export interface DriverSkillInstallerDependencies {
  mkdir(target: string): Promise<void>;
  writeSkill(target: string, content: string): Promise<void>;
}

function body(agent: DriverAgent): string {
  return [
    "# WSSpecKit Driver",
    "",
    "新任务判断功能/文档 Workflow 并显式 start / 已有任务 inspect -> acquire -> 读取绑定 Skill -> 当前 Agent 执行 -> submit -> 重复",
    "",
    "仅当需求明确为纯文档或无代码变更时，建议 `documentation-delivery`；其余默认 `feature-delivery`。创建时必须传递 `workflowRef`，允许用户覆盖，创建后不得自动切换。",
    "",
    `手动调用示例：\`wspec start --provider ${agent} --prompt "更新 README" --workflow builtin://workflows/documentation-delivery\`。`,
    "",
  ].join("\n");
}

function skill(agent: DriverAgent): string {
  const content = body(agent);
  return [
    "---",
    "name: wsspeckit-driver",
    "wsspeckit-driver-version: 1",
    `wsspeckit-driver-content-digest: ${sha256(content)}`,
    "description: 使用 WSSpecKit 驱动软件交付 Workflow；新任务、已有任务或用户明确要求时调用。",
    "---",
    "",
    content,
  ].join("\n");
}

async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function targetFor(input: InstallDriverSkillInput): string {
  if (input.agent !== "generic" && input.target !== undefined) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "只有 Generic Driver 支持 --target。");
  const target = input.agent === "codex" ? codexDriverTarget(input.home)
    : input.agent === "claude" ? claudeDriverTarget(input.home)
      : input.agent === "cursor" ? cursorDriverTarget(input.home)
        : genericDriverTarget(input.target);
  if (target === undefined || target === "") throw new CliAdapterError("WSSPEC_ARGUMENT_REQUIRED", "Generic Driver 必须通过 --target 指定安装目录。");
  return path.resolve(target);
}

function ownedSkill(content: string, agent: DriverAgent): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/u.exec(content);
  if (match === null) return false;
  let frontMatter: unknown;
  try { frontMatter = parse(match[1]!); } catch { return false; }
  if (frontMatter === null || typeof frontMatter !== "object" || Array.isArray(frontMatter)) return false;
  const source = frontMatter as Record<string, unknown>;
  return source.name === "wsspeckit-driver"
    && source["wsspeckit-driver-version"] === 1
    && source["wsspeckit-driver-content-digest"] === sha256(match[2]!)
    && content === skill(agent);
}

async function assertOwned(target: string, agent: DriverAgent): Promise<void> {
  if (!(await exists(target))) return;
  let existing: string;
  try { existing = await readFile(path.join(target, "SKILL.md"), "utf8"); }
  catch { throw new CliAdapterError("WSSPEC_SKILL_INSTALL_CONFLICT", "安装目标已存在且不是 WSSpecKit Driver，拒绝覆盖。"); }
  if (!ownedSkill(existing, agent)) throw new CliAdapterError("WSSPEC_SKILL_INSTALL_CONFLICT", "安装目标已存在且不是 WSSpecKit Driver，拒绝覆盖。");
}

const defaultDependencies: DriverSkillInstallerDependencies = {
  mkdir: async (target) => { await mkdir(target, { recursive: true }); },
  writeSkill: writeFileAtomic,
};

export function createDriverSkillInstaller(overrides: Partial<DriverSkillInstallerDependencies> = {}): (input: InstallDriverSkillInput) => Promise<InstallDriverSkillResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (input) => {
    const target = targetFor(input);
    await assertOwned(target, input.agent);
    if (input.dryRun === true) return { agent: input.agent, target, dryRun: true };
    await dependencies.mkdir(target);
    await dependencies.writeSkill(path.join(target, "SKILL.md"), skill(input.agent));
    return { agent: input.agent, target, dryRun: false };
  };
}

export const installDriverSkill = createDriverSkillInstaller();
