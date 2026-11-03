import { defineHarness } from "../../harness/types.mjs";
import { resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import { printHarnessConnected, printModelsAdded, printCommandHint, printBody, printInfo, printNote } from "../../cli/messages.mjs";
import { LIMITED_NOTE, WORKSPACE_NOTES } from "./core.mjs";

const LABEL = "Claude Desktop";

const adapter = defineHarness({
  id: "claude-desktop",
  label: LABEL,
  async resolveKey(ctx) {
    return (await resolveFireworksKeyWithSource({ home: ctx.home })).key;
  },
  async on(ctx) {
    if (!ctx.home) throw new Error("HOME is not set; pass --home.");
    const { enableProfileLane } = await import("./profile-lane.mjs");
    const result = await enableProfileLane(ctx.home, { model: ctx.main || undefined });
    printHarnessConnected("Claude Desktop");
    printBody("Chat, Cowork, and Code now run on Fireworks models.");
    printModelsAdded(result.models ?? []);
    printInfo(LIMITED_NOTE);
    for (const note of WORKSPACE_NOTES) printNote(note);
    printCommandHint("Quit and reopen Claude Desktop, then", "nexus claude-desktop status");
    printCommandHint("Undo", "nexus claude-desktop off");
  },
  async off(ctx) {
    // Honors ctx.quiet (uninstall narrates itself) and returns the outcome.
    const { disableProfileLane, readProfileState } = await import("./profile-lane.mjs");
    const log = ctx.quiet ? () => {} : (line) => console.log(line);
    const touched = Boolean(await readProfileState(ctx.home));
    if (touched) await disableProfileLane(ctx.home, { log });
    return touched ? "restored" : "none";
  },
  /**
   * nexus claude-desktop mcp [list]
   * nexus claude-desktop mcp add <name> <https-url> [--client-id …] [--client-secret …]
   * nexus claude-desktop mcp remove <name>
   * nexus claude-desktop mcp sync   (re-detect from sessions + the pre-Nexus deployment + the org registry)
   * The applied 3p profile is the source of truth; restart Desktop after changes.
   */
  async mcp(ctx, args = []) {
    const {
      listProfileConnectors, addProfileConnector, removeProfileConnector, syncProfileConnectors, syncReportLines,
    } = await import("./profile-lane.mjs");
    const [sub, name, url] = args;

    if (!sub || sub === "list") {
      const connectors = await listProfileConnectors(ctx.home);
      if (!connectors.length) { console.log("No connectors in the profile."); return; }
      for (const c of connectors) console.log(`  ${c.name}  ${c.url ?? c.command ?? ""}`);
      return;
    }

    if (sub === "add") {
      // The URL is optional when the connector already exists (attach an
      // OAuth client to a migrated entry without re-typing its URL).
      const existing = url ? undefined : (await listProfileConnectors(ctx.home)).find((c) => c.name === name);
      const target = url ?? existing?.url;
      if (!name || !target) {
        throw new Error("Usage: nexus claude-desktop mcp add <name> [https-url] [--client-id <id>] [--client-secret <secret>]");
      }
      // No OAuth flags + no new URL means keep the connector's client.
      const oauth = ctx.clientId
        ? { clientId: ctx.clientId, ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}) }
        : existing?.oauth;
      await addProfileConnector(ctx.home, {
        name, url: target,
        ...(oauth ? { oauth } : {}),
      });
      console.log(`Added connector "${name}" to the profile.`);
    } else if (sub === "remove") {
      if (!name) throw new Error("Usage: nexus claude-desktop mcp remove <name>");
      if (!(await removeProfileConnector(ctx.home, name))) {
        console.log(`No connector named "${name}" in the profile.`);
        return;
      }
      console.log(`Removed connector "${name}" from the profile.`);
    } else if (sub === "sync") {
      const synced = await syncProfileConnectors(ctx.home);
      console.log(`Synced ${synced.total} connector(s) into the profile.`);
      for (const line of syncReportLines(synced)) console.log(line);
    } else {
      throw new Error(`Unknown mcp subcommand: ${sub}. Use list | add | remove | sync.`);
    }
    console.log("Restart Claude Desktop to pick up the change.");
  },
  async keyInUse(ctx) {
    const { readClaudeDesktopProfileKey } = await import("./profile-lane.mjs");
    return readClaudeDesktopProfileKey(ctx.home);
  },
  async status(ctx) {
    const { readProfileStatus } = await import("./profile-lane.mjs");
    const profile = await readProfileStatus(ctx.home);
    if (!profile.state) {
      if (ctx.json === true) console.log(JSON.stringify({ enabled: false, lane: null }, null, 2));
      else console.log(`${LABEL}: not configured. Run \`nexus claude-desktop on\`.`);
      return;
    }
    if (ctx.json === true) {
      console.log(JSON.stringify({
        enabled: true, lane: "profile", port: profile.state.port,
        shimHealthy: profile.shimHealthy, shimUnverified: profile.shimUnverified, profileApplied: profile.appliedProfileIsOurs,
        connectors: profile.state.connectors ?? [],
      }, null, 2));
      return;
    }
    console.log(`${LABEL} profile lane: enabled (Chat/Cowork/Code via shim on 127.0.0.1:${profile.state.port})`);
    const shim = profile.shimHealthy ? "healthy"
      : profile.shimUnverified ? `NOT VERIFIED — something answers on port ${profile.state.port} but isn't the Nexus shim, `
        + "and Claude Desktop sends your Fireworks key to that port. Quit Claude Desktop, then run `nexus claude-desktop on`"
        : "NOT RESPONDING";
    console.log(`  Shim: ${shim}`);
    console.log(`  Profile applied: ${profile.appliedProfileIsOurs ? "yes" : "no — restart Claude Desktop or check Setup"}`);
    console.log(`  Connectors migrated: ${(profile.state.connectors ?? []).join(", ") || "none detected"}`);
  },
});

export default adapter;
