import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const maximumPathLength = 1024;

export function isRepositoryRelativePattern(value: string): boolean {
  if (value === "" || value.length > maximumPathLength || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

type Token = { kind: "literal"; value: string } | { kind: "star" | "globstar" | "globstar-slash" | "question" };

function tokens(pattern: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        result.push({ kind: "globstar-slash" });
        index += 2;
      } else {
        result.push({ kind: "globstar" });
        index += 1;
      }
    } else if (pattern[index] === "*") result.push({ kind: "star" });
    else if (pattern[index] === "?") result.push({ kind: "question" });
    else result.push({ kind: "literal", value: pattern[index]! });
  }
  return result;
}

export function matchesRepositoryPath(pattern: string, candidate: string): boolean {
  if (!isRepositoryRelativePattern(pattern) || !isRepositoryRelativePattern(candidate)) return false;
  const compiled = tokens(pattern);
  const memo = new Map<string, boolean>();
  const match = (tokenIndex: number, candidateIndex: number): boolean => {
    const key = `${tokenIndex}:${candidateIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const token = compiled[tokenIndex];
    let result: boolean;
    if (token === undefined) result = candidateIndex === candidate.length;
    else if (token.kind === "literal") result = candidate[candidateIndex] === token.value && match(tokenIndex + 1, candidateIndex + 1);
    else if (token.kind === "question") result = candidateIndex < candidate.length && candidate[candidateIndex] !== "/" && match(tokenIndex + 1, candidateIndex + 1);
    else if (token.kind === "star") result = match(tokenIndex + 1, candidateIndex)
      || (candidateIndex < candidate.length && candidate[candidateIndex] !== "/" && match(tokenIndex, candidateIndex + 1));
    else if (token.kind === "globstar") result = match(tokenIndex + 1, candidateIndex)
      || (candidateIndex < candidate.length && match(tokenIndex, candidateIndex + 1));
    else result = match(tokenIndex + 1, candidateIndex)
      || (candidateIndex < candidate.length && (candidate[candidateIndex] === "/"
        ? match(tokenIndex + 1, candidateIndex + 1) || match(tokenIndex, candidateIndex + 1)
        : match(tokenIndex, candidateIndex + 1)));
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

export async function resolveRepositoryRegularFile(root: string, relativePath: string): Promise<string> {
  if (!isRepositoryRelativePattern(relativePath)) throw new Error("Path is not repository-relative");
  const canonicalRoot = await realpath(root);
  const requested = path.resolve(canonicalRoot, ...relativePath.split("/"));
  const lexicalRelative = path.relative(canonicalRoot, requested);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) throw new Error("Path escapes repository root");
  const before = await lstat(requested);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Path is not a regular file");
  const canonicalFile = await realpath(requested);
  const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
  if (canonicalRelative === "" || canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative) || canonicalFile !== requested) {
    throw new Error("Path escapes repository root or traverses a symlink");
  }
  const after = await lstat(canonicalFile);
  if (!after.isFile() || after.isSymbolicLink()) throw new Error("Path is not a regular file");
  return canonicalFile;
}
