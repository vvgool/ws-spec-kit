import { ExpressionError, type ExpressionAst } from "./ast.js";

const maximumExpressionLength = 1024;
const forbiddenSegments = new Set(["__proto__", "constructor", "prototype"]);
const roots = new Set(["artifacts", "bindings", "steps"]);

type Token =
  | { kind: "literal"; value: string | boolean | number | null }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: "==" | "!=" | "&&" | "||" | "." | "(" | ")" }
  | { kind: "end" };

function sourceBody(source: string): string {
  if (source.length > maximumExpressionLength) {
    throw new ExpressionError("WSSPEC_EXPRESSION_LIMIT_EXCEEDED", "表达式超过最大长度。");
  }
  const trimmed = source.trim();
  if (trimmed.startsWith("${") || trimmed.endsWith("}")) {
    if (!trimmed.startsWith("${") || !trimmed.endsWith("}")) {
      throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "表达式模板边界不完整。");
    }
    return trimmed.slice(2, -1).trim();
  }
  return trimmed;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (/\s/u.test(character)) { index += 1; continue; }
    const pair = source.slice(index, index + 2);
    if (pair === "==" || pair === "!=" || pair === "&&" || pair === "||") {
      tokens.push({ kind: "operator", value: pair }); index += 2; continue;
    }
    if (character === "." || character === "(" || character === ")") {
      tokens.push({ kind: "operator", value: character }); index += 1; continue;
    }
    if (character === "\"" || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const next = source[index++]!;
        if (next === quote) { closed = true; break; }
        if (next === "\\") {
          const escaped = source[index++];
          if (escaped === undefined || !["\\", "\"", "'", "n", "r", "t"].includes(escaped)) {
            throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "字符串转义不在有限语法内。");
          }
          value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
        } else value += next;
      }
      if (!closed) throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "字符串没有结束引号。");
      tokens.push({ kind: "literal", value }); continue;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/u.exec(source.slice(index));
    if (number !== null) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "数字字面量无效。");
      tokens.push({ kind: "literal", value }); index += number[0].length; continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/u.exec(source.slice(index));
    if (identifier !== null) {
      const value = identifier[0];
      if (value === "true") tokens.push({ kind: "literal", value: true });
      else if (value === "false") tokens.push({ kind: "literal", value: false });
      else if (value === "null") tokens.push({ kind: "literal", value: null });
      else tokens.push({ kind: "identifier", value });
      index += value.length; continue;
    }
    throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "表达式含有未允许的语法。");
  }
  tokens.push({ kind: "end" });
  return tokens;
}

class Parser {
  #index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): ExpressionAst {
    const value = this.or();
    if (this.current().kind !== "end") throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "表达式包含未允许的后续语法。");
    return value;
  }

  private or(): ExpressionAst {
    let left = this.and();
    while (this.take("||")) left = { kind: "binary", op: "||", left, right: this.and() };
    return left;
  }

  private and(): ExpressionAst {
    let left = this.equality();
    while (this.take("&&")) left = { kind: "binary", op: "&&", left, right: this.equality() };
    return left;
  }

  private equality(): ExpressionAst {
    let left = this.primary();
    while (true) {
      if (this.take("==")) left = { kind: "binary", op: "==", left, right: this.primary() };
      else if (this.take("!=")) left = { kind: "binary", op: "!=", left, right: this.primary() };
      else return left;
    }
  }

  private primary(): ExpressionAst {
    const token = this.current();
    if (token.kind === "literal") { this.#index += 1; return { kind: "literal", value: token.value }; }
    if (this.take("(")) {
      const value = this.or();
      if (!this.take(")")) throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "括号没有闭合。");
      return value;
    }
    if (token.kind !== "identifier") throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "表达式缺少允许的值。");
    if (!roots.has(token.value)) throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "表达式引用了未知标识。");
    this.#index += 1;
    const segments: string[] = [];
    while (this.take(".")) {
      const segment = this.current();
      if (segment.kind !== "identifier" || forbiddenSegments.has(segment.value)) {
        throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "表达式路径包含禁止的属性。");
      }
      segments.push(segment.value);
      this.#index += 1;
    }
    if (segments.length === 0) throw new ExpressionError("WSSPEC_EXPRESSION_FORBIDDEN", "表达式路径必须包含属性。");
    return { kind: "path", root: token.value as "artifacts" | "bindings" | "steps", segments };
  }

  private current(): Token { return this.tokens[this.#index]!; }

  private take(value: Extract<Token, { kind: "operator" }> ["value"]): boolean {
    const token = this.current();
    if (token.kind !== "operator" || token.value !== value) return false;
    this.#index += 1;
    return true;
  }
}

export function parseExpression(source: string): ExpressionAst {
  if (typeof source !== "string") throw new ExpressionError("WSSPEC_EXPRESSION_INVALID", "表达式必须是字符串。");
  const body = sourceBody(source);
  if (body === "") throw new ExpressionError("WSSPEC_EXPRESSION_INVALID", "表达式不能为空。");
  return new Parser(tokenize(body)).parse();
}
