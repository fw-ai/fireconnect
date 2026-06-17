import {
  filterCatalogBySearch,
  loadServerlessCatalog,
} from "./fireworks-models.mjs";

function formatTable(catalog) {
  const idWidth = Math.max(8, ...catalog.map((entry) => entry.shortId.length));
  const nameWidth = Math.max(12, ...catalog.map((entry) => entry.displayName.length));

  const header = `${"ID".padEnd(idWidth)}  ${"NAME".padEnd(nameWidth)}  KIND`;
  const lines = catalog.map((entry) => (
    `${entry.shortId.padEnd(idWidth)}  ${entry.displayName.padEnd(nameWidth)}  ${entry.kind}`
  ));

  return [header, ...lines].join("\n");
}

export async function runModelListCommand({ options, harness = "", apiKey }) {
  const { catalog, keyType } = await loadServerlessCatalog({ apiKey });

  const filtered = filterCatalogBySearch(catalog, options.search);

  if (options.json) {
    console.log(JSON.stringify({
      keyType,
      count: filtered.length,
      models: filtered,
    }, null, 2));
    return;
  }

  if (keyType === "firepass") {
    console.log("Fire Pass key: showing the kimi-k2p7-code-fast serverless router only.");
    console.log("");
  }

  if (filtered.length === 0) {
    console.log("No serverless models matched your query.");
    return;
  }

  console.log(formatTable(filtered));
  console.log("");
  console.log(`Showing ${filtered.length} serverless endpoint${filtered.length === 1 ? "" : "s"}.`);
  if (harness) {
    console.log(`Pick interactively: fireconnect ${harness} model select`);
  }
}
