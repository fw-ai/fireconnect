import path from "node:path";

const DATA_DIR_RELATIVE = ".nexus/claude-desktop";

export function claudeDesktopDataDir(home) {
  return path.join(home, DATA_DIR_RELATIVE);
}

// Rendered by `on` and `help claude-desktop`; the README mirrors it verbatim.
export const LIMITED_NOTE = "Limited: while Nexus is on, Claude Desktop opens a new local workspace without your chats, "
  + "and each imported connector needs a one-time re-auth. To return to your main workspace, run "
  + "`nexus claude-desktop off` and reopen Claude Desktop. Nothing is lost. For the fullest experience, "
  + "use Claude Code, Codex, or the ChatGPT desktop app.";

// Rendered by `on` and `help claude-desktop`; the README table mirrors it verbatim.
export const WORKSPACE_NOTES = [
  "Third-party mode does not show your claude.ai chats, projects, artifacts, memory, or scheduled tasks. Nothing is deleted, and `off` brings them back.",
  "New chats, projects, artifacts, and memory are saved only on this computer. They don't appear on claude.ai web or mobile and can't be shared.",
  "Skills and plugins are copied over on `on`. Run `on` again to copy ones you add later.",
  "Cowork and Chat can reach any website. To limit that, set Allowed egress hosts in Developer → Configure Third-Party Inference; `on` keeps your list.",
];
