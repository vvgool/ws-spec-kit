import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
