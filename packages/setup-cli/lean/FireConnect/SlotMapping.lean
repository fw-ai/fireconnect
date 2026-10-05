/-
Formal model of tier-slot override merging in
`lib/harnesses/claude/activation.mjs` (`resolveClaudeActivationPlan`) and
`lib/harnesses/claude/connect.mjs` (`claudeSlotOverridesFromCtx`).

A tier slot is either pinned to a Fireworks model id (`some id`) or left on
Claude's own default (`none`, the `native` / `claude-default` sentinel in JS).
Each override source maps a slot to `none` (flag absent — keep the lower
precedence level) or `some v` (flag present — win, where `v = none` is an
explicit `native` unpin). Precedence, lowest to highest: defaults < saved
profile < live settings < CLI flags. `--model` is picker-only and never feeds
the merge; `main` is not a tier slot and is left out of the mapping entirely.
-/
namespace FireConnect.SlotMapping

inductive TierSlot where
  | opus
  | sonnet
  | haiku
  | fable
  | subagent
  deriving DecidableEq, Repr

/-- Slot value: `none` = native (Claude default), `some id` = pinned model. -/
abbrev SlotValue := Option String

/-- One merge source: `none` = flag absent, `some v` = explicit flag value. -/
abbrev Override := TierSlot → Option SlotValue

/-- A full tier mapping. -/
abbrev Mapping := TierSlot → SlotValue

/-- All-native defaults (`defaultClaudeModelMapping` for standard keys). -/
def defaults : Mapping := fun _ => none

/-- One merge step: an explicit flag wins, an absent flag keeps the base. -/
def mergeOne (base : Mapping) (over : Override) : Mapping :=
  fun slot => match over slot with
    | none => base slot
    | some v => v

/-- Full precedence chain: saved profile < live settings < CLI flags. -/
def resolve (saved live flags : Override) : Mapping :=
  mergeOne (mergeOne (mergeOne defaults saved) live) flags

/-- An absent flag keeps the lower-precedence value. -/
theorem mergeOne_absent (base : Mapping) (over : Override) (slot : TierSlot)
    (h : over slot = none) : mergeOne base over slot = base slot := by
  simp [mergeOne, h]

/-- An explicit flag wins over the lower-precedence value. -/
theorem mergeOne_present (base : Mapping) (over : Override) (slot : TierSlot)
    (v : SlotValue) (h : over slot = some v) : mergeOne base over slot = v := by
  simp [mergeOne, h]

/-- With no source pinning anything, every slot stays native. -/
theorem resolve_all_absent_is_native (slot : TierSlot) :
    resolve (fun _ => none) (fun _ => none) (fun _ => none) slot = none := by
  simp [resolve, mergeOne, defaults]

/-- A saved pin survives a plain re-`on` (no live edit, no flag). -/
theorem resolve_saved_pins (saved live flags : Override) (slot : TierSlot)
    (pinned : String)
    (hs : saved slot = some (some pinned))
    (hl : live slot = none)
    (hf : flags slot = none) :
    resolve saved live flags slot = some pinned := by
  simp [resolve, mergeOne, hs, hl, hf]

/-- A live edit beats the saved profile when no flag is passed. -/
theorem resolve_live_beats_saved (saved live flags : Override) (slot : TierSlot)
    (v : SlotValue)
    (hl : live slot = some v)
    (hf : flags slot = none) :
    resolve saved live flags slot = v := by
  simp [resolve, mergeOne, hl, hf]

/-- An explicit flag beats both saved and live values. -/
theorem resolve_flags_win (saved live flags : Override) (slot : TierSlot)
    (v : SlotValue)
    (h : flags slot = some v) :
    resolve saved live flags slot = v := by
  simp [resolve, mergeOne, h]

/-- Explicit `native` clears a saved pin (the reported subagent use case:
main Anthropic, subagent on Flash, then back to default with one flag). -/
theorem resolve_native_clears_saved (saved live flags : Override) (slot : TierSlot)
    (pinned : String)
    (_hs : saved slot = some (some pinned))
    (_hl : live slot = none)
    (hf : flags slot = some none) :
    resolve saved live flags slot = none := by
  simp [resolve, mergeOne, hf]

/-- Pinning one slot never disturbs another (sonnet flag, haiku untouched). -/
theorem resolve_slot_independent (saved live flags : Override)
    (hf : flags TierSlot.haiku = none)
    (hl : live TierSlot.haiku = none)
    (hs : saved TierSlot.haiku = none) :
    resolve saved live flags TierSlot.haiku = none := by
  simp [resolve, mergeOne, defaults, hs, hl, hf]

/-- Spot check mirroring the e2e test: sonnet pinned, subagent explicitly
native, everything else untouched. -/
def exFlags : Override
  | .sonnet => some (some "deepseek-flash-latest")
  | .subagent => some none
  | _ => none

theorem ex_spot :
    resolve (fun _ => none) (fun _ => none) exFlags TierSlot.sonnet =
      some "deepseek-flash-latest" ∧
    resolve (fun _ => none) (fun _ => none) exFlags TierSlot.subagent = none ∧
    resolve (fun _ => none) (fun _ => none) exFlags TierSlot.opus = none := by
  decide

/-- `--routing-preference` without `--model` implies a firerouter picker row,
but only when no tier slot pins a real model: an explicit pin opts out of the
FireRouter mix, so synthesizing firerouter there would attach a routing header
the pinned tiers ignore (the `on` guard then rejects instead). A `native` flag
normalizes to the unpinned sentinel — end-state identical to passing no flag —
so it must not block the synth. Mirrors `shouldImplyFirerouterPickerRow` in
`connect.mjs`: `prefSet` = a routing preference was passed, `mainSet` =
`--model` was passed, `slotSet` = a non-native tier pin was passed. -/
def implyFirerouterRow (prefSet mainSet slotSet : Bool) : Bool :=
  prefSet && !mainSet && !slotSet

/-- Full truth table: the synth fires in exactly one of the eight cases. -/
theorem implyFirerouterRow_table :
    implyFirerouterRow true false false = true ∧
    implyFirerouterRow true false true = false ∧
    implyFirerouterRow true true false = false ∧
    implyFirerouterRow true true true = false ∧
    implyFirerouterRow false false false = false ∧
    implyFirerouterRow false false true = false ∧
    implyFirerouterRow false true false = false ∧
    implyFirerouterRow false true true = false := by
  decide

/-- Bare `--routing-preference` implies the firerouter row. -/
theorem implyFirerouterRow_bare_preference :
    implyFirerouterRow true false false = true := by
  decide

/-- Explicit pins keep the rejection guard reachable (a pinned slot never gets
a synthesized firerouter row alongside it). -/
theorem implyFirerouterRow_slots_block :
    implyFirerouterRow true false true = false := by
  decide

/-- An explicit `--model` never gets a synthesized row either. -/
theorem implyFirerouterRow_model_blocks :
    implyFirerouterRow true true false = false := by
  decide

/-- A tier flag counts as opting out of the mix only when it pins a real
model. `native` normalizes to the unpinned sentinel (`none`), which is
end-state identical to passing no flag — so it must not block the synth.
Mirrors the pin check inside `shouldImplyFirerouterPickerRow`: only
`some (some _)` values count. -/
def hasNonNativePin (flags : Override) : Bool :=
  [TierSlot.opus, TierSlot.sonnet, TierSlot.haiku, TierSlot.fable,
    TierSlot.subagent].any fun slot => match flags slot with
      | some (some _) => true
      | _ => false

/-- `native` flags do not block the synth (an unpin is not a pin). -/
theorem native_flags_do_not_block :
    hasNonNativePin (fun s => if s = TierSlot.sonnet then some none else none) = false ∧
    hasNonNativePin (fun _ => some none) = false ∧
    hasNonNativePin (fun _ => none) = false := by
  decide

/-- A real pin blocks the synth. -/
theorem real_pin_blocks :
    hasNonNativePin (fun s => if s = TierSlot.sonnet then some (some "glm-latest") else none) = true := by
  decide

/-! ## Fire Pass merge

Fire Pass starts from curated router defaults rather than all-native, and also
merges `--model` into `main` (not a tier slot, so it is an absent override
here). The old chain stopped before the tier flags, silently dropping them;
the fixed chain merges them last, so they win like they do on standard keys. -/

/-- Every tier slot, for guards that scan the whole mapping. -/
def allSlots : List TierSlot :=
  [TierSlot.opus, TierSlot.sonnet, TierSlot.haiku, TierSlot.fable, TierSlot.subagent]

theorem mem_allSlots (slot : TierSlot) : slot ∈ allSlots := by
  cases slot <;> simp [allSlots]

/-- Pre-fix Fire Pass chain: tier flags never reach the merge. -/
def resolveFirePassOld (curated : Mapping) (saved live mainOv : Override) : Mapping :=
  mergeOne (mergeOne (mergeOne curated saved) live) mainOv

/-- Fixed Fire Pass chain: tier flags merge last (`activation.mjs`). -/
def resolveFirePass (curated : Mapping) (saved live mainOv flags : Override) : Mapping :=
  mergeOne (resolveFirePassOld curated saved live mainOv) flags

/-- An explicit tier flag wins on Fire Pass, whatever the curated defaults. -/
theorem firePass_flags_win (curated : Mapping) (saved live mainOv flags : Override)
    (slot : TierSlot) (v : SlotValue) (h : flags slot = some v) :
    resolveFirePass curated saved live mainOv flags slot = v := by
  simp [resolveFirePass, mergeOne, h]

/-- The `on` guard rejecting native slots on Fire Pass ("Claude default slots
require a Fireworks API key"). -/
def firePassRejectsNative (m : Mapping) : Bool :=
  allSlots.any fun slot => m slot == none

/-- `--<tier> native` on Fire Pass now trips the guard: it fails loudly instead
of exiting 0 with the flag ignored. -/
theorem firePass_native_flag_rejected (curated : Mapping) (saved live mainOv flags : Override)
    (slot : TierSlot) (h : flags slot = some none) :
    firePassRejectsNative (resolveFirePass curated saved live mainOv flags) = true := by
  apply List.any_eq_true.mpr
  exact ⟨slot, mem_allSlots slot, by simp [resolveFirePass, mergeOne, h]⟩

/-- The Fire Pass FireRouter guard (`claudeMappingUsesAnyFirerouter`): reject
when any slot holds a FireRouter route. `isRoute` abstracts
`isFirerouterModelPattern`, which matches bare `firerouter` and every
`firerouter/*` compound. -/
def firePassRejectsRouter (isRoute : String → Bool) (m : Mapping) : Bool :=
  allSlots.any fun slot => match m slot with
    | some id => isRoute id
    | none => false

/-- Any FireRouter tier flag on Fire Pass — bare or compound — is rejected,
because the flag wins the merge and the guard scans every slot. -/
theorem firePass_router_flag_rejected (isRoute : String → Bool) (curated : Mapping)
    (saved live mainOv flags : Override) (slot : TierSlot) (route : String)
    (h : flags slot = some (some route)) (hr : isRoute route = true) :
    firePassRejectsRouter isRoute (resolveFirePass curated saved live mainOv flags) = true := by
  apply List.any_eq_true.mpr
  exact ⟨slot, mem_allSlots slot, by simp [resolveFirePass, mergeOne, h, hr]⟩

/-- The pre-fix guard matched only bare `firerouter`, so a compound pin slipped
through (the Bugbot finding). With `isBareOnly` = exact `"firerouter"` match,
`firerouter/gpt-5p6` is not rejected by the old guard but is by the new one. -/
def isBareOnly (id : String) : Bool := id == "firerouter"
def isAnyRoute (id : String) : Bool := id == "firerouter" || id.startsWith "firerouter/"
def opusCompoundFlag : Override
  | .opus => some (some "firerouter/gpt-5p6")
  | _ => none

theorem firePass_compound_regression :
    firePassRejectsRouter isBareOnly
        (resolveFirePass (fun _ => some "kimi-fast-latest") (fun _ => none) (fun _ => none)
          (fun _ => none) opusCompoundFlag) = false ∧
    firePassRejectsRouter isAnyRoute
        (resolveFirePass (fun _ => some "kimi-fast-latest") (fun _ => none) (fun _ => none)
          (fun _ => none) opusCompoundFlag) = true := by
  native_decide

/-- The pre-fix chain ignores tier flags entirely: its result does not depend
on them (the reported Bugbot finding). -/
theorem firePassOld_ignores_flags (curated : Mapping) (saved live mainOv : Override)
    (flagsA flagsB : Override) :
    (fun _ : Override => resolveFirePassOld curated saved live mainOv) flagsA =
      (fun _ : Override => resolveFirePassOld curated saved live mainOv) flagsB := rfl

/-- Concrete regression: curated `kimi-fast-latest` everywhere plus
`--sonnet native` — the old chain kept the router (flag dropped), the fixed
chain unpins it so the guard fires. -/
def kimiCurated : Mapping := fun _ => some "kimi-fast-latest"
def sonnetNativeFlag : Override
  | .sonnet => some none
  | _ => none

theorem firePass_regression :
    resolveFirePassOld kimiCurated (fun _ => none) (fun _ => none) (fun _ => none)
        TierSlot.sonnet = some "kimi-fast-latest" ∧
    resolveFirePass kimiCurated (fun _ => none) (fun _ => none) (fun _ => none)
        sonnetNativeFlag TierSlot.sonnet = none := by
  decide

/-! ## OpenAI key attach

Mirrors `claudeMappingNeedsOpenaiKey` in `model-profile.mjs`: the key rides
along when any candidate — the /model default `on` writes, or any resolved
slot value — is bare `firerouter` or a GPT compound. `isBare` / `requiresKey`
abstract `isFirerouterModel` / `firerouterRequiresOpenaiKey`. -/

def needsOpenaiKey (isBare requiresKey : String → Bool)
    (extra : Option String) (pins : List String) : Bool :=
  (extra.toList ++ pins).any fun m => isBare m || requiresKey m

/-- A GPT compound pinned to a tier slot attaches the key (the Bugbot finding:
previously only `--model` was inspected). -/
theorem slot_gpt_compound_attaches (isBare requiresKey : String → Bool)
    (extra : Option String) (pins : List String) (m : String)
    (hm : m ∈ pins) (hk : requiresKey m = true) :
    needsOpenaiKey isBare requiresKey extra pins = true := by
  apply List.any_eq_true.mpr
  exact ⟨m, List.mem_append_right _ hm, by simp [hk]⟩

/-- With no slot pins, behavior is exactly the old `--model`-only rule, so
existing `--model firerouter[/gpt-…]` behavior is unchanged. -/
theorem extra_only_unchanged (isBare requiresKey : String → Bool) (extra : Option String) :
    needsOpenaiKey isBare requiresKey extra [] =
      (match extra with
        | none => false
        | some m => isBare m || requiresKey m) := by
  cases extra <;> simp [needsOpenaiKey]

/-- No bare router and no GPT compound anywhere: the key stays off (pinned
non-GPT compounds like `firerouter/opus` stay clean). -/
theorem clean_without_openai_route (isBare requiresKey : String → Bool)
    (extra : Option String) (pins : List String)
    (h : ∀ m ∈ extra.toList ++ pins, isBare m = false ∧ requiresKey m = false) :
    needsOpenaiKey isBare requiresKey extra pins = false := by
  rw [needsOpenaiKey, List.any_eq_false]
  intro m hm
  simp [(h m hm).1, (h m hm).2]

/-! ### The /model default candidate

Mirrors `resolveClaudeDefaultModel` in `core.mjs` for standard keys: `--model`
wins, else a saved pick the picker still serves is kept, else the implicit
FireRouter mix. The pre-fix check only saw `--model`, so a plain `on` landing
on the implicit `firerouter` default dropped the key. -/

def defaultModel (selected savedServable : Option String) : String :=
  selected.getD (savedServable.getD "firerouter")

/-- Plain `on` (no `--model`, no servable saved pick) lands on `firerouter`. -/
theorem plain_on_lands_on_firerouter : defaultModel none none = "firerouter" := rfl

/-- The regression: with the implicit default as a candidate, plain `on`
attaches the key whenever bare `firerouter` is recognized. -/
theorem plain_on_attaches (isBare requiresKey : String → Bool)
    (pins : List String) (hb : isBare "firerouter" = true) :
    needsOpenaiKey isBare requiresKey (some (defaultModel none none)) pins = true := by
  apply List.any_eq_true.mpr
  exact ⟨"firerouter", by simp [defaultModel], by simp [hb]⟩

/-- A kept saved pick replaces the implicit default, so it alone decides:
re-`on` on a saved non-router pick does not attach the key by default. -/
theorem saved_pick_decides (saved : String) :
    defaultModel none (some saved) = saved := rfl

/-- `--model` always wins as the candidate, so `--model` behavior is
unchanged by considering the default. -/
theorem selected_wins (selected : String) (savedServable : Option String) :
    defaultModel (some selected) savedServable = selected := rfl

end FireConnect.SlotMapping
