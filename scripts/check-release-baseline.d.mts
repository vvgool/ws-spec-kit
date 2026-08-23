export type EvidenceTierStatus = "passed" | "no-go";

export type EvidenceTierSummary = {
  readonly localAutomated: EvidenceTierStatus;
  readonly realHost: EvidenceTierStatus;
  readonly realPlatform: EvidenceTierStatus;
  readonly overall: "go" | "no-go";
};

export function aggregateEvidenceTiers(rows: readonly { readonly evidenceTier: string; readonly status: string }[]): EvidenceTierSummary;
