/**
 * Interactive setup form for `fireconnect demo` (replaces the old one-line
 * "press enter to race, or e to edit" consent prompt).
 *
 * Pre-fills reasonable defaults (from auto-detection + CLI flags) and lets the
 * user adjust them in place: move a cursor between fields with ↑/↓, cycle
 * choices with ←/→ (or jump with a number), and type to edit the seed / output
 * path. Enter races; q / Esc / Ctrl-C quits without making any call.
 *
 * Two layers, like the split-pane TUI:
 *   - `applyKey(state, key)` — a pure reducer, fully unit-testable (no TTY).
 *   - `runSetupForm(...)` — a thin raw-ANSI stdin/render shell that feeds keys
 *     to the reducer and redraws in place. Dep-free; reuses ./ansi.mjs.
 *
 * Non-TTY / --yes / --json paths never reach this module (the orchestrator
 * skips the form entirely).
 */

import process from "node:process";

import {
  BOLD, DIM, CYAN, RESET, REVERSE, HIDE_CURSOR, SHOW_CURSOR,
  HOME_CURSOR, CLEAR_SCREEN, moveTo, CLEAR_LINE, stripAnsi, visibleWidth, padRight,
} from "./ansi.mjs";
import { CUSTOM_DEMO_PROMPT_ID, DEMO_PRESETS } from "./presets.mjs";
import { FIREWORKS_MODEL_SPECS } from "../fireworks-model-specs.mjs";
import { lookupFireworksPricing } from "../fireworks-pricing.mjs";

// Curated challenger list — only specs that carry pricing, so the demo's
// `fireworksRates` never throws. Order = display order; default first.
const CURATED_CHALLENGER_IDS = [
  "glm-5p2-fast", "glm-5p2", "deepseek-v4-flash", "deepseek-v4-pro",
  "kimi-k2p7-code-fast", "kimi-k2p7-code", "qwen3p7-plus", "gpt-oss-120b",
];

/** @returns {{ id: string, label: string }[]} */
export function curatedChallengers() {
  return CURATED_CHALLENGER_IDS
    .filter((id) => FIREWORKS_MODEL_SPECS[id])
    .map((id) => ({ id, label: FIREWORKS_MODEL_SPECS[id].label }));
}

const PROMPT_OPTION_IDS = [...Object.keys(DEMO_PRESETS), CUSTOM_DEMO_PROMPT_ID];
const OUT_ALLOWED = /[A-Za-z0-9._\-\/]/;
const CUSTOM_PROMPT_ALLOWED = /[\x20-\x7e]/;

// Curated Anthropic model aliases for the incumbent side. Claude Code resolves
// these to the latest respective model on Anthropic direct. Order = display
// order; default first.
const CURATED_ANTHROPIC_MODELS = [
  { id: "opus", label: "Claude Opus" },
  { id: "sonnet", label: "Claude Sonnet" },
  { id: "haiku", label: "Claude Haiku" },
];
const CURATED_ANTHROPIC_IDS = CURATED_ANTHROPIC_MODELS.map((m) => m.id);

/**
 * @typedef {Object} FormField
 * @property {"choice"|"number"|"text"|"readonly"} type
 * @property {string} key
 * @property {string} label
 * @property {string[]} [options]   choice: option ids
 * @property {number} [index]       choice: selected index
 * @property {string} [text]        number/text: current raw text
 * @property {string} [display]     readonly: text to show
 * @property {number} [fallback]    number: default when empty
 */

/**
 * @typedef {Object} FormState
 * @property {object} defaults
 * @property {FormField[]} fields
 * @property {number} focus
 * @property {boolean} done
 * @property {boolean} quit
 */

/**
 * @param {{
 *   defaults: {
 *     promptSource: "preset"|"file"|"literal",
 *     promptPresetId?: string,
 *     promptText?: string,
 *     promptTitle?: string,
 *     challenger: string,
 *     out: string,
 *     incumbentModel?: string,
 *   },
 * }} args
 * @returns {FormState}
 */
export function createFormState({ defaults }) {
  return {
    defaults,
    fields: buildFields(defaults),
    focus: 0,
    done: false,
    quit: false,
  };
}

// ── field builders ────────────────────────────────────────────────────────────

/** The ordered field list. Prompt is always field[0]. */
function buildFields(defaults) {
  return [
    promptField(defaults),
    customPromptField(defaults),
    incumbentModelField(defaults),
    challengerField(defaults),
    outField(defaults),
  ];
}

function promptField(defaults) {
  const selected = defaults.promptSource === "preset"
    ? defaults.promptPresetId
    : CUSTOM_DEMO_PROMPT_ID;
  const presetIndex = Math.max(0, PROMPT_OPTION_IDS.indexOf(selected ?? ""));
  return { type: "choice", key: "prompt", label: "Prompt", options: PROMPT_OPTION_IDS, index: presetIndex };
}

function customPromptField(defaults) {
  const text = defaults.promptSource === "preset" ? "" : (defaults.promptText ?? "");
  return {
    type: "text",
    key: "customPrompt",
    label: "Custom task",
    text,
    fallback: "Describe the standalone HTML app to build",
  };
}

/** The Anthropic model for the incumbent side (choice of aliases). */
function incumbentModelField(defaults) {
  const cur = defaults.incumbentModel ?? "opus";
  return CURATED_ANTHROPIC_IDS.includes(cur)
    ? { type: "choice", key: "incumbentModel", label: "Your model", options: CURATED_ANTHROPIC_IDS, index: Math.max(0, CURATED_ANTHROPIC_IDS.indexOf(cur)) }
    : { type: "readonly", key: "incumbentModel", label: "Your model", display: cur };
}

function challengerField(defaults) {
  const challengerIds = curatedChallengers().map((c) => c.id);
  // If the configured challenger isn't in the curated list, lock the field
  // read-only so the user can't cycle into a model with no pricing entry.
  return challengerIds.includes(defaults.challenger)
    ? { type: "choice", key: "challenger", label: "Challenger", options: challengerIds, index: Math.max(0, challengerIds.indexOf(defaults.challenger)) }
    : { type: "readonly", key: "challenger", label: "Challenger", display: defaults.challenger };
}

function outField(defaults) {
  return { type: "text", key: "out", label: "Output", text: defaults.out ?? "", fallback: defaults.out || "./fireconnect-demo" };
}

/** Snapshot the currently-edited values. */
function readValues(state) {
  const byKey = Object.fromEntries(state.fields.map((f) => [f.key, f]));
  const vals = {};
  if (byKey.prompt?.type === "choice") vals.promptPresetId = byKey.prompt.options[byKey.prompt.index];
  if (byKey.customPrompt?.type === "text") vals.customPrompt = byKey.customPrompt.text;
  if (byKey.challenger?.type === "choice") vals.challenger = byKey.challenger.options[byKey.challenger.index];
  else if (byKey.challenger?.type === "readonly") vals.challenger = byKey.challenger.display;
  if (byKey.out) vals.out = byKey.out.text;
  if (byKey.incumbentModel?.type === "choice") vals.incumbentModel = byKey.incumbentModel.options[byKey.incumbentModel.index];
  else if (byKey.incumbentModel?.type === "readonly") vals.incumbentModel = byKey.incumbentModel.display;
  return vals;
}

/**
 * Pure reducer. `key` is a normalized token from the stdin shell:
 * "up" | "down" | "left" | "right" | "enter" | "backspace" | "escape" | "ctrlc"
 * or a single printable character string.
 *
 * @param {FormState} state
 * @param {string} key
 * @returns {FormState}
 */
export function applyKey(state, key) {
  if (key === "ctrlc" || key === "escape") {
    return { ...state, quit: true };
  }
  if (key === "enter") {
    const customPrompt = customPromptRequiredButEmpty(state);
    if (customPrompt) {
      return { ...state, focus: customPrompt.index };
    }
    return { ...state, done: true };
  }

  if (key === "up") {
    return { ...state, focus: Math.max(0, state.focus - 1) };
  }
  if (key === "down") {
    return { ...state, focus: Math.min(state.fields.length - 1, state.focus + 1) };
  }

  const field = state.fields[state.focus];
  if (!field) {
    return state;
  }

  if (field.type === "choice") {
    const len = field.options.length;
    let newIndex = field.index;
    if (key === "left") {
      newIndex = (field.index - 1 + len) % len;
    } else if (key === "right") {
      newIndex = (field.index + 1) % len;
    } else if (/^[1-9]$/.test(key)) {
      const n = Number(key);
      if (n > len) return state;
      newIndex = n - 1;
    } else if (key === "q") {
      // 'q' quits only when not typing into a text/number field.
      return { ...state, quit: true };
    } else {
      return state;
    }
    if (newIndex === field.index) {
      return state;
    }
    return patchField(state, { index: newIndex });
  }

  if (field.type === "number") {
    if (key === "backspace") {
      return patchField(state, { text: field.text.slice(0, -1) });
    }
    if (/^[0-9]$/.test(key) && field.text.length < 10) {
      return patchField(state, { text: field.text + key });
    }
    return state;
  }

  if (field.type === "text") {
    if (key === "backspace") {
      return patchField(state, { text: field.text.slice(0, -1) });
    }
    const allowed = field.key === "customPrompt" ? CUSTOM_PROMPT_ALLOWED : OUT_ALLOWED;
    const maxLen = field.key === "customPrompt" ? 1000 : 200;
    if (key.length === 1 && allowed.test(key) && field.text.length < maxLen) {
      return patchField(state, { text: field.text + key });
    }
    return state;
  }

  // readonly: 'q' quits; everything else is a no-op.
  if (field.type === "readonly") {
    if (key === "q") {
      return { ...state, quit: true };
    }
    return state;
  }

  return state;
}

/** @param {FormState} state @param {Partial<FormField>} changes @returns {FormState} */
function patchField(state, changes) {
  const fields = state.fields.slice();
  fields[state.focus] = { ...fields[state.focus], ...changes };
  return { ...state, fields };
}

function customPromptRequiredButEmpty(state) {
  const promptIndex = state.fields.findIndex((f) => f.key === "prompt");
  const customIndex = state.fields.findIndex((f) => f.key === "customPrompt");
  const prompt = state.fields[promptIndex];
  const custom = state.fields[customIndex];
  if (prompt?.type !== "choice" || custom?.type !== "text") {
    return null;
  }
  const selected = prompt.options[prompt.index];
  if (selected !== CUSTOM_DEMO_PROMPT_ID) {
    return null;
  }
  return custom.text.trim() ? null : { index: customIndex };
}

/**
 * Extract the form's finalized values for the orchestrator.
 * @param {FormState} state
 * @param {{ defaults: { promptSource: string, promptText?: string } }} ref
 * @returns {{ prompt: string, promptSource: "preset" | "literal" | "custom-empty", challenger: string, out: string, incumbentModel?: string }}
 */
export function formResult(state, ref) {
  const byKey = Object.fromEntries(state.fields.map((f) => [f.key, f]));
  const promptField = byKey.prompt;
  let prompt;
  // Track how the prompt was chosen so the caller can route user-typed custom
  // tasks as literals (a task whose text is exactly "custom" must not be
  // mistaken for the empty-custom sentinel).
  let promptSource;
  if (promptField.type === "choice") {
    const selected = promptField.options[promptField.index];
    if (selected === CUSTOM_DEMO_PROMPT_ID) {
      const text = byKey.customPrompt?.text?.trim() || "";
      if (text) {
        prompt = text;
        promptSource = "literal";
      } else {
        prompt = CUSTOM_DEMO_PROMPT_ID;
        promptSource = "custom-empty";
      }
    } else {
      prompt = selected; // a preset id
      promptSource = "preset";
    }
  } else {
    prompt = ref.defaults.promptText ?? "";
    promptSource = "literal";
  }
  const challengerField = byKey.challenger;
  const challenger = challengerField.type === "choice"
    ? challengerField.options[challengerField.index]
    : challengerField.display;
  const out = byKey.out.text.trim() ? byKey.out.text.trim() : "./fireconnect-demo";
  const im = byKey.incumbentModel;
  const incumbentModel = im?.type === "choice" ? im.options[im.index] : (im?.display ?? "opus");
  return { prompt, promptSource, challenger, out, incumbentModel };
}

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * @param {FormState} state
 * @param {{ incumbent: { providerLabel: string, modelLabel: string, callMode: "live" }, cols?: number }} meta
 * @returns {string[]}
 */
export function renderFormLines(state, meta) {
  const cols = meta.cols ?? 80;
  const labelWidth = 18;
  const lines = [];
  lines.push("");
  lines.push(`  ${BOLD}${CYAN}FireConnect Demo — setup${RESET}`);
  lines.push(`  ${DIM}Race Claude (your tool, on Anthropic) vs Fireworks on the same prompt.${RESET}`);
  lines.push("");

  for (let i = 0; i < state.fields.length; i += 1) {
    const field = state.fields[i];
    const focused = i === state.focus;
    const marker = focused ? `${CYAN}❯${RESET} ` : "  ";
    const label = padRight(`${field.label}:`, labelWidth);
    // A focused choice field shows just the current selection on its header line;
    // the full option list is rendered on the indented lines directly below, so
    // every choice is visible at once instead of hidden behind ←/→ cycling.
    const valuePart = (focused && field.type === "choice")
      ? renderChoiceHeader(field)
      : renderFieldValue(field, Math.max(20, cols - labelWidth - 6), focused);
    lines.push(`  ${marker}${DIM}${label}${RESET}${valuePart}`);

    if (focused && field.type === "choice") {
      for (const optLine of renderChoiceOptions(field)) {
        lines.push(`      ${optLine}`);
      }
    }

    // A one-line explanation for the focused field, so each field is
    // self-explanatory instead of a bare label.
    if (focused) {
      const help = fieldHelp(field);
      if (help) {
        lines.push(`      ${DIM}${help}${RESET}`);
      }
    }
  }

  // Comparison model — read-only row showing what the left side actually runs
  // (Claude Code on Anthropic direct). Derived from the form's CURRENT "Your
  // model" selection so it stays in sync as the user cycles the Anthropic alias,
  // not a static snapshot passed at open time.
  const incModelField = state.fields.find((f) => f.key === "incumbentModel");
  const incAlias = incModelField?.type === "choice"
    ? incModelField.options[incModelField.index]
    : (incModelField?.display ?? "opus");
  const incLabel = CURATED_ANTHROPIC_MODELS.find((m) => m.id === incAlias)?.label ?? incAlias;
  lines.push(`    ${DIM}${padRight("Comparison model:", labelWidth)}Anthropic · ${incLabel} (live call)${RESET}`);
  lines.push("");
  lines.push(
    `  ${DIM}↑/↓ move   ←/→ cycle   1-9 jump / type to edit   ⏎ race   q quit${RESET}`,
  );
  return lines;
}

/**
 * @param {FormField} field
 * @param {number} width
 * @param {boolean} [focused] — whether this field is the focused one (adds a
 *   block cursor for text/number fields so the user sees where typing lands).
 */
function renderFieldValue(field, width, focused) {
  if (field.type === "choice") {
    return renderChoice(field, width);
  }
  if (field.type === "number" || field.type === "text") {
    const shown = field.text || "";
    if (shown.length === 0) {
      // No typed text: surface the fallback as the effective value in
      // reverse-video (guaranteed contrast on any background) with a hint, so
      // the default is visible at a glance instead of a dim "(empty → …)".
      if (field.fallback) {
        return `${REVERSE}${BOLD}${field.fallback}${RESET} ${DIM}(default — type to replace)${RESET}`;
      }
      return `${DIM}(empty)${RESET}`;
    }
    // Reverse-video for the value: guaranteed contrast on light and dark
    // backgrounds (bare BOLD/BOLD-CYAN washes out on light themes — the same
    // white-on-white bug fixed for choice chips). A focused field gets a
    // trailing block cursor so it reads as the active edit target.
    const cursor = focused ? `${REVERSE} ${RESET}` : "";
    return `${REVERSE}${BOLD}${shown}${RESET}${cursor}`;
  }
  // readonly
  return `${DIM}${field.display}${RESET}`;
}

/**
 * Compact one-line summary of a choice field's current selection, used on the
 * field's header line. The full option list lives on the lines below it.
 * @param {FormField} field
 */
function renderChoiceHeader(field) {
  const cur = optionLabel(field.key, field.options[field.index]);
  const head = `◂ ${REVERSE}${BOLD}${cur}${RESET} ▸ ${DIM}[${field.index + 1}/${field.options.length}]${RESET}`;
  if (field.key === "challenger") {
    const p = lookupFireworksPricing(field.options[field.index]);
    const price = p ? `  ${DIM}$${p.input} / $${p.output} per Mtok${RESET}` : "";
    return `${head}${price}`;
  }
  return head;
}

/**
 * Inline numbered chips for an unfocused choice field. Falls back to the
 * compact header if the chips don't fit the available width.
 * @param {FormField} field @param {number} width
 */
function renderChoice(field, width) {
  const chips = field.options.map((opt, idx) => {
    const selected = idx === field.index;
    const num = `${idx + 1}`;
    const name = optionLabel(field.key, opt);
    const body = `${num} ${name}`;
    // Reverse-video for the selected chip: guaranteed contrast on any terminal
    // background (fixes white-on-white on light themes where bare BOLD → bright
    // white). Unselected chips stay dim.
    return selected ? `${REVERSE}${BOLD}${body}${RESET}` : `${DIM}${body}${RESET}`;
  });
  const chipsLine = chips.join("  ");
  if (visibleWidth(chipsLine) <= width) {
    return chipsLine;
  }
  return renderChoiceHeader(field);
}

/**
 * Full vertical option list for a focused choice field — one line per option,
 * so every selection is visible at once. The selected option is highlighted;
 * others are dim. Challenger rows also show per-Mtok pricing.
 * @param {FormField} field
 * @returns {string[]}
 */
function renderChoiceOptions(field) {
  return field.options.map((opt, idx) => {
    const selected = idx === field.index;
    const bullet = selected ? `${CYAN}●${RESET}` : `${DIM}○${RESET}`;
    const num = `${idx + 1}`;
    const name = optionLabel(field.key, opt);
    const nameStr = selected ? `${BOLD}${CYAN}${name}${RESET}` : `${DIM}${name}${RESET}`;
    let line = `${bullet} ${DIM}${num}${RESET}  ${nameStr}`;
    if (field.key === "challenger") {
      const p = lookupFireworksPricing(opt);
      if (p) {
        const price = selected ? `${CYAN}$${p.input} / $${p.output} per Mtok${RESET}` : `${DIM}$${p.input} / $${p.output} per Mtok${RESET}`;
        line += `  ${price}`;
      }
    }
    return line;
  });
}

/** @param {string} key @param {string} id */
function optionLabel(key, id) {
  if (key === "prompt") {
    if (id === CUSTOM_DEMO_PROMPT_ID) return "Custom task";
    return DEMO_PRESETS[id]?.title ?? id;
  }
  if (key === "challenger") {
    return FIREWORKS_MODEL_SPECS[id]?.label ?? id;
  }
  return id;
}

/**
 * One-line explanation for a focused field, so the form is self-documenting.
 * Returns null for fields with nothing useful to add.
 * @param {FormField} field
 * @returns {string | null}
 */
function fieldHelp(field) {
  if (field.type === "readonly") {
    return "Set via CLI flag (read-only).";
  }
  if (field.key === "prompt") {
    return "Pick a curated prompt, or choose Custom task and type your own standalone app request.";
  }
  if (field.key === "customPrompt") {
    return "Used only when Prompt is Custom task; output is forced to one complete HTML file.";
  }
  if (field.key === "incumbentModel") {
    return "Anthropic model for your tool (Claude Code on Anthropic direct).";
  }
  if (field.key === "challenger") {
    return "Fireworks model to race against your comparison model.";
  }
  if (field.key === "out") {
    return "Directory the demo writes the HTML apps + logs into.";
  }
  return null;
}

// ── stdin shell ──────────────────────────────────────────────────────────────

/**
 * Run the form against a real TTY. Resolves to the finalized values, or throws
 * on quit / Ctrl-C (no calls have been made).
 *
 * @param {{
 *   defaults: Parameters<typeof createFormState>[0]["defaults"],
 *   incumbent: { providerLabel: string, modelLabel: string, callMode: "live" },
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WriteStream,
 * }} args
 * @returns {Promise<{ prompt: string, challenger: string, out: string, incumbentModel: string }>}
 */
export async function runSetupForm({ defaults, incumbent, stdin = process.stdin, stdout = process.stdout }) {
  let state = createFormState({ defaults });
  const cols = () => stdout.columns || 80;
  // The form's height changes as the focused choice field expands/collapses its
  // option list, so we must clear at least as many lines as we last drew,
  // otherwise stale option lines linger at the bottom when focus moves.
  let prevLineCount = 0;

  let firstDraw = true;
  const redraw = () => {
    const lines = renderFormLines(state, { incumbent, cols: cols() });
    const n = Math.max(prevLineCount, lines.length);
    // On the first draw, clear the whole screen and home the cursor so the form
    // starts on a clean canvas at the top of the viewport. Without this, drawing
    // from HOME overwrites the previously-printed framing in place — leaving
    // half-overwritten lines that read as "the form didn't finish rendering" —
    // and on short terminals the form's bottom rows (seed/output) can land past
    // the visible edge. A full clear guarantees every field is visible.
    let out = firstDraw ? `${CLEAR_SCREEN}${HOME_CURSOR}` : HOME_CURSOR;
    firstDraw = false;
    for (let i = 0; i < n; i += 1) {
      out += `${moveTo(i + 1, 1)}${lines[i] ?? ""}${CLEAR_LINE}`;
    }
    stdout.write(out);
    prevLineCount = lines.length;
  };

  stdout.write(HIDE_CURSOR);
  redraw();

  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    const cleanup = () => {
      clearTimeout(escTimer);
      stdin.removeListener("data", onData);
      stdin.pause();
      if (stdin.isTTY) {
        stdin.setRawMode(wasRaw);
      }
      stdout.write(SHOW_CURSOR);
      // Clear every line we ever drew so subsequent output starts clean — the
      // expanded option list can push the form well past the old fixed height.
      stdout.write(`${HOME_CURSOR}${CLEAR_LINE}`);
      for (let i = 1; i < prevLineCount; i += 1) {
        stdout.write(`${moveTo(i + 1, 1)}${CLEAR_LINE}`);
      }
      stdout.write(HOME_CURSOR);
    };

    let escTimer = null;
    let buf = "";

    const emitKey = (key) => {
      state = applyKey(state, key);
      if (state.quit) {
        cleanup();
        reject(new Error("Demo cancelled."));
        return;
      }
      if (state.done) {
        cleanup();
        resolve(formResult(state, { defaults }));
        return;
      }
      redraw();
    };

    const flushBuffer = () => {
      while (buf.length > 0) {
        const ch = buf[0];
        if (ch === "\x1b") {
          if (buf.length >= 3 && buf[1] === "[") {
            const arrow = { A: "up", B: "down", C: "right", D: "left" }[buf[2]];
            if (arrow) {
              buf = buf.slice(3);
              emitKey(arrow);
              if (state.done || state.quit) return;
              continue;
            }
          }
          if (buf.length >= 2 && buf[1] !== "[") {
            // Esc + something else: treat as Escape.
            buf = buf.slice(1);
            emitKey("escape");
            if (state.done || state.quit) return;
            continue;
          }
          if (buf.length === 1) {
            // Lone Esc; wait briefly in case an arrow sequence is still arriving.
            clearTimeout(escTimer);
            escTimer = setTimeout(() => {
              if (buf === "\x1b") {
                buf = "";
                emitKey("escape");
              }
            }, 40);
            return;
          }
          // `\x1b[` partial — wait for more bytes.
          return;
        }
        if (ch === "\x7f" || ch === "\x08") {
          buf = buf.slice(1);
          emitKey("backspace");
          if (state.done || state.quit) return;
          continue;
        }
        if (ch === "\x03") {
          buf = buf.slice(1);
          emitKey("ctrlc");
          if (state.done || state.quit) return;
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          buf = buf.slice(1);
          emitKey("enter");
          if (state.done || state.quit) return;
          continue;
        }
        // Printable (ASCII). Non-ASCII bytes are ignored by the reducer's
        // allowed-char checks; consume one byte at a time.
        buf = buf.slice(1);
        emitKey(ch);
        if (state.done || state.quit) return;
      }
    };

    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      flushBuffer();
    };

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("latin1");
    stdin.on("data", onData);
  });
}
