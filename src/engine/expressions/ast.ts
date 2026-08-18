export type ExpressionAst =
  | { kind: "literal"; value: string | boolean | number | null }
  | { kind: "path"; root: "artifacts" | "bindings" | "steps"; segments: string[] }
  | { kind: "binary"; op: "==" | "!=" | "&&" | "||"; left: ExpressionAst; right: ExpressionAst };

export type ExpressionErrorCode =
  | "WSSPEC_EXPRESSION_FORBIDDEN"
  | "WSSPEC_EXPRESSION_INVALID"
  | "WSSPEC_EXPRESSION_LIMIT_EXCEEDED"
  | "WSSPEC_EXPRESSION_TYPE_INVALID";

export class ExpressionError extends Error {
  constructor(readonly code: ExpressionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExpressionError";
  }
}
