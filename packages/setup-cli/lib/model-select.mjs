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
  filterCatalogBySearch,
  loadServerlessCatalog,
} from "./fireworks-models.mjs";
import { HARNESS } from "./harness.mjs";
import { printClaudeModelRoutingHint } from "./claude-hints.mjs";

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
      throw new Error("model select requires an interactive terminal. Use: fireconnect opencode on --main <id>");
    }
    throw new Error("model select requires an interactive terminal. Use: fireconnect claude on --<slot> <id>");
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
  ensureInteractiveTerminal(HARNESS.CLAUDE);

  const settings = await readJsonIfExists(settingsPath);
  const env = settings.env ?? {};
  if (providerStatusFromEnv(env) !== "fireworks") {
    throw new Error("model select requires Fireworks to be enabled; run: fireconnect claude on");
  }

  const { catalog, keyType } = await loadServerlessCatalog({ apiKey });

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
    printClaudeModelRoutingHint();
  } finally {
    rl.close();
  }
}

export async function runOpencodeModelSelect({ options, configPath, dataDir, apiKey }) {
  ensureInteractiveTerminal(HARNESS.OPENCODE);

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
  } finally {
    rl.close();
  }
}
