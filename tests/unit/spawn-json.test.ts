import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProcessJsonError, spawnJson } from "../../src/adapters/process/spawn-json.js";

const nodeScriptPrefix = ["--input-type=module", "-e"] as const;

function request(script: string, overrides: Partial<Parameters<typeof spawnJson>[0]> = {}): Parameters<typeof spawnJson>[0] {
  return {
    executable: process.execPath,
    argv: [...nodeScriptPrefix, script],
    input: { request: "fixture" },
    timeoutMs: 1_000,
    maxStdoutBytes: 4_096,
    ...overrides,
  };
}

async function rejectsWithCode(promise: Promise<unknown>, code: ProcessJsonError["code"]): Promise<ProcessJsonError> {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof ProcessJsonError);
  assert.equal(caught.code, code);
  return caught;
}

test("spawnJson sends JSON on stdin and preserves shell metacharacters as one argv value", async () => {
  const metacharacter = "$(touch should-not-run); && | > `command`";
  const script = [
    "let input = ''",
    "process.stdin.setEncoding('utf8')",
    "for await (const chunk of process.stdin) input += chunk",
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), input: JSON.parse(input) }))",
  ].join(";");

  const result = await spawnJson(request(script, { argv: [...nodeScriptPrefix, script, metacharacter] }));

  assert.deepEqual(result.value, { argv: [metacharacter], input: { request: "fixture" } });
  assert.equal(result.exitCode, 0);
});

test("spawnJson does not inherit HOME or credential-bearing environment variables", async () => {
  const previous = { HOME: process.env.HOME, GH_TOKEN: process.env.GH_TOKEN, GITLAB_TOKEN: process.env.GITLAB_TOKEN };
  process.env.HOME = "/private/credential-home";
  process.env.GH_TOKEN = "inherited-gh-secret";
  process.env.GITLAB_TOKEN = "inherited-gitlab-secret";
  try {
    const script = "process.stdout.write(JSON.stringify({HOME:process.env.HOME,GH_TOKEN:process.env.GH_TOKEN,GITLAB_TOKEN:process.env.GITLAB_TOKEN,LANG:process.env.LANG}))";
    const result = await spawnJson(request(script));
    assert.deepEqual(result.value, { LANG: process.env.LANG });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("spawnJson rejects relative executables before spawning", async () => {
  await rejectsWithCode(spawnJson(request("", { executable: "node" })), "WSSPEC_PROCESS_EXECUTABLE_INVALID");
});

test("spawnJson validates JSON input before starting the executable", async () => {
  const marker = path.join(os.tmpdir(), `wspec-invalid-input-${crypto.randomUUID()}`);
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  await rejectsWithCode(
    spawnJson(request(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`, { input: circular })),
    "WSSPEC_PROCESS_REQUEST_INVALID",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(readFile(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  await rm(marker, { force: true });
});

test("timeout terminates the complete process group before rejecting", async () => {
  const marker = path.join(os.tmpdir(), `wspec-timeout-survivor-${crypto.randomUUID()}`);
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),300);setInterval(()=>{},1000)`;
  const script = [
    "const {spawn}=await import('node:child_process')",
    `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    "setInterval(()=>{},1000)",
  ].join(";");

  await rejectsWithCode(spawnJson(request(script, { timeoutMs: 40 })), "WSSPEC_PROCESS_TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(readFile(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  await rm(marker, { force: true });
});

test("stdout overflow terminates the complete process group and retains no unbounded diagnostic", async () => {
  const marker = path.join(os.tmpdir(), `wspec-size-survivor-${crypto.randomUUID()}`);
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),300);setInterval(()=>{},1000)`;
  const script = [
    "const {spawn}=await import('node:child_process')",
    `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    "process.stdout.write('x'.repeat(8192))",
    "setInterval(()=>{},1000)",
  ].join(";");

  const error = await rejectsWithCode(spawnJson(request(script, { maxStdoutBytes: 128 })), "WSSPEC_PROCESS_OUTPUT_LIMIT");
  assert.ok(Buffer.byteLength(error.diagnostic) <= 1_024);
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(readFile(marker), (caught: unknown) => (caught as NodeJS.ErrnoException).code === "ENOENT");
  await rm(marker, { force: true });
});

test("spawnJson rejects non-JSON stdout and nonzero exits with bounded diagnostics", async () => {
  const invalid = await rejectsWithCode(
    spawnJson(request("process.stdout.write('not-json');process.stderr.write('invalid response')")),
    "WSSPEC_PROCESS_INVALID_JSON",
  );
  assert.match(invalid.diagnostic, /not-json/u);

  const nonzero = await rejectsWithCode(
    spawnJson(request("process.stdout.write(JSON.stringify({ok:false}));process.stderr.write('denied');process.exitCode=7")),
    "WSSPEC_PROCESS_EXIT_NONZERO",
  );
  assert.equal(nonzero.exitCode, 7);
  assert.match(nonzero.diagnostic, /denied/u);
});

test("errors and parsed JSON never echo argv, stderr or structured secrets", async () => {
  const secret = "unique-process-secret-value";
  const parsed = await spawnJson(request(`process.stdout.write(JSON.stringify({payload:${JSON.stringify(secret)},Authorization:'Bearer another-secret'}))`, { secrets: [secret] }));
  assert.equal(JSON.stringify(parsed).includes(secret), false);
  assert.equal(JSON.stringify(parsed).includes("another-secret"), false);

  const script = `process.stderr.write('GH_TOKEN=${secret} Authorization: Bearer ${secret}');process.exitCode=2`;
  const error = await rejectsWithCode(spawnJson(request(script, { secrets: [secret] })), "WSSPEC_PROCESS_EXIT_NONZERO");
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  assert.equal(serialized.includes(secret), false);
  assert.equal("cause" in error, false);
  assert.ok(Buffer.byteLength(error.diagnostic) <= 1_024);
});

test("diagnostics remain byte-bounded even when redaction expands many short secrets", async () => {
  const error = await rejectsWithCode(
    spawnJson(request("process.stderr.write('x'.repeat(900));process.exitCode=2", { secrets: ["x"] })),
    "WSSPEC_PROCESS_EXIT_NONZERO",
  );

  assert.ok(Buffer.byteLength(error.diagnostic) <= 1_024);
  assert.equal(error.diagnostic.includes("x"), false);
});

test("successful stdout remains configured-byte-bounded after redaction expansion", async () => {
  const result = await spawnJson(request("process.stdout.write(JSON.stringify('x'.repeat(100)))", {
    maxStdoutBytes: 128,
    secrets: ["x"],
  }));

  assert.ok(Buffer.byteLength(result.stdout) <= 128);
  assert.equal(result.stdout.includes("x"), false);
});
