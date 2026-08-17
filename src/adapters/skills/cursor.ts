import path from "node:path";
export function cursorDriverTarget(home: string): string { return path.join(home, ".cursor", "skills", "wsspeckit-driver"); }
