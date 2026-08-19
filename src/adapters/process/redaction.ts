const redacted = "[REDACTED]";
const sensitiveKey = /^(?:authorization|cookie|set-cookie|gh_token|gitlab_token|.*(?:^|[_-])(?:token|password|secret|api[_-]?key))$/iu;
const labelledSecret = /((?:GH_TOKEN|GITLAB_TOKEN|Authorization|Cookie|Set-Cookie|(?:api[_-]?key|token|password|secret))\s*[:=]\s*)([^\r\n]*)/giu;
const bearerSecret = /(Bearer\s+)([^\s,;]+)/giu;

function explicitSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of [...new Set(secrets)].filter((candidate) => candidate !== "").sort((left, right) => right.length - left.length)) {
    result = result.replaceAll(secret, redacted);
  }
  return result;
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  const labelled = value
    .replace(labelledSecret, `$1${redacted}`)
    .replace(bearerSecret, `$1${redacted}`);
  return explicitSecrets(labelled, secrets);
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKey.test(key) ? redacted : redactValue(item, secrets),
  ]));
}
