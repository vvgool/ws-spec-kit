import path from "node:path";
export function claudeDriverTarget(home: string): string { return path.join(home, ".claude", "skills", "wsspeckit-driver"); }
