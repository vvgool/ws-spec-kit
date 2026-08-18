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

export function errorOutput(error: unknown): { ok: false; error: CliProblem } {
  const code = error instanceof Error && "code" in error ? String((error as Error & { code: unknown }).code) : "WSSPEC_INTERNAL_ERROR";
  if (isApplicationPublicErrorCode(code)) return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
  return { ok: false, error: { code: "WSSPEC_INTERNAL_ERROR", message: "发生未预期的内部错误。" } };
}
import { isApplicationPublicErrorCode } from "../../protocol/public-contract.js";
