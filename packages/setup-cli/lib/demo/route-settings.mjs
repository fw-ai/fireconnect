/**
 * Isolated per-side config dirs for `fireconnect demo`'s real-tool race.
 *
 * The demo races two REAL `claude -p` processes side by side — one routed to
 * Anthropic direct (incumbent), one to Fireworks direct (challenger / GLM 5.2
 * Fast). Each side runs in its OWN throwaway config dir via `CLAUDE_CONFIG_DIR`,
 * containing only a clean `settings.json` with that side's routing + model + key.
 *
 * This is the key isolation: Claude Code loads `<dir>/settings.json` as the
 * user settings with NO merge against `~/.claude/settings.json`, so a leftover
 * `apiKeyHelper` or Fireworks model-mapping env from `fireconnect claude on`
 * can't leak into either side. Each side is fully self-contained.
 *
 * Auth is via an inline API key in the settings `env` block (Anthropic key for
 * the incumbent, Fireworks key for the challenger) — no keychain/OAuth, so the
 * isolated config dir doesn't need a credentials file. The user's
 * `~/.claude/settings.json` is never read or touched.
 */

import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildFireworksSettings,
  resolveModelMapping,
  writeJson,
} from "../fireconnect-core.mjs";

export const ANTHROPIC_DIRECT_BASE_URL = "https://api.anthropic.com";

/**
 * Build the incumbent's settings: a CLEAN Anthropic-direct config —
 * `ANTHROPIC_BASE_URL` pointed at api.anthropic.com and the Anthropic API key
 * inline. No `apiKeyHelper`, no Fireworks env, no inherited base settings.
 * Pure — does not touch disk.
 *
 * @param {{ anthropicKey: string }} opts
 * @returns {Record<string, unknown>}
 */
export function buildIncumbentSettings({ anthropicKey }) {
  const env = { ANTHROPIC_BASE_URL: ANTHROPIC_DIRECT_BASE_URL };
  if (anthropicKey) {
    env.ANTHROPIC_API_KEY = anthropicKey;
  }
  return { env };
}

/**
 * Build the challenger's settings: a CLEAN Fireworks-direct config for the
 * chosen challenger model (default GLM 5.2 Fast) with the Fireworks key inline.
 * Reuses `buildFireworksSettings` on an empty base so the routing is identical
 * to what `fireconnect claude on` (direct mode) would produce — just with no
 * user settings inherited. Pure — does not touch disk.
 *
 * @param {{ fireworksKey: string, challengerModel: string, keyType?: "fireworks" | "firepass", routerBaseUrl?: string }} opts
 * @returns {Promise<{ settings: Record<string, unknown>, token: string }>}
 */
export async function buildChallengerSettings({
  fireworksKey,
  challengerModel,
  keyType = "fireworks",
  routerBaseUrl = "",
}) {
  const mapping = resolveModelMapping({ main: challengerModel }, keyType);
  const { settings, token } = buildFireworksSettings({ env: {} }, {
    apiKey: fireworksKey,
    mapping,
    keyType,
    routerBaseUrl,
  });
  // Carry the resolved Fireworks key inline so the tmp settings file is
  // self-contained (no apiKeyHelper / keychain).
  const env = { ...settings.env, ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: token };
  return { settings: { ...settings, env }, token };
}

/**
 * Create two isolated `CLAUDE_CONFIG_DIR`s (incumbent + challenger), each with
 * its own clean `settings.json`, under the provided `tmpRoot`. Returns both
 * dirs plus a `cleanup()` that removes the root. Call `cleanup()` on exit
 * (normal, error, SIGINT).
 *
 * This is Claude's `buildRaceSettings` adapter (registered in
 * harness-runners.mjs). `incumbentModel` is unused for Claude — the incumbent
 * model is pinned via `--model` at run time — but is accepted so the adapter
 * interface stays uniform across harnesses.
 *
 * @param {{
 *   tmpRoot: string,
 *   incumbentKey: string,
 *   incumbentModel?: string,
 *   fireworksKey: string,
 *   challengerModel: string,
 *   keyType?: "fireworks" | "firepass",
 *   routerBaseUrl?: string,
 * }} args
 * @returns {Promise<{ incumbentDir: string, challengerDir: string, tmpDir: string, cleanup: () => Promise<void> }>}
 */
export async function prepareRouteSettings({
  tmpRoot,
  incumbentKey,
  fireworksKey,
  challengerModel,
  keyType,
  routerBaseUrl,
}) {
  const incumbentDir = path.join(tmpRoot, "incumbent");
  const challengerDir = path.join(tmpRoot, "challenger");
  await mkdir(incumbentDir, { recursive: true });
  await mkdir(challengerDir, { recursive: true });

  const incumbent = buildIncumbentSettings({ anthropicKey: incumbentKey });
  const { settings: challenger } = await buildChallengerSettings({
    fireworksKey,
    challengerModel,
    keyType,
    routerBaseUrl,
  });

  await writeJson(path.join(incumbentDir, "settings.json"), incumbent);
  await writeJson(path.join(challengerDir, "settings.json"), challenger);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  };
  return { incumbentDir, challengerDir, tmpDir: tmpRoot, cleanup };
}
