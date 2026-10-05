import path from "node:path";

const DATA_DIR_RELATIVE = ".fireconnect/claude-desktop";

export function claudeDesktopDataDir(home) {
  return path.join(home, DATA_DIR_RELATIVE);
}
