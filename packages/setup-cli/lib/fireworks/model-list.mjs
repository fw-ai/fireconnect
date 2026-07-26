import { lookupVscodeModelMetadata } from "./model-specs.mjs";
import { visionCapabilityLabel } from "./vision.mjs";
import { attachPricing } from "./pricing.mjs";
import {
  filterCatalogBySearch,
  catalogWithAutomaticFirerouter,
  loadServerlessCatalog,
  preferLatestAliases,
} from "./models.mjs";
import { bold, dim, warn, withSpinner } from "../ui.mjs";
import { stripViaFireworksSuffix } from "./models.mjs";

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const text = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `$${text}`;
}

function displayName(entry) {
  const name = stripViaFireworksSuffix(entry.displayName);
  const visionLabel = visionCapabilityLabel(entry.id);
  return visionLabel === "text-only" ? `${name} (text-only)` : name;
}

function isFastRouter(entry) {
  return entry.pricing?.tier === "fast"
    || /(?:-fast|-turbo)(?:-|$)/i.test(entry.shortId);
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => left.shortId.localeCompare(right.shortId));
}

export function organizeCatalogForDisplay(catalog) {
  const smartRouters = catalog.filter((entry) => entry.shortId === "firerouter");
  const routers = preferLatestAliases(catalog.filter((entry) => (
    entry.shortId !== "firerouter"
    && entry.id.includes("/routers/")
  )));
  const models = preferLatestAliases(catalog.filter((entry) => entry.id.includes("/models/")));

  const fastRouters = routers.filter(isFastRouter);
  const latestRouters = routers.filter((entry) => (
    !isFastRouter(entry)
    && entry.shortId.endsWith("-latest")
  ));
  const otherRouters = routers.filter((entry) => (
    !fastRouters.includes(entry)
    && !latestRouters.includes(entry)
  ));

  return [
    {
      title: "SMART ROUTER",
      description: "",
      entries: sortEntries(smartRouters),
    },
    {
      title: "LATEST ROUTERS",
      description: "recommended, automatically track new versions",
      entries: sortEntries(latestRouters),
    },
    {
      title: "FAST ROUTERS",
      description: "higher tokens per second",
      entries: sortEntries(fastRouters),
    },
    {
      title: "INDIVIDUAL MODELS",
      description: "pinned versions",
      entries: sortEntries(models),
    },
    {
      title: "OTHER ROUTERS",
      description: "",
      entries: sortEntries(otherRouters),
    },
  ].filter((section) => section.entries.length > 0);
}

function tableWidths(catalog) {
  return {
    id: Math.max(8, ...catalog.map((entry) => entry.shortId.length)),
    name: Math.max(12, ...catalog.map((entry) => displayName(entry).length)),
    input: Math.max(5, ...catalog.map((entry) => formatUsd(entry.pricing?.inputPerMillion).length)),
    cached: Math.max(6, ...catalog.map((entry) => formatUsd(entry.pricing?.cachedInputPerMillion).length)),
    output: Math.max(6, ...catalog.map((entry) => formatUsd(entry.pricing?.outputPerMillion).length)),
  };
}

function formatTable(catalog, widths) {
  const header = bold(
    `${"ID".padEnd(widths.id)}  `
    + `${"NAME".padEnd(widths.name)}  `
    + `${"INPUT".padStart(widths.input)}  `
    + `${"CACHED".padStart(widths.cached)}  `
    + `${"OUTPUT".padStart(widths.output)}`,
  );
  const lines = catalog.map((entry) => {
    const input = formatUsd(entry.pricing?.inputPerMillion).padStart(widths.input);
    const cached = formatUsd(entry.pricing?.cachedInputPerMillion).padStart(widths.cached);
    const output = formatUsd(entry.pricing?.outputPerMillion).padStart(widths.output);
    return (
      `${bold(entry.shortId.padEnd(widths.id))}  `
      + `${displayName(entry).padEnd(widths.name)}  `
      + `${dim(input)}  ${dim(cached)}  ${dim(output)}`
    );
  });
  return [header, ...lines].join("\n");
}

export function formatCatalogSections(sections) {
  const catalog = sections.flatMap((section) => section.entries);
  const widths = tableWidths(catalog);
  const lines = [
    bold("FireConnect coding models"),
    dim("Prices in USD per 1M tokens."),
  ];

  for (const section of sections) {
    const heading = section.description
      ? `${section.title} — ${section.description}`
      : section.title;
    lines.push("", bold(heading), formatTable(section.entries, widths));
  }
  return lines.join("\n");
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

export function globalListIncludesFirerouter(keyType) {
  return keyType !== "firepass";
}

export async function runModelListCommand({ options, apiKey }) {
  const { catalog, keyType } = await withSpinner(
    "Fetching Fireworks model catalog…",
    () => loadServerlessCatalog({ apiKey }),
  );

  const fullCatalog = catalogWithAutomaticFirerouter(catalog, keyType, {
    includeFirerouter: globalListIncludesFirerouter(keyType),
  });

  const enriched = enrichCatalogWithPricing(fullCatalog);

  if (options.json) {
    const filtered = filterCatalogBySearch(enriched, options.search);
    console.log(JSON.stringify({
      keyType,
      count: filtered.length,
      models: filtered,
    }, null, 2));
    return;
  }

  if (keyType === "firepass") {
    console.log(warn("Fire Pass key: showing Fire Pass-supported serverless routers."));
    console.log("");
  }

  const sections = organizeCatalogForDisplay(enriched)
    .map((section) => ({
      ...section,
      entries: filterCatalogBySearch(section.entries, options.search),
    }))
    .filter((section) => section.entries.length > 0);
  const displayCount = sections.reduce((total, section) => total + section.entries.length, 0);

  if (displayCount === 0) {
    console.log("No serverless models matched your query.");
    return;
  }

  console.log(formatCatalogSections(sections));
  console.log("");
  console.log(dim(`${displayCount} model${displayCount === 1 ? "" : "s"}.`));
}
