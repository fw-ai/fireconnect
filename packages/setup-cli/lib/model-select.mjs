import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  applyModelMapping,
  detectApiKeyType,
  mappingFromEnv,
  normalizeModelId,
  providerStatusFromEnv,
  readJsonIfExists,
  resolveModelMapping,
} from "./fireconnect-core.mjs";
import {
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_FIREWORKS_PROVIDER_ID,
  enableOpencodeFireworks,
  opencodeCurrentModelId,
  opencodeProviderStatus,
} from "./opencode-core.mjs";
import {
  PI_API_KEY_ENV_REF,
  enablePiFireworks,
  piProviderStatus,
} from "./pi-core.mjs";
import { filterCatalogBySearch,
  loadServerlessCatalog,
} from "./fireworks-models.mjs";
import { filterPickerCatalogForCodex } from "./codex-catalog.mjs";
import { HARNESS } from "./harness.mjs";
import { printClaudeModelActivationHint } from "./claude-hints.mjs";
import {
  codexCurrentModelId,
  codexProviderStatus,
  codexStoredAuthRef,
  loadCodexCatalogBundle,
  printCodexRestartHint,
  readCodexTomlIfExists,
  updateCodexModel,
} from "./codex-core.mjs";
import {
  CURSOR_MODES,
  CURSOR_DEFAULT_MODE,
  addUserModel,
  ensureCursorStopped,
  cursorCurrentModelId,
  cursorProviderStatus,
  prettyModelName,
  readCursorState,
  setModeModel,
  writeApplicationUserBlob,
} from "./cursor-core.mjs";
import {
  addVscodeModel,
  fireworksProviderStatus,
  prettyModelName as vscodePrettyModelName,
  readChatLanguageModels,
  readVscodeStoredKey,
  warnIfVscodeRunning,
} from "./vscode-core.mjs";
import { printPiRestartHint } from "./pi-hints.mjs";

export const CLAUDE_CODE_SLOTS = [
  { key: "main", label: "main (primary conversation model)" },
  { key: "opus", label: "opus" },
  { key: "sonnet", label: "sonnet" },
  { key: "haiku", label: "haiku" },
  { key: "subagent", label: "subagent" },
];

const NON_INTERACTIVE_HINT = {
  claude: "fireconnect claude on --<slot> <id>",
  opencode: "fireconnect opencode on --main <id>",
  codex: "fireconnect codex on --main <id>",
  pi: "fireconnect pi on --main <id>",
  cursor: "fireconnect cursor on --main <id>",
  vscode: "fireconnect vscode on --main <id>  (or fireconnect vscode model add <id>)",
};

function ensureInteractiveTerminal(harness) {
  if (input.isTTY && output.isTTY) {
    return;
  }
  const hint = NON_INTERACTIVE_HINT[harness] ?? "fireconnect <harness> on --main <id>";
  throw new Error(`model select requires an interactive terminal. Use: ${hint}`);
}

/**
 * Shared interactive model picker. Handles the common readline lifecycle
 * (interactive-terminal guard → optional pre-pick step → search/pick → confirm)
 * shared by every harness's `model select`. Callers own the pre-check (Fireworks
 * enabled?) and the post-pick write step.
 *
 * @param {{
 *   harness: string,
 *   catalog: object[],
 *   options: { search?: string },
 *   promptLabel: string,
 *   beforePick?: (rl: readline.Interface) => Promise<string | null | void>,
 * }} args
 *   `beforePick` may return a string to override `promptLabel` (e.g. after
 *   interactively choosing a slot/mode), or `null` to signal cancellation.
 * @returns {Promise<{ id: string, shortId: string, displayName: string } | null>}
 *   the picked catalog entry, or null if the user cancelled.
 */
export async function pickModelInteractive({ harness, catalog, options, promptLabel, beforePick }) {
  ensureInteractiveTerminal(harness);
  const rl = readline.createInterface({ input, output });
  try {
    let label = promptLabel;
    if (beforePick) {
      const result = await beforePick(rl);
      if (result === null) {
        console.log("Cancelled.");
        return null;
      }
      if (typeof result === "string") {
        label = result;
      }
    }
    const picked = await pickFromCatalog({ rl, catalog, options, promptLabel: label });
    if (!picked) {
      console.log("Cancelled.");
    }
    return picked;
  } finally {
    rl.close();
  }
}

function parseSlotChoice(value) {
  const slot = value.trim().toLowerCase();
  const match = CLAUDE_CODE_SLOTS.find((entry) => entry.key === slot);
  if (!match) {
    throw new Error(`Unknown slot: ${value}. Choose one of: ${CLAUDE_CODE_SLOTS.map((entry) => entry.key).join(", ")}`);
  }
  return match.key;
}

async function promptChoice(rl, question, choices) {
  console.log(question);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}) ${choice.label}`);
  });
  console.log("  q) Cancel");

  while (true) {
    const answer = (await rl.question("\nEnter choice: ")).trim().toLowerCase();
    if (answer === "q" || answer === "quit") {
      return null;
    }

    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1];
    }

    console.log("Invalid choice. Enter a number from the list, or q to cancel.");
  }
}

function buildMappingForSlot({ env, slot, pickedId, keyType }) {
  const defaults = resolveModelMapping({}, keyType);
  const current = mappingFromEnv(env);

  const mapping = {
    main: current.main ?? defaults.main,
    opus: current.opus ?? defaults.opus,
    sonnet: current.sonnet ?? defaults.sonnet,
    haiku: current.haiku ?? defaults.haiku,
    subagent: current.subagent ?? defaults.subagent,
  };

  mapping[slot] = normalizeModelId(pickedId);
  return mapping;
}

async function pickFromCatalog({ rl, catalog, options, promptLabel }) {
  let workingCatalog = catalog;
  if (options.search) {
    workingCatalog = filterCatalogBySearch(catalog, options.search);
  } else {
    const searchQuery = (await rl.question("Search models (or press Enter to list all): ")).trim();
    workingCatalog = filterCatalogBySearch(catalog, searchQuery);
  }

  if (workingCatalog.length === 0) {
    throw new Error("No serverless models matched your filter.");
  }

  const modelChoices = workingCatalog.map((entry) => ({
    id: entry.id,
    shortId: entry.shortId,
    label: `${entry.shortId} — ${entry.displayName} (${entry.kind})`,
  }));

  const picked = await promptChoice(rl, promptLabel, modelChoices);
  if (!picked) {
    console.log("Cancelled.");
    return null;
  }

  const confirm = (await rl.question(`Set model to ${picked.id}? [Y/n] `)).trim().toLowerCase();
  if (confirm === "n" || confirm === "no") {
    console.log("Cancelled.");
    return null;
  }

  return picked;
}

export async function runClaudeModelSelect({ options, settingsPath, apiKey }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  if (providerStatusFromEnv(env) !== "fireworks") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect claude on");
  }

  const dbKeyType = detectApiKeyType(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "");
  const { catalog } = await loadServerlessCatalog({ apiKey, keyType: dbKeyType });
  let slot = options.slot ? parseSlotChoice(options.slot) : null;

  const picked = await pickModelInteractive({
    harness: HARNESS.CLAUDE,
    catalog,
    options,
    promptLabel: "",
    beforePick: async (rl) => {
      if (!slot) {
        const slotChoices = CLAUDE_CODE_SLOTS.map((entry) => {
          const current = mappingFromEnv(env)[entry.key];
          const currentShort = current ? current.split("/").at(-1) : "(unset)";
          return { key: entry.key, label: `${entry.label} — current: ${currentShort}` };
        });
        const slotChoice = await promptChoice(rl, "Which Claude Code alias do you want to update?", slotChoices);
        if (!slotChoice) {
          return null;
        }
        slot = slotChoice.key;
      }
      return `Pick a serverless model for ${slot}:`;
    },
  });
  if (!picked) {
    return;
  }

  const resolvedKeyType = detectApiKeyType(
    env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "",
  );
  const mapping = buildMappingForSlot({
    env,
    slot,
    pickedId: picked.id,
    keyType: resolvedKeyType,
  });

  await applyModelMapping({ settingsPath, mapping });
  console.log(`Updated ${slot} -> ${mapping[slot]}`);
  printClaudeModelActivationHint();
}

export async function runOpencodeModelSelect({ options, configPath, dataDir, apiKey }) {
  if (options.slot) {
    throw new Error("--slot is Claude Code only; OpenCode uses a single model (omit --slot)");
  }

  const config = await readJsonIfExists(configPath);
  if (opencodeProviderStatus(config) !== "fireworks") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect opencode on");
  }

  const existingKey = config.provider?.[OPENCODE_FIREWORKS_PROVIDER_ID]?.options?.apiKey
    ?? config.provider?.fireworks?.options?.apiKey
    ?? "";
  const keyType = detectApiKeyType(apiKey);
  const { catalog } = await loadServerlessCatalog({ apiKey, keyType });
  const currentModel = opencodeCurrentModelId(config)?.split("/").at(-1) ?? "(unset)";

  const picked = await pickModelInteractive({
    harness: HARNESS.OPENCODE,
    catalog,
    options,
    promptLabel: "Pick a serverless model for OpenCode:",
    beforePick: async () => {
      console.log(`Current OpenCode model: ${currentModel}`);
    },
  });
  if (!picked) {
    return;
  }

  // Preserve the on-disk write mode: keep the stored value (literal or
  // {env:...} ref) unless the user passed an explicit --api-key.
  const writeKey = options.apiKeyFromFlag ? options.apiKey : (existingKey || options.apiKey);
  const existingKeyIsLiteral = Boolean(existingKey) && existingKey !== OPENCODE_API_KEY_ENV_REF;

  const result = await enableOpencodeFireworks({
    configPath,
    dataDir,
    apiKey: writeKey,
    apiKeyFromFlag: options.apiKeyFromFlag || existingKeyIsLiteral,
    modelId: picked.shortId,
    keyType,
  });

  console.log(`Updated OpenCode model: ${result.model}`);
  console.log("Restart OpenCode for full effect.");
}

export async function runCodexModelSelect({ options, configPath, apiKey, literalAuth = false }) {
  if (options.slot) {
    throw new Error("--slot is Claude Code only; Codex uses a single model (omit --slot)");
  }

  const { doc } = await readCodexTomlIfExists(configPath);
  if (codexProviderStatus(doc) !== "fireworks") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect codex on");
  }

  const storedAuth = codexStoredAuthRef(doc);
  const keyType = detectApiKeyType(apiKey);
  let pickerCatalog = options.pickerCatalog;
  let codexCatalog = options.catalog ?? null;
  if (!pickerCatalog || !codexCatalog) {
    const bundle = await loadCodexCatalogBundle(apiKey);
    pickerCatalog = pickerCatalog ?? bundle.pickerCatalog;
    codexCatalog = codexCatalog ?? bundle.codexCatalog;
  }
  if (!pickerCatalog) {
    pickerCatalog = (await loadServerlessCatalog({ apiKey, keyType })).catalog;
  }
  if (codexCatalog) {
    pickerCatalog = filterPickerCatalogForCodex(pickerCatalog, codexCatalog);
    if (pickerCatalog.length === 0) {
      throw new Error(
        "No Codex-compatible models found. Verify FIREWORKS_API_KEY and retry.",
      );
    }
  } else if (doc.root.model_catalog_json) {
    throw new Error(
      "Could not refresh the Codex model catalog. Verify FIREWORKS_API_KEY and retry, "
      + "or run: fireconnect codex on",
    );
  }
  const currentModel = codexCurrentModelId(doc)?.split("/").at(-1) ?? "(unset)";

  const picked = await pickModelInteractive({
    harness: HARNESS.CODEX,
    catalog: pickerCatalog,
    options,
    promptLabel: "Pick a serverless model for Codex:",
    beforePick: async () => {
      console.log(`Current Codex model: ${currentModel}`);
    },
  });
  if (!picked) {
    return;
  }

  const writeAuth = options.apiKeyFromFlag ? options.apiKey : (storedAuth || apiKey);
  const result = await updateCodexModel({
    configPath,
    modelId: picked.shortId,
    apiKey: writeAuth,
    literalAuth: options.apiKeyFromFlag || literalAuth,
    catalogPath: options.catalogPath ?? "",
    catalog: codexCatalog,
  });

  console.log(`Updated Codex model: ${result.model}`);
  printCodexRestartHint();
}

export async function runPiModelSelect({ options, settingsPath, authPath, modelsPath, dataDir, apiKey }) {
  if (options.slot) {
    throw new Error("--slot is Claude Code only; Pi uses a single model (omit --slot)");
  }

  const settings = await readJsonIfExists(settingsPath);
  if (piProviderStatus(settings) !== "fireworks") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect pi on");
  }

  const auth = await readJsonIfExists(authPath);
  const existingKey = auth.fireworks?.key ?? "";
  const keyType = detectApiKeyType(apiKey);
  const { catalog } = await loadServerlessCatalog({ apiKey, keyType });
  const currentModel = typeof settings.defaultModel === "string"
    ? settings.defaultModel.split("/").at(-1)
    : "(unset)";

  const picked = await pickModelInteractive({
    harness: HARNESS.PI,
    catalog,
    options,
    promptLabel: "Pick a serverless model for Pi:",
    beforePick: async () => {
      console.log(`Current Pi model: ${currentModel}`);
    },
  });
  if (!picked) {
    return;
  }

  const writeKey = options.apiKeyFromFlag ? options.apiKey : (existingKey || options.apiKey);
  const existingKeyIsLiteral = Boolean(existingKey)
    && existingKey !== PI_API_KEY_ENV_REF
    && existingKey !== "${FIREWORKS_API_KEY}";

  const result = await enablePiFireworks({
    settingsPath,
    authPath,
    modelsPath,
    dataDir,
    apiKey: writeKey,
    apiKeyFromFlag: options.apiKeyFromFlag || existingKeyIsLiteral,
    modelId: picked.shortId,
    keyType,
  });

  console.log(`Updated Pi model: ${result.model}`);
  printPiRestartHint();
}

/**
 * Interactive model picker for the Cursor harness. Picks a Cursor mode (default
 * `composer`) and a serverless model, then writes aiSettings.modelConfig[mode]
 * and registers the model in the picker list.
 *
 * @param {{ options: import("./harness-types.mjs").HarnessContext, dbPath: string, apiKey: string }} args
 */
export async function runCursorModelSelect({ options, dbPath, apiKey }) {
  if (options.slot) {
    throw new Error("--slot is Claude Code only; Cursor uses --mode (omit --slot)");
  }

  const { blob, openAIKey } = await readCursorState(dbPath);
  if (cursorProviderStatus(blob, openAIKey) === "none") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect cursor on");
  }

  // Fail fast: if Cursor is running, ask the user to quit before the interactive
  // picker + catalog fetch — don't make them pick a model only to be blocked.
  await ensureCursorStopped({ force: options.force });

  // Re-read after Cursor is quit so the picker + write see the final on-disk
  // state (Cursor's last flush may have changed modelConfig since the first read).
  const { blob: freshBlob, openAIKey: freshKey } = await readCursorState(dbPath);

  // Filter the catalog by the key type actually stored in the DB, not the
  // resolved API key (which may prefer FIREWORKS_API_KEY env over the DB key).
  // This prevents a Fire Pass DB key from showing the full serverless catalog.
  const dbKeyType = detectApiKeyType(freshKey);
  const { catalog } = await loadServerlessCatalog({ apiKey, keyType: dbKeyType });

  let mode = options.mode ? options.mode.trim().toLowerCase() : "";
  if (mode && !CURSOR_MODES.includes(mode)) {
    throw new Error(`Unknown mode: ${options.mode}. Choose one of: ${CURSOR_MODES.join(", ")}`);
  }

  const picked = await pickModelInteractive({
    harness: HARNESS.CURSOR,
    catalog,
    options,
    promptLabel: "",
    beforePick: async (rl) => {
      if (!mode) {
        const modeChoices = CURSOR_MODES.map((m) => {
          const id = cursorCurrentModelId(freshBlob, m);
          const current = id ? prettyModelName(id) : "(unset)";
          return { key: m, label: `${m} — current: ${current}` };
        });
        const modeChoice = await promptChoice(rl, "Which Cursor mode do you want to update?", modeChoices);
        if (!modeChoice) {
          return null;
        }
        mode = modeChoice.key;
      }
      return `Pick a serverless model for Cursor (${mode}):`;
    },
  });
  if (!picked) {
    return;
  }

  // Write — Cursor is already quit (guard ran above), so the freshBlob baseline
  // matches the final on-disk state.
  let next = setModeModel(freshBlob, mode, picked.id);
  next = addUserModel(next, picked.id); // ensure it's selectable in the picker
  await writeApplicationUserBlob(dbPath, next);

  console.log(`Updated Cursor ${mode} -> ${picked.id} (${prettyModelName(picked.id)})`);
  console.log("Restart Cursor for the change to take effect.");
}

export async function runVscodeModelSelect({ options, vscodePath, stateDbPath, apiKey }) {
  if (options.slot) {
    throw new Error("--slot is Claude Code only; VS Code has no slot/mode (omit --slot)");
  }

  const arr = await readChatLanguageModels(vscodePath);
  if (fireworksProviderStatus(arr) === "none") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect vscode on");
  }

  // Filter the catalog by the key type actually stored in VS Code's secret
  // storage, not the resolved API key (which may prefer FIREWORKS_API_KEY env).
  // Same rationale as the cursor picker: a Fire Pass key shouldn't show the full
  // serverless catalog.
  const storedKey = await readVscodeStoredKey(vscodePath, stateDbPath, arr);
  const storedKeyType = detectApiKeyType(storedKey);
  const { catalog } = await loadServerlessCatalog({ apiKey, keyType: storedKeyType });

  const picked = await pickModelInteractive({
    harness: HARNESS.VSCODE,
    catalog,
    options,
    promptLabel: "Pick a serverless model to add to VS Code's Fireworks provider:",
  });
  if (!picked) {
    return;
  }

  warnIfVscodeRunning();
  await addVscodeModel({ vscodePath, modelId: picked.id });

  console.log(`Added ${picked.id} (${vscodePrettyModelName(picked.id)}) to VS Code's Fireworks provider.`);
  console.log("VS Code hot-reloads the file — the change applies immediately (no restart needed).");
}
