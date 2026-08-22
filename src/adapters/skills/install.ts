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

type DriverVersion = 1 | 2 | 3;

const currentDriverVersion = 3 as const;
const driverDescription = "使用 WSSpecKit 驱动软件交付 Workflow；新任务、已有任务或用户明确要求时调用。";
const driverFrontMatterKeys = ["description", "name", "wsspeckit-driver-content-digest", "wsspeckit-driver-version"] as const;

// v1 的中文指导曾在未提升版本号时更新，因此两个历史摘要都必须显式登记。
const canonicalDriverDigests: Record<DriverAgent, Record<DriverVersion, readonly string[]>> = {
  codex: {
    1: [
      "sha256:8804ee37451e7740a488c14291d048b57a21bdd7e2efb1b1beb70a46940030e3",
      "sha256:69b6ad68c123a711095377ffdf64d21225f4bafaab3a414497ffef6c5391773e",
    ],
    2: ["sha256:69b6ad68c123a711095377ffdf64d21225f4bafaab3a414497ffef6c5391773e"],
    3: ["sha256:451f3853fbc01766264e07c6b3f376aa64acfa0d7f2c6662916f876496558a8f"],
  },
  claude: {
    1: [
      "sha256:3a592093e530e6e65c46d3d0cbde567fc4674135b250b0bd807e44dcb8ff8fb7",
      "sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1",
    ],
    2: ["sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1"],
    3: ["sha256:100a50a8ca4da95b9513aec29cdd70703cccd6bdb89209d1d18850f63ea944cb"],
  },
  cursor: {
    1: [
      "sha256:d74438d605600c54633d2262a9558163a3f0d3a5c664983e4a20d4f84708b392",
      "sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93",
    ],
    2: ["sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93"],
    3: ["sha256:5d16ec26c199a1c552b9ba81d346f87fc26ff508c9204c68501ba01ace39ea98"],
  },
  generic: {
    1: [
      "sha256:a2aeea6a8e14df5fb5477d5ec37eee0a7666f10976e80ac92a8087d1484b94c5",
      "sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25",
    ],
    2: ["sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25"],
    3: ["sha256:68f5b5a5c650648987fa230f339e162792a431da53d4b4ca202aff78fcb0cff1"],
  },
};

function body(agent: DriverAgent): string {
  return [
    "# WSSpecKit Driver",
    "",
    "新任务判断功能/文档 Workflow 并显式 start；已有任务 inspect -> acquire -> 读取绑定 Skill -> 当前 Agent 原生执行 -> submit -> 重复。",
    "",
    "面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。",
    "",
    "仅当需求明确为纯文档或无代码变更时选择 `builtin://workflows/documentation-delivery`；其余默认选择 `builtin://workflows/feature-delivery`。创建时必须传递明确的 `workflowRef`，允许用户覆盖；Work Item 创建后不得自动切换 Workflow。",
    "",
    "Driver 不得调用模型 API，不得缓存或管理对话、Token、记忆或隐藏推理，不得把 Artifact 正文放入协议 JSON。Artifact 只通过协议中的引用读取，模型上下文由当前 Agent Host 自主管理。",
    "",
    "安装只写入本 Skill 文件，不会启动后台 Runner。Driver 使用 WSSpecKit Application Protocol 驱动当前 Agent，不冒充 Codex、Claude、Cursor 或其他真实 Agent Host。",
    "",
    `手动调用示例：\`wspec start --provider ${agent} --prompt "更新 README" --workflow builtin://workflows/documentation-delivery\`。`,
    "",
  ].join("\n");
}

function skill(agent: DriverAgent): string {
  const content = body(agent);
  const digest = sha256(content);
  if (!canonicalDriverDigests[agent][currentDriverVersion].includes(digest)) {
    throw new Error("当前 Driver 正文未登记 canonical 摘要。");
  }
  return [
    "---",
    "name: wsspeckit-driver",
    `wsspeckit-driver-version: ${currentDriverVersion}`,
    `wsspeckit-driver-content-digest: ${digest}`,
    `description: ${driverDescription}`,
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
  const keys = Object.keys(source).sort();
  const version = source["wsspeckit-driver-version"];
  const digest = source["wsspeckit-driver-content-digest"];
  return source.name === "wsspeckit-driver"
    && source.description === driverDescription
    && keys.length === driverFrontMatterKeys.length
    && keys.every((key, index) => key === driverFrontMatterKeys[index])
    && (version === 1 || version === 2 || version === 3)
    && typeof digest === "string"
    && digest === sha256(match[2]!)
    && canonicalDriverDigests[agent][version].includes(digest);
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
