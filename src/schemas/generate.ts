import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { schemaIds, schemas } from "./definitions.js";

export async function generatePublicSchemas(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  for (const schemaId of schemaIds) {
    const filename = `${schemaId.replaceAll(".", "-")}.schema.json`;
    await writeFile(path.join(outputDir, filename), `${JSON.stringify(schemas[schemaId], null, 2)}\n`, "utf8");
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputDir = process.argv[2];
  if (outputDir === undefined) {
    throw new Error("Usage: generate <output-directory>");
  }
  await generatePublicSchemas(path.resolve(outputDir));
}

