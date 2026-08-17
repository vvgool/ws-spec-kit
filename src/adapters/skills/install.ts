import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliAdapterError } from "../cli/output.js";
import { claudeDriverTarget } from "./claude.js";
import { codexDriverTarget } from "./codex.js";
import { cursorDriverTarget } from "./cursor.js";
import { genericDriverTarget } from "./generic.js";

export type DriverAgent = "codex" | "claude" | "cursor" | "generic";
export interface InstallDriverSkillInput { agent: DriverAgent; home: string; target?: string; dryRun?: boolean }
export interface InstallDriverSkillResult { agent: DriverAgent; target: string; dryRun: boolean }

const skill = [
  "---",
  "name: wsspeckit-driver",
  "description: 使用 WSSpecKit 驱动软件交付 Workflow；新任务、已有任务或用户明确要求时调用。",
  "---",
  "",
  "# WSSpecKit Driver",
  "",
  "新任务判断功能/文档 Workflow 并显式 start / 已有任务 inspect -> acquire -> 读取绑定 Skill -> 当前 Agent 执行 -> submit -> 重复",
  "",
  "仅当需求明确为纯文档或无代码变更时，建议 `documentation-delivery`；其余默认 `feature-delivery`。创建时必须传递 `workflowRef`，允许用户覆盖，创建后不得自动切换。",
  "",
  "手动调用示例：`wspec start --prompt \"更新 README\" --workflow builtin://workflows/documentation-delivery`。",
  "",
].join("\n");

async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function targetFor(input: InstallDriverSkillInput): string {
  const target = input.agent === "codex" ? codexDriverTarget(input.home)
    : input.agent === "claude" ? claudeDriverTarget(input.home)
      : input.agent === "cursor" ? cursorDriverTarget(input.home)
        : genericDriverTarget(input.target);
  if (target === undefined || target === "") throw new CliAdapterError("WSSPEC_ARGUMENT_REQUIRED", "Generic Driver 必须通过 --target 指定安装目录。");
  return path.resolve(target);
}

async function assertOwned(target: string): Promise<void> {
  if (!(await exists(target))) return;
  let existing: string;
  try { existing = await readFile(path.join(target, "SKILL.md"), "utf8"); }
  catch { throw new CliAdapterError("WSSPEC_SKILL_INSTALL_CONFLICT", "安装目标已存在且不是 WSSpecKit Driver，拒绝覆盖。"); }
  if (!existing.includes("name: wsspeckit-driver")) throw new CliAdapterError("WSSPEC_SKILL_INSTALL_CONFLICT", "安装目标已存在且不是 WSSpecKit Driver，拒绝覆盖。");
}

export async function installDriverSkill(input: InstallDriverSkillInput): Promise<InstallDriverSkillResult> {
  const target = targetFor(input);
  await assertOwned(target);
  if (input.dryRun === true) return { agent: input.agent, target, dryRun: true };
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.wsspeckit-driver-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(staging);
  await writeFile(path.join(staging, "SKILL.md"), skill, "utf8");
  const backup = `${target}.previous-${crypto.randomUUID()}`;
  const hadTarget = await exists(target);
  try {
    if (hadTarget) await rename(target, backup);
    await rename(staging, target);
    if (hadTarget) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget && await exists(backup) && !(await exists(target))) await rename(backup, target);
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { agent: input.agent, target, dryRun: false };
}
