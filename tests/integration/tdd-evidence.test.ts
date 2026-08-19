import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

import { computeWorkspaceTreeDigest, sha256 } from "../../src/domain/digests.js";
import { tddFailureDisposition } from "../../src/application/submit.js";
import { recordGreenEvidence } from "../../src/engine/tdd/green-gate.js";
import { isTestPath, recordRedEvidence } from "../../src/engine/tdd/red-gate.js";
import type { FixedTestGate, TddVerificationCode, TrustedEvidence } from "../../src/engine/tdd/types.js";
import {
  assertImplementHasTrustedRed,
  evaluateReviewFixEvidence,
  tddRedEvidenceKey,
  VerificationError,
} from "../../src/engine/verification.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { createGitRepository, git } from "./helpers/git.js";
import {
  completedResult,
  controlRuntimeFixture,
  requireExecute,
  retainOnlyReadyStage,
  rewriteSelectedSnapshot,
  submitPackage,
  worktreeFor,
} from "./helpers/control-runtime.js";

function featureTestSource(name = "feature remains red"): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import test from 'node:test';",
    `test(${JSON.stringify(name)}, () => assert.match(readFileSync('src/feature.mjs', 'utf8'), /value = 1/));`,
    "",
  ].join("\n");
}

async function workspace(testSource = featureTestSource()): Promise<string> {
  const root = await createGitRepository();
  await mkdir(path.join(root, "tests"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "tests", "feature.test.mjs"), testSource, "utf8");
  await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 0;\n", "utf8");
  await git(root, "add", "tests/feature.test.mjs", "src/feature.mjs");
  await git(root, "commit", "-m", "test: seed tdd workspace");
  return root;
}

function nodeGate(_script = "", timeoutMs = 2_000): FixedTestGate {
  return {
    commandId: "test",
    argv: [process.execPath, "--test", "tests/feature.test.mjs"],
    cwd: "worktree",
    timeoutMs,
    inheritEnv: [],
    env: {},
    testPathRules: ["node", "java", "ruby", "dotnet"],
    testAssetPaths: ["tests/**"],
    productPaths: ["src/**"],
    reporter: { type: "node-test", version: 1 },
  } as FixedTestGate;
}

function featureGate(): FixedTestGate {
  return nodeGate();
}

async function configureGate(root: string, gate: FixedTestGate): Promise<void> {
  await writeFile(path.join(root, ".wsspec", "config.yaml"), `${JSON.stringify({
    version: 1,
    testing: {
      pathRules: gate.testPathRules,
      testAssetPaths: (gate as FixedTestGate & { testAssetPaths: readonly string[] }).testAssetPaths,
      productPaths: (gate as FixedTestGate & { productPaths: readonly string[] }).productPaths,
    },
    quality: {
      gates: {
        test: {
          command: gate.argv,
          cwd: "worktree",
          timeoutSeconds: 2,
          required: true,
          evidence: "trusted",
          inheritEnv: [],
          env: {},
          reporter: gate.reporter,
        },
      },
    },
  })}\n`, "utf8");
}

async function redInput(root: string, gate: FixedTestGate, overrides: Record<string, unknown> = {}) {
  const workspaceDigest = await computeWorkspaceTreeDigest(root);
  return {
    taskId: "WSS-TDD",
    step: { id: "verify-red", uses: "command.execute", action: "quality.test", expectedOutcome: "test-failure" },
    gate,
    worktree: root,
    workspaceDigest,
    modifiedFiles: ["tests/feature.test.mjs"],
    testPaths: ["tests/feature.test.mjs"],
    ...overrides,
  };
}

test("Red executes only the project-fixed argv and records bounded redacted trusted evidence", async () => {
  const root = await workspace([
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    `console.log(${JSON.stringify("token-super-secret-value\n".repeat(4_000))});`,
    "test('rejects missing behavior', () => assert.equal(1, 2));",
    "",
  ].join("\n"));
  const injected = path.join(root, "agent-command-ran");
  const secret = "token-super-secret-value";
  const evidence = await recordRedEvidence(await redInput(root, nodeGate(), {
    agentCommand: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(injected)}, 'bad')`],
    secrets: [secret],
  }));

  assert.equal(evidence.level, "trusted");
  assert.equal(evidence.phase, "red");
  assert.equal(evidence.commandId, "test");
  assert.equal(evidence.exitCode, 1);
  assert.deepEqual(evidence.failedTests, ["rejects missing behavior"]);
  assert.equal(evidence.workspaceDigest, await computeWorkspaceTreeDigest(root));
  assert.equal(evidence.testPathsDigest, sha256(`${JSON.stringify({
    version: 1,
    files: [{ path: "tests/feature.test.mjs", digest: sha256(await readFile(path.join(root, "tests", "feature.test.mjs"))) }],
  })}\n`));
  assert.ok(evidence.summary.length <= 8_192);
  assert.ok(!evidence.summary.includes(secret));
  const secretFailureRoot = await workspace([
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    `test(${JSON.stringify(secret)}, () => assert.equal(1, 2));`,
    "",
  ].join("\n"));
  const secretFailure = await recordRedEvidence(await redInput(
    secretFailureRoot,
    nodeGate(),
    { secrets: [secret] },
  ));
  assert.deepEqual(secretFailure.failedTests, ["[REDACTED]"]);
  await assert.rejects(readFile(injected, "utf8"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("Red accepts only test-path changes and an actual test assertion failure", async () => {
  const root = await workspace();
  const failing = featureGate();

  await assert.rejects(
    recordRedEvidence(await redInput(root, failing, { modifiedFiles: ["tests/feature.test.mjs", "src/feature.mjs"] })),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_SCOPE_INVALID",
  );
  const syntaxRoot = await workspace("this is not valid JavaScript {\n");
  await assert.rejects(
    recordRedEvidence(await redInput(syntaxRoot, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_SYNTAX_FAILURE",
  );
  const missingRoot = await workspace("import 'package-that-does-not-exist';\n");
  await assert.rejects(
    recordRedEvidence(await redInput(missingRoot, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE",
  );
  const hangingRoot = await workspace("import test from 'node:test';\ntest('hangs', async () => new Promise(() => {}));\n");
  await assert.rejects(
    recordRedEvidence(await redInput(hangingRoot, nodeGate("", 50))),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_TIMEOUT",
  );
  const timeoutRoot = await workspace([
    "import { spawn } from 'node:child_process';",
    "import test from 'node:test';",
    "test('hangs with descendant', async () => {",
    "  spawn(process.execPath, ['-e', process.env.WSSPEC_GRANDCHILD], { stdio: 'ignore' });",
    "  await new Promise(() => {});",
    "});",
    "",
  ].join("\n"));
  const survivor = path.join(timeoutRoot, "survivor");
  const grandchild = [
    "process.on('SIGTERM', () => {})",
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survivor)}, 'bad'), 600)`,
    "setInterval(() => {}, 1000)",
  ].join(";");
  const timeoutGate = { ...nodeGate("", 50), env: { WSSPEC_GRANDCHILD: grandchild } };
  await assert.rejects(
    recordRedEvidence(await redInput(timeoutRoot, timeoutGate)),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_TIMEOUT",
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  await assert.rejects(readFile(survivor, "utf8"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const passingRoot = await workspace("import test from 'node:test';\ntest('already green', () => {});\n");
  await assert.rejects(
    recordRedEvidence(await redInput(passingRoot, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_NOT_OBSERVED",
  );
  const mutatingRoot = await workspace([
    "import assert from 'node:assert/strict';",
    "import { writeFileSync } from 'node:fs';",
    "import test from 'node:test';",
    "test('mutates workspace', () => { writeFileSync('src/feature.mjs', 'mutated'); assert.equal(1, 2); });",
    "",
  ].join("\n"));
  await assert.rejects(
    recordRedEvidence(await redInput(mutatingRoot, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
  );
});

test("Red rejects global syntax and dependency failures outside the asserted test paths", async () => {
  for (const [name, source, code] of [
    ["syntax", "this is not valid JavaScript {\n", "WSSPEC_TDD_RED_SYNTAX_FAILURE"],
    ["dependency", "import 'package-that-does-not-exist';\n", "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE"],
  ] as const) {
    const root = await workspace();
    await writeFile(path.join(root, "tests", `existing-${name}.test.mjs`), source, "utf8");
    await git(root, "add", `tests/existing-${name}.test.mjs`);
    await git(root, "commit", "-m", `test: seed global ${name} failure`);
    const gate = {
      ...featureGate(),
      argv: [process.execPath, "--test", "tests/feature.test.mjs", `tests/existing-${name}.test.mjs`],
    };

    await assert.rejects(
      recordRedEvidence(await redInput(root, gate)),
      (error: unknown) => error instanceof VerificationError && error.code === code,
    );
  }
});

test("Red fails closed when the structured reporter truncates more than 100 failures", async () => {
  const source = [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    ...Array.from({ length: 101 }, (_, index) => `test('failure ${index}', () => assert.equal(1, 2));`),
    "",
  ].join("\n");
  const root = await workspace(source);

  await assert.rejects(
    recordRedEvidence(await redInput(root, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_REPORT_INVALID",
  );
});

test("trusted Red rejects forged reporter text and signal termination", async () => {
  const root = await workspace("console.log('not ok 1 - forged'); process.exit(1);\n");
  await assert.rejects(
    recordRedEvidence(await redInput(root, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE",
  );
  const signalRoot = await workspace("process.kill(process.ppid, 'SIGKILL'); setInterval(() => {}, 1000);\n");
  const signalGate = featureGate();
  await assert.rejects(
    recordRedEvidence(await redInput(signalRoot, signalGate)),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE",
  );
});

test("timeout waits for process-group SIGKILL cleanup before the calling CLI can exit", async () => {
  const root = await workspace([
    "import { spawn } from 'node:child_process';",
    "import test from 'node:test';",
    "test('hangs with descendant', async () => { spawn(process.execPath, ['-e', process.env.WSSPEC_GRANDCHILD], { stdio: 'ignore' }); await new Promise(() => {}); });",
    "",
  ].join("\n"));
  const survivor = path.join(root, "survivor-after-cli-exit");
  const grandchild = [
    "process.on('SIGTERM', () => {})",
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survivor)}, 'bad'), 600)`,
    "setInterval(() => {}, 1000)",
  ].join(";");
  const moduleUrl = new URL("../../src/engine/tdd/red-gate.ts", import.meta.url).href;
  const digestUrl = new URL("../../src/domain/digests.ts", import.meta.url).href;
  const innerScript = [
    `import { recordRedEvidence } from ${JSON.stringify(moduleUrl)}`,
    `import { computeWorkspaceTreeDigest } from ${JSON.stringify(digestUrl)}`,
    `const root = ${JSON.stringify(root)}`,
    "await recordRedEvidence({",
    "taskId: 'WSS-TDD', step: { id: 'verify-red', uses: 'command.execute', action: 'quality.test', expectedOutcome: 'test-failure' },",
    `gate: ${JSON.stringify({ ...nodeGate("", 50), env: { WSSPEC_GRANDCHILD: grandchild } })}, worktree: root, workspaceDigest: await computeWorkspaceTreeDigest(root),`,
    "modifiedFiles: ['tests/feature.test.mjs'], testPaths: ['tests/feature.test.mjs']",
    "}).catch(() => {})",
  ].join("\n");
  const inner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", innerScript], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    stdio: "ignore",
  });
  await once(inner, "close");
  await new Promise((resolve) => setTimeout(resolve, 900));
  await assert.rejects(readFile(survivor, "utf8"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("test path rules are explicit and cover Node, Java, Ruby and .NET layouts", () => {
  assert.equal(isTestPath("tests/feature.test.mjs", ["node"]), true);
  assert.equal(isTestPath("src/test/java/com/example/FooTest.java", ["java"]), true);
  assert.equal(isTestPath("test/models/user_test.rb", ["ruby"]), true);
  assert.equal(isTestPath("Tests/Feature/FooTests.cs", ["dotnet"]), true);
  assert.equal(isTestPath("src/feature.ts", ["node", "java", "ruby", "dotnet"]), false);
});

test("Red and Green bind inherited environment values into the command identity", async () => {
  const root = await workspace();
  const name = "WSSPEC_TDD_MODE";
  const previous = process.env[name];
  const gate = {
    ...nodeGate(`const red = process.env.${name} === 'red'; process.stdout.write(red ? 'not ok 1 - inherited mode\\n' : 'ok 1 - inherited mode\\n'); process.exitCode = red ? 1 : 0`),
    inheritEnv: [name],
  };
  try {
    process.env[name] = "red";
    const red = await recordRedEvidence(await redInput(root, gate));
    await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 1;\n", "utf8");
    process.env[name] = "green";
    await assert.rejects(
      recordGreenEvidence({
        taskId: "WSS-TDD",
        step: { id: "verify-green", uses: "command.execute", action: "quality.test", expectedOutcome: "success" },
        gate,
        worktree: root,
        workspaceDigest: await computeWorkspaceTreeDigest(root),
        redEvidence: red,
      }),
      (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
    );
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("Red and Green bind PATH resolution to the same executable identity", async () => {
  const root = await workspace();
  const redBin = path.join(root, "red-bin");
  const greenBin = path.join(root, "green-bin");
  await mkdir(redBin);
  await mkdir(greenBin);
  const command = "wsspec-test-runner";
  await link(process.execPath, path.join(redBin, command));
  await link(process.execPath, path.join(greenBin, command));
  const previousPath = process.env.PATH;
  const gate: FixedTestGate = {
    ...nodeGate(""),
    argv: [command, "--test", "tests/feature.test.mjs"],
  };
  try {
    process.env.PATH = `${redBin}${path.delimiter}${previousPath ?? ""}`;
    const red = await recordRedEvidence(await redInput(root, gate));
    await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 1;\n", "utf8");
    process.env.PATH = `${greenBin}${path.delimiter}${previousPath ?? ""}`;
    await assert.rejects(
      recordGreenEvidence({
        taskId: "WSS-TDD",
        step: { id: "verify-green", uses: "command.execute", action: "quality.test", expectedOutcome: "success" },
        gate,
        worktree: root,
        workspaceDigest: await computeWorkspaceTreeDigest(root),
        redEvidence: red,
      }),
      (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

async function validRed(root: string): Promise<TrustedEvidence> {
  return recordRedEvidence(await redInput(root, featureGate()));
}

test("Green requires the same command and unchanged Red tests, then binds a zero exit to the cycle", async () => {
  const root = await workspace();
  const red = await validRed(root);
  await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 1;\n", "utf8");
  const workspaceDigest = await computeWorkspaceTreeDigest(root);

  const cycle = await recordGreenEvidence({
    taskId: "WSS-TDD",
    step: { id: "verify-green", uses: "command.execute", action: "quality.test", expectedOutcome: "success" },
    gate: featureGate(),
    worktree: root,
    workspaceDigest,
    redEvidence: red,
  });

  assert.deepEqual(cycle.testPaths, ["tests/feature.test.mjs"]);
  assert.equal(cycle.commandId, "test");
  assert.equal(cycle.redEvidenceId, red.evidenceId);
  assert.match(cycle.greenEvidenceId, /^evidence-/u);
  assertImplementHasTrustedRed({ taskId: "WSS-TDD", commandId: "test", worktree: root, redEvidence: red });

  await assert.rejects(
    recordGreenEvidence({
      taskId: "WSS-TDD",
      step: { id: "verify-green", uses: "command.execute", action: "quality.test", expectedOutcome: "success" },
      gate: { ...nodeGate("process.exitCode = 0"), commandId: "different" },
      worktree: root,
      workspaceDigest,
      redEvidence: red,
    }),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
  );
});

test("deleting or weakening the Red test invalidates implement and Green evidence", async () => {
  const root = await workspace();
  const red = await validRed(root);
  await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 2;\n", "utf8");
  await assert.rejects(
    assertImplementHasTrustedRed({ taskId: "WSS-TDD", commandId: "test", gate: featureGate(), worktree: root, redEvidence: red, requireWorkspaceMatch: true }),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
  );
  await writeFile(path.join(root, "tests", "feature.test.mjs"), "// no assertions\n", "utf8");

  assert.throws(
    () => assertImplementHasTrustedRed({ taskId: "WSS-TDD", commandId: "test", worktree: root, redEvidence: undefined }),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_REQUIRED",
  );
  await assert.rejects(
    assertImplementHasTrustedRed({ taskId: "WSS-TDD", commandId: "test", worktree: root, redEvidence: red }),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
  );
  await assert.rejects(
    recordGreenEvidence({
      taskId: "WSS-TDD",
      step: { id: "verify-green", uses: "command.execute", action: "quality.test", expectedOutcome: "success" },
      gate: nodeGate("process.exitCode = 0"),
      worktree: root,
      workspaceDigest: await computeWorkspaceTreeDigest(root),
      redEvidence: red,
    }),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
  );
});

test("trusted Red binds the configured helper, fixture, snapshot, config and indirect import scope", async () => {
  const root = await workspace([
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { expected } from './support/helper.mjs';",
    "test('uses the complete test asset graph', async () => assert.equal(await expected(), 1));",
    "",
  ].join("\n"));
  await mkdir(path.join(root, "tests", "support"), { recursive: true });
  await mkdir(path.join(root, "tests", "fixtures"), { recursive: true });
  await mkdir(path.join(root, "tests", "snapshots"), { recursive: true });
  await writeFile(path.join(root, "tests", "support", "helper.mjs"), [
    "import { createRequire } from 'node:module';",
    "import config from '../test.config.mjs';",
    "const require = createRequire(import.meta.url);",
    "const { snapshot, product } = require('./reader.cjs');",
    "export async function expected() {",
    "  const { fixture } = await import('../fixtures/value.mjs');",
    "  return product + fixture + snapshot + config.offset;",
    "}",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "tests", "support", "reader.cjs"), [
    "const { readFileSync } = require('node:fs');",
    "exports.snapshot = Number(readFileSync(new URL('../snapshots/value.txt', `file://${__filename}`), 'utf8'));",
    "exports.product = Number(/value = (\\d+)/.exec(readFileSync('src/feature.mjs', 'utf8'))?.[1]);",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "tests", "fixtures", "value.mjs"), "export const fixture = 0;\n", "utf8");
  await writeFile(path.join(root, "tests", "snapshots", "value.txt"), "0\n", "utf8");
  await writeFile(path.join(root, "tests", "test.config.mjs"), "export default { offset: 0 };\n", "utf8");
  await git(root, "add", "tests", "src/feature.mjs");
  await git(root, "commit", "-m", "test: seed traced test assets");

  const gate = nodeGate();
  const red = await recordRedEvidence(await redInput(root, gate));
  const bound = red as TrustedEvidence & { testAssets: Array<{ path: string; digest: string }>; testAssetsDigest: string };
  assert.deepEqual(bound.testAssets.map(({ path: filename }) => filename), [
    "tests/feature.test.mjs",
    "tests/fixtures/value.mjs",
    "tests/snapshots/value.txt",
    "tests/support/helper.mjs",
    "tests/support/reader.cjs",
    "tests/test.config.mjs",
  ]);
  assert.match(bound.testAssetsDigest, /^sha256:/u);

  await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 1;\n", "utf8");
  await assert.doesNotReject(assertImplementHasTrustedRed({ taskId: "WSS-TDD", commandId: "test", gate, worktree: root, redEvidence: red }));

  for (const [filename, replacement] of [
    ["tests/support/helper.mjs", "export function expected() { return 1; }\n"],
    ["tests/fixtures/value.mjs", "export const fixture = 1;\n"],
    ["tests/snapshots/value.txt", "1\n"],
    ["tests/test.config.mjs", "export default { offset: 1 };\n"],
  ] as const) {
    const absolute = path.join(root, filename);
    const original = await readFile(absolute, "utf8");
    await writeFile(absolute, replacement, "utf8");
    await assert.rejects(
      assertImplementHasTrustedRed({ taskId: "WSS-TDD", commandId: "test", gate, worktree: root, redEvidence: red }),
      (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
      filename,
    );
    await writeFile(absolute, original, "utf8");
  }
});

test("trusted Red binds every regular file in the configured test asset scope despite trace replacement", async () => {
  const root = await workspace([
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import test from 'node:test';",
    "import { expected } from './support/helper.mjs';",
    "const traceDir = process.env.WS_SPEC_TDD_TRACE_DIR;",
    "if (traceDir) {",
    "  for (const name of fs.readdirSync(traceDir)) fs.unlinkSync(path.join(traceDir, name));",
    "  fs.writeFileSync(path.join(traceDir, `trace-${process.pid}.jsonl`), `${JSON.stringify({ version: 1, path: path.resolve('tests/feature.test.mjs') })}\\n`);",
    "}",
    "test('replacement probe stays red', () => assert.equal(expected, 1));",
    "",
  ].join("\n"));
  await mkdir(path.join(root, "tests", "support"), { recursive: true });
  await mkdir(path.join(root, "tests", "fixtures"), { recursive: true });
  await mkdir(path.join(root, "tests", "__snapshots__"), { recursive: true });
  await writeFile(path.join(root, "tests", "support", "helper.mjs"), "export const expected = 0;\n", "utf8");
  await writeFile(path.join(root, "tests", "fixtures", "unused.json"), "{\"value\":0}\n", "utf8");
  await writeFile(path.join(root, "tests", "__snapshots__", "unused.snap"), "snapshot 0\n", "utf8");
  await writeFile(path.join(root, "tests", "test.config.json"), "{\"mode\":\"red\"}\n", "utf8");
  await git(root, "add", "tests");
  await git(root, "commit", "-m", "test: seed complete configured asset scope");

  const gate = featureGate();
  const red = await recordRedEvidence(await redInput(root, gate));
  assert.deepEqual(red.testPaths, ["tests/feature.test.mjs"]);
  assert.deepEqual(red.testAssets.map(({ path: filename }) => filename), [
    "tests/__snapshots__/unused.snap",
    "tests/feature.test.mjs",
    "tests/fixtures/unused.json",
    "tests/support/helper.mjs",
    "tests/test.config.json",
  ]);

  await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 1;\n", "utf8");
  await assert.doesNotReject(assertImplementHasTrustedRed({ taskId: "WSS-TDD", commandId: "test", gate, worktree: root, redEvidence: red }));

  for (const [name, mutate, restore] of [
    ["modified helper", () => writeFile(path.join(root, "tests", "support", "helper.mjs"), "export const expected = 1;\n", "utf8"), () => writeFile(path.join(root, "tests", "support", "helper.mjs"), "export const expected = 0;\n", "utf8")],
    ["new fixture", () => writeFile(path.join(root, "tests", "fixtures", "new.json"), "{}\n", "utf8"), () => rm(path.join(root, "tests", "fixtures", "new.json"))],
    ["deleted snapshot", () => rm(path.join(root, "tests", "__snapshots__", "unused.snap")), () => writeFile(path.join(root, "tests", "__snapshots__", "unused.snap"), "snapshot 0\n", "utf8")],
    ["modified config", () => writeFile(path.join(root, "tests", "test.config.json"), "{\"mode\":\"green\"}\n", "utf8"), () => writeFile(path.join(root, "tests", "test.config.json"), "{\"mode\":\"red\"}\n", "utf8")],
  ] as const) {
    await mutate();
    await assert.rejects(
      assertImplementHasTrustedRed({ taskId: "WSS-TDD", commandId: "test", gate, worktree: root, redEvidence: red }),
      (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_EVIDENCE_INVALIDATED",
      name,
    );
    await restore();
  }
});

test("configured test asset scope fails closed on symlinks, ambiguous classification, entry limits and byte limits", async () => {
  const symlinkRoot = await workspace();
  await writeFile(path.join(symlinkRoot, "outside-test-asset.txt"), "outside\n", "utf8");
  await symlink(path.join(symlinkRoot, "outside-test-asset.txt"), path.join(symlinkRoot, "tests", "linked-fixture.txt"));
  await assert.rejects(
    async () => recordRedEvidence(await redInput(symlinkRoot, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_TEST_PATH_INVALID",
  );

  const ambiguousRoot = await workspace();
  const ambiguousGate = { ...featureGate(), productPaths: ["src/**", "tests/**"] };
  await assert.rejects(
    recordRedEvidence(await redInput(ambiguousRoot, ambiguousGate)),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_GATE_CONFIGURATION_INVALID",
  );

  const entryRoot = await workspace();
  await mkdir(path.join(entryRoot, "tests", "generated"), { recursive: true });
  await Promise.all(Array.from({ length: 4_096 }, (_, index) => writeFile(path.join(entryRoot, "tests", "generated", `${index}.txt`), "", "utf8")));
  await assert.rejects(
    recordRedEvidence(await redInput(entryRoot, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_TEST_PATH_INVALID",
  );

  const byteRoot = await workspace();
  await writeFile(path.join(byteRoot, "tests", "oversized.fixture"), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(
    recordRedEvidence(await redInput(byteRoot, featureGate())),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_TEST_PATH_INVALID",
  );
});

test("Review-Fix appends Green for production changes and restarts at write-tests for test changes", async () => {
  const root = await workspace();
  const red = await validRed(root);
  await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 1;\n", "utf8");
  const first = await recordGreenEvidence({
    taskId: "WSS-TDD",
    step: { id: "verify-green", uses: "command.execute", action: "quality.test", expectedOutcome: "success" },
    gate: featureGate(),
    worktree: root,
    workspaceDigest: await computeWorkspaceTreeDigest(root),
    redEvidence: red,
  });

  assert.deepEqual(evaluateReviewFixEvidence({ modifiedFiles: ["src/feature.mjs"], cycle: first }), {
    action: "append-green",
    commandId: "test",
  });
  assert.deepEqual(evaluateReviewFixEvidence({ modifiedFiles: ["tests/feature.test.mjs"], cycle: first }), {
    action: "restart-cycle",
    nextStepId: "write-tests",
  });
  assert.deepEqual(evaluateReviewFixEvidence({ modifiedFiles: ["tests/new-regression.test.mjs"], cycle: first }), {
    action: "restart-cycle",
    nextStepId: "write-tests",
  });
});

test("Application acquire blocks implement without Red and consumes trusted Red internally for verify-green", async () => {
  const blocked = await controlRuntimeFixture();
  await configureGate(blocked.root, featureGate());
  await git(blocked.root, "add", ".wsspec/config.yaml");
  await git(blocked.root, "commit", "-m", "test: configure blocked TDD gate");
  const blockedStarted = await blocked.app.start({
    root: blocked.root,
    source: { type: "prompt", text: "TDD acquire gate" },
    profile: "standard",
  });
  await retainOnlyReadyStage(blocked, blockedStarted.workItemId, "implement");
  await assert.rejects(
    blocked.app.acquire({ root: blocked.root, workItemId: blockedStarted.workItemId, actor: "implementer" }),
    (error: unknown) => error instanceof VerificationError && error.code === "WSSPEC_TDD_RED_REQUIRED",
  );

  const current = await controlRuntimeFixture();
  await mkdir(path.join(current.root, "tests"), { recursive: true });
  await mkdir(path.join(current.root, "src"), { recursive: true });
  await writeFile(path.join(current.root, "tests", "feature.test.mjs"), featureTestSource(), "utf8");
  await writeFile(path.join(current.root, "src", "feature.mjs"), "export const value = 0;\n", "utf8");
  const gate = featureGate();
  await configureGate(current.root, gate);
  await git(current.root, "add", ".wsspec/config.yaml", "tests/feature.test.mjs", "src/feature.mjs");
  await git(current.root, "commit", "-m", "test: configure fixed TDD gate");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "TDD internal evidence" }, profile: "standard" });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const red = await recordRedEvidence(await redInput(worktree, gate, { taskId: started.workItemId }));
  await mutateControlPlane({
    cwd: current.root,
    workItemId: started.workItemId,
    eventType: "evidence.recorded",
    idempotencyKey: "test:tdd:red",
    operationInput: red,
    mutate: (projection) => ({
      projection: { ...projection, evidence: { ...projection.evidence, [tddRedEvidenceKey(started.workItemId)]: red } },
      value: null,
    }),
  });
  await retainOnlyReadyStage(current, started.workItemId, "verify-green");

  await writeFile(path.join(worktree, "src", "feature.mjs"), "export const value = 1;\n", "utf8");

  const workPackage = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "engine" }));
  assert.equal(workPackage.stepId, "verify-green");
  assert.deepEqual(workPackage.artifacts, []);
  await submitPackage(current, workPackage, {
    ...completedResult(workPackage, []),
    modifiedFiles: [],
    commands: [{ argv: ["false"] }],
    evidence: [{ level: "trusted", result: "failed" }],
  });
  const greenProjection = await readControlPlane(current.root, started.workItemId);
  const cycle = greenProjection.evidence[`tdd:${started.workItemId}:cycle`] as { commandId: string; redEvidenceId: string; greenEvidenceId: string };
  assert.equal(cycle.commandId, "test");
  assert.equal(cycle.redEvidenceId, red.evidenceId);
  assert.match(cycle.greenEvidenceId, /^evidence-/u);
});

async function applicationVerifyGreen(testSource = featureTestSource()) {
  const current = await controlRuntimeFixture();
  await mkdir(path.join(current.root, "tests"), { recursive: true });
  await mkdir(path.join(current.root, "src"), { recursive: true });
  await writeFile(path.join(current.root, "tests", "feature.test.mjs"), testSource, "utf8");
  await writeFile(path.join(current.root, "src", "feature.mjs"), "export const value = 0;\n", "utf8");
  const gate = featureGate();
  await configureGate(current.root, gate);
  await git(current.root, "add", ".wsspec/config.yaml", "tests/feature.test.mjs", "src/feature.mjs");
  await git(current.root, "commit", "-m", "test: configure Green recovery gate");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "recover Green outcome" }, profile: "standard" });
  await rewriteSelectedSnapshot(current, started.workItemId, (profile) => {
    const implement = profile.steps.find(({ id }) => id === "implement");
    assert.ok(implement);
    implement.inputs = (implement.inputs as Array<{ artifact: string }>).filter(({ artifact }) => artifact !== "tasks");
  });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const red = await recordRedEvidence(await redInput(worktree, gate, { taskId: started.workItemId }));
  await retainOnlyReadyStage(current, started.workItemId, "verify-green");
  await mutateControlPlane({
    cwd: current.root,
    workItemId: started.workItemId,
    eventType: "evidence.recorded",
    idempotencyKey: "test:tdd:green-recovery-red",
    operationInput: red,
    mutate: (projection) => ({
      projection: { ...projection, evidence: { ...projection.evidence, [tddRedEvidenceKey(started.workItemId)]: red } },
      value: null,
    }),
  });
  return { current, started, worktree, red };
}

test("Green assertion failure atomically routes to implement and replays idempotently after recovery", async () => {
  const { current, started } = await applicationVerifyGreen();
  const verifyGreen = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "engine" }));

  const action = await submitPackage(current, verifyGreen, completedResult(verifyGreen, []));
  assert.equal(action.action, "execute");
  if (action.action !== "execute") return;
  assert.equal(action.workPackage.stepId, "implement");
  assert.deepEqual(await submitPackage(current, verifyGreen, completedResult(verifyGreen, [])), action);

  const projection = await readControlPlane(current.root, started.workItemId);
  assert.equal(projection.claims["verify-green"], undefined);
  assert.equal(projection.stages["verify-green"]?.status, "pending");
  assert.equal(projection.evidence[tddRedEvidenceKey(started.workItemId)] !== undefined, true);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: current.root, workItemId: started.workItemId });
  assert.equal(recovered.stages.implement?.status, "ready");
  assert.equal(recovered.claims.implement, undefined);
  assert.equal(recovered.retries.implement?.status, "ready");
  assert.deepEqual(recovered.evidence, projection.evidence);
});

test("Green timeout persists a retryable failed Attempt and releases its Claim", async () => {
  const source = [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import test from 'node:test';",
    "test('red then hangs', async () => {",
    "  const source = readFileSync('src/feature.mjs', 'utf8');",
    "  if (/value = 1/.test(source)) await new Promise(() => {});",
    "  assert.match(source, /value = 1/);",
    "});",
    "",
  ].join("\n");
  const { current, started, worktree } = await applicationVerifyGreen(source);
  await writeFile(path.join(worktree, "src", "feature.mjs"), "export const value = 1;\n", "utf8");
  const verifyGreen = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "engine" }));

  const action = await submitPackage(current, verifyGreen, completedResult(verifyGreen, []));
  assert.equal(action.action, "blocked");
  if (action.action !== "blocked") return;
  assert.equal(action.problems[0]?.retryable, true);
  const projection = await readControlPlane(current.root, started.workItemId);
  assert.equal(projection.claims["verify-green"], undefined);
  assert.equal(projection.stages["verify-green"]?.status, "failed");
  assert.equal(projection.retries["verify-green"]?.status, "ready");
  assert.equal((projection.contexts["verify-green"] as { result?: { status?: string } }).result?.status, "failed");
});

test("typed TDD outcomes classify exhaustively for Red, Green, and Review-Fix verify", () => {
  const cases: Array<[TddVerificationCode, "restart-red" | "restart-implementation" | "retry" | "fail-closed", "retry" | "fail-closed"]> = [
    ["WSSPEC_TDD_RED_NOT_OBSERVED", "restart-red", "fail-closed"],
    ["WSSPEC_TDD_RED_SCOPE_INVALID", "restart-red", "fail-closed"],
    ["WSSPEC_TDD_RED_SYNTAX_FAILURE", "restart-red", "retry"],
    ["WSSPEC_TDD_REPORT_INVALID", "restart-red", "retry"],
    ["WSSPEC_TDD_GREEN_NOT_OBSERVED", "fail-closed", "retry"],
    ["WSSPEC_TDD_GATE_EXECUTION_FAILED", "retry", "retry"],
    ["WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE", "retry", "retry"],
    ["WSSPEC_TDD_RED_TIMEOUT", "retry", "retry"],
    ["WSSPEC_TDD_EVIDENCE_INVALIDATED", "fail-closed", "fail-closed"],
    ["WSSPEC_TDD_GATE_CONFIGURATION_INVALID", "fail-closed", "fail-closed"],
    ["WSSPEC_TDD_RED_REQUIRED", "fail-closed", "fail-closed"],
    ["WSSPEC_TDD_REPORTER_UNSUPPORTED", "fail-closed", "fail-closed"],
    ["WSSPEC_TDD_STEP_INVALID", "fail-closed", "fail-closed"],
    ["WSSPEC_TDD_TEST_PATH_INVALID", "fail-closed", "fail-closed"],
  ];
  for (const [code, red, reviewVerify] of cases) {
    assert.equal(tddFailureDisposition({ phase: "red", internal: false }, code), red);
    assert.equal(tddFailureDisposition({ phase: "green", internal: true }, code), reviewVerify);
  }
  assert.equal(tddFailureDisposition({ phase: "green", internal: false }, "WSSPEC_TDD_GREEN_NOT_OBSERVED"), "restart-implementation");
});

test("TDD workspace drift fails closed, releases the Claim, and recovers the same projection", async () => {
  const { current, started, worktree } = await applicationVerifyGreen();
  await writeFile(path.join(worktree, "src", "feature.mjs"), "export const value = 1;\n", "utf8");
  const verifyGreen = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "engine" }));
  await writeFile(path.join(worktree, "src", "feature.mjs"), "export const value = 2;\n", "utf8");

  const action = await submitPackage(current, verifyGreen, { ...completedResult(verifyGreen, []), modifiedFiles: ["src/feature.mjs"] });
  assert.equal(action.action, "blocked");
  if (action.action !== "blocked") return;
  assert.equal(action.problems[0]?.code, "WSSPEC_STEP_INPUT_INVALID");
  assert.equal(action.problems[0]?.retryable, false);
  const projection = await readControlPlane(current.root, started.workItemId);
  assert.equal(projection.claims["verify-green"], undefined);
  assert.equal(projection.retries["verify-green"], undefined);
  assert.equal(projection.stages["verify-green"]?.status, "failed");
  assert.equal((projection.contexts["verify-green"] as { result?: { failureCode?: string } }).result?.failureCode, "WSSPEC_STEP_INPUT_INVALID");
  assert.deepEqual(await submitPackage(current, verifyGreen, { ...completedResult(verifyGreen, []), modifiedFiles: ["src/feature.mjs"] }), action);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: current.root, workItemId: started.workItemId });
  assert.deepEqual(recovered.claims, projection.claims);
  assert.deepEqual(recovered.stages, projection.stages);
  assert.deepEqual(recovered.contexts, projection.contexts);
});

test("Application submit replaces Agent-reported Red with engine-executed trusted evidence", async () => {
  const current = await controlRuntimeFixture();
  await mkdir(path.join(current.root, "tests"), { recursive: true });
  await mkdir(path.join(current.root, "src"), { recursive: true });
  await writeFile(path.join(current.root, "tests", "feature.test.mjs"), featureTestSource(), "utf8");
  await writeFile(path.join(current.root, "src", "feature.mjs"), "export const value = 0;\n", "utf8");
  await configureGate(current.root, featureGate());
  await git(current.root, "add", ".wsspec/config.yaml", "tests/feature.test.mjs", "src/feature.mjs");
  await git(current.root, "commit", "-m", "test: configure submit TDD gate");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "TDD submit trust" }, profile: "standard" });
  await retainOnlyReadyStage(current, started.workItemId, "verify-red");
  await mutateControlPlane({
    cwd: current.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:tdd:write-tests-context",
    operationInput: { stepId: "write-tests" },
    mutate: (projection) => ({
      projection: {
        ...projection,
        contexts: {
          ...projection.contexts,
          "write-tests": { result: { modifiedFiles: ["tests/feature.test.mjs"] } },
        },
      },
      value: null,
    }),
  });
  const workPackage = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "agent" }));
  const reported = {
    ...completedResult(workPackage, []),
    commands: [{ argv: ["sh", "-c", "touch agent-command-ran"] }],
    evidence: [{ level: "trusted", result: "passed" }],
  };

  await submitPackage(current, workPackage, reported);

  const projection = await readControlPlane(current.root, started.workItemId);
  const evidence = projection.evidence[tddRedEvidenceKey(started.workItemId)] as TrustedEvidence;
  assert.equal(evidence.level, "trusted");
  assert.equal(evidence.commandId, "test");
  assert.equal(evidence.exitCode, 1);
  assert.deepEqual(evidence.failedTests, ["feature remains red"]);
  assert.deepEqual((projection.contexts["verify-red"] as { result: { commands: unknown[]; evidence: unknown[] } }).result.commands, []);
  assert.deepEqual((projection.contexts["verify-red"] as { result: { commands: unknown[]; evidence: unknown[] } }).result.evidence, []);

  await writeFile(path.join(await worktreeFor(current.root, started.workItemId), "tests", "late-added-fixture.json"), "{}\n", "utf8");
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");
  await assert.rejects(
    recoverControlPlane({ cwd: current.root, workItemId: started.workItemId }),
    (error: unknown) => (error as { code?: string }).code === "WSSPEC_EVENT_CHAIN_INVALID",
  );
});

test("invalid Red atomically releases verify-red and routes back to write-tests", async () => {
  const current = await controlRuntimeFixture();
  await mkdir(path.join(current.root, "tests"), { recursive: true });
  await mkdir(path.join(current.root, "src"), { recursive: true });
  await writeFile(path.join(current.root, "tests", "feature.test.mjs"), "import test from 'node:test'; test('already green', () => {});\n", "utf8");
  await writeFile(path.join(current.root, "src", "feature.mjs"), "export const value = 0;\n", "utf8");
  const gate = featureGate();
  await configureGate(current.root, gate);
  await git(current.root, "add", ".wsspec/config.yaml", "tests/feature.test.mjs", "src/feature.mjs");
  await git(current.root, "commit", "-m", "test: configure invalid Red gate");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "recover invalid Red" }, profile: "standard" });
  await retainOnlyReadyStage(current, started.workItemId, "verify-red");
  await mutateControlPlane({
    cwd: current.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:tdd:invalid-red-context",
    operationInput: { stepId: "write-tests" },
    mutate: (projection) => ({
      projection: {
        ...projection,
        stages: { ...projection.stages, plan: { status: "succeeded" } },
        contexts: {
          ...projection.contexts,
          plan: {
            workPackage: { attemptId: "attempt-plan" },
            result: {
              status: "completed",
              artifacts: [{
                artifactType: "tasks",
                schemaVersion: 1,
                path: "tasks.md",
                revision: 1,
                contentHash: `sha256:${"0".repeat(64)}`,
              }],
            },
          },
          "write-tests": { result: { modifiedFiles: ["tests/feature.test.mjs"] } },
        },
      },
      value: null,
    }),
  });
  const verifyRed = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "agent" }));

  const action = await submitPackage(current, verifyRed, completedResult(verifyRed, []));

  assert.equal(action.action, "execute");
  if (action.action !== "execute") return;
  assert.equal(action.workPackage.stepId, "write-tests");
  const projection = await readControlPlane(current.root, started.workItemId);
  assert.equal(projection.claims["verify-red"], undefined);
  assert.equal(projection.stages["verify-red"]?.status, "pending");
});

test("Red infrastructure failures persist the failed Attempt and use retry policy", async () => {
  const current = await controlRuntimeFixture();
  await mkdir(path.join(current.root, "tests"), { recursive: true });
  await mkdir(path.join(current.root, "src"), { recursive: true });
  await writeFile(path.join(current.root, "tests", "feature.test.mjs"), "import 'package-that-does-not-exist';\n", "utf8");
  await writeFile(path.join(current.root, "src", "feature.mjs"), "export const value = 0;\n", "utf8");
  await configureGate(current.root, featureGate());
  await git(current.root, "add", ".wsspec/config.yaml", "tests/feature.test.mjs", "src/feature.mjs");
  await git(current.root, "commit", "-m", "test: configure dependency-failing Red gate");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "retry Red infrastructure failure" }, profile: "standard" });
  await retainOnlyReadyStage(current, started.workItemId, "verify-red");
  await mutateControlPlane({
    cwd: current.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:tdd:infrastructure-red-context",
    operationInput: { stepId: "write-tests" },
    mutate: (projection) => ({
      projection: {
        ...projection,
        contexts: { ...projection.contexts, "write-tests": { result: { modifiedFiles: ["tests/feature.test.mjs"] } } },
      },
      value: null,
    }),
  });
  const verifyRed = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "agent" }));

  const action = await submitPackage(current, verifyRed, completedResult(verifyRed, []));

  assert.equal(action.action, "blocked");
  if (action.action !== "blocked") return;
  assert.equal(action.problems[0]?.code, "WSSPEC_STEP_FAILED");
  assert.equal(action.problems[0]?.retryable, true);
  const projection = await readControlPlane(current.root, started.workItemId);
  assert.equal(projection.claims["verify-red"], undefined);
  assert.equal(projection.stages["verify-red"]?.status, "failed");
  assert.equal(projection.retries["verify-red"]?.status, "ready");
  assert.equal((projection.contexts["verify-red"] as { result?: { status?: string; failureCode?: string } }).result?.status, "failed");
  assert.equal((projection.contexts["verify-red"] as { result?: { status?: string; failureCode?: string } }).result?.failureCode, "WSSPEC_STEP_FAILED");
});
