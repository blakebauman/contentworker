---
name: contentworker Admin
description: Calm, precise, fast admin UI for an API-first, AI-agentic-first headless CMS
colors:
  slate-floor: "oklch(0.145 0 0)"
  slate-panel: "oklch(0.205 0 0)"
  slate-raised: "oklch(0.269 0 0)"
  ink: "oklch(0.985 0 0)"
  ink-muted: "oklch(0.708 0 0)"
  ink-button: "oklch(0.922 0 0)"
  hairline: "oklch(1 0 0 / 10%)"
  input-fill: "oklch(1 0 0 / 15%)"
  focus-ring: "oklch(0.556 0 0)"
  wayfinding-blue: "oklch(0.488 0.243 264.376)"
  signal-green: "#3fb950"
  signal-amber: "#d29922"
  signal-red: "oklch(0.704 0.191 22.216)"
typography:
  headline:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter Variable, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.35
rounded:
  control: "18px"
  card: "24px"
  inline: "4px"
spacing:
  control-h: "32px"
  card-pad: "20px"
  card-pad-sm: "16px"
  gap: "6px"
components:
  button-primary:
    backgroundColor: "{colors.ink-button}"
    textColor: "{colors.slate-panel}"
    rounded: "{rounded.control}"
    height: "{spacing.control-h}"
    padding: "0 12px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "{spacing.control-h}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "{spacing.control-h}"
  button-destructive:
    backgroundColor: "oklch(0.704 0.191 22.216 / 20%)"
    textColor: "{colors.signal-red}"
    rounded: "{rounded.control}"
    height: "{spacing.control-h}"
  input:
    backgroundColor: "{colors.input-fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "{spacing.control-h}"
    padding: "4px 10px"
  card:
    backgroundColor: "{colors.slate-panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad}"
  badge-success:
    backgroundColor: "rgba(63, 185, 80, 0.10)"
    textColor: "{colors.signal-green}"
    rounded: "{rounded.control}"
    height: "20px"
    padding: "2px 8px"
---

# Design System: contentworker Admin

## 1. Overview

**Creative North Star: "The Ink and Slate"**

The admin is a slab of slate on which content is the ink. Surfaces are
near-monochrome (chroma 0 across the entire neutral ramp), dark by default, and
deliberately quiet; hue is a reserved vocabulary that means *state* (green =
published/healthy, amber = changed/attention, red = destructive/failed) and
almost nothing else. A single saturated blue exists for rare wayfinding moments
(the active space in the sidebar); it is not a brand splash. The system rejects,
by name, the legacy enterprise CMS admin, the SaaS-gradient startup look,
AI-sparkle clutter, and the unthemed gray shadcn template feel: the theme is
committed, not default.

Density serves reading. Controls are compact (32px), type is small but high
contrast, and layouts lean on background steps and hairline rings instead of
boxes-in-boxes. Editors keep this tab open all day; nothing pulses, glows, or
markets at them.

**Key Characteristics:**
- Dark slate default (`class="dark"` ships on `<html>`); a calm light theme exists but dark is the identity.
- Achromatic neutral ramp; color is state, never decoration.
- Pill-shaped compact controls (18px radius, 32px tall) against 24px-radius panels.
- Flat surfaces defined by rings and background steps, not shadows.
- One family (Inter Variable) doing all typographic work through weight and size.

## 2. Colors

An achromatic slate ramp carries every surface; four hues carry meaning.

### Primary
- **Ink Button** (oklch(0.922 0 0)): the default action color. On slate, the
  strongest thing on screen is a near-white pill; actions read by contrast, not hue.
- **Ink** (oklch(0.985 0 0)): foreground text on all dark surfaces.

### Neutral
- **Slate Floor** (oklch(0.145 0 0)): the app background.
- **Slate Panel** (oklch(0.205 0 0)): cards, popovers, the sidebar. One visible step above the floor.
- **Slate Raised** (oklch(0.269 0 0)): secondary/muted fills, hover states, code blocks.
- **Ink Muted** (oklch(0.708 0 0)): secondary text, placeholders. Meets 4.5:1 on floor and panel; never lighten it below that.
- **Hairline** (oklch(1 0 0 / 10%)): borders and dividers. **Input Fill** (oklch(1 0 0 / 15%)) backs text inputs.

### Tertiary (state + wayfinding)
- **Signal Green** (#3fb950): published, succeeded, healthy. Used as tinted badge fill (10%) with green text.
- **Signal Amber** (#d29922): changed, pending, attention.
- **Signal Red** (oklch(0.704 0.191 22.216)): destructive actions and failures; buttons use a 20% tint fill with red text, never a solid red slab.
- **Wayfinding Blue** (oklch(0.488 0.243 264.376)): the active-space marker in the sidebar and little else.

### Named Rules
**The Hue-Means-State Rule.** If an element is colored, it is telling you a
state. Decorative color is prohibited; a colored element that conveys no state
is a bug. Status color is always paired with a text label, never color alone.

**The One Blue Rule.** Wayfinding Blue appears on at most one element per
screen. If two things are blue, neither is a landmark.

## 3. Typography

**Display/Body/Label Font:** Inter Variable (with `sans-serif` fallback)

**Character:** One neutral grotesque doing everything through weight and size.
No display font, no mono flourish outside code; the voice is set by restraint,
tight sizes, and high contrast rather than typeface personality.

### Hierarchy
- **Headline** (600, 1.125rem/1.3): page titles in the header bar.
- **Title** (500, 1rem/1.4): card titles (`CardTitle`), dialog titles.
- **Body** (400, 0.875rem/1.5): the default reading size everywhere, including tables and forms.
- **Label** (500, 0.75rem/1.35): badges, table headers, metadata, timestamps. Sentence case; no uppercase tracking.

### Named Rules
**The Fourteen-Pixel Rule.** Interface prose is 14px (0.875rem). Larger sizes
are earned by hierarchy (titles, headlines); smaller (12px) is reserved for
labels and metadata, and it stays at ≥4.5:1 contrast.

## 4. Elevation

Flat, ring-defined. Surfaces are flat planes separated by background steps
(floor → panel → raised) and 1px foreground-tinted rings
(`ring-1 ring-foreground/10` in dark). Cards carry only a whisper of shadow
(`shadow-sm`); overlays (dialogs, dropdowns, sheets) earn slightly more, but
depth is always communicated first by the background step and ring, and the
dimmed scrim behind modals. There is no shadow ramp to escalate; if a surface
needs more separation, step its background, don't darken its shadow.

### Named Rules
**The Ring-Not-Shadow Rule.** Boundaries come from hairline rings and
background steps. A shadow larger than `shadow-sm`/`shadow-md` on any resting
surface is prohibited.

## 5. Components

Compact and unassuming: small, quiet controls that disappear until needed.
Density is a feature. All interactive elements share the pill shape (18px
radius), 32px default height, `transition-all`, a 3px soft focus ring
(`ring-3 ring-ring/30` plus a ring-colored border), and a 1px translate-down on
press.

### Buttons
- **Shape:** pill (18px radius), 32px tall, 14px/500 text, 12px horizontal padding. Sizes step 24/28/32/36px.
- **Primary:** Ink Button fill with Slate Panel text; hover drops fill to 80% opacity.
- **Outline / Secondary / Ghost:** hairline border on transparent, raised-slate fill, and bare text respectively; all hover to the muted fill.
- **Destructive:** Signal Red text on a 20% red tint; hover deepens the tint to 30%. Never solid red.
- **Focus:** border takes the ring color plus a 3px `ring/30` halo. Disabled is 50% opacity, pointer-events off.

### Badges (chips)
- **Style:** 20px pill, 12px/500 text, tinted-fill formula: `color at 10% background + colored text + color/30 border` for success/warning; destructive uses the same formula at 20% in dark.
- **State:** `StatusBadge` maps entry states: draft = outline, changed = warning, published = success. Text label always present.

### Cards / Containers
- **Corner Style:** 24px radius.
- **Background:** Slate Panel; nested emphasis uses Slate Raised, never a nested card.
- **Shadow Strategy:** `shadow-sm` + `ring-1 ring-foreground/10` (see Elevation).
- **Internal Padding:** 20px (16px for `size="sm"`), managed by a `--card-spacing` variable.

### Inputs / Fields
- **Style:** pill (18px radius), 32px tall, Input Fill (white at 15%) background, transparent border, placeholder in Ink Muted.
- **Focus:** ring-colored border + 3px `ring/30` halo, transitioned over 200ms.
- **Error / Disabled:** `aria-invalid` swaps border and halo to Signal Red tints; disabled is 50% opacity with `cursor: not-allowed`.

### Navigation
- **Sidebar:** Slate Panel background, ghost-style items (14px/400, Ink Muted at rest, Ink + Slate Raised fill when active), Wayfinding Blue marking the active space. Collapses behind a sheet on mobile.
- **Header:** breadcrumbs in Label size, space/environment switchers as outline pills, command palette on ⌘K.

### Rich Text Editor (signature)
TipTap surface styled as content, not chrome: transparent background, no
visible frame, selection tinted `primary/20`, entry/asset reference links as
subtle `primary/10` pills with dotted underlines, code in Slate Raised mono blocks.

## 6. Do's and Don'ts

### Do:
- **Do** keep the neutral ramp achromatic (chroma 0). "Warming up" the grays is a redesign decision, not a tweak.
- **Do** pair every status color with a text label (badge text, not a bare dot), per PRODUCT.md's accessibility line: status is never color alone.
- **Do** use background steps (floor → panel → raised) to create hierarchy before reaching for borders or shadows.
- **Do** keep controls at 32px default height and 14px text; density is the personality.
- **Do** give every animation a `prefers-reduced-motion` alternative and keep transitions ≤200ms ease-out.

### Don't:
- **Don't** recreate the "legacy enterprise CMS admin": no crowded chrome, no nested settings mazes, no boxes-in-boxes (nested cards are prohibited; use Slate Raised fills).
- **Don't** import the "SaaS-gradient startup" look: no gradient fills, no glassmorphism, no `background-clip: text`, no marketing energy in a work tool.
- **Don't** scatter sparkle icons or "AI" buttons across surfaces ("AI-everything clutter"); AI lives inside flows (generate dialog, assist panel, enrichment review) with the same quiet chrome as everything else.
- **Don't** ship the unthemed gray shadcn template feel: every new surface uses these tokens (slate ramp, pill controls, tinted badges), never stock defaults or one-off hexes.
- **Don't** use solid saturated fills for destructive actions or status; the tinted-fill formula (10-20% background + colored text) is the only approved treatment.
- **Don't** use colored side-stripes (`border-left` > 1px) as accents, uppercase tracked eyebrows, or decorative blue: Wayfinding Blue is a landmark, one per screen.
