# UI Guide

Visual language guide for the Collab application. This file is the UI
counterpart to the [Codebase Reference](./codebase.md): the codebase reference
explains how the project is organized, while this guide explains how the
product should look, feel, and behave.

Use this document whenever adding or changing UI. If a new pattern is important enough to repeat, update this file in the same change.

## Purpose

This app should feel:

- focused rather than flashy
- dense but readable
- polished without looking corporate-generic
- expressive through theme, spacing, and motion rather than decorative clutter
- consistent across notes, kanban, canvas, graph, image, PDF, settings, and sidebar flows

The goal is not “pretty screens” in isolation. The goal is a coherent desktop product where every surface feels like it belongs to the same tool.

## Core Principles

### 1. Function first, but not plain

Utility comes first. Controls should be fast to scan, predictable, and low-friction. At the same time, the app should not collapse into bare browser-default UI or interchangeable SaaS chrome.

### 2. Reuse patterns before inventing new ones

If a layout, inspector, toolbar, dialog, card, or interaction style already exists, extend that pattern instead of creating a new local design language.

### 3. Build rhythm with spacing and hierarchy

Clarity should come from:

- strong grouping
- consistent gaps
- restrained color usage
- clear typography hierarchy
- deliberate contrast between primary and secondary information

### 4. Accent color is a signal, not wallpaper

`--primary` should identify action, focus, selection, progress, and important relationships. Do not flood entire screens with the accent color when a border, glow, highlight, or label would do the job better.

### 5. Motion should explain, not decorate

Animations should support orientation, state change, and spatial continuity. Avoid ornamental motion that adds delay without meaning.

## App-Wide Visual Rules

### Themes and tokens

- Use the existing theme system from `App.tsx` and `src/App.css`.
- Prefer CSS custom properties already defined by the app such as `--background`, `--foreground`, `--muted`, `--muted-foreground`, `--border`, `--accent`, and `--primary`.
- Do not introduce one-off hard-coded colors unless there is no suitable token and the use is extremely local.
- New UI should work across all supported themes and accent colors.

### Application controls

- Use the shared controls in `src/components/ui/` before adding a local control.
- Never expose browser or operating-system-native control chrome in product UI.
  Raw `<select>`, `<input type="color">`, date/time inputs, and unstyled native
  checkboxes, radios, or ranges break the app's theme and interaction language.
- When a shared control is missing, add a theme-token-based component there,
  preferably on a shadcn/Radix primitive, and make its keyboard, focus,
  disabled, and accessible-name behavior part of the component contract.
- Raw semantic HTML remains appropriate when it has no platform-native visual
  UI or when it is encapsulated inside the shared component implementation.
- Use `src/components/ui/color-picker.tsx` whenever a desktop workflow accepts
  an arbitrary colour. It provides a full HSV range, exact hex entry, optional
  opacity, presets, and keyboard operation without native control chrome. Mobile
  surfaces use their app-owned counterpart over the same shared colour math in
  `src/lib/color.ts`; do not reintroduce a native colour input or a fixed-only
  palette as the sole way to choose a colour.

### Surfaces

Primary surface types:

- app background
- document surfaces
- raised cards/panels
- overlays/dialogs/popovers
- interactive hover/focus states

Expected behavior:

- base screens should sit on `background`
- controls and grouped tool regions should usually use subtle card-like contrast rather than loud fills
- raised surfaces should use border, blur, or shadow gently
- avoid flat, high-contrast boxes unless the element is intentionally urgent or destructive

### Blur and translucency

- All app blur should go through the shared surface utilities in `src/App.css`.
- Prefer `glass`, `glass-panel`, `glass-strong`, or the shared `backdrop-blur-*-webkit` helpers.
- Do not introduce raw `backdrop-blur-*` Tailwind classes, inline `backdropFilter` styles, or one-off blur values inside components unless the shared blur system is being extended for everyone.
- Blur must remain optional per-platform. New surfaces should still look correct when blur is disabled by compatibility fallbacks on Windows, AppImage, or Linux WebKit.

### Borders and radii

- Rounded corners are part of the app language.
- Prefer the established radius scale already present in the codebase.
- Use borders to define grouping before reaching for stronger fills.
- High-emphasis interactive states can combine border tint + soft background tint + subtle shadow.

### Typography

- Respect the interface font and editor font settings from `uiStore`.
- Prioritize hierarchy through weight, opacity, and size before adding extra labels or separators.
- Titles should be compact and readable, not oversized.
- Secondary text should remain legible; do not hide core information behind hover-only behavior.

### Density

The app is desktop-first and can support moderately dense UI, but density must remain intentional.

Good density:

- short toolbars with grouped controls
- compact metadata rows
- tight but readable sidebars
- inspectors with consistent row structure

Bad density:

- tiny hit targets
- crammed controls with no grouping
- too many equal-weight elements competing at once
- hidden states that require pixel hunting

## Component and Layout Patterns

### Document headers

All document-style views should follow `DocumentTopBar`.

Rules:

- row 1 contains icon, title, path/subtitle, and compact metadata
- row 2 contains grouped controls when needed
- row 2 controls should use the shared `DocumentTopBar` control primitives instead of bespoke per-view button sizing
- controls in the secondary row should be horizontally scrollable rather than wrapping into chaos
- do not create bespoke document headers unless the shared pattern is being evolved for everyone

### Tool groups

Toolbar controls should be visually chunked into small groups.

Use:

- rounded group containers
- compact icon buttons sized through shared toolbar primitives when they live inside `DocumentTopBar`
- consistent hover/focus treatment
- tooltips for icon-only buttons

Avoid:

- long undifferentiated button rows
- mixing different button heights, paddings, or icon scales inside the same toolbar family
- mixing unrelated controls into one visual cluster

### Sidebars

Sidebar panels should feel compact and structured.

Rules:

- selection state must be obvious
- empty states should be explicit and calm
- search and filter inputs should match the app’s control styling
- destructive actions should remain discoverable but not dominant

### Cards

Used in canvas, kanban, lists, previews, and dialogs.

Rules:

- cards should feel slightly raised from the background
- headers, content, and metadata should have clear internal spacing
- card actions should appear intentional, not scattered
- hover affordances should never hide the card’s primary identity

### Inspectors and settings rows

Inspector and settings UIs should use predictable row patterns:

- label
- short explanatory text when needed
- control aligned consistently

Do not redesign each settings section from scratch. Variation should come from content, not structure.

## Interaction Rules

### Hover

Hover should reveal enhancement, not basic comprehension.

Allowed hover uses:

- show secondary controls
- strengthen a border or tint
- reveal a supplementary affordance

Disallowed hover uses:

- making core text readable only on hover
- hiding the only affordance for a primary task
- moving layout enough to cause jitter

### Focus

- Focus states must be visible and keyboard friendly.
- Prefer accent-tinted outlines, border changes, or glow tokens that match the rest of the app.
- Never remove focus indication without replacing it with an accessible equivalent.

### Drag and spatial interactions

For canvas-like or graph-like interactions:

- handles should be as small as possible while remaining usable
- idle visuals should stay quiet
- drag mode can temporarily reveal additional affordances
- geometry should align to the actual rendered content, not just naive bounding-box assumptions
- overlapping connectors should attempt to separate before fully stacking

### Conflict and error states

- Errors should be clear, compact, and actionable.
- Use destructive color sparingly and intentionally.
- Conflict dialogs should appear only when truly needed; simple cases should resolve automatically when safe.

## Motion

- Respect global animation settings from `uiStore`.
- Use existing motion timing tokens and app conventions.
- Good motion includes:
  - panel open/close continuity
  - hover transitions
  - selected-state emphasis
  - viewport or graph transitions that aid orientation
- Avoid:
  - long easing chains
  - bounce for serious workflows
  - simultaneous motion on too many elements

## Color Usage

### Primary accent

Use `--primary` for:

- active tool states
- selected items
- important links and relationships
- focus rings
- confirmation emphasis

Avoid:

- full-surface accent fills for ordinary controls
- using accent on multiple competing elements in the same cluster

### Muted text and surfaces

Muted styles should still be readable. They are for hierarchy, not concealment.

### Destructive styling

Reserve destructive color for:

- delete and purge actions
- unrecoverable warnings
- genuine error feedback

## Editor-Specific Rules

- Editor-adjacent UI should feel lightweight and non-disruptive.
- Inline tooling must not crowd the writing surface.
- Auxiliary affordances should stay subtle until relevant.
- Search, preview, inline helpers, and slash-command UI should look like part of the editor, not browser defaults.
- Markdown rendering helpers should preserve content readability above visual cleverness.

## Android Launcher Widgets

Widgets sit outside the app on someone else's home screen, so they have to earn
their place by looking like Collab rather than like a generic list.

Rules:

- Build every widget from the shared Glance primitives in
  `CollabAgendaWidget.kt` (`WidgetSurface`, `WidgetHeader`, `WidgetAccentButton`,
  `WidgetQuietButton`, `WidgetSectionLabel`, `WidgetRowCard`, `widgetCard`).
  Do not give one widget a bespoke shell.
- Carry the app's card language across: list rows are raised `surface` cards at
  the `--radius` corner radius, not flat text stacked on the background.
- A row's calendar or source colour belongs in a slim left rail, mirroring
  `.mobile-calendar-task-color`, rather than in a bullet glyph.
- The accent is for the widget's single primary action, plus today/selection
  marks. Secondary controls use the quiet surface treatment.
- The widget shell rounds itself with the launcher's own widget background
  radius so it sits in the grid like a system widget.
- Keep the picker preview layouts (`res/layout/collab_*_widget_preview.xml`,
  built from the shared `CollabWidgetPreview*` styles) in step with what the
  composable actually renders. A preview that flatters the widget is a bug —
  it sells a design the user will not get.
- **Preview layouts may only use views RemoteViews can inflate** — no bare
  `<View>`, `<Space>`, or custom views. Anything else fails to inflate in the
  launcher and shows a broken picker entry, which building and resource
  compilation both pass. `widgetPreviewsOnlyUseViewsRemoteViewsCanInflate`
  guards this; use `ImageView` for rails, bars, and spacers.
- Widget colours come from the app's own theme tokens resolved to sRGB in
  `agendaWidgetPalette`, and keep the stylesheet's split: `--card` behind
  content cards, `--surface` behind controls, `--border` for separators and
  card outlines, `--background` for month cells. Do not invent a lookalike
  shade — `palettesResolveTheAppThemeTokens` pins the resolved values.
- Glance has no border modifier, so a card's 1px outline is a border-coloured
  layer the card sits 1dp inside of (`WidgetCardFrame`). The subtle card fill
  needs that outline to read as a card.
- Compact sizes drop detail lines and section labels rather than shrinking hit
  targets or crowding the card.
- State colour is not decoration. `--destructive` marks only what the user has
  to recover from, the accent marks work actually in flight, and everything
  else — waiting, offline, paused — stays muted. A widget that colours ordinary
  states loses the ability to signal a real one.
- A widget must not render optimistic state. An action reports that it was
  accepted and then republishes; what actually happened arrives through the
  normal snapshot path, so the launcher can never show a success the native
  layer did not apply.

## Canvas, Graph, and Spatial Views

- Spatial surfaces should use the same theme tokens as the rest of the app.
- Lines, nodes, glows, and handles should derive from theme variables instead of hard-coded colors whenever possible.
- Spatial affordances should feel precise and intentional.
- Decorative glow is acceptable, but only when it improves readability or focus.
- Labels must remain legible against the active theme.

## Dialogs, Menus, and Popovers

- Prefer shadcn/ui components first, then Radix primitives, then raw HTML only when necessary.
- Dialogs should be compact, structured, and not overly wide.
- Menus and popovers should use the same border, blur, and shadow language as the rest of the app.
- Confirmation flows should make the safe action easy to identify.

## What To Avoid

- browser-default looking controls when a shared app style exists
- operating-system-native form controls anywhere in product-facing UI
- purple-by-default styling that ignores the active accent
- text that appears only on hover when it is core content
- oversized icons or affordances that overpower content
- local mini-design-systems inside a single component
- hard-coded visual values that bypass the theme system
- adding new header, settings, or inspector layouts when a shared pattern already exists

## Implementation Guidance

When making UI changes:

1. Check the [Codebase Reference](./codebase.md) for the correct structural home.
2. Check this file for the intended visual and interaction language.
3. Reuse existing tokens, layout shells, and interaction patterns.
4. Verify the result in context, not just in isolation.
5. Update this file if the change establishes a reusable new rule.

## Documentation Links

- Structural reference: [Codebase Reference](./codebase.md)
- Agent/project implementation rules: `AGENTS.md`
- Additional model-facing guidance: `CLAUDE.md`
