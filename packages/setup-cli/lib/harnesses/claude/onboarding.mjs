import process from "node:process";

import { ANSI, accent, paint } from "../../ui.mjs";
import { promptSearch, promptSelect } from "../../ui/prompt.mjs";
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

const ONBOARDING_SLOT_ORDER = Object.freeze([
  "fable",
  "main",
  "opus",
  "sonnet",
  "haiku",
  "subagent",
]);

const SLOT_INTENT = Object.freeze({
  main: "general coding · tools · vision",
  opus: "capability · reasoning · long context",
  sonnet: "balanced capability · speed",
  haiku: "low latency · low cost",
  fable: "lighter general work · vision",
  subagent: "fast · economical tool use",
});

const STANDARD_MODELS = Object.freeze({
  main: "glm-latest",
  opus: "glm-latest",
  sonnet: "glm-latest",
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
  const width = Math.max(...ONBOARDING_SLOT_ORDER.map((slot) => SLOT_LABELS[slot].length));
  output.write(`${paint(ANSI.bold, "Model mapping", output)}\n`);
  for (const slot of ONBOARDING_SLOT_ORDER) {
    output.write([
      "  ",
      paint(ANSI.muted, SLOT_LABELS[slot].padEnd(width), output),
      ` ${accent("→", output)} `,
      accent(mapping[slot], output),
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
  catalog = null,
  loadCatalog = async () => [],
  select = promptSelect,
  search = promptSearch,
  input = process.stdin,
  output = process.stdout,
}) {
  let mapping = { ...initialMapping };
  let availableCatalog = catalog;
  const baselineSelectionMode = CLAUDE_MODEL_SLOTS.every(
    (slot) => initialMapping[slot] === nonFastMapping[slot],
  ) ? "non-fast" : "all";
  let selectionMode = baselineSelectionMode;
  let focus = ONBOARDING_SLOT_ORDER.length;
  while (true) {
    const changed = CLAUDE_MODEL_SLOTS.some(
      (slot) => mapping[slot] !== initialMapping[slot],
    );
    const choices = [
      ...ONBOARDING_SLOT_ORDER.map((slot, index) => ({
        name: modelChoiceName(SLOT_LABELS[slot], mapping[slot], output),
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
          "",
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
      mapping = { ...nonFastMapping };
      selectionMode = "non-fast";
      focus = ONBOARDING_SLOT_ORDER.length;
      continue;
    }
    if (action.action === "fast") {
      mapping = { ...fastMapping };
      selectionMode = "all";
      focus = ONBOARDING_SLOT_ORDER.length;
      continue;
    }
    if (action.action === "reset") {
      mapping = { ...initialMapping };
      selectionMode = baselineSelectionMode;
      focus = ONBOARDING_SLOT_ORDER.length;
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
    focus = Math.min(action.index + 1, ONBOARDING_SLOT_ORDER.length);
  }
}

/**
 * First-run model setup. Save is selected by default; each visible row can be
 * edited without entering a second profile-selection screen.
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
  const standard = standardClaudeModelMapping(keyType);
  output.write(`\n${paint(
    ANSI.muted,
    "Set Claude Code model defaults (you can change these later with model flags).",
    output,
  )}\n`);
  const currentMapping = mappingLabel === "Current";
  return runClaudeMappingEditor({
    initialMapping: recommended,
    recommended: currentMapping ? fastDefaults : recommended,
    fastMapping: fastDefaults,
    nonFastMapping: standard,
    baselineLabel: mappingLabel,
    loadCatalog,
    select,
    search,
    input,
    output,
  });
}
