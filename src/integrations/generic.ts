const pullLoop = `1. Run \`wspec next <work-item> --json\`.
2. For an Agent-owned Stage, run \`wspec claim <work-item> <stage> <actor> --json\`.
3. Run \`wspec context <work-item> <stage> --json\` and obey the returned contract.
4. Submit only through \`wspec complete <work-item> <stage> <result.json> --json\`.
5. Repeat until the engine reports an approval gate or completion.`;

export function generateGenericIntegration(): string { return `# WiesenSpecKit Generic Integration\n\n${pullLoop}\n`; }
export { pullLoop };
