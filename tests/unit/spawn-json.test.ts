import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProcessJsonError, spawnJson, spawnParsedText } from "../../src/adapters/process/spawn-json.js";

const nodeScriptPrefix = ["--input-type=module", "-e"] as const;

function request(script: string, overrides: Partial<Parameters<typeof spawnJson>[0]> = {}): Parameters<typeof spawnJson>[0] {
  return {
    executable: process.execPath,
    argv: [...nodeScriptPrefix, script],
    input: { request: "fixture" },
    timeoutMs: 3_000,
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

async function executableFixture(t: test.TestContext, source: string): Promise<{ executable: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-executable-"));
  await chmod(root, 0o700);
  const executable = path.join(root, "provider");
  await writeFile(executable, source, { encoding: "utf8", mode: 0o700 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { executable, root };
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

test("spawnJson uses deterministic PATH for env-node shebangs", async (t) => {
  const fixture = await executableFixture(t, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,PATH:process.env.PATH}))\n");
  const result = await spawnJson({ ...request(""), executable: fixture.executable, argv: [] });

  assert.deepEqual(result.value, { ok: true, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` });
});

test("spawnJson passes only allowlisted absolute config paths and rejects credential env", async () => {
  const configHome = path.join(os.tmpdir(), `wspec-config-${crypto.randomUUID()}`);
  const script = "process.stdout.write(JSON.stringify({HOME:process.env.HOME,GH_CONFIG_DIR:process.env.GH_CONFIG_DIR,GH_TOKEN:process.env.GH_TOKEN}))";
  const result = await spawnJson(request(script, { environment: { HOME: configHome, GH_CONFIG_DIR: configHome } }));
  assert.deepEqual(result.value, { HOME: "[REDACTED]", GH_CONFIG_DIR: "[REDACTED]" });
  assert.equal(result.stdout.includes(configHome), false);

  await rejectsWithCode(
    spawnJson(request(script, { environment: { GH_TOKEN: "forbidden-secret" } })),
    "WSSPEC_PROCESS_REQUEST_INVALID",
  );
  await rejectsWithCode(
    spawnJson(request(script, { environment: { HOME: "relative/config" } })),
    "WSSPEC_PROCESS_REQUEST_INVALID",
  );
});

test("spawnJson treats every explicit environment value as a diagnostic secret", async () => {
  const shortHome = "/R";
  const error = await rejectsWithCode(spawnJson(request(
    "process.stderr.write(`HOME=${process.env.HOME} ordinary failure`);process.exitCode=2",
    { environment: { HOME: shortHome } },
  )), "WSSPEC_PROCESS_EXIT_NONZERO");

  assert.equal(error.diagnostic, "");
  assert.equal(JSON.stringify(error).includes(shortHome), false);
});

test("spawnJson rejects relative executables before spawning", async () => {
  await rejectsWithCode(spawnJson(request("", { executable: "node" })), "WSSPEC_PROCESS_EXECUTABLE_INVALID");
});

test("spawnJson preserves spawn failure when no process group was created", async (t) => {
  if (process.platform === "win32") return;
  const fixture = await executableFixture(t, "#!/definitely/missing/wsspec-interpreter\n");

  await rejectsWithCode(
    spawnJson({ ...request(""), executable: fixture.executable, argv: [] }),
    "WSSPEC_PROCESS_SPAWN_FAILED",
  );
});

test("spawnJson rejects writable executable paths and detects runtime identity changes", async (t) => {
  const writableFile = await executableFixture(t, `#!${process.execPath}\nprocess.stdout.write('{}')\n`);
  await chmod(writableFile.executable, 0o720);
  await rejectsWithCode(spawnJson({ ...request(""), executable: writableFile.executable, argv: [] }), "WSSPEC_PROCESS_EXECUTABLE_INVALID");

  const writableDirectory = await executableFixture(t, `#!${process.execPath}\nprocess.stdout.write('{}')\n`);
  await chmod(writableDirectory.root, 0o770);
  await rejectsWithCode(spawnJson({ ...request(""), executable: writableDirectory.executable, argv: [] }), "WSSPEC_PROCESS_EXECUTABLE_INVALID");

  const replaced = await executableFixture(t, [
    `#!${process.execPath}`,
    "const {writeFileSync}=require('node:fs')",
    "writeFileSync(__filename, '#!/bin/sh\\nexit 0\\n', {mode:0o700})",
    "process.stdout.write('{}')",
    "",
  ].join("\n"));
  await rejectsWithCode(spawnJson({ ...request(""), executable: replaced.executable, argv: [] }), "WSSPEC_PROCESS_EXECUTABLE_CHANGED");
});

test("timeout remains the primary error when executable identity also changes", async (t) => {
  const replaced = await executableFixture(t, [
    `#!${process.execPath}`,
    "const {writeFileSync}=require('node:fs')",
    "writeFileSync(__filename, '#!/bin/sh\\nexit 0\\n', {mode:0o700})",
    "setInterval(()=>{},1000)",
    "",
  ].join("\n"));

  await rejectsWithCode(
    spawnJson({ ...request("", { timeoutMs: 500 }), executable: replaced.executable, argv: [] }),
    "WSSPEC_PROCESS_TIMEOUT",
  );
});

test("spawnJson rejects oversized executables before spawning", async (t) => {
  const fixture = await executableFixture(t, `#!${process.execPath}\nprocess.stdout.write('{}')\n`);
  await truncate(fixture.executable, 128 * 1024 * 1024 + 1);

  await rejectsWithCode(
    spawnJson({ ...request(""), executable: fixture.executable, argv: [] }),
    "WSSPEC_PROCESS_EXECUTABLE_INVALID",
  );
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

  const error = await rejectsWithCode(spawnJson(request(script, { timeoutMs: 40 })), "WSSPEC_PROCESS_TIMEOUT");
  assert.equal(error.diagnostic, "");
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
  assert.equal(error.diagnostic, "");
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(readFile(marker), (caught: unknown) => (caught as NodeJS.ErrnoException).code === "ENOENT");
  await rm(marker, { force: true });
});

test("stderr overflow is bounded and returns no diagnostic", async () => {
  const error = await rejectsWithCode(spawnJson(request(
    "process.stderr.write('e'.repeat(8192));setInterval(()=>{},1000)",
    { maxStdoutBytes: 128 },
  )), "WSSPEC_PROCESS_OUTPUT_LIMIT");

  assert.equal(error.diagnostic, "");
});

test("signal exits are typed and Unicode limits count bytes", async () => {
  const signal = await rejectsWithCode(
    spawnJson(request("process.kill(process.pid,'SIGTERM')")),
    "WSSPEC_PROCESS_EXIT_NONZERO",
  );
  assert.equal(signal.exitCode, undefined);

  const unicode = "你";
  assert.equal((await spawnJson(request(`process.stdout.write(JSON.stringify(${JSON.stringify(unicode)}))`, { maxStdoutBytes: 5 }))).value, unicode);
  const overflow = await rejectsWithCode(
    spawnJson(request(`process.stdout.write(JSON.stringify(${JSON.stringify(unicode)}))`, { maxStdoutBytes: 4 })),
    "WSSPEC_PROCESS_OUTPUT_LIMIT",
  );
  assert.equal(overflow.diagnostic, "");
});

test("timeout returns only after the POSIX process group no longer exists", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const pidFile = path.join(os.tmpdir(), `wspec-process-group-${crypto.randomUUID()}`);
  const script = `const {writeFileSync}=await import('node:fs');writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  await rejectsWithCode(spawnJson(request(script, { timeoutMs: 80 })), "WSSPEC_PROCESS_TIMEOUT");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(-pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  await rm(pidFile, { force: true });
});

test("nonzero, signal, and invalid JSON failures clean same-group descendants", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  for (const [name, failureScript, code] of [
    ["nonzero", "process.stdout.write('{}');process.exitCode=7", "WSSPEC_PROCESS_EXIT_NONZERO"],
    ["signal", "process.kill(process.pid,'SIGTERM')", "WSSPEC_PROCESS_EXIT_NONZERO"],
    ["invalid-json", "process.stdout.write('not-json')", "WSSPEC_PROCESS_INVALID_JSON"],
  ] as const) {
    await t.test(name, async () => {
      const marker = path.join(os.tmpdir(), `wspec-failure-survivor-${crypto.randomUUID()}`);
      const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),300)`;
      const script = [
        "const {spawn}=await import('node:child_process')",
        `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
        "child.unref()",
        failureScript,
      ].join(";");

      await rejectsWithCode(spawnJson(request(script)), code);
      await new Promise((resolve) => setTimeout(resolve, 450));
      await assert.rejects(access(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
      await rm(marker, { force: true });
    });
  }
});

test("spawnParsedText cleans same-group descendants when its parser throws", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const marker = path.join(os.tmpdir(), `wspec-parser-survivor-${crypto.randomUUID()}`);
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),300)`;
  const script = [
    "const {spawn}=await import('node:child_process')",
    `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref()`,
    "process.stdout.write('parse-me')",
  ].join(";");

  await assert.rejects(
    spawnParsedText(request(script), () => { throw new Error("parser rejected output"); }),
    /parser rejected output/u,
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(access(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  await rm(marker, { force: true });
});

test("cleanup deadline fails closed with a dedicated sanitized error", { concurrency: false }, async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const pidFile = path.join(os.tmpdir(), `wspec-cleanup-deadline-${crypto.randomUUID()}`);
  const descendant = "setInterval(()=>{},1000)";
  const script = [
    "const {spawn}=await import('node:child_process')",
    "const {writeFileSync}=await import('node:fs')",
    `writeFileSync(${JSON.stringify(pidFile)},String(process.pid))`,
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    "child.unref()",
    "process.stdout.write('{}')",
    "process.exitCode=7",
  ].join(";");
  const realKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => pid < 0 ? true : realKill(pid, signal)) as typeof process.kill;
  try {
    const error = await rejectsWithCode(spawnJson(request(script)), "WSSPEC_PROCESS_CLEANUP_FAILED");
    assert.equal(error.diagnostic, "");
  } finally {
    process.kill = realKill;
    const pid = Number(await readFile(pidFile, "utf8"));
    try { realKill(-pid, "SIGKILL"); } catch { /* group already exited */ }
    await rm(pidFile, { force: true });
  }
});

test("output overflow never exposes a secret prefix cut at the capture boundary", async () => {
  const secret = "abcdefghijklmnop";
  const error = await rejectsWithCode(spawnJson(request(
    `process.stdout.write(${JSON.stringify(`12345678${secret}`)});setInterval(()=>{},1000)`,
    { maxStdoutBytes: 16, secrets: [secret] },
  )), "WSSPEC_PROCESS_OUTPUT_LIMIT");

  assert.equal(error.diagnostic, "");
  assert.equal(JSON.stringify(error).includes("abcdefgh"), false);
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

  assert.equal(error.diagnostic, "");
});

test("non-overflow diagnostics fail closed for short or reconstruction-prone secrets", async () => {
  const short = await rejectsWithCode(spawnJson(request(
    "process.stderr.write('ordinary failure R');process.exitCode=2",
    { secrets: ["R"] },
  )), "WSSPEC_PROCESS_EXIT_NONZERO");
  assert.equal(short.diagnostic, "");

  const reconstructed = await rejectsWithCode(spawnJson(request(
    "process.stdout.write('abcXdef');process.exitCode=2",
    { secrets: ["X", "abcdef"] },
  )), "WSSPEC_PROCESS_EXIT_NONZERO");
  assert.equal(["X", "abcdef"].some((secret) => reconstructed.diagnostic.includes(secret)), false);
});

test("non-overflow diagnostics remove Basic authorization and every Cookie segment", async () => {
  const error = await rejectsWithCode(spawnJson(request([
    "process.stderr.write('Authorization: Basic dXNlcjpwYXNz\\n')",
    "process.stderr.write('Authorization: Digest username=\\\"user\\\", response=\\\"digest-secret\\\"\\n')",
    "process.stderr.write('Authorization: Custom custom-secret-value\\n')",
    "process.stderr.write('Cookie: sid=first-secret; refresh=second-secret\\n')",
    "process.stderr.write('Set-Cookie: sid=first-secret; HttpOnly; refresh=second-secret')",
    "process.exitCode=2",
  ].join(";"))), "WSSPEC_PROCESS_EXIT_NONZERO");

  for (const secret of ["dXNlcjpwYXNz", "digest-secret", "custom-secret-value", "first-secret", "second-secret"]) {
    assert.equal(error.diagnostic.includes(secret), false);
  }
});

test("successful stdout remains configured-byte-bounded after redaction expansion", async () => {
  const result = await spawnJson(request("process.stdout.write(JSON.stringify('x'.repeat(100)))", {
    maxStdoutBytes: 128,
    secrets: ["x"],
  }));

  assert.ok(Buffer.byteLength(result.stdout) <= 128);
  assert.equal(result.stdout.includes("x"), false);
});
