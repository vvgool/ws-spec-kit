import * as canonicalizeModule from "canonicalize";

import type { WorkPackage } from "../protocol/work-package.js";
import { sha256 } from "./digests.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;

export function workPackageIdentityDigest(workPackage: WorkPackage): string {
  const encoded = canonicalize(workPackage);
  if (encoded === undefined) throw new Error("Work Package 无法规范化。");
  return sha256(encoded);
}
