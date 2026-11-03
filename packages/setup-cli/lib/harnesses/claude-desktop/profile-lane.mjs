/**
 * Claude Desktop "profile lane": route Desktop's Chat/Cowork/Code surfaces
 * through Fireworks using Desktop's third-party provider profile mechanism
 * (<Claude-3p data dir>/configLibrary/ — ~/Library/Application Support on
 * macOS, ~/.config on Linux), with a loopback shim in front of Fireworks for
 * model-name mapping. The shim runs as a launchd agent (macOS) or a systemd
 * user unit (Linux); see platform.mjs.
 *
 * Semantics (validated live):
 * - profile keys: inferenceGatewayBaseUrl, inferenceGatewayApiKey,
 *   chatTabEnabled, inferenceModels[] (names MUST be Anthropic-shaped),
 *   inferenceProvider: "gateway", inferenceCredentialKind: "static",
 *   managedMcpServers as an ARRAY [{name, transport: "http", url}] — the
 *   object form is rejected with invalid_type.
 * - the Connectors pane is suppressed in 3p mode, but connectors still work
 *   in sessions; each needs a one-time OAuth re-auth.
 * - connector detection: scan Desktop session files' remoteMcpServersConfig.
 * - existing user profiles are backed up before we write and restored on off.
 */
import process from "node:process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { assertResolvedKeyNotRejected, resolveFireworksKeyWithSource, tryReadKeychainSecret } from "../../keys/api-key.mjs";
import { loadServerlessCatalog } from "../../fireworks/models.mjs";
import { isFirerouterModelPattern } from "../../fireworks/model-specs.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { printBody, printNote } from "../../cli/messages.mjs";
import { claudeDesktopDataDir } from "./core.mjs";
import {
  SHIM_AGENT_LABEL, SUPPORTED_PLATFORMS, buildShimServiceFile, launchAgentPlistPath,
  retireLegacyShimAgent, shimServiceFilePath, shimTrustOptions, startShimService, stopShimService,
} from "./platform.mjs";
import { preferDataDirPath } from "../../system/data-dir.mjs";
import { ensureShimSecret, probeShimIdentity, readShimSecret } from "./shim-auth.mjs";
import { isLoopbackHostname } from "../../system/loopback.mjs";

const SHIM_DEFAULT_PORT = 8799;
const SHIM_LABEL = SHIM_AGENT_LABEL;

export function shimStatePath(home) {
  return path.join(claudeDesktopDataDir(home), "shim-state.json");
}
function profileStatePath(home) {
  return path.join(claudeDesktopDataDir(home), "profile-state.json");
}
/** The owned shim service definition (launchd plist or systemd user unit). */
export function shimServicePath(home) {
  return shimServiceFilePath(home, { label: SHIM_LABEL });
}
export function shimPlistPath(home) {
  return launchAgentPlistPath(home, SHIM_LABEL);
}
function backupDir(home) {
  return path.join(claudeDesktopDataDir(home), "profile-backup");
}
// The pure lineup logic lives in lineup.mjs (the shim imports only that leaf);
// re-export so existing callers keep working.
import { DEFAULT_MODEL_MAP, PICKER_MODELS, firstPartyDir, serverlessLineup, thirdPartyDir } from "./lineup.mjs";
export { DEFAULT_MODEL_MAP, PICKER_MODELS, firstPartyDir, serverlessLineup, thirdPartyDir } from "./lineup.mjs";
function configLibraryDir(home) {
  return path.join(thirdPartyDir(home), "configLibrary");
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

export async function readProfileState(home) {
  return readJson(profileStatePath(home));
}

/**
 * Detect connectors from Desktop session files. Each local-agent session
 * carries `remoteMcpServersConfig: [{uuid, name, url, tools[]}]` for the
 * connectors that were live in it. Offline, no credentials needed.
 * Returns a deduped array in Desktop's managedMcpServers entry shape.
 */
export async function detectConnectors(home, { deployments = [firstPartyDir(home), thirdPartyDir(home)] } = {}, hostedByUuid = new Map()) {
  const found = new Map();
  for (const root of deployments) {
    const sessionsRoot = path.join(root, "local-agent-mode-sessions");
    await walk(sessionsRoot, found, hostedByUuid);
  }
  // The pre-Nexus (first-party) deployment's own MCP config is a
  // detection source too: its mcpServers (http and stdio) are connectors the
  // user already had before the 3p lane existed.
  const firstParty = await readJson(path.join(firstPartyDir(home), "claude_desktop_config.json"));
  for (const [name, def] of Object.entries(firstParty?.mcpServers ?? {})) {
    const key = connectorSlug(name);
    // A relay URL recorded from a session file yields to the config's real URL.
    if (!key || (found.has(key) && !isRelayUrl(found.get(key).url))) continue;
    if (typeof def?.url === "string" && /^https:\/\//.test(def.url)) {
      found.set(key, { name: key, transport: "http", url: def.url, ...(def.oauth ? { oauth: desktopOAuth(def.oauth, def.url) } : {}) });
    } else if (typeof def?.command === "string") {
      found.set(key, { name: key, transport: "stdio", command: def.command, args: def.args ?? [], ...(def.env ? { env: def.env } : {}) });
    }
  }
  return [...found.values()];
}

/**
 * Translate a Claude Code / first-party MCP `oauth` block into Desktop's
 * managed-MCP shape. Claude Code registers pre-registered clients with an
 * http://localhost:<callbackPort>/callback redirect, while Desktop defaults
 * to 127.0.0.1 — an exact-match IdP (e.g. Slack) then rejects the redirect.
 * Pinning callbackHost to localhost keeps the redirect byte-identical.
 */
export function desktopOAuth(oauth, url) {
  if (!oauth || typeof oauth !== "object") return undefined;
  const out = { ...oauth };
  if (out.clientId && out.callbackPort && !out.callbackHost) out.callbackHost = "localhost";
  // A client secret requires an explicit issuer (Desktop schema rule).
  if (out.clientSecret && !out.authorizationServer) {
    let host = "";
    try { host = new URL(url ?? "").hostname; } catch {}
    const issuer = /googleapis\.com$/.test(host) ? "https://accounts.google.com"
      : OAUTH_ISSUERS[host];
    if (issuer) out.authorizationServer = [issuer];
  }
  return out;
}

// Authorization-server issuers for IdPs Desktop cannot discover.
const OAUTH_ISSUERS = {
  "mcp.slack.com": "https://slack.com",
  "mcp.figma.com": "https://api.figma.com",
};

/**
 * Claude.ai connector relay candidates: {name, serverId} pairs found in
 * session files. server_id addresses Anthropic's connector relay:
 * https://mcp-proxy.anthropic.com/v1/mcp/{server_id}.
 */
export async function listHostedCandidates(home) {
  const hostedByUuid = new Map();
  for (const root of [firstPartyDir(home), thirdPartyDir(home)]) {
    await walk(path.join(root, "local-agent-mode-sessions"), new Map(), hostedByUuid);
  }
  return [...hostedByUuid.values()];
}

/**
 * Connectors hosted on Anthropic/Google infrastructure authenticate through
 * the claude.ai control plane (their vendor tokens live server-side); the
 * 3p app cannot self-register with them, so sync skips them unless the entry
 * carries its own pre-registered OAuth client.
 */
// mcp-proxy.anthropic.com is claude.ai's connector relay: a session file
// carrying that URL is really a hosted connector (see listHostedCandidates),
// and the relay only answers for claude.ai sessions — a 3p profile pointing
// at it gets a dead server, so it is skipped like the other control-plane
// hosts.
const CONTROL_PLANE_HOSTS = /googleapis\.com$|claudemcpcontent\.com$|\.mcp\.claude\.com$|^mcp\.claude\.com$|^mcp-proxy\.anthropic\.com$/;

export function reliesOnClaudeAiLogin(entry) {
  const url = entry?.url ?? "";
  let host = "";
  try { host = new URL(url).hostname; } catch { return false; }
  return CONTROL_PLANE_HOSTS.test(host) && !entry?.oauth?.clientId;
}

/** claude.ai's connector relay (see listHostedCandidates). */
function isRelayUrl(url) {
  try { return new URL(url).hostname === "mcp-proxy.anthropic.com"; } catch { return false; }
}

/** IdPs that require a pre-registered OAuth client (Figma): without one the
 * entry can never authenticate, so sync skips it instead of landing a dead
 * connector. `mcp add <name> --client-id --client-secret` supplies one. */
const BYO_OAUTH_HOSTS = new Set(["mcp.figma.com"]);

function hostOf(url) {
  try { return new URL(url ?? "").hostname; } catch { return ""; }
}

/** Entries that can never work in the 3p profile: relay URLs (dead even
 * with an OAuth client — the relay answers claude.ai sessions only),
 * control-plane connectors without their own client, and connectors that
 * require a pre-registered OAuth client the user has not supplied. */
function isUnmigratable(entry) {
  return isRelayUrl(entry?.url) || reliesOnClaudeAiLogin(entry)
    || (BYO_OAUTH_HOSTS.has(hostOf(entry?.url)) && !entry?.oauth?.clientId);
}

/** Why a connector was skipped, for sync output. */
function skippedReason(entry, excluded) {
  if (excluded.has(entry.name)) return "removed with `mcp remove`";
  const host = hostOf(entry?.url);
  if (BYO_OAUTH_HOSTS.has(host) || /googleapis\.com$/.test(host)) return "requires OAuth client ID and secret";
  return "requires claude.ai account";
}

/** Canonical report lines for `mcp sync` and `on`. */
export function syncReportLines({ migrated = [], skipped = [] } = {}) {
  const lines = [];
  if (migrated.length) {
    lines.push("  Migrated:");
    for (const e of migrated) lines.push(`    ${e.name}`);
  }
  if (skipped.length) {
    lines.push("  Not migrated:");
    for (const s of skipped) lines.push(`    ${s.name}: ${s.reason}`);
  }
  return lines;
}

/**
 * Managed MCP server names may only contain letters, digits, hyphens and
 * underscores, so display names like "Google Drive" become "google-drive".
 * Returns "" when nothing usable remains.
 */
export function connectorSlug(name) {
  if (typeof name !== "string") return "";
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return /^[a-z][a-z0-9_-]{0,63}$/.test(slug) ? slug : "";
}

async function walk(dir, found, hostedByUuid = new Map()) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(p, found, hostedByUuid); continue; }
    if (!entry.name.startsWith("local_") || !entry.name.endsWith(".json")) continue;
    const session = await readJson(p);
    for (const server of session?.remoteMcpServersConfig ?? []) {
      const url = server?.url;
      const key = connectorSlug(server?.name);
      if (typeof url !== "string" || !/^https:\/\//.test(url) || !key) continue;
      // A relay URL is not the connector's own address — it only resolves for
      // claude.ai sessions. Record it as a placeholder so sync can report the
      // connector as skipped, but let a usable URL for the same name win.
      const existing = found.get(key);
      const isRelay = isRelayUrl(url);
      if (isRelay ? !existing : (!existing || isRelayUrl(existing.url))) {
        found.set(key, { name: key, transport: "http", url });
      }
      if (typeof server.uuid === "string" && !hostedByUuid.has(server.uuid)) {
        hostedByUuid.set(server.uuid, { name: key, serverId: server.uuid });
      }
    }
  }
}

/**
 * Parse `claude mcp list` output. Only the "claude.ai <Name>: <url> - ..."
 * rows are org connectors; local Claude Code servers are ignored.
 */
export function parseClaudeMcpList(stdout) {
  const connectors = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = /^claude\.ai (.+?): (https:\/\/\S+) - /.exec(line.trim());
    if (!m) continue;
    const name = connectorSlug(m[1]);
    if (name) connectors.push({ name, transport: "http", url: m[2] });
  }
  return connectors;
}

/**
 * Backup source: the org's full claude.ai connector registry, via the Claude
 * Code CLI when it is installed. Env auth (ANTHROPIC_API_KEY and friends) and
 * user settings are excluded because either one hides claude.ai connectors.
 * Bounded by a timeout; any failure yields [] so sync still completes.
 */
export async function listOrgConnectorsViaClaudeCli({ timeoutMs = 90_000 } = {}) {
  if (process.env.NEXUS_TEST === "1") return [];
  const { execFile } = await import("node:child_process");
  const env = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"]) delete env[name];
  // Project and local settings are read from the working directory, so run
  // in a fresh private one: never a shared directory others can write into.
  const { tmpdir } = await import("node:os");
  const cwd = await mkdtemp(path.join(tmpdir(), "nexus-mcp-list-"));
  try {
    return await new Promise((resolve, reject) => {
      execFile("claude", ["--setting-sources", "project,local", "mcp", "list"], {
        env, cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout) => {
        if (error && !stdout) reject(new Error(`claude mcp list failed: ${error.message}`));
        else resolve(parseClaudeMcpList(stdout));
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

function appliedProfilePath(home, state) {
  return path.join(configLibraryDir(home), `${state.profileId}.json`);
}

async function requireEnabledProfile(home) {
  const state = await readProfileState(home);
  if (!state?.enabled || !state.profileId) {
    throw new Error("The profile lane is not enabled. Run: nexus claude-desktop on");
  }
  const profilePath = appliedProfilePath(home, state);
  const profile = await readJson(profilePath);
  if (!profile) throw new Error(`Applied profile ${state.profileId} is missing; run \`nexus claude-desktop on\` to rewrite it.`);
  return { state, profilePath, profile };
}

async function setConnectorExcluded(home, name, excluded) {
  const state = await readProfileState(home);
  if (!state) return;
  const key = connectorSlug(name);
  const set = new Set(Array.isArray(state.excludedConnectors) ? state.excludedConnectors : []);
  if (excluded) set.add(key); else set.delete(key);
  state.excludedConnectors = [...set].sort();
  await writeFileAtomic(profileStatePath(home), JSON.stringify(state, null, 2));
  await persistConnectorStore(home, { excluded: state.excludedConnectors }).catch(() => {});
}

/** Connectors currently in the applied profile. */
export async function listProfileConnectors(home) {
  const state = await readProfileState(home);
  if (!state?.enabled || !state.profileId) return [];
  const profile = await readJson(appliedProfilePath(home, state));
  return Array.isArray(profile?.managedMcpServers) ? profile.managedMcpServers : [];
}

/**
 * Remote connectors must be https. Plain http is allowed only for loopback
 * servers running on this machine (e.g. an app's local MCP server such as
 * http://127.0.0.1:<port>/mcp), which never leave the device.
 */
export function isConnectorUrl(url) {
  if (typeof url !== "string") return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
}

/** Add or replace a connector directly in the applied profile. */
function oauthClientsPath(home) {
  return path.join(claudeDesktopDataDir(home), "oauth-clients.json");
}

/** Durable OAuth clients (survive off/on profile restore). name -> oauth block. */
export async function readOauthClients(home) {
  return (await readJson(oauthClientsPath(home))) ?? {};
}

/**
 * Durable connector store (survives off/on like oauth-clients.json). `off`
 * deletes the applied profile and the profile state (which holds
 * excludedConnectors), so the connector setup is mirrored here and re-on
 * restores it instead of silently dropping every mcp add/sync result.
 */
function connectorStorePath(home) {
  return path.join(claudeDesktopDataDir(home), "connectors.json");
}

async function readConnectorStore(home) {
  const stored = await readJson(connectorStorePath(home));
  return {
    servers: Array.isArray(stored?.servers) ? stored.servers : [],
    excluded: Array.isArray(stored?.excluded) ? stored.excluded : [],
  };
}

async function writeConnectorStore(home, { servers, excluded }) {
  await mkdir(claudeDesktopDataDir(home), { recursive: true });
  await writeFileAtomic(connectorStorePath(home), JSON.stringify({ servers, excluded }, null, 2), { mode: 0o600 });
}

/** Mirror the applied profile's connector setup into the durable store.
 * undefined leaves the slot alone; an EMPTY array must be persisted — the
 * user may have removed the last connector, and skipping would resurrect it
 * on the next on. */
async function persistConnectorStore(home, { servers, excluded } = {}) {
  const store = await readConnectorStore(home);
  if (Array.isArray(servers)) store.servers = servers;
  if (Array.isArray(excluded)) store.excluded = excluded;
  await writeConnectorStore(home, store);
}

/**
 * A saved OAuth client for `name`, only when it was registered for `url`. A
 * client is issued for one server: a source that later reports a different
 * URL under the same name never inherits it. Entries saved before the URL
 * was recorded match nothing here; sync binds them (see backfillClientUrls
 * and syncProfileConnectors).
 */
export function durableClientFor(durable, name, url) {
  const entry = durable?.[name];
  if (!entry || typeof entry !== "object") return undefined;
  const { registeredUrl, ...oauth } = entry;
  return typeof url === "string" && registeredUrl === url ? oauth : undefined;
}

/**
 * Clients saved before the URL was recorded: take the URL once from the
 * applied profile's entry carrying the same client, then they are
 * URL-bound like any other. Mutates and persists `durable`.
 */
async function backfillClientUrls(home, durable, servers) {
  let changed = false;
  for (const server of Array.isArray(servers) ? servers : []) {
    const entry = durable[server?.name];
    if (!entry || typeof entry !== "object" || entry.registeredUrl || typeof server.url !== "string") continue;
    if (!server.oauth || server.oauth.clientId !== entry.clientId) continue;
    entry.registeredUrl = server.url;
    changed = true;
  }
  if (!changed) return;
  await writeFileAtomic(oauthClientsPath(home), JSON.stringify(durable, null, 2), { mode: 0o600 });
}

async function saveOauthClient(home, name, oauth, url) {
  if (!oauth || typeof oauth !== "object") return;
  const all = await readOauthClients(home);
  all[name] = { ...oauth, registeredUrl: url };
  await mkdir(claudeDesktopDataDir(home), { recursive: true });
  await writeFileAtomic(oauthClientsPath(home), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export async function addProfileConnector(home, { name, url, command, args, env, oauth }) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/i.test(name)) {
    throw new Error(`Invalid connector name: ${name}`);
  }
  const isHttp = isConnectorUrl(url);
  const isStdio = typeof command === "string" && command.length > 0;
  if (!isHttp && !isStdio) {
    throw new Error(`Connector needs an https URL (http only for 127.0.0.1/localhost) or a stdio command: ${name}`);
  }
  if (oauth && isHttp) await saveOauthClient(home, name, oauth, url);
  const entry = isHttp
    ? { name, transport: "http", url, ...(oauth ? { oauth: desktopOAuth(oauth, url) } : {}) }
    : { name, transport: "stdio", command, args: args ?? [], ...(env ? { env } : {}) };
  const { profilePath, profile } = await requireEnabledProfile(home);
  const servers = Array.isArray(profile.managedMcpServers) ? profile.managedMcpServers : [];
  const i = servers.findIndex((e) => e?.name === name);
  if (i >= 0) servers[i] = entry; else servers.push(entry);
  profile.managedMcpServers = servers;
  await writeFileAtomic(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
  await persistConnectorStore(home, { servers }).catch(() => {});
  await setConnectorExcluded(home, name, false);
}

/** Remove a connector from the applied profile. Returns true when one existed. */
export async function removeProfileConnector(home, name) {
  const { profilePath, profile } = await requireEnabledProfile(home);
  const servers = Array.isArray(profile.managedMcpServers) ? profile.managedMcpServers : [];
  const next = servers.filter((e) => e?.name !== name);
  // Record the removal so `mcp sync` does not re-add it from a detection source.
  await setConnectorExcluded(home, name, true);
  if (next.length === servers.length) return false;
  if (next.length) profile.managedMcpServers = next;
  else delete profile.managedMcpServers;
  await writeFileAtomic(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
  await persistConnectorStore(home, { servers: next }).catch(() => {});
  return true;
}

/**
 * Re-detect connectors (session files + pre-Nexus config) and merge
 * them into the applied profile. Detected entries replace same-named ones;
 * profile entries nothing detects anymore (manual adds) are kept.
 */
export async function syncProfileConnectors(home, { listOrgConnectors = listOrgConnectorsViaClaudeCli } = {}) {
  const { state, profilePath, profile } = await requireEnabledProfile(home);
  const excluded = new Set(Array.isArray(state.excludedConnectors) ? state.excludedConnectors : []);
  // Local sources first (sessions + first-party config), then the org
  // registry from the Claude Code CLI for connectors never used in Desktop.
  // Names the user removed stay out. Durable OAuth clients (mcp add
  // --client-id) are overlaid BEFORE the control-plane filter: an entry with
  // its own client authenticates standalone and is kept; without one,
  // control-plane connectors (Google/Anthropic-hosted) are skipped.
  const durable = await readOauthClients(home);
  await backfillClientUrls(home, durable, profile.managedMcpServers).catch(() => {});
  const previousOauth = new Map((Array.isArray(profile.managedMcpServers) ? profile.managedMcpServers : [])
    .filter((e) => typeof e?.name === "string" && e?.oauth).map((e) => [e.name, e]));
  // A client follows its connector's name AND URL, never just the name.
  const previousClient = (e) => {
    const prev = previousOauth.get(e.name);
    return prev && prev.url === e.url ? prev.oauth : undefined;
  };
  // A client saved before URLs were recorded that the applied profile no
  // longer carries: bind it, once, to the URL the first source reports for
  // its name, then it is URL-bound like any other.
  let bound = false;
  const legacyClient = (e) => {
    const entry = durable[e.name];
    // Never bind a URL-less client to a relay placeholder — it would record
    // the dead URL and the real URL from another source could not inherit it.
    if (excluded.has(e.name) || isRelayUrl(e.url) || !entry || typeof entry !== "object" || entry.registeredUrl || typeof e.url !== "string") {
      return undefined;
    }
    entry.registeredUrl = e.url;
    bound = true;
    return durableClientFor(durable, e.name, e.url);
  };
  const withClients = (e) => {
    const oauth = e.oauth ?? previousClient(e) ?? durableClientFor(durable, e.name, e.url) ?? legacyClient(e);
    return oauth && !e.oauth ? { ...e, oauth: desktopOAuth(oauth, e.url) } : e;
  };
  const [detectedAll, orgRaw] = await Promise.all([
    detectConnectors(home),
    listOrgConnectors().catch(() => null),
  ]);
  const registryRead = orgRaw !== null;
  // Skipped connectors are reported by name with a reason (first source wins).
  const skipped = new Map();
  const keep = (e) => {
    const skip = excluded.has(e.name) || isUnmigratable(e);
    // A usable entry for the same name from another source un-skips it.
    if (!skip) skipped.delete(e.name);
    else if (!skipped.has(e.name)) skipped.set(e.name, { name: e.name, reason: skippedReason(e, excluded) });
    return !skip;
  };
  const detected = detectedAll.map(withClients).filter(keep);
  const org = (orgRaw ?? []).map(withClients).filter(keep);
  if (bound) await writeFileAtomic(oauthClientsPath(home), JSON.stringify(durable, null, 2), { mode: 0o600 }).catch(() => {});
  // The list is rebuilt strictly from sources: org-registered + locally used.
  // Standard-catalog connectors that the org has not added are ignored, and
  // entries only present in the profile from an earlier sync are dropped.
  const byName = new Map();
  const localNames = new Set(detected.map((e) => e.name));
  // Keep profile entries that are manual (loopback servers like figma-desktop)
  // or carry their own OAuth client — sources cannot re-derive those.
  const isManual = (e) => {
    let host = "";
    try { host = new URL(e?.url ?? "").hostname; } catch { return true; } // stdio
    return isLoopbackHostname(host) || Boolean(e?.oauth);
  };
  for (const server of Array.isArray(profile.managedMcpServers) ? profile.managedMcpServers : []) {
    if (!server?.name) continue;
    if (excluded.has(server.name) || isUnmigratable(server)) {
      if (!skipped.has(server.name)) skipped.set(server.name, { name: server.name, reason: skippedReason(server, excluded) });
      continue;
    }
    if (isManual(server)) byName.set(server.name, server);
  }
  for (const entry of [...detected, ...org.filter((e) => !localNames.has(e.name))]) {
    byName.set(entry.name, entry);
  }
  const merged = [...byName.values()];
  // A name that still migrated is not "skipped" — e.g. a purged relay entry
  // in the profile while a usable URL for it came from a detection source.
  for (const entry of merged) skipped.delete(entry.name);
  if (merged.length) profile.managedMcpServers = merged;
  else delete profile.managedMcpServers;
  await writeFileAtomic(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
  await persistConnectorStore(home, { servers: merged, excluded: [...excluded] }).catch(() => {});
  return { total: merged.length, fromOrg: org.length, registryRead,
    migrated: merged, skipped: [...skipped.values()] };
}

/** Set/clear the harness enabled flag via the shared config helper (uninstall discovery reads it). */
async function markHarnessEnabled(home, enabled = true) {
  const { setHarnessEnabled } = await import("../../config/global-config.mjs");
  await setHarnessEnabled(home, "claude-desktop", enabled, "fireworks");
}

/**
 * One-way skills/plugin asset copy, claude.ai -> 3p, on `on` only
 * (--ignore-existing semantics: nothing is ever overwritten or deleted).
 * The skills-plugin tree lives under local-agent-mode-sessions but holds no
 * sessions — it carries skills/ and .claude-plugin/ assets the 3p deployment
 * needs to render your plugins. Sessions themselves are NOT migrated: each
 * deployment keeps its own conversation history.
 */
export async function migrateSkillsPlugin(home, { log = () => {} } = {}) {
  const src = path.join(firstPartyDir(home), "local-agent-mode-sessions", "skills-plugin");
  const dst = path.join(thirdPartyDir(home), "local-agent-mode-sessions", "skills-plugin");
  let copied = 0;
  const copyTree = async (s, d) => {
    let entries;
    try { entries = await readdir(s, { withFileTypes: true }); } catch { return; }
    await mkdir(d, { recursive: true }).catch(() => {});
    for (const entry of entries) {
      const sp = path.join(s, entry.name);
      const dp = path.join(d, entry.name);
      if (entry.isDirectory()) { await copyTree(sp, dp); continue; }
      try { await stat(dp); continue; } catch { /* missing: copy */ }
      // Count only a copy that landed — a failed cp must not count as success.
      await cp(sp, dp).then(() => { copied += 1; }).catch(() => {});
    }
  };
  try {
    await copyTree(src, dst);
  } catch (error) {
    log(`Skills/plugins migration skipped: ${error?.message ?? error}`);
  }
  return copied;
}



/**
 * Build the full picker line-up: the auto mixes plus one entry per -latest
 * Fireworks router, each named with a UNIQUE signed-catalog id (tier-matched
 * where the pool allows; leftovers borrow unused ids of any tier). `auto`
 * ranks first so it takes the first opus id as that tier's default. Also
 * returns the shim model map covering every entry (bare only — the [1m]
 * spelling renders a duplicate row in static lists).
 */

/**
 * Resolve the picker line-up from the same served catalog `model list` and the
 * other harnesses use (so `auto` arrives once, however the gateway lists it),
 * paired against the signed catalog the shim cached. A cold cache with no
 * network falls back to the curated list.
 */
/** Fetch the signed model catalog (the id pool for pairing) when the shim's
 * cached copy is missing or stale. Not the hot path — `on` only. */
async function refreshSignedCatalog(catalogPath, { maxAgeMs = 24 * 3600_000 } = {}) {
  try {
    const age = Date.now() - (await stat(catalogPath)).mtimeMs;
    if (age < maxAgeMs) return;
  } catch { /* missing: fetch */ }
  try {
    const res = await fetch("https://downloads.claude.ai/model-catalog/v1/catalog.json", {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      await mkdir(path.dirname(catalogPath), { recursive: true });
      await writeFileAtomic(catalogPath, await res.text());
    }
  } catch { /* offline: the cached copy (or the fallback ids) will do */ }
}

/** Custom models from `on --model <id>` — durable: `off` removes
 * profile-state.json, so they live in manual-models.json (like the OAuth
 * client store). */
async function readManualModels(home) {
  const list = await readJson(path.join(claudeDesktopDataDir(home), "manual-models.json"));
  return Array.isArray(list) ? list : [];
}

async function writeManualModels(home, list) {
  await mkdir(claudeDesktopDataDir(home), { recursive: true });
  await writeFileAtomic(path.join(claudeDesktopDataDir(home), "manual-models.json"), JSON.stringify(list, null, 2));
}

/**
 * `--model <id>` adds a custom picker entry: validate the id against the
 * serverless cache, pair an unused valid catalog id (the app removes non-
 * Anthropic ids; the anthropic/-prefixed spelling works when the bare pool is
 * out). Stored in manual-models.json (durable across off/on).
 */
export async function customModelEntry(home, shortId, { catalogIds, usedNames } = {}) {
  const cache = (await readJson(path.join(home, ".nexus", "catalog-cache.json")))?.snapshot?.entries ?? [];
  const hit = cache.find((e) => e?.shortId === shortId || e?.id === shortId || e?.baseModelId?.endsWith(`/${shortId}`));
  if (!hit) return null;
  const label = hit.displayName ?? shortId;
  const tier = /kimi|opus|fable|max/i.test(label) ? "opus"
    : /flash|mini|haiku/i.test(label) ? "haiku" : "sonnet";
  const catalog = await readJson(path.join(claudeDesktopDataDir(home), "catalog", "catalog.json"));
  const pool = (catalogIds ?? (catalog?.surfaces?.chat?.model_selector_config ?? [])
    .flatMap((c) => c?.models ?? []).map((m) => m?.id).filter(Boolean));
  const state = await readProfileState(home);
  const lib = configLibraryDir(home);
  const profile = state?.profileId ? await readJson(path.join(lib, `${state.profileId}.json`)) : null;
  const used = new Set([
    ...(Array.isArray(profile?.inferenceModels) ? profile.inferenceModels : []).map((m) => m.name),
    // The lineup about to be written (a first on has no profile yet).
    ...(usedNames ?? []),
    // Persisted customs survive off (the profile doesn't): their ids must
    // never be handed to a new custom, or two entries would share a name and
    // the newer route would overwrite the older one.
    ...(await readManualModels(home)).map((m) => m.name),
  ]);
  const bare = pool.filter((id) => !used.has(id));
  const prefixed = pool.filter((id) => !used.has(`anthropic/${id}`)).map((id) => `anthropic/${id}`);
  const name = bare[0] ?? prefixed[0];
  if (!name) return null;
  return {
    entry: { name, labelOverride: label, anthropicFamilyTier: tier, isFamilyDefault: false },
    map: [name, hit.shortId],
    shortId: hit.shortId,
  };
}

export async function loadDesktopLineup({ apiKey, signedCatalogPath }) {
  await refreshSignedCatalog(signedCatalogPath);
  let entries = [];
  try {
    ({ catalog: entries } = await loadServerlessCatalog({ apiKey }));
  } catch {
    // No cached snapshot and the gateway is unreachable.
  }
  const full = serverlessLineup(entries, await readJson(signedCatalogPath));
  return {
    full: Boolean(full),
    models: full?.models ?? PICKER_MODELS,
    modelMap: full?.modelMap ?? DEFAULT_MODEL_MAP,
  };
}

// Unset, Cowork and Chat refuse every web fetch and sandbox network call.
// "*" matches first-party Cowork; a list the user set in Desktop wins.
const DEFAULT_EGRESS_HOSTS = Object.freeze(["*"]);

function userEgressHosts(profile) {
  const hosts = profile?.coworkEgressAllowedHosts;
  return Array.isArray(hosts) && hosts.length ? hosts : null;
}

/** The user's own list from the current profile, else the one `off` saved, else every host. */
export function egressHosts(profile, saved) {
  return userEgressHosts(profile) ?? userEgressHosts({ coworkEgressAllowedHosts: saved }) ?? [...DEFAULT_EGRESS_HOSTS];
}

/** `off` deletes the profile, so a user-set egress list is kept here for the next `on`. */
function egressStorePath(home) {
  return path.join(claudeDesktopDataDir(home), "egress-hosts.json");
}

function buildProfile({
  shimUrl, apiKey, models, existingServers, customModels = [], coworkEgressAllowedHosts,
}) {
  // managedMcpServers are opt-in via `nexus claude-desktop mcp add/sync`
  // (which rewrite the applied profile directly). A repeat `on` preserves
  // them so a re-run never wipes the user's connectors.
  const servers = Array.isArray(existingServers) ? existingServers : [];
  return {
    inferenceGatewayBaseUrl: shimUrl,
    inferenceGatewayApiKey: apiKey,
    chatTabEnabled: true,
    // `route` is our internal link to the shim's model map; the app rejects
    // unknown inferenceModels sub-keys, so strip it from what we persist.
    inferenceModels: [
      ...(models ?? PICKER_MODELS).map(({ route: _route, ...entry }) => entry),
      ...customModels.map((m) => ({ name: m.name, labelOverride: m.label, anthropicFamilyTier: m.tier, isFamilyDefault: false })),
    ],
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    toolSearchEnabled: true,
    // Max stream-idle wait (documented range 300–1800s). 1M-context prefills
    // take minutes on a silent stream; the default 300s abandons them.
    inferenceStreamIdleTimeoutSec: 1800,
    coworkEgressAllowedHosts,
    ...(servers.length ? { managedMcpServers: servers } : {}),
  };
}

/** True when a profile routes through our loopback shim — Nexus-written,
 * regardless of profile-state.json (which older installs may lack). The port
 * alone is not the signal (a user may run another loopback gateway, or the
 * default port may change): fingerprint on the full shape only we write —
 * loopback host + fw_ key + gateway/static credentials. */
function isShimProfile(profile, shimUrl) {
  const url = profile?.inferenceGatewayBaseUrl;
  if (typeof url !== "string") return false;
  let host = "", port = "";
  try { ({ hostname: host, port } = new URL(url)); } catch { return false; }
  const loopback = isLoopbackHostname(host);
  if (!loopback) return false;
  const key = profile?.inferenceGatewayApiKey;
  // Older installs also wrote Fire Pass (fpk_) keys; `off` must still find them.
  const fingerprint = typeof key === "string" && /^(fw_|fpk_)/.test(key)
    && profile?.inferenceProvider === "gateway" && profile?.inferenceCredentialKind === "static";
  return fingerprint && (port === "" || port === String(new URL(shimUrl).port));
}

/**
 * Re-point the applied Nexus profile at `fireworksKey`: Desktop sends the
 * profile's literal key, so it must track the stored key. Returns true when
 * the profile changed.
 * @param {{ home: string, fireworksKey: string }} params
 */
export async function refreshClaudeDesktopGatewayKey({ home, fireworksKey }) {
  const key = fireworksKey?.trim();
  // Like `on`, bake only the stored key, never one from this shell's environment.
  if (!key || key !== await tryReadKeychainSecret(home)) return false;
  const state = await readProfileState(home);
  if (!state?.enabled || !state.profileId) return false;
  const profilePath = path.join(configLibraryDir(home), `${state.profileId}.json`);
  const profile = await readJson(profilePath);
  if (!isShimProfile(profile, `http://127.0.0.1:${state.port ?? SHIM_DEFAULT_PORT}`)
    || profile.inferenceGatewayApiKey === key) return false;
  await writeFileAtomic(profilePath, JSON.stringify({ ...profile, inferenceGatewayApiKey: key }, null, 2), { mode: 0o600 });
  return true;
}

/**
 * The key Claude Desktop sends while the Nexus profile is applied: the
 * profile's literal `inferenceGatewayApiKey` (the shim forwards it as-is).
 * null when the lane is off or the profile isn't ours. Reads files only.
 * @param {string} home
 * @returns {Promise<string | null>}
 */
export async function readClaudeDesktopProfileKey(home) {
  const state = await readProfileState(home);
  if (!state?.enabled || !state.profileId) return null;
  const profile = await readJson(path.join(configLibraryDir(home), `${state.profileId}.json`));
  if (!isShimProfile(profile, `http://127.0.0.1:${state.port ?? SHIM_DEFAULT_PORT}`)) return null;
  return profile.inferenceGatewayApiKey;
}

/** Durable registry of profile ids Nexus has written (survives off, so
 * detection never depends on profile-state.json alone). */
function writtenProfilesPath(home) {
  return path.join(claudeDesktopDataDir(home), "written-profiles.json");
}

export async function readWrittenProfiles(home) {
  const list = await readJson(writtenProfilesPath(home));
  return new Set(Array.isArray(list) ? list : []);
}

async function rememberWrittenProfile(home, profileId) {
  const set = await readWrittenProfiles(home);
  if (set.has(profileId)) return;
  set.add(profileId);
  await mkdir(claudeDesktopDataDir(home), { recursive: true });
  await writeFileAtomic(writtenProfilesPath(home), JSON.stringify([...set], null, 2), { mode: 0o600 });
}

/** The id of our profile in a config library: prefer the durable registry,
 * fall back to the content fingerprint for pre-registry installs. */
export async function detectShimProfileId(lib, shimUrl, home) {
  const meta = await readJson(path.join(lib, "_meta.json"));
  const entries = meta?.entries ?? [];
  const written = home ? await readWrittenProfiles(home) : new Set();
  for (const entry of entries) {
    if (written.has(entry.id)) return entry.id;
  }
  for (const entry of entries) {
    const profile = await readJson(path.join(lib, `${entry.id}.json`));
    if (isShimProfile(profile, shimUrl)) return entry.id;
  }
  return null;
}

/** Never leave a shim-pointing profile applied after a backup/restore: the app
 * then opens on a dead 127.0.0.1:8799 instead of Default (claude.ai). */
async function sanitizeAppliedId(lib, shimUrl) {
  const metaPath = path.join(lib, "_meta.json");
  const meta = await readJson(metaPath);
  if (!meta?.appliedId) return;
  const applied = await readJson(path.join(lib, `${meta.appliedId}.json`));
  if (applied && !isShimProfile(applied, shimUrl)) return;
  meta.appliedId = null;
  await writeFileAtomic(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

/**
 * Device-level 3p config keys (claude_desktop_config.json — NOT the profile;
 * the profile parser rejects catalogUrl as unrecognized). Points the model
 * catalog fetch at the shim's byte-for-byte mirror.
 */
async function applyDeviceCatalogConfig(home, shimUrl) {
  const configPath = path.join(thirdPartyDir(home), "claude_desktop_config.json");
  const config = (await readJson(configPath)) ?? {};
  // No model catalog: with it enabled, the app fills picker entries with the
  // borrowed catalog ids' generic blurbs (and its validation rejects non-
  // catalog ids). Without it, entries render exactly what we write. Delete
  // leftovers from older FireConnect versions that set them — an upgrade
  // must actually turn the catalog off.
  delete config.modelCatalogEnabled;
  delete config.catalogUrl;
  // Default the picker to the 1M-context variant of the default model.
  // Effort is deliberately left unset: new conversations use the Desktop
  // app's own default, and a person's own choice per model still wins.
  config.modelPrefer1mContext = true;
  delete config.defaultModelEffort;
  await writeFileAtomic(configPath, JSON.stringify(config, null, 2));
}

/** Capture the device config keys we touch, for off to restore. */
async function backupDeviceCatalogConfig(home) {
  const config = (await readJson(path.join(thirdPartyDir(home), "claude_desktop_config.json"))) ?? {};
  const saved = {};
  for (const key of DEVICE_CATALOG_KEYS) if (key in config) saved[key] = config[key];
  return saved;
}

/** Restore the device config keys to their pre-Nexus values. */
async function restoreDeviceCatalogConfig(home, saved) {
  const configPath = path.join(thirdPartyDir(home), "claude_desktop_config.json");
  const config = (await readJson(configPath)) ?? {};
  for (const key of DEVICE_CATALOG_KEYS) {
    if (saved && key in saved) config[key] = saved[key];
    else delete config[key];
  }
  await writeFileAtomic(configPath, JSON.stringify(config, null, 2));
}

// `defaultModelEffort` stays in the snapshot list so `off` restores a user's
// pre-Nexus value (and clears the key when they had none): `on` itself
// never writes it — the Desktop app default applies while fireconnected.
const DEVICE_CATALOG_KEYS = ["modelCatalogEnabled", "catalogUrl", "modelPrefer1mContext", "defaultModelEffort", "toolSearchEnabled"];

async function fileSize(file) {
  return stat(file).then((s) => s.size, () => 0);
}

/** What the shim wrote to `errorPath` after byte `offset` (this run only). */
async function readNewErrorLog(errorPath, offset) {
  const bytes = await readFile(errorPath).catch(() => Buffer.alloc(0));
  // A log truncated since `offset` was taken is all new.
  return bytes.subarray(bytes.length >= offset ? offset : 0).toString("utf8").trim();
}

/**
 * Explain a shim that never answered, from what it logged during this run:
 * a port conflict, other crash output, or nothing at all (it exited cleanly
 * or the service never started it).
 * @param {{ port: number, newErrors: string, platform?: string }} details
 */
export function shimNotReadyMessage({ port, newErrors, platform = process.platform }) {
  const head = `The Fireworks shim did not start on 127.0.0.1:${port}.`;
  if (/EADDRINUSE/.test(newErrors)) {
    return `${head} Another program is using port ${port}. `
      + `Find it with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, quit it, then connect again.`;
  }
  if (newErrors) {
    const tail = newErrors.split("\n").slice(-8).join("\n");
    return `${head} It reported:\n${tail}\nFull log: ~/.nexus/claude-desktop/shim.err.log`;
  }
  const status = platform === "linux"
    ? `systemctl --user status ${SHIM_LABEL}`
    : `launchctl print gui/$(id -u)/${SHIM_LABEL}`;
  return `${head} It exited without an error; check the service with \`${status}\`.`;
}

/**
 * Wait until the listener on `port` proves it is our shim (HMAC over a
 * nonce with the per-install secret). Any other answer on the port — a
 * different user's process holding it — never counts as ready.
 *
 * A port conflict logged early is expected to clear: the service respawns
 * the shim (launchd waits 10 s between respawns, systemd 2 s) and a
 * previous instance may still be letting go of the port. Only a conflict
 * logged after `conflictGraceMs` is current, and that one fails at once
 * instead of waiting out the full timeout. The log is read at most once a
 * second.
 */
export async function waitForShim(port, {
  secret, errorPath, errorOffset = 0, timeoutMs = 20_000, conflictGraceMs = 10_500,
} = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let recentOffset = null;
  let lastLogRead = 0;
  for (;;) {
    if (await probeShimIdentity(port, secret)) return;
    const now = Date.now();
    if (now > deadline) {
      const newErrors = errorPath ? await readNewErrorLog(errorPath, errorOffset) : "";
      throw new Error(shimNotReadyMessage({ port, newErrors }));
    }
    if (errorPath && now - started >= conflictGraceMs) {
      if (recentOffset === null) {
        recentOffset = await fileSize(errorPath);
      } else if (now - lastLogRead >= 1000) {
        lastLogRead = now;
        if (/EADDRINUSE/.test(await readNewErrorLog(errorPath, recentOffset))) {
          throw new Error(shimNotReadyMessage({ port, newErrors: await readNewErrorLog(errorPath, errorOffset) }));
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Put the backed-up profile library back, minus Nexus's own profile, with the
 * user's later changes on top: profiles added or edited since `on` keep their
 * current contents and stay listed, and profiles the user deleted since
 * (gone from both the current listing and the current files) stay deleted.
 * With no later changes the result is the backup byte for byte. Built beside
 * the library and swapped in, so a failure leaves the current one intact.
 * @param {string} lib
 * @param {string} backup
 * @param {{ profileId?: string, meta?: { appliedId?: string|null, entries?: Array<{ id: string }> } | null, readdirFn?: typeof readdir }} options
 */
async function restoreProfileLibrary(lib, backup, { profileId, meta, readdirFn = readdir }) {
  const staged = `${lib}.nexus-restore-${Date.now()}`;
  await rm(staged, { recursive: true, force: true });
  await cp(backup, staged, { recursive: true });
  try {
    let current = [];
    try {
      current = await readdirFn(lib, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of current) {
      if (entry.name === "_meta.json" || entry.name === `${profileId}.json`) continue;
      const from = path.join(lib, entry.name);
      const to = path.join(staged, entry.name);
      if (entry.isFile()) {
        const before = await readFile(to).catch(() => null);
        const now = await readFile(from);
        if (before && before.equals(now)) continue;
      }
      await rm(to, { recursive: true, force: true });
      await cp(from, to, { recursive: true });
    }
    const backupMeta = await readJson(path.join(staged, "_meta.json"));
    const later = new Map((meta?.entries ?? []).filter((entry) => entry.id !== profileId).map((entry) => [entry.id, entry]));
    // `on` carries every listed profile over, so a backup entry missing from
    // a readable current listing was deleted by the user. An unreadable
    // listing proves nothing, and the backup is kept whole.
    const currentFiles = new Set(current.map((entry) => entry.name));
    const deleted = (entry) => Array.isArray(meta?.entries) && !later.has(entry.id) && !currentFiles.has(`${entry.id}.json`);
    const backupEntries = (backupMeta?.entries ?? []).filter((entry) => !deleted(entry));
    for (const entry of backupMeta?.entries ?? []) {
      if (deleted(entry)) await rm(path.join(staged, `${entry.id}.json`), { force: true });
    }
    const entries = [
      ...backupEntries.map((entry) => later.get(entry.id) ?? entry),
      ...[...later.values()].filter((entry) => !backupEntries.some((old) => old.id === entry.id)),
    ];
    const listed = new Set(entries.map((entry) => entry.id));
    const appliedId = meta?.appliedId === null
      ? null
      : meta?.appliedId !== profileId && listed.has(meta?.appliedId)
        ? meta.appliedId
        : backupMeta?.appliedId !== profileId && listed.has(backupMeta?.appliedId)
          ? backupMeta.appliedId
          : null;
    if (JSON.stringify(entries) !== JSON.stringify(backupMeta?.entries ?? []) || appliedId !== backupMeta?.appliedId) {
      await writeFileAtomic(
        path.join(staged, "_meta.json"),
        JSON.stringify({ ...backupMeta, appliedId, entries }, null, 2),
        { mode: 0o600 },
      );
    }
    const old = `${lib}.nexus-old-${Date.now()}`;
    let movedOld = false;
    try {
      await rename(lib, old);
      movedOld = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(staged, lib);
    } catch (error) {
      if (movedOld) await rename(old, lib).catch(() => {});
      throw error;
    }
    if (movedOld) await rm(old, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function backupConfigLibrary(home, log, { shimUrl } = {}) {
  const lib = configLibraryDir(home);
  try { await stat(lib); } catch { return null; }
  const dest = path.join(backupDir(home), `configLibrary-${Date.now()}`);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(lib, dest, { recursive: true });
  // Never bake a shim-pointing appliedId into a backup: off restores the
  // backup wholesale, and a stale shim appliedId would leave the app on a
  // dead gateway instead of Default.
  if (shimUrl) await sanitizeAppliedId(dest, shimUrl);
  printBody("Backed up your previous Desktop setup (undo restores it).");
  return dest;
}

/**
 * Enable the profile lane: start the shim service, write the 3p profile,
 * migrate sessions. Idempotent; pre-existing profiles are backed up first.
 */
export async function enableProfileLane(home, {
  allowSystemChanges = true,
  port = SHIM_DEFAULT_PORT,
  model,
  log = (line) => console.log(line),
} = {}) {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
    throw new Error("Claude Desktop support requires macOS or Linux.");
  }
  const key = await resolveFireworksKeyWithSource({ home });
  if (!key.key) throw new Error("No Fireworks credential found. Run `nexus login` or set FIREWORKS_API_KEY first.");
  if (key.source === "env") {
    throw new Error(
      "The Fireworks key comes from FIREWORKS_API_KEY in this shell only. "
      + "Run `nexus login --api-key <key>` so the shim service can use a stored credential.",
    );
  }
  // Same stop as every other `on`: never bake a saved key the gateway
  // rejects into the profile or the shim (a dead key would 401 every turn).
  await assertResolvedKeyNotRejected(key.key, { harnessId: "claude-desktop" });

  const dataDir = claudeDesktopDataDir(home);
  await mkdir(dataDir, { recursive: true });
  const shimUrl = `http://127.0.0.1:${port}`;

  // Full serverless line-up: auto plus one picker entry per -latest router
  // alias, paired with a unique signed-catalog id (tier-matched when the pool
  // allows) so every entry gets descriptions and an effort menu.
  const { models, modelMap } = await loadDesktopLineup({
    apiKey: key.key,
    signedCatalogPath: path.join(dataDir, "catalog", "catalog.json"),
  });
  printBody("Setting up Fireworks for Claude Desktop…");

  const storedCustomModels = await readManualModels(home);
  // FireRouter customs added by an earlier release are dropped, not
  // re-registered: FireRouter selections are retired (see model admission).
  const customModels = storedCustomModels.filter((m) => !isFirerouterModelPattern(m?.shortId ?? ""));
  if (customModels.length !== storedCustomModels.length) {
    await writeManualModels(home, customModels);
  }
  if (model) {
    const pair = await customModelEntry(home, model, { usedNames: models.map((m) => m.name) });
    if (!pair) throw new Error(`Unknown serverless model: ${model} (see: nexus model list)`);
    if (!customModels.some((m) => m.shortId === pair.shortId)) {
      customModels.push({ shortId: pair.shortId, name: pair.entry.name, label: pair.entry.labelOverride, tier: pair.entry.anthropicFamilyTier });
      await writeManualModels(home, customModels);
    }
  }

    const stateModelMap = {
    ...modelMap,
    models: { ...(modelMap.models ?? {}), ...Object.fromEntries(customModels.map((m) => [m.name, m.shortId])) },
  };
  await writeFileAtomic(shimStatePath(home), JSON.stringify({ port, modelMap: stateModelMap }, null, 2));
  // Before the service starts, so the shim can prove itself on first probe.
  const shimSecret = await ensureShimSecret(dataDir);
  if (process.env.NEXUS_TEST !== "1" && allowSystemChanges) {
    const entry = preferDataDirPath(fileURLToPath(new URL("shim.mjs", import.meta.url)));
    const servicePath = shimServicePath(home);
    const firstInstall = await stat(servicePath).then(() => false, () => true);
    const errorPath = path.join(dataDir, "shim.err.log");
    const errorOffset = await fileSize(errorPath);
    try {
      await mkdir(path.dirname(servicePath), { recursive: true });
      await writeFileAtomic(servicePath, buildShimServiceFile({
        nodeExec: process.execPath,
        entry,
        home,
        ...shimTrustOptions(),
        label: SHIM_LABEL,
        logPath: path.join(dataDir, "shim.log"),
        errorPath,
      }));
      await retireLegacyShimAgent(home, { allowSystemChanges }).catch(() => {});
      await startShimService(servicePath, { allowSystemChanges, label: SHIM_LABEL });
      await waitForShim(port, { secret: shimSecret, errorPath, errorOffset });
    } catch (error) {
      // No profile state is written yet, so `off` would not know to remove
      // a service this run installed; undo it here (e.g. no systemd user
      // session over SSH). A pre-existing service is left for `off`.
      if (firstInstall) {
        await stopShimService({ allowSystemChanges, label: SHIM_LABEL, unitPath: servicePath }).catch(() => {});
        await rm(servicePath, { force: true });
      }
      throw error;
    }
  }

  // Names only (profile-state and the summary); syncProfileConnectors below
  // is what lands connectors and their OAuth clients in the profile.
  // Unmigratable entries (relay URLs, claude.ai-hosted without a client) are
  // only detected so sync can report them as skipped — they are not connectors.
  const connectors = (await detectConnectors(home)).filter((e) => !isUnmigratable(e));

  const lib = configLibraryDir(home);
  const existing = await readJson(path.join(lib, "_meta.json"));
  const priorState = await readProfileState(home);
  // Our profile is recognized by content (shim fingerprint) and the durable
  // registry, not only by profile-state: older installs may carry a stale
  // Fireworks profile with no state file. Adopting its id means a re-on
  // UPDATES it in place instead of duplicating.
  const shimProfileId = await detectShimProfileId(lib, shimUrl, home);
  const profileId = priorState?.profileId ?? shimProfileId ?? randomUUID();
  const appliedIsOurs = existing?.appliedId === profileId;
  // A repeat on must not wipe the path to the user's pre-Nexus profiles.
  const backup = appliedIsOurs
    ? (priorState?.backup ?? null)
    : existing
      ? await backupConfigLibrary(home, log, { shimUrl })
      : null;

  await mkdir(lib, { recursive: true });
  // Connectors: preserve what the applied profile already has; when it has
  // none (first on, or off deleted it), restore from the durable store so an
  // off/on cycle keeps the user's mcp add/sync setup.
  const durableStore = await readConnectorStore(home);
  const priorProfile = await readJson(path.join(lib, `${profileId}.json`));
  const profileServers = priorProfile?.managedMcpServers;
  const existingServers = Array.isArray(profileServers) ? profileServers : durableStore.servers;
  await writeFileAtomic(path.join(lib, `${profileId}.json`), JSON.stringify(buildProfile({
    shimUrl, apiKey: key.key, models, existingServers, customModels,
    coworkEgressAllowedHosts: egressHosts(priorProfile, await readJson(egressStorePath(home))),
  }), null, 2), { mode: 0o600 });

  const entries = (existing?.entries ?? []).filter((e) => e.id !== profileId);
  entries.push({ id: profileId, name: "Fireworks" });
  await writeFileAtomic(path.join(lib, "_meta.json"), JSON.stringify({ appliedId: profileId, entries }, null, 2), { mode: 0o600 });
  await rememberWrittenProfile(home, profileId);

  // Recapture only when there is no prior snapshot — a repeat on would
  // otherwise back up Nexus's own keys and off would restore them.
  const deviceBackup = priorState?.deviceBackup ?? (await backupDeviceCatalogConfig(home));
  await applyDeviceCatalogConfig(home, shimUrl);
  await markHarnessEnabled(home);

  const migrated = await migrateSkillsPlugin(home, { log });
  if (migrated) log(`Copied ${migrated} skills/plugin file(s) into the 3p deployment.`);

  await writeFileAtomic(profileStatePath(home), JSON.stringify({
    enabled: true, lane: "profile", port, profileId, backup, deviceBackup,
    connectors: connectors.map((c) => c.name),
    excludedConnectors: priorState?.excludedConnectors ?? durableStore.excluded,
    writtenAt: new Date().toISOString(),
  }, null, 2));

  // Reconcile the freshly written profile with every detection source (session
  // files, pre-Nexus config, org registry) — this is what actually lands
  // the detected connectors; the write above only seeds/restores them.
  let synced = null;
  try {
    synced = await syncProfileConnectors(home);
  } catch (error) {
    log(`Connector sync skipped: ${error?.message ?? error}`);
  }

  if (synced?.total) printNote(`${synced.total} connector(s) are set up.`);
  for (const line of syncReportLines(synced ?? {})) printNote(line);
  if (synced) {
    // status reads state.connectors: record what actually migrated (a durable
    // OAuth client can rescue a connector detection alone cannot judge).
    const state = await readJson(profileStatePath(home));
    if (state?.connectors) {
      state.connectors = synced.migrated.map((e) => e.name);
      await writeFileAtomic(profileStatePath(home), JSON.stringify(state, null, 2));
    }
  }
  return { port, profileId, connectors: synced?.total ?? connectors.length, migrated,
    models: [...models.map((m) => m.labelOverride ?? m.name), ...customModels.map((m) => m.label)] };
}

/** Disable the profile lane: restore the backed-up profiles (or remove ours) and stop the shim. */
export async function disableProfileLane(home, {
  allowSystemChanges = true,
  log = (line) => console.log(line),
  readdirFn = readdir,
} = {}) {
  const state = await readProfileState(home);
  if (!state) { log("Desktop profile lane is not configured; nothing to do."); return; }

  const lib = configLibraryDir(home);
  const meta = await readJson(path.join(lib, "_meta.json"));
  // Snapshot the connector setup before the profile/state files go away, so a
  // later on restores it (see the durable connector store).
  try {
    const profile = state.profileId ? await readJson(path.join(lib, `${state.profileId}.json`)) : null;
    await persistConnectorStore(home, { servers: profile?.managedMcpServers, excluded: state.excludedConnectors });
    const hosts = userEgressHosts(profile);
    if (hosts) await writeFileAtomic(egressStorePath(home), JSON.stringify(hosts, null, 2));
    else await rm(egressStorePath(home), { force: true });
  } catch { /* best effort — the store may already hold the latest writes */ }
  await restoreDeviceCatalogConfig(home, state.deviceBackup).catch((error) => log(`Device config restore skipped: ${error?.message ?? error}`));
  if (state.backup) {
    // Restore the pre-fireconnect profiles, keeping what the user changed
    // since — except a backup whose appliedId points at a shim profile (older
    // installs) would leave the app on the now-dead gateway. Fall back to
    // Default in that case.
    await restoreProfileLibrary(lib, state.backup, { profileId: state.profileId, meta, readdirFn });
    await sanitizeAppliedId(lib, `http://127.0.0.1:${state.port ?? SHIM_DEFAULT_PORT}`);
    log("Restored the Desktop setup you had before.");
  } else if (meta?.appliedId === state.profileId) {
    await rm(path.join(lib, `${state.profileId}.json`), { force: true });
    const entries = (meta.entries ?? []).filter((e) => e.id !== state.profileId);
    await writeFileAtomic(path.join(lib, "_meta.json"), JSON.stringify({ appliedId: entries[0]?.id ?? null, entries }, null, 2), { mode: 0o600 });
    await sanitizeAppliedId(lib, `http://127.0.0.1:${state.port ?? SHIM_DEFAULT_PORT}`);
    log("Removed the Fireworks provider profile.");
  } else {
    log("The applied 3p profile is not ours; leaving profiles untouched.");
  }

  if (process.env.NEXUS_TEST !== "1" && allowSystemChanges) {
    await stopShimService({ allowSystemChanges, label: SHIM_LABEL, unitPath: shimServicePath(home) });
    await retireLegacyShimAgent(home, { allowSystemChanges }).catch(() => {});
  }
  // Only now that profiles are restored and the shim is stopped: uninstall
  // discovery reads this flag, so clearing it earlier would let a failed off
  // drop Claude Desktop (and its profile backup) from a later uninstall.
  await markHarnessEnabled(home, false);
  await rm(shimServicePath(home), { force: true });
  await rm(shimStatePath(home), { force: true });
  await rm(profileStatePath(home), { force: true });
  // Sessions are NOT migrated: each deployment keeps its own conversation
  // history. Skills/plugin assets flow one way (claude.ai -> 3p) on `on`.
  printBody("Quit and reopen Claude Desktop — you're back to your normal setup.");
}

/** Read-only profile-lane status: state + bounded shim probe. */
export async function readProfileStatus(home) {
  const state = await readProfileState(home);
  let shimHealthy = false;
  let shimUnverified = false;
  if (state?.port) {
    // Healthy only when the listener proves it is our shim: any process can
    // answer on a loopback port.
    const secret = await readShimSecret(claudeDesktopDataDir(home));
    shimHealthy = await probeShimIdentity(state.port, secret, { timeoutMs: 1500 });
    // Something answers but can't prove it is our shim: a shim from before
    // this check that hasn't restarted yet, or another program on the port.
    if (!shimHealthy) {
      try {
        const res = await fetch(`http://127.0.0.1:${state.port}/`, { signal: AbortSignal.timeout(1500) });
        shimUnverified = res.ok;
      } catch { shimUnverified = false; }
    }
  }
  let appliedProfileIsOurs = false;
  const meta = await readJson(path.join(configLibraryDir(home), "_meta.json"));
  if (state?.profileId && meta?.appliedId === state.profileId) appliedProfileIsOurs = true;
  return { state, shimHealthy, shimUnverified, appliedProfileIsOurs };
}
