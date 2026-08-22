import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { sha256 } from "../../domain/digests.js";
import { createWriteFileAtomic } from "../../storage/files.js";
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
  writeSkill(target: string, content: string, beforeRename: () => Promise<void>): Promise<void>;
}

type DriverVersion = 1 | 2 | 3 | 4;

const currentDriverVersion = 4 as const;
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
    4: ["sha256:417eb92d90b1fcd9f3ea519a80fd7d3b9151d211c90371ff17e2edbb361817aa"],
  },
  claude: {
    1: [
      "sha256:3a592093e530e6e65c46d3d0cbde567fc4674135b250b0bd807e44dcb8ff8fb7",
      "sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1",
    ],
    2: ["sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1"],
    3: ["sha256:100a50a8ca4da95b9513aec29cdd70703cccd6bdb89209d1d18850f63ea944cb"],
    4: ["sha256:4bc3ec83cec6e94858e91d9530de8cd5cb73808e4afaed40696f0acd0238f1a3"],
  },
  cursor: {
    1: [
      "sha256:d74438d605600c54633d2262a9558163a3f0d3a5c664983e4a20d4f84708b392",
      "sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93",
    ],
    2: ["sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93"],
    3: ["sha256:5d16ec26c199a1c552b9ba81d346f87fc26ff508c9204c68501ba01ace39ea98"],
    4: ["sha256:37dac4a4dfb61cc430cd50fcfd2b57988aa44caf0edbe87e5f5c97c36b153f1e"],
  },
  generic: {
    1: [
      "sha256:a2aeea6a8e14df5fb5477d5ec37eee0a7666f10976e80ac92a8087d1484b94c5",
      "sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25",
    ],
    2: ["sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25"],
    3: ["sha256:68f5b5a5c650648987fa230f339e162792a431da53d4b4ca202aff78fcb0cff1"],
    4: ["sha256:c850774fd9c8338c31c6815a83fe526408b76f9473a3482d99bcee42342e3db6"],
  },
};

function contract(agent: DriverAgent): Record<string, unknown> {
  const actionCases = {
    execute: {
      next: "submit",
      capture: {
        workPackage: "result.workPackage",
        stepId: "result.workPackage.stepId",
        attemptId: "result.workPackage.attemptId",
        leaseToken: "result.workPackage.lease.token",
      },
    },
    await_approval: { next: "await_approval" },
    blocked: { next: "blocked" },
    completed: { next: "completed" },
  };
  return {
    kind: "wsspeckit-driver-contract",
    version: 1,
    workflowSelection: {
      feature: "builtin://workflows/feature-delivery",
      documentation: "builtin://workflows/documentation-delivery",
    },
    entrypoints: { new: "start", recovery: "inspect" },
    operations: {
      start: {
        argv: ["wspec", "start", "--prompt", "${prompt}", "--workflow", "${workflowRef}", "--profile", "${profile}", "--provider", agent],
        capture: { workItemId: "result.workItemId", workflowRef: "result.workflowRef" },
        next: "inspect",
      },
      inspect: {
        argv: ["wspec", "inspect", "${workItemId}"],
        capture: { workflowRef: "result.workflowRef" },
        next: "acquire",
      },
      acquire: {
        argv: ["wspec", "acquire", "${workItemId}", "--actor", "${actor}"],
        branch: {
          field: "result.action",
          cases: actionCases,
        },
      },
      submit: {
        argv: [
          "wspec", "submit", "${workItemId}",
          "--step", "${stepId}",
          "--attempt", "${attemptId}",
          "--lease", "${leaseToken}",
          "--result", "${resultPath}",
          "--actor", "${actor}",
        ],
        branch: { field: "result.action", cases: actionCases },
      },
    },
    terminals: {
      await_approval: { stop: true },
      blocked: { stop: true },
      completed: { stop: true },
    },
  };
}

function body(agent: DriverAgent): string {
  return [
    "# WSSpecKit Driver",
    "",
    "## Workflow 决策",
    "",
    "仅当需求明确为纯文档或无代码变更时选择 `builtin://workflows/documentation-delivery`；其余默认选择 `builtin://workflows/feature-delivery`。用户可以在创建前覆盖选择，但创建时必须传递明确的 `workflowRef`；Work Item 创建后不得自动切换 Workflow。",
    "",
    "## 新任务与恢复",
    "",
    `新任务执行 \`wspec start --prompt "<用户需求>" --workflow "<workflowRef>" --profile "<profile>" --provider "${agent}"\`。从 JSON 输出读取 \`result.workItemId\` 和 \`result.workflowRef\`；后续所有命令都使用这个 \`workItemId\`，并确认 \`workflowRef\` 未变化。`,
    "",
    "已有任务或 Host 重启后的恢复固定执行 inspect -> acquire：先运行 `wspec inspect \"<workItemId>\"`，从 `result.workflowRef` 确认原 Workflow，再运行 `wspec acquire \"<workItemId>\" --actor \"<actor>\"`。不要重新 start，也不要按项目当前默认值替换原 `workflowRef`。",
    "",
    "## acquire / submit 循环",
    "",
    "每次 acquire 都读取 `result.action` 并按下列分支处理：",
    "",
    "- `execute`：读取 `result.workPackage.stepId`、`result.workPackage.attemptId` 和 `result.workPackage.lease.token`。只按 Work Package 中的 Artifact 引用读取输入，加载绑定 Skill，由当前 Agent Host 原生执行，并把符合 SubmitResult Schema 的 JSON 写到 `<resultPath>`。随后执行 `wspec submit \"<workItemId>\" --step \"<stepId>\" --attempt \"<attemptId>\" --lease \"<leaseToken>\" --result \"<resultPath>\" --actor \"<actor>\"`。submit 也返回 `result.action`：若为 `execute`，它已经携带并 claim 新 Work Package，必须直接处理后继续 submit，不得再次 acquire；其余分支按下文停止。不得复用旧 attemptId 或 leaseToken。",
    "- `await_approval`：读取并向用户展示 `result.approval`，停止自动执行；不得代替用户批准。获得人工决定后由审批入口处理；若 Host 会话已中断，再从 inspect / acquire 恢复。",
    "- `blocked`：读取并展示 `result.problems`，停止循环；只有问题被外部解决后才从 inspect / acquire 恢复。",
    "- `completed`：读取 `result.summary`，报告完成并停止，不再 acquire 或 submit。",
    "",
    "以下 fenced JSON 是 Host 和自动验收共同消费的命令/状态机合同；`${...}` 变量必须来自用户选择、Host 身份或前一条命令声明的 capture，不能自行猜测：",
    "",
    "```json",
    JSON.stringify(contract(agent), null, 2),
    "```",
    "",
    "面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。",
    "",
    "Driver 不得调用模型 API，不得缓存或管理对话、Token、记忆或隐藏推理，不得把 Artifact 正文放入协议 JSON。Artifact 只通过协议中的引用读取，模型上下文由当前 Agent Host 自主管理。",
    "",
    "安装只写入本 Skill 文件，不会启动后台 Runner。Driver 使用 WSSpecKit Application Protocol 驱动当前 Agent，不冒充 Codex、Claude、Cursor 或其他真实 Agent Host。",
    "",
    `手动调用示例：\`wspec start --provider ${agent} --prompt "更新 README" --workflow builtin://workflows/documentation-delivery --profile quick\`。`,
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

function conflict(message = "安装目标已存在且不是 WSSpecKit Driver，拒绝覆盖。"): never {
  throw new CliAdapterError("WSSPEC_SKILL_INSTALL_CONFLICT", message);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalDirectory(directory: string): Promise<string> {
  let canonical: string;
  try { canonical = await realpath(path.resolve(directory)); }
  catch { return conflict("Driver 安装 authority 不存在或不可访问。"); }
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory()) return conflict("Driver 安装 authority 必须是普通目录。");
  return canonical;
}

async function targetFor(input: InstallDriverSkillInput): Promise<string> {
  if (input.agent !== "generic" && input.target !== undefined) throw new CliAdapterError("WSSPEC_ARGUMENT_INVALID", "只有 Generic Driver 支持 --target。");
  const home = await canonicalDirectory(input.home);
  const supplied = genericDriverTarget(input.target);
  const rawHome = path.resolve(input.home);
  const genericTarget = supplied === undefined ? undefined : path.resolve(supplied);
  const normalizedGenericTarget = genericTarget !== undefined && isWithin(rawHome, genericTarget)
    ? path.join(home, path.relative(rawHome, genericTarget))
    : genericTarget;
  const target = input.agent === "codex" ? codexDriverTarget(home)
    : input.agent === "claude" ? claudeDriverTarget(home)
      : input.agent === "cursor" ? cursorDriverTarget(home)
        : normalizedGenericTarget;
  if (target === undefined || target === "") throw new CliAdapterError("WSSPEC_ARGUMENT_REQUIRED", "Generic Driver 必须通过 --target 指定安装目录。");
  return path.resolve(target);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDirectory(info: BigIntStats): void {
  if (!info.isDirectory()) conflict("Driver 安装路径的每一段都必须是普通目录，禁止 symlink 或其他文件类型。");
}

async function nearestExistingDirectory(target: string): Promise<string> {
  let current = target;
  while (true) {
    try {
      const info = await lstat(current, { bigint: true });
      assertDirectory(info);
      return current;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return conflict("Driver 安装目标没有可验证的 authority。");
      current = parent;
    }
  }
}

async function assertCanonicalDirectoryChain(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  assertDirectory(await lstat(current, { bigint: true }));
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current, { bigint: true });
    assertDirectory(info);
    if (await realpath(current) !== current) conflict("Driver 安装路径必须是 canonical，禁止任何祖先 symlink。");
  }
}

async function prepareTarget(
  target: string,
  create: boolean,
  createDirectory: (directory: string) => Promise<void>,
): Promise<BigIntStats | undefined> {
  const authority = await nearestExistingDirectory(target);
  await assertCanonicalDirectoryChain(authority);
  let current = authority;
  for (const segment of path.relative(authority, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info: BigIntStats;
    try {
      info = await lstat(current, { bigint: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return undefined;
      try { await createDirectory(current); }
      catch (mkdirError) { if (!isMissing(mkdirError) && (mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      info = await lstat(current, { bigint: true });
    }
    assertDirectory(info);
    if (await realpath(current) !== current) conflict("Driver 安装路径必须是 canonical，禁止任何祖先 symlink。");
  }
  return lstat(target, { bigint: true });
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
    && (version === 1 || version === 2 || version === 3 || version === 4)
    && typeof digest === "string"
    && digest === sha256(match[2]!)
    && canonicalDriverDigests[agent][version].includes(digest);
}

async function skillIdentity(filename: string): Promise<BigIntStats | undefined> {
  let info: BigIntStats;
  try { info = await lstat(filename, { bigint: true }); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!info.isFile() || info.nlink !== 1n) conflict("Driver Skill 必须是单链接普通文件，禁止 symlink、hardlink 或其他文件类型。");
  return info;
}

async function assertOwned(target: string, agent: DriverAgent): Promise<BigIntStats | undefined> {
  const filename = path.join(target, "SKILL.md");
  const before = await skillIdentity(filename);
  if (before === undefined) return undefined;
  let existing: string;
  try { existing = await readFile(filename, "utf8"); }
  catch { return conflict(); }
  const after = await skillIdentity(filename);
  if (after === undefined || !sameIdentity(before, after) || !ownedSkill(existing, agent)) return conflict();
  return after;
}

const defaultDependencies: DriverSkillInstallerDependencies = {
  mkdir: async (target) => { await mkdir(target); },
  writeSkill: async (target, content, beforeRename) => {
    await createWriteFileAtomic({ beforeRename: async () => beforeRename() })(target, content);
  },
};

async function revalidateDestination(target: string, parent: BigIntStats, expectedSkill: BigIntStats | undefined): Promise<void> {
  const currentParent = await lstat(target, { bigint: true });
  assertDirectory(currentParent);
  if (!sameIdentity(parent, currentParent) || await realpath(target) !== target) {
    conflict("Driver 安装父目录在原子替换前发生变化。");
  }
  const currentSkill = await skillIdentity(path.join(target, "SKILL.md"));
  if ((expectedSkill === undefined) !== (currentSkill === undefined)
    || (expectedSkill !== undefined && currentSkill !== undefined && !sameIdentity(expectedSkill, currentSkill))) {
    conflict("Driver Skill 在原子替换前发生变化。");
  }
}

export function createDriverSkillInstaller(overrides: Partial<DriverSkillInstallerDependencies> = {}): (input: InstallDriverSkillInput) => Promise<InstallDriverSkillResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (input) => {
    const target = await targetFor(input);
    const existingParent = await prepareTarget(target, false, dependencies.mkdir);
    const expectedSkill = existingParent === undefined ? undefined : await assertOwned(target, input.agent);
    if (existingParent !== undefined && expectedSkill === undefined) conflict();
    if (input.dryRun === true) return { agent: input.agent, target, dryRun: true };
    const parent = await prepareTarget(target, true, dependencies.mkdir);
    if (parent === undefined) throw new Error("Driver 安装父目录创建失败。");
    const currentSkill = await assertOwned(target, input.agent);
    if ((expectedSkill === undefined) !== (currentSkill === undefined)
      || (expectedSkill !== undefined && currentSkill !== undefined && !sameIdentity(expectedSkill, currentSkill))) {
      conflict("Driver Skill 在安装准备期间发生变化。");
    }
    await dependencies.writeSkill(
      path.join(target, "SKILL.md"),
      skill(input.agent),
      async () => revalidateDestination(target, parent, currentSkill),
    );
    return { agent: input.agent, target, dryRun: false };
  };
}

export const installDriverSkill = createDriverSkillInstaller();
