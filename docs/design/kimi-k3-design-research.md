# Kimi K3 and the OverClick design system — research (OCL-113)

> Research, not implementation. Scope: what Kimi K3 actually is (capability,
> context, price, as of August 2026), how this codebase already wires it into
> the harness/pricing layer, and how that wiring lines up against
> [`system/`](./system/) (OCL-81, the canonical design doctrine) and its own
> [implementation review](./review-2026-08-19.md). Every claim below is either
> a citation to a public source or a file:line in this repo; nothing is
> estimated.

## 1. What Kimi K3 is

Moonshot AI announced Kimi K3 on 2026-07-16 and shipped open weights on
2026-07-27. It is a 2.8-trillion-parameter model — the first open-weight model
in the 3T class — built on Kimi Delta Attention (a hybrid linear-attention
mechanism with a fixed-size recurrent state instead of per-token KV storage)
plus Attention Residuals, with native multimodal input (text, image, video)
and a 1,048,576-token context window
([Kimi tech blog](https://www.kimi.ai/blog/kimi-k3);
[Bloomberg](https://www.bloomberg.com/news/articles/2026-07-27/what-is-moonshot-ai-s-kimi-k3-model-and-why-is-it-making-waves)).

Relevant to design/frontend work specifically, Moonshot's own writeup claims
the model:

- sustains long agentic coding sessions, navigates large repositories and
  orchestrates terminal tools (long-horizon coding, not single-shot);
- combines its multimodal input with coding to go from screenshots/video to
  working UI, calling out "game dev, frontend, and CAD" by name;
- produces motion design, animation and dashboard/infographic-style output.

Two limitations are named in the same source: "sensitivity to thinking
history" and "excessive proactiveness" when user intent is ambiguous — the
model tends to fill gaps with its own decisions rather than ask or stop.

**Coding agent.** Kimi Code CLI is a real, separate, MIT-licensed TypeScript
terminal agent (`github.com/MoonshotAI/kimi-code`, successor to the older
`kimi-cli`) with subagents (coder/explore/plan), video-input support, and a
`/model` picker used to select K3 specifically
([MarkTechPost](https://www.marktechpost.com/2026/06/06/moonshot-ai-releases-kimi-code-cli-a-terminal-ai-coding-agent-built-in-typescript-for-next-gen-agents/);
[GitHub](https://github.com/MoonshotAI/kimi-code)). This grounds the plugin
files already shipped in this repo (`plugin/kimi.plugin.json`,
`.kimi-plugin/plugin.json`, both: *"Run the complete OverClick card workflow
from Kimi Code."*) — the target CLI for OCL-106 (marketplace nativo Kimi)
exists and is addressable, not vaporware.

**Pricing (published, August 2026).** Two distinct products are on the
market and are priced differently:

| Model | Cache-miss input | Cache-hit input | Output | Source |
|---|---|---|---|---|
| Kimi K3 (flagship, native API) | $3.00/Mtok | $0.30/Mtok | $15.00/Mtok | [kimi.ai pricing](https://www.kimi.ai/resources/kimi-k3-pricing) |
| Kimi K3 (OpenRouter aggregate) | $2.60/Mtok | $0.29/Mtok (cache read) | $13.00/Mtok | [OpenRouter](https://openrouter.ai/moonshotai/kimi-k3) |
| Kimi For Coding (K2.7 Code, standard) | $0.95/Mtok | $0.19/Mtok | $4.00/Mtok | pricing survey, Aug 2026 |
| Kimi For Coding (K2.7 Code, high-speed) | $0.95/Mtok | $0.19/Mtok | $8.00/Mtok | pricing survey, Aug 2026 |

Kimi For Coding also ships flat monthly membership tiers ($19/$39/$99/$199,
cheaper annually) for terminal/IDE use without per-token billing. K3's
context window is 1,048,576 tokens with up to ~974,842 tokens of output
headroom in the same window.

## 2. How this repo already wires Kimi K3 in

Kimi K3 is not hypothetical here — it is a registered model with three
independent integration points, found by grepping the tree for `kimi`
(29 files touch it):

- **Model catalog** — `kimi-k3` is a `tier: "top"` entry with aliases
  `["k3", "kimi-k3-max"]`
  (`packages/mcp-core/src/harness/recommend.ts:371`).
- **Effort catalog** — correctly encodes that Kimi Code's own model registry
  exposes only `max` for `k3`/`k3-256k`, and a boolean `off`/`on` thinking
  toggle for `kimi-for-coding`/`kimi-for-coding-highspeed`, sourced to
  Moonshot's own config docs (`packages/mcp-core/src/harness/efforts.ts:43-51,
  86-92`). This one is internally consistent with what this research found
  and needed no correction.
- **Pricing** — `k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed`
  are seeded rows (`packages/db/src/domain/pricing.ts:139-143`), and `kimi` /
  `kimi-code/k3` / `moonshot/k3` all alias to the `k3` row
  (`pricing.ts:64-66`).
- **Executors** — the `kimi` executor lists `["kimi-for-coding",
  "kimi-for-coding-highspeed", "k3", "k3-256k"]` as its models
  (`apps/web/src/lib/executors.ts:31-33`).
- **Prior practice** — the OCL-81 implementation review already assigned
  `kimi/k3/max` by hand as the harness for the majority of `visual_fix` work:
  OCL-83, 84, 85, 86, 90, 91, 92, 93 and 94, nine of the twelve cards opened
  by that review, all "consultado no cardápio" per its own header
  (`docs/design/review-2026-08-19.md:383-400`).

## 3. Findings

### F1 — High. Kimi K3 is proven in practice for `visual_fix` but absent from the shipped routing table

`ACTIVITY_HARNESS.visual_fix.chain` is `["opus-5", "fable-5", "gpt-5.6-sol"]`
(`packages/mcp-core/src/harness/recommend.ts:253-258`). `showpiece` reads the
same three (`recommend.ts:247-252`), and so do `publish`, `page_copy`,
`docs`, `rfc`, `review` and — notably — `research` itself
(`recommend.ts:259-324`). **Kimi K3 does not appear in a single chain in the
shipped table**, even though it is a registered top-tier model
(`recommend.ts:371`) and even though the design system's own implementation
review used `kimi/k3/max` as the de facto harness for 75% of its
`visual_fix` cards nine days earlier
(`docs/design/review-2026-08-19.md:389-400`).

Concretely: a card claimed today via `harness_recommend("visual_fix")` will
never be offered Kimi K3 — it has to be hand-pinned with an `explicit`
harness, exactly as the Aug-19 review did. The catalog knows the model
exists; the policy never proposes it. That is either a real gap (the routing
table missed updating after the review established practice) or a decision
nobody wrote down (cost, unverified literal-spec compliance, multimodal
reliability). Right now it reads as the former, because nothing next to
`ACTIVITY_HARNESS` or in `decisions.md` explains the omission.

### F2 — High. The seeded price for `k3` matches no published rate, and collapses two different models into one

`pricing.ts:140,142` seeds both `k3` and `kimi-for-coding` at the identical
row — $0.60 input / $2.50 output / $0.06 cache per Mtok, dated
`MODEL_PRICES_FAMILIES_SEEDED_AT = "2026-08-17"` (`pricing.ts:80`). Every
public rate found in this research (§1 table) disagrees:

- K3 flagship is $3.00 (cache-miss) / $0.30 (cache-hit) input and $15.00
  output on Moonshot's own pricing page, and $2.60/$13.00 on OpenRouter's
  aggregate across 12 providers — roughly **5–6x** the seeded input price and
  **5–6x** the seeded output price.
- Kimi For Coding (a genuinely different, cheaper, coding-tuned model, not a
  rebrand of K3) is $0.95 (cache-miss) / $0.19 (cache-hit) input and
  $4.00–$8.00 output — closer to the seed's order of magnitude but still not
  matching it, and still a different number from K3.

The file's own header states the table exists so "dollars are arithmetic"
and warns that "a price read a week ago is a week old" (`pricing.ts:78-79`,
`102-113`) — this row is one month old against a fast-moving public price and
is off by roughly 5x on the model most of the design review actually billed
against. It also merges two models Moonshot prices differently onto one
number, which will misprice whichever of the two a card actually runs.

### F3 — Informational. Effort catalog integration is correct and needs no change

`KIMI_K3` (`max` only) and `KIMI_THINKING` (`off`/`on`) in `efforts.ts:43-51`
match Kimi Code's own documented model registry
(`moonshotai.github.io/kimi-code/en/configuration/config-files.html`, the
source already cited in the file). Included here as the positive control:
proof this research's method (cross-check the repo's claim against the
model's own current docs) turns up both gaps and non-gaps, not just
findings.

### F4 — Open question, not a defect. Fit against the doctrine's literalism is untested

OCL-81's whole premise is that a screen "never improvise[s] locally"
(`system/components.md:19-21`, `system/README.md` rule 2) — a component spec
is tokens-only, every state is mandatory, and an amendment is the only way to
add anything not already written down. Kimi K3's own vendor material claims
exactly the visual-comparison strength `visual_fix` needs (screenshot/video
input, frontend-specific tuning) — but names "excessive proactiveness" under
ambiguous intent as a known behavior (§1). That is the specific failure mode
a token-literal, no-improvisation doctrine is least tolerant of: a model that
fills a gap with its own taste instead of stopping at the spec's edge.

Nothing in this research confirms or refutes whether Kimi K3 actually
does this against OCL-81's spec — the Aug-19 review used it for `visual_fix`
execution, but its report evaluates the *rendered UI*, not which model wrote
the fix or whether that model stayed on-spec. Before F1's routing gap is
closed at the policy-table level (not just per-card by hand), one literal
`visual_fix` card should be run through Kimi K3 and checked specifically for
un-requested deviation from `components.md`/`decisions.md` — the same way
`decisions.md` checks every other gap the doctrine left open.

## 4. Recommendations

1. **Close F1 as a decision, not a silent gap.** Either add `kimi-k3` to the
   `visual_fix`/`showpiece` chains in `ACTIVITY_HARNESS` (matching what the
   Aug-19 review already did by hand), or write one line next to the table —
   or a `decisions.md`-style entry — saying why it stays out. Right now
   nothing distinguishes "forgotten" from "decided against."
2. **Re-seed F2's price rows from the current published rates**, and split
   `k3`/`k3-256k` from `kimi-for-coding`/`kimi-for-coding-highspeed` into
   independently-sourced numbers instead of aliasing them to the same price —
   they are different models with different public rates.
3. **Run F4's spec-adherence check before scaling F1's fix.** One
   `visual_fix` card, Kimi K3 harness, reviewed against `components.md`
   line-by-line for improvisation beyond the spec — cheap, and it turns an
   open question into either a confirmation or a documented risk.

## Sources

- [Kimi K3 Tech Blog: Open Frontier Intelligence](https://www.kimi.ai/blog/kimi-k3)
- [What Is Moonshot AI's Kimi K3 Model and Why Is It Making Waves? — Bloomberg](https://www.bloomberg.com/news/articles/2026-07-27/what-is-moonshot-ai-s-kimi-k3-model-and-why-is-it-making-waves)
- [China's Moonshot AI unveils Kimi K3 that rivals OpenAI, Anthropic — CNBC](https://www.cnbc.com/2026/07/17/moonshot-ai-kimi-k3-model-openai-anthropic-china.html)
- [Kimi K3 - Kimi API Platform (quickstart)](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [Kimi K3 - API Pricing & Benchmarks — OpenRouter](https://openrouter.ai/moonshotai/kimi-k3)
- [Kimi K3 Pricing | Plans, Membership & API Costs — kimi.ai](https://www.kimi.ai/resources/kimi-k3-pricing)
- [Kimi K2.7 Code Pricing | API Costs, Plans & Membership — kimi.ai](https://www.kimi.ai/resources/kimi-k2-7-code-pricing)
- [Kimi K3 Model Overview: 2.8T Parameters, MXFP4 Quantization — Hugging Face blog](https://huggingface.co/blog/ResterChed/kimi-k3-model-overview-mxfp4-quantization-open-wei)
- [Moonshot AI Releases Kimi Code CLI — MarkTechPost](https://www.marktechpost.com/2026/06/06/moonshot-ai-releases-kimi-code-cli-a-terminal-ai-coding-agent-built-in-typescript-for-next-gen-agents/)
- [GitHub — MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
- Moonshot Kimi Code config docs, cited in-repo: `https://moonshotai.github.io/kimi-code/en/configuration/config-files.html`
