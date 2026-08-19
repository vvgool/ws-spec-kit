const tokenFamily = /(?:github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{12,}|xox[a-z]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|xoxe(?:\.xox[a-z])?-[A-Za-z0-9-]{8,})/iu;
const credentialHeader = /\b(?:authorization|cookie|set-cookie)\s*[:=]\s*\S/iu;
const authorizationScheme = /\b(?:bearer|basic)\s+[A-Za-z0-9+/=._~-]{4,}/iu;
const labelledSecret = /\b(?:api[-_ ]?key|client[-_ ]?secret|credential|password|private[-_ ]?key|refresh[-_ ]?token|session(?:id)?|secret|token)\s*[:=]\s*\S/iu;
const larkTokenCandidate = /(?:^|[^A-Za-z0-9])([tua]-[A-Za-z0-9_-]{24,})(?=$|[^A-Za-z0-9])/gu;
const invalidPercentEscape = /%(?![A-Fa-f0-9]{2})/u;
const defaultMaximumSurfaceBytes = 8_192;
const defaultMaximumDecodeRounds = 4;

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  return [...frequencies.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function larkAccessToken(value: string): boolean {
  for (const match of value.matchAll(larkTokenCandidate)) {
    const token = match[1]!;
    if (shannonEntropy(token.slice(2)) >= 3) return true;
  }
  return false;
}

export function credentialLikeKey(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return ["authorization", "basic", "bearer", "cookie", "setcookie", "credential", "password", "privatekey", "session", "sessionid", "secret"].includes(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("apikey")
    || normalized.endsWith("privatekey");
}

export function credentialLikeValue(value: string): boolean {
  return tokenFamily.test(value)
    || larkAccessToken(value)
    || credentialHeader.test(value)
    || authorizationScheme.test(value)
    || labelledSecret.test(value);
}

export function credentialLikeField(value: string): boolean {
  return credentialLikeKey(value) || credentialLikeValue(value);
}

export type DecodedCredentialSurfaceResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; reason: "credential" | "decode-limit" | "invalid-encoding" | "too-large" }>;

export function inspectDecodedCredentialSurface(
  surface: string,
  options: Readonly<{ detectCredentialKeys?: boolean; maximumBytes?: number; maximumDecodeRounds?: number }> = {},
): DecodedCredentialSurfaceResult {
  const maximumBytes = options.maximumBytes ?? defaultMaximumSurfaceBytes;
  const maximumDecodeRounds = options.maximumDecodeRounds ?? defaultMaximumDecodeRounds;
  const detector = options.detectCredentialKeys === true ? credentialLikeField : credentialLikeValue;
  let current = surface;
  for (let round = 0; round <= maximumDecodeRounds; round += 1) {
    if (Buffer.byteLength(current, "utf8") > maximumBytes) return { ok: false, reason: "too-large" };
    if (detector(current)) return { ok: false, reason: "credential" };
    if (!current.includes("%")) return { ok: true, value: current };
    if (invalidPercentEscape.test(current)) return { ok: false, reason: "invalid-encoding" };
    if (round === maximumDecodeRounds) return { ok: false, reason: "decode-limit" };
    try {
      current = decodeURIComponent(current);
    } catch {
      return { ok: false, reason: "invalid-encoding" };
    }
  }
  return { ok: false, reason: "decode-limit" };
}
