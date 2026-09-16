/** Normalize a Responses API base without changing the gateway's path. */
export function normalizeCodexBaseUrl(value) {
  const raw = String(value ?? "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Codex --base-url must be an absolute HTTP or HTTPS URL.");
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || /[\u0000-\u0020\u007f]/.test(raw)) {
    throw new Error("Codex --base-url must be an absolute HTTP or HTTPS URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Codex --base-url must not contain credentials, a query, or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}
