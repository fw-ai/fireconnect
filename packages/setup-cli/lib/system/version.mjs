import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Machine-readable protocol support; additive and independent of release numbers. */
export function cliVersionInfo() {
  return { version: readLocalVersion(), capabilities: ["login-account-type-v1"] };
}

export function readLocalVersion() {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "";
  } catch {
    return "";
  }
}
