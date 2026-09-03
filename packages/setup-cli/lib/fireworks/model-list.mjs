import { resolveModelDisplayMetadata } from "./model-display.mjs";
import { visionCapabilityLabel } from "./vision.mjs";
import { attachPricing } from "./pricing.mjs";
import {
  autoCatalogEntry,
  filterCatalogBySearch,
  catalogWithAutomaticFirerouter,
  isAutoCatalogEntry,
  loadServerlessCatalog,
  newestModelsByFamily,
  preferLatestAliases,
} from "./models.mjs";
import { KNOWN_AUTO_MODEL_IDS, canonicalAutoModelId } from "./model-id.mjs";
import { bold, dim, warn, withSpinner } from "../ui.mjs";
import { stripViaFireworksSuffix } from "./models.mjs";

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return `$${value.toFixed(3)}`;
}

export function formatCatalogUpdatedAt(updatedAt, timeZone = undefined) {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "bundled with FireConnect";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(updatedAt));
}

function catalogUpdatedAtIso(updatedAt) {
  return Number.isFinite(updatedAt) && updatedAt > 0
    ? new Date(updatedAt).toISOString()
    : null;
}

function printCatalogFooter(displayCount, updatedAt) {
  const count = displayCount == null
    ? ""
    : `${displayCount} model${displayCount === 1 ? "" : "s"} · `;
  console.log(dim(`${count}Last updated: ${formatCatalogUpdatedAt(updatedAt)}`));
  console.log(dim("Refresh catalog: fireconnect model list --refresh"));
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

function isUsRouter(entry) {
  return entry.shortId?.endsWith("-us");
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => left.shortId.localeCompare(right.shortId));
}

export function organizeCatalogForDisplay(catalog) {
  // `auto` sorts ahead of `firerouter`, so the smart-routing section leads with
  // the default recommendation.
  const smartRouters = catalog.filter((entry) => (
    entry.shortId === "firerouter" || isAutoCatalogEntry(entry)
  ));
  // Collapse versioned families via their -latest router aliases across the
  // whole catalog, then split. Running preferLatestAliases over the full set is
  // what keeps standalone models that have no -latest alias (gpt-oss-120b,
  // inkling, nemotron-3-ultra-nvfp4) visible instead of dropping them.
  const preferred = preferLatestAliases(catalog.filter((entry) => (
    entry.shortId !== "firerouter"
    && !isAutoCatalogEntry(entry)
  )));
  const routers = preferred.filter((entry) => entry.id.includes("/routers/"));
  const usRouters = routers.filter(isUsRouter);
  const fastRouters = routers.filter(isFastLatestRouter);
  const latestRouters = routers.filter((entry) => (
    !isFastLatestRouter(entry)
    && entry.shortId.endsWith("-latest")
  ));
  // Read straight off the catalog rather than following each -latest router to
  // its pinned base model: a stale ROUTER_SPEC_ALIASES target must not be able
  // to hide the newest version the API is serving.
  const models = newestModelsByFamily(catalog);

  return [
    {
      title: "SMART ROUTERS",
      description: "pick a model per request",
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
      title: "US-ONLY ROUTERS",
      description: "inference stays in the US",
      entries: sortEntries(usRouters),
    },
    {
      title: "INDIVIDUAL MODELS",
      description: "pinned versions",
      entries: sortEntries(models),
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

/** Fire Pass advertises only its own curated routers, so `auto` is standard-key only. */
export function globalListIncludesAuto(keyType) {
  return keyType !== "firepass";
}

/**
 * Add the synthesized auto-mix rows for display. The gateway serves them
 * without listing them, so `model list` is the only place they can come from.
 *
 * Rows come from KNOWN_AUTO_MODEL_IDS, not from the `auto-*` matcher that
 * governs acceptance: a name can only be advertised once FireConnect knows it
 * exists, while `--model` stays free to pass a newer mix straight through.
 * @param {import("./models.mjs").CatalogEntry[]} catalog
 */
export function catalogWithAutoEntry(catalog, keyType) {
  if (!globalListIncludesAuto(keyType)) {
    return catalog;
  }
  const present = new Set(
    catalog
      .filter(isAutoCatalogEntry)
      .map((entry) => canonicalAutoModelId(entry.shortId) || canonicalAutoModelId(entry.id)),
  );
  const missing = KNOWN_AUTO_MODEL_IDS
    .filter((id) => !present.has(id))
    .map((id) => autoCatalogEntry(id));
  return missing.length ? [...missing, ...catalog] : catalog;
}

export async function runModelListCommand({ options, apiKey }) {
  const refresh = Boolean(options.refresh);
  const { catalog, keyType, source, updatedAt } = await withSpinner(
    refresh ? "Refreshing Fireworks model catalog…" : "Fetching Fireworks model catalog…",
    () => loadServerlessCatalog({ apiKey, refresh }),
  );

  const fullCatalog = catalogWithAutoEntry(
    catalogWithAutomaticFirerouter(catalog, keyType, {
      includeFirerouter: globalListIncludesFirerouter(keyType),
    }),
    keyType,
  );

  const enriched = enrichCatalogWithPricing(fullCatalog, {
    firepass: keyType === "firepass",
  });

  if (options.json) {
    const filtered = filterCatalogBySearch(enriched, options.search);
    console.log(JSON.stringify({
      keyType,
      source,
      updatedAt: catalogUpdatedAtIso(updatedAt),
      count: filtered.length,
      models: filtered,
    }, null, 2));
    return;
  }

  if (keyType === "firepass") {
    console.log(warn("Fire Pass key: showing Fire Pass-supported serverless routers."));
    console.log("");
  }

  // A refresh that couldn't reach the gateway falls back to the last snapshot,
  // so say so rather than presenting cached rows as freshly fetched.
  if (refresh && source === "stale") {
    console.log(warn("Couldn't reach Fireworks — showing the last cached catalog."));
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
    console.log("");
    printCatalogFooter(null, updatedAt);
    return;
  }

  console.log(formatCatalogSections(sections));
  console.log("");
  printCatalogFooter(displayCount, updatedAt);
}
