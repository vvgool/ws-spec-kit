import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import type { SubmitResult } from "../../src/protocol/application.js";
import type { WorkPackage } from "../../src/protocol/work-package.js";
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
  return home;
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

test("四类 Driver 通过 --client 安装到各自官方目录，且 dry-run、幂等和冲突均 fail closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-task2-install-root-"));
  for (const client of clients) {
    await t.test(client, async () => {
      const home = await temporaryHome(client);
      const target = expectedTarget(client, home);
      const installArgs = ["agent", "install", "--client", client, ...(client === "generic" ? ["--target", target] : [])];

      const dryRun = await runCli(root, home, [...installArgs, "--dry-run"]);
      assertPassed(dryRun, `${client}: dry-run`);
      assert.equal(dryRun.value.result.target, target, `${client}: target`);
      assert.equal(await exists(path.join(target, "SKILL.md")), false, `${client}: dry-run 不得写入`);

      const installed = await runCli(root, home, installArgs);
      assertPassed(installed, `${client}: install`);
      const skillPath = path.join(target, "SKILL.md");
      const first = await readFile(skillPath, "utf8");
      const { frontMatter, body } = splitSkill(first);
      assert.match(String(frontMatter.description), /[\u3400-\u9fff]/u, `${client}: frontmatter 应为中文说明`);
      assert.match(body, /[\u3400-\u9fff]/u, `${client}: 正文应为中文`);
      assert.match(body, /start.*inspect.*acquire.*submit/su, `${client}: Driver 循环`);
      assert.match(body, /不得调用模型 API/u, `${client}: 模型边界`);
      assert.match(body, /不得缓存.*对话/u, `${client}: 对话边界`);
      assert.match(body, /不得.*Artifact 正文.*协议 JSON/u, `${client}: Artifact 边界`);
      assert.match(body, /builtin:\/\/workflows\/feature-delivery/u, `${client}: 功能 workflowRef`);
      assert.match(body, /builtin:\/\/workflows\/documentation-delivery/u, `${client}: 文档 workflowRef`);
      assert.match(body, /创建后不得自动切换 Workflow/u, `${client}: Workflow 不切换`);
      assert.match(body, /不冒充.*真实 Agent Host/u, `${client}: Host 边界`);

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

async function createRepository(home: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-task2-driver-repo-"));
  await git(root, "init");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "Task 2 Fixture");
  const initialized = await runCli(root, home, ["init"]);
  assertPassed(initialized, "init");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "test: initialize driver fixture");
  return root;
}

function submissionFor(workPackage: WorkPackage): SubmitResult {
  const artifacts = workPackage.requiredOutputs.map((expected: { artifactType: string; schemaVersion: number }) => {
    if (expected.artifactType !== "requirement-source") return expected;
    const source = workPackage.artifacts.find((artifact: { artifactType: string }) => artifact.artifactType === "requirement-source");
    assert.ok(source, "intake 必须携带 Requirement Source 引用");
    return source;
  });
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
          const install = await runCli(
            repositoryRoot,
            home,
            ["agent", "install", "--client", client, ...(client === "generic" ? ["--target", target] : [])],
          );
          assertPassed(install, `${client}/${kind}: install`);
          const root = await createRepository(home);
          const environment = {
            OPENAI_BASE_URL: modelEndpoint,
            ANTHROPIC_BASE_URL: modelEndpoint,
            CURSOR_API_BASE_URL: modelEndpoint,
          };

          const started = await runCli(root, home, [
            "start", "--prompt", task.prompt,
            "--workflow", task.workflowRef,
            "--profile", "quick",
            "--provider", client,
          ], environment);
          assertPassed(started, `${client}/${kind}: start`);
          assert.equal(started.value.result.workflowRef, task.workflowRef, `${client}/${kind}: explicit workflowRef`);
          const workItemId = requiredString(started.value.result.workItemId, `${client}/${kind}: workItemId`);

          const opposite = kind === "feature"
            ? "builtin://workflows/documentation-delivery"
            : "builtin://workflows/feature-delivery";
          const switched = await runCli(root, home, ["workflow", "use", opposite, "--profile", "quick", "--provider", client], environment);
          assertPassed(switched, `${client}/${kind}: switch project default`);

          const inspected = await runCli(root, home, ["inspect", workItemId], environment);
          assertPassed(inspected, `${client}/${kind}: inspect in a new process`);
          assert.equal(inspected.value.result.workflowRef, task.workflowRef, `${client}/${kind}: 已创建任务不得切 Workflow`);

          const acquired = await runCli(root, home, ["acquire", workItemId, "--actor", fixture.actor], environment);
          assertPassed(acquired, `${client}/${kind}: acquire in a new process`);
          assert.equal(acquired.value.result.action, "execute", `${client}/${kind}: acquire action`);
          const workPackage = requiredWorkPackage(acquired.value.result.workPackage, `${client}/${kind}`);
          assert.equal(workPackage.workItemId, workItemId);
          const protocolJson = `${started.stdout}${inspected.stdout}${acquired.stdout}`;
          assert.doesNotMatch(protocolJson, /"body"\s*:/u, `${client}/${kind}: 协议不得内嵌 Artifact 正文`);
          assert.doesNotMatch(protocolJson, new RegExp(task.artifactBodyMarker, "u"), `${client}/${kind}: Artifact 正文标记不得出现在协议`);
          for (const forbidden of [noConversationMarker, noSecretMarker, home, process.env.HOME ?? "", os.userInfo().username]) {
            if (forbidden !== "") assert.doesNotMatch(protocolJson, escapePattern(forbidden), `${client}/${kind}: 不得记录敏感运行环境`);
          }

          const resultPath = path.join(root, "driver-result.json");
          await writeFile(resultPath, `${JSON.stringify(submissionFor(workPackage), null, 2)}\n`, "utf8");
          const submitted = await runCli(root, home, [
            "submit", workItemId,
            "--step", workPackage.stepId,
            "--attempt", workPackage.attemptId,
            "--lease", workPackage.lease.token,
            "--result", "driver-result.json",
            "--actor", fixture.actor,
          ], environment);
          assertPassed(submitted, `${client}/${kind}: submit`);
          assert.notEqual(started.pid, inspected.pid, `${client}/${kind}: inspect 必须是新进程`);
          assert.notEqual(inspected.pid, acquired.pid, `${client}/${kind}: acquire 必须是新进程`);
          assert.notEqual(acquired.pid, submitted.pid, `${client}/${kind}: submit 必须是新进程`);

          const after = await runCli(root, home, ["inspect", workItemId], environment);
          assertPassed(after, `${client}/${kind}: inspect after submit`);
          assert.equal(after.value.result.workflowRef, task.workflowRef, `${client}/${kind}: submit 后 Workflow 保持不变`);

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
