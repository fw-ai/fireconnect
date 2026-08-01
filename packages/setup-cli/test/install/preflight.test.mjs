import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const INSTALL_PATH = path.join(REPO_ROOT, "install.sh");
const PROMPT = `Claude Code is currently connected through FireConnect.

FireConnect must temporarily restore your original Claude settings before upgrading.

Continue? [Y/n]`;
const BASE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const HAS_UTIL_LINUX_SCRIPT = spawnSync("script", ["--version"], {
  encoding: "utf8",
}).status === 0;

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createRunner(root) {
  const installSource = await readFile(INSTALL_PATH, "utf8");
  const runner = path.join(root, "preflight-runner.sh");
  await writeFile(
    runner,
    installSource.replace(
      /\nmain "\$@"\s*$/,
      "\npreflight_existing_install\nprint_claude_restore_summary\nprintf 'restored=%s\\n' \"${CLAUDE_SETTINGS_RESTORED}\"\n",
    ),
  );
  return runner;
}

async function createFakeCli(home) {
  const launcher = path.join(home, ".local/bin/fireconnect");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(
    launcher,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${FIRECONNECT_FAKE_LOG}"
if [[ "\${FIRECONNECT_FAKE_MODE:-success}" == "fail" ]]; then
  exit 9
fi
if [[ "\${FIRECONNECT_FAKE_MODE:-success}" == "noop" ]]; then
  exit 0
fi
if [[ -n "\${FIRECONNECT_AFTER_CONFIG:-}" ]]; then
  cp "\${FIRECONNECT_AFTER_CONFIG}" "\${HOME}/.fireconnect/config.json"
fi
if [[ -n "\${FIRECONNECT_AFTER_SETTINGS:-}" ]]; then
  mkdir -p "\${HOME}/.claude"
  cp "\${FIRECONNECT_AFTER_SETTINGS}" "\${HOME}/.claude/settings.json"
else
  rm -f "\${HOME}/.claude/settings.json"
fi
rm -f "\${HOME}/.fireconnect/claude/provider-backup.json"
rm -f "\${HOME}/.fireconnect/claude/provider-state.json"
`,
  );
  await chmod(launcher, 0o755);
}

async function withFixture(name, callback, { installed = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `fc-install-${name}-`));
  const home = path.join(root, "home");
  const logPath = path.join(root, "fake-cli.log");
  await mkdir(home, { recursive: true });
  const runner = await createRunner(root);
  if (installed) {
    await createFakeCli(home);
  }
  try {
    await callback({ root, home, logPath, runner });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runPreflight({ home, logPath, runner }, env = {}) {
  return spawnSync("bash", [runner], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: BASE_PATH,
      SHELL: "/bin/bash",
      FIRECONNECT_FAKE_LOG: logPath,
      ...env,
    },
  });
}

function runPreflightInPty({ home, logPath, runner }, input, env = {}) {
  return spawnSync(
    "script",
    ["-qfec", 'bash "$FIRECONNECT_TEST_RUNNER"', "/dev/null"],
    {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        HOME: home,
        PATH: BASE_PATH,
        SHELL: "/bin/bash",
        FIRECONNECT_FAKE_LOG: logPath,
        FIRECONNECT_TEST_RUNNER: runner,
        ...env,
      },
    },
  );
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

describe("install.sh Claude upgrade preflight", () => {
  it("skips Claude-off when the installed FireConnect is 0.9.0+", async () => {
    await withFixture("skip-modern", async (fixture) => {
      await writeJson(path.join(fixture.home, ".fireconnect/config.json"), {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      await writeJson(
        path.join(fixture.home, ".fireconnect/cli/packages/setup-cli/package.json"),
        { name: "fireconnect", version: "0.9.0" },
      );

      const result = runPreflight(fixture, {
        // Would force off if detection ran — assert it never reaches the CLI.
        FIRECONNECT_AUTO_OFF_CLAUDE: "1",
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readIfExists(fixture.logPath), "");
      assert.match(result.stdout, /restored=0/);
    });
  });

  it("still restores Claude when upgrading from FireConnect before 0.9.0", async () => {
    await withFixture("legacy-version", async (fixture) => {
      const configPath = path.join(fixture.home, ".fireconnect/config.json");
      const afterConfig = path.join(fixture.root, "config-after.json");
      await writeJson(configPath, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      await writeJson(afterConfig, {
        harnesses: { claude: { enabled: false, provider: "fireworks" } },
      });
      await writeJson(
        path.join(fixture.home, ".fireconnect/cli/packages/setup-cli/package.json"),
        { name: "fireconnect", version: "0.8.9" },
      );

      const result = runPreflight(fixture, {
        FIRECONNECT_AUTO_OFF_CLAUDE: "1",
        FIRECONNECT_AFTER_CONFIG: afterConfig,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      assert.match(result.stdout, /restored=1/);
    });
  });

  it("uses the existing CLI to disable a globally enabled Claude harness", async () => {
    await withFixture("global", async (fixture) => {
      const configPath = path.join(fixture.home, ".fireconnect/config.json");
      const afterConfig = path.join(fixture.root, "config-after.json");
      await writeJson(configPath, {
        harnesses: { claude: { enabled: true, provider: "fireworks" } },
      });
      await writeJson(afterConfig, {
        harnesses: { claude: { enabled: false, provider: "fireworks" } },
      });

      const result = runPreflight(fixture, {
        FIRECONNECT_AUTO_OFF_CLAUDE: "1",
        FIRECONNECT_AFTER_CONFIG: afterConfig,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      assert.match(result.stdout, /restored=1/);
      assert.match(
        result.stdout,
        /Your original Claude Code settings were restored before the upgrade\./,
      );
      assert.match(
        result.stdout,
        /Reconnect Claude Code through FireConnect: fireconnect claude on/,
      );
    });
  });

  it("detects managed Fireworks settings when global state is missing", async () => {
    await withFixture("settings", async (fixture) => {
      const settingsPath = path.join(fixture.home, ".claude/settings.json");
      const afterSettings = path.join(fixture.root, "settings-after.json");
      await writeJson(settingsPath, {
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_CUSTOM_HEADERS: "X-Title: Claude Code",
        },
      });
      await writeJson(afterSettings, { theme: "dark" });

      const result = runPreflight(fixture, {
        FIRECONNECT_AUTO_OFF_CLAUDE: "1",
        FIRECONNECT_AFTER_SETTINGS: afterSettings,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        theme: "dark",
      });
    });
  });

  it("detects backup-less short-slug settings without telemetry", async () => {
    await withFixture("short-slug-settings", async (fixture) => {
      const settingsPath = path.join(fixture.home, ".claude/settings.json");
      const afterSettings = path.join(fixture.root, "settings-after.json");
      await writeJson(settingsPath, {
        env: {
          ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
          ANTHROPIC_MODEL: "glm-fast-latest[1m]",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-fast-latest",
          ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_test_key",
        },
      });
      await writeJson(afterSettings, { theme: "dark" });

      const result = runPreflight(fixture, {
        FIRECONNECT_AUTO_OFF_CLAUDE: "1",
        FIRECONNECT_AFTER_SETTINGS: afterSettings,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        theme: "dark",
      });
      assert.match(result.stdout, /restored=1/);
    });
  });

  it("does not claim an unmanaged Fireworks hostname", async () => {
    await withFixture("unmanaged", async (fixture) => {
      await writeJson(path.join(fixture.home, ".claude/settings.json"), {
        env: {
          ANTHROPIC_BASE_URL: "https://custom.fireworks.ai/inference",
          ANTHROPIC_MODEL: "glm-fast-latest",
        },
      });

      const result = runPreflight(fixture);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readIfExists(fixture.logPath), "");
      assert.match(result.stdout, /restored=0/);
      assert.doesNotMatch(result.stdout, /Reconnect Claude Code/);
    });
  });

  it("stops without a controlling terminal and leaves Claude untouched", async () => {
    await withFixture("no-tty", async (fixture) => {
      await writeJson(path.join(fixture.home, ".fireconnect/config.json"), {
        harnesses: { claude: { enabled: true } },
      });

      const result = runPreflight(fixture);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no interactive terminal is available/);
      assert.match(result.stderr, /FIRECONNECT_AUTO_OFF_CLAUDE=1/);
      assert.equal(await readIfExists(fixture.logPath), "");
    });
  });

  it(
    "prints the approved prompt through a TTY and stops when declined",
    { skip: !HAS_UTIL_LINUX_SCRIPT },
    async () => {
      await withFixture("decline", async (fixture) => {
        await writeJson(path.join(fixture.home, ".fireconnect/config.json"), {
          harnesses: { claude: { enabled: true } },
        });

        const result = runPreflightInPty(fixture, "n\n");
        const transcript = result.stdout.replaceAll("\r", "");

        assert.notEqual(result.status, 0);
        assert.match(transcript, new RegExp(PROMPT.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(transcript, /Installation cancelled/);
        assert.equal(await readIfExists(fixture.logPath), "");
      });
    },
  );

  it(
    "accepts the prompt default and runs the existing CLI",
    { skip: !HAS_UTIL_LINUX_SCRIPT },
    async () => {
      await withFixture("accept", async (fixture) => {
        const configPath = path.join(fixture.home, ".fireconnect/config.json");
        const afterConfig = path.join(fixture.root, "config-after.json");
        await writeJson(configPath, {
          harnesses: { claude: { enabled: true } },
        });
        await writeJson(afterConfig, {
          harnesses: { claude: { enabled: false } },
        });

        const result = runPreflightInPty(fixture, "\n", {
          FIRECONNECT_AFTER_CONFIG: afterConfig,
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
      });
    },
  );

  it("fails closed when the existing CLI leaves Claude managed", async () => {
    await withFixture("noop", async (fixture) => {
      await writeJson(path.join(fixture.home, ".fireconnect/config.json"), {
        harnesses: { claude: { enabled: true } },
      });

      const result = runPreflight(fixture, {
        FIRECONNECT_AUTO_OFF_CLAUDE: "1",
        FIRECONNECT_FAKE_MODE: "noop",
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Claude Code is still managed/);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
    });
  });

  it("fails closed when the existing CLI cannot disable Claude", async () => {
    await withFixture("failure", async (fixture) => {
      await writeJson(path.join(fixture.home, ".fireconnect/config.json"), {
        harnesses: { claude: { enabled: true } },
      });

      const result = runPreflight(fixture, {
        FIRECONNECT_AUTO_OFF_CLAUDE: "1",
        FIRECONNECT_FAKE_MODE: "fail",
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /could not restore Claude Code settings/);
      assert.equal(await readFile(fixture.logPath, "utf8"), "claude off\n");
    });
  });

  it("leaves first-time installs unaffected", async () => {
    await withFixture("first", async (fixture) => {
      const result = runPreflight(fixture);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /restored=0/);
      assert.doesNotMatch(result.stdout, /Claude Code is currently connected/);
    }, { installed: false });
  });

  it("runs the preflight before source setup", async () => {
    const installSource = await readFile(INSTALL_PATH, "utf8");
    assert.match(
      installSource,
      /ensure_node_runtime\n  preflight_existing_install\n  ensure_durable_source/,
    );
  });
});

describe("install.sh finish screen", () => {
  it("shows the banner once and prints quick help at the end", async () => {
    const installSource = await readFile(INSTALL_PATH, "utf8");
    assert.equal((installSource.match(/node "\$\{banner_script\}"/g) ?? []).length, 1);
    assert.match(installSource, /node "\$\{banner_script\}" --context install\n/);
    assert.match(installSource, /node "\$\{CLI\}" help quick/);
    assert.doesNotMatch(installSource, /node "\$\{CLI\}" help\n/);
    assert.doesNotMatch(installSource, /--success-only/);
  });

  it("print_install_notes tolerates an empty INSTALL_NOTES array under set -u", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fireconnect-install-notes-"));
    try {
      const installSource = await readFile(INSTALL_PATH, "utf8");
      const printInstallNotes = installSource.match(
        /^print_install_notes\(\) \{[\s\S]*?^\}/m,
      )?.[0];
      assert.ok(printInstallNotes, "expected print_install_notes in install.sh");
      assert.match(
        printInstallNotes,
        /\(\(\$\{#INSTALL_NOTES\[@\]\}\)\)/,
        "expected empty-array guard for set -u compatibility",
      );

      const runner = path.join(root, "notes-runner.sh");
      await writeFile(
        runner,
        `#!/usr/bin/env bash
set -euo pipefail
INSTALL_NOTES=()
${printInstallNotes}
print_install_notes
echo notes-ok
`,
      );
      await chmod(runner, 0o755);

      const result = spawnSync("bash", [runner], { encoding: "utf8" });
      assert.equal(
        result.status,
        0,
        result.stderr || result.stdout,
      );
      assert.match(result.stdout, /notes-ok/);
      assert.doesNotMatch(result.stdout, /^Note:/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("install.sh shared finalize", () => {
  it("invokes fireconnect finalize-install after installing the launcher", async () => {
    const source = await readFile(INSTALL_PATH, "utf8");
    assert.match(source, /node "\$\{CLI\}" finalize-install/);
    assert.match(source, /Finalizing install/);
  });
});
