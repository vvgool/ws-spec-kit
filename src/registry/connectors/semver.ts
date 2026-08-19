export interface SemVer {
  source: string;
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[];
}

const exactSemVer = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const semverCandidate = /(?:^|[^0-9A-Za-z-])([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.+-])/gu;

function hasLeadingZero(value: string): boolean {
  return value.length > 1 && value.startsWith("0");
}

export function parseSemVer(value: string): SemVer | undefined {
  const match = exactSemVer.exec(value);
  if (match === null) return undefined;
  const coreParts = [match[1]!, match[2]!, match[3]!] as const;
  if (coreParts.some(hasLeadingZero)) return undefined;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  if (prerelease.some((part) => /^\d+$/u.test(part) && hasLeadingZero(part))) return undefined;
  return { source: value, core: coreParts.map((part) => BigInt(part)) as unknown as SemVer["core"], prerelease };
}

export function extractSemVer(value: string): SemVer | undefined {
  for (const match of value.matchAll(semverCandidate)) {
    const parsed = parseSemVer(match[1]!);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemVer(left: SemVer, right: SemVer): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index]! !== right.core[index]!) return left.core[index]! < right.core[index]! ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    const compared = compareIdentifier(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
}
