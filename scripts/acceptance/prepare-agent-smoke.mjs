#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";

import {
  cleanEnvironment,
  cleanEnvironmentKeys,
  createAuthority,
  sha256,
  sha256File,
  writeSignedJson,
} from "./lib/evidence.mjs";

const execFileAsync = promisify(execFile);
const clients = new Set(["codex", "claude", "cursor"]);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDirectory, "../..");
const sourceRuntime = process.env.WSSPECKIT_ACCEPTANCE_RUNTIME === "source";
const wspecCli = path.join(sourceRoot, sourceRuntime ? "src" : "dist", "cli", sourceRuntime ? "main.ts" : "main.js");
const tsxLoader = path.join(sourceRoot, "node_modules", "tsx", "dist", "loader.mjs");

function wspecArguments(args) {
  return sourceRuntime ? ["--import", tsxLoader, wspecCli, ...args] : [wspecCli, ...args];
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--client", "--directory"].includes(name) || value === undefined || value.startsWith("--")) {
      throw new Error("用法：prepare-agent-smoke.mjs --client <codex|claude|cursor> [--directory <目录>]");
    }
    if (values[name] !== undefined) throw new Error(`重复参数：${name}`);
    values[name] = value;
  }
  if (!clients.has(values["--client"])) throw new Error("--client 必须是 codex、claude 或 cursor");
  return { client: values["--client"], directory: values["--directory"] };
}

async function run(executable, args, options = {}) {
  return execFileAsync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function findClientExecutable(client) {
  const names = client === "cursor" ? ["agent", "cursor-agent", "cursor"] : [client];
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, fsConstants.X_OK);
        return { filename: await realpath(candidate), name };
      } catch {}
    }
  }
  return undefined;
}

async function probeClientVersion(client, runtime) {
  const versionArgv = ["--version"];
  const executable = await findClientExecutable(client);
  if (executable === undefined) {
    return { status: "unavailable", executableName: client, executableDigest: null, versionArgv, outputDigest: null, exitCode: null };
  }
  const executableDigest = await sha256File(executable.filename);
  try {
    const result = await run(executable.filename, versionArgv, { env: runtime.environment });
    return {
      status: "recorded",
      executableName: executable.name,
      executableDigest,
      versionArgv,
      outputDigest: sha256({ stdout: result.stdout, stderr: result.stderr }),
      exitCode: 0,
    };
  } catch (error) {
    const failure = error;
    return {
      status: "failed",
      executableName: executable.name,
      executableDigest,
      versionArgv,
      outputDigest: sha256({ stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }),
      exitCode: typeof failure.code === "number" ? failure.code : null,
    };
  }
}

async function git(runtime, root, ...args) {
  return run(runtime.gitExecutable, [
    "-c", "user.email=acceptance@example.invalid",
    "-c", "user.name=WSSpecKit Acceptance",
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd: root, env: runtime.environment });
}

function driverDirectory(client, root) {
  if (client === "codex") return path.join(root, ".agents", "skills", "wsspeckit-driver");
  if (client === "claude") return path.join(root, ".claude", "skills", "wsspeckit-driver");
  return path.join(root, ".cursor", "skills", "wsspeckit-driver");
}

function driverRelativePath(client) {
  if (client === "codex") return ".agents/skills/wsspeckit-driver/SKILL.md";
  if (client === "claude") return ".claude/skills/wsspeckit-driver/SKILL.md";
  return ".cursor/skills/wsspeckit-driver/SKILL.md";
}

async function runWspec(root, environment, args) {
  const { stdout } = await run(process.execPath, wspecArguments(args), { cwd: root, env: environment });
  const value = JSON.parse(stdout);
  if (value.ok !== true) throw new Error(`WSSpecKit 命令失败：${value.error?.code ?? "unknown"}`);
  return value.result;
}

async function prepareSmoke(input) {
  const root = input.directory === undefined
    ? await mkdtemp(path.join(os.tmpdir(), `wsspeckit-${input.client}-live-`))
    : path.resolve(input.directory);
  if (input.directory !== undefined) await mkdir(root);
  await mkdir(path.join(root, ".acceptance"), { recursive: true });
  const authority = await createAuthority();
  const runtime = await cleanEnvironment(root, [path.join(root, "bin")], { home: root });
  const invocations = [];
  const recordInvocation = (operation, exitCode = 0) => invocations.push({
    sequence: invocations.length + 1,
    operation,
    exitCode,
    timestamp: new Date().toISOString(),
    environmentKeys: cleanEnvironmentKeys,
  });
  const clientVersionProbe = await probeClientVersion(input.client, runtime);
  recordInvocation("client.version", clientVersionProbe.exitCode);
  await git(runtime, root, "init", "--quiet");
  recordInvocation("git.init");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), ".acceptance/\n", "utf8");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "wsspeckit-agent-live-smoke",
    private: true,
    type: "module",
    scripts: { test: "node --test tests/labels.test.ts" },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "src", "labels.ts"), [
    "export function normalizeLabel(value: string): string {",
    "  return value.trim().toLowerCase();",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "tests", "labels.test.ts"), [
    "import assert from \"node:assert/strict\";",
    "import test from \"node:test\";",
    "import { normalizeLabel } from \"../src/labels.ts\";",
    "",
    "test(\"normalizeLabel trims and lowercases a label\", () => {",
    "  assert.equal(normalizeLabel(\"  Ready  \"), \"ready\");",
    "});",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "SMOKE_REQUIREMENT.md"), [
    "# Smoke Requirement",
    "",
    "在 `src/labels.ts` 增加无副作用纯函数 `formatLabelParts(parts: readonly string[]): string`。",
    "函数应先复用现有规范化规则，再移除空项，并以 ` / ` 连接；同时新增对应 Node 测试。",
    "必须先提交会因缺少该函数而失败的测试，再做最小实现，并完成 Review。",
    "",
  ].join("\n"), "utf8");
  const wrapperArguments = wspecArguments([]).map((value) => JSON.stringify(value)).join(" ");
  const wrapper = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${wrapperArguments} \"$@\"\n`;
  await writeFile(path.join(root, "bin", "wspec"), wrapper, { encoding: "utf8", mode: 0o755 });
  await chmod(path.join(root, "bin", "wspec"), 0o755);

  await runWspec(root, runtime.environment, ["init"]);
  recordInvocation("wspec.init");
  await writeFile(path.join(root, ".wsspec", "config.yaml"), stringifyYaml({
    version: 1,
    testing: {
      pathRules: ["node"],
      testAssetPaths: ["tests/**", "**/*.test.*"],
      productPaths: ["src/**"],
    },
    quality: {
      gates: {
        test: {
          command: [process.execPath, "--test", "tests/labels.test.ts"],
          cwd: "worktree",
          timeoutSeconds: 30,
          required: true,
          evidence: "trusted",
          inheritEnv: [],
          env: {},
          reporter: { type: "node-test", version: 1 },
        },
      },
    },
  }, { lineWidth: 0 }), "utf8");
  await mkdir(driverDirectory(input.client, root), { recursive: true });
  await runWspec(root, runtime.environment, ["agent", "install", "--client", input.client]);
  recordInvocation("wspec.agent-install");

  await git(runtime, root, "add", ".");
  recordInvocation("git.add");
  await git(runtime, root, "commit", "--quiet", "-m", "test: seed agent acceptance smoke");
  recordInvocation("git.commit");
  const baselineCommit = (await git(runtime, root, "rev-parse", "HEAD")).stdout.trim();
  const baselineTree = (await git(runtime, root, "rev-parse", "HEAD^{tree}")).stdout.trim();
  const wsspeckitCommit = (await git(runtime, sourceRoot, "rev-parse", "HEAD")).stdout.trim();
  const started = await runWspec(root, runtime.environment, [
    "start",
    "--file", "SMOKE_REQUIREMENT.md",
    "--workflow", "builtin://workflows/feature-delivery",
    "--profile", "quick",
    "--provider", input.client,
  ]);
  recordInvocation("wspec.start");
  const metadata = {
    version: 1,
    kind: "wsspeckit-agent-smoke",
    runIdHash: sha256(authority.authority.runNonce),
    client: input.client,
    workItemId: started.workItemId,
    workflowRef: started.workflowRef,
    profile: started.profile,
    baselineCommit,
    baselineTree,
    wsspeckitCommit,
    requirementDigest: await sha256File(path.join(root, "SMOKE_REQUIREMENT.md")),
    driver: driverRelativePath(input.client),
    driverDigest: await sha256File(path.join(root, driverRelativePath(input.client))),
    clientVersionProbe,
    authorityIdentity: authority.identity,
    createdAt: authority.authority.createdAt,
  };
  await writeSignedJson(
    path.join(root, ".acceptance", "agent-smoke.json"),
    path.join(root, ".acceptance", "agent-smoke-receipt.json"),
    "wsspeckit-agent-smoke-fixture-receipt",
    metadata,
    authority.authority,
    authority.identity,
  );
  const runManifest = {
    version: 1,
    kind: "wsspeckit-agent-smoke-run",
    client: input.client,
    runIdHash: metadata.runIdHash,
    workItemIdHash: sha256(started.workItemId),
    requirementDigest: metadata.requirementDigest,
    baselineCommit,
    baselineTree,
    driverDigest: metadata.driverDigest,
    authorityIdentity: metadata.authorityIdentity,
    createdAt: metadata.createdAt,
    updatedAt: new Date().toISOString(),
    workflowRef: started.workflowRef,
    wsspeckitCommit,
    clientVersionProbe,
    invocations,
    verifier: null,
    artifactDigests: [],
    evidenceDigests: [],
    eventReferences: [],
    status: "prepared",
    reason: "awaiting-verifier",
  };
  await writeSignedJson(
    path.join(root, ".acceptance", "agent-smoke-run.json"),
    path.join(root, ".acceptance", "agent-smoke-run-receipt.json"),
    "wsspeckit-agent-smoke-run-receipt",
    runManifest,
    authority.authority,
    authority.identity,
  );
  return {
    version: 1,
    client: input.client,
    root,
    workItemId: started.workItemId,
    baselineCommit,
    driver: metadata.driver,
    authorityFile: authority.filename,
    authorityIdentity: authority.identity,
  };
}

async function main() {
  const result = await prepareSmoke(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
