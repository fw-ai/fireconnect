/- Formal model of the explicit creation-origin allowlist in mintedKeyName.
   Hostname normalization is covered by JavaScript tests; these names take
   an already normalized hostname. -/
namespace Nexus.KeyOrigin

def origin (client : String) : String :=
  if client = "desktop" then "desktop" else "cli"

def keyName (client host : String) : String :=
  "nexus-" ++ origin client ++ "-" ++ host

theorem origin_is_cli_or_desktop (client : String) :
    origin client = "cli" ∨ origin client = "desktop" := by
  unfold origin
  split <;> simp_all

theorem desktop_requires_explicit_signal (client : String) :
    origin client = "desktop" ↔ client = "desktop" := by
  unfold origin
  split <;> simp_all

theorem name_spots :
    keyName "cli" "example-host" = "nexus-cli-example-host" ∧
    keyName "desktop" "example-host" = "nexus-desktop-example-host" ∧
    keyName "unknown" "example-host" = "nexus-cli-example-host" := by
  native_decide

end Nexus.KeyOrigin
