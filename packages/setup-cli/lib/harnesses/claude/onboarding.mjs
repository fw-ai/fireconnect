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
  select,
  search,
  input,
  output,
}) {
  if (catalog.length === 0) {
    return null;
  }
  const options = {
    slot,
    currentModel: mapping[slot],
    recommendedModel: recommended[slot],
  };
  const ranked = rankClaudeModelsForSlot(catalog, options);
  const suitable = suitableClaudeModelsForSlot(catalog, options);
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
      message: "Claude model mapping · select a row to change it",
      choices,
      initialIndex: focus,
      summary: false,
      input,
      output,
    });
    if (!action) return null;
    if (action.action === "save") return mapping;
    if (action.action === "reset") {
      mapping = { ...initialMapping };
      focus = slots.length;
      continue;
    }
    availableCatalog ??= await loadCatalog();
    const model = await selectModelForSlot({
      slot: action.slot,
      mapping,
      recommended,
      catalog: availableCatalog,
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
 *   shownMapping: Record<string, string>,
 *   badgeMapping?: Record<string, string>,
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
  shownMapping,
  badgeMapping = shownMapping,
  mappingLabel = "Recommended",
  keyType = "fireworks",
  input = process.stdin,
  output = process.stdout,
  select = promptSelect,
  search = promptSearch,
  loadCatalog = async () => [],
}) {
  output.write(`\n${paint(
    ANSI.muted,
    "Set Claude Code model defaults (you can change these later with model flags).",
    output,
  )}\n`);
  return runClaudeMappingEditor({
    initialMapping: shownMapping,
    recommended: badgeMapping,
    baselineLabel: mappingLabel,
    slots: onboardingSlotOrder(keyType, shownMapping),
    loadCatalog,
    select,
    search,
    input,
    output,
  });
}
