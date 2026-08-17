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
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
}
