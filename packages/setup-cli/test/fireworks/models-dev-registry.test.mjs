import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearModelsDevFireworksRegistry,
  modelsDevRegistryStatus,
  parseModelsDevFireworksModelIds,
  replaceModelsDevFireworksRegistry,
  setModelsDevFireworksRegistry,
} from "../../lib/fireworks/models-dev-registry.mjs";

describe("models.dev Fireworks registry", () => {
  it("parses fireworks-ai model ids from api.json", () => {
    const raw = JSON.stringify({
      "fireworks-ai": {
        models: {
          "accounts/fireworks/models/glm-5p2": { id: "accounts/fireworks/models/glm-5p2" },
          "accounts/fireworks/routers/glm-5p2-fast": { id: "accounts/fireworks/routers/glm-5p2-fast" },
        },
      },
    });
    const ids = parseModelsDevFireworksModelIds(raw);
    assert.ok(ids.has("accounts/fireworks/models/glm-5p2"));
    assert.ok(ids.has("accounts/fireworks/routers/glm-5p2-fast"));
    assert.equal(ids.has("accounts/fireworks/models/inkling"), false);
  });

  it("reports present/absent/unknown registry status", () => {
    setModelsDevFireworksRegistry([
      "accounts/fireworks/models/glm-5p2",
    ]);
    try {
      assert.equal(
        modelsDevRegistryStatus("accounts/fireworks/models/glm-5p2"),
        "present",
      );
      assert.equal(
        modelsDevRegistryStatus("accounts/fireworks/models/inkling"),
        "absent",
      );
    } finally {
      clearModelsDevFireworksRegistry();
    }
    assert.equal(modelsDevRegistryStatus("accounts/fireworks/models/glm-5p2"), "unknown");
  });

  it("treats empty registry mocks as unknown", () => {
    setModelsDevFireworksRegistry([]);
    try {
      assert.equal(modelsDevRegistryStatus("accounts/fireworks/models/glm-5p2"), "unknown");
    } finally {
      clearModelsDevFireworksRegistry();
    }
  });

  it("rejects empty parse results without replacing a loaded registry", () => {
    setModelsDevFireworksRegistry(["accounts/fireworks/models/glm-5p2"]);
    try {
      assert.equal(replaceModelsDevFireworksRegistry(new Set()), false);
      assert.equal(modelsDevRegistryStatus("accounts/fireworks/models/glm-5p2"), "present");
      assert.equal(replaceModelsDevFireworksRegistry(parseModelsDevFireworksModelIds("{}")), false);
      assert.equal(modelsDevRegistryStatus("accounts/fireworks/models/glm-5p2"), "present");
    } finally {
      clearModelsDevFireworksRegistry();
    }
  });
});
