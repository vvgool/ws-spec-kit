#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stringify as stringifyYaml } from "yaml";

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

async function git(root, ...args) {
  return run("git", args, { cwd: root });
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
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "acceptance@example.invalid");
  await git(root, "config", "user.name", "WSSpecKit Acceptance");

  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, ".acceptance"), { recursive: true });
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

  const environment = {
    ...process.env,
    HOME: root,
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  await runWspec(root, environment, ["init"]);
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
  await runWspec(root, environment, ["agent", "install", "--client", input.client]);

  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "test: seed agent acceptance smoke");
  const baselineCommit = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  const wsspeckitCommit = (await git(sourceRoot, "rev-parse", "HEAD")).stdout.trim();
  const started = await runWspec(root, environment, [
    "start",
    "--file", "SMOKE_REQUIREMENT.md",
    "--workflow", "builtin://workflows/feature-delivery",
    "--profile", "quick",
    "--provider", input.client,
  ]);
  const metadata = {
    version: 1,
    kind: "wsspeckit-agent-smoke",
    client: input.client,
    workItemId: started.workItemId,
    workflowRef: started.workflowRef,
    profile: started.profile,
    baselineCommit,
    wsspeckitCommit,
    driver: driverRelativePath(input.client),
  };
  await writeFile(path.join(root, ".acceptance", "agent-smoke.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { version: 1, client: input.client, root, workItemId: started.workItemId, baselineCommit, driver: metadata.driver };
}

async function main() {
  const result = await prepareSmoke(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
