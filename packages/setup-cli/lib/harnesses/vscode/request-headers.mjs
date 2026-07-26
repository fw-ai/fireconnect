import { isFirerouterModel } from "../../fireworks/model-id.mjs";
import {
  ANTHROPIC_BYOK_BODY_FIELD,
  ANTHROPIC_BYOK_HEADER,
} from "../../firerouter/core.mjs";
import { mergeFireconnectTelemetryHeaders } from "../../telemetry/request-headers.mjs";

const BYOK_HEADER_NAMES = new Set([
  ANTHROPIC_BYOK_HEADER,
  "x-openai-api-key",
]);

export function withFireconnectRequestHeaders(
  model,
  { telemetryHeaders = {}, byokHeaders = {} } = {},
) {
  const firerouter = isFirerouterModel(model.id);
  const priorHeaders = Object.fromEntries(
    Object.entries(model.requestHeaders ?? {}).filter(
      ([name]) => !BYOK_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
  const requestHeaders = {
    ...mergeFireconnectTelemetryHeaders(priorHeaders, telemetryHeaders),
    ...(firerouter ? byokHeaders : {}),
  };
  const next = { ...model };
  if (Object.keys(requestHeaders).length) {
    next.requestHeaders = requestHeaders;
  } else {
    delete next.requestHeaders;
  }
  const anthropicKey = byokHeaders[ANTHROPIC_BYOK_HEADER];
  if (firerouter && anthropicKey) {
    next[ANTHROPIC_BYOK_BODY_FIELD] = anthropicKey;
  } else {
    delete next[ANTHROPIC_BYOK_BODY_FIELD];
  }
  return next;
}

export function withFireconnectRequestHeadersForModels(
  models,
  options,
) {
  return models.map((model) => withFireconnectRequestHeaders(model, options));
}
