import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("packed CLI installs and runs from a clean consumer directory", async () => {
  const packageDirectory = await mkdtemp(path.join(os.tmpdir(), "wspec-package-"));
  const consumerDirectory = await mkdtemp(path.join(os.tmpdir(), "wspec-consumer-"));
  await execute("npm", ["run", "build"], { cwd: repositoryRoot });
  const packed = await execute("npm", ["pack", repositoryRoot, "--json"], { cwd: packageDirectory });
  const packedEntries = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const filename = packedEntries[0]?.filename;
  assert.ok(filename, "npm pack must return a tarball filename");
  await execute("npm", ["init", "-y"], { cwd: consumerDirectory });
  await execute("npm", ["install", "--ignore-scripts", path.join(packageDirectory, filename)], { cwd: consumerDirectory });
  const executable = path.join(consumerDirectory, "node_modules/.bin/wspec");

  const version = await execute(executable, ["--version"], { cwd: consumerDirectory });
  const help = await execute(executable, ["--help"], { cwd: consumerDirectory });
  const catalog = await execute(process.execPath, [
    "--input-type=module",
    "--eval",
    "import { loadBuiltinCatalog } from './node_modules/ws-spec-kit/dist/resources/catalog.js'; console.log((await loadBuiltinCatalog()).workflows.length)",
  ], { cwd: consumerDirectory });

  assert.equal(JSON.parse(version.stdout).version, "0.1.0-alpha.1");
  assert.match(help.stdout, /WSSpecKit/);
  assert.match(help.stdout, /用法/);
  assert.match(help.stdout, /wspec init/);
  assert.doesNotMatch(help.stdout, /issues|knowledge|wspec next|wspec claim|wspec context|wspec complete/);
  assert.equal(catalog.stdout.trim(), "2");
});
