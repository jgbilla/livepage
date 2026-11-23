# Livepage design language

Livepage is a page that people and agents write on together. The design has one job: keep the
writing in front, and make it obvious at a glance **who** is doing **what**, whether that is a
person or an agent, and whether it is happening right now.

Everything here is implemented as CSS custom properties in
[`apps/web/src/design/tokens.css`](apps/web/src/design/tokens.css), and the same tokens are
injected into sandboxed HTML blocks so that UI an agent builds looks like it belongs on the page.

## Principles

1. **The page is the hero.** Chrome is quiet: neutral paper tones, hairline borders, no color unless
   color means something. If a screen looks busy, remove before adding.
2. **Color carries meaning, and each meaning has one color.**
   - **Ink** (the text color) is the primary action: *Share*, *Save*, *New page*.
   - **Blue accent** is navigation and focus: links, page links, the selected item, focus rings.
   - **Violet is agents, and only agents.** An agent's avatar, caret, comments, streaming blocks,
     edits in history, and the *Ask AI* button. If something is violet, an AI did it or will do it.
   - **Amber is comments**, like a highlighter.
   - Green, red and orange are reserved for status and diffs.
3. **People are round, agents are square.** A person is a circle with initials in their own hue.
   An agent is a violet squircle with a spark. The shape reads before the color, so it survives
   color blindness, grayscale screenshots and print.
4. **Live things move, settled things don't.** Motion signals presence and work in progress: an agent's
   caret breathes, a block being streamed shimmers, a panel slides in. Nothing loops once it is done,
   and everything respects *reduce motion*.
5. **One system everywhere.** The editor, sidebar, dialogs, published pages and HTML blocks share
   the same type scale, spacing, radii and icons. No one-off values.
6. **Fast is a feature.** System fonts, one inline icon set, no webfont or icon-font download, CSS
   only for motion.

## Type

System fonts, so the first paint is instant and text looks native on each OS.

| Token | Use |
|---|---|
| `--lp-font-sans` | Interface and default prose |
| `--lp-font-serif` | Published pages (reading mode) |
| `--lp-font-mono` | Code, kbd, tokens |

A 1.2 scale anchored on **14px interface** text and **16px prose**:

| Token | Size | Use |
|---|---|---|
| `--lp-text-2xs` | 11 | Uppercase section labels, kbd |
| `--lp-text-xs` | 12 | Meta, timestamps, badges |
| `--lp-text-sm` | 13 | Secondary UI, hints |
| `--lp-text-md` | 14 | Default UI: buttons, menus, sidebar |
| `--lp-text-base` | 16 | Prose |
| `--lp-text-lg` | 18 | Dialog titles, h3 |
| `--lp-text-xl` | 22 | h2, screen sections |
| `--lp-text-2xl` | 28 | h1 in a page, screen titles |
| `--lp-text-3xl` | 40 | The page title (scales down on phones) |

Weights: 400 body, 500 UI emphasis, 600 headings and selected items, 700 the page title only.
Big headings get slight negative tracking (`--lp-tracking-tight`). Section labels are 11px caps
with `--lp-tracking-caps`. Prose line height is 1.7 on a 720px measure; UI is 1.5.

## Space

A 4px grid: `--lp-space-1` (4) … `--lp-space-16` (64). Use 8 between related items, 12–16 inside
components, 24–32 between sections, 48+ between page regions. Controls are 28 (compact),
32 (default) or 40 (prominent) tall, and at least 40 on touch screens.

## Shape

| Token | Radius | Use |
|---|---|---|
| `--lp-radius-xs` | 4 | Inline marks, kbd, page links |
| `--lp-radius-sm` | 6 | Menu items, small icon buttons |
| `--lp-radius-md` | 8 | Buttons, inputs, sidebar rows |
| `--lp-radius-lg` | 12 | Cards, blocks, popovers, menus |
| `--lp-radius-xl` | 16 | Dialogs, sheets |
| `--lp-radius-full` | pill | People, pills, chips |
| `--lp-radius-agent` | 30% | Agents (squircle) |

## Color

Semantic tokens only; raw hex lives in `tokens.css`. Each has a light and a dark value. Dark follows
the OS unless the person picks Light or Dark in the sidebar (stored per browser, applied as
`<html data-theme>` before first paint).

| Role | Tokens |
|---|---|
| Canvas | `--lp-bg` (page), `--lp-bg-subtle` (sidebar), `--lp-surface` (cards, inputs), `--lp-surface-overlay` (menus, dialogs), `--lp-surface-sunken` (code, wells) |
| Interaction | `--lp-hover`, `--lp-active` (translucent, so they work on any surface) |
| Lines | `--lp-border` (hairlines), `--lp-border-strong` (inputs on hover, dividers that must show) |
| Text | `--lp-text`, `--lp-text-secondary`, `--lp-text-tertiary`, `--lp-text-placeholder` |
| Ink (primary action) | `--lp-ink`, `--lp-ink-hover`, `--lp-on-ink` |
| Accent (links, focus) | `--lp-accent`, `--lp-accent-text`, `--lp-accent-soft`, `--lp-focus-ring`, `--lp-selection` |
| Agent | `--lp-agent`, `--lp-agent-text`, `--lp-agent-soft`, `--lp-agent-gradient`, `--lp-on-agent` |
| Comments | `--lp-comment`, `--lp-comment-soft`, `--lp-comment-strong` |
| Status | `--lp-success`, `--lp-warning`, `--lp-danger` (+ `-soft`) |
| Diff | `--lp-diff-add`, `--lp-diff-del` (+ `-strong` for inline changes) |
| People | `--lp-person-1` … `--lp-person-7` (hold white initials, avoid violet) |
| Categories | `--lp-cat-1` … `--lp-cat-8` (tags in the graph, charts in blocks) |

Text on every surface meets WCAG AA (4.5:1) for body and secondary text; tertiary text is for
non-essential meta only.

## Elevation

Depth is a hairline border plus a soft, warm shadow. Three levels, and nothing else casts a shadow:

| Level | Token | Use |
|---|---|---|
| 1 | `--lp-shadow-1` | Raised controls (segmented control thumb, active tab) |
| 2 | `--lp-shadow-2` | Popovers: menus, the comment button, footnote cards, link menu, docked panels |
| 3 | `--lp-shadow-3` | Overlays: dialogs, the quick switcher, the mobile drawer |

Overlays sit on `--lp-scrim`. Layers follow `--lp-z-*` (sticky < panel < drawer < popover < modal < toast).

## Motion

| Token | Duration | Use |
|---|---|---|
| `--lp-duration-instant` | 80ms | Hover and press feedback |
| `--lp-duration-fast` | 140ms | Menus, tooltips, chevrons |
| `--lp-duration-base` | 200ms | Panels, dialogs |
| `--lp-duration-slow` | 320ms | Drawers, page-level transitions |

Arriving things ease out (`--lp-ease-out`), leaving things ease in. Menus scale from 98% and fade;
panels slide 12px; dialogs rise 8px. Loops are only for live work (agent caret, streaming shimmer,
a running step) and stop when it ends. With *reduce motion* every duration becomes 0.

## Icons

One set: a curated subset of [Lucide](https://lucide.dev) (ISC), inlined in
[`design/Icon.tsx`](apps/web/src/design/Icon.tsx). 24px grid, 1.75px round stroke, `currentColor`,
rendered at 16px in UI (14px in dense rows, 18px in the top bar on phones). No emoji in the interface:
emoji render differently on every OS and can't be colored. Icon-only buttons always have an
`aria-label`, and the most important actions keep a text label on wide screens.

Use `<Icon name="sparkles" />` for anything AI, `comment` for comments, `link` for links,
`graph` for the graph, `today` for daily pages. Add new icons to the set rather than reaching for emoji.

## People and agents

This is the part of Livepage no other editor has, so it gets its own grammar.

| | Person | Agent |
|---|---|---|
| Avatar | Circle, initials, own hue (`--lp-person-n`) | Squircle (`--lp-radius-agent`), violet gradient, spark icon |
| Caret | Solid 2px line in their hue, name label as a pill | Violet line with a soft glow that breathes while it types; label starts with a spark |
| Selection | Their hue at low opacity | Violet at low opacity |
| Name | Plain text | Name with a small *Agent* tag or spark |
| Mention | Blue chip (`--lp-accent-soft`) | Violet chip (`--lp-agent-soft`) |
| Comment | Circle avatar | Squircle avatar, comment card has a violet edge |
| In history | Chip outlined in their hue | Violet chip with spark |
| Work in progress | — | Violet shimmer on the block being streamed, running steps pulse |

The *Ask AI* button, the assistant panel and agent-written HTML blocks all use the agent palette,
so "violet = AI" holds across the app.

## Components

All in `styles.css`, built only from tokens.

- **Buttons.** `primary` (ink fill), default (surface + hairline), `ghost` (no border, hover fill),
  `danger` (red text, red hairline), `agent` (violet; Ask AI). Heights 28/32/40. Icon + label, 6px gap.
  Icon-only buttons are square.
- **Inputs and selects.** Surface fill, hairline, 8px radius, 32–36px tall, strong border on hover,
  accent ring on focus.
- **Menus and popovers.** Overlay surface, 12px radius, level 2, 4–6px padding, items are 32px rows
  with a 16px icon column and 6px radius hover fill.
- **Dialogs.** Overlay surface, 16px radius, level 3, 24px padding, title 18/600, actions right-aligned.
  On phones they become bottom sheets.
- **Panels** (comments, Ask AI, history). Dock to the right with a hairline and level 2, slide in.
  Full-screen sheets on phones. Header 48px with a title and a close icon button.
- **Segmented controls.** Sunken track, raised thumb (level 1).
- **Tags/chips.** Pills, 24px, neutral fill; `#` glyph in tertiary text.
- **Badges.** 20px pills: neutral, success (Published), agent (Template, Agent).
- **Tabs.** Underline tabs: the active tab has ink text and a 2px ink underline.
- **Sidebar.** `--lp-bg-subtle`. One row rhythm: 28px rows (36px on touch), a 16px chevron slot,
  a 16px icon in tertiary color, then the label; nesting indents 16px with a faint guide line. Nav rows
  (Search, Today, Home, Graph) on top, then foldable sections (Pages, Views, Templates, Tags) with 11px
  caps labels. Actions show on hover (always on touch). Selection is a quiet `--lp-active` fill.
  Dragging dims the row; the target folder gets an accent ring and opens after a moment. The right edge
  resizes the sidebar (208–440px, double-click resets), remembered per browser.
- **Blocks** (HTML, mind map, code, tables). Surface, hairline, 12px radius, a slim header bar in
  12px secondary text; selected blocks get the accent ring.

## HTML blocks

Every HTML block gets the tokens as CSS variables on `:root`, in the current theme, plus a few
defaults (system font, text color, transparent background), so a block written with
`var(--lp-text)`, `var(--lp-accent)`, `var(--lp-radius-lg)` or `var(--lp-font-sans)` matches the
page and switches with light and dark. The block also gets `data-theme="light|dark"` on `<html>`.
Agents are told about this in the MCP and HTTP tool descriptions.

## Checklist for new UI

- Uses only `--lp-*` tokens; no raw hex, no new font sizes or radii.
- Violet only if it is about an agent.
- Has hover, focus-visible, active and disabled states.
- Works at 320px wide and in dark mode; `pnpm check:responsive` passes.
- Icons from `design/Icon.tsx`, never emoji.
