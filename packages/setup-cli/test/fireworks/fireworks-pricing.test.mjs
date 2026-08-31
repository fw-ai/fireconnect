import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachPricing,
  formatPricingDescription,
  formatPricingInOut,
  formatPricingLine,
  lookupFireworksPricing,
} from "../../lib/fireworks/pricing.mjs";
import { buildPickerCatalogFromApiModels } from "../../lib/fireworks/models.mjs";
import { setServerlessCatalogSnapshot } from "../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel } from "../helpers.mjs";

function seedPricingCache() {
  buildPickerCatalogFromApiModels([
    mockServerlessModel(),
    mockServerlessModel({
      name: "accounts/fireworks/models/kimi-k2p7-code",
      displayName: "Kimi K2.7 Code",
      serverlessModes: [
        {
          name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/default",
          skuInfos: [
            { sku: "LLM input tokens (uncached)", amount: { nanos: 950_000_000 } },
            { sku: "LLM output tokens", amount: { units: "4" } },
          ],
        },
        {
          name: "accounts/fireworks/models/kimi-k2p7-code/serverlessModes/fast",
          usageIdentifier: "accounts/fireworks/routers/kimi-fast-latest",
          skuInfos: [
            { sku: "LLM input tokens (uncached)", amount: { units: "1", nanos: 900_000_000 } },
            { sku: "LLM output tokens", amount: { units: "8" } },
          ],
        },
      ],
    }),
  ]);
}

seedPricingCache();

describe("fireworks-pricing", () => {
  it("resolves glm-latest router to GLM 5.2 standard rates", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/glm-latest");
    assert.ok(pricing);
    assert.equal(pricing.input, 1.40);
    assert.equal(pricing.cachedInput, 0.14);
    assert.equal(pricing.output, 4.40);
    assert.equal(pricing.tier, "standard");
  });

  it("resolves glm-latest[1m] context suffix via live router cache", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/glm-latest[1m]");
    assert.equal(pricing?.slug, "glm-latest");
    assert.equal(pricing?.input, 1.40);
  });

  it("resolves fast routers to fast-tier pricing", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/kimi-fast-latest");
    assert.equal(pricing?.tier, "fast");
    assert.equal(pricing?.output, 8.00);
  });

  it("resolves short router slugs to live cached pricing", () => {
    const pricing = lookupFireworksPricing("kimi-fast-latest");
    assert.equal(pricing?.tier, "fast");
    assert.equal(pricing?.input, 1.90);
    assert.equal(pricing?.output, 8.00);
  });

  it("resolves glm-5p2-fast router to GLM 5.2 fast-tier rates", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/glm-5p2-fast");
    assert.ok(pricing);
    assert.equal(pricing.slug, "glm-5p2-fast");
    assert.equal(pricing.tier, "fast");
    assert.equal(pricing.input, 2.10);
    assert.equal(pricing.cachedInput, 0.21);
    assert.equal(pricing.output, 6.60);
  });

  it("uses documented US-only pricing instead of cached global base rates", () => {
    const kimiUs = lookupFireworksPricing("kimi-k3-us");
    assert.equal(kimiUs?.slug, "kimi-k3-us");
    assert.equal(kimiUs?.input, 3.30);
    assert.equal(kimiUs?.cachedInput, 0.33);
    assert.equal(kimiUs?.output, 16.50);

    const glmFastUs = lookupFireworksPricing("glm-5p2-fast-us");
    assert.equal(glmFastUs?.slug, "glm-5p2-fast-us");
    assert.equal(glmFastUs?.tier, "fast");
    assert.equal(glmFastUs?.input, 2.10);
    assert.equal(glmFastUs?.cachedInput, 0.21);
    assert.equal(glmFastUs?.output, 6.60);

    const glmFlashUs = lookupFireworksPricing("glm-5p3-flash-us");
    assert.equal(glmFlashUs?.slug, "glm-5p3-flash-us");
    assert.equal(glmFlashUs?.input, 0.225);
    assert.equal(glmFlashUs?.cachedInput, 0.045);
    assert.equal(glmFlashUs?.output, 0.75);
  });

  it("formats compact in/out pricing for tables", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/models/glm-5p2");
    assert.equal(formatPricingInOut(pricing), "$1.4 / $4.4");
  });

  it("formats a full pricing line for status output", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/models/glm-5p2");
    assert.match(formatPricingLine(pricing), /\$1\.4 in \/ \$0\.14 cached in \/ \$4\.4 out per Mtok/);
  });

  it("returns null pricing metadata for unknown models", () => {
    assert.equal(lookupFireworksPricing("accounts/fireworks/models/unknown-model"), null);
    assert.equal(attachPricing("accounts/fireworks/models/unknown-model"), null);
  });

  it("keeps static pricing for deprecated glm-5p1 deployments", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/models/glm-5p1");
    assert.equal(pricing?.label, "GLM 5.1");
    assert.equal(pricing?.input, 1.40);
  });

  it("falls back to docs link when pricing is unknown", () => {
    assert.match(
      formatPricingDescription(null),
      /docs\.fireworks\.ai\/serverless\/pricing/,
    );
  });

  it("falls back to static specs when cached pricing is all zero", () => {
    setServerlessCatalogSnapshot({
      entries: [],
      pricingById: new Map([
        ["accounts/fireworks/models/glm-5p2", {
          slug: "glm-5p2",
          label: "GLM 5.2",
          input: 0,
          cachedInput: 0,
          output: 0,
          tier: "standard",
          source: "https://docs.fireworks.ai/serverless/pricing",
        }],
      ]),
      inputModalitiesById: new Map(),
      routerBaseModelById: new Map(),
      contextLengthById: new Map(),
      supportsToolsById: new Map(),
    });
    const pricing = lookupFireworksPricing("accounts/fireworks/models/glm-5p2");
    assert.equal(pricing?.input, 1.40);
    assert.equal(pricing?.output, 4.40);
    seedPricingCache();
  });
});
