export const DEEPAGENTS_CONFIG_RELATIVE_PATH = ".deepagents/config.toml";
export const DEEPAGENTS_STATE_RELATIVE_DIR = ".deepagents/.state";
export const DEEPAGENTS_AUTH_RELATIVE_PATH = `${DEEPAGENTS_STATE_RELATIVE_DIR}/auth.json`;
export const DEEPAGENTS_DATA_RELATIVE_DIR = ".fireconnect/deepagents";
export const DEEPAGENTS_FIREWORKS_PROVIDER_ID = "fireworks";
export const DEEPAGENTS_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference";
export const DEEPAGENTS_API_KEY_ENV = "FIREWORKS_API_KEY";
export const DEEPAGENTS_PROVIDER_TABLE = `models.providers.${DEEPAGENTS_FIREWORKS_PROVIDER_ID}`;
// Fireworks models served on Microsoft Foundry (Azure) get a distinct provider,
// so a `fireworks-azure:<deployment>` default never collides with the gateway.
export const DEEPAGENTS_AZURE_PROVIDER_ID = "fireworks-azure";
export const DEEPAGENTS_AZURE_PROVIDER_TABLE = `models.providers.${DEEPAGENTS_AZURE_PROVIDER_ID}`;
export const AUTH_STORAGE_VERSION = 1;
