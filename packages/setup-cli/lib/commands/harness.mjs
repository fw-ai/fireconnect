import { dispatchHarnessCommand } from "../harness-types.mjs";
import { getHarness } from "../harness-registry.mjs";

/**
 * @param {{ harnessId: string, verb: string, noun?: string }} route
 * @param {import("../harness-types.mjs").HarnessContext} ctx
 */
export async function runHarnessCommand(route, ctx) {
  const adapter = getHarness(route.harnessId);
  await dispatchHarnessCommand(adapter, route, ctx);
}
