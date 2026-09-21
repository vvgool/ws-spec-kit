import {
  applicationFixedPublicErrors,
  applicationFilesystemPermissionError,
  applicationInternalError,
  isApplicationPublicErrorCode,
  type PublicCliErrorRoute,
} from "../../protocol/public-contract.js";

export interface CliProblem {
  code: string;
  message: string;
  retryable?: boolean;
}

export class CliAdapterError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(message);
    this.name = "CliAdapterError";
  }
}

export function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function errorOutput(error: unknown, route?: PublicCliErrorRoute): { ok: false; error: CliProblem } {
  const code = error instanceof Error && "code" in error ? String((error as Error & { code: unknown }).code) : applicationInternalError.code;
  if (error instanceof Error && ["EPERM", "EACCES", "EROFS"].includes(code)
    && "syscall" in error && typeof error.syscall === "string"
    && ["mkdir", "open", "read", "write", "rename", "unlink", "rmdir", "copyfile", "link", "symlink", "stat", "lstat", "scandir", "chmod"].includes(error.syscall)
    && "path" in error && typeof error.path === "string"
    && isApplicationPublicErrorCode(applicationFilesystemPermissionError.code, route)) {
    return { ok: false, error: { ...applicationFilesystemPermissionError } };
  }
  if (error instanceof Error && code !== applicationInternalError.code && isApplicationPublicErrorCode(code, route)) {
    const fixed = applicationFixedPublicErrors[code as keyof typeof applicationFixedPublicErrors];
    return { ok: false, error: fixed === undefined ? { code, message: error.message } : { ...fixed } };
  }
  return { ok: false, error: { ...applicationInternalError } };
}
