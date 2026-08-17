import path from "node:path";
export function codexDriverTarget(home: string): string { return path.join(home, ".agents", "skills", "wsspeckit-driver"); }
