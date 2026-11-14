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
- Pick-one-of-a-list controls use `ui/select.tsx`. Its menu opens as a popper
  list under the trigger, styled like every other dropdown menu. In toolbars
  and header strips use `<SelectTrigger variant="ghost">`, so the picker reads
  as a toolbar button (font, size, number format) rather than a form field;
  forms and inspectors keep the default bordered field.

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

Every document and workspace view uses `DocumentTopBar`, including Calendar,
Databases, Graph (standalone only; inside a grid cell the cell header names it),
Grid and desktop Chats (`ConversationAccounts desktopHeader`; mobile keeps its
compact toolbar). Workspace sidebars use uppercase 11 px section headings with
an icon action on the right, and list rows carry a status dot instead of
stacked buttons. Settings groups its sections (You, App, Documents, Sync) and
titles the open section.

The header is one 48 px row, in a fixed order:

- kind icon, title, folder, then the `status` slot (save/sync pill, or a Save
  button while the document has unsaved changes)
- `meta` on the right: people on the document, a view switch when the view has
  modes (Board / Calendar / Timeline, Day / Week / Month, Digital / Electronic),
  at most one primary action (`variant="default"`), then the ⋯ `DocumentMoreMenu`
- export, print, insert-elsewhere and other rare document actions belong in ⋯
- do not create bespoke document headers unless the shared pattern is being
  evolved for everyone

### Tool strip and tool groups

The `secondary` slot is the single tool strip (`DocumentToolStrip`). Each child
group uses `documentTopBarGroupClass`:

- groups are flat and separated by a thin divider, never boxed
- the strip never scrolls sideways: groups that do not fit fold, whole and in
  order, into a "More" popover
- undo / redo first and find last, where the view has them; a `flex-1` spacer
  pushes trailing groups right
- labels only on menu buttons (`DocumentTopBarMenuButton`: Paragraph ▾,
  Insert ▾, Data ▾); everything else is a 32 px icon button with a tooltip
- rare actions go into named menus, not into an ever-longer row of icons
- no hidden modifier-click features: visual editors get their own menu items
- menus whose items open dialogs are non-modal (`modal={false}`)

Canvas-style editors (Logic, Canvas, Ink, Deck, SVG) keep tools on the canvas
instead, built from `components/layout/CanvasChrome.tsx`: a tool rail
(`FloatingBar` + `RailButton`) floating on the left, a selection bar that
appears only while something is selected, a status chip bottom-left, a page pill
bottom-centre and a `ZoomPill` bottom-right. Formatting for the current
selection (Deck text and object formatting) floats above the stage and appears
only when there is something to format.

Keep rails short. Related tools share one button with a corner arrow that opens
the rest of the group (Ink: Selection, Shape, Text, Insert, Measure, Inspect,
plus brushes under Pen); the button shows the tool last used from its group.
Insert actions in header strips are split by category (Deck: Text box, Media ▾,
Shape ▾, Chart ▾, Placeholder ▾) rather than one long scrolling menu.

Viewers (PDF, Image) read by default. Annotate and Edit are modes switched in
the header; only then does a tool rail (PDF/image ink, vertical
`PdfInkToolbar`) or the image edit bar appear. Page navigation, zoom, fit and
page layout share one pill at the bottom centre. Rare page actions (bookmark,
comment, snapshots, rotate, export annotated copy) live in ⋯. Undo / redo sit
in the header, before the primary action, in every canvas editor.

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

Every sidebar panel starts with the same 48 px vault header
(`layout/SidebarVaultHeader.tsx`), level with the document header. Its menu holds
the vault manager and **Close vault**, the way back to the start screen. Below
it, a segmented switch (`layout/sidebarSwitch.ts`: Files / Search / Tags, or
People / History) and then the panel. Rare panel actions (Trash, Graph, vault
manager) sit in a quiet 40 px footer rather than in the header. Files pinned from the
context menu sit in a Pinned group above the tree; rows show an unsaved dot and the
initials of whoever is editing.

The collaboration panel groups people by where they are: in the open document,
elsewhere in the vault (with a button that opens their document), offline
(collapsed), then you. **Follow** opens each document the followed person opens; a small
"Following" bar over the workspace shows it and stops it, and it ends on its own
when they go offline. History is a timeline of versions grouped by day, with
**Save version** as its one primary action.

The vault manager uses the settings dialog shape (880 × 600): a navigation column
grouped into **This vault** (Overview, then Members and Offline copy for hosted
vaults or Encryption for local ones) and **All vaults** (Vaults, Servers), and setting rows with the
label and description on the left and the control on the right. Password forms
open in small dialogs instead of sitting on the page.

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

### Dialogs and link previews

Math builders and document reconciliation dialogs must fit the available
viewport at small window sizes and app scaling. Bound both height and width,
keep their header/footer actions outside the scrolling body, and allow long
content to wrap or scroll inside that body. Use the shared ScrollArea rather
than letting content expand the whole modal.

Markdown file-link hover previews use the same document/PDF/image renderer as
the file tree. Keep embedded images in the document, and resolve file previews
against the current vault. The website-fetching master switch does not disable
vault previews; the existing link-hover preference controls their visibility.

## Motion

- Respect global animation settings from `uiStore`.
- Use existing motion timing tokens and app conventions.
- On activity bar navigation, slide the incoming workspace a short distance
  from below when moving down the list and from above when moving up. Start
  the entrance when the view is ready. Keep the activity bar and status bar
  in place, and respect reduced motion.
- Routine content updates stay opaque: expanding folders/tags, changing sidebar
  panels/settings categories and switching document views must not fade the new
  content from zero opacity or stack parent/child entrance animations. Keep
  document keys for correct session ownership; do not fix flashes by reusing an
  editor across different documents. Use hover/selection/geometry transitions
  for routine navigation. Dialogs and their backdrops appear fully opaque; do not
  add entrance/exit fades or scale animations to modal surfaces, including
  deferred loading dialogs. Menus may retain entrance motion.
- A transient refresh indicator must not replace a document entrance animation
  and restart that entrance when the indicator clears.
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

## Workspace Sidebars

Use the activity bar sidebar button for the left panel that belongs to the
active workspace. The label names the panel and changes between Show and Hide.
Calendar shows its calendar overview, Chats shows chats and teams, and
Databases shows connections. Document views use the vault sidebar. Collapsing
or expanding a panel animates its width and opacity with the standard app
motion. Reduced-motion preferences apply to the transition. Place Graph beside
Filter in the file tree because it opens a document tab.

## Dialogs, Menus, and Popovers

- Prefer shadcn/ui components first, then Radix primitives, then raw HTML only when necessary.
- Dialogs should be compact, structured, and not overly wide.
- Menus and popovers should use the same border, blur, and shadow language as the rest of the app.
- Confirmation flows should make the safe action easy to identify.

### Editor suggestion menus

The Markdown, SQL, and fenced code block editors use the shared CodeMirror suggestion style in
`src/components/editor/editorCompletionTheme.ts`. Use it for new editor
completion menus. The popup uses the active theme’s popover surface and border,
with rounded corners, a shadow, and a compact scrollable list. Use the foreground
color for suggestion labels, muted text for optional details, and an accent tint
for the active row. Use the shared Lucide icons in
`src/components/editor/editorCompletionIcons.ts` to identify suggestion kinds,
such as tables, columns, functions, and files. Icons are decorative and sit
beside the text label. Preserve keyboard navigation and selection behavior.

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

## Start Screen

The screen shown with no vault open (`components/vault/VaultPicker.tsx`) is a
rail beside one list. The rail holds the app-level destinations (Vaults, Chats,
Databases), the servers with a status dot (filled green connected, amber ring
signed out, grey ring known only from offline copies), and Settings. Clicking a
server filters the list to it; its (i) button opens the server details dialog,
which owns sign in, refresh, log out and new hosted vault. Below `md` the rail
collapses into a top bar with icon buttons and a servers menu. Chats and Databases opened
without a vault keep the same rail (without the server list) instead of the
vault ActivityBar, so Vaults is always one click away.

Every vault kind is a row in the same list; kind is an icon plus a filter chip,
never a section heading. Offline copies carry an amber "N pending" badge, and
secondary actions (remove from list, remove offline copy, server details) live
in the row's ⋯ menu. Signed-out servers collapse into one dismissible banner.
New vaults go through one dialog that picks the location first.

## Media Players

Video controls float over the picture on a dark scrim, the same in a tab and in
fullscreen, and fade while playing. Order is fixed: play, back/forward 10 s,
volume and time on the left; subtitles, settings, ambiance and fullscreen on
the right. Choices with several options go into the single settings menu (a
row only when there is a real choice), never as separate dropdowns in the bar.
Player states (opening, buffering, errors, the MP4 compatibility switch) are
shown on the picture, not as text under it. Audio uses a now-playing column
with one prominent round play button; lyrics take the second column only when
the track has them.

## Conversation Workspace

Chats uses the existing app activity rail for navigation back to files. A toolbar
places server-scoped people search at the top and the account/server dropdown at
the top right, showing the account avatar or initials; its menu marks the current
account and ends with **Account settings**. Use live directory suggestions and
account-scoped recent people (removable individually or with **Clear all**);
selecting a person opens the canonical direct chat immediately. Group composition is a separate named-group
flow with removable recipient chips and an always-reachable creation action.

Chat rows show a name-tinted avatar, the newest message preview, a Teams-style
time (clock today, then Yesterday, weekday, date) and an unread badge. Threads
group consecutive messages from one sender within five minutes, right-align the
account's own bubbles, and send on Enter (Shift+Enter for a new line). Avatars
come from the server for every person shown and fall back to tinted initials.

Messages are Markdown. The composer's **Format** button expands a toolbar (bold,
italic, strikethrough, lists, quote, link, inline code, code block; Ctrl+B/I/E/K)
in which Enter adds a line and Ctrl+Enter sends; the emoji button inserts from a
local, searchable set. Hovering, focusing or tapping a bubble shows quick
reactions, more reactions, Reply and a menu with Edit/Delete (own messages) and
Copy text. Replies quote the original and jump to it; edits are marked
**Edited**; deletions leave "This message was deleted." in place. Rendered
Markdown allows no raw HTML or images, and links open in the system browser.
Attachments are deferred to the extended file-sharing work.

**Settings → Chats** (desktop) and **Settings → Chats** (Android) hold the
device-local chat preferences with a live preview: chats and teams together or on
separate tabs; group chats mixed or in their own section; most-recent or
unread-first sort; comfortable or compact density; message previews; bubble or
flat message style; accent or neutral own-message colour; text size; grouping of
consecutive messages; and Enter-to-send. The sliders menu beside the Chats heading
offers the common ones plus **All chat settings…**. Chats, group chats and teams
can be pinned from a row's right-click (long-press on touch) or hover **⋯** menu,
and chats from the conversation header; pins sync with the server account and
appear in a **Pinned** section above the other chats.

Keep a secondary conversation sidebar visible beside desktop threads. Its
**Chat layout** menu persists a device-local preference: chats and teams together,
or separate Chats/Teams sidebar tabs. Expand a team to reveal channels; put team
membership and channel management in the main content area. At widths up to
700px, show either navigation or the selected content (the conversation header
replaces the search toolbar), with a visible Back control and Android hardware
Back support. Preserve independent scrolling,
keyboard navigation, readable server hostnames and theme tokens. Android also
needs explicit scoped styles because it does not load desktop Tailwind utilities.
