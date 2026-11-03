/-
Formal model of the OpenCode effort repair in
`lib/harnesses/opencode/core.mjs`: `withOpencodeReasoningEffort`, which marks
the Auto row `reasoning: true`, and the Auto carry-over an online catalog
refresh applies before it.

A row is modeled by the facts both read: whether it is a row the repair
may mark (canonical Auto, a reasoning-table model, or a catalog-missing
row Nexus itself authors — a remapped `id` makes it something else), each effort control the
user can set (`reasoning`, `reasoning_options`, `variants`) as absent,
loadable or malformed, and the row's own SDK. The refresh re-renders the
row from the catalog: it keeps loadable controls, drops malformed ones and
the row-level `provider`, and the rebuilt row is a markable row again.

Proved here: the repair is idempotent; a row with any user-set control,
another SDK, or a remap is left as written; its only write is
`reasoning := true`; a refresh never turns a row with a loadable control
into one the repair changes. The authored marking path
(`withAuthoredOpencodeReasoningEffort`) shares this same repair shape;
its wider row predicate, the v2 mirror, and migration gating are not
modeled here.
JS tests: `test/harnesses/opencode/opencode-effort.test.mjs`.
-/
namespace Nexus.OpencodeReasoningEffort

/-- The SDK OpenCode builds effort variants for. -/
def compatible : String := "@ai-sdk/openai-compatible"

inductive Setting where
  | absent
  | loadable
  | malformed
  deriving DecidableEq, Repr

structure Row where
  markable : Bool
  reasoning : Setting
  reasoningOptions : Setting
  variants : Setting
  rowNpm : Option String
  deriving DecidableEq, Repr

/-- OpenCode's SDK precedence: the row's `provider.npm`, then the
provider's `npm`, then models.dev (openai-compatible for fireworks-ai). -/
def sdk (r : Row) (providerNpm : Option String) : String :=
  (r.rowNpm <|> providerNpm).getD compatible

/-- A user-set effort control, loadable or not. -/
def hasControl (r : Row) : Bool :=
  r.reasoning != .absent || r.reasoningOptions != .absent || r.variants != .absent

def eligible (providerNpm : Option String) (r : Row) : Bool :=
  r.markable && !hasControl r && sdk r providerNpm == compatible

/-- Mirrors `withOpencodeReasoningEffort`; `reasoning: true` is a loadable value. -/
def repair (providerNpm : Option String) (r : Row) : Row :=
  if eligible providerNpm r then { r with reasoning := .loadable } else r

/-- Mirrors the Auto carry-over in `buildModels` on an online refresh. -/
def keep : Setting → Setting
  | .loadable => .loadable
  | _ => .absent

def rebuild (r : Row) : Row :=
  { markable := true, reasoning := keep r.reasoning, reasoningOptions := keep r.reasoningOptions,
    variants := keep r.variants, rowNpm := none }

theorem repair_keeps_controls (p : Option String) (r : Row) (h : hasControl r = true) :
    repair p r = r := by
  simp [repair, eligible, h]

theorem repaired_has_control (p : Option String) (r : Row) (h : eligible p r = true) :
    hasControl (repair p r) = true := by
  simp [repair, h, hasControl]

/-- Re-running `on` or `nexus update` is a fixed point. -/
theorem repair_idempotent (p : Option String) (r : Row) :
    repair p (repair p r) = repair p r := by
  by_cases h : eligible p r = true
  · exact repair_keeps_controls p (repair p r) (repaired_has_control p r h)
  · simp [repair, h]

theorem repair_keeps_remaps (p : Option String) (r : Row) (h : r.markable = false) :
    repair p r = r := by
  simp [repair, eligible, h]

theorem repair_keeps_other_sdk (p : Option String) (r : Row) (h : sdk r p ≠ compatible) :
    repair p r = r := by
  simp [repair, eligible, h]

/-- The only write is `reasoning := true`, and only where it was unset. -/
theorem repair_only_sets_reasoning (p : Option String) (r : Row) :
    repair p r = r ∨ (r.reasoning = .absent ∧ repair p r = { r with reasoning := .loadable }) := by
  by_cases h : eligible p r = true
  · right
    refine ⟨?_, by simp [repair, h]⟩
    cases hr : r.reasoning <;> simp_all [eligible, hasControl]
  · left
    simp [repair, h]

/-- A refresh keeps a loadable control, so the repair leaves the rebuilt row alone. -/
theorem refresh_keeps_loadable_control (p : Option String) (r : Row)
    (h : r.reasoning = .loadable ∨ r.reasoningOptions = .loadable ∨ r.variants = .loadable) :
    repair p (rebuild r) = rebuild r := by
  apply repair_keeps_controls
  rcases h with h | h | h <;> simp [hasControl, rebuild, keep, h]

/-- Malformed controls don't survive a refresh: the rebuilt row has none. -/
theorem refresh_drops_malformed (r : Row)
    (h : r.reasoning ≠ .loadable ∧ r.reasoningOptions ≠ .loadable ∧ r.variants ≠ .loadable) :
    hasControl (rebuild r) = false := by
  obtain ⟨h1, h2, h3⟩ := h
  cases hr : r.reasoning <;> cases ho : r.reasoningOptions <;> cases hv : r.variants <;>
    simp_all [hasControl, rebuild, keep]

def generated : Row :=
  { markable := true, reasoning := .absent, reasoningOptions := .absent, variants := .absent, rowNpm := none }

/-- Spot checks: the generated row is flagged; custom variants,
`reasoning_options`, an opt-out, a remap and another SDK are not; a refresh
keeps loadable `reasoning_options` and drops malformed `variants`. -/
theorem spot_checks :
    (repair none generated).reasoning = .loadable
    ∧ repair none { generated with variants := .loadable } = { generated with variants := .loadable }
    ∧ repair none { generated with reasoningOptions := .loadable } = { generated with reasoningOptions := .loadable }
    ∧ repair none { generated with reasoning := .loadable } = { generated with reasoning := .loadable }
    ∧ repair none { generated with variants := .malformed } = { generated with variants := .malformed }
    ∧ repair none { generated with markable := false } = { generated with markable := false }
    ∧ repair (some "example-adapter") generated = generated
    ∧ repair none (rebuild { generated with reasoningOptions := .loadable })
        = rebuild { generated with reasoningOptions := .loadable }
    ∧ (repair none (rebuild { generated with variants := .malformed })).reasoning = .loadable := by
  native_decide

end Nexus.OpencodeReasoningEffort
