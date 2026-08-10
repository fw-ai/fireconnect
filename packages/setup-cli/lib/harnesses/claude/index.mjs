import process from "node:process";

import {
  printClaudeRestartHint,
  printClaudeModelActivationHint,
  printClaudeModelManagementHints,
  printHarnessOnSuccess,
  printHarnessRestored,
  printNote,
  buildFirerouterOnFootnotes,
} from "../../cli/messages.mjs";
import {
  printStructuredHarnessStatus,
  shortModelId,
} from "../../harness/status-display.mjs";
import {
  claudeFireconnectIntent,
  disableFireworksProvider,
  enableFireworksProvider,
  mappingFromSettings,
  hasLegacyAnthropicMainEnv,
  providerBackupPath,
  providerStatePath,
  providerStatusFromEnv,
  stripFireconnectManagedClaudeSettings,
  stripManagedApiKeyHelper,
} from "./core.mjs";
import {
  FIREWORKS_BASE_URL,
} from "../../fireworks/model-id.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import {
  detectApiKeyType,
  isFireworksKey,
  MISSING_FIREWORKS_API_KEY_MESSAGE,
} from "../../keys/key-type.mjs";
import { withoutDesktopGuardHook } from "./desktop-guard.mjs";
import {
  withGatewayServerToolsDenied,
  withoutGatewayServerToolsDenied,
} from "./server-tools-deny.mjs";
import {
  formatClaudeUsageReport,
  formatClaudeUsageReports,
  readClaudeUsage,
  readClaudeUsages,
} from "./usage/report.mjs";
import {
  canRunClaudeUsageInteractiveDisplay,
  hasClaudeUsageRows,
  playUsageIntroAnimation,
  runClaudeUsageInteractiveDisplay,
} from "./usage/display.mjs";
import { runClaudeUsageLive, shouldRunClaudeUsageLive } from "./usage/live.mjs";
import { promptClaudeUsageSession } from "./usage/session-picker.mjs";
import { runClaudeLiveTmux } from "./live-tmux.mjs";
import {
  attachPricing,
  CLAUDE_CODE_PRICING_DISCLAIMER,
} from "../../fireworks/pricing.mjs";
import { warmServerlessPricingCache } from "../../fireworks/models.mjs";
import {
  formatNonVisionModelsWarning,
  uniqueNonVisionModelShortIds,
  visionCapabilityLabel,
} from "../../fireworks/vision.mjs";
import { defineHarnessProfile } from "../../harness/engine.mjs";
import {
  claudePathsFor,
  ensureHomeForHarness,
} from "../../harness/context.mjs";
import {
  isHarnessEnabled,
  setHarnessEnabled,
  setHarnessState,
} from "../../config/global-config.mjs";
import { HARNESS } from "../../harness/id.mjs";
import {
  fireworksKeyFromCustomHeaders,
  isAnthropicShapedKey,
  resolveAnthropicKey,
} from "../../firerouter/core.mjs";
import {
  FIREROUTER_FIREPASS_UNSUPPORTED_MESSAGE,
  resolveExplicitFirerouterCredential,
  resolveWorkspaceByokStatus,
} from "../../firerouter/flag.mjs";
import {
  harnessStatusKeySource,
  persistApiKeyFromFlag,
  resolveFireworksApiKeyValue,
} from "../../keys/api-key.mjs";
import { harnessFullKey } from "../../keys/harness-api-key.mjs";
import { detectSecretBackend } from "../../keys/secret-store.mjs";
import { assertBackendCanStore } from "../../keys/storage-report.mjs";
import { claudeJsonPath, disableWebsearchMcp, syncWebsearchMcp } from "../../system/websearch-mcp.mjs";
import { printWebsearchOnStep } from "../../system/websearch-install-guide.mjs";
import {
  printClaudeModelMapping,
  runClaudeModelOnboarding,
  standardClaudeModelMapping,
} from "./onboarding.mjs";
import {
  canOnboardingSelectFirerouter,
  readClaudeActivationSnapshot,
  resolveClaudeActivationPlan,
} from "./activation.mjs";
import {
  defaultClaudeModelMapping,
  hasClaudeModelOverrides,
  inferClaudeActiveKeyType,
  mappingUsesFirerouter,
  withSavedClaudeModelMapping,
} from "./model-profile.mjs";
import { loadClaudeModelPickerCatalog } from "./model-picker.mjs";

const CLAUDE_FIREROUTER = Object.freeze({
  byok: "value",
  autoCatalog: true,
});

export const CLAUDE_FIREROUTER_FALLBACK_WARNING =
  "FireRouter off · Sign in to Claude or pass --anthropic-api-key to enable automatic routing.";

export const CLAUDE_FIREROUTER_AUTH_REQUIRED =
  "FireRouter requires Claude sign-in, workspace BYOK, or an Anthropic API key. "
  + "Sign in with `/login` in Claude Code or rerun with "
  + "`fireconnect claude on --anthropic-api-key <sk-ant-...>`.";

export const CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING =
  "Legacy env.ANTHROPIC_MODEL is still set and overrides Claude Code's /model picker. "
  + "Run `fireconnect claude on` to migrate.";

export function resolveClaudeAuthState(settings, state = {}) {
  const env = settings.env ?? {};
  const customHeaderToken = fireworksKeyFromCustomHeaders(
    env.ANTHROPIC_CUSTOM_HEADERS,
  );
  if (isFireworksKey(customHeaderToken)) {
    return {
      authMode: "customHeader",
      keyConfigured: true,
      token: customHeaderToken.trim(),
    };
  }

  const usesHelper = Boolean(settings.apiKeyHelper)
    || state.authMode === "apiKeyHelper";
  if (usesHelper) {
    return { authMode: "apiKeyHelper", keyConfigured: true, token: "" };
  }

  const token = [
    env.ANTHROPIC_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
    state.fireworksApiKey,
  ].find(isFireworksKey)?.trim() ?? "";
  return {
    authMode: token ? "env" : "missing",
    keyConfigured: Boolean(token),
    token,
  };
}

/**
 * Fireworks key from active Claude Code settings when Fireconnect is on.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeResolveKey(ctx) {
  const { settingsPath, dataDir } = claudePathsFor(ctx);
  const settings = await readJsonIfExists(settingsPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  return resolveClaudeAuthState(settings, state).token;
}

/**
 * Resolve before any Claude settings mutation. Claude `on` intentionally stops
 * with explicit login/custom-SSO guidance instead of starting sign-in itself.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeApiKeyForOn(ctx, snapshot) {
  const token = await harnessFullKey(
    ctx,
    async () => resolveClaudeAuthState(snapshot.settings, snapshot.state).token,
  );
  if (token) {
    return token;
  }
  throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
}

function isNativeClaudeCredential(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return Boolean(key) && key !== "fireconnect" && !isFireworksKey(key);
}

function settingsFromSnapshot(backup) {
  if (backup.snapshot === undefined) {
    return null;
  }
  if (!backup.snapshot?.existed) {
    return {};
  }
  return JSON.parse(backup.snapshot.raw);
}

/**
 * Return the auth-bearing settings Claude had before FireConnect. A current
 * v0.9 mapping uses its raw snapshot; a v0.8 values backup exposes the restored
 * auth fields directly. Backup-less v0.8 installs retain only credentials that
 * cannot be FireConnect's own key/sentinel.
 */
export function claudeNativeAuthBaseline(settings, backup = {}, state = {}, intent = null) {
  const snapshot = settingsFromSnapshot(backup);
  if (snapshot !== null) {
    return snapshot;
  }
  if (backup.values !== undefined) {
    const baseline = { env: { ...(backup.values ?? {}) } };
    if (Object.hasOwn(backup.topLevel?.values ?? {}, "apiKeyHelper")) {
      baseline.apiKeyHelper = backup.topLevel.values.apiKeyHelper;
    }
    return baseline;
  }
  if (!intent) {
    return settings;
  }

  const baseline = stripFireconnectManagedClaudeSettings(settings, state);
  const currentEnv = settings.env ?? {};
  const env = { ...(baseline.env ?? {}) };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if (isNativeClaudeCredential(currentEnv[key])) {
      env[key] = currentEnv[key];
    }
  }
  return { ...baseline, env };
}

async function resolveClaudeNativeAuth({
  ctx,
  baseline,
  state,
  hasClaudeOAuth,
}) {
  const baselineEnv = baseline.env ?? {};
  const anthropicApiKey = isNativeClaudeCredential(baselineEnv.ANTHROPIC_API_KEY)
    ? baselineEnv.ANTHROPIC_API_KEY.trim()
    : "";
  const anthropicAuthToken = isNativeClaudeCredential(baselineEnv.ANTHROPIC_AUTH_TOKEN)
    ? baselineEnv.ANTHROPIC_AUTH_TOKEN.trim()
    : "";
  const helperResult = stripManagedApiKeyHelper(baseline, state).settings;
  const nativeApiKeyHelper = Object.hasOwn(helperResult, "apiKeyHelper")
    ? helperResult.apiKeyHelper
    : null;
  const resolvedAnthropicKey = await resolveAnthropicKey({
    apiKey: ctx.anthropicKeyFromFlag ? ctx.anthropicKey : "",
    settingsEnv: {
      ...(anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
      ...(anthropicAuthToken ? { ANTHROPIC_AUTH_TOKEN: anthropicAuthToken } : {}),
    },
    home: ctx.home,
  });
  const resolvedOnlyFromAuthToken = !ctx.anthropicKeyFromFlag
    && !anthropicApiKey
    && Boolean(anthropicAuthToken)
    && resolvedAnthropicKey === anthropicAuthToken;

  return {
    anthropicApiKey: resolvedOnlyFromAuthToken
      ? ""
      : (resolvedAnthropicKey || anthropicApiKey),
    anthropicAuthToken,
    nativeApiKeyHelper,
    hasNativeAuth: hasClaudeOAuth
      || Boolean(resolvedAnthropicKey)
      || Boolean(nativeApiKeyHelper),
  };
}

/**
 * Pre-approve a stray ANTHROPIC_API_KEY in ~/.claude.json so Claude Code doesn't
 * show its one-time "Detected a custom API key in your environment" prompt.
 * FireConnect authenticates via the X-Fireworks-Api-Key header (that key still
 * wins), but a user who exports ANTHROPIC_API_KEY would otherwise get prompted on
 * first launch. Claude Code identifies an approved key by `key.trim().slice(-20)`
 * stored in customApiKeyResponses.approved. No-op when no key is in the env.
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function approveStrayAnthropicApiKey(home) {
  const key = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!home || !key) {
    return false;
  }
  const identifier = key.slice(-20);
  const filePath = claudeJsonPath(home);
  const current = await readJsonIfExists(filePath);
  const responses = (current.customApiKeyResponses && typeof current.customApiKeyResponses === "object")
    ? current.customApiKeyResponses
    : {};
  const approved = Array.isArray(responses.approved) ? responses.approved : [];
  if (approved.includes(identifier)) {
    return false;
  }
  await writeJson(filePath, {
    ...current,
    customApiKeyResponses: {
      ...responses,
      approved: [...approved, identifier],
      rejected: Array.isArray(responses.rejected) ? responses.rejected : [],
    },
  });
  return true;
}

/** Strip a legacy SessionStart desktop-guard hook left by older FireConnect installs. */
async function removeDesktopGuardHook(settingsPath) {
  const settings = await readJsonIfExists(settingsPath);
  const next = withoutDesktopGuardHook(settings);
  if (next !== settings) {
    await writeJson(settingsPath, next);
  }
}

// Disable Claude's server-side WebSearch/WebFetch while routed through the
// gateway (they'd break). Added after the enable step — the enable already
// snapshotted the user's original settings — so `off`'s byte-for-byte snapshot
// restore removes this without touching the user's own permissions.
async function applyGatewayServerToolsDenied(settingsPath) {
  const settings = await readJsonIfExists(settingsPath);
  const next = withGatewayServerToolsDenied(settings);
  if (next !== settings) {
    await writeJson(settingsPath, next);
  }
}

function legacyBackupIncludesPermissions(backup) {
  return Object.hasOwn(backup.topLevel?.values ?? {}, "permissions")
    || (backup.topLevel?.missing ?? []).includes("permissions");
}

async function prepareClaudeV09Baseline({ settingsPath, dataDir, intent }) {
  if (!intent?.needsUpgrade) {
    return;
  }

  const backupPath = providerBackupPath(dataDir);
  const backup = await readJsonIfExists(backupPath);
  const state = await readJsonIfExists(providerStatePath(dataDir));
  const hasLegacyBackup = backup.values !== undefined;
  if (hasLegacyBackup) {
    await disableFireworksProvider({ settingsPath, dataDir, wasEnabled: true });
  } else {
    const settings = await readJsonIfExists(settingsPath);
    await writeJson(
      settingsPath,
      stripFireconnectManagedClaudeSettings(settings, state),
      { mode: 0o600 },
    );
  }

  let baseline = await readJsonIfExists(settingsPath);
  baseline = withoutDesktopGuardHook(baseline);
  if (!hasLegacyBackup || !legacyBackupIncludesPermissions(backup)) {
    baseline = withoutGatewayServerToolsDenied(baseline);
  }
  await writeJson(settingsPath, baseline, { mode: 0o600 });
}

export default defineHarnessProfile({
  id: HARNESS.CLAUDE,
  label: "Claude Code",
  resolveKey: claudeResolveKey,
  firerouter: CLAUDE_FIREROUTER,
  // Claude's `on` is bespoke (slot mapping, raw-snapshot backup, and websearch MCP).
  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const onboardingMode = ctx.onboardingMode ?? "auto";
    if (onboardingMode === "prompt" && hasClaudeModelOverrides(ctx)) {
      throw new Error(
        "--interactive cannot be combined with model flags; choose the wizard or "
          + "use --model/--opus/--sonnet/--haiku/--fable/--subagent directly.",
      );
    }
    if (onboardingMode === "prompt" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error(
        "--interactive requires a terminal. Use --non-interactive for saved defaults "
          + "or pass --opus/--sonnet/--haiku/--fable/--subagent directly.",
      );
    }
    const snapshot = await readClaudeActivationSnapshot(ctx);
    const { settingsPath, dataDir } = snapshot;
    const fireworksKey = await claudeApiKeyForOn(ctx, snapshot);
    if (ctx.anthropicKeyFromFlag && !isAnthropicShapedKey(ctx.anthropicKey)) {
      throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
    }
    const keyType = detectApiKeyType(fireworksKey);
    const nativeBaseline = claudeNativeAuthBaseline(
      snapshot.settings,
      snapshot.backup,
      snapshot.state,
      snapshot.intent,
    );
    const nativeAuth = await resolveClaudeNativeAuth({
      ctx,
      baseline: nativeBaseline,
      state: snapshot.state,
      hasClaudeOAuth: snapshot.hasClaudeOAuth,
    });
    const workspaceByokLookup = keyType === "firepass"
      ? null
      : await resolveWorkspaceByokStatus(fireworksKey);
    const hasWorkspaceByok = workspaceByokLookup?.enabled === true;
    const hasConfirmedFirerouterAuth = nativeAuth.hasNativeAuth || hasWorkspaceByok;
    const canUseFirerouter = hasConfirmedFirerouterAuth
      || workspaceByokLookup?.unavailable === true;
    const activeToken = resolveClaudeAuthState(snapshot.settings, snapshot.state).token;
    const recordedKeyType = ["fireworks", "firepass"].includes(snapshot.state.keyType)
      ? snapshot.state.keyType
      : "";
    const activeKeyType = snapshot.intent
      ? inferClaudeActiveKeyType({
        tokenKeyType: activeToken ? detectApiKeyType(activeToken) : "",
        recordedKeyType,
        profiles: snapshot.profiles,
        activeMapping: snapshot.intent.mapping,
        currentKeyType: keyType,
      })
      : "";
    const plan = resolveClaudeActivationPlan({
      ctx,
      keyType,
      snapshot,
      activeKeyType,
      automaticFirerouter: keyType !== "firepass" && hasConfirmedFirerouterAuth,
    });
    const shouldRunOnboarding = (plan.firstSetup || onboardingMode === "prompt")
      && !plan.explicitOverrides
      && onboardingMode !== "skip"
      && process.stdin.isTTY
      && process.stdout.isTTY;
    let mapping = plan.mapping;
    const wizardCanAddFirerouter = canOnboardingSelectFirerouter({
      shouldRunOnboarding,
      keyType,
      hasFirerouterAuth: canUseFirerouter,
    });
    if (
      ctx.routingPreference !== null
      && !mappingUsesFirerouter(mapping)
      && !wizardCanAddFirerouter
    ) {
      throw new Error("--routing-preference requires a Claude slot set to firerouter.");
    }
    const fastDefaults = defaultClaudeModelMapping(keyType);
    const nonFastDefaults = standardClaudeModelMapping(keyType);
    let pickerCatalogPromise;
    const loadPickerCatalog = () => {
      pickerCatalogPromise ??= loadClaudeModelPickerCatalog({
        apiKey: fireworksKey,
        keyType,
        includeFirerouter: canUseFirerouter,
        extraModelIds: [
          ...Object.values(plan.mapping),
          ...Object.values(fastDefaults),
          ...Object.values(nonFastDefaults),
        ],
      });
      return pickerCatalogPromise;
    };
    if (keyType === "fireworks") {
      await loadPickerCatalog();
    }
    if (shouldRunOnboarding) {
      const selected = await runClaudeModelOnboarding({
        recommended: mapping,
        fastDefaults,
        mappingLabel: plan.firstSetup ? "Recommended" : "Current",
        keyType,
        loadCatalog: loadPickerCatalog,
      });
      if (selected === null) {
        printNote("Setup cancelled.");
        return { cancelled: true };
      }
      mapping = selected;
    }
    const usesFirerouter = mappingUsesFirerouter(mapping);
    if (ctx.routingPreference !== null && !usesFirerouter) {
      throw new Error("--routing-preference requires a Claude slot set to firerouter.");
    }
    if (usesFirerouter && keyType === "firepass") {
      throw new Error(FIREROUTER_FIREPASS_UNSUPPORTED_MESSAGE);
    }
    let anthropicKeyForFirerouter = nativeAuth.anthropicApiKey;
    if (usesFirerouter && !canUseFirerouter) {
      if (onboardingMode !== "skip") {
        const prompted = await resolveExplicitFirerouterCredential({
          firerouter: CLAUDE_FIREROUTER,
          availability: {
            include: false,
            workspaceByokLookup: workspaceByokLookup ?? undefined,
          },
          ctx,
          allowPromptSkip: false,
        });
        if (prompted.anthropicKey) {
          anthropicKeyForFirerouter = prompted.anthropicKey;
        }
      }
      if (!anthropicKeyForFirerouter) {
        throw new Error(CLAUDE_FIREROUTER_AUTH_REQUIRED);
      }
    }

    // Migrate a harness-local key (baked into settings by an older `on`) into the
    // shared store so `key export` and other harnesses can reuse it — but only
    // when flag/env/stored are all empty, so a newer key from `login`/env is
    // never clobbered (matches resolveHarnessOnApiKey's precedence). `--api-key`
    // is already persisted by runHarnessCommand; a prompted key persists itself.
    const flagKey = ctx.apiKey?.trim() ?? "";
    const migrated = !flagKey
      && isFireworksKey(fireworksKey)
      && !(await resolveFireworksApiKeyValue({ home: ctx.home }));
    if (migrated) {
      const backend = await detectSecretBackend(ctx.home);
      await assertBackendCanStore(backend, ctx.home);
      await persistApiKeyFromFlag(ctx.home, fireworksKey, { backend });
    }
    await prepareClaudeV09Baseline({
      settingsPath,
      dataDir,
      intent: snapshot.intent,
    });
    await enableFireworksProvider({
      settingsPath,
      dataDir,
      effectiveApiKey: fireworksKey,
      baseUrl: ctx.baseUrl || FIREWORKS_BASE_URL,
      mapping,
      keyType,
      anthropicKey: anthropicKeyForFirerouter,
      anthropicAuthToken: nativeAuth.anthropicAuthToken,
      nativeApiKeyHelper: nativeAuth.nativeApiKeyHelper,
      routingPreference: usesFirerouter ? ctx.routingPreference : null,
      useApiKeySentinel: false,
      // Workspace BYOK makes FireRouter eligible, but a logged-out Claude
      // profile still needs native auth material to pass its client login gate.
      useFireworksAuthTokenFallback: !nativeAuth.hasNativeAuth
        && !anthropicKeyForFirerouter?.trim(),
    });
    await setHarnessState(ctx.home, HARNESS.CLAUDE, {
      enabled: true,
      provider: "fireworks",
      profiles: withSavedClaudeModelMapping(snapshot.profiles, keyType, mapping),
    });
    // Drop a legacy SessionStart desktop-guard hook if present (retired; CLI-only).
    await removeDesktopGuardHook(settingsPath);
    const hasAnthropicForFirerouter = Boolean(anthropicKeyForFirerouter?.trim());
    const firerouterEligible = hasConfirmedFirerouterAuth || hasAnthropicForFirerouter;
    /** @type {Array<() => void>} */
    const footnotes = [];
    if (keyType !== "firepass" && !firerouterEligible && !usesFirerouter) {
      if (workspaceByokLookup?.unavailable) {
        footnotes.push(() => printNote(
          `Workspace BYOK could not be verified (${workspaceByokLookup.reason}); continuing without it.`,
        ));
      }
      footnotes.push(() => printNote(CLAUDE_FIREROUTER_FALLBACK_WARNING));
    } else {
      footnotes.push(...buildFirerouterOnFootnotes({
        harnessId: HARNESS.CLAUDE,
        firerouter: CLAUDE_FIREROUTER,
        firerouterIncluded: usesFirerouter,
        eligible: firerouterEligible,
        routingPreference: ctx.routingPreference,
        firepass: keyType === "firepass",
        workspaceByokLookup,
      }));
    }
    const visionWarning = formatNonVisionModelsWarning(
      uniqueNonVisionModelShortIds(Object.values(mapping)),
    );
    if (visionWarning) {
      footnotes.push(() => printNote(visionWarning));
    }
    await applyGatewayServerToolsDenied(settingsPath);
    await approveStrayAnthropicApiKey(ctx.home);

    let websearchSync = { installed: false, reason: "not-attempted" };
    try {
      websearchSync = await syncWebsearchMcp(ctx.home, { apiKey: fireworksKey, quiet: true });
    } catch {
      websearchSync = { installed: false, reason: "sync-failed" };
    }
    await printHarnessOnSuccess({
      label: "Claude Code",
      footnotes,
      restartHint: printClaudeModelActivationHint,
      afterConnected: async () => {
        printClaudeModelMapping(mapping);
        await printWebsearchOnStep(websearchSync, ctx.home);
      },
    });
    printClaudeModelManagementHints();
  },

  async off(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const [wasEnabled, settings, backup, state] = await Promise.all([
      isHarnessEnabled(ctx.home, HARNESS.CLAUDE),
      readJsonIfExists(settingsPath),
      readJsonIfExists(providerBackupPath(dataDir)),
      readJsonIfExists(providerStatePath(dataDir)),
    ]);
    const intent = claudeFireconnectIntent(settings, { backup, state });
    // A v0.8 install may have managed settings but no enabled flag or raw
    // snapshot. Reuse the on-migration fallback so upgrade-triggered off still
    // restores its values backup or strips only FireConnect-owned settings.
    await prepareClaudeV09Baseline({ settingsPath, dataDir, intent });
    await disableFireworksProvider({
      settingsPath,
      dataDir,
      wasEnabled: wasEnabled || Boolean(intent),
    });
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, false);
    await disableWebsearchMcp(ctx.home);
    await removeDesktopGuardHook(settingsPath);
    printHarnessRestored("Claude Code");
    printClaudeRestartHint();
  },

  async status(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);
    const settings = await readJsonIfExists(settingsPath);
    const state = await readJsonIfExists(providerStatePath(dataDir));
    const env = settings.env ?? {};
    const auth = resolveClaudeAuthState(settings, state);
    const token = auth.token;
    const keyType = token ? detectApiKeyType(token) : "fireworks";
    if (token && keyType === "fireworks") {
      await warmServerlessPricingCache(token, keyType);
    }
    const currentMapping = mappingFromSettings(settings);
    const payload = {
      harness: HARNESS.CLAUDE,
      provider: providerStatusFromEnv(env),
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      hasAuthToken: auth.keyConfigured,
      authMode: auth.authMode,
      defaults: defaultClaudeModelMapping(keyType),
      current: currentMapping,
      pricing: Object.fromEntries(
        Object.entries(currentMapping)
          .filter(([, modelId]) => modelId)
          .map(([slot, modelId]) => [slot, attachPricing(modelId)]),
      ),
      pricingNote: CLAUDE_CODE_PRICING_DISCLAIMER,
    };
    payload.keyType = keyType;

    if (ctx.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const routed = payload.provider === "fireworks";
    const mainModel = payload.current.main || payload.defaults.main || null;
    printStructuredHarnessStatus(HARNESS.CLAUDE, {
      provider: payload.provider,
      keyConfigured: payload.hasAuthToken,
      authMode: auth.authMode,
      endpoint: routed ? null : payload.baseUrl,
      model: routed ? undefined : mainModel,
      mappingRows: routed
        ? Object.entries(payload.current)
          .map(([slot, modelId]) => {
            const resolved = modelId || payload.defaults[slot] || "";
            const detailParts = [
              payload.pricing?.[slot]?.display ?? "",
              visionCapabilityLabel(resolved),
            ].filter(Boolean);
            return {
              slot,
              value: shortModelId(resolved),
              detail: detailParts.join(" · "),
            };
          })
          .filter((row) => row.value && row.value !== "(unset)")
        : [],
      keySource: harnessStatusKeySource(HARNESS.CLAUDE, payload.provider, {
        authMode: auth.authMode,
      }),
    });
    if (routed && hasLegacyAnthropicMainEnv(settings)) {
      printNote(CLAUDE_LEGACY_ANTHROPIC_MODEL_WARNING);
    }
  },

  async usage(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    // Meter with live Fireworks prices, not just the static spec table. The
    // serverless catalog is per-process (no disk cache) and only `status` warmed
    // it before — so every `claude usage` / live-meter process priced from the
    // static fallback. Warm it here (self-gates on a genuine fw_ key) before any
    // cost is computed. Fully best-effort: resolving the key can throw on a
    // malformed/unreadable settings file, and usage must still work off the
    // session logs, so the whole warm is wrapped, not just the fetch.
    try {
      await warmServerlessPricingCache(await claudeResolveKey(ctx));
    } catch {
      /* fall back to static spec pricing */
    }
    if (shouldRunClaudeUsageLive(ctx)) {
      const withinDays = ctx.days || undefined;
      let session = ctx.session ?? "";
      if (!session) {
        // Needs stdin TTY for the multi-session menu; otherwise picks newest.
        session = await promptClaudeUsageSession({ home: ctx.home, withinDays });
        if (!session) {
          return;
        }
      }
      await runClaudeUsageLive({
        home: ctx.home,
        session,
        verbose: ctx.verbose,
        plain: ctx.plain,
        ...(process.env.FC_LIVE_SPLIT === "1"
          ? {}
          : {
            // The session list is always reachable, including from an explicit
            // --session. It was withheld there on the theory that you can only go
            // "back" somewhere you have been, but the list is a destination in its
            // own right: --session names a starting point, not a cage, and the only
            // way out used to be quitting and rerunning.
            promptSession: (opts) => promptClaudeUsageSession({ ...opts, withinDays }),
          }),
      });
      return;
    }
    if (ctx.lastN) {
      const reportGroup = await readClaudeUsages({ home: ctx.home, session: ctx.session ?? "", lastN: ctx.lastN });
      if (ctx.json) {
        console.log(JSON.stringify(reportGroup, null, 2));
        return;
      }
      if (!ctx.verbose && !ctx.plain && hasClaudeUsageRows(reportGroup)) {
        await playUsageIntroAnimation();
        if (canRunClaudeUsageInteractiveDisplay() && await runClaudeUsageInteractiveDisplay(reportGroup)) {
          // q/Esc/Ctrl-C resolve the display and restore the cursor, but a
          // paused TTY stdin still holds a libuv ref, so returning up the stack
          // hangs the process. Exit explicitly now that the terminal is restored
          // (same fix as the live meter's quit path in usage/live.mjs).
          process.exit(0);
        }
      }
      console.log(formatClaudeUsageReports(reportGroup, { verbose: ctx.verbose, plain: ctx.plain }));
      return;
    }

    const report = await readClaudeUsage({ home: ctx.home, session: ctx.session ?? "" });
    if (ctx.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!ctx.verbose && !ctx.plain && hasClaudeUsageRows(report)) {
      await playUsageIntroAnimation();
      if (canRunClaudeUsageInteractiveDisplay() && await runClaudeUsageInteractiveDisplay(report)) {
        // q/Esc/Ctrl-C resolve the display and restore the cursor, but a paused
        // TTY stdin still holds a libuv ref, so returning up the stack hangs the
        // process. Exit explicitly now that the terminal is restored (same fix
        // as the live meter's quit path in usage/live.mjs).
        process.exit(0);
      }
    }
    console.log(formatClaudeUsageReport(report, { verbose: ctx.verbose, plain: ctx.plain }));
  },

  async live(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    await runClaudeLiveTmux({ home: ctx.home, session: ctx.session });
  },

});
