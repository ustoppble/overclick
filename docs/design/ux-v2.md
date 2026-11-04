# OverClick UX v2 — Design Doctrine

> The contract for the board's visual language. Every UI card cites this document;
> a change that contradicts it is wrong until the doctrine itself is amended.
> Implementation is split across OCL-34 (themes), OCL-35 (topbar), OCL-36 (numbers),
> OCL-37 (brand) — see the scope map at the end.
>
> Amendments in force: **A1** (touch floor, OCL-87) and **A2** (theme
> conformance, OCL-88). The rules below already read as amended; the conflict
> each one resolved and the reasoning behind it live in
> [`amendments.md`](./amendments.md).

Direction in one line: **the x.ai school — near-black, one typeface speaking through
weight, one accent, generous air, and not a single decorative color.**

---

## 1. Visual direction

### What it is

- **Near-black canvas.** The app is a dark instrument panel: `#000` canvas, surfaces
  a step above it, depth from *lightness*, never from colored glows.
- **A disciplined gray ladder.** Exactly one scale of grays for surfaces, borders and
  text. If two elements need to differ, they differ by one step on the ladder or one
  weight of type — not by hue.
- **One accent.** White. Emphasis, selection, the primary action: white at full
  strength on dark. There is no "brand blue". (Semantic red/green survive only as
  *status meaning*, see below.)
- **Typography is the identity.** Hierarchy comes from size and weight of a single
  UI face; monospace is demoted from "the whole interface" to a *data voice* — ids,
  counts, money, code. Today the entire board speaks 10–11px mono; that reads as
  terminal soup, not as x.ai.
- **Air.** Density is bought with padding and type size, never by shrinking the
  **hit area** (A1). The visual box may be as compact as 32px; the area that
  receives the tap never goes under `--oc-tap-min` (24px) on any device, and never
  under `--oc-tap` (44px) where the pointer is a finger. The box and the target are
  two different things, and only one of them is negotiable.
- **1px borders, low-alpha white.** Edges whisper (`rgba(255,255,255,.08)` at rest,
  `.14` on hover). No colored borders as decoration.

### What it is not

- Not cyberpunk: no neon glows, no scanlines, no matrix green.
- Not "vibrant block-based": no duotone blocks, no rainbow badges.
- Not glassmorphism-as-identity: blur is an *optical tool* for panels that float
  over content, not the personality of the product.

### What stays from Nebula (verbatim values worth keeping)

| Keep | Current value | Why |
|---|---|---|
| Canvas | `--nebula-void: #000000` | Already the right floor |
| Focus ring | `0 0 0 2px rgba(209,217,235,0.55)` + offset | Correct pattern: outside the control, never resizes it — and **neutral in every theme** (A2/U2): a focus ring in the danger colour announces every keyboard stop as an error |
| Tap floor | `--nebula-tap: 44px` | Accessibility law — under a coarse pointer. It is a **hit-area floor, never a `height`** (A1) |
| Panel solid | `rgb(13,15,19)` | The "no glass when the panel is the screen" rule is right |
| Spacing scale | 4/8/12/16/24/32 | Sane; gains a 48 step for section air |
| Motion ease | `cubic-bezier(0.22,0.61,0.36,1)`, 150–300ms micro | Keep |

### What goes

| Out | Where it lives today | Replacement |
|---|---|---|
| Colored type badges (`.tag.bug #e8a1a1`, `.tag.feature #a9c7e8`) | nebula.css:927–929 | Neutral outline chip, meaning by label; color only as a 3px status *tick* where scanning demands it |
| Amber/blue data accents (`#ffd9a0`, `#a9c7e8` on counters) | nebula.css:983–1003 | text-2 gray; money gets weight, not color |
| Warm gradient on account button (`rgba(196,120,90,…)`) | `--nebula-btn-account-border` | 1px gray border like every other control |
| Glow shadows on status dots (`box-shadow: 0 0 8px …`) | `.agent-status .dot` | Flat 7px dot, no halo |
| Mono as the default UI voice | `body`, buttons, filters (10–11px mono everywhere) | Inter for UI; mono only for data (ids, numbers, timestamps) |
| The bare-text "Filtros" trigger that renders as a gray toggle pill glued to the wordmark | `.ff-trigger` (nebula.css:532) | The Control spec in §3 — every trigger is the same 32px bordered control |

---

## 2. Token table

All board styles migrate to `--oc-*` custom properties. A theme is a file in
`apps/web/src/styles/themes/<name>.css` that only redefines tokens. `nebula` must be
pixel-faithful to today; `xai` is the reference implementation of this document;
`overclock` is the board wearing the product's own palette, extracted from the
Overclock app and documented value by value (OCL-56). What a theme may and may not
diverge on is settled below, in **Theme conformance**.

Type ramp (all themes): 22/16/13/12 px = display/title/body/label, data at
the label size, nothing under 12 px (amendment A3), weights 400/500/600 only.
UI face: `Inter, -apple-system, sans-serif`, served by the app (A3).
Data face: `"SF Mono", ui-monospace, Menlo, monospace`.

| Token | Role | nebula (today) | xai (new) | overclock |
|---|---|---|---|---|
| `--oc-bg` | app canvas | `#000000` | `#000000` | TODO |
| `--oc-surface` | column/list background | `transparent` (columns sit on canvas) | `#0A0A0B` | TODO |
| `--oc-surface-2` | card, panel | `rgba(16,18,22,0.72)` + blur 18 | `#111113`, no blur | TODO |
| `--oc-surface-3` | hover/raised, popover | `rgb(13,15,19)` | `#17171A` | TODO |
| `--oc-border` | resting 1px edge | `rgba(255,255,255,0.08)` | `rgba(255,255,255,0.08)` | TODO |
| `--oc-border-strong` | hover/open edge | `rgba(209,217,235,0.4)` | `rgba(255,255,255,0.16)` | TODO |
| `--oc-text-1` | primary text | `#FFFFFF` | `#F7F7F8` | TODO |
| `--oc-text-2` | secondary | `rgba(255,255,255,0.65)` | `rgba(255,255,255,0.64)` | TODO |
| `--oc-text-3` | tertiary/meta | `rgba(255,255,255,0.45)` | `rgba(255,255,255,0.42)` | TODO |
| `--oc-accent` | emphasis, selection, primary action | `#D1D9EB` (mist-glow) | `#FFFFFF` | TODO |
| `--oc-accent-contrast` | text on accent | `#0a0c10` | `#000000` | TODO |
| `--oc-ok` | success/running status only | `#7dd6a0` | `#4ADE80` @ 70% sat — dots and status text only | TODO |
| `--oc-danger` | error/bug status only | `#e8a1a1` | `#F87171` @ 70% sat — dots, errors, destructive | TODO |
| `--oc-font-ui` | UI face | system sans (today: mono almost everywhere) | Inter stack | TODO |
| `--oc-font-data` | data face | SF Mono stack | SF Mono stack | TODO |
| `--oc-radius-control` | buttons, chips, inputs | mixed 7–999px | `8px` (uniform; pills die) | TODO |
| `--oc-radius-panel` | cards, popovers, modal | 16px | `12px` | TODO |
| `--oc-space-1..8` | 4/8/12/16/24/32 | same | same + `--oc-space-9: 48px` | TODO |
| `--oc-focus-ring` | focus — **neutral in every theme** (A2/U2) | current double ring | same values | same values |
| `--oc-tap` | **coarse-pointer hit floor** (A1) — never a `height` | 44px | 44px | 44px |
| `--oc-tap-min` | **universal hit floor**, every pointer (A1, WCAG 2.2 SC 2.5.8) | 24px | 24px | 24px |
| `--oc-shadow-panel` | floating panels | `0 8px 32px rgba(0,0,0,0.5)` | `0 8px 24px rgba(0,0,0,0.6)` | TODO |
| `--oc-duration` / `--oc-ease` | micro-motion | 150–300ms / atmosphere curve | same | TODO |

Rules: no component may use a hex/rgba literal — tokens only. `--oc-ok`/`--oc-danger`
may appear **only** on status dots, status text, error text and destructive actions;
never on tags, counters, borders-as-decoration.

The `overclock` column above was written before the theme existed. The theme file
(`themes/overclock.css`) is now the source of truth for its values and documents the
origin of each; its declared divergences from this document are listed under Theme
conformance, below.

### Theme conformance — when an extracted palette contradicts §1 (A2)

A theme built by extracting a real product's palette will contradict this document,
because the product was not designed against it. That is expected and it is not a
defect of the theme. What follows decides which contradictions are allowed.

**Tier 1 — universal. No theme may break these, in any circumstance.** These are
the rules whose violation changes what the user *understands*, not what they see:

| # | Law | Binary test |
|---|---|---|
| U1 | `--oc-accent` ≠ `--oc-danger`. A theme may not resolve both to the same colour. | The two computed colours differ by ≥25° of OKLCH hue **or** ≥0.15 of OKLCH lightness. Equal values fail. |
| U2 | The focus ring is **neutral** in every theme — never `--oc-danger`, and never the accent when the accent is a semantic colour. | `--oc-focus-ring`'s colour has OKLCH chroma ≤ 0.04 and is not in the danger hue family. |
| U3 | Hover and open borders are neutral. Colour is not decoration. | Same chroma test as U2, on `--oc-border-strong`. |
| U4 | `--oc-ok` / `--oc-danger` are reserved to meaning: status dots, status text, error text, destructive actions. A theme picks its red and green; it may not spend them elsewhere. | No other token resolves to the `--oc-ok` / `--oc-danger` value. |
| U5 | A theme declares values only — never a size that moves a box. | Checklist 14. |
| U6 | Type ramp, Control anatomy and the hit floors of A1 hold in every theme. | Checklist 3, 12. |

**Tier 2 — theme-scoped. A theme may diverge, and must declare it.** Identity and
taste: accent hue (an accent need not be white), the radius family including pills,
the label face (mono as the UI voice), tag foreground colours, decorative glow,
extra semantic colours (`warn`, `info`), and the hue of the gray ladder. One guard
rides along: **a Tier-2 colour may not equal `--oc-ok` or `--oc-danger`** — a cyan
`feature` tag is identity, a red one is a lie.

**Tier 3 — the declaration.** Every theme file opens with an `EXEMPTIONS` block:
one line per Tier-2 divergence, naming the rule it departs from and the source of
the value. **An undeclared divergence is a bug**; a declared one is the theme.
`nebula`'s exemption is "pixel-faithful to today". `overclock`'s is "the board
wearing the product": pills, mono labels, the agent colour spectrum on tags, the
red haze, `warn`/`info`, and a hued gray ladder — all sourced from the Overclock
app. `xai` declares none and is the only theme required to pass every item of the §5
checklist, universal and theme-scoped alike.

### Layers (`--oc-z-*`, OCL-59)

Depth is a token too. A rule never writes a z-index number; it names a rung, and the
rungs are the whole ladder the board stacks on:

| Rung | Value | What sits there |
|---|---|---|
| `--oc-z-atmo-back/mid/front` | -3 / -2 / -1 | the canvas behind the content |
| `--oc-z-content` | 2 | the board's columns and cards, and every non-board page |
| `--oc-z-fade` | 5 | the viewport's bottom blur |
| `--oc-z-bar` | 10 | the floating bulk-selection bar |
| `--oc-z-panel` | 20 | a filter panel hanging off a control in a bar |
| `--oc-z-backdrop` | 25 | the tap-away target that closes a phone panel |
| `--oc-z-chrome` | 30 | the bars themselves |
| `--oc-z-menu` | 40 | dropdowns, menus, popovers |
| `--oc-z-modal` | 50 | the card detail and its overlay |
| `--oc-z-sheet` | 60 | the phone's full-screen detail |

Two rules make the ladder hold, and both are enforced by `styles/layers.test.ts`:

1. **A bar that owns a panel owns a rung.** Glass makes a bar a stacking context, so
   the panel's own rung counts only *inside* the bar; from outside, bar and panel are
   one box, and anything later in the document draws over both. Both bars state
   `--oc-z-chrome` in their base rule, at every width — `.topbar-wrap`, which carries
   the board's two levels (§3), and `.topbar`, which is the whole bar on every other
   screen. Never only inside a media query.
2. **A menu is always over the board.** A hover state, a lift, a card: none of them
   may cover an open menu or take its clicks. Anything the board draws stays under
   `--oc-z-menu`, and the detail that a menu opens stays over it.

New layer? It gets a name here, never a `+1` at the call site.

---

## 3. Component specs

### The Control (one anatomy for every trigger — fixes the "Filtros" pill)

Every interactive chip in the bars (project, mission, Filtros, limpar, mover) is the
same control; nothing is bare text and nothing is a stretched toggle:

```
height 32px · padding 0 12px · radius --oc-radius-control (8px)
border 1px --oc-border · bg transparent · font --oc-font-ui 13px/500 --oc-text-2
gap 6px between icon (14px SVG, stroke 1.5) · label · count

rest    → as above
hover   → bg --oc-surface-3 · border --oc-border-strong · text-1 · 200ms
open    → same as hover, chevron/funnel rotates, stays until close
active  → (filter applied) text-1 + count badge:
          [ 18px min-width · radius 9px · bg --oc-accent · --oc-accent-contrast
            font --oc-font-data 12px/600 ]  e.g. "Filtros ②"
```

The funnel icon is Lucide `filter` at 14px — never an emoji, never a toggle-switch
graphic. Minimum 16px gap between the wordmark block and the first control.

**Hit area (A1).** The 32px above is the *drawn box*. Every Control — and every
other interactive element in the board — also carries a hit area that never falls
below `--oc-tap-min` (24px), and grows to `--oc-tap` (44px) under a coarse pointer.
The area grows without moving the box, with a non-painting pseudo-element:

```css
.oc-tappable { position: relative; }

.oc-tappable::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  width: max(100%, var(--oc-tap-min));
  height: max(100%, var(--oc-tap-min));
}

@media (pointer: coarse) {
  .oc-tappable::after {
    width: max(100%, var(--oc-tap));
    height: max(100%, var(--oc-tap));
  }
}
```

Four constraints, all of them review points:

- No ancestor between the control and the bar may `overflow: hidden` it — clipping
  reverts the fix silently. If the row must clip, the control grows its own
  `min-block-size` instead and the row grows with it.
- A row of tappables holds `gap: var(--oc-space-2)` (8px) or more under a coarse
  pointer; otherwise the expanded areas overlap and the later element in the DOM
  steals the tap.
- Replaced elements (`input[type="checkbox"|"radio"|"range"]`) have no
  pseudo-elements: they are wrapped in their `<label>`, and the label is the
  `.oc-tappable`.
- The pseudo-element paints nothing — no background, no border, no shadow. It
  inherits `pointer-events` from the control, so a tap on it is a tap on the
  control.

`--oc-tap` is never written as a `height` or `min-height` on a visual box. A
control that is under 24px drawn *and* under 24px in hit area is a bug on every
device, not a dense control.

### Topbar — two levels

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ L1  overclick                            ● 2 rodando   Custo ~US$ 27,10 ⋯  │  48px
├──────────────────────────────────────────────────────────────────────────────┤
│ L2  [Todos os projetos ▾] [V1 — Zero investiga a fundo e leva o problema…▾] │  44px
│     [⧩ Filtros ②]  26 cards · [limpar]              [Mover para missão]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **L1** never wraps, never truncates: wordmark left; right side is exactly three
  items — running chip, cost stat (§4), account menu `⋯`. All follow
  the Control anatomy; the stat is text, not a pill.
- **L2** owns filtering. Mission chip may grow to ~60ch before ellipsis + title
  tooltip. "Mover para missão" appears only with cards selected, right-aligned.
- <1100px: L1 folds running into `⋯`. <768px: L2 collapses to a single
  `[⧩ Filtros]` control opening a sheet; L1 keeps wordmark + stat + `⋯`.
- Both levels sit on `--oc-bg` with a single 1px `--oc-border` under L2. No glass.

### Board card

```
┌────────────────────────────────────────────┐   surface-2 · radius 12 · border 1px
│ OCL-27 · feature                     ~$2.10│   ← data face 12px text-3; cost right
│ Continuação do OCL-15: contexto do         │   ← UI face 13px/500 text-1, 2 lines max
│ projeto (context + current_version…)       │
│ ● sol · aberto 21 min                      │   ← 7px status dot (--oc-ok when running)
└────────────────────────────────────────────┘     + data face 12px text-3; no badges
```

Type (`bug`/`feature`/`rfc`) is a plain text word in the meta line — no colored
chip. A `bug` may carry a 3px left border in `--oc-danger` at 40% alpha as the one
permitted scanning aid. Hover: border-strong + surface-3, no scale transform.

### Detail modal

Two columns (main 1fr / rail 300px), surface-2, radius 12, padding 24. Section
titles are UI face 12px/600 uppercase text-3 letter-spacing .06em. Rail facts
(harness, executor, branch) in data face. No horizontal scroll anywhere (OCL-10
rule); rail truncates with ellipsis. Timeline entries: 1px left rule, kind label in
data face text-3 — `report` entries get the only allowed accent-colored label.

### Columns

Column header: UI face 12px/600 uppercase text-3 + data-face count. 24px gutter
between columns (48px before the Descartados group). Snap-scroll behavior from
OCL-24 stays.

---

## 4. Numbers & money

1. **Money is labeled, always.** `Custo ~US$ 27,10` — never a bare `~$27.10`.
   Currency explicit per locale (`US$` in pt-BR, `$` in en). Money renders in
   **data face, 600 weight, text-1**; it is the only number allowed to lead.
2. **Secondary numbers stay secondary.** Tokens and time follow in text-3:
   `175M tokens · 4h14`. Never four unlabeled numbers in a row.
3. **`~` must be explainable.** The stat popover states: "estimado: N cards sem
   usage medido · M sem preço". The bare `(4)` of today dies; it becomes a popover
   line.
4. **One formatter.** A single helper (`formatMoney`, `formatTokens`,
   `formatDuration`) used by topbar, cards, detail and Insights. Rules:
   money 2 decimals; tokens `175M`/`94.8M`/`12k`; duration `4h14`/`33m`/`58s`;
   `null` price → "sem preço", never `$0`.

---

## 5. Acceptance checklist (binary — implementation cards cite these)

Every item is tagged **[universal]** — it holds in every theme, no exemption
possible — or **[theme]** — `xai` and `nebula` must pass it, and another theme may
diverge only by declaring it in its `EXEMPTIONS` block (§2, Theme conformance).

1. [ ] **[universal]** No hex/rgba literal in any component rule; tokens only.
2a. [ ] **[universal]** `--oc-ok`/`--oc-danger` appear only on status dots,
        status/error text and destructive actions — never on tags, counters or
        borders-as-decoration.
2b. [ ] **[theme]** Zero coloured type/priority badges; type is a plain word.
3. [ ] **[universal]** Every topbar trigger follows the Control anatomy (32px box,
       1px border, `--oc-radius-control`, 14px SVG icon); no bare-text triggers, no
       pill toggles. The radius *value* is [theme].
4. [ ] **[universal]** ≥16px between wordmark and first control at every width.
5. [ ] **[universal]** Topbar renders as two levels ≥768px; L1 never wraps nor
       truncates.
6. [ ] **[universal]** Mission chip shows ≥60ch before ellipsis at 1440px.
7a. [ ] **[universal]** Ids, numbers, timestamps and code speak the data face.
7b. [ ] **[theme]** UI text speaks the UI face (`--oc-font-label` = `--oc-font-ui`).
8. [ ] **[universal]** Money always labeled + currency-explicit; no unlabeled
       number groups.
9. [ ] **[universal]** "~" explained in the stat popover with both counts.
10. [ ] **[universal]** Focus ring visible on every interactive element (keyboard
        walk of topbar, card, modal), and neutral per U2 — never the danger colour.
11. [ ] **[universal]** No hover scale transforms; hover = surface/border/text
        change in 150–300ms.
12. [ ] **[universal]** Hit floors (A1): for every interactive element, the union of
        its border box and its `::after` floor measures **≥24×24 CSS px with
        `pointer: fine`** and **≥44×44 with `pointer: coarse`**. The drawn box stays
        32px (36px for fields); density is bought with padding, never with the
        target.
13. [ ] **[universal]** No horizontal scroll at 375/768/1024/1440 in any theme.
14. [ ] **[universal]** A theme switch changes zero layout — only token values.
15. [ ] **[universal]** `prefers-reduced-motion` disables non-essential animation.
16. [ ] **[universal]** `--oc-accent` ≠ `--oc-danger` (U1), and `--oc-border-strong`
        is neutral (U3), in every theme.
17. [ ] **[universal]** Every theme file opens with an `EXEMPTIONS` block; every
        Tier-2 divergence it ships is listed there with its source. An undeclared
        divergence fails this item.
18. [ ] **[universal]** No Tier-2 colour (tag foregrounds, glow, `warn`, `info`)
        resolves to the `--oc-ok` or `--oc-danger` value.

---

## 6. Scope map

| Card | Owns | Must not touch |
|---|---|---|
| **OCL-34** | Token extraction (`--oc-*`), `themes/nebula.css` (pixel-faithful), `themes/xai.css` (§2 values), `themes/overclock.css` (extract + document values), theme selector in `⋯` menu, no-flash boot | Layout, component structure |
| **OCL-35** | Topbar two-level layout (§3), the Control anatomy applied to all bar triggers, responsive folds | Number formatting, themes, brand |
| **OCL-36** | Formatting helpers + stat/popover copy (§4), applied to topbar, card, modal, Insights | Layout, themes |
| **OCL-37** | Monochrome wordmark SVG (`currentColor`), monogram favicon set, `docs/design/brand.md` | Everything else |

Sequence: 34 → 35 → 36 → 37 (35+ build on tokens; each cites the checklist items it
closes in its deliver).

### Amendment follow-ups (A1, A2 — see [`amendments.md`](./amendments.md))

| Card | Owns | Must not touch |
|---|---|---|
| **A1 implementation** | `--oc-tap-min`, the `.oc-tappable` utility, adoption on the seven measured components (`.mf-trigger`, cost stat, `.mchip`, `.am-theme-opt`, `.seen-add`, banner and modal buttons) | Theme values, layout |
| **A1 guard** | The hit-floor test (fine + coarse pointer passes), sibling of `styles/layers.test.ts` | Component styles |
| **A2 implementation** | Four values in `themes/overclock.css` (`--oc-danger-rgb`, `--oc-focus-ring`, `--oc-focus-ring-inset`, `--oc-border-strong`) + the `EXEMPTIONS` block in all three theme files | Component styles, layout |
| **A2 guard** | U1–U4 as assertions in `styles/tokens.test.ts`, evaluated per theme | Theme values |
