import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the target. On POSIX the rename is atomic, so readers (e.g.
 * Claude Code loading settings.json) never observe a truncated file even if
 * this process is killed mid-write.
 *
 * @param {string} filePath
 * @param {string} data
 * @param {{ mode?: number }} [options]
 */
export async function writeFileAtomic(filePath, data, { mode } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    if (mode !== undefined) {
      await writeFile(tempPath, data, { mode });
    } else {
      await writeFile(tempPath, data);
      // Match the target's eventual default perms; chmod after write keeps
      // parity with the previous writeFile-then-chmod behavior of callers.
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  if (mode !== undefined) {
    await chmod(filePath, mode);
  }
}
