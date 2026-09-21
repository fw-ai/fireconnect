/** Strip catalog/router suffix from a display label. */
export function stripViaFireworksSuffix(label) {
  return String(label).replace(/ via Fireworks$/i, "");
}
