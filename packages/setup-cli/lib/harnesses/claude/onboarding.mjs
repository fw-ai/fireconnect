import process from "node:process";

import { ANSI, accent, paint } from "../../ui.mjs";
import { promptSearch, promptSelect } from "../../ui/prompt.mjs";
import {
  CLAUDE_NATIVE_MODEL_ID,
  formatClaudeSlotModelLabel,
} from "../../fireworks/model-id.mjs";
import { CLAUDE_MODEL_SLOTS } from "./model-profile.mjs";
import {
  filterClaudeModelPicker,
  modelPickerBadges,
  rankClaudeModelsForSlot,
  suitableClaudeModelsForSlot,
} from "./model-picker.mjs";

const SLOT_LABELS = Object.freeze({
  main: "Main",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  subagent: "Subagents",
});

// Main is deliberately absent: for fw_ keys FireConnect never pins it (see
// defaultClaudeModelMapping), so there is no row to edit. `--model` still sets it
// for anyone who wants it pinned on purpose.
const ONBOARDING_SLOT_ORDER = Object.freeze([
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "subagent",
]);

// Fire Pass has no Anthropic access, so every slot including main is pinned to a
// Fireworks model — main stays editable there because it is actually written.
const FIREPASS_SLOT_ORDER = Object.freeze(["main", ...ONBOARDING_SLOT_ORDER]);

function isPinnedMainSlot(modelId) {
  return Boolean(modelId && modelId !== CLAUDE_NATIVE_MODEL_ID);
}

/**
 * Apply a fast/non-fast mapping without discarding a deliberate `--model` pin.
 *
 * For fw_ keys both mode mappings leave main native, so applying one verbatim
 * would silently clear a pin the user asked for. Fire Pass mappings do pin main
 * (it has no Anthropic fallback) and it is a normal editable row there, so the
 * toggle must update it like every other slot.
 */
function mappingForMode(target, current) {
  if (isPinnedMainSlot(target.main) || !isPinnedMainSlot(current.main)) {
    return { ...target };
  }
  return { ...target, main: current.main };
}

function onboardingSlotOrder(keyType, mapping = null) {
  if (keyType === "firepass") {
    return FIREPASS_SLOT_ORDER;
  }
  return isPinnedMainSlot(mapping?.main)
    ? ["main", ...ONBOARDING_SLOT_ORDER]
    : ONBOARDING_SLOT_ORDER;
}

const SLOT_INTENT = Object.freeze({
  main: "general coding · tools · vision",
  opus: "capability · reasoning · long context",
  sonnet: "balanced capability · speed",
  haiku: "low latency · low cost",
  fable: "lighter general work · vision",
  subagent: "fast · economical tool use",
});

// Non-fast counterparts of the defaults. Native slots stay native here too, so
// toggling non-fast never pins a main model or replaces the native Sonnet.
const STANDARD_MODELS = Object.freeze({
  main: CLAUDE_NATIVE_MODEL_ID,
  opus: "glm-latest",
  sonnet: CLAUDE_NATIVE_MODEL_ID,
  haiku: "deepseek-v4-pro",
  fable: "kimi-latest",
  subagent: "deepseek-v4-pro",
});

function profileChoiceName(label, detail, output) {
  const title = paint(ANSI.bold, label, output);
  return detail
    ? `${title} ${paint(ANSI.muted, `· ${detail}`, output)}`
    : title;
}

function modelChoiceName(label, model, output) {
  return [
    paint(ANSI.bold, label, output),
    paint(ANSI.muted, " · ", output),
    accent(model, output),
  ].join("");
}

export function printClaudeModelMapping(mapping, output = process.stdout) {
  // Show Main only when it is actually pinned (Fire Pass, or a deliberate
  // `--model`); an unpinned main has nothing to report.
  const rows = mapping.main && mapping.main !== CLAUDE_NATIVE_MODEL_ID
    ? FIREPASS_SLOT_ORDER
    : ONBOARDING_SLOT_ORDER;
  const width = Math.max(...rows.map((slot) => SLOT_LABELS[slot].length));
  output.write(`${paint(ANSI.bold, "Model mapping", output)}\n`);
  for (const slot of rows) {
    output.write([
      "  ",
      paint(ANSI.muted, SLOT_LABELS[slot].padEnd(width), output),
      ` ${accent("→", output)} `,
      accent(formatClaudeSlotModelLabel(mapping[slot]), output),
      "\n",
    ].join(""));
  }
  output.write("\n");
}

/**
 * The non-fast profile keeps aliases stable so future model upgrades can move
 * behind the aliases without changing persisted user preferences.
 */
export function standardClaudeModelMapping(keyType = "fireworks") {
  if (keyType === "firepass") {
    return Object.fromEntries(CLAUDE_MODEL_SLOTS.map((slot) => [slot, "glm-latest"]));
  }
  return { ...STANDARD_MODELS };
}

function pickerChoice(model, options, output) {
  const badges = modelPickerBadges(model, options);
  const pricing = model.pricing?.display ?? "";
  return {
    name: [
      accent(model.slug, output),
      badges.length > 0
        ? paint(ANSI.muted, ` · ${badges.join(" · ")}`, output)
        : "",
    ].join(""),
    short: model.slug,
    detail: [model.label, pricing].filter(Boolean).join(" · "),
  };
}

async function selectModelForSlot({
  slot,
  mapping,
  recommended,
  catalog,
  selectionMode,
  select,
  search,
  input,
  output,
}) {
  const compatibleCatalog = selectionMode === "non-fast"
    ? catalog.filter((model) => !model.fast && !model.firerouter)
    : catalog;
  if (compatibleCatalog.length === 0) {
    return null;
  }
  const options = {
    slot,
    currentModel: mapping[slot],
    recommendedModel: recommended[slot],
  };
  const ranked = rankClaudeModelsForSlot(compatibleCatalog, options);
  const suitable = suitableClaudeModelsForSlot(compatibleCatalog, options);
  const choices = suitable.map((model) => ({
    ...pickerChoice(model, options, output),
    value: { action: "model", model },
  }));
  if (ranked.length > suitable.length) {
    choices.push({
      name: profileChoiceName("Search all compatible models…", "", output),
      value: { action: "search" },
      short: "Search all",
    });
  }
  const choice = await select({
    message: `${SLOT_LABELS[slot]} · ${SLOT_INTENT[slot]}`,
    choices,
    summary: false,
    input,
    output,
  });
  if (!choice) return null;
  if (choice.action === "model") return choice.model;
  return search({
    message: `Search ${SLOT_LABELS[slot]} models · ${SLOT_INTENT[slot]}`,
    items: ranked,
    filter: filterClaudeModelPicker,
    toChoice: (model) => pickerChoice(model, options, output),
    summary: false,
    input,
    output,
  });
}

export async function runClaudeMappingEditor({
  initialMapping,
  recommended,
  fastMapping = recommended,
  nonFastMapping,
  baselineLabel = "Recommended",
  slots = ONBOARDING_SLOT_ORDER,
  catalog = null,
  loadCatalog = async () => [],
  select = promptSelect,
  search = promptSearch,
  input = process.stdin,
  output = process.stdout,
}) {
  let mapping = { ...initialMapping };
  let availableCatalog = catalog;
  const nonFastChangesNothing = slots
    .every((slot) => fastMapping[slot] === nonFastMapping[slot]);
  // "Already non-fast" means the mapping the non-fast button would produce, not a
  // raw comparison against nonFastMapping — otherwise a preserved main pin (which
  // the toggle keeps) reads as a difference and the header claims fast mode while
  // every editable slot is already non-fast.
  const nonFastBaseline = mappingForMode(nonFastMapping, initialMapping);
  const baselineSelectionMode = CLAUDE_MODEL_SLOTS.every(
    (slot) => initialMapping[slot] === nonFastBaseline[slot],
  ) ? "non-fast" : "all";
  let selectionMode = baselineSelectionMode;
  let focus = slots.length;
  while (true) {
    const changed = CLAUDE_MODEL_SLOTS.some(
      (slot) => mapping[slot] !== initialMapping[slot],
    );
    const choices = [
      ...slots.map((slot, index) => ({
        name: modelChoiceName(SLOT_LABELS[slot], formatClaudeSlotModelLabel(mapping[slot]), output),
        value: { action: "edit", slot, index },
        short: SLOT_LABELS[slot],
      })),
      {
        name: profileChoiceName(
          "Save mapping",
          changed ? "changes ready" : baselineLabel,
          output,
        ),
        value: { action: "save" },
        short: "Save mapping",
      },
      {
        name: profileChoiceName(
          selectionMode === "non-fast" ? "Use fast models" : "Use non-fast models",
          selectionMode === "non-fast" || nonFastChangesNothing ? "" : "all slots",
          output,
        ),
        value: { action: selectionMode === "non-fast" ? "fast" : "non-fast" },
        short: selectionMode === "non-fast" ? "Fast models" : "Non-fast models",
      },
      ...(changed ? [{
        name: profileChoiceName(
          baselineLabel === "Current" ? "Discard edits" : "Reset to recommended",
          "",
          output,
        ),
        value: { action: "reset" },
        short: "Reset",
      }] : []),
    ];
    const action = await select({
      message: selectionMode === "non-fast"
        ? "Claude model mapping · Non-fast mode · select a row to change it"
        : "Claude model mapping · select a row to change it",
      choices,
      initialIndex: focus,
      summary: false,
      input,
      output,
    });
    if (!action) return null;
    if (action.action === "save") return mapping;
    if (action.action === "non-fast") {
      mapping = mappingForMode(nonFastMapping, mapping);
      selectionMode = "non-fast";
      focus = slots.length;
      continue;
    }
    if (action.action === "fast") {
      mapping = mappingForMode(fastMapping, mapping);
      selectionMode = "all";
      focus = slots.length;
      continue;
    }
    if (action.action === "reset") {
      mapping = { ...initialMapping };
      selectionMode = baselineSelectionMode;
      focus = slots.length;
      continue;
    }
    availableCatalog ??= await loadCatalog();
    const model = await selectModelForSlot({
      slot: action.slot,
      mapping,
      recommended: selectionMode === "non-fast" ? nonFastMapping : recommended,
      catalog: availableCatalog,
      selectionMode,
      select,
      search,
      input,
      output,
    });
    if (model) {
      mapping[action.slot] = model.slug;
    }
    focus = Math.min(action.index + 1, slots.length);
  }
}

/**
 * First-run model setup: a single screen. There is no "how do you want to run
 * Claude Code?" question — every slot is editable here, so an all-Fireworks or a
 * mostly-Anthropic mapping is one or two edits away from the same defaults.
 *
 * @param {{
 *   recommended: Record<string, string>,
 *   fastDefaults: Record<string, string>,
 *   mappingLabel?: "Recommended"|"Current",
 *   keyType?: string,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 *   select?: typeof promptSelect,
 *   search?: typeof promptSearch,
 *   loadCatalog?: () => Promise<object[]>,
 * }} args
 */
export async function runClaudeModelOnboarding({
  recommended,
  fastDefaults,
  mappingLabel = "Recommended",
  keyType = "fireworks",
  input = process.stdin,
  output = process.stdout,
  select = promptSelect,
  search = promptSearch,
  loadCatalog = async () => [],
}) {
  const currentMapping = mappingLabel === "Current";
  const initialMapping = recommended;
  const fastMapping = fastDefaults;
  const nonFastMapping = standardClaudeModelMapping(keyType);
  output.write(`\n${paint(
    ANSI.muted,
    "Set Claude Code model defaults (you can change these later with model flags).",
    output,
  )}\n`);
  return runClaudeMappingEditor({
    initialMapping,
    recommended: currentMapping ? fastMapping : initialMapping,
    fastMapping,
    nonFastMapping,
    baselineLabel: mappingLabel,
    slots: onboardingSlotOrder(keyType, initialMapping),
    loadCatalog,
    select,
    search,
    input,
    output,
  });
}
