import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fixedTestGateFromConfig } from "../../src/engine/verification.js";
import { executeTrustedTestGate } from "../../src/engine/tdd/red-gate.js";
import { computeWorkspaceTreeDigest } from "../../src/domain/digests.js";
import { git } from "./helpers/git.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-vitest-"));
  await git(root, "init");
  await mkdir(path.join(root, "tests"));
  await mkdir(path.join(root, "src"));
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  const gate = fixedTestGateFromConfig({ testing: { pathRules: ["node"], testAssetPaths: ["tests/**"], productPaths: ["src/**"] }, quality: { gates: { test: {
    command: [process.execPath, "node_modules/vitest/vitest.mjs", "run"], timeoutSeconds: 30, reporter: { type: "vitest", version: 1 },
  } } } });
  const run = async (phase: "red" | "green", expectedCommandDigest?: string) => executeTrustedTestGate({
    taskId: "fixture", stepId: phase === "red" ? "verify-red" : "verify-green", phase, gate, worktree: root,
    workspaceDigest: await computeWorkspaceTreeDigest(root), testPaths: ["tests/feature.test.js"], ...(expectedCommandDigest === undefined ? {} : { expectedCommandDigest }),
  });
  return { root, gate, run };
}

test("Vitest trusted gate observes assertion Red and unchanged-test Green", async () => {
  const { root, run } = await fixture();
  await writeFile(path.join(root, "src/feature.js"), "export const result = 1;\n");
  await writeFile(path.join(root, "tests/feature.test.js"), "import {test,expect} from 'vitest'; import {result} from '../src/feature.js'; test('expected result',()=>expect(result).toBe(2));\n");
  const red = await run("red");
  assert.equal(red.phase, "red");
  assert.equal(red.failedTests.length, 1);
  await writeFile(path.join(root, "src/feature.js"), "export const result = 2;\n");
  const green = await run("green", red.commandDigest);
  assert.equal(green.exitCode, 0);
  assert.equal(green.testAssetsDigest, red.testAssetsDigest);
});

test("Vitest collection failures and empty runs cannot produce trusted Red or Green", async (t) => {
  for (const [body, phase, code] of [
    ["import './missing.js';", "red", "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE"],
    ["const = ;", "red", "WSSPEC_TDD_RED_SYNTAX_FAILURE"],
    ["import {test} from 'vitest'; test.skip('skip',()=>{});", "green", "WSSPEC_TDD_GREEN_NOT_OBSERVED"],
  ] as const) await t.test(code + body.slice(0, 12), async () => {
    const { root, run } = await fixture();
    await writeFile(path.join(root, "tests/feature.test.js"), body);
    await assert.rejects(run(phase), { code });
  });
});

test("Vitest hook errors and report overrides cannot masquerade as trusted assertion Red", async () => {
  const { root, gate, run } = await fixture();
  await writeFile(path.join(root, "tests/feature.test.js"), "import {test,beforeAll,expect} from 'vitest'; beforeAll(()=>{throw new Error('infrastructure');}); test('test',()=>expect(1).toBe(2));");
  await assert.rejects(run("red"), { code: "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE" });
  gate.argv = [...gate.argv, "--reporter=json"];
  await assert.rejects(run("red"), { code: "WSSPEC_TDD_REPORTER_UNSUPPORTED" });
});

test("Vitest rejects Red outside declared test paths and changed command binding", async () => {
  const { root, gate, run } = await fixture();
  await writeFile(path.join(root, "tests/feature.test.js"), "import {test,expect} from 'vitest'; test('pass',()=>expect(1).toBe(1));");
  await writeFile(path.join(root, "tests/other.test.js"), "import {test,expect} from 'vitest'; test('fail',()=>expect(1).toBe(2));");
  await assert.rejects(run("red"), { code: "WSSPEC_TDD_REPORT_INVALID" });
  await writeFile(path.join(root, "tests/feature.test.js"), "import {test,expect} from 'vitest'; test('expected failure',()=>expect(1).toBe(2));");
  const red = await run("red");
  gate.argv = [...gate.argv, "--maxWorkers=1"];
  await assert.rejects(run("green", red.commandDigest), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
});

test("Vitest beforeEach assertion failure cannot count as test-body Red", async () => {
  const { root, run } = await fixture();
  await writeFile(path.join(root, "tests/feature.test.js"), "import {test,beforeEach,expect} from 'vitest'; beforeEach(()=>expect(1).toBe(2)); test('body never ran',()=>expect(1).toBe(1));");
  await assert.rejects(run("red"), { code: "WSSPEC_TDD_RED_INFRASTRUCTURE_FAILURE" });
});

test("Vitest assertion text containing infrastructure words remains valid Red", async () => {
  const { root, run } = await fixture();
  await writeFile(path.join(root, "tests/feature.test.js"), "import {test,beforeEach,expect} from 'vitest'; beforeEach(()=>{}); test('message',()=>expect('Cannot find user').toBe('User missing'));");
  assert.equal((await run("red")).failedTests.length, 1);
});

test("missing Vitest installation reports an actionable gate failure", async () => {
  const { gate, run } = await fixture();
  gate.argv = [process.execPath, "missing/node_modules/vitest/vitest.mjs", "run"];
  await assert.rejects(run("red"), { code: "WSSPEC_TDD_GATE_EXECUTION_FAILED" });
});

test("Vitest versions before the supported reporter loader are rejected before execution", async () => {
  const { root, gate, run } = await fixture();
  await mkdir(path.join(root, "old-vitest"));
  await writeFile(path.join(root, "old-vitest/package.json"), '{"name":"vitest","version":"3.0.9"}');
  await writeFile(path.join(root, "old-vitest/vitest.mjs"), "throw new Error('unsupported runner must not execute');");
  gate.argv = [process.execPath, "old-vitest/vitest.mjs", "run"];
  await assert.rejects(run("red"), { code: "WSSPEC_TDD_REPORTER_UNSUPPORTED" });
});


test("changing the installed assertion library invalidates the Red command binding", async () => {
  const { root, run } = await fixture();
  // Isolate the install before changing dependency code; never touch shared node_modules.
  await rm(path.join(root, "node_modules"));
  await cp(path.resolve("node_modules"), path.join(root, "node_modules"), { recursive: true });
  await writeFile(path.join(root, "tests/feature.test.js"), "import {test,expect} from 'vitest'; test('still fails',()=>expect(1).toBe(2));");
  const red = await run("red");
  const dependency = path.join(root, "node_modules/@vitest/expect/dist/index.js");
  const original = await readFile(dependency, "utf8");
  const patched = original.replace("const pass = Object.is(actual, expected);", "const pass = true;");
  assert.notEqual(patched, original, "fixture must alter the assertion implementation");
  await writeFile(dependency, patched);
  await assert.rejects(run("green", red.commandDigest), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
});
