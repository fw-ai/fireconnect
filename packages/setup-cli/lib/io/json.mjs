import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "./atomic-write.mjs";

export async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} is not valid JSON`);
    }
    throw error;
  }
}

export function writeJson(filePath, value, { mode } = {}) {
  return writeFileAtomic(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    { mode },
  );
}
