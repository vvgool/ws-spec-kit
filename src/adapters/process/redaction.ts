const markerCandidates = ["[REDACTED]", "[MASKED]", "***", "<hidden>", ""] as const;
const sensitiveNames = new Set([
  "authorization", "cookie", "setcookie", "ghtoken", "gitlabtoken", "accesstoken", "refreshtoken", "clientsecret", "apikey",
]);
const labelledSecret = /(\b(?:GH_TOKEN|GITLAB_TOKEN|Authorization|Cookie|Set-Cookie|accessToken|refreshToken|clientSecret|apiKey|token|password|secret)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const bearerSecret = /(Bearer\s+)([^\s,;]+)/giu;
const credentialHeader = /(\b(?:Authorization|Cookie|Set-Cookie)\b\s*[:=]\s*)[^\r\n]*/giu;

function markerFor(secrets: readonly string[]): string {
  return markerCandidates.find((candidate) => secrets.every((secret) => secret === "" || !candidate.includes(secret))) ?? "";
}

function containsSecret(value: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret !== "" && value.includes(secret));
}

function explicitSecrets(value: string, secrets: readonly string[], marker: string): string {
  let result = value;
  for (const secret of [...new Set(secrets)].filter((candidate) => candidate !== "").sort((left, right) => right.length - left.length)) {
    result = result.replaceAll(secret, marker);
  }
  return containsSecret(result, secrets) ? "" : result;
}

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return sensitiveNames.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("apikey");
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  const marker = markerFor(secrets);
  const labelled = value
    .replace(credentialHeader, `$1${marker}`)
    .replace(bearerSecret, `$1${marker}`)
    .replace(labelledSecret, `$1${marker}`);
  return explicitSecrets(labelled, secrets, marker);
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value === null || typeof value !== "object") return value;
  if (Object.keys(value).some((key) => sensitiveKey(key) || containsSecret(key, secrets))) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    redactValue(item, secrets),
  ]));
}
