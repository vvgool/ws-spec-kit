import type { BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { sha256 } from "../../domain/digests.js";
import { CliAdapterError } from "../cli/output.js";
import { spawnJson } from "../process/spawn-json.js";
import { claudeDriverTarget } from "./claude.js";
import { codexDriverTarget } from "./codex.js";
import { cursorDriverTarget } from "./cursor.js";
import { genericDriverTarget } from "./generic.js";

export type DriverAgent = "codex" | "claude" | "cursor" | "generic";
export interface InstallDriverSkillInput { agent: DriverAgent; home: string; target?: string; dryRun?: boolean }
export interface InstallDriverSkillResult { agent: DriverAgent; target: string; dryRun: boolean }
export interface DriverSkillInstallerDependencies {
  secureInstall(request: SecureInstallRequest): Promise<void>;
}

export interface SecureInstallRequest {
  target: string;
  targetDev: string;
  targetIno: string;
  operation: "create" | "verify";
  dryRun: boolean;
  contentBase64?: string;
  expectedDigest?: string;
  expectedSize?: number;
}

type DriverVersion = 1 | 2 | 3 | 4 | 5 | 6;

const currentDriverVersion = 6 as const;
const maximumDriverBytes = 1_048_576n;
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
    5: ["sha256:2168d90a410d3d250645efb01911d09bc0f72259835fa2800819eba6838b65db"],
    6: ["sha256:dbee7635c12c75cd3548241e36e919f53afa7f6ca5f93a147d2dc674cc39bb25"],
  },
  claude: {
    1: [
      "sha256:3a592093e530e6e65c46d3d0cbde567fc4674135b250b0bd807e44dcb8ff8fb7",
      "sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1",
    ],
    2: ["sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1"],
    3: ["sha256:100a50a8ca4da95b9513aec29cdd70703cccd6bdb89209d1d18850f63ea944cb"],
    4: ["sha256:4bc3ec83cec6e94858e91d9530de8cd5cb73808e4afaed40696f0acd0238f1a3"],
    5: ["sha256:bbaf8982709f2a8a38e62fc1d4142725d9a38932385daad0bba70307295e7f62"],
    6: ["sha256:3d425ec1ad828b1c58768225bc07e5fa00468566d63997ce8b346c9ba0e50c1f"],
  },
  cursor: {
    1: [
      "sha256:d74438d605600c54633d2262a9558163a3f0d3a5c664983e4a20d4f84708b392",
      "sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93",
    ],
    2: ["sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93"],
    3: ["sha256:5d16ec26c199a1c552b9ba81d346f87fc26ff508c9204c68501ba01ace39ea98"],
    4: ["sha256:37dac4a4dfb61cc430cd50fcfd2b57988aa44caf0edbe87e5f5c97c36b153f1e"],
    5: ["sha256:cb9f9b0b7698c91a8b92443e3818cb5e875392d8f2a97666408ed38967b3d2a7"],
    6: ["sha256:fde89e7d933eea21e9ef1b9d32f3e8a2b2c5905664cc7f924ad02de4390e73bc"],
  },
  generic: {
    1: [
      "sha256:a2aeea6a8e14df5fb5477d5ec37eee0a7666f10976e80ac92a8087d1484b94c5",
      "sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25",
    ],
    2: ["sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25"],
    3: ["sha256:68f5b5a5c650648987fa230f339e162792a431da53d4b4ca202aff78fcb0cff1"],
    4: ["sha256:c850774fd9c8338c31c6815a83fe526408b76f9473a3482d99bcee42342e3db6"],
    5: ["sha256:6a5288b339b5bc2ae41f3b445863b32ad11428d5b6362ba4a97bd025cafdcca9"],
    6: ["sha256:675dbd85103232c879728b080f648b64701813a540050a1af0d622655f37cde3"],
  },
};

function contract(agent: DriverAgent): Record<string, unknown> {
  const actionCases = {
    execute: {
      next: "artifact",
      capture: {
        workPackage: "result.workPackage",
        stepId: "result.workPackage.stepId",
        attemptId: "result.workPackage.attemptId",
        leaseToken: "result.workPackage.lease.token",
        requiredOutputs: "result.workPackage.requiredOutputs",
      },
      initialize: {
        target: "artifactRefs",
        source: "result.workPackage.artifacts",
        filter: { field: "artifactType", equals: "requirement-source", requiredBy: "requiredOutputs" },
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
      artifact: {
        argv: [
          "wspec", "artifact", "create",
          "--work-item", "${workItemId}",
          "--step", "${stepId}",
          "--attempt", "${attemptId}",
          "--lease-token", "${leaseToken}",
          "--artifact-type", "${artifactType}",
          "--output", "${outputId}",
          "--content-file", "${contentFile}",
        ],
        capture: { artifactRef: "result" },
        forEach: {
          source: "requiredOutputs",
          item: "requiredOutput",
          filter: { field: "artifactType", notEquals: "requirement-source" },
          bindings: {
            artifactType: "requiredOutput.artifactType",
            outputId: "requiredOutput.outputId",
            contentFile: ".wsspec/work-items/${workItemId}/drafts/${outputId}.md",
          },
          collect: { target: "artifactRefs", value: "result" },
        },
        next: "submit",
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
        resultBindings: { artifacts: "artifactRefs" },
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
    "- `execute`：读取 `result.workPackage.stepId`、`result.workPackage.attemptId`、`result.workPackage.lease.token` 和完整 `requiredOutputs`。先把 Work Package 中系统提供的 `requirement-source` 引用放入 `artifactRefs`；再按 `requiredOutputs` 顺序逐项处理其余输出。每项正文写入 Work Item 自有的 `.wsspec/work-items/<workItemId>/drafts/<outputId>.md`，执行 `wspec artifact create --work-item \"<workItemId>\" --step \"<stepId>\" --attempt \"<attemptId>\" --lease-token \"<leaseToken>\" --artifact-type \"<artifactType>\" --output \"<outputId>\" --content-file \".wsspec/work-items/<workItemId>/drafts/<outputId>.md\"`，并把每次 JSON stdout 的 `result` 追加到 `artifactRefs`。所有必需输出完成后才生成 SubmitResult；submit JSON 的 `artifacts` 只携带累积的 ArtifactRef，正文、`contentFile`、绝对路径和 Lease token 都不得写入 `<resultPath>`。随后执行 `wspec submit \"<workItemId>\" --step \"<stepId>\" --attempt \"<attemptId>\" --lease \"<leaseToken>\" --result \"<resultPath>\" --actor \"<actor>\"`。submit 也返回 `result.action`：若为 `execute`，它已经携带并 claim 新 Work Package，必须从 artifact 循环处理，不得再次 acquire；其余分支按下文停止。不得复用旧 attemptId 或 leaseToken。",
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

async function assertCanonicalDirectoryChain(directory: string): Promise<BigIntStats> {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  let currentInfo = await lstat(current, { bigint: true });
  assertDirectory(currentInfo);
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current, { bigint: true });
    assertDirectory(info);
    if (await realpath(current) !== current) conflict("Driver 安装路径必须是 canonical，禁止任何祖先 symlink。");
    currentInfo = info;
  }
  return currentInfo;
}

function ownedSkillVersion(content: string, agent: DriverAgent): DriverVersion | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/u.exec(content);
  if (match === null) return undefined;
  let frontMatter: unknown;
  try { frontMatter = parse(match[1]!); } catch { return undefined; }
  if (frontMatter === null || typeof frontMatter !== "object" || Array.isArray(frontMatter)) return undefined;
  const source = frontMatter as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const version = source["wsspeckit-driver-version"];
  const digest = source["wsspeckit-driver-content-digest"];
  const owned = source.name === "wsspeckit-driver"
    && source.description === driverDescription
    && keys.length === driverFrontMatterKeys.length
    && keys.every((key, index) => key === driverFrontMatterKeys[index])
    && (version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6)
    && typeof digest === "string"
    && digest === sha256(match[2]!)
    && canonicalDriverDigests[agent][version].includes(digest);
  return owned ? version : undefined;
}

async function skillIdentity(filename: string): Promise<BigIntStats | undefined> {
  let info: BigIntStats;
  try { info = await lstat(filename, { bigint: true }); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!info.isFile() || info.nlink !== 1n || info.size > maximumDriverBytes) conflict("Driver Skill 必须是有界单链接普通文件，禁止 symlink、hardlink 或其他文件类型。");
  return info;
}

interface OwnedSkill {
  content: string;
  info: BigIntStats;
  version: DriverVersion;
}

async function assertOwned(target: string, agent: DriverAgent): Promise<OwnedSkill | undefined> {
  const filename = path.join(target, "SKILL.md");
  const before = await skillIdentity(filename);
  if (before === undefined) return undefined;
  let existing: string;
  try { existing = await readFile(filename, "utf8"); }
  catch { return conflict(); }
  const after = await skillIdentity(filename);
  const version = ownedSkillVersion(existing, agent);
  if (after === undefined || !sameIdentity(before, after) || version === undefined) return conflict();
  return { content: existing, info: after, version };
}

const secureInstallScript = String.raw`
import base64, hashlib, json, os, stat, sys

def result(ok, code=None):
    value = {"ok": ok}
    if code is not None:
        value["code"] = code
    sys.stdout.write(json.dumps(value, separators=(",", ":")))

def fail():
    raise RuntimeError("conflict")

def request_value(source, key, kind):
    value = source.get(key)
    if not isinstance(value, kind):
        fail()
    return value

def open_target(target, expected_dev, expected_ino):
    if not target.startswith("/") or os.path.normpath(target) != target or target == "/" or "\x00" in target:
        fail()
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for segment in [part for part in target.split("/") if part]:
            before = os.stat(segment, dir_fd=current, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                fail()
            child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            after = os.fstat(child)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                os.close(child)
                fail()
            os.close(current)
            current = child
        final = os.fstat(current)
        if str(final.st_dev) != expected_dev or str(final.st_ino) != expected_ino:
            fail()
        return current
    except BaseException:
        os.close(current)
        raise

def existing_file(directory):
    try:
        before = os.stat("SKILL.md", dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 1048576:
        fail()
    handle = os.open("SKILL.md", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    after = os.fstat(handle)
    if (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size):
        os.close(handle)
        fail()
    return handle

def verify(directory, expected_digest, expected_size):
    handle = existing_file(directory)
    if handle is None:
        fail()
    try:
        data = bytearray()
        while True:
            chunk = os.read(handle, 65536)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 1048576:
                fail()
        if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected_digest:
            fail()
    finally:
        os.close(handle)

def create(directory, content, dry_run):
    existing = existing_file(directory)
    if existing is not None:
        os.close(existing)
        fail()
    if dry_run:
        return False
    handle = None
    try:
        handle = os.open("SKILL.md", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        offset = 0
        while offset < len(content):
            written = os.write(handle, content[offset:])
            if written < 1:
                fail()
            offset += written
        os.fsync(handle)
        os.close(handle)
        handle = None
        os.fsync(directory)
        return True
    except BaseException:
        if handle is not None:
            os.close(handle)
        raise

try:
    source = json.load(sys.stdin)
    if not isinstance(source, dict) or set(source) - {"target", "targetDev", "targetIno", "operation", "dryRun", "contentBase64", "expectedDigest", "expectedSize"}:
        fail()
    target = request_value(source, "target", str)
    target_dev = request_value(source, "targetDev", str)
    target_ino = request_value(source, "targetIno", str)
    operation = request_value(source, "operation", str)
    dry_run = request_value(source, "dryRun", bool)
    directory = open_target(target, target_dev, target_ino)
    created = False
    try:
        if operation == "create":
            encoded = request_value(source, "contentBase64", str)
            content = base64.b64decode(encoded, validate=True)
            if len(content) > 1048576:
                fail()
            created = create(directory, content, dry_run)
            if created:
                verify(directory, hashlib.sha256(content).hexdigest(), len(content))
        elif operation == "verify":
            digest = request_value(source, "expectedDigest", str)
            size = request_value(source, "expectedSize", int)
            if dry_run not in (True, False) or len(digest) != 64 or size < 0 or size > 1048576:
                fail()
            verify(directory, digest, size)
        else:
            fail()
        confirmed = open_target(target, target_dev, target_ino)
        os.close(confirmed)
    except BaseException:
        raise
    finally:
        os.close(directory)
    result(True)
except BaseException:
    result(False, "conflict")
`;

function helperSucceeded(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && (value as Record<string, unknown>).ok === true;
}

export async function secureInstallDriverFile(request: SecureInstallRequest): Promise<void> {
  if (process.platform !== "darwin") conflict("Driver 安全安装当前仅支持 macOS。");
  try {
    const helper = await realpath("/usr/bin/python3");
    const helperInfo = await lstat(helper);
    if (!helperInfo.isFile() || helperInfo.uid !== 0 || (helperInfo.mode & 0o022) !== 0) {
      conflict("Driver 安全安装 helper 不可信。");
    }
    const result = await spawnJson({
      executable: helper,
      argv: ["-I", "-S", "-c", secureInstallScript],
      input: request,
      timeoutMs: 5_000,
      maxStdoutBytes: 256,
    });
    if (!helperSucceeded(result.value)) conflict("Driver 安全安装未通过文件系统边界校验。");
  } catch (error) {
    if (error instanceof CliAdapterError) throw error;
    conflict("Driver 安全安装 helper 不可用或执行失败。");
  }
}

const defaultDependencies: DriverSkillInstallerDependencies = { secureInstall: secureInstallDriverFile };

export function createDriverSkillInstaller(overrides: Partial<DriverSkillInstallerDependencies> = {}): (input: InstallDriverSkillInput) => Promise<InstallDriverSkillResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (input) => {
    const target = await targetFor(input);
    let targetInfo: BigIntStats;
    try { targetInfo = await assertCanonicalDirectoryChain(target); }
    catch (error) {
      if (isMissing(error)) conflict("Driver 安装目标目录必须预先创建。");
      throw error;
    }
    const existing = await assertOwned(target, input.agent);
    if (existing !== undefined && existing.version !== currentDriverVersion) {
      conflict("旧版 Driver 不进行原地升级；请移除旧文件后重新安装。");
    }
    const content = skill(input.agent);
    const request: SecureInstallRequest = existing === undefined
      ? {
        target,
        targetDev: targetInfo.dev.toString(),
        targetIno: targetInfo.ino.toString(),
        operation: "create",
        dryRun: input.dryRun === true,
        contentBase64: Buffer.from(content).toString("base64"),
      }
      : {
        target,
        targetDev: targetInfo.dev.toString(),
        targetIno: targetInfo.ino.toString(),
        operation: "verify",
        dryRun: input.dryRun === true,
        expectedDigest: sha256(existing.content).slice("sha256:".length),
        expectedSize: Buffer.byteLength(existing.content),
      };
    await dependencies.secureInstall(request);
    return { agent: input.agent, target, dryRun: input.dryRun === true };
  };
}

export const installDriverSkill = createDriverSkillInstaller();
