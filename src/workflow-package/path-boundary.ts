import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { WorkflowPackageError } from "./types.js";

export interface ContainedPathCodes {
  invalid: `WSSPEC_${string}`;
  escape: `WSSPEC_${string}`;
}

function outside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function canonicalTarget(target: string, code: `WSSPEC_${string}`, label: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new WorkflowPackageError(code, `${label} 是悬空符号链接。`);
      } catch (inspected) {
        if (inspected instanceof WorkflowPackageError) throw inspected;
      }
    }
    throw caught;
  }
}

export async function assertContainedPath(root: string, target: string, codes: ContainedPathCodes, label: string): Promise<void> {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(target);
  if (outside(lexicalRoot, lexicalTarget)) throw new WorkflowPackageError(codes.invalid, `${label} 的词法路径越出允许边界。`);
  const [realRoot, realTarget] = await Promise.all([
    realpath(lexicalRoot),
    canonicalTarget(lexicalTarget, codes.escape, label),
  ]);
  if (outside(realRoot, realTarget)) throw new WorkflowPackageError(codes.escape, `${label} 的真实路径越出允许边界。`);
}
