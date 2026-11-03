import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { codexConfigPath, refreshCodexGatewayKey } from "../../../lib/harnesses/codex/core.mjs";
import { repairCodexDuplicateHttpHeadersOnUpgrade } from "../../../lib/harnesses/codex/upgrade-migrations.mjs";
import { repairDuplicateCodexHttpHeadersRaw } from "../../../lib/harnesses/codex/toml-patch.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import { withTempHome } from "../../helpers.mjs";

// A config as an earlier `nexus login --force` left it once the ChatGPT app had
// rewritten the inline headers as a subtable: `http_headers` is defined twice
// and Codex refuses to start ("duplicate key"). The inline line holds the key
// login wrote last.
const BROKEN = `model_provider = "fireworks-ai"
model_catalog_json = "~/.codex/fireworks-model-catalog.json"
model = "auto"
notify = [
    "/Users/example/.codex/notify-client",
    "turn-ended",
]

[model_providers.fireworks-ai]
name = "Fireworks"
base_url = "https://api.fireworks.ai/inference/v1"
wire_api = "responses"



requires_openai_auth = true
http_headers = { "X-Title" = "Codex", "HTTP-Referer" = "nexus/v0.0.0", "x-fireworks-api-key" = "fw_LATEST" }
[model_providers.fireworks-ai.http_headers]
X-Title = "Codex"
HTTP-Referer = "nexus/v0.0.0"
x-fireworks-api-key = "fw_PREVIOUS"

[desktop]
followUpQueueMode = "steer"
sansFontSize = 14
`;

function providerHeaders(raw) {
  return { ...parseToml(raw).tables["model_providers.fireworks-ai"].http_headers };
}

async function writeCodexConfig(home, raw) {
  const configPath = codexConfigPath(home);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, raw);
  return configPath;
}

describe("codex duplicate http_headers repair", () => {
  it("the fixture really is the broken shape", () => {
    assert.throws(() => parseToml(BROKEN));
  });

  it("keeps the inline headers and drops the stale subtable", () => {
    const repaired = repairDuplicateCodexHttpHeadersRaw(BROKEN);
    assert.deepEqual(providerHeaders(repaired), {
      "X-Title": "Codex",
      "HTTP-Referer": "nexus/v0.0.0",
      "x-fireworks-api-key": "fw_LATEST",
    });
    assert.doesNotMatch(repaired, /fw_PREVIOUS/);
    const doc = parseToml(repaired);
    assert.equal(doc.tables.desktop.sansFontSize, 14);
    assert.deepEqual(doc.root.notify, ["/Users/example/.codex/notify-client", "turn-ended"]);
    assert.equal(doc.root.model, "auto");
  });

  it("leaves valid configs untouched", () => {
    const inlineOnly = BROKEN.replace(/\[model_providers\.fireworks-ai\.http_headers\]\n(?:.+\n){3}/, "");
    const subtableOnly = BROKEN.replace(/^http_headers = .+\n/m, "");
    for (const raw of [inlineOnly, subtableOnly]) {
      parseToml(raw);
      assert.equal(repairDuplicateCodexHttpHeadersRaw(raw), raw);
    }
  });

  it("nexus update repairs the file on disk, once", async () => {
    await withTempHome("codex-dup-headers-upgrade", async (home) => {
      const configPath = await writeCodexConfig(home, BROKEN);
      assert.equal(await repairCodexDuplicateHttpHeadersOnUpgrade(home), true);
      const raw = await readFile(configPath, "utf8");
      assert.equal(providerHeaders(raw)["x-fireworks-api-key"], "fw_LATEST");
      assert.equal(await repairCodexDuplicateHttpHeadersOnUpgrade(home), false);
    });
  });

  it("login writes the repair even when the key is unchanged", async () => {
    await withTempHome("codex-dup-headers-same-key", async (home) => {
      const configPath = await writeCodexConfig(home, BROKEN);
      assert.equal(await refreshCodexGatewayKey({ configPath, fireworksKey: "fw_LATEST" }), true);
      assert.equal(providerHeaders(await readFile(configPath, "utf8"))["x-fireworks-api-key"], "fw_LATEST");
    });
  });

  it("login rotates the key on a broken config", async () => {
    await withTempHome("codex-dup-headers-rotate", async (home) => {
      const configPath = await writeCodexConfig(home, BROKEN);
      assert.equal(await refreshCodexGatewayKey({ configPath, fireworksKey: "fw_ROTATED" }), true);
      const raw = await readFile(configPath, "utf8");
      assert.deepEqual(providerHeaders(raw), {
        "X-Title": "Codex",
        "HTTP-Referer": "nexus/v0.0.0",
        "x-fireworks-api-key": "fw_ROTATED",
      });
      assert.equal(parseToml(raw).tables.desktop.followUpQueueMode, "steer");
    });
  });
});
