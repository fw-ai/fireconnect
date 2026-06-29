import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function readLocalVersion() {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "";
  } catch {
    return "";
  }
}
