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
  const packed = await execute("npm", ["pack", "--json", "--pack-destination", packageDirectory], { cwd: repositoryRoot });
  const packedEntries = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const filename = packedEntries[0]?.filename;
  assert.ok(filename, "npm pack must return a tarball filename");
  await execute("npm", ["init", "-y"], { cwd: consumerDirectory });
  await execute("npm", ["install", "--ignore-scripts", path.join(packageDirectory, filename)], { cwd: consumerDirectory });
  const executable = path.join(consumerDirectory, "node_modules/.bin/wspec");

  const version = await execute(executable, ["--version"], { cwd: consumerDirectory });
  const help = await execute(executable, ["--help"], { cwd: consumerDirectory });

  assert.equal(version.stdout.trim(), "0.1.0-alpha.1");
  assert.match(help.stdout, /wspec init/);
  assert.doesNotMatch(help.stdout, /issues|knowledge/);
});
