import { evaluateExpression, type ExpressionScope } from "../expressions/evaluate.js";
import { parseExpression } from "../expressions/parser.js";
import type { RuntimeProjection } from "../../storage/control-plane.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export interface ConditionScopeOptions {
  contextKeys?: readonly string[];
  steps?: Record<string, { status: string }>;
}

function artifactView(projection: RuntimeProjection, contextKeys?: readonly string[]): Record<string, unknown> {
  const artifacts = Object.create(null) as Record<string, unknown>;
  const contexts = contextKeys === undefined
    ? Object.values(projection.contexts)
    : contextKeys.map((key) => projection.contexts[key]);
  for (const context of contexts) {
    if (context === undefined) continue;
    const result = record(context)?.result;
    const completed = record(result);
    if (completed?.status !== "completed" || !Array.isArray(completed.artifacts)) continue;
    for (const artifact of completed.artifacts) {
      const reference = record(artifact);
      if (typeof reference?.artifactType !== "string") continue;
      artifacts[reference.artifactType] = {
        exists: true,
        ...(typeof reference.contentHash === "string" ? { digest: reference.contentHash } : {}),
        ...(record(record(context)?.artifactValues)?.[reference.artifactType] as Record<string, unknown> | undefined ?? {}),
      };
    }
  }
  return artifacts;
}

export function conditionScope(projection: RuntimeProjection, options: ConditionScopeOptions = {}): ExpressionScope {
  const bindings = record(projection.evidence.bindings) ?? {};
  const steps = {
    ...Object.fromEntries(Object.entries(projection.stages).map(([id, stage]) => [id, { status: stage.status }])),
    ...(options.steps ?? {}),
  };
  return { artifacts: artifactView(projection, options.contextKeys), bindings, steps };
}

export function evaluateCondition(source: string | undefined, scope: ExpressionScope): boolean {
  return source === undefined || evaluateExpression(parseExpression(source), scope);
}
