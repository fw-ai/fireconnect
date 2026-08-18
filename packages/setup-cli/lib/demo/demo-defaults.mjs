/**
 * Smart defaults for the demo wizard from CLI flags, saved prefs, and claude status.
 */

import { stripClaudeCodeContextSuffix } from "../harnesses/claude/code-context.mjs";
import { shortFireworksModelRef } from "../fireworks/model-id.mjs";
import {
  defaultLeftModel,
  defaultRightModel,
  isAnthropicSlotModel,
  isDemoCatalogModel,
} from "./demo-models.mjs";
import { loadDemoPreferences } from "./demo-preferences.mjs";
import { CUSTOM_MATCHUP_ID, demoMatchupPreset } from "./demo-matchups.mjs";

/** @param {string | null | undefined} modelId */
function toDemoCatalogId(modelId) {
  if (!modelId) {
    return null;
  }
  const bare = shortFireworksModelRef(stripClaudeCodeContextSuffix(String(modelId).trim()));
  if (isDemoCatalogModel(bare)) {
    return bare;
  }
  if (isAnthropicSlotModel(bare)) {
    return bare;
  }
  return null;
}

/** @param {string} leftModel @param {string} rightModel */
function sanitizeDemoModelPair(leftModel, rightModel) {
  let left = leftModel;
  let right = rightModel;
  if (!isDemoCatalogModel(left)) {
    left = defaultLeftModel();
  }
  if (!isDemoCatalogModel(right)) {
    right = defaultRightModel();
  }
  if (left === right) {
    // Prefer the default right model as the alternate; if both sides already
    // are that model, fall back to the default left so the pair always splits.
    right = left !== defaultRightModel() ? defaultRightModel() : defaultLeftModel();
  }
  return { leftModel: left, rightModel: right };
}

/**
 * @param {{
 *   home?: string,
 *   readinessMapping?: Record<string, string | null>,
 *   cliLeft?: string,
 *   cliRight?: string,
 *   saved?: Awaited<ReturnType<typeof loadDemoPreferences>>,
 * }} args
 */
export function resolveDemoWizardDefaults({
  home = "",
  readinessMapping = {},
  cliLeft = "",
  cliRight = "",
  saved = {},
} = {}) {
  // Fresh run (no saved prefs, no CLI overrides): default to the first matchup
  // option ("Claude Opus vs Fireworks") and its models, so the wizard opens on
  // the first option — not "custom". (Previously the right model was seeded from
  // the user's live Claude slot mapping, which drifted to "custom" whenever the
  // opus slot wasn't the bare "opus" alias.)
  const freshMatchup = demoMatchupPreset("subscription-vs-fireworks");

  let leftModel = cliLeft || saved.leftModel || freshMatchup.leftModel;
  let rightModel = cliRight || saved.rightModel || freshMatchup.rightModel;

  const savedMatchup = saved.matchupPresetId && saved.matchupPresetId !== CUSTOM_MATCHUP_ID
    ? demoMatchupPreset(saved.matchupPresetId)
    : null;
  if (saved.matchupPresetId === CUSTOM_MATCHUP_ID && !cliLeft && !cliRight) {
    const savedLeft = toDemoCatalogId(saved.leftModel);
    const savedRight = toDemoCatalogId(saved.rightModel);
    if (savedLeft) {
      leftModel = savedLeft;
    }
    if (savedRight) {
      rightModel = savedRight;
    }
  } else if (savedMatchup && !cliLeft && !cliRight) {
    leftModel = savedMatchup.leftModel;
    rightModel = savedMatchup.rightModel;
  }

  ({ leftModel, rightModel } = sanitizeDemoModelPair(leftModel, rightModel));

  // If sanitize (or CLI overrides) drifted the models off the claimed curated
  // preset, persist as custom — same rule as confirm-step swap.
  let matchupPresetId = saved.matchupPresetId || "subscription-vs-fireworks";
  const claimed = matchupPresetId !== CUSTOM_MATCHUP_ID
    ? demoMatchupPreset(matchupPresetId)
    : null;
  if (!claimed || claimed.leftModel !== leftModel || claimed.rightModel !== rightModel) {
    matchupPresetId = CUSTOM_MATCHUP_ID;
  }

  return {
    leftModel,
    rightModel,
    promptPresetId: saved.promptPresetId || "tetris",
    matchupPresetId,
  };
}

/**
 * @param {string} home
 * @param {import("./demo-readiness.mjs").DemoReadiness} readiness
 * @param {{ leftModel?: string, rightModel?: string }} cli
 */
export async function loadDemoWizardDefaults(home, readiness, cli = {}) {
  const saved = home ? await loadDemoPreferences(home) : {};
  return resolveDemoWizardDefaults({
    home,
    readinessMapping: readiness.mapping ?? {},
    cliLeft: cli.leftModel ?? "",
    cliRight: cli.rightModel ?? "",
    saved,
  });
}
