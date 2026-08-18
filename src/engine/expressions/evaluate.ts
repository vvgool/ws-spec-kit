import { ExpressionError, type ExpressionAst } from "./ast.js";

export interface ExpressionScope {
  artifacts?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  steps?: Record<string, unknown>;
}

const missing = Symbol("missing");
type Missing = typeof missing;
type Value = string | boolean | number | null | Missing;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathValue(ast: Extract<ExpressionAst, { kind: "path" }>, scope: ExpressionScope): Value {
  let current: unknown = scope[ast.root];
  for (const segment of ast.segments) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return missing;
    current = current[segment];
  }
  if (current === null || typeof current === "string" || typeof current === "boolean" || typeof current === "number") return current;
  return missing;
}

function booleanValue(value: Value): boolean | Missing {
  if (value === missing) return missing;
  if (typeof value !== "boolean") throw new ExpressionError("WSSPEC_EXPRESSION_TYPE_INVALID", "逻辑表达式必须得到布尔值。");
  return value;
}

function valueOf(ast: ExpressionAst, scope: ExpressionScope): Value {
  if (ast.kind === "literal") return ast.value;
  if (ast.kind === "path") return pathValue(ast, scope);
  const left = valueOf(ast.left, scope);
  if (ast.op === "==" || ast.op === "!=") {
    const right = valueOf(ast.right, scope);
    if (left === missing || right === missing) return missing;
    return ast.op === "==" ? left === right : left !== right;
  }
  const leftBoolean = booleanValue(left);
  if (leftBoolean === missing) return missing;
  if (ast.op === "&&") return leftBoolean ? booleanValue(valueOf(ast.right, scope)) : false;
  return leftBoolean ? true : booleanValue(valueOf(ast.right, scope));
}

export function evaluateExpression(ast: ExpressionAst, scope: ExpressionScope): boolean {
  const value = booleanValue(valueOf(ast, scope));
  return value === missing ? false : value;
}
