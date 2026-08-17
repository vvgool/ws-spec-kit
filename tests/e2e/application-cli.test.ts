import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGitRepository } from "../integration/helpers/git.js";

interface CliResult { code: number | null; stdout: string; stderr: string }

async function runCli(cwd: string, args: string[], home: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", path.resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs"), path.resolve(import.meta.dirname, "../../src/cli/main.ts"), ...args], {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("公开 CLI 只暴露 Application 命令并将旧命令拒绝为未知命令", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  const help = await runCli(root, ["--help"], home);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /\binit\b/);
  assert.match(help.stdout, /\bstart\b/);
  assert.match(help.stdout, /\bacquire\b/);
  assert.match(help.stdout, /\bsubmit\b/);
  assert.match(help.stdout, /\bdecide\b/);
  assert.match(help.stdout, /\binspect\b/);
  assert.match(help.stdout, /\bworkflow\b/);
  assert.match(help.stdout, /\bagent install\b/);
  assert.doesNotMatch(help.stdout, /\bnew-file\b|\bclaim\b|\bresume\b/);

  for (const legacy of ["new", "resume", "claim", "complete"]) {
    const result = await runCli(root, [legacy], home);
    assert.equal(result.code, 1, legacy);
    assert.match(`${result.stdout}${result.stderr}`, /WSSPEC_COMMAND_UNKNOWN/, legacy);
  }

  const target = await runCli(root, ["agent", "install", "codex", "--target", path.join(home, "ignored"), "--dry-run"], home);
  assert.equal(target.code, 1);
  assert.match(target.stdout, /WSSPEC_ARGUMENT_INVALID/);

  for (const args of [["init", "extra"], ["start", "extra", "--prompt", "需求"], ["acquire", "WSS-EXTRA", "extra", "--actor", "agent"]]) {
    const result = await runCli(root, args, home);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stdout, /WSSPEC_ARGUMENT_INVALID/, args.join(" "));
  }
});

test("核心 CLI 的 value option 拒绝缺值、相邻 option 与重复项，并保持 dry-run 无写入", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  const cases: Array<{ args: string[]; code: string }> = [
    { args: ["start", "--prompt", "--provider"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["start", "--prompt", ""], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["start", "--prompt", "需求", "--prompt", "重复"], code: "WSSPEC_ARGUMENT_INVALID" },
    { args: ["submit", "WSS-CLI", "--step", "--attempt", "attempt-1", "--lease", "lease", "--result", "result.json", "--actor", "agent"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["submit", "WSS-CLI", "--step", "step", "--step", "again", "--attempt", "attempt-1", "--lease", "lease", "--result", "result.json", "--actor", "agent"], code: "WSSPEC_ARGUMENT_INVALID" },
    { args: ["decide", "--input", "--actor", "agent"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["decide", "--input", "decision.json", "--actor", "agent", "--actor", "again"], code: "WSSPEC_ARGUMENT_INVALID" },
    { args: ["agent", "install", "generic", "--target", "--dry-run"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["agent", "install", "generic", "--target", "", "--dry-run"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["agent", "install", "generic", "--target", "one", "--target", "two", "--dry-run"], code: "WSSPEC_ARGUMENT_INVALID" },
  ];

  for (const current of cases) {
    const result = await runCli(root, current.args, home);
    assert.equal(result.code, 1, current.args.join(" "));
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(current.code), current.args.join(" "));
  }
  await assert.rejects(access(path.join(root, "--dry-run", "SKILL.md")), /ENOENT/);
});
