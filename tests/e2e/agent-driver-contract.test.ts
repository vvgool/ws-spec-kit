import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, cp, link, mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import type { SubmitResult } from "../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../src/protocol/work-package.js";
import { readControlPlane } from "../../src/storage/control-plane.js";
import { git } from "../integration/helpers/git.js";

type Client = "codex" | "claude" | "cursor" | "generic";

interface TaskFixture {
  prompt: string;
  artifactBodyMarker: string;
  workflowRef: "builtin://workflows/feature-delivery" | "builtin://workflows/documentation-delivery";
}

interface DriverFixture {
  client: Client;
  actor: string;
  feature: TaskFixture;
  documentation: TaskFixture;
}

interface CliRun {
  code: number | null;
  pid: number;
  stdout: string;
  stderr: string;
  value: { ok: boolean; result?: Record<string, unknown>; error?: { code?: string; message?: string } };
}

type DriverState = "start" | "inspect" | "acquire" | "artifact" | "submit" | "decide";
type DriverOperationName = DriverState;
type DriverTerminal = "await_approval" | "blocked" | "completed";

interface DriverCollectionRule {
  target: "artifactRefs";
  source: string;
  filter: { field: "artifactType"; equals: "requirement-source"; requiredBy: "requiredOutputs" };
}

interface DriverForEachRule {
  source: "requiredOutputs";
  item: "requiredOutput";
  filter: { field: "artifactType"; notEquals: "requirement-source" };
  bindings: {
    artifactType: "requiredOutput.artifactType";
    outputId: "requiredOutput.outputId";
    contentFile: ".wsspec/work-items/${workItemId}/drafts/${outputId}.md";
  };
  collect: { target: "artifactRefs"; value: "result" };
}

interface DriverOperation {
  argv: string[];
  capture?: Record<string, string>;
  initialize?: DriverCollectionRule;
  forEach?: DriverForEachRule;
  resultBindings?: { artifacts: "artifactRefs" };
  next?: DriverState;
  branch?: {
    field: string;
    cases: Record<"execute" | DriverTerminal, {
      next: DriverState | DriverTerminal;
      capture?: Record<string, string>;
      initialize?: DriverCollectionRule;
      humanGate?: { required: true; approval: "result.approval" };
    }>;
  };
}

interface DriverContract {
  kind: "wsspeckit-driver-contract";
  version: 1;
  workflowSelection: Record<"feature" | "documentation", TaskFixture["workflowRef"]>;
  entrypoints: { new: "start"; recovery: "inspect" };
  operations: Record<DriverOperationName, DriverOperation>;
  terminals: Record<DriverTerminal, { stop: true }>;
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "agent-homes");
const clients = ["codex", "claude", "cursor", "generic"] as const;
const noConversationMarker = "DO_NOT_CACHE_AGENT_CONVERSATION_7F4F8C";
const noSecretMarker = "sk-task2-driver-secret-not-for-storage";

function expectedTarget(client: Client, home: string): string {
  if (client === "codex") return path.join(home, ".agents", "skills", "wsspeckit-driver");
  if (client === "claude") return path.join(home, ".claude", "skills", "wsspeckit-driver");
  if (client === "cursor") return path.join(home, ".cursor", "skills", "wsspeckit-driver");
  return path.join(home, "generic-driver");
}

async function exists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runCli(cwd: string, home: string, args: string[], environment: Record<string, string> = {}): Promise<CliRun> {
  const child = spawn(process.execPath, [
    "--import",
    path.join(repositoryRoot, "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(repositoryRoot, "src", "cli", "main.ts"),
    ...args,
  ], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      WSPEC_FIXTURE_CONVERSATION: noConversationMarker,
      OPENAI_API_KEY: noSecretMarker,
      ANTHROPIC_API_KEY: noSecretMarker,
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  assert.ok(pid !== undefined, `未能启动 CLI：${args.join(" ")}`);
  const result = await new Promise<Omit<CliRun, "pid" | "value">>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  let value: CliRun["value"];
  try {
    value = JSON.parse(result.stdout) as CliRun["value"];
  } catch {
    throw new Error(`CLI 未返回 JSON：${args.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { ...result, pid, value };
}

function assertPassed(run: CliRun, label: string): asserts run is CliRun & { value: { ok: true; result: Record<string, unknown> } } {
  assert.equal(run.code, 0, `${label}\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  assert.equal(run.value.ok, true, label);
  assert.ok(run.value.result !== undefined && run.value.result !== null && !Array.isArray(run.value.result), label);
}

function escapePattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u");
}

function requiredString(value: unknown, label: string): string {
  assert.equal(typeof value, "string", label);
  return value as string;
}

function requiredWorkPackage(value: unknown, label: string): WorkPackage {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: Work Package 必须是对象`);
  const candidate = value as Partial<WorkPackage>;
  assert.equal(candidate.version, 1, `${label}: Work Package version`);
  assert.equal(typeof candidate.workItemId, "string", `${label}: workItemId`);
  assert.equal(typeof candidate.stepId, "string", `${label}: stepId`);
  assert.equal(typeof candidate.attemptId, "string", `${label}: attemptId`);
  assert.equal(typeof candidate.lease?.token, "string", `${label}: lease token`);
  assert.ok(Array.isArray(candidate.artifacts), `${label}: artifacts`);
  assert.ok(Array.isArray(candidate.requiredOutputs), `${label}: requiredOutputs`);
  return candidate as WorkPackage;
}

async function fixtureFor(client: Client): Promise<DriverFixture> {
  return JSON.parse(await readFile(path.join(fixtureRoot, client, "driver-fixture.json"), "utf8")) as DriverFixture;
}

async function temporaryHome(client: Client): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), `wspec-task2-${client}-home-`));
  await cp(path.join(fixtureRoot, client), home, { recursive: true });
  return realpath(home);
}

async function allFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

function splitSkill(content: string): { frontMatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/u.exec(content);
  assert.ok(match, "Driver Skill 必须使用 YAML frontmatter");
  return { frontMatter: parse(match[1]!) as Record<string, unknown>, body: match[2]! };
}

function driverContract(body: string): DriverContract {
  const candidates = [...body.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/gu)]
    .map((match) => JSON.parse(match[1]!) as unknown)
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value));
  const contract = candidates.find((value) => value.kind === "wsspeckit-driver-contract") as DriverContract | undefined;
  assert.ok(contract, "Driver 正文必须包含 fenced JSON 状态机合同");
  assert.equal(contract.version, 1);
  assert.deepEqual(contract.entrypoints, { new: "start", recovery: "inspect" });
  assert.deepEqual(Object.keys(contract.operations).sort(), ["acquire", "artifact", "decide", "inspect", "start", "submit"]);
  assert.deepEqual(Object.keys(contract.terminals).sort(), ["await_approval", "blocked", "completed"]);
  return contract;
}

function valueAt(source: unknown, pointer: string): unknown {
  return pointer.split(".").reduce<unknown>((current, segment) => {
    assert.ok(current !== null && typeof current === "object" && !Array.isArray(current), `无法从 ${pointer} 读取 ${segment}`);
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\$\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
    const value = values[name];
    assert.equal(typeof value, "string", `命令模板变量 ${name} 必须已从 Driver 输出合同捕获`);
    return value as string;
  });
}

function renderArgv(operation: DriverOperation, values: Record<string, unknown>): string[] {
  return operation.argv.map((argument) => renderTemplate(argument, values));
}

function capture(fields: Record<string, string> | undefined, output: CliRun["value"], values: Record<string, unknown>): void {
  for (const [name, pointer] of Object.entries(fields ?? {})) values[name] = valueAt(output, pointer);
}

function initialize(rule: DriverCollectionRule | undefined, output: CliRun["value"], values: Record<string, unknown>): void {
  if (rule === undefined) return;
  const source = valueAt(output, rule.source);
  assert.ok(Array.isArray(source), `${rule.source} 必须是数组`);
  const required = values[rule.filter.requiredBy];
  assert.ok(Array.isArray(required), `${rule.filter.requiredBy} 必须已由 execute capture`);
  const requiredTypes = new Set(required.flatMap((candidate) => candidate !== null
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && typeof (candidate as Record<string, unknown>)[rule.filter.field] === "string"
    ? [(candidate as Record<string, unknown>)[rule.filter.field] as string]
    : []));
  values[rule.target] = source.filter((candidate) => candidate !== null
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>)[rule.filter.field] === rule.filter.equals
    && requiredTypes.has(rule.filter.equals));
}

test("四类 Driver 通过 --client 安装到各自官方目录，且 dry-run、幂等和冲突均 fail closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-task2-install-root-"));
  for (const client of clients) {
    await t.test(client, async () => {
      const home = await temporaryHome(client);
      const target = expectedTarget(client, home);
      const installArgs = ["agent", "install", "--client", client, ...(client === "generic" ? ["--target", target] : [])];

      const missingParent = await runCli(root, home, installArgs);
      assert.equal(missingParent.code, 1, `${client}: 缺失目标目录必须拒绝`);
      assert.equal(missingParent.value.error?.code, "WSSPEC_SKILL_INSTALL_CONFLICT", `${client}: 缺失目标目录错误码`);
      assert.match(String(missingParent.value.error?.message), /目标目录必须预先创建/u, `${client}: 中文预创建提示`);
      await mkdir(target, { recursive: true });

      const dryRun = await runCli(root, home, [...installArgs, "--dry-run"]);
      assertPassed(dryRun, `${client}: dry-run`);
      assert.equal(dryRun.value.result.target, target, `${client}: target`);
      assert.equal(await exists(path.join(target, "SKILL.md")), false, `${client}: dry-run 不得写入`);

      const installed = await runCli(root, home, installArgs);
      assertPassed(installed, `${client}: install`);
      const skillPath = path.join(target, "SKILL.md");
      const first = await readFile(skillPath, "utf8");
      const { frontMatter, body } = splitSkill(first);
      const contract = driverContract(body);
      assert.match(String(frontMatter.description), /[\u3400-\u9fff]/u, `${client}: frontmatter 应为中文说明`);
      assert.match(body, /[\u3400-\u9fff]/u, `${client}: 正文应为中文`);
      assert.match(body, /start.*inspect.*acquire.*submit/su, `${client}: Driver 循环`);
      assert.match(body, /不得调用模型 API/u, `${client}: 模型边界`);
      assert.match(body, /不得缓存.*对话/u, `${client}: 对话边界`);
      assert.match(body, /不得.*Artifact 正文.*协议 JSON/u, `${client}: Artifact 边界`);
      assert.match(body, /\.wsspec\/work-items\/<workItemId>\/drafts\/<outputId>\.md/u, `${client}: draft 路径模板`);
      assert.match(body, /artifact create/u, `${client}: Artifact authoring 命令`);
      assert.match(body, /submit.*只.*ArtifactRef/su, `${client}: submit 只携带 ArtifactRef`);
      assert.match(body, /builtin:\/\/workflows\/feature-delivery/u, `${client}: 功能 workflowRef`);
      assert.match(body, /builtin:\/\/workflows\/documentation-delivery/u, `${client}: 文档 workflowRef`);
      assert.match(body, /创建后不得自动切换 Workflow/u, `${client}: Workflow 不切换`);
      assert.match(body, /不冒充.*真实 Agent Host/u, `${client}: Host 边界`);
      assert.equal(contract.operations.acquire.branch?.field, "result.action", `${client}: acquire action 分支`);
      assert.deepEqual(contract.operations.acquire.branch?.cases, {
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
      }, `${client}: action.kind 分支必须完整`);
      assert.deepEqual(contract.operations.submit.branch?.cases.execute, contract.operations.acquire.branch?.cases.execute, `${client}: submit execute 必须消费返回的 AgentAction`);
      assert.deepEqual(contract.operations.artifact, {
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
      }, `${client}: artifact authoring 命令模板`);
      assert.deepEqual(contract.operations.submit.resultBindings, { artifacts: "artifactRefs" }, `${client}: submit 必须消费累积 ArtifactRef`);

      const repeated = await runCli(root, home, installArgs);
      assertPassed(repeated, `${client}: idempotent reinstall`);
      assert.equal(await readFile(skillPath, "utf8"), first, `${client}: 同 digest 安装必须幂等`);
      assert.equal((await allFiles(home)).some((filename) => filename.endsWith(".mdc")), false, `${client}: 禁止 .mdc`);

      const altered = first.replace("# WSSpecKit Driver", "# 被修改的 Driver");
      await writeFile(skillPath, altered, "utf8");
      const conflict = await runCli(root, home, installArgs);
      assert.equal(conflict.code, 1, `${client}: 不同内容应拒绝覆盖`);
      assert.equal(conflict.value.error?.code, "WSSPEC_SKILL_INSTALL_CONFLICT", `${client}: conflict code`);
      assert.equal(await readFile(skillPath, "utf8"), altered, `${client}: 冲突内容必须保留`);
    });
  }

  const genericHome = await temporaryHome("generic");
  const missingTarget = await runCli(root, genericHome, ["agent", "install", "--client", "generic"]);
  assert.equal(missingTarget.code, 1);
  assert.equal(missingTarget.value.error?.code, "WSSPEC_ARGUMENT_REQUIRED");
});

test("Driver 对受治理外部动作在人工决定后以返回 Work Package 原样重新 submit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-governed-resume-"));
  for (const client of clients) {
    await t.test(client, async () => {
      const home = await temporaryHome(client);
      const target = expectedTarget(client, home);
      await mkdir(target, { recursive: true });
      const installed = await runCli(root, home, installArguments(client, target));
      assertPassed(installed, `${client}: install governed resume contract`);
      const { body } = splitSkill(await readFile(path.join(target, "SKILL.md"), "utf8"));
      const contract = driverContract(body);

      const awaitApproval = contract.operations.submit.branch?.cases.await_approval;
      assert.deepEqual(awaitApproval, {
        next: "decide",
        capture: { approval: "result.approval" },
        humanGate: { required: true, approval: "result.approval" },
      }, `${client}: first governed submit must stop for a human decision`);

      const decide = contract.operations.decide;
      assert.deepEqual(decide.argv, ["wspec", "decide", "--input", "${decisionPath}", "--actor", "${actor}"], `${client}: decide must use the public human-gated decision entrypoint`);
      assert.deepEqual(decide.branch?.cases.execute, {
        next: "submit",
        capture: {
          workPackage: "result.workPackage",
          stepId: "result.workPackage.stepId",
          attemptId: "result.workPackage.attemptId",
          leaseToken: "result.workPackage.lease.token",
          requiredOutputs: "result.workPackage.requiredOutputs",
        },
      }, `${client}: human-approved action must retain the returned package identity and re-submit the existing result`);
      assert.equal(decide.branch?.cases.execute?.initialize, undefined, `${client}: resumed submit must not rebuild ArtifactRef inputs`);
      assert.equal(decide.branch?.cases.execute?.next, "submit", `${client}: resumed action must bypass artifact authoring`);
      assert.deepEqual(contract.entrypoints, { new: "start", recovery: "inspect" }, `${client}: recovery remains inspect then acquire`);
      assert.equal(contract.operations.inspect.next, "acquire", `${client}: inspect is only the recovery bridge to acquire`);
    });
  }
});

function installArguments(client: Client, target: string): string[] {
  return ["agent", "install", "--client", client, ...(client === "generic" ? ["--target", target] : [])];
}

function firstInstallSegment(client: Exclude<Client, "generic">): string {
  if (client === "codex") return ".agents";
  if (client === "claude") return ".claude";
  return ".cursor";
}

test("四类 Driver 拒绝祖先目录与最终 Skill symlink，且外部路径零副作用", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-task2-link-root-"));
  for (const client of clients) {
    await t.test(`${client}/ancestor`, async () => {
      const home = await temporaryHome(client);
      const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), `wspec-task2-${client}-outside-`)));
      const target = client === "generic"
        ? path.join(home, "linked-parent", "generic-driver")
        : expectedTarget(client, home);
      const linkedAncestor = client === "generic"
        ? path.join(home, "linked-parent")
        : path.join(home, firstInstallSegment(client));
      await symlink(outside, linkedAncestor, "dir");

      const result = await runCli(root, home, installArguments(client, target));

      assert.equal(result.code, 1, `${client}: symlink 祖先必须拒绝`);
      assert.equal(result.value.error?.code, "WSSPEC_SKILL_INSTALL_CONFLICT", `${client}: symlink 祖先错误码`);
      assert.deepEqual(await readdir(outside), [], `${client}: symlink 祖先不得产生外部写入`);
    });

    await t.test(`${client}/final`, async () => {
      const home = await temporaryHome(client);
      const target = expectedTarget(client, home);
      const args = installArguments(client, target);
      await mkdir(target, { recursive: true });
      const installed = await runCli(root, home, args);
      assertPassed(installed, `${client}: 安装 final symlink fixture`);
      const skillPath = path.join(target, "SKILL.md");
      const canonical = await readFile(skillPath, "utf8");
      const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), `wspec-task2-${client}-outside-`)));
      const outsideSkill = path.join(outside, "SKILL.md");
      await writeFile(outsideSkill, canonical, "utf8");
      await unlink(skillPath);
      await symlink(outsideSkill, skillPath, "file");

      const result = await runCli(root, home, args);

      assert.equal(result.code, 1, `${client}: 最终 Skill symlink 必须拒绝`);
      assert.equal(result.value.error?.code, "WSSPEC_SKILL_INSTALL_CONFLICT", `${client}: 最终 symlink 错误码`);
      assert.equal(await readFile(outsideSkill, "utf8"), canonical, `${client}: symlink 外部文件不得变化`);
      assert.deepEqual(await readdir(outside), ["SKILL.md"], `${client}: symlink 外部目录不得新增内容`);
    });
  }
});

test("Driver 最终 Skill 必须是单链接普通文件", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-task2-file-kind-root-"));
  const home = await temporaryHome("generic");
  const target = expectedTarget("generic", home);
  const args = installArguments("generic", target);
  await mkdir(target, { recursive: true });
  const installed = await runCli(root, home, args);
  assertPassed(installed, "generic: 安装 file-kind fixture");
  const skillPath = path.join(target, "SKILL.md");
  const canonical = await readFile(skillPath, "utf8");

  await t.test("hardlink", async () => {
    const outside = path.join(home, "outside-hardlink.md");
    await writeFile(outside, canonical, "utf8");
    await unlink(skillPath);
    await link(outside, skillPath);
    try {
      const result = await runCli(root, home, args);
      assert.equal(result.code, 1);
      assert.equal(result.value.error?.code, "WSSPEC_SKILL_INSTALL_CONFLICT");
      assert.equal(await readFile(outside, "utf8"), canonical);
    } finally {
      await unlink(skillPath).catch(() => undefined);
      await unlink(outside).catch(() => undefined);
    }
  });

  await t.test("non-regular", async () => {
    await mkdir(skillPath);
    const result = await runCli(root, home, args);
    assert.equal(result.code, 1);
    assert.equal(result.value.error?.code, "WSSPEC_SKILL_INSTALL_CONFLICT");
  });
});

async function createRepository(home: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-task2-driver-repo-"));
  await git(root, "init");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "Task 2 Fixture");
  const initialized = await runCli(root, home, ["init"]);
  assertPassed(initialized, "init");
  const ignorePath = path.join(root, ".gitignore");
  const ignore = await readFile(ignorePath, "utf8").catch(() => "");
  await writeFile(ignorePath, `${ignore}${ignore.endsWith("\n") || ignore === "" ? "" : "\n"}.acceptance/\n`, "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "test: initialize driver fixture");
  return root;
}

function artifactBody(artifactType: string): string {
  if (artifactType === "specification") return [
    "# 目标与背景", "验证 Driver 状态机。", "# 范围", "本地 Fixture。", "# 需求", "执行统一协议。",
    "# 验收条件", "到达明确终点。", "# 约束", "不访问模型端点。", "# 排除项", "真实 Host。", "# 开放问题", "无。", "",
  ].join("\n");
  if (artifactType === "tasks") return "# 任务\n\n```yaml\ntasks:\n  - id: task-1\n    status: pending\n    dependencies: []\n    completion: Driver 循环到达明确终点\n```\n";
  if (artifactType === "implementation-result") return [
    "# 实际改动", "本地 Fixture。", "# 修改文件", "无。", "# 计划偏差", "无。", "# 验证摘要", "由协议测试验证。",
    "# 未完成项", "无。", "# 残余风险", "不代表真实 Host。", "",
  ].join("\n");
  if (artifactType === "review-result") return "# Findings\n\n```yaml\nfindings: []\n```\n";
  return `# ${artifactType}\n\n本地 Driver 合同 Fixture。\n`;
}

async function executeArtifactOperation(
  root: string,
  home: string,
  environment: Record<string, string>,
  operation: DriverOperation,
  values: Record<string, unknown>,
): Promise<CliRun[]> {
  const rule = operation.forEach;
  assert.ok(rule, "artifact operation 必须声明 forEach");
  const source = values[rule.source];
  assert.ok(Array.isArray(source), `${rule.source} 必须已由 execute capture`);
  const collected = values[rule.collect.target];
  assert.ok(Array.isArray(collected), `${rule.collect.target} 必须已由 execute initialize`);
  const workPackage = requiredWorkPackage(values.workPackage, "artifact Work Package");
  const projection = await readControlPlane(root, workPackage.workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  const worktree = path.join(root, locator.worktree);
  const runs: CliRun[] = [];
  for (const candidate of source) {
    assert.ok(candidate !== null && typeof candidate === "object" && !Array.isArray(candidate), `${rule.item} 必须是对象`);
    const expected = candidate as Record<string, unknown>;
    if (expected[rule.filter.field] === rule.filter.notEquals) continue;
    for (const [name, binding] of Object.entries(rule.bindings)) {
      const prefix = `${rule.item}.`;
      values[name] = binding.startsWith(prefix)
        ? valueAt(expected, binding.slice(prefix.length))
        : renderTemplate(binding, values);
    }
    const artifactType = requiredString(values.artifactType, "artifactType binding");
    const outputId = requiredString(values.outputId, "outputId binding");
    const contentFile = requiredString(values.contentFile, "contentFile binding");
    await mkdir(path.dirname(path.join(worktree, contentFile)), { recursive: true });
    await writeFile(path.join(worktree, contentFile), artifactBody(artifactType), "utf8");
    const argv = renderArgv(operation, values);
    const run = await runCli(worktree, home, argv.slice(1), environment);
    assertPassed(run, `${workPackage.stepId}/${outputId}: artifact create`);
    capture(operation.capture, run.value, values);
    collected.push(valueAt(run.value, rule.collect.value));
    runs.push(run);
  }
  return runs;
}

function submissionFor(
  workPackage: WorkPackage,
  artifacts: ArtifactReference[],
): SubmitResult {
  if (workPackage.stepId === "edit-document" || workPackage.stepId === "write-tests" || workPackage.stepId === "verify-red") {
    return {
      version: 1,
      status: "failed",
      summary: workPackage.stepId === "edit-document"
        ? "本地 Driver Fixture 不执行真实文档编辑，显式进入 blocked 终点"
        : "本地 Driver Fixture 不执行真实 TDD，显式进入 blocked 终点",
      modifiedFiles: [],
      artifacts: [],
      commands: [],
      evidence: [],
      externalWrites: [],
      remainingRisks: [{
        code: workPackage.stepId === "edit-document"
          ? "WSSPEC_FIXTURE_DOCUMENT_EDIT_NOT_RUN"
          : "WSSPEC_FIXTURE_TDD_NOT_RUN",
      }],
    };
  }
  return {
    version: 1,
    status: "completed",
    summary: "本地 Driver fixture 完成当前步骤",
    modifiedFiles: [],
    artifacts,
    commands: [],
    evidence: [],
    externalWrites: [],
    remainingRisks: [],
  };
}

test("四类 Adapter 对功能与纯文档任务执行统一 CLI 循环，并可由新进程恢复", async (t) => {
  let modelRequests = 0;
  const modelServer = createServer((_request, response) => {
    modelRequests += 1;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  assert.ok(address !== null && typeof address === "object");
  const modelEndpoint = `http://127.0.0.1:${address.port}`;

  try {
    for (const client of clients) {
      const fixture = await fixtureFor(client);
      assert.equal(fixture.client, client);
      for (const kind of ["feature", "documentation"] as const) {
        await t.test(`${client}/${kind}`, async () => {
          const task = fixture[kind];
          const home = await temporaryHome(client);
          const target = expectedTarget(client, home);
          await mkdir(target, { recursive: true });
          const install = await runCli(
            repositoryRoot,
            home,
            ["agent", "install", "--client", client, ...(client === "generic" ? ["--target", target] : [])],
          );
          assertPassed(install, `${client}/${kind}: install`);
          const { body } = splitSkill(await readFile(path.join(target, "SKILL.md"), "utf8"));
          const contract = driverContract(body);
          const root = await createRepository(home);
          const environment = {
            OPENAI_BASE_URL: modelEndpoint,
            ANTHROPIC_BASE_URL: modelEndpoint,
            CURSOR_API_BASE_URL: modelEndpoint,
          };
          const workflowRef = contract.workflowSelection[kind];
          assert.equal(workflowRef, task.workflowRef, `${client}/${kind}: Driver workflow 决策`);
          const values: Record<string, unknown> = {
            actor: fixture.actor,
            profile: "quick",
            prompt: task.prompt,
            provider: client,
            workflowRef,
          };
          const pids: number[] = [];
          let protocolJson = "";
          let state: DriverState = contract.entrypoints.new;
          let terminal: DriverTerminal | undefined;
          let terminalResult: Record<string, unknown> | undefined;
          let acquireCount = 0;
          let executeCount = 0;
          let submitCount = 0;
          let projectDefaultSwitched = false;

          for (let iteration = 0; iteration < 32 && terminal === undefined; iteration += 1) {
            const operation: DriverOperation = contract.operations[state];
            assert.ok(operation, `${client}/${kind}: Driver 缺少 ${state} 操作`);
            if (state === "artifact") {
              const runs = await executeArtifactOperation(root, home, environment, operation, values);
              pids.push(...runs.map(({ pid }) => pid));
              protocolJson += runs.map(({ stdout }) => stdout).join("");
              assert.equal(operation.next, "submit", `${client}/${kind}: artifact 完成后必须 submit`);
              state = operation.next;
              continue;
            }
            if (state === "submit") {
              const workPackage = requiredWorkPackage(values.workPackage, `${client}/${kind}: submit Work Package`);
              const resultName = `driver-result-${submitCount + 1}.json`;
              const artifactBinding = operation.resultBindings?.artifacts;
              assert.equal(artifactBinding, "artifactRefs", `${client}/${kind}: submit artifact binding`);
              const artifactRefs = values[artifactBinding];
              assert.ok(Array.isArray(artifactRefs), `${client}/${kind}: artifactRefs 必须由状态合同累积`);
              const result = submissionFor(workPackage, artifactRefs as ArtifactReference[]);
              await writeFile(path.join(root, resultName), `${JSON.stringify(result, null, 2)}\n`, "utf8");
              values.resultPath = resultName;
            }
            const argv = renderArgv(operation, values);
            assert.equal(argv[0], "wspec", `${client}/${kind}: Driver 命令必须以 wspec 开始`);
            const run = await runCli(root, home, argv.slice(1), environment);
            assertPassed(run, `${client}/${kind}: ${state}`);
            pids.push(run.pid);
            protocolJson += run.stdout;
            capture(operation.capture, run.value, values);
            const branch = operation.branch;
            const branchCase = branch === undefined
              ? undefined
              : branch.cases[requiredString(valueAt(run.value, branch.field), `${client}/${kind}: action.kind`) as keyof typeof branch.cases];
            capture(branchCase?.capture, run.value, values);
            initialize(branchCase?.initialize, run.value, values);

            if (state === "start") {
              assert.equal(values.workflowRef, task.workflowRef, `${client}/${kind}: explicit workflowRef`);
              requiredString(values.workItemId, `${client}/${kind}: workItemId`);
              assert.equal(operation.next, contract.entrypoints.recovery, `${client}/${kind}: start 后必须进入恢复入口`);
              const opposite = kind === "feature"
                ? "builtin://workflows/documentation-delivery"
                : "builtin://workflows/feature-delivery";
              const switched = await runCli(root, home, ["workflow", "use", opposite, "--profile", "quick", "--provider", client], environment);
              assertPassed(switched, `${client}/${kind}: switch project default`);
              projectDefaultSwitched = true;
            } else if (state === "inspect") {
              assert.equal(run.value.result.workflowRef, task.workflowRef, `${client}/${kind}: inspect 不得切换 Workflow`);
            } else if (state === "acquire") {
              acquireCount += 1;
              if (run.value.result.action === "execute") {
                executeCount += 1;
                const workPackage = requiredWorkPackage(values.workPackage, `${client}/${kind}: acquire Work Package`);
                assert.equal(workPackage.workItemId, values.workItemId);
              }
            } else if (state === "submit") {
              submitCount += 1;
              if (run.value.result.action === "execute") {
                executeCount += 1;
                if (submitCount === 1) {
                  const active = requiredWorkPackage(values.workPackage, `${client}/${kind}: active Work Package`);
                  const repeatedAcquireArgv = renderArgv(contract.operations.acquire, values);
                  const differentActorArgv = [...repeatedAcquireArgv];
                  differentActorArgv[differentActorArgv.length - 1] = `${fixture.actor}-other`;
                  const differentActor = await runCli(root, home, differentActorArgv.slice(1), environment);
                  assertPassed(differentActor, `${client}/${kind}: different actor acquire`);
                  assert.equal(differentActor.value.result.action, "blocked");
                  assert.equal(
                    (differentActor.value.result.problems as Array<{ code?: string }> | undefined)?.[0]?.code,
                    "WSSPEC_STAGE_ALREADY_CLAIMED",
                    `${client}/${kind}: different actor 必须被活动 Claim 阻塞`,
                  );
                  pids.push(differentActor.pid);
                  protocolJson += differentActor.stdout;

                  const inspected = await runCli(root, home, renderArgv(contract.operations.inspect, values).slice(1), environment);
                  assertPassed(inspected, `${client}/${kind}: fresh-session inspect`);
                  const reacquired = await runCli(root, home, repeatedAcquireArgv.slice(1), environment);
                  assertPassed(reacquired, `${client}/${kind}: same actor fresh-session reacquire`);
                  assert.equal(reacquired.value.result.action, "execute");
                  const recovered = requiredWorkPackage(reacquired.value.result.workPackage, `${client}/${kind}: reacquired Work Package`);
                  assert.equal(recovered.stepId, active.stepId);
                  assert.equal(recovered.attemptId, active.attemptId);
                  assert.notEqual(recovered.lease.token, active.lease.token);
                  values.workPackage = recovered;
                  values.stepId = recovered.stepId;
                  values.attemptId = recovered.attemptId;
                  values.leaseToken = recovered.lease.token;
                  pids.push(inspected.pid, reacquired.pid);
                  protocolJson += inspected.stdout + reacquired.stdout;
                }
              }
            }

            const next = branchCase?.next ?? operation.next;
            assert.ok(next !== undefined, `${client}/${kind}: ${state} 必须声明下一状态`);
            if (next in contract.terminals) {
              assert.equal(contract.terminals[next as DriverTerminal].stop, true);
              terminal = next as DriverTerminal;
              terminalResult = run.value.result;
            } else {
              state = next as DriverState;
            }
          }

          assert.equal(projectDefaultSwitched, true, `${client}/${kind}: 必须扰动项目默认 Workflow`);
          assert.ok(terminal !== undefined, `${client}/${kind}: Driver 循环必须到达明确终点`);
          assert.ok(acquireCount >= 1, `${client}/${kind}: recovery 必须执行 acquire`);
          assert.ok(executeCount >= 2, `${client}/${kind}: 必须取得多个 execute Work Package，实际 ${executeCount}`);
          assert.ok(submitCount >= 2, `${client}/${kind}: 必须多次 submit，实际 ${submitCount}，终点 ${terminal} ${JSON.stringify(terminalResult)}`);
          assert.equal(new Set(pids).size, pids.length, `${client}/${kind}: 每条协议命令必须使用 fresh process`);
          assert.doesNotMatch(protocolJson, /"body"\s*:/u, `${client}/${kind}: 协议不得内嵌 Artifact 正文`);
          assert.doesNotMatch(protocolJson, new RegExp(task.artifactBodyMarker, "u"), `${client}/${kind}: Artifact 正文标记不得出现在协议`);
          for (const forbidden of [noConversationMarker, noSecretMarker, home, process.env.HOME ?? "", os.userInfo().username]) {
            if (forbidden !== "") assert.doesNotMatch(protocolJson, escapePattern(forbidden), `${client}/${kind}: 不得记录敏感运行环境`);
          }

          const persisted = await allFiles(path.join(root, ".wsspec"));
          for (const filename of persisted) {
            const content = await readFile(filename, "utf8");
            for (const forbidden of [noConversationMarker, noSecretMarker, home, process.env.HOME ?? "", os.userInfo().username]) {
              if (forbidden !== "") assert.doesNotMatch(content, escapePattern(forbidden), `${client}/${kind}: 控制数据不得记录对话、HOME、用户名或 secret`);
            }
          }
        });
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error === undefined ? resolve() : reject(error)));
  }
  assert.equal(modelRequests, 0, "Driver/CLI 不得调用模型 API");
});
