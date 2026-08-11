# BAU AI Design System

> Status: living document  
> Last reviewed: 2026-08-11  
> Scope: BAU AI web application

This document defines the visual language, interaction patterns, and implementation conventions for BAU AI. It describes both the system implemented today and the direction new UI should follow. When an existing screen and this guide disagree, new work should follow this guide and migrate the old pattern when it is safe to do so.

## 1. Product character

BAU AI is a professional construction-intelligence product. Its interface should feel:

- **Clear:** dense tender and company information remains scannable.
- **Calm:** neutral surfaces and restrained motion keep attention on decisions.
- **Capable:** AI features communicate evidence, progress, and uncertainty instead of appearing magical.
- **Approachable:** rounded geometry, concise language, and the violet brand color soften operational workflows.
- **Trustworthy:** destructive, incomplete, generated, and unavailable states are always explicit.

Use visual emphasis in this order: task outcome, primary action, supporting context, decoration.

## 2. Sources of truth

The design system is implemented through the following layers, in priority order:

1. Semantic theme tokens in [`app/globals.css`](../app/globals.css).
2. Shared primitives in [`components/ui`](../components/ui).
3. Shared feature patterns, such as [`components/settings/settings-ui.ts`](../components/settings/settings-ui.ts), while they are migrated to semantic tokens.
4. Local feature styling only when no reusable pattern exists.

The application uses Tailwind CSS v4, Base UI behavior primitives, `class-variance-authority` for variants, and `cn()` from [`lib/utils.ts`](../lib/utils.ts) for class composition. Use Lucide for interface icons.

### Implementation rule

Prefer a semantic class such as `bg-primary`, `text-muted-foreground`, or `border-border` over an arbitrary value such as `bg-[#6516dc]`. An arbitrary value is acceptable only for a documented brand asset, data-visualization series, or a temporary migration case.

## 3. Brand

### Name

Write the product name as **BAU AI** in prose and accessible labels. Do not write `BauAI`, `BAU.AI`, or `Bau AI`.

### Logo assets

| Asset | Use |
| --- | --- |
| [`public/brand/logo_name.svg`](../public/brand/logo_name.svg) | Primary wordmark on light backgrounds |
| [`public/brand/logo_small.svg`](../public/brand/logo_small.svg) | Compact navigation and square placements |
| [`public/brand/bau-ai-logo-white.svg`](../public/brand/bau-ai-logo-white.svg) | Wordmark on dark or photographic backgrounds |
| [`public/brand/favicon.svg`](../public/brand/favicon.svg) | Browser and small app icon |

Keep the logo's aspect ratio. Do not recolor, rotate, outline, crop, or add effects to it. Leave clear space around the mark equal to at least the width of its narrowest vertical stroke.

The logo gradient runs from electric blue `#001AFF` to brand violet `#5000A8`. The gradient belongs to brand artwork; ordinary interface controls use a solid semantic color.

## 4. Color

BAU AI is currently a light-only interface. The root declares `scheme-light`; do not add isolated dark-mode styles until a complete dark theme and its semantic tokens exist.

### Core semantic tokens

These tokens are currently defined in `app/globals.css` and are the canonical choices for new UI.

| Token / utility | Value | Intended use |
| --- | --- | --- |
| `background` / `bg-background` | `#FFFFFF` | Cards, controls, dialogs, menus |
| `foreground` / `text-foreground` | `#191724` | Primary text and high-emphasis icons |
| `primary` / `bg-primary` | `#5000A8` | Primary actions, selected states, links |
| `primary-foreground` | `#FFFFFF` | Content on primary surfaces |
| `border` / `border-border` | `#E7E1EB` | Dividers and standard boundaries |
| `input` / `border-input` | `#E4E0E7` | Form-control boundaries |
| `ring` / `ring-ring` | `#7430C3` | Keyboard focus and active control rings |
| `muted` / `bg-muted` | `#F3F1F6` | Subtle fills, skeletons, inactive surfaces |
| `muted-foreground` | `#8D8797` | Secondary text, metadata, placeholders |
| `card` / `bg-card` | `#FFFFFF` | Content cards |
| app canvas | `#F8F8F8` | Global page background |

Never use muted text for essential instructions or the only indication of state. Body copy should normally use `text-foreground/90`; supporting copy can use `text-muted-foreground`.

### Semantic feedback

Use the shared [`Badge`](../components/ui/badge.tsx) vocabulary for compact statuses.

| Meaning | Tailwind family | Examples |
| --- | --- | --- |
| Success / positive | `emerald` | completed, available, high fit |
| Warning / attention | `amber` | expiring, incomplete, medium fit |
| Information | `sky` | neutral system information |
| Danger / destructive | `rose` or `red` | failed, remove, low confidence requiring action |
| Neutral | `muted` | draft, unavailable, not started |
| Product / selected | `primary` | active, AI-generated, chosen |

Feedback color must be accompanied by text, an icon, or both. Do not communicate status through color alone.

### Feature and data colors

The dashboard's blue accents and kanban column colors are feature/data colors, not replacements for `primary`. They may distinguish agents, series, or pipeline stages. Keep their meaning stable within a view and provide a visible legend when more than one color is present.

### Token migration

Auth, onboarding, settings, and dashboard components contain historical violet and neutral aliases such as `#6516DC`, `#6515B7`, `#3146ED`, and `#85818C`. When touching those components:

1. Map the value to a semantic token when the meaning is equivalent.
2. Add a named theme token when the color has a durable, distinct role.
3. Keep an arbitrary value only when it represents branded artwork or data.

Do not introduce another near-duplicate hex value.

## 5. Typography

The application uses **Inter Variable**, loaded in [`app/layout.tsx`](../app/layout.tsx). The fallback stack is `Inter, Arial, sans-serif`.

### Type roles

| Role | Suggested classes | Usage |
| --- | --- | --- |
| Display | `text-3xl sm:text-4xl font-bold tracking-tight` | Rare landing or empty-state message |
| Page title | `text-2xl font-bold tracking-tight` | One per page |
| Section title | `text-base font-semibold` | Card and panel headings |
| Card title | `text-sm font-semibold` | Repeated content titles |
| Body | `text-sm leading-relaxed` | Explanations and long-form content |
| Compact body | `text-xs leading-relaxed` | Dense application content |
| Label | `text-xs font-semibold` | Form and data labels |
| Metadata | `text-[11px] text-muted-foreground` | Dates, counts, secondary context |
| Eyebrow | `text-[11px] font-bold tracking-wider uppercase` | Section category, used sparingly |
| Code / identifiers | `font-mono text-[10px]` | CPV codes and machine identifiers |

Sentence case is the default. Reserve uppercase for short eyebrows and table headings. Use real heading elements in document order; visual size does not determine semantic rank.

Prefer font weights 400, 500, 600, and 700. Avoid synthetic weights such as `650` or `750` in new components unless a visual regression requires them.

## 6. Spacing and sizing

Use Tailwind's spacing scale, which follows a 4 px base rhythm. The most common gaps are:

| Relationship | Size | Utility examples |
| --- | --- | --- |
| Icon to label | 4–6 px | `gap-1`, `gap-1.5` |
| Closely related controls | 8 px | `gap-2` |
| Fields in a group | 12–16 px | `gap-3`, `gap-4` |
| Card padding | 12–24 px | `p-3`, `p-4`, `p-6` |
| Section separation | 24–32 px | `gap-6`, `gap-8` |
| Page gutters | 16 px mobile, 24–48 px desktop | `px-4 sm:px-6 lg:px-12` |

Use `size-*` for square controls and icons. Standard interactive heights are 32 px for compact controls, 36 px for regular toolbar actions, and 44–48 px for primary form controls. A touch target should be at least 44 × 44 px when the surrounding layout allows it.

## 7. Shape, border, and elevation

### Radius

Use radius to communicate containment level, not decoration.

| Element | Radius |
| --- | --- |
| Small tags and nested controls | `rounded-md` |
| Buttons and inputs | `rounded-lg` |
| Popovers and inner panels | `rounded-xl` |
| Cards and dialogs | `rounded-2xl` |
| Prominent auth/onboarding surfaces | `rounded-2xl` or `rounded-3xl` |
| Avatars, status dots, pills | `rounded-full` |

Avoid adding a new arbitrary radius when a standard utility is visually equivalent.

### Borders

Use a 1 px `border-border` boundary by default. Use a dashed border only for drop zones and empty states. Selected components may combine `border-primary/30` with a subtle `bg-primary/5`; avoid heavy, fully saturated outlines.

### Elevation

The system uses restrained shadows:

- `shadow-xs` for cards that need separation from the canvas.
- `shadow-sm` for selected tabs and floating labels.
- `shadow-lg` for popovers.
- `shadow-xl` for modal dialogs.

Do not use shadow as the only boundary. Floating surfaces should normally also have a border. Avoid stacking multiple bespoke shadows in new UI.

## 8. Icons and imagery

Use icons from `lucide-react`.

- 16 px: inline and compact controls.
- 18 px: standard toolbar and navigation actions.
- 20–24 px: empty states or prominent panel actions.
- Default to Lucide's standard stroke; use approximately `1.7` in primary navigation.
- Use `aria-hidden` for decorative icons. Icon-only buttons require an accessible name and usually a tooltip or `title`.

Agent portraits live under [`public/agents`](../public/agents). Display them as circles with `object-cover`. Provide meaningful alternative text only when the person's identity is not already present beside the image; otherwise use `alt=""`.

## 9. Core components

New UI should compose the primitives in [`components/ui`](../components/ui) before creating local equivalents.

### Button

Use [`Button`](../components/ui/button.tsx) for actions.

| Variant | Use |
| --- | --- |
| `default` | The single primary action in a local region |
| `outline` | Secondary actions and cancel |
| `secondary` | Lower-emphasis action on a neutral surface |
| `ghost` | Toolbars, menus, and low-emphasis icon actions |
| `destructive` | Actions that remove or irreversibly change data |
| `link` | Action presented in reading flow |

Use verb-led labels: “Save changes,” “Generate report,” “Remove tender.” Show a progress label or spinner for asynchronous actions and prevent duplicate submission while pending.

> Implementation note: `secondary` and `destructive` are referenced by the button primitive but do not yet have complete global color tokens. Define those tokens before relying on these variants in a new visual context.

### Input and field

Use [`Input`](../components/ui/input.tsx) as the base control. Every field needs a persistent visible label. Supporting text goes below the field; validation text should explain how to recover.

States:

- Default: `border-input`.
- Hover: a slightly stronger border, without shifting layout.
- Focus: `border-ring ring-3 ring-ring/30`.
- Invalid: danger border, danger message, and `aria-invalid`.
- Disabled: non-interactive cursor and reduced opacity; preserve readable text.

Placeholder text is an example, not a replacement for a label.

### Badge

Use [`Badge`](../components/ui/badge.tsx) for short categorical states. Keep labels to one or two words where possible. A badge should not be used as a button unless it has explicit interactive styling and semantics.

### Tabs

Use [`Tabs`](../components/ui/tabs.tsx) to switch between peer views without changing context. Keep labels short, preserve keyboard navigation from Base UI, and avoid more tabs than fit at the smallest supported width. Use navigation links instead when each destination should have its own URL and page lifecycle.

### Dialog

Use [`Dialog`](../components/ui/dialog.tsx) for focused decisions and short tasks. Put the title and concise description in the header, scrollable content in the body, and actions in the footer. The safest action appears first on mobile due to the reversed footer layout; on desktop, the primary action sits at the right.

Confirmation is required for destructive or hard-to-reverse actions. Name the affected object in the dialog.

### Popover

Use [`Popover`](../components/ui/popover.tsx) for lightweight anchored choices. Use a dialog on small screens when content is complex, requires multiple fields, or cannot tolerate clipping.

### Progress and skeleton

Use [`Progress`](../components/ui/progress.tsx) when a determinate value exists and [`Skeleton`](../components/ui/skeleton.tsx) while the shape of loading content is known. Prefer a textual status for long-running AI work. Do not show a fake percentage.

### Cards

Cards use `rounded-2xl border border-border bg-card`, with `shadow-xs` only when the surrounding canvas needs extra separation. A card should contain one coherent object or decision. Do not nest more than one card level; use dividers or muted sections inside instead.

### Empty, error, and unavailable states

Each state should contain:

1. A concise title describing the situation.
2. One sentence of context or recovery guidance.
3. A relevant action when the user can resolve it.

Use a dashed border for an actionable empty drop zone, not for ordinary errors. “Coming soon” and unavailable features must look disabled and must not respond to pointer or keyboard activation.

## 10. Layout and responsive behavior

Application pages use a neutral canvas with white content surfaces. Prefer a readable centered maximum width over stretching text and forms across the viewport.

The dashboard shell currently uses these product-specific transitions:

- Above 820 px: full or collapsed side navigation.
- 561–820 px: icon-only side navigation.
- 560 px and below: bottom navigation.

Feature layouts should otherwise use Tailwind's standard responsive breakpoints. Build from the smallest layout upward. Avoid fixed widths unless paired with `max-w-*`, `minmax()`, or a small-screen override.

Dense desktop tables need a deliberate small-screen treatment: horizontal scrolling, a reduced column set, or a card representation. Do not squeeze every desktop column into the mobile viewport.

Use `svh` rather than `vh` for full-height mobile layouts.

## 11. Motion

Motion should explain state changes and preserve spatial context.

- Small overlays: 150 ms.
- Dialogs and tab content: 200–220 ms.
- Use opacity, transform, border color, and shadow transitions.
- Keep hover movement to 1–4 px.
- Use continuous animation only for active progress or a live long-running process.
- Add `motion-reduce` or `motion-safe` behavior for non-essential motion.

The shared `tender-tab-in` and `report-aurora` keyframes are defined in `app/globals.css`. Do not create a second animation for the same purpose.

## 12. Accessibility

Target WCAG 2.2 AA for application UI.

- All functionality must be reachable and operable by keyboard.
- Preserve a visible focus ring; never remove outlines without an equivalent focus treatment.
- Text and meaningful icons need at least 4.5:1 contrast; large text needs 3:1.
- Interactive component boundaries and focus indicators need at least 3:1 against adjacent colors.
- Associate labels, descriptions, errors, and controls programmatically.
- Use native elements first: `button` for actions and `a`/`Link` for navigation.
- Announce asynchronous results and validation changes where appropriate.
- Trap focus and restore it when dialogs close; shared Base UI primitives provide the behavioral foundation.
- Respect `prefers-reduced-motion`.

Do not rely on hover to reveal essential information or actions.

## 13. Content and localization

User-facing copy is localized with `next-intl`; English and German messages live in [`messages/en.json`](../messages/en.json) and [`messages/de.json`](../messages/de.json).

- Add both translations in the same change.
- Allow labels to grow by at least 30% for German.
- Do not concatenate translated fragments into a sentence.
- Use locale-aware date and number formatting.
- Prefer plain language and short, direct sentences.
- Refer to the assistant by its visible agent name when relevant; label AI-generated or inferred content honestly.

## 14. AI interaction patterns

AI output must remain inspectable and reversible.

- Show evidence with citations or tender references when a factual claim comes from source material.
- Distinguish loading, partial streaming, complete, and failed states.
- Present match scores with a label and rationale, not a number alone.
- Use “Generate” or “Ask” for AI-triggering actions rather than implying an immediate deterministic result.
- Preserve the user's text and attachments if generation fails.
- Ask for confirmation before an AI recommendation changes tender state or removes data.

## 15. Engineering conventions

### Preferred pattern

```tsx
import { Button } from "@/components/ui/button";

export function SaveAction() {
  return <Button type="submit">Save changes</Button>;
}
```

### Styling checklist

Before adding a class or component:

1. Check whether a shared primitive already provides the behavior.
2. Use semantic color utilities.
3. Use the standard spacing and radius scales.
4. Include hover, focus, disabled, loading, and error states as relevant.
5. Verify keyboard behavior and accessible naming.
6. Check the smallest supported width and long German copy.
7. Add a reusable variant when the same pattern appears three times.

### Definition of done for UI work

- Uses or extends a shared primitive where appropriate.
- Has no unexplained one-off color, radius, or shadow.
- Works at mobile, intermediate, and desktop widths.
- Supports keyboard navigation and visible focus.
- Handles empty, loading, error, disabled, and success states that apply.
- Includes English and German copy.
- Does not create layout shift during loading or validation.
- Respects reduced-motion preferences.

## 16. Known system gaps

The following are deliberate follow-up items, not patterns to copy:

- Complete semantic tokens for `secondary`, `destructive`, and their foreground colors.
- Consolidate legacy arbitrary violet, blue, neutral, and danger hex values.
- Standardize form-field markup across auth, onboarding, and settings.
- Replace remaining feature-local button and card implementations with shared primitives.
- Add automated accessibility checks and component visual regression coverage.
- Define a dark theme only if the product commits to supporting it end to end.

When resolving a gap, update this document and the underlying shared primitive in the same change.
