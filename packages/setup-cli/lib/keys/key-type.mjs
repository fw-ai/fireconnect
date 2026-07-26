export const MISSING_FIREWORKS_API_KEY_MESSAGE =
  "No Fireworks API key found. No settings were changed.\n\n"
  + "Sign in:\n"
  + "  fireconnect login\n\n"
  + "Custom SSO:\n"
  + "  fireconnect login --account <account-id>";

export function isFireworksShapedKey(key) {
  return typeof key === "string" && (key.startsWith("fw_") || key.startsWith("fpk_"));
}

export const isFireworksKey = isFireworksShapedKey;

export function fireworksKeyOrEmpty(key) {
  return isFireworksShapedKey(key) ? key.trim() : "";
}

export function detectApiKeyType(key) {
  return typeof key === "string" && key.trim().startsWith("fpk_")
    ? "firepass"
    : "fireworks";
}
