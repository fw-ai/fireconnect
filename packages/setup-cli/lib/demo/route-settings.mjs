/**
 * Model resolution for `fireconnect claude demo`.
 *
 * The demo races two real `claude -p` processes side by side using the user's
 * existing FireConnect-managed Claude Code profile — same as `claude live`, no
 * isolated config dirs or credential seeding.
 */

import { claudeCodeModelId } from "../harnesses/claude/code-context.mjs";
import { assertClaudeFireconnected } from "./demo-prep.mjs";
import { defaultLeftModel, defaultRightModel, isAnthropicSlotModel } from "./demo-models.mjs";

/** @param {string} modelId */
export function demoCliModel(modelId) {
  const bare = String(modelId).trim();
  if (isAnthropicSlotModel(bare)) {
    return bare;
  }
  return claudeCodeModelId(bare);
}

/**
 * Resolve left/right `--model` values and require `fireconnect claude`.
 *
 * @param {{
 *   leftModel?: string,
 *   rightModel?: string,
 *   home?: string,
 *   settingsPath?: string,
 * }} args
 */
export async function prepareRouteSettings({
  leftModel = "",
  rightModel = "",
  home = "",
  settingsPath = "",
}) {
  await assertClaudeFireconnected({ home, settingsPath });
  const resolvedLeft = leftModel || defaultLeftModel();
  const resolvedRight = rightModel || defaultRightModel();
  return {
    leftCliModel: demoCliModel(resolvedLeft),
    rightCliModel: demoCliModel(resolvedRight),
    cleanup: async () => {},
  };
}
