/** Upper bound for gateway verify/catalog HTTP requests (no response → fail fast). */
export const FIREWORKS_GATEWAY_FETCH_TIMEOUT_MS = 30_000;

/**
 * @returns {AbortSignal}
 */
export function fireworksGatewayFetchSignal() {
  return AbortSignal.timeout(FIREWORKS_GATEWAY_FETCH_TIMEOUT_MS);
}
