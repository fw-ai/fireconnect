import { lookupVscodeModelMetadata } from "./fireworks-model-specs.mjs";
import { attachPricing } from "./fireworks-pricing.mjs";
import {
  filterCatalogBySearch,
  loadServerlessCatalog,
} from "./fireworks-models.mjs";

function formatTable(catalog) {
  const idWidth = Math.max(8, ...catalog.map((entry) => entry.shortId.length));
  const nameWidth = Math.max(12, ...catalog.map((entry) => entry.displayName.length));
  const priceWidth = Math.max(12, ...catalog.map((entry) => (entry.pricingDisplay ?? "—").length));

  const header = `${"ID".padEnd(idWidth)}  ${"NAME".padEnd(nameWidth)}  ${"IN / OUT".padEnd(priceWidth)}  KIND`;
  const lines = catalog.map((entry) => (
    `${entry.shortId.padEnd(idWidth)}  ${entry.displayName.padEnd(nameWidth)}  ${(entry.pricingDisplay ?? "—").padEnd(priceWidth)}  ${entry.kind}`
  ));

  return [header, ...lines].join("\n");
}

function enrichCatalogWithPricing(catalog) {
  return catalog.map((entry) => {
    const pricing = attachPricing(entry.id);
    return {
      ...entry,
      ...lookupVscodeModelMetadata(entry.id),
      pricing,
      pricingDisplay: pricing?.display ?? "—",
    };
  });
}

export async function runModelListCommand({ options, harness = "", apiKey }) {
  const { catalog, keyType } = await loadServerlessCatalog({ apiKey });

  const filtered = filterCatalogBySearch(catalog, options.search);
  const enriched = enrichCatalogWithPricing(filtered);

  if (options.json) {
    console.log(JSON.stringify({
      keyType,
      count: enriched.length,
      models: enriched,
    }, null, 2));
    return;
  }

  if (keyType === "firepass") {
    console.log("Fire Pass key: showing Fire Pass-supported serverless routers.");
    console.log("");
  }

  if (enriched.length === 0) {
    console.log("No serverless models matched your query.");
    return;
  }

  console.log(formatTable(enriched));
  console.log("");
  console.log(`Showing ${enriched.length} serverless endpoint${enriched.length === 1 ? "" : "s"}.`);
  console.log("Prices are Fireworks standard serverless in/out per 1M tokens (USD).");
  if (harness) {
    console.log(`Pick interactively: fireconnect ${harness} model select`);
  }
}
