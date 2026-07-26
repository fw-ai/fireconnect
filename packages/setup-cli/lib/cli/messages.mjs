import { accent, dim, muted, ok } from "../ui.mjs";
import { AZURE_PROVIDER_LABEL } from "../fireworks/azure-core.mjs";
import {
  FIREROUTER_TAGLINE,
  routingPreferenceLevelName,
  routingPreferenceOptionsList,
} from "../firerouter/core.mjs";
import { supportsRoutingPreference } from "../firerouter/flag.mjs";

export const FIREROUTER_DOCS_URL =
  "https://docs.fireworks.ai/ecosystem/firerouter/overview";

function displayModel(model) {
  return typeof model === "string"
    ? model.replace(/\[1m\]$/, "").split("/").at(-1)
    : "";
}

function firerouterOnCommand(harnessId) {
  return harnessId === "claude"
    ? "fireconnect claude on --opus firerouter"
    : `fireconnect ${harnessId} on --model firerouter`;
}

function printRoutingPreferenceHint(harnessId, routingPreference) {
  const levelName = routingPreferenceLevelName(routingPreference) ?? "balanced";
  const command = `${firerouterOnCommand(harnessId)} --routing-preference ${levelName}`;
  const otherOptions = routingPreferenceOptionsList({ excludeLevel: levelName });
  printCommandHint("Change routing", command);
  printNote(`Other levels: ${otherOptions}`);
}

/** `Label: fireconnect …` with cyan command highlight. */
export function printCommandHint(label, command) {
  const prefix = label.endsWith(":") ? label : `${label}:`;
  console.log(`${prefix} ${accent(command)}`);
}

/** Indented detail (secondary). */
export function printDetail(label, value) {
  console.log(`  ${muted(`${label}: ${value}`)}`);
}

/** Green ✓ headline. */
export function printSuccess(message) {
  console.log(ok(message));
}

/** Plain informational line. */
export function printInfo(message) {
  console.log(message);
}

/** Muted footnote. */
export function printNote(message) {
  console.log(muted(message));
}

/** Dim supporting copy. */
export function printBody(message) {
  console.log(dim(message));
}

/** Harness turned on (direct Fireworks). */
export function printHarnessConnected(name, { model } = {}) {
  const display = displayModel(model);
  printSuccess(display ? `${name} → Fireworks · ${display}` : `${name} → Fireworks`);
}

export function printModelsAdded(models = [], { primaryModel } = {}) {
  const display = [...new Set(models.map(displayModel).filter(Boolean))];
  if (display.length === 0) {
    return;
  }
  let shown = display;
  if (primaryModel !== undefined) {
    const primary = displayModel(primaryModel);
    shown = display.filter((model) => model !== primary);
    if (shown.length === 0) {
      return;
    }
  }
  printNote(`Also in your model list: ${shown.join(", ")}`);
}

function printSpacer() {
  console.log("");
}

/**
 * Footnotes and restart hint for `<harness> on`, with spacing between sections.
 * @param {string[]} modelsAdded
 * @param {Array<() => void>} footnotes
 * @param {() => void} restartHint
 */
export function printHarnessOnFootnotes(modelsAdded, footnotes, restartHint, { primaryModel } = {}) {
  printModelsAdded(modelsAdded, { primaryModel });
  if (footnotes.length > 0) {
    printSpacer();
    for (const footnote of footnotes) {
      footnote();
    }
  }
  printSpacer();
  restartHint();
}

/**
 * Standard success output for `<harness> on`.
 * @param {{
 *   label: string,
 *   model?: string,
 *   modelsAdded?: string[],
 *   footnotes?: Array<() => void>,
 *   restartHint: () => void,
 *   afterConnected?: () => void | Promise<void>,
 * }} args
 */
export async function printHarnessOnSuccess({
  label,
  model,
  modelsAdded = [],
  footnotes = [],
  restartHint,
  afterConnected,
}) {
  printHarnessConnected(label, { model });
  if (afterConnected) {
    await afterConnected();
  }
  printHarnessOnFootnotes(modelsAdded, footnotes, restartHint, { primaryModel: model });
}

/**
 * Standard FireRouter footnotes for harness `on` (note + optional routing preference).
 * @param {{
 *   harnessId: string,
 *   firerouter: { byok?: string }|null|undefined,
 *   firerouterIncluded: boolean,
 *   eligible: boolean,
 *   routingPreference?: number|string|null,
 *   firepass?: boolean,
 *   workspaceByokOnly?: boolean,
 *   workspaceByokLookup?: import("../config/feature-flags.mjs").FeatureFlagLookupResult|null,
 * }} args
 * @returns {Array<() => void>}
 */
export function buildFirerouterOnFootnotes({
  harnessId,
  firerouter,
  firerouterIncluded,
  eligible,
  routingPreference = null,
  firepass = false,
  workspaceByokOnly = false,
  workspaceByokLookup = null,
}) {
  if (!firerouter) {
    return [];
  }
  /** @type {Array<() => void>} */
  const footnotes = [() => printFirerouterNote({
    harnessId,
    included: firerouterIncluded,
    eligible,
    supportsEnvByok: firerouter.byok !== "none",
    workspaceByokOnly: firerouter.byok === "none",
    firepass,
    workspaceByokLookup,
  })];
  if (firerouterIncluded && supportsRoutingPreference(firerouter)) {
    footnotes.push(() => printRoutingPreferenceHint(harnessId, routingPreference));
  }
  return footnotes;
}

function printFirerouterEnabledNote() {
  printNote(
    `FireRouter is on. ${FIREROUTER_TAGLINE} `
      + `Learn more: ${FIREROUTER_DOCS_URL}`,
  );
}

function printFirerouterUnavailableNote(message) {
  printNote(`${message} Learn more: ${FIREROUTER_DOCS_URL}`);
}

export function printFirerouterNote({
  harnessId,
  included = false,
  eligible = false,
  supportsEnvByok = false,
  workspaceByokOnly = false,
  firepass = false,
  workspaceByokLookup = null,
}) {
  const command = firerouterOnCommand(harnessId);
  if (workspaceByokOnly) {
    if (included) {
      printFirerouterEnabledNote();
      if (workspaceByokLookup?.unavailable) {
        printNote(
          `Couldn't verify workspace BYOK (${workspaceByokLookup.reason}). Continuing anyway.`,
        );
      }
      return;
    }
    if (firepass) {
      printFirerouterUnavailableNote(
        "FireRouter needs a regular Fireworks API key (fw_...), not Fire Pass.",
      );
      return;
    }
    if (eligible) {
      printNote(`FireRouter is available. Run ${command} to turn it on.`);
      return;
    }
    if (workspaceByokLookup?.unavailable) {
      printNote(
        `FireRouter wasn't turned on: couldn't verify workspace BYOK (${workspaceByokLookup.reason}). `
          + `Ask the Fireworks team, or try: ${command}.`,
      );
      return;
    }
    printNote(
      "FireRouter wasn't turned on. Ask the Fireworks team to enable it for your account.",
    );
    return;
  }

  if (included) {
    printFirerouterEnabledNote();
    if (workspaceByokLookup?.unavailable) {
      printNote(
        `Couldn't verify workspace BYOK (${workspaceByokLookup.reason}). Continuing anyway.`,
      );
    }
    return;
  }
  if (firepass) {
    printFirerouterUnavailableNote(
      "FireRouter needs a regular Fireworks API key (fw_...), not Fire Pass.",
    );
    return;
  }
  if (workspaceByokLookup?.unavailable) {
    printNote(
      `FireRouter wasn't turned on: couldn't verify workspace BYOK (${workspaceByokLookup.reason}). `
        + `Set ANTHROPIC_API_KEY or try: ${command}.`,
    );
    return;
  }
  if (eligible) {
    printNote(`FireRouter is available. Run ${command} to turn it on.`);
    return;
  }
  if (supportsEnvByok) {
    printNote(
      `FireRouter wasn't turned on (no Anthropic API key). Run ${command} to enable it.`,
    );
    return;
  }
  printNote(`FireRouter wasn't turned on. Run ${command} to enable it.`);
}

/**
 * Harness turned on via the Azure/Foundry provider: success line, endpoint, and
 * the endpoint.
 * @param {{ id: string, result: { model: string, baseUrl: string, apiKeyMode?: string } }} args
 */
export function printAzureConnected({ id, result }) {
  printSuccess(`${id} → ${AZURE_PROVIDER_LABEL} · ${displayModel(result.model)}`);
  printDetail("Endpoint", result.baseUrl);
  printSpacer();
}

/** Harness turned off or unchanged. */
export function printHarnessRestored(name) {
  printInfo(`${name} restored to your previous setup.`);
}

export function printHarnessUnchanged(name) {
  printNote(`${name} was not connected; nothing changed.`);
}

export function printRestartHint(message) {
  console.log(muted(message));
}

function printSessionRestartHint(name) {
  printRestartHint(`Restart ${name} to use the new setup.`);
}

export function printClaudeRestartHint() {
  printSessionRestartHint("Claude Code");
}

export function printClaudeModelActivationHint() {
  printSessionRestartHint("Claude Code");
}

export function printCodexRestartHint() {
  printSessionRestartHint("Codex");
}

export function printPiRestartHint() {
  printSessionRestartHint("Pi");
}

export function printDeepagentsRestartHint() {
  printSessionRestartHint("Deep Agents");
}

export function printOpenCodeRestartHint() {
  printSessionRestartHint("OpenCode");
}

export function printModelUpdate(message, hints = []) {
  console.log(ok(message));
  for (const hint of hints) {
    if (typeof hint === "string") {
      console.log(hint);
    } else {
      printCommandHint(hint.label, hint.command);
    }
  }
}
