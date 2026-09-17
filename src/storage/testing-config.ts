import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { defaultProductPaths, defaultTestAssetPaths, testPathRules } from "../engine/tdd/types.js";

async function directory(root: string, relative: string): Promise<boolean> {
  try { return (await lstat(path.join(root, relative))).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function suggestTestingConfig(root: string, testRoot?: string): Promise<Record<string, unknown>> {
  const packages = ["."];
  for (const base of ["apps", "packages"]) {
    if (await directory(root, base)) for (const name of (await readdir(path.join(root, base))).sort()) {
      if (await directory(root, `${base}/${name}`)) packages.push(`${base}/${name}`);
    }
  }
  const candidates: string[] = [];
  const simple = new Set<string>();
  const dependencies = new Set<string>();
  let installedVitest = false;
  for (const relative of packages) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, relative, "package.json"), "utf8"));
      if (manifest.devDependencies?.vitest || manifest.dependencies?.vitest) { installedVitest = true; dependencies.add(relative); }
      if (/\bvitest\b/u.test(manifest.scripts?.test ?? "")) candidates.push(relative);
      if (/^vitest(?: run)?$/u.test(manifest.scripts?.test ?? "")) simple.add(relative);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const selected = testRoot ?? candidates[0];
  if ((testRoot === undefined && candidates.length > 1) || (installedVitest && candidates.length === 0)
    || (selected !== undefined && (!candidates.includes(selected) || !simple.has(selected)))) {
    throw Object.assign(new Error("无法唯一确定 Vitest 测试范围，请显式配置 Test Gate 后重新 init。"), { code: "WSSPEC_TDD_GATE_CONFIGURATION_INVALID" });
  }
  const products: string[] = [];
  for (const name of ["src", "apps", "packages"]) if (await directory(root, name)) products.push(`${name}/**`);
  const runnerRoot = selected !== undefined && dependencies.has(selected) ? selected : ".";
  let runner = path.posix.join(runnerRoot, "node_modules/vitest/vitest.mjs");
  if (selected !== undefined) {
    for (const candidate of [...new Set([path.posix.join(selected, "node_modules/vitest/vitest.mjs"), "node_modules/vitest/vitest.mjs"])]) {
      try { await readFile(path.join(root, candidate)); runner = candidate; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  const command = selected === undefined ? ["node", "--test"]
    : ["node", runner, "run", ...(selected === "." ? [] : ["--root", selected])];
  return {
    version: 1,
    testing: { pathRules: [...testPathRules], testAssetPaths: [...defaultTestAssetPaths], productPaths: products.length ? products : [...defaultProductPaths] },
    quality: { gates: { test: { command, cwd: "worktree", timeoutSeconds: selected === undefined ? 60 : 120, required: true, evidence: "trusted", inheritEnv: [], env: {}, reporter: { type: selected === undefined ? "node-test" : "vitest", version: 1 } } } },
  };
}
