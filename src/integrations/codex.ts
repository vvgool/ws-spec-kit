import { pullLoop } from "./generic.js";

export function generateCodexIntegration(): string { return `---\nname: wiesen-spec-kit\ndescription: Execute an active WiesenSpecKit workflow through its CLI protocol.\n---\n\n${pullLoop}\n`; }
