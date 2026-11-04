# Amendments — where the doctrine contradicted itself, and what was decided

> OCL-87, OCL-88. Each entry: the conflict as measured, the decision, the
> rationale, and the tokens and files the decision touches.
>
> An amendment is **normative the moment it lands**: the corresponding rules in
> [`ux-v2.md`](./ux-v2.md) are edited in the same commit, and this file is the
> record of *why* they now read the way they do. Implementation of the code that
> the amendment makes necessary is scoped to its own cards, listed at the end of
> each entry.
>
> Relation to [`system/decisions.md`](./system/decisions.md): that file records
> what the doctrine **did not cover**; this one records where the doctrine
> **said two incompatible things** and which one survived.

---

## A1 — The touch floor is a pointer-conditional hit floor, not a control height

**Card:** OCL-87 · **Origin:** design review OCL-79, finding C3
· **Amends:** §1 (Air), §2 (token table), §3 (the Control), §5 (item 12, new item 16)

### The conflict, as it stood

Four passages of the doctrine could not all be true at once:

| Where | Text |
|---|---|
| §3, the Control | `height 32px · padding 0 12px · radius --oc-radius-control` |
| §1, Air | "Density is bought with padding and type size, never by shrinking targets (the 44px floor in `--nebula-tap` stays law)." |
| §2, tokens | `--oc-tap` = 44px in every theme |
| §5, item 12 | "44px touch floor held on every control (density via padding only)." |

A control cannot be a 32px box and a 44px target at the same time. The
implementation followed §3, so item 12 fails almost everywhere. Measured in
production v0.2.1: topbar controls 32px, `.mf-trigger` 16px, cost stat 19px,
`.am-theme-opt` 23px, `.mchip` 20px, `.seen-add` 30px, banner buttons 31px,
modal buttons 33px. The Settings tabs (44px) are the only place the floor holds.

### The decision

**The 44px floor is kept, and scoped to touch. The 32px Control is kept, and
scoped to a fine pointer. Neither number moves; what changes is what each one
governs.** Three rules, all binary:

1. **`--oc-tap` stays 44px in every theme**, and stops meaning "the height of a
   control". It now governs one thing: **the minimum hit-target dimension,
   both axes, under a coarse pointer.** It is never used as a `height` or a
   `min-height` on a visual box.
2. **A new token `--oc-tap-min: 24px`** carries the floor that holds
   *everywhere*, pointer included — the WCAG 2.2 AA minimum target size
   (SC 2.5.8). No interactive element in the board may have a hit box under
   24×24 CSS px on any device.
3. **The visual box is unchanged and stays a design decision:** 32px for
   compact controls, 36px for form fields (system `decisions.md` D2). Density
   is still bought with padding and type size; what §1 forbids shrinking is the
   **hit area**, which is now a distinct thing from the box.

So a 32px topbar control is compliant on a desktop (32 ≥ 24) and must present a
44px hit area on a phone. A 16px `.mf-trigger` is a **bug in every context** —
it fails the pointer floor too — which is the outcome that matters most here:
the amendment must not be readable as a license for 16px triggers.

### The technique, written so two executors converge

The hit area grows with a non-painting `::after`, centred on the element. The
element's box, its layout and its neighbours' positions do not move.

```css
/* Base utility. Every interactive element carries .oc-tappable, or is matched
   by the element selectors below in the base stylesheet. */
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

Four constraints that make it work, and that a reviewer checks:

- **No ancestor between the control and the bar may clip it.** An
  `overflow: hidden` on the row cuts the expanded area back to the visual box
  and silently reverts the fix. If the row must clip, the control's own hit
  area grows by `min-block-size` instead and the row grows with it.
- **Neighbours need `gap`.** Two 32px controls 4px apart get 44px areas that
  overlap; the later one in the DOM wins the tap. Any row of tappables under a
  coarse pointer holds `gap: var(--oc-space-2)` (8px) or more — which is what
  makes the expansion honest rather than decorative.
- **Replaced elements have no pseudo-elements.** A bare
  `input[type="checkbox"]` / `[type="radio"]` / `[type="range"]` cannot carry
  `::after`. Those are wrapped in their `<label>`, and the label is the
  `.oc-tappable`.
- **The pseudo-element paints nothing.** No background, no border, no
  `box-shadow`. It exists to receive pointer events; it inherits
  `pointer-events` from the control, so a tap on it is a tap on the control.

### Rationale

The literal reading of §1 ("never by shrinking targets") pointed at Option A —
a 44px area everywhere, including desktop. It was rejected on the evidence:

- **It is not what accessibility actually requires.** WCAG 2.2 sets the
  normative minimum at **24×24 CSS px (SC 2.5.8, AA)**, with an exception when
  spacing compensates. 44×44 comes from SC 2.5.5 (**AAA**) and from touch
  platform guidance (Apple HIG 44pt, Material 48dp) — guidance written for a
  finger, whose contact patch is ~10mm, not for a cursor with single-pixel
  precision. A 32px control with a mouse clears AA with 33% to spare.
- **Invisible 44px areas on a desktop cost more than they buy.** They overlap
  in dense bars, they steal taps from the element next door, and they make the
  clickable region disagree with the drawn region — a worse accessibility
  outcome for low-vision and motor-impaired pointer users than an honest 32px
  box, because the target you see is no longer the target you hit.
- **Desktop density is the product's direction.** This board is a work
  instrument read at 1440px with dozens of cards in view; §1's whole thesis is
  air *between* elements, not fat elements. Option C (44px controls
  everywhere) inflates the topbar by 37% in height and contradicts §3 as
  written and as already shipped.
- **The floor still binds where the risk is real.** On a phone every one of
  those measured elements — 16, 19, 20, 23, 30px — becomes a 44px target, which
  is where mis-taps actually happen.

The system doctrine already anticipated this: `system/decisions.md` D2 says
"below 768px the hit area grows to `var(--oc-tap)` without changing the visual
height". This amendment promotes that sentence into the doctrine, replaces the
width breakpoint with `(pointer: coarse)` — the honest signal, since a 1024px
tablet is a finger and a 700px window on a laptop is not — and adds the 24px
floor that D2 did not have.

### Tokens and files affected

| What | Where | Change |
|---|---|---|
| `--oc-tap` | `apps/web/src/styles/themes/nebula.css:252` (inherited by `xai`, `overclock`) | Value unchanged (44px); role redefined. Doc comment updated to "coarse-pointer hit floor". |
| `--oc-tap-min` | same file, next to `--oc-tap` | **New**, `24px`, all themes. |
| `--nebula-tap` | `apps/web/src/styles/nebula.css:146` | Alias stays; any rule using it as a `height`/`min-height` is a violation. |
| `.oc-tappable` | base stylesheet (`nebula.css`, control layer) | **New** utility, the block above. |
| Failing components | `.mf-trigger` (16px), cost stat (19px), `.mchip` (20px), `.am-theme-opt` (23px), `.seen-add` (30px), banner buttons (31px), modal buttons (33px) | Adopt `.oc-tappable`; the four under 24px are pointer-floor bugs and are fixed on both pointers. |
| Token snapshot | `apps/web/src/styles/__snapshots__/tokens.test.ts.snap` | Gains `--oc-tap-min`. |
| Guard | `apps/web/src/styles/` (sibling of `layers.test.ts`) | **New** test, see below. |

### The checklist item is now machine-checkable

Item 12 becomes: measure `el.getBoundingClientRect()` unioned with the
`::after` box for every element matching the interactive selector set, once
with `pointer: fine` and once with `pointer: coarse` emulated. Pass = every box
≥ 24×24 in the first pass and ≥ 44×44 in the second. No human judgement, no
screenshot.

### Follow-up cards (not this one)

- **Implementation:** adopt `.oc-tappable`, add `--oc-tap-min`, fix the seven
  measured components. Closes checklist 12.
- **Guard:** the Playwright/JSDOM test above, so item 12 stops being an opinion.

---

## A2 — When an extracted palette contradicts §1: three tiers of law

**Card:** OCL-88 · **Origin:** design review OCL-79, findings B1–B5
· **Amends:** §2 (new "Theme conformance" subsection), §5 (every item tagged, new items 17–18)

### The conflict, as it stood

§2 wrote an exemption for exactly one theme — "`nebula` must be pixel-faithful
to today" — and left `overclock` as a TODO. Then OCL-56 built `overclock` by
extracting the Overclock app's palette token by token, documenting the source of
each value, which is precisely what its scope map asked for. The result fails
~6 of the 15 checklist items **by construction**, and the file is not wrong: the
doctrine never said what happens when a real product's palette disagrees with
§1's universal laws.

Measured in `apps/web/src/styles/themes/overclock.css`:

1. `--oc-accent-rgb: 239 68 68` and `--oc-danger-rgb: 239 68 68` — accent and
   danger are the same `#ef4444`. Selected, primary, error and destructive are
   visually identical.
2. `--oc-focus-ring: 0 0 0 2px rgb(var(--oc-accent-rgb)/0.65)` and
   `--oc-border-strong: rgb(var(--oc-accent-rgb)/0.4)` — keyboard focus and
   every hover paint the error red.
3. Kill-list items return: `--oc-tag-feature-fg: #22d3ee`,
   `--oc-tag-rfc-fg: #8b5cf6`, `--oc-radius-pill: 999px`,
   `--oc-font-label: var(--oc-font-data)`, a red `--oc-plan-glow`,
   `--oc-warn: #facc15`, `--oc-info: #06b6d4`.
4. The grays carry hue: `#1f2937`, `#9ca3af`, `#6b7280` (blue slate) where
   `nebula` and `xai` use white with alpha.

### The decision

**Neither blanket exemption nor blanket conformance. The checklist splits into
two kinds of law, and a theme may only diverge from one of them — in writing.**

**Tier 1 — universal. No theme may break these, ever.** They are the rules
where breaking them changes what the user *understands*, not what they see:

| # | Law | Binary test |
|---|---|---|
| U1 | **`--oc-accent` ≠ `--oc-danger`.** A theme may not resolve both to the same colour. | The two computed colours differ by ≥25° of OKLCH hue **or** ≥0.15 of OKLCH lightness. Equal values fail. |
| U2 | **The focus ring is neutral in every theme.** It never carries the accent when the accent is a semantic colour, and never carries `--oc-danger`. | `--oc-focus-ring`'s colour has OKLCH chroma ≤ 0.04 and is not in the danger hue family. |
| U3 | **Hover and open borders are neutral.** `--oc-border-strong` is a gray-ladder value; colour is not decoration. | Same chroma test as U2. |
| U4 | **`--oc-ok` / `--oc-danger` are reserved to meaning** — status dots, status text, error text, destructive actions. A theme picks its red and green; it may not spend them elsewhere. | No other token resolves to the `--oc-ok`/`--oc-danger` values. |
| U5 | **Layout tokens are identical across themes.** A theme declares values, never a size that moves a box. | Existing checklist 14. |
| U6 | **Type ramp, Control anatomy, and the A1 hit floors** hold in every theme. | Checklist 3, 12. |

**Tier 2 — theme-scoped. A theme may diverge, and must declare it.** These are
identity and taste: accent hue (an accent need not be white), radius family
including pills, the label face (mono as the UI voice), tag foreground colours,
decorative glow, extra semantic colours (`warn`, `info`), and the hue of the
gray ladder. One guard rides along: **a Tier-2 colour may not equal `--oc-ok`
or `--oc-danger`** — a cyan `feature` tag is identity, a red one is a lie.

**Tier 3 — the declaration.** Every theme file opens with an `EXEMPTIONS`
block, one line per Tier-2 divergence with the doctrine rule it departs from and
the source of the value. **An undeclared divergence is a bug**; a declared one
is the theme. `nebula`'s exemption ("pixel-faithful to today") is restated in
this form. `xai` is the reference implementation and declares none: it is the
only theme required to pass all 15 items.

Applied to `overclock`, the theme **stays in the selector**, keeps its identity,
and changes four values:

| Token | Today | Becomes | Law |
|---|---|---|---|
| `--oc-danger-rgb` | `239 68 68` (= accent) | a red distinguishable from the accent — darker/deeper, e.g. the deep red already present as `--oc-danger-deep-rgb: 127 29 29`, or the accent's `#dc2626` hover shade promoted to danger with the accent staying `#ef4444` | U1 |
| `--oc-focus-ring` | `rgb(accent / 0.65)` (red) | the neutral verbatim ring, `rgba(209,217,235,0.55)` family | U2 |
| `--oc-focus-ring-inset` | idem | idem | U2 |
| `--oc-border-strong` | `rgb(accent / 0.4)` (red) | a gray-ladder value, e.g. the app's own `--color-faint #4b5563` | U3 |

And keeps, declared as exemptions: `--oc-radius-pill: 999px`,
`--oc-font-label: var(--oc-font-data)`, `--oc-tag-feature-fg`,
`--oc-tag-rfc-fg`, `--oc-plan-glow`, `--oc-warn`, `--oc-info`, and the hued
gray ladder — all of them sourced, line by line, from the product.

### Rationale

- **Items 1 and 2 are usability, not taste.** If selection and error are the
  same red, "this card is selected" and "this card is broken" are the same
  pixel — and no amount of brand fidelity earns that. The same red on the focus
  ring means a keyboard user walking the topbar sees every stop announce
  itself as an error. These break comprehension in *any* palette, which is
  what makes them universal rather than `xai`-flavoured.
- **The rest is legitimately the product.** Pills, mono labels, the agent
  colour spectrum, the red haze: these are what the Overclock app *is*. A
  doctrine that forbids a theme from looking like the product it dresses has
  no reason to offer a third theme at all. Option C (drop the theme) throws
  away work that did exactly what it was asked to do.
- **Blanket exemption (Option A alone) was rejected** because it makes the
  checklist unfalsifiable: with "theme-scoped" undefined, every future review
  reopens the same six findings and argues them again from zero. Tiers make the
  argument once.
- **The declaration is the cheap half of the fix.** It costs a comment block
  and converts "this theme fails 6 items" into "this theme declares 8
  exemptions and passes every universal law" — a sentence a reviewer can check
  in one pass.

### Tokens and files affected

| What | Where | Change |
|---|---|---|
| Doctrine | `docs/design/ux-v2.md` §2, §5 | This card. Tier definitions, per-item `[universal]`/`[theme]` tags. |
| `--oc-danger-rgb`, `--oc-focus-ring`, `--oc-focus-ring-inset`, `--oc-border-strong` | `apps/web/src/styles/themes/overclock.css:59, 95, 203, 205` | Four values, follow-up card. |
| `EXEMPTIONS` block | `themes/overclock.css` header, `themes/nebula.css` header | New; `xai` states "none". |
| `--oc-haze-rgb: 239 68 68` | `themes/overclock.css:69` | Reviewed under U4 — it feeds `--oc-plan-glow` (declared exemption), so it stays, but it may not reach a status surface. |
| Guard | `apps/web/src/styles/tokens.test.ts` | Gains the U1–U4 assertions, run per theme. |

Not touched by this card: the theme file itself. The doctrine lands first.

### Follow-up cards (not this one)

- **Implementation:** the four `overclock.css` values + the `EXEMPTIONS` blocks
  in all three theme files. Closes checklist items 2 (the semantic half), 10,
  16, 17.
- **Guard:** U1–U4 as assertions in `tokens.test.ts`, evaluated for every theme.

---

## A3 — Nothing under 12px, and xai is what a newcomer sees

> Navigation plan E7 (owner's decision 8, 2026-11-03).

### The conflict, as it stood

§2 set a five-step ramp, 22/16/13/12/11 px, and called the 11 "data". The
board read it as permission: about 150 declarations sat under 12 px across
`nebula.css` and `insights.css` (11 ×63, 10 ×30, 11.5 ×15, 9.5 ×16, 9 ×15,
10.5 ×10, 8.5 ×1), most of them frozen in `type-ramp-exceptions.ts`. Seals at
8.5 px and ids at 10 px are the text people scan most, and they were the
smallest on the screen. §2 also named Inter as the UI face while the app never
loaded it (finding M14), and the overclock theme's `text-3` read at 4.34:1.

### The decision

- The ramp is **22/16/13/12 px** (display/title/body/label). Data reads at the
  label size. No component rule declares a size under 12 px, in `font-size` or
  in the `font` shorthand, and the escape list keeps no entry under 12.
- **xai is the default theme** for whoever never chose, members included.
  nebula stays the **base**: its file is the `:root` contract every theme
  overrides (`BASE_THEME`), while `DEFAULT_THEME` is only what the layout and
  the boot script write on `<html>` when there is no cookie.
- **Inter is served by the app** (`next/font/local`, weights 400/500/600, the
  OFL beside the files); no font CDN.
- **Every theme clears 4.5:1** for every ink a component paints text with, on
  every floor (canvas, card surface, panel, modal).

### Rationale

The owner's rule is "nothing under 12 px". A floor is only a floor if the
guard holds it in every theme, so the contrast check moved from a per-PR
review note to `contrast.test.ts`, computed from the theme files.

### Tokens and files affected

| What | Where | Change |
|---|---|---|
| Ramp | `apps/web/src/styles/type-ramp.ts` | `[22, 16, 13, 12]` |
| Escapes | `apps/web/src/styles/type-ramp-exceptions.ts` | every entry under 12 px removed |
| Guard | `type-ramp.test.ts` | reads the `font` shorthand too; no step and no escape under 12 |
| Themes | `apps/web/src/lib/theme.ts` | `BASE_THEME = "nebula"`, `DEFAULT_THEME = "xai"`; picker order x.ai · Overclock · Nebula |
| overclock | `themes/overclock.css` | `text-3`/`mist` `#757c89`, `danger` as text `#fca5a5`, `btn-light-text` `#000000` |
| Inter | `apps/web/src/app/fonts.ts`, `app/fonts/` | served locally; xai's `--oc-font-ui` leads with `var(--font-inter)` |
| Guards | `contrast.test.ts` (new), `tokens.test.ts`, `theme.test.ts` | the base is read from `BASE_THEME` |
| Probe | `scripts/legibility-probe.mjs` | measures the rendered page: size ≥12 px and ≥4.5:1, and the rendered font |
