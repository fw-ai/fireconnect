# Nexus CLI development

See the [repository README](../../README.md) for usage.

## API key creation labels

Browser and SSO sign-in name newly created keys `nexus-cli-{hostname}` by
default. Nexus desktop integrations that invoke this CLI must explicitly set
`NEXUS_CLIENT=desktop` in the subprocess environment to create keys named
`nexus-desktop-{hostname}`. Set it only for that subprocess, not globally in the
user's shell. Unset or unrecognized values default to `cli`.

These names identify creation origin, not subsequent usage: keys can be shared
or copied between clients. Existing keys and pasted/imported keys are not
renamed. This setting does not create separate credential stores for CLI and
desktop. If the hostname is empty, the label uses `unknown-host`.
