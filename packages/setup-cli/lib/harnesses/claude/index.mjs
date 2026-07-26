import process from "node:process";

import {
  printClaudeRestartHint,
  printClaudeModelActivationHint,
  printHarnessConnected,
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
  defaultModelIds,
  disableFireworksProvider,
  enableFireworksProvider,
  mappingUsesFirerouter,
  mappingFromEnv,
  providerBackupPath,
  providerStatePath,
  providerStatusFromEnv,
  resolveModelMapping,
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
import { fireconnectDesktopGuardCommand } from "../../cli/path.mjs";
import { withDesktopGuardHook, withoutDesktopGuardHook } from "./desktop-guard.mjs";
import {
  withGatewayServerToolsDenied,
  withoutGatewayServerToolsDenied,
} from "./server-tools-deny.mjs";
import {
  formatClaudeUsageReport,
  formatClaudeUsageReports,
  readClaudeUsage,
  readClaudeUsages,
} from "./usage.mjs";
import {
  canRunClaudeUsageInteractiveDisplay,
  hasClaudeUsageRows,
  playUsageIntroAnimation,
  runClaudeUsageInteractiveDisplay,
} from "./usage-display.mjs";
import { hasClaudeOAuthCredentials } from "./oauth.mjs";
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
  modelOverridesFrom,
} from "../../harness/context.mjs";
import { isHarnessEnabled, setHarnessEnabled } from "../../config/global-config.mjs";
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

const CLAUDE_FIREROUTER = Object.freeze({
  byok: "value",
  autoCatalog: true,
});

export const CLAUDE_FIREROUTER_FALLBACK_WARNING =
  "FireRouter wasn't enabled: Claude isn't signed in and no Anthropic key was found. "
  + "Using glm-fast-latest with your Fireworks key for now. "
  + "To enable FireRouter, sign in with `/login` in Claude Code or run "
  + "`fireconnect claude on --anthropic-api-key <sk-ant-...>`.";

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
 * Flag > env > settings (when on) > global config.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeApiKey(ctx) {
  return harnessFullKey(ctx, claudeResolveKey);
}

/**
 * Resolve before any Claude settings mutation. Claude `on` intentionally stops
 * with explicit login/custom-SSO guidance instead of starting sign-in itself.
 * @param {import("../../harness/types.mjs").HarnessContext} ctx
 */
async function claudeApiKeyForOn(ctx) {
  const token = await claudeApiKey(ctx);
  if (token) {
    return token;
  }
  throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
}

async function resolveClaudeOnContext(ctx) {
  if (!ctx.home && !ctx.settingsPath) {
    return ctx;
  }
  const { settingsPath, dataDir } = claudePathsFor(ctx);
  const [settings, backup, state] = await Promise.all([
    readJsonIfExists(settingsPath),
    readJsonIfExists(providerBackupPath(dataDir)),
    readJsonIfExists(providerStatePath(dataDir)),
  ]);
  const env = settings.env ?? {};
  const intent = claudeFireconnectIntent(settings, { backup, state });
  if (!intent) {
    return ctx;
  }
  const current = intent.mapping;
  return {
    ...ctx,
    main: ctx.main || current.main || "",
    opus: ctx.opus || current.opus || "",
    sonnet: ctx.sonnet || current.sonnet || "",
    haiku: ctx.haiku || current.haiku || "",
    fable: ctx.fable || current.fable || "",
    subagent: ctx.subagent || current.subagent || "",
  };
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

async function installDesktopGuardHook(settingsPath) {
  const settings = await readJsonIfExists(settingsPath);
  await writeJson(settingsPath, withDesktopGuardHook(settings, fireconnectDesktopGuardCommand()));
}

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
  resolveOnContext: resolveClaudeOnContext,
  firerouter: CLAUDE_FIREROUTER,
  // Claude's `on` is bespoke (slot mapping, raw-snapshot backup, desktop guard,
  // and websearch MCP).
  async on(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    const { settingsPath, dataDir } = claudePathsFor(ctx);

    // Resolve the Fireworks key before auth discovery, workspace lookup, or any
    // Claude settings mutation.
    const fireworksKey = await claudeApiKeyForOn(ctx);
    if (ctx.anthropicKeyFromFlag && !isAnthropicShapedKey(ctx.anthropicKey)) {
      throw new Error("--anthropic-api-key must be an Anthropic API key (sk-ant-...).");
    }
    const keyType = detectApiKeyType(fireworksKey);
    const [existingSettings, existingBackup, existingState, hasClaudeOAuth] = await Promise.all([
      readJsonIfExists(settingsPath),
      readJsonIfExists(providerBackupPath(dataDir)),
      readJsonIfExists(providerStatePath(dataDir)),
      hasClaudeOAuthCredentials({ home: ctx.home, settingsPath }),
    ]);
    const activeIntent = claudeFireconnectIntent(existingSettings, {
      backup: existingBackup,
      state: existingState,
    });
    const nativeBaseline = claudeNativeAuthBaseline(
      existingSettings,
      existingBackup,
      existingState,
      activeIntent,
    );
    const nativeAuth = await resolveClaudeNativeAuth({
      ctx,
      baseline: nativeBaseline,
      state: existingState,
      hasClaudeOAuth,
    });
    const workspaceByokLookup = keyType === "firepass"
      ? null
      : await resolveWorkspaceByokStatus(fireworksKey);
    const hasWorkspaceByok = workspaceByokLookup?.enabled === true;
    const hasFirerouterAuth = nativeAuth.hasNativeAuth || hasWorkspaceByok;
    const explicitModelOverrides = Object.values(modelOverridesFrom(ctx)).some(Boolean);

    const effectiveCtx = await resolveClaudeOnContext(ctx);
    const policyCtx = !activeIntent
      && !explicitModelOverrides
      && keyType !== "firepass"
      && hasFirerouterAuth
      ? { ...effectiveCtx, main: "firerouter", fable: "firerouter" }
      : effectiveCtx;
    if (keyType === "fireworks") {
      await warmServerlessPricingCache(fireworksKey, keyType);
    }
    const mapping = resolveModelMapping(modelOverridesFrom(policyCtx), keyType);
    const usesFirerouter = mappingUsesFirerouter(mapping);
    if (usesFirerouter && keyType === "firepass") {
      throw new Error(FIREROUTER_FIREPASS_UNSUPPORTED_MESSAGE);
    }
    let anthropicKeyForFirerouter = nativeAuth.anthropicApiKey;
    if (explicitModelOverrides && usesFirerouter && !hasFirerouterAuth) {
      const prompted = await resolveExplicitFirerouterCredential({
        firerouter: CLAUDE_FIREROUTER,
        availability: {
          include: false,
          workspaceByokLookup: workspaceByokLookup ?? undefined,
        },
        ctx,
      });
      if (prompted.anthropicKey) {
        anthropicKeyForFirerouter = prompted.anthropicKey;
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
      intent: activeIntent,
    });
    await enableFireworksProvider({
      settingsPath,
      dataDir,
      effectiveApiKey: fireworksKey,
      baseUrl: effectiveCtx.baseUrl || FIREWORKS_BASE_URL,
      mapping,
      keyType,
      anthropicKey: anthropicKeyForFirerouter,
      anthropicAuthToken: nativeAuth.anthropicAuthToken,
      nativeApiKeyHelper: nativeAuth.nativeApiKeyHelper,
      routingPreference: usesFirerouter ? effectiveCtx.routingPreference : null,
      useApiKeySentinel: false,
      // Workspace BYOK makes FireRouter eligible, but a logged-out Claude
      // profile still needs native auth material to pass its client login gate.
      useFireworksAuthTokenFallback: !nativeAuth.hasNativeAuth
        && !anthropicKeyForFirerouter?.trim(),
    });
    await setHarnessEnabled(ctx.home, HARNESS.CLAUDE, true, "fireworks");
    await installDesktopGuardHook(settingsPath);
    const modelsAdded = Object.values(mapping);
    const hasAnthropicForFirerouter = Boolean(anthropicKeyForFirerouter?.trim());
    const firerouterEligible = hasFirerouterAuth || hasAnthropicForFirerouter;
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
        routingPreference: effectiveCtx.routingPreference,
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
      model: mapping.main,
      modelsAdded,
      footnotes,
      restartHint: printClaudeModelActivationHint,
      afterConnected: () => printWebsearchOnStep(websearchSync, ctx.home),
    });
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
    const payload = {
      harness: HARNESS.CLAUDE,
      provider: providerStatusFromEnv(env),
      baseUrl: env.ANTHROPIC_BASE_URL ?? null,
      hasAuthToken: auth.keyConfigured,
      authMode: auth.authMode,
      defaults: defaultModelIds(keyType),
      current: mappingFromEnv(env),
      pricing: Object.fromEntries(
        Object.entries(mappingFromEnv(env))
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
  },

  async usage(ctx) {
    ensureHomeForHarness(ctx, HARNESS.CLAUDE);
    if (ctx.lastN) {
      const reportGroup = await readClaudeUsages({ home: ctx.home, session: ctx.session ?? "", lastN: ctx.lastN });
      if (ctx.json) {
        console.log(JSON.stringify(reportGroup, null, 2));
        return;
      }
      if (!ctx.verbose && !ctx.plain && hasClaudeUsageRows(reportGroup)) {
        await playUsageIntroAnimation();
        if (canRunClaudeUsageInteractiveDisplay() && await runClaudeUsageInteractiveDisplay(reportGroup)) {
          return;
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
        return;
      }
    }
    console.log(formatClaudeUsageReport(report, { verbose: ctx.verbose, plain: ctx.plain }));
  },

});
