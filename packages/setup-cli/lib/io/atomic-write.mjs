import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function existingFileMode(filePath) {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the target. On POSIX the rename is atomic, so readers (e.g.
 * Claude Code loading settings.json) never observe a truncated file even if
 * this process is killed mid-write. When `mode` is omitted, an existing
 * target's permissions are preserved rather than replaced by the process
 * umask's default.
 *
 * @param {string} filePath
 * @param {string} data
 * @param {{ mode?: number }} [options]
 */
export async function writeFileAtomic(filePath, data, { mode } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const targetMode = mode ?? await existingFileMode(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    if (targetMode !== undefined) {
      await writeFile(tempPath, data, { mode: targetMode });
    } else {
      await writeFile(tempPath, data);
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  if (targetMode !== undefined) {
    await chmod(filePath, targetMode);
  }
}

function existingFileModeSync(filePath) {
  try {
    return statSync(filePath).mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Write a file atomically from a synchronous caller.
 * @param {string} filePath
 * @param {string} data
 * @param {{ mode?: number }} [options]
 */
export function writeFileAtomicSync(filePath, data, { mode } = {}) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const targetMode = mode ?? existingFileModeSync(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tempPath, data, {
      flag: "wx",
      ...(targetMode === undefined ? {} : { mode: targetMode }),
    });
    if (targetMode !== undefined) {
      chmodSync(tempPath, targetMode);
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may not have been created.
    }
    throw error;
  }
}
