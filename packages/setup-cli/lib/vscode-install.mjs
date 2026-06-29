import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * VS Code install detection: which variant (stable / Insiders) is present and
 * the user-data **folder** name ("Code" / "Code - Insiders") that goes with it.
 *
 * The folder is used so `chatLanguageModelsPath` and `vscodeStateDbPath` target
 * the same variant the user actually has installed, and the variant drives the
 * Electron app name used by `vscode-safestorage.mjs` when reading the OS
 * `safeStorage` master key. `--vscode-path` overrides the resolved location.
 *
 * (VS Code Chat's BYOK secrets are NOT individual OS keychain entries — they are
 * `safeStorage`-encrypted blobs in `state.vscdb`; see `vscode-safestorage.mjs`.)
 */

/**
 * Detect a VS Code install. Stable is preferred when both stable and Insiders
 * are present.
 * @param {string|undefined} installDir explicit resources/app dir override
 * @returns {{ variant: "stable"|"insiders", folder: string, productJson: string, nameLong: string | null } | null}
 */
export function detectVscodeInstall(installDir) {
  if (installDir) {
    const productJson = path.join(installDir, "product.json");
    if (existsSync(productJson)) {
      return { variant: "stable", folder: "Code", productJson, nameLong: readNameLong(productJson) };
    }
    return null;
  }
  for (const candidate of vscodeInstallCandidates()) {
    if (existsSync(candidate.productJson)) {
      return { ...candidate, nameLong: readNameLong(candidate.productJson) };
    }
  }
  return null;
}

/**
 * Per-platform candidate installs, stable first. `folder` is the user-data
 * directory name (e.g. "Code", "Code - Insiders").
 * @returns {{ variant: "stable"|"insiders", folder: string, productJson: string }[]}
 */
function vscodeInstallCandidates() {
  const platform = os.platform();
  if (platform === "darwin") {
    return [
      { variant: "stable", folder: "Code", productJson: "/Applications/Visual Studio Code.app/Contents/Resources/app/product.json" },
      { variant: "insiders", folder: "Code - Insiders", productJson: "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/product.json" },
    ];
  }
  if (platform === "win32") {
    const prog = process.env.ProgramFiles || "C:\\Program Files";
    const prog86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      { variant: "stable", folder: "Code", productJson: path.join(prog, "Microsoft VS Code", "resources", "app", "product.json") },
      { variant: "stable", folder: "Code", productJson: path.join(prog86, "Microsoft VS Code", "resources", "app", "product.json") },
      { variant: "insiders", folder: "Code - Insiders", productJson: path.join(prog, "Microsoft VS Code Insiders", "resources", "app", "product.json") },
      { variant: "insiders", folder: "Code - Insiders", productJson: path.join(prog86, "Microsoft VS Code Insiders", "resources", "app", "product.json") },
    ];
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return [
    { variant: "stable", folder: "Code", productJson: "/usr/share/code/resources/app/product.json" },
    { variant: "stable", folder: "Code", productJson: "/usr/lib/code/resources/app/product.json" },
    { variant: "stable", folder: "Code", productJson: path.join(xdg, "code", "resources", "app", "product.json") },
    { variant: "insiders", folder: "Code - Insiders", productJson: "/usr/share/code-insiders/resources/app/product.json" },
    { variant: "insiders", folder: "Code - Insiders", productJson: path.join(xdg, "code-insiders", "resources", "app", "product.json") },
  ];
}

/** @param {string} productJson @returns {string | null} */
function readNameLong(productJson) {
  try {
    const product = JSON.parse(readFileSync(productJson, "utf8"));
    if (typeof product?.nameLong === "string" && product.nameLong.trim()) {
      return product.nameLong.trim();
    }
  } catch {
    // fall through to null
  }
  return null;
}
