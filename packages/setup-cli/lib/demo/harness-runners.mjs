/**
 * Headless raceable harness adapters for `fireconnect demo`'s harness-swap mode.
 *
 * harness-swap drives the user's REAL tool headlessly on two backends — its
 * native one (the incumbent) and Fireworks (the challenger) — in isolated
 * per-side config dirs, so the comparison is "same tool, swapped model."
 *
 * Each adapter owns two things:
 *   - `buildRaceSettings({ tmpRoot, incumbentKey, incumbentModel, fireworksKey,
 *       challengerModel, keyType, routerBaseUrl })` — build two isolated side
 *       configs (incumbent → native backend, challenger → Fireworks) under
 *       `tmpRoot`. Returns `{ incumbentDir, challengerDir, cleanup }`.
 *   - `runSide({ configDir, cwd, prompt, model, signal, onDelta, onError,
 *       onStatus, env })` — spawn the tool headless for one side and parse its
 *       output into the common RunResult shape (`{ ok, text, inputTokens,
 *       outputTokens, seconds, tokenLog, error?, httpStatus, errorBody? }`).
 *       The caller pins `model` for the incumbent; the challenger's settings
 *       carry their own model.
 *
 * Only Claude Code is implemented today. To add a harness (opencode, codex, …):
 * implement `buildRaceSettings` + `runSide` for it (its native backend takes the
 * place Anthropic holds for Claude), then register it below. The orchestrator
 * dispatches via `getHeadlessRunner`, so no other wiring is needed.
 */

import { HARNESS } from "../harness.mjs";
import { prepareRouteSettings } from "./route-settings.mjs";
import { runClaude } from "./claude-runner.mjs";

/** @type {Record<string, { id: string, label: string, buildRaceSettings: Function, runSide: Function }>} */
export const HEADLESS_RUNNERS = {
  [HARNESS.CLAUDE]: {
    id: HARNESS.CLAUDE,
    label: "Claude Code",
    buildRaceSettings: prepareRouteSettings,
    runSide: runClaude,
  },
};

export const SUPPORTED_HARNESS_IDS = Object.keys(HEADLESS_RUNNERS);

/**
 * @param {string} harnessId
 * @returns {{ id: string, label: string, buildRaceSettings: Function, runSide: Function } | null}
 */
export function getHeadlessRunner(harnessId) {
  return HEADLESS_RUNNERS[harnessId] ?? null;
}
