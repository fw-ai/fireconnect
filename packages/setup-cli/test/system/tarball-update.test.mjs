import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import {
  downloadCliTarball,
  extractCliTarball,
  fetchLatestVersion,
} from "../../lib/system/tarball-update.mjs";

// Hand-build minimal ustar entries so tests control the archive byte-for-byte
// (system `tar` refuses to create path-traversal entries).
function tarEntry(name, data = Buffer.alloc(0), type = "0") {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, "utf8");
  header.write("0000644\0", 100, "utf8"); // mode
  header.write("0000000\0", 108, "utf8"); // uid
  header.write("0000000\0", 116, "utf8"); // gid
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "utf8"); // size
  header.write("00000000000\0", 136, "utf8"); // mtime
  header.write(type, 156, "utf8");
  header.write("ustar\0", 258, "utf8"); // magic
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function gzipTarball(...entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function fakeFetchFor(bytes) {
  return async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes });
}

describe("extractCliTarball", () => {
  async function withStaging(callback) {
    const staging = await mkdtemp(path.join(os.tmpdir(), "nexus-untar-"));
    try {
      await callback(staging);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  it("extracts files and directories, stripping the top-level prefix", async () => {
    await withStaging(async (staging) => {
      const archive = gzipTarball(
        tarEntry("nexus-cli-main/packages/setup-cli/bin/", Buffer.alloc(0), "5"),
        tarEntry("nexus-cli-main/packages/setup-cli/bin/nexus.mjs", Buffer.from("// cli\n")),
        tarEntry("nexus-cli-main/README.md", Buffer.from("readme\n")),
      );

      await extractCliTarball(archive, staging);

      assert.equal(await readFile(path.join(staging, "packages/setup-cli/bin/nexus.mjs"), "utf8"), "// cli\n");
      assert.equal(await readFile(path.join(staging, "README.md"), "utf8"), "readme\n");
    });
  });

  it("honors the ustar prefix field for long paths", async () => {
    await withStaging(async (staging) => {
      // name field holds the basename; the prefix field holds the directory.
      const data = Buffer.from("// p\n");
      const header = Buffer.alloc(512);
      header.write("nexus.mjs", 0, "utf8");
      header.write("0000644\0", 100, "utf8");
      header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
      header.write("0", 156, "utf8");
      header.write("nexus-cli-main/packages/setup-cli/bin", 345, "utf8");
      const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
      const archive = gzipTarball(Buffer.concat([header, data, padding]));

      await extractCliTarball(archive, staging);

      assert.equal(await readFile(path.join(staging, "packages/setup-cli/bin/nexus.mjs"), "utf8"), "// p\n");
    });
  });

  it("refuses entries that escape the staging directory (tar-slip)", async () => {
    await withStaging(async (staging) => {
      const archive = gzipTarball(
        tarEntry("nexus-cli-main/packages/setup-cli/bin/nexus.mjs", Buffer.from("// ok\n")),
        tarEntry("nexus-cli-main/../evil.txt", Buffer.from("pwned\n")),
      );

      await assert.rejects(
        extractCliTarball(archive, staging),
        /Refusing to extract unsafe tar entry/,
      );
      assert.equal(existsSync(path.join(staging, "..", "evil.txt")), false);
    });
  });

  it("skips symlink entries instead of creating them", async () => {
    await withStaging(async (staging) => {
      const archive = gzipTarball(
        tarEntry("nexus-cli-main/packages/setup-cli/bin/nexus.mjs", Buffer.from("// ok\n")),
        tarEntry("nexus-cli-main/link", Buffer.from("/etc/passwd"), "2"),
      );

      await extractCliTarball(archive, staging);

      assert.equal(existsSync(path.join(staging, "link")), false);
      assert.equal(await readFile(path.join(staging, "packages/setup-cli/bin/nexus.mjs"), "utf8"), "// ok\n");
    });
  });
});

describe("fetchLatestVersion", () => {
  it("returns the remote package.json version", async () => {
    const version = await fetchLatestVersion({
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: "1.2.3" }) }),
    });
    assert.equal(version, "1.2.3");
  });

  it("returns an empty string on HTTP failure, bad JSON, or network error", async () => {
    assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: false }) }), "");
    assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), "");
    assert.equal(
      await fetchLatestVersion({ fetchImpl: async () => { throw new Error("offline"); } }),
      "",
    );
  });
});

describe("downloadCliTarball", () => {
  it("downloads, extracts, and replaces any stale staging content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-download-"));
    try {
      const staging = path.join(root, "staging");
      await mkdir(path.join(staging, "stale"), { recursive: true });
      await writeFile(path.join(staging, "stale", "junk.txt"), "junk\n");

      const archive = gzipTarball(
        tarEntry("nexus-cli-main/packages/setup-cli/bin/nexus.mjs", Buffer.from("// downloaded\n")),
      );
      await downloadCliTarball(staging, { fetchImpl: fakeFetchFor(archive) });

      assert.equal(existsSync(path.join(staging, "stale")), false);
      assert.equal(
        await readFile(path.join(staging, "packages/setup-cli/bin/nexus.mjs"), "utf8"),
        "// downloaded\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws on HTTP errors so callers can leave the install in place", async () => {
    await assert.rejects(
      downloadCliTarball("/tmp/should-not-exist-staging", {
        fetchImpl: async () => ({ ok: false, status: 502 }),
      }),
      /HTTP 502/,
    );
    assert.equal(existsSync("/tmp/should-not-exist-staging"), false);
  });
});
