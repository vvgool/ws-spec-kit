const tokenFamily = /(?:github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{12,}|xox[a-z]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|xoxe(?:\.xox[a-z])?-[A-Za-z0-9-]{8,})/iu;
const credentialHeader = /\b(?:authorization|cookie|set-cookie)\s*[:=]\s*\S/iu;
const authorizationScheme = /\b(?:bearer|basic)\s+[A-Za-z0-9+/=._~-]{4,}/iu;
const labelledSecret = /\b(?:api[-_ ]?key|client[-_ ]?secret|credential|password|private[-_ ]?key|refresh[-_ ]?token|session(?:id)?|secret|token)\s*[:=]\s*\S/iu;

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
    || credentialHeader.test(value)
    || authorizationScheme.test(value)
    || labelledSecret.test(value);
}

export function credentialLikeField(value: string): boolean {
  return credentialLikeKey(value) || credentialLikeValue(value);
}
