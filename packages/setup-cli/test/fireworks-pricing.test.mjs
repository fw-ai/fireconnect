import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachPricing,
  formatPricingDescription,
  formatPricingInOut,
  formatPricingLine,
  lookupFireworksPricing,
} from "../lib/fireworks-pricing.mjs";
import { fireworksCustomOptionFields } from "../lib/fireconnect-core.mjs";

describe("fireworks-pricing", () => {
  it("resolves glm-latest router to GLM 5.2 standard rates", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/glm-latest");
    assert.ok(pricing);
    assert.equal(pricing.input, 1.40);
    assert.equal(pricing.output, 4.40);
    assert.equal(pricing.tier, "standard");
  });

  it("resolves glm-latest[1m] context suffix", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/glm-latest[1m]");
    assert.equal(pricing?.slug, "glm-5p2");
  });

  it("resolves fast routers to fast-tier pricing", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/routers/kimi-k2p7-code-fast");
    assert.equal(pricing?.tier, "fast");
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

  it("formats compact in/out pricing for tables", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/models/glm-5p1");
    assert.equal(formatPricingInOut(pricing), "$1.4 / $4.4");
  });

  it("formats a full pricing line for status output", () => {
    const pricing = lookupFireworksPricing("accounts/fireworks/models/glm-5p2");
    assert.match(formatPricingLine(pricing), /\$1\.4 in \/ \$0\.26 cached in \/ \$4\.4 out per Mtok/);
  });

  it("includes Fireworks rates in custom model descriptions", () => {
    const fields = fireworksCustomOptionFields("accounts/fireworks/routers/glm-latest");
    assert.match(fields.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION, /Fireworks serverless \(GLM 5\.2\)/);
    assert.match(fields.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION, /\$1\.4 in \/ \$4\.4 out per Mtok/);
  });

  it("returns null pricing metadata for unknown models", () => {
    assert.equal(lookupFireworksPricing("accounts/fireworks/models/unknown-model"), null);
    assert.equal(attachPricing("accounts/fireworks/models/unknown-model"), null);
  });

  it("falls back to docs link when pricing is unknown", () => {
    assert.match(
      formatPricingDescription(null),
      /docs\.fireworks\.ai\/serverless\/pricing/,
    );
  });
});
