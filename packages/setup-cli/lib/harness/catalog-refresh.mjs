/**
 * Shared re-`on` refresh policy for Nexus-managed picker catalogs.
 *
 * Every harness stores its catalog in its own format — a JSON catalog file
 * (codex), provider model maps (opencode / copilot CLI), SQLite rows (copilot app),
 * Electron-state arrays (vscode, cursor), a models.json provider block (pi) —
 * but the refresh POLICY is one:
 *
 *   1. prune ids the provider no longer serves,
 *   2. keep gateway specials (the synthesized `auto` mix, FireRouter paths,
 *      per the caller's keepUnserved predicate),
 *   3. register newly served ids,
 *   4. re-render fresh metadata (price, context window, display name) for kept
 *      rows — the caller does this when applying the plan.
 *
 * Harnesses plug in their own parsing (how currentIds are read out of their
 * storage format, normalized into the same id space as freshIds) and their own
 * row building (how added/kept ids become storage rows); this module owns only
 * the id-set plan so all harnesses follow the same interface.
 *
 * {@link planModelList} applies the whole policy (fresh install, refresh,
 * unavailable catalog, the selected model); harnesses should call it rather
 * than branch themselves, and keep only the translation to their storage.
 *
 * @param {object} args
 * @param {string[]} args.currentIds ids currently registered (normalized)
 * @param {string[]} args.freshIds ids the provider serves now (same id space)
 * @param {(id: string) => boolean} [args.keepUnserved] keep a current id even
 *   though the provider doesn't list it (auto mix, FireRouter paths, …).
 *   Default: drop it.
 * @returns {{ kept: string[], pruned: string[], added: string[] }}
 */
export function planCatalogRefresh({ currentIds = [], freshIds = [], keepUnserved = () => false } = {}) {
  const freshSet = new Set(freshIds.filter(Boolean));
  const kept = [];
  const pruned = [];
  const seen = new Set();
  for (const id of currentIds) {
    if (!id || seen.has(id)) {
      pruned.push(id);
      continue;
    }
    seen.add(id);
    (freshSet.has(id) || keepUnserved(id) ? kept : pruned).push(id);
  }
  const added = [...freshSet].filter((id) => !seen.has(id));
  return { kept, pruned, added };
}

/**
 * The ids a harness's Nexus-managed model list should hold after `on` — the
 * one list policy every harness shares, so harness code only translates ids
 * to and from its own storage:
 *
 * - a fresh install seeds the whole catalog;
 * - otherwise an available catalog reconciles the list (see
 *   {@link planCatalogRefresh}): delisted ids are pruned, newly served ones
 *   added, so an account switch or plan change shows up on the next `on`;
 * - an unavailable catalog (offline, or only another account's stale copy)
 *   or an empty one keeps the list as it is: only a served catalog may
 *   prune (a plan limited to `auto` still serves `auto`);
 * - the selected model (`--model`, or the current one on a plain re-`on`)
 *   is always present: `--model` picks the active model, it never narrows
 *   the menu or stops the list from tracking the catalog.
 *
 * Order: kept ids in their current order, then added ones; a fresh install
 * lists the selection first.
 * @param {object} args
 * @param {string[]} [args.currentIds] ids currently registered (normalized)
 * @param {string[]} [args.freshIds] ids the catalog serves now (same id space)
 * @param {boolean} args.catalogAvailable whether freshIds is this account's catalog
 * @param {boolean} [args.freshInstall] no managed list exists yet
 * @param {string} [args.selectedId] the model `on` selects ("" for none)
 * @param {(id: string) => boolean} [args.keepUnserved] see {@link planCatalogRefresh}
 * @returns {string[]}
 */
export function planModelList({
  currentIds = [],
  freshIds = [],
  catalogAvailable,
  freshInstall = false,
  selectedId = "",
  keepUnserved = () => false,
}) {
  const unique = (ids) => [...new Set(ids.filter(Boolean))];
  if (freshInstall) {
    return unique([selectedId, ...freshIds]);
  }
  if (!catalogAvailable || !freshIds.some(Boolean)) {
    return unique([...currentIds, selectedId]);
  }
  const { kept, added } = planCatalogRefresh({
    currentIds,
    freshIds,
    keepUnserved: (id) => id === selectedId || keepUnserved(id),
  });
  return unique([...kept, ...added, selectedId]);
}
