import { ExpressionError, type ExpressionAst } from "./ast.js";

export interface ExpressionScope {
  artifacts?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  steps?: Record<string, unknown>;
}

type Value = string | boolean | number | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathValue(ast: Extract<ExpressionAst, { kind: "path" }>, scope: ExpressionScope): Value {
  let current: unknown = scope[ast.root];
  for (const segment of ast.segments) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  if (current === null || typeof current === "string" || typeof current === "boolean" || typeof current === "number") return current;
  return undefined;
}

function booleanValue(value: Value): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ExpressionError("WSSPEC_EXPRESSION_TYPE_INVALID", "逻辑表达式必须得到布尔值。");
  return value;
}

function valueOf(ast: ExpressionAst, scope: ExpressionScope): Value {
  if (ast.kind === "literal") return ast.value;
  if (ast.kind === "path") return pathValue(ast, scope);
  if (ast.op === "==") return valueOf(ast.left, scope) === valueOf(ast.right, scope);
  if (ast.op === "!=") return valueOf(ast.left, scope) !== valueOf(ast.right, scope);
  if (ast.op === "&&") return booleanValue(valueOf(ast.left, scope)) && booleanValue(valueOf(ast.right, scope));
  return booleanValue(valueOf(ast.left, scope)) || booleanValue(valueOf(ast.right, scope));
}

export function evaluateExpression(ast: ExpressionAst, scope: ExpressionScope): boolean {
  return booleanValue(valueOf(ast, scope));
}
