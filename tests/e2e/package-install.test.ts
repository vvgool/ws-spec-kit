import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
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
    "import { loadBuiltinCatalog } from 'ws-spec-kit/resources/catalog'; console.log((await loadBuiltinCatalog()).workflows.length)",
  ], { cwd: consumerDirectory });

  assert.equal(JSON.parse(version.stdout).version, "0.1.0-beta.0");
  assert.match(help.stdout, /WSSpecKit/);
  assert.match(help.stdout, /用法/);
  assert.match(help.stdout, /wspec init/);
  assert.doesNotMatch(help.stdout, /issues|knowledge|wspec next|wspec claim|wspec context|wspec complete/);
  assert.equal(catalog.stdout.trim(), "2");
});

test("打包产物不包含旧 Workflow、Project Config、编排器或 StageContext", async () => {
  await execute("npm", ["run", "build"], { cwd: repositoryRoot });
  const packed = await execute("npm", ["pack", "--dry-run", "--json"], { cwd: repositoryRoot });
  const entries = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
  const paths = new Set(entries[0]?.files.map((file) => file.path));
  const definitions = await readFile(path.join(repositoryRoot, "dist", "schemas", "definitions.js"), "utf8");

  assert.equal(paths.has("schemas/builtin-application-project-config-snapshot-v1.schema.json"), true, "应发布 portable Project Config snapshot Schema");
  for (const legacyPath of [
    "schemas/builtin-workflow-v1.schema.json",
    "schemas/builtin-project-config-v1.schema.json",
    "dist/engine/orchestrator.js",
    "dist/engine/orchestrator.d.ts",
    "dist/engine/claims.js",
    "dist/engine/claims.js.map",
    "dist/engine/claims.d.ts",
    "dist/engine/claims.d.ts.map",
  ]) assert.equal(paths.has(legacyPath), false, `不应发布 ${legacyPath}`);
  assert.doesNotMatch(definitions, /builtin\.workflow\.v1|builtin\.project-config\.v1/);
  const declarations = await Promise.all([...paths]
    .filter((filename) => filename.startsWith("dist/") && filename.endsWith(".d.ts"))
    .map((filename) => readFile(path.join(repositoryRoot, filename), "utf8")));
  assert.doesNotMatch(declarations.join("\n"), /\bStageContext\b/u);
});

test("构建产物保持 repository-relative matcher 和 symlink 拒绝边界", async () => {
  await execute("npm", ["run", "build"], { cwd: repositoryRoot });
  const repositoryPath = await import(`${pathToFileURL(path.join(repositoryRoot, "dist", "domain", "repository-path.js")).href}?${crypto.randomUUID()}`) as {
    matchesRepositoryPath(pattern: string, candidate: string): boolean;
  };
  const docs = await import(`${pathToFileURL(path.join(repositoryRoot, "dist", "engine", "docs-integrity.js")).href}?${crypto.randomUUID()}`) as {
    checkDocumentationIntegrity(input: { root: string; files: string[]; allowedPaths: string[] }): Promise<{ ok: boolean; problems: Array<{ code: string }> }>;
  };
  assert.equal(repositoryPath.matchesRepositoryPath("docs/**/*.md", "docs/readme.md"), true);

  const root = await mkdtemp(path.join(os.tmpdir(), "wsspec-dist-docs-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "wsspec-dist-outside-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(outside, "outside.md"), "# Outside\n");
  await symlink(path.join(outside, "outside.md"), path.join(root, "docs", "escape.md"));
  const checked = await docs.checkDocumentationIntegrity({ root, files: ["docs/escape.md"], allowedPaths: ["docs/**/*.md"] });
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.problems.map(({ code }) => code), ["WSSPEC_DOCUMENTATION_FILE_INVALID"]);
});
