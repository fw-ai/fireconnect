import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { writeFileAtomic } from "../../lib/io/atomic-write.mjs";

test("writes file content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-"));
  const target = path.join(dir, "settings.json");
  await writeFileAtomic(target, '{"a":1}\n');
  assert.equal(await readFile(target, "utf8"), '{"a":1}\n');
});

test("creates parent directories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-"));
  const target = path.join(dir, "nested", "deep", "config.json");
  await writeFileAtomic(target, "x");
  assert.equal(await readFile(target, "utf8"), "x");
});

test("replaces existing file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-"));
  const target = path.join(dir, "f.json");
  await writeFileAtomic(target, "old");
  await writeFileAtomic(target, "new");
  assert.equal(await readFile(target, "utf8"), "new");
});

test("applies mode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-"));
  const target = path.join(dir, "secret");
  await writeFileAtomic(target, "s3cret", { mode: 0o600 });
  const { mode } = await stat(target);
  assert.equal(mode & 0o777, 0o600);
});

test("preserves an existing target's mode when mode is omitted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-"));
  const target = path.join(dir, "secret");
  await writeFile(target, "old", { mode: 0o600 });
  await writeFileAtomic(target, "new");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test("leaves no temp files behind", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-"));
  const target = path.join(dir, "f.json");
  await writeFileAtomic(target, "a");
  await writeFileAtomic(target, "b");
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["f.json"]);
});

test("cleans up temp file when write fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-"));
  // Target is a directory → rename fails; temp must be removed.
  const target = path.join(dir, "sub");
  await writeFileAtomic(path.join(target, "placeholder"), "x"); // creates dir "sub"
  await assert.rejects(writeFileAtomic(target, "boom"));
  const entries = await readdir(dir);
  assert.deepEqual(entries.sort(), ["sub"]);
});
