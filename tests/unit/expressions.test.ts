import assert from "node:assert/strict";
import test from "node:test";

import { evaluateExpression } from "../../src/engine/expressions/evaluate.js";
import { parseExpression } from "../../src/engine/expressions/parser.js";

const scope = {
  artifacts: { review: { approved: true, attempts: 2 } },
  bindings: { issue: { exists: false } },
  steps: { review: { status: "succeeded" } },
};

test("有限表达式解析并计算布尔值、相等与不等", () => {
  assert.equal(evaluateExpression(parseExpression("true && (artifacts.review.approved == true)"), scope), true);
  assert.equal(evaluateExpression(parseExpression("artifacts.review.attempts != 3 || false"), scope), true);
  assert.equal(evaluateExpression(parseExpression("steps.review.status == 'failed'"), scope), false);
});

test("有限表达式只读取声明根路径且缺失 Binding 为 false", () => {
  assert.equal(evaluateExpression(parseExpression("bindings.issue.exists"), scope), false);
  assert.equal(evaluateExpression(parseExpression("bindings.knowledge.exists"), scope), false);
  assert.equal(evaluateExpression(parseExpression("${bindings.issue.exists == false}"), scope), true);
});

test("有限表达式拒绝未知标识、调用、赋值与原型属性", () => {
  for (const source of ["unknown.exists", "process.exit()", "bindings.issue.exists = true", "bindings.__proto__.exists", "artifacts.review.constructor"]) {
    assert.throws(() => parseExpression(source), /WSSPEC_EXPRESSION_FORBIDDEN/);
  }
});

test("有限表达式拒绝超长输入", () => {
  assert.throws(() => parseExpression(`bindings.issue.exists${" ".repeat(4096)}`), /WSSPEC_EXPRESSION_LIMIT_EXCEEDED/);
});
