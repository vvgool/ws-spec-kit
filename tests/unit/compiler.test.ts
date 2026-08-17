import assert from "node:assert/strict";
import test from "node:test";

import { CompileError, compileWorkflow, type ProjectConfig, type Workflow } from "../../src/engine/compiler.js";

const config: ProjectConfig = {
  quality: { gates: { test: { required: true } } },
  publishing: { targets: {} },
};

function validWorkflow(): Workflow {
  return {
    version: 1,
    workflow: { id: "verified-delivery" },
    stages: [
      { id: "define", kind: "define", owner: "agent", uses: "artifact.generate", output: ["specification"], approval: { required: true, provider: "interactive" } },
      { id: "design", kind: "design", owner: "agent", uses: "artifact.generate", needs: ["define"], input: ["specification"], output: ["design"], approval: { required: true, provider: "interactive" } },
      { id: "plan", kind: "plan", owner: "agent", uses: "task.plan", needs: ["design"], input: ["specification", "design"], output: ["plan"], approval: { required: true, provider: "interactive" } },
      { id: "build", kind: "implement", owner: "agent", uses: "engineering.implement", needs: ["plan"], input: ["specification", "design", "plan"], output: ["implementation-result"] },
      { id: "review", kind: "review", owner: "agent", uses: "engineering.review", needs: ["build"], input: ["implementation-result"], output: ["review-result"] },
      { id: "verify", kind: "verify", owner: "engine", uses: "quality.verify", needs: ["review"], input: ["review-result"], output: ["verification-result"], gates: ["test"] },
      { id: "close", kind: "close", owner: "engine", uses: "work-item.close", needs: ["verify"] },
    ],
  };
}

function expectCompileError(workflow: Workflow, code: string): void {
  assert.throws(
    () => compileWorkflow(workflow, config),
    (error: unknown) => error instanceof CompileError && error.code === code && error.path.startsWith("/stages/"),
  );
}

test("compiles a valid workflow and normalizes optional stage fields", () => {
  const workflow = validWorkflow();
  delete workflow.stages[0]?.needs;
  delete workflow.stages[0]?.input;
  delete workflow.stages[0]?.gates;
  delete workflow.stages[0]?.publish;

  const compiled = compileWorkflow(workflow, config);

  assert.deepEqual(compiled.stages[0]?.needs, []);
  assert.deepEqual(compiled.stages[0]?.input, []);
  assert.deepEqual(compiled.order, ["define", "design", "plan", "build", "review", "verify", "close"]);
});

test("rejects duplicate stage IDs", () => {
  const workflow = validWorkflow();
  workflow.stages.push({ ...workflow.stages[0]! });
  expectCompileError(workflow, "WSPEC_COMPILE_DUPLICATE_STAGE");
});

test("rejects unknown dependencies", () => {
  const workflow = validWorkflow();
  workflow.stages[1]!.needs = ["missing"];
  expectCompileError(workflow, "WSPEC_COMPILE_UNKNOWN_DEPENDENCY");
});

test("rejects dependency cycles", () => {
  const workflow = validWorkflow();
  workflow.stages[0]!.needs = ["design"];
  expectCompileError(workflow, "WSPEC_COMPILE_CYCLE");
});

test("rejects owner and kind mismatches", () => {
  const workflow = validWorkflow();
  workflow.stages[3]!.owner = "engine";
  expectCompileError(workflow, "WSPEC_COMPILE_OWNER_KIND_MISMATCH");
});

test("rejects executors that cannot serve the stage kind", () => {
  const workflow = validWorkflow();
  workflow.stages[3]!.uses = "artifact.generate";
  expectCompileError(workflow, "WSPEC_EXECUTOR_CONTRACT_MISMATCH");
});

test("rejects input artifacts not produced by the dependency closure", () => {
  const workflow = validWorkflow();
  workflow.stages[3]!.needs = ["plan"];
  workflow.stages[3]!.input = ["tasks"];
  expectCompileError(workflow, "WSPEC_COMPILE_MISSING_ARTIFACT_PRODUCER");
});

test("rejects implementation paths that bypass approved specification, design or plan", () => {
  for (const stageId of ["define", "design", "plan"]) {
    const workflow = validWorkflow();
    const stage = workflow.stages.find((candidate) => candidate.id === stageId)!;
    stage.approval = { required: false };
    expectCompileError(workflow, "WSPEC_COMPILE_APPROVAL_REQUIRED");
  }
});

test("rejects verify stages without a configured required gate", () => {
  const workflow = validWorkflow();
  workflow.stages[5]!.gates = [];
  expectCompileError(workflow, "WSPEC_COMPILE_REQUIRED_GATE_MISSING");
});

test("rejects close stages without a verify dependency path", () => {
  const workflow = validWorkflow();
  workflow.stages[6]!.needs = ["review"];
  expectCompileError(workflow, "WSPEC_COMPILE_VERIFY_PATH_REQUIRED");
});

test("rejects verify stages that bypass review", () => {
  const workflow = validWorkflow();
  workflow.stages[5]!.needs = ["build"];
  workflow.stages[5]!.input = ["implementation-result"];
  expectCompileError(workflow, "WSPEC_COMPILE_REVIEW_PATH_REQUIRED");
});

test("rejects kind-specific outputs served by an overly broad executor", () => {
  const workflow = validWorkflow();
  workflow.stages[0]!.output = ["specification", "design"];
  expectCompileError(workflow, "WSPEC_EXECUTOR_CONTRACT_MISMATCH");
});
