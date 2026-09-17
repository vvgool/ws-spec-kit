import { createRequire } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../../domain/digests.js";
import { VerificationError } from "./types.js";

interface PackageMetadata {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

// Node resolves package directories before applying exports conditions. Read manifests
// directly so packages that hide package.json in exports are still included.
async function resolvePackage(from: string, name: string): Promise<string | undefined> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name) || name === "." || name === "..") {
    throw new VerificationError("WSSPEC_TDD_REPORTER_UNSUPPORTED", "测试工具包含无效依赖名称。");
  }
  const search = createRequire(path.join(from, "package.json")).resolve.paths(name) ?? [];
  for (const directory of search) {
    try { return path.dirname(await realpath(path.join(directory, name, "package.json"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return undefined;
}

export async function runnerInstallationDigest(entry: string): Promise<string> {
  const packages = new Map<string, { files: Array<[string, string]>; dependencies: Array<[string, string | null]> }>();
  async function visit(root: string): Promise<void> {
    if (packages.has(root)) return;
    if (packages.size >= 512) throw new VerificationError("WSSPEC_TDD_REPORTER_UNSUPPORTED", "测试工具依赖数量超出限制。");
    const record = { files: [] as Array<[string, string]>, dependencies: [] as Array<[string, string | null]> };
    packages.set(root, record);
    async function walk(directory: string): Promise<void> {
      for (const name of (await readdir(directory)).sort()) {
        if (name === "node_modules") continue;
        const file = path.join(directory, name);
        const info = await lstat(file);
        if (info.isDirectory()) await walk(file);
        else if (info.isFile()) record.files.push([path.relative(root, file), sha256(await readFile(file))]);
        else throw new VerificationError("WSSPEC_TDD_REPORTER_UNSUPPORTED", "测试工具依赖包含非普通运行文件。");
      }
    }
    await walk(root);
    const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as PackageMetadata;
    const names = [...new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.optionalDependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {})])].sort();
    for (const name of names) {
      const dependency = await resolvePackage(root, name);
      // Missing optional/peer dependencies are bound too: installing one changes the digest.
      record.dependencies.push([name, dependency ?? null]);
      if (dependency !== undefined) await visit(dependency);
      else if (metadata.dependencies?.[name] !== undefined && metadata.optionalDependencies?.[name] === undefined) {
        throw new VerificationError("WSSPEC_TDD_GATE_EXECUTION_FAILED", "测试工具的必需依赖未安装。");
      }
    }
  }
  await visit(path.dirname(await realpath(entry)));
  return sha256(JSON.stringify([...packages].sort(([left], [right]) => left.localeCompare(right))));
}
