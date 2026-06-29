import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AZURE_API_KEY_ENV,
  AZURE_API_KEY_ENV_REF,
  DEFAULT_AZURE_MODEL,
  effectiveAzureApiKey,
  isAzureBaseUrl,
  normalizeAzureBaseUrl,
  resolveAzureOnApiKey,
} from "../lib/azure-core.mjs";

async function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

describe("normalizeAzureBaseUrl", () => {
  it("appends /openai/v1 to a bare project endpoint", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("strips trailing slashes before appending", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("leaves an already-suffixed openai/v1 base unchanged", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/openai/v1"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("rewrites the /models route to the openai/v1 base", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/models"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("completes a bare /openai segment", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/openai"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("reduces a portal project endpoint to the resource-root openai/v1 base", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/api/projects/msft-fw-foundry"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
    assert.equal(
      normalizeAzureBaseUrl("https://my-res.services.ai.azure.com/api/projects/msft-fw-foundry/"),
      "https://my-res.services.ai.azure.com/openai/v1",
    );
  });

  it("preserves a custom path for non-Azure (proxy) hosts", () => {
    assert.equal(
      normalizeAzureBaseUrl("https://gateway.example.com/fw"),
      "https://gateway.example.com/fw/openai/v1",
    );
  });

  it("returns empty string for empty input", () => {
    assert.equal(normalizeAzureBaseUrl(""), "");
    assert.equal(normalizeAzureBaseUrl(undefined), "");
  });
});

describe("isAzureBaseUrl", () => {
  it("matches Azure hosts", () => {
    assert.equal(isAzureBaseUrl("https://x.services.ai.azure.com"), true);
    assert.equal(isAzureBaseUrl("https://x.openai.azure.com/openai/v1"), true);
  });

  it("rejects the Fireworks gateway", () => {
    assert.equal(isAzureBaseUrl("https://api.fireworks.ai/inference/v1"), false);
  });
});

describe("resolveAzureOnApiKey", () => {
  it("prefers an explicit flag key, stored literally", async () => {
    const result = await resolveAzureOnApiKey({ apiKey: "azkey123", apiKeyFromFlag: true });
    assert.deepEqual(result, { apiKey: "azkey123", apiKeyFromFlag: true, reusedExistingKey: false });
  });

  it("reuses an existing literal key", async () => {
    const result = await resolveAzureOnApiKey({ getExistingKey: async () => "stored-literal" });
    assert.deepEqual(result, { apiKey: "stored-literal", apiKeyFromFlag: true, reusedExistingKey: true });
  });

  it("reuses an existing env-ref without marking it literal", async () => {
    const result = await resolveAzureOnApiKey({ getExistingKey: async () => AZURE_API_KEY_ENV_REF });
    assert.deepEqual(result, { apiKey: AZURE_API_KEY_ENV_REF, apiKeyFromFlag: false, reusedExistingKey: true });
  });

  it("falls back to the AZURE_API_KEY env reference", async () => {
    await withEnv(AZURE_API_KEY_ENV, "env-azure-key", async () => {
      const result = await resolveAzureOnApiKey({});
      assert.deepEqual(result, { apiKey: AZURE_API_KEY_ENV_REF, apiKeyFromFlag: false, reusedExistingKey: false });
    });
  });

  it("throws when no key is available", async () => {
    await withEnv(AZURE_API_KEY_ENV, undefined, async () => {
      await assert.rejects(() => resolveAzureOnApiKey({}), /No Azure API key/);
    });
  });
});

describe("effectiveAzureApiKey", () => {
  it("resolves the env reference to the real value", async () => {
    await withEnv(AZURE_API_KEY_ENV, "real-azure-key", async () => {
      assert.equal(effectiveAzureApiKey(AZURE_API_KEY_ENV_REF), "real-azure-key");
    });
  });

  it("returns literal keys untouched", () => {
    assert.equal(effectiveAzureApiKey("literal"), "literal");
  });

  it("returns empty for empty input", () => {
    assert.equal(effectiveAzureApiKey(""), "");
  });
});

describe("DEFAULT_AZURE_MODEL", () => {
  it("is a bare Foundry deployment name (no publisher prefix)", () => {
    assert.equal(typeof DEFAULT_AZURE_MODEL, "string");
    assert.ok(DEFAULT_AZURE_MODEL.length > 0);
    assert.doesNotMatch(DEFAULT_AZURE_MODEL, /^fireworks-ai\//);
  });
});
