export type ExternalDeliveryStatus =
  | "missing"
  | "prepared"
  | "approved"
  | "executing"
  | "reconciliation_required"
  | "verified"
  | "failed"
  | "absent"
  | "skipped"
  | "warning";

export function evaluateExternalDelivery(input: {
  issueUpdate: ExternalDeliveryStatus;
  knowledge: ExternalDeliveryStatus;
  knowledgeRequired: boolean;
  issueClose: ExternalDeliveryStatus;
}): { allowed: boolean; warnings: `WSSPEC_${string}`[]; blockers: `WSSPEC_${string}`[] } {
  const warnings: `WSSPEC_${string}`[] = [];
  const blockers: `WSSPEC_${string}`[] = [];
  if (input.issueUpdate !== "verified") blockers.push("WSSPEC_EXTERNAL_ISSUE_UPDATE_NOT_VERIFIED");
  if (input.knowledge !== "verified") {
    if (input.knowledgeRequired) blockers.push("WSSPEC_REQUIRED_KNOWLEDGE_NOT_VERIFIED");
    else if (input.knowledge === "warning") warnings.push("WSSPEC_OPTIONAL_KNOWLEDGE_FAILED");
    else if (input.knowledge !== "absent" && input.knowledge !== "skipped") blockers.push("WSSPEC_OPTIONAL_KNOWLEDGE_NOT_SETTLED");
  }
  if (input.issueClose !== "verified") blockers.push("WSSPEC_EXTERNAL_ISSUE_CLOSE_NOT_VERIFIED");
  return { allowed: blockers.length === 0, warnings, blockers };
}
