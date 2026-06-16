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
  enableOpencodeFireworks,
  opencodeProviderStatus,
} from "./opencode-core.mjs";
import {
  effectiveOpencodeApiKey,
  filterCatalogBySearch,
  loadServerlessCatalog,
} from "./fireworks-models.mjs";
import { DEFAULT_HARNESS, HARNESS } from "./harness.mjs";

export const CLAUDE_CODE_SLOTS = [
  { key: "main", label: "main (primary conversation model)" },
  { key: "opus", label: "opus" },
  { key: "sonnet", label: "sonnet" },
  { key: "haiku", label: "haiku" },
  { key: "subagent", label: "subagent" },
];

function ensureInteractiveTerminal(harness) {
  if (!input.isTTY || !output.isTTY) {
    if (harness === HARNESS.OPENCODE) {
      throw new Error("model select requires an interactive terminal. Use: fireconnect set --harness opencode --main <id>");
    }
    throw new Error("model select requires an interactive terminal. Use: fireconnect set --<slot> <id>");
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
    const searchQuery = (await rl.question("Filter models (optional, Enter for all): ")).trim();
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

async function runClaudeModelSelect({ options, settingsPath, dataDir, configPath }) {
  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  if (providerStatusFromEnv(env) !== "fireworks") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect on");
  }

  const { catalog, keyType } = await loadServerlessCatalog({
    apiKey: options.apiKey,
    harness: HARNESS.CLAUDE,
    settingsPath,
    dataDir,
    configPath,
  });

  const rl = readline.createInterface({ input, output });

  try {
    let slot = options.slot ? parseSlotChoice(options.slot) : null;
    if (!slot) {
      const slotChoices = CLAUDE_CODE_SLOTS.map((entry) => {
        const current = mappingFromEnv(env)[entry.key];
        const currentShort = current ? current.split("/").at(-1) : "(unset)";
        return {
          key: entry.key,
          label: `${entry.label} — current: ${currentShort}`,
        };
      });
      const slotChoice = await promptChoice(rl, "Which Claude Code alias do you want to update?", slotChoices);
      if (!slotChoice) {
        console.log("Cancelled.");
        return;
      }
      slot = slotChoice.key;
    }

    const picked = await pickFromCatalog({
      rl,
      catalog,
      options,
      promptLabel: `Pick a serverless model for ${slot}:`,
    });
    if (!picked) {
      return;
    }

    const resolvedKeyType = keyType || detectApiKeyType(
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
    console.log("Restart Claude Code for full effect.");
  } finally {
    rl.close();
  }
}

async function runOpencodeModelSelect({ options, configPath, dataDir, settingsPath }) {
  if (options.slot) {
    throw new Error("--slot is Claude Code only; OpenCode uses a single model (omit --slot)");
  }

  const config = await readJsonIfExists(configPath);
  if (opencodeProviderStatus(config) !== "fireworks") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect on --harness opencode");
  }

  const existingKey = config.provider?.fireworks?.options?.apiKey ?? "";
  const effectiveKey = effectiveOpencodeApiKey(existingKey) || options.apiKey;
  const keyType = detectApiKeyType(effectiveKey);

  const { catalog } = await loadServerlessCatalog({
    apiKey: options.apiKey || effectiveKey,
    harness: HARNESS.OPENCODE,
    settingsPath,
    dataDir: "",
    configPath,
    keyType,
  });

  const currentModel = typeof config.model === "string" && config.model.startsWith("fireworks/")
    ? config.model.slice("fireworks/".length).split("/").at(-1)
    : "(unset)";

  const rl = readline.createInterface({ input, output });

  try {
    console.log(`Current OpenCode model: ${currentModel}`);

    const picked = await pickFromCatalog({
      rl,
      catalog,
      options,
      promptLabel: "Pick a serverless model for OpenCode:",
    });
    if (!picked) {
      return;
    }

    // Preserve the existing key mode: explicit --api-key or a literal key stored in
    // config should be written back literally; an env reference (or no existing key)
    // should keep using the env reference so the secret stays out of the file.
    const apiKey = options.apiKeyFromFlag ? options.apiKey : (existingKey || options.apiKey);
    const existingKeyIsLiteral = Boolean(existingKey) && existingKey !== OPENCODE_API_KEY_ENV_REF;

    const result = await enableOpencodeFireworks({
      configPath,
      dataDir,
      apiKey,
      apiKeyFromFlag: options.apiKeyFromFlag || existingKeyIsLiteral,
      modelId: picked.shortId,
      keyType,
    });

    console.log(`Updated OpenCode model: ${result.model}`);
    console.log("Restart OpenCode for full effect.");
  } finally {
    rl.close();
  }
}

export async function runModelSelectCommand({
  options,
  harness = DEFAULT_HARNESS,
  settingsPath = "",
  dataDir = "",
  configPath = "",
  opencodeDataDir = "",
}) {
  ensureInteractiveTerminal(harness);

  if (harness === HARNESS.OPENCODE) {
    await runOpencodeModelSelect({
      options,
      configPath,
      dataDir: opencodeDataDir,
      settingsPath,
    });
    return;
  }

  await runClaudeModelSelect({
    options,
    settingsPath,
    dataDir,
    configPath,
  });
}
