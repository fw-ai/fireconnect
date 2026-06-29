# Claude Code pricing estimates vs Fireworks billing

When FireConnect routes Claude Code through Fireworks, **inference is billed at Fireworks
serverless rates**. The cost numbers Claude Code shows in `/model` and in session estimates are
often **much higher** because Claude Code uses Anthropic list prices, not Fireworks pricing.

This page explains the discrepancy, what to trust, and how FireConnect helps.

## What you may see in Claude Code

With the default FireConnect mapping (`glm-latest` on `main` and `opus`), Claude Code typically
labels the active model as an **Opus-tier** entry (for example “Custom Opus model (1M context)”)
and may show rates like **$5 / $25 per million tokens** (input / output).

Those figures come from Claude Code’s **built-in Anthropic tier table**. Claude Code does not
read Fireworks pricing from the API and has no setting to override the `/model` price column for
third-party gateways.

## What Fireworks actually charges

Fireworks bills per token at **model-specific serverless rates**. For the default `glm-latest`
router (currently GLM 5.2 on standard serverless), list pricing is approximately:

| | Per 1M tokens (USD) |
|---|--:|
| Input | $1.40 |
| Cached input | $0.26 |
| Output | $4.40 |

See the live table: [Fireworks serverless pricing](https://docs.fireworks.ai/serverless/pricing).

**Ground truth for spend:**

- Fireworks [billing / usage dashboard](https://app.fireworks.ai/account/billing)
- The `usage` object on each inference response (`prompt_tokens`, `completion_tokens`)
- `firectl billing get-usage` (group by `model_name`)

Claude Code’s UI estimate can be **several times higher** than actual Fireworks cost for the same
traffic. That is a **display issue only** — not incorrect Fireworks billing.

## How FireConnect surfaces Fireworks rates

FireConnect cannot change Claude Code’s price column. It adds Fireworks pricing everywhere it
controls configuration and CLI output:

### `fireconnect claude status`

Shows your alias mapping with **Fireworks in / cached / out per Mtok** for each configured slot,
plus a note that Claude Code estimates use Anthropic list prices.

```bash
fireconnect claude status
fireconnect claude status --json   # includes a `pricing` object per slot
```

### `fireconnect claude model list`

Adds an **IN / OUT** column (USD per 1M tokens, standard serverless) when browsing the catalog.
JSON output includes `pricing` metadata per model where rates are known.

```bash
fireconnect claude model list
fireconnect claude model list --search glm
```

### Custom model description in `/model`

FireConnect writes `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION` in `~/.claude/settings.json` with
Fireworks rates for your **main** model. That text appears as the **subtitle** on the custom
picker entry at the bottom of `/model` — not in the price column.

The description is refreshed when you run:

- `fireconnect claude on`
- `fireconnect claude model select`
- `fireconnect claude model reset`

If you change only `sonnet`, `haiku`, or another non-`main` slot, the custom description still
reflects **`main`** (same as `ANTHROPIC_CUSTOM_MODEL_OPTION`).

Changing models only inside Claude Code (`/model`) does **not** update the description until you
run one of the FireConnect commands above.

## Version-tracking routers (`glm-latest`)

`glm-latest` is a stable router ID. Fireworks can retarget it to a newer GLM release without you
changing Claude Code settings.

| | Router (`glm-latest`) | Pinned model (`glm-5p2`) |
|---|----------------------|--------------------------|
| Model version | Follows Fireworks “latest” | Fixed |
| Billing | Whatever the router serves | Always `glm-5p2` rates |
| FireConnect CLI rates | Mapped from a maintained alias table | Direct lookup |

When Fireworks ships a new GLM and retargets the router, **billing updates immediately**; FireConnect’s
displayed rates update when we publish a new CLI release with refreshed pricing data. For unknown
models, FireConnect falls back to a link to the [pricing docs](https://docs.fireworks.ai/serverless/pricing).

## Quick reference

| Source | Trust for Fireworks cost? |
|--------|---------------------------|
| Claude Code `/model` price column | No — Anthropic tier estimates |
| Claude Code session cost estimate | No — same hardcoded tiers |
| Custom model **description** (FireConnect) | Yes for list rates on known models |
| `fireconnect claude status` / `model list` | Yes for list rates on known models |
| Fireworks billing dashboard | Yes — actual spend |
| Inference `usage` tokens × pricing table | Yes — for estimates |

## Related

- [FireConnect README](../README.md) — setup and model commands
- [Fireworks serverless pricing](https://docs.fireworks.ai/serverless/pricing)
