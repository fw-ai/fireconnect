import { resolveModelDisplayMetadata } from "./model-display.mjs";
import { resolveRouterSpecAliasTarget } from "./model-specs.mjs";
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

function isFastLatestRouter(entry) {
  // For now, the FAST section surfaces only the `-fast-latest` router aliases
  // (glm-fast-latest, kimi-fast-latest, …) — the versioned `-fast`/`-turbo`
  // models (kimi-k3-fast, glm-5p2-fast, …) collapse into those aliases via
  // preferLatestAliases and shouldn't be listed separately here.
  return entry.shortId?.endsWith("-fast-latest");
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => left.shortId.localeCompare(right.shortId));
}

function resolveLatestRouterBaseModelId(entry, catalog) {
  if (entry.baseModelId) {
    return entry.baseModelId;
  }
  const entryIds = new Set(catalog.map(({ id }) => id));
  const targetSlug = resolveRouterSpecAliasTarget(entry.shortId, entryIds);
  return targetSlug ? `accounts/fireworks/models/${targetSlug}` : null;
}

function individualModelsFromLatestRouters(catalog, latestRouters) {
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const modelIds = new Set();

  for (const router of latestRouters) {
    const baseModelId = resolveLatestRouterBaseModelId(router, catalog);
    if (baseModelId && catalogById.has(baseModelId)) {
      modelIds.add(baseModelId);
    }
  }

  return sortEntries([...modelIds].map((id) => catalogById.get(id)));
}

export function organizeCatalogForDisplay(catalog) {
  const smartRouters = catalog.filter((entry) => entry.shortId === "firerouter");
  // Collapse versioned families via their -latest router aliases across the
  // whole catalog, then split. Running preferLatestAliases over the full set is
  // what keeps standalone models that have no -latest alias (gpt-oss-120b,
  // inkling, nemotron-3-ultra-nvfp4) visible instead of dropping them.
  const preferred = preferLatestAliases(catalog.filter((entry) => (
    entry.shortId !== "firerouter"
  )));
  const routers = preferred.filter((entry) => entry.id.includes("/routers/"));
  const fastRouters = routers.filter(isFastLatestRouter);
  const latestRouters = routers.filter((entry) => (
    !isFastLatestRouter(entry)
    && entry.shortId.endsWith("-latest")
  ));
  const models = individualModelsFromLatestRouters(catalog, latestRouters);
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

function formatTable(catalog, widths, showPricing) {
  const header = bold(
    `${"ID".padEnd(widths.id)}  `
    + `${"NAME".padEnd(widths.name)}  `
    + (showPricing
      ? `${"INPUT".padStart(widths.input)}  `
        + `${"CACHED".padStart(widths.cached)}  `
        + `${"OUTPUT".padStart(widths.output)}`
      : ""),
  );
  const lines = catalog.map((entry) => {
    const base = `${bold(entry.shortId.padEnd(widths.id))}  `
      + `${displayName(entry).padEnd(widths.name)}`;
    if (!showPricing) {
      return base;
    }
    const input = formatUsd(entry.pricing?.inputPerMillion).padStart(widths.input);
    const cached = formatUsd(entry.pricing?.cachedInputPerMillion).padStart(widths.cached);
    const output = formatUsd(entry.pricing?.outputPerMillion).padStart(widths.output);
    return `${base}  ${dim(input)}  ${dim(cached)}  ${dim(output)}`;
  });
  return [header, ...lines].join("\n");
}

export function formatCatalogSections(sections) {
  const catalog = sections.flatMap((section) => section.entries);
  const widths = tableWidths(catalog);
  // Fire Pass is a subscription — no per-model metered pricing to display.
  const showPricing = catalog.some((entry) => entry.pricing);
  const lines = [
    bold("FireConnect coding models"),
    ...(showPricing ? [dim("Prices in USD per 1M tokens.")] : []),
  ];

  for (const section of sections) {
    const heading = section.description
      ? `${section.title} — ${section.description}`
      : section.title;
    lines.push("", bold(heading), formatTable(section.entries, widths, showPricing));
  }
  return lines.join("\n");
}

function enrichCatalogWithPricing(catalog, { firepass = false } = {}) {
  return catalog.map((entry) => {
    // Fire Pass is a subscription — no per-model metered pricing to display.
    const pricing = firepass ? null : attachPricing(entry.id);
    return {
      ...entry,
      ...resolveModelDisplayMetadata(entry.id),
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

  const enriched = enrichCatalogWithPricing(fullCatalog, {
    firepass: keyType === "firepass",
  });

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
