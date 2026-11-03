/-
Formal model of serverless pricing tiers: `flatModeTier` and the bare-id
pricing gate in `lib/fireworks/models.mjs`, and `pricingMatchesModelRefTier`
in `lib/fireworks/model-specs.mjs`.

`requiresFastTierPricing` is a suffix heuristic, so the matcher takes its
result as the `wantsFast` argument instead of modelling it.
-/
namespace Nexus.ServerlessTier

/-- `flatModeTier`: only an absent or `"standard"` mode is the standard tier. -/
def flatModeTier (mode : String) : String :=
  if mode == "" || mode == "standard" then "standard" else mode

/-- A catalog row writes its rates under the bare model id only when its tier
is standard (`tier === "standard" && rates`). -/
def pricesBareId (mode : String) : Bool :=
  flatModeTier mode == "standard"

/-- The bare model id is only ever priced from a standard row. -/
theorem pricesBareId_only_standard (mode : String) :
    pricesBareId mode = true → mode = "" ∨ mode = "standard" := by
  unfold pricesBareId flatModeTier
  by_cases h : (mode == "" || mode == "standard") = true
  · intro _
    simpa [Bool.or_eq_true, beq_iff_eq] using h
  · simp only [h]
    intro hm
    exact absurd (by simp [beq_iff_eq] at hm ⊢; exact Or.inr hm) h

/-- `pricingMatchesModelRefTier` for a short ref and a cached pricing tier.
`""` stands for an absent tier, which JS treats like standard. -/
def pricingMatches (ref : String) (wantsFast : Bool) (tier : String) : Bool :=
  if tier == "priority" then false
  else if ref.endsWith "-spot" then tier == "spot"
  else if tier != "" && tier != "standard" && tier != "fast" then ref.endsWith ("-" ++ tier)
  else if wantsFast then tier == "fast" else tier != "fast"

/-- A `*-spot` ref only accepts spot pricing. -/
theorem spot_ref_only_spot (ref tier : String) (wantsFast : Bool)
    (hspot : ref.endsWith "-spot" = true) :
    pricingMatches ref wantsFast tier = true → tier = "spot" := by
  unfold pricingMatches
  by_cases hp : (tier == "priority") = true
  · simp [hp]
  · simp [hp, hspot]

/-- A mode tier (anything but absent, standard, fast, priority) never prices a ref
that does not end in `-<tier>`: spot rates can't leak onto a standard id. -/
theorem mode_tier_needs_suffix (ref tier : String) (wantsFast : Bool)
    (hnone : tier ≠ "") (hstd : tier ≠ "standard") (hfast : tier ≠ "fast")
    (hsuffix : ref.endsWith ("-" ++ tier) = false) :
    pricingMatches ref wantsFast tier = false := by
  unfold pricingMatches
  by_cases hp : (tier == "priority") = true
  · simp [hp]
  · by_cases hs : ref.endsWith "-spot" = true
    · simp only [hp, hs, if_false, if_true, Bool.false_eq_true]
      by_cases ht : tier = "spot"
      · subst ht; simp [hs] at hsuffix
      · simpa [beq_iff_eq] using ht
    · simp [hp, hs, hnone, hstd, hfast, hsuffix]

theorem tier_spot :
    flatModeTier "" = "standard" ∧
    flatModeTier "standard" = "standard" ∧
    flatModeTier "fast" = "fast" ∧
    flatModeTier "spot" = "spot" ∧
    flatModeTier "ultrafast" = "ultrafast" ∧
    pricesBareId "spot" = false := by native_decide

theorem matches_spot :
    pricingMatches "example-model-spot" false "spot" = true ∧
    pricingMatches "example-model-spot" false "standard" = false ∧
    pricingMatches "example-model" false "spot" = false ∧
    pricingMatches "example-latest" false "spot" = false ∧
    pricingMatches "example-model-ultrafast" false "ultrafast" = true ∧
    pricingMatches "example-model" false "ultrafast" = false ∧
    pricingMatches "example-fast" true "fast" = true ∧
    pricingMatches "example-latest" false "standard" = true ∧
    pricingMatches "example-latest" false "" = true ∧
    pricingMatches "example-fast" true "" = false ∧
    pricingMatches "example-latest" false "priority" = false := by native_decide

end Nexus.ServerlessTier
