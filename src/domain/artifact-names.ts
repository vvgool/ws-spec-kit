/** Presentation names never replace the full content hash stored in Artifact metadata. */
const labels: Readonly<Record<string, string>> = {
  "exploration-report": "02-现状分析",
  specification: "03-需求规格",
  design: "04-技术方案",
  plan: "05-实施计划",
  tasks: "05-实施计划",
  "implementation-result": "实现结果",
  "verification-result": "验证结果",
  "knowledge-entry": "知识记录",
};

export function artifactFilename(input: { artifactType: string; stageId: string; contentHash: string }): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.contentHash)) throw new Error("Invalid Artifact content hash");
  const iteration = /^[a-z][a-z0-9-]*:([1-9][0-9]*):[a-z][a-z0-9-]*$/u.exec(input.stageId)?.[1] ?? "1";
  const fallback = input.artifactType.normalize("NFC").replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "文档";
  const label = input.artifactType === "review-result" ? `第${iteration.padStart(2, "0")}轮-评审结果` : labels[input.artifactType] ?? fallback;
  // The hash includes producer attempt and output identity, preserving every historical result.
  return `${label}-${input.contentHash.slice(7, 19)}.md`;
}

export function isArtifactFilename(value: string): boolean {
  return /^[a-f0-9]{64}\.md$/u.test(value)
    || (Buffer.byteLength(value, "utf8") <= 220 && /^[\p{L}\p{N}][\p{L}\p{N}-]*-[a-f0-9]{12}\.md$/u.test(value) && value.normalize("NFC") === value);
}
