import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fireconnectKeyExportCommand, resolveFireconnectCliPath } from "../lib/cli-path.mjs";
import { withTempHome } from "./helpers.mjs";

describe("cli-path", () => {
  it("follows npm-global launcher symlink to fireconnect.mjs for apiKeyHelper", async () => {
    await withTempHome("cli-path-symlink", async (home) => {
      const binDir = path.join(home, ".local/bin");
      const pkgDir = path.join(home, "pkg");
      const entry = path.join(pkgDir, "fireconnect.mjs");
      await mkdir(binDir, { recursive: true });
      await mkdir(pkgDir, { recursive: true });
      await writeFile(entry, "#!/usr/bin/env node\n", "utf8");
      await chmod(entry, 0o755);
      await symlink(entry, path.join(binDir, "fireconnect"));

      const resolved = resolveFireconnectCliPath(home);
      // resolveFireconnectCliPath follows symlinks via realpathSync, which
      // canonicalizes (e.g. macOS /var → /private/var) — compare canonically.
      assert.equal(resolved, realpathSync(entry));

      const cmd = fireconnectKeyExportCommand(home);
      assert.match(cmd, new RegExp(`^${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
      assert.match(cmd, /--home /);
      assert.match(cmd, /fireconnect\.mjs --home .+ key export --stored-only$/);
    });
  });

  it("uses install.sh bash launcher without a node prefix", async () => {
    await withTempHome("cli-path-bash", async (home) => {
      const binDir = path.join(home, ".local/bin");
      const launcher = path.join(binDir, "fireconnect");
      await mkdir(binDir, { recursive: true });
      await writeFile(
        launcher,
        "#!/usr/bin/env bash\nexec /usr/bin/node /opt/fireconnect.mjs \"$@\"\n",
        "utf8",
      );
      await chmod(launcher, 0o755);

      const cmd = fireconnectKeyExportCommand(home);
      // The launcher path is canonicalized via realpathSync (macOS /var → /private/var).
      assert.equal(cmd, `${realpathSync(launcher)} --home ${home} key export --stored-only`);
    });
  });
});
