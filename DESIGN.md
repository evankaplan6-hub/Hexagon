---
name: The Hexagon floor
description: Apple's own look for a paper trading desk, phone first, light or dark as the device is set. Normative source is public/tokens.css; this file mirrors it.
colors:
  page: "light-dark(#f2f2f7, #000000)"
  card: "light-dark(#ffffff, #1c1c1e)"
  segment-on: "light-dark(#ffffff, #636366)"
  ink-strong: "light-dark(#1d1d1f, #f5f5f7)"
  ink-body: "light-dark(#3c3c43, #d1d1d6)"
  ink-label: "light-dark(#5d5d62, #9d9da4)"
  accent: "light-dark(#0066cc, #2997ff)"
  focus: "light-dark(#0071e3, #2997ff)"
  gain: "light-dark(#1b7d36, #30d158)"
  loss: "light-dark(#d70015, #ff453a)"
  gain-line: "light-dark(#34c759, #30d158)"
  loss-line: "light-dark(#ff3b30, #ff453a)"
  state-ok: "light-dark(#1b7d36, #30d158)"
  state-warn: "light-dark(#c93400, #ff9f0a)"
  state-bad: "light-dark(#d70015, #ff453a)"
  fill: "light-dark(rgba(118, 118, 128, .12), rgba(118, 118, 128, .24))"
  line-1: "light-dark(#e5e5ea, #38383a)"
  line-2: "light-dark(#d1d1d6, #48484a)"
  part-crypto: "light-dark(#ff9500, #ff9f0a)"
  part-stocks: "light-dark(#007aff, #0a84ff)"
  part-games: "light-dark(#5856d6, #5e5ce6)"
  part-side: "light-dark(#af52de, #bf5af2)"
  part-lab: "light-dark(#30b0c7, #40c8e0)"
  icon-top: "#3a3a3c"
  icon-bottom: "#0c0c0d"
  icon-glyph: "#ffffff"
  icon-core: "#30d158"
typography:
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0"
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  figure:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "52px"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.03em"
rounded:
  md: "14px"
  lg: "22px"
  xl: "28px"
  pill: "999px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "20px"
  space-6: "24px"
components:
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink-body}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
  state-pill:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink-strong}"
    rounded: "{rounded.pill}"
    height: "30px"
  segment-button:
    textColor: "{colors.ink-body}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  segment-button-on:
    backgroundColor: "{colors.segment-on}"
    textColor: "{colors.ink-strong}"
  banner:
    textColor: "{colors.ink-strong}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  sheet:
    backgroundColor: "{colors.page}"
    rounded: "{rounded.xl}"
---

# Design System: The Hexagon floor

> **Status: locked.** The floor at `/` (`public/desk.html`, `public/desk.css`, `public/desk.js`) is drawn from `public/tokens.css`. That file is the source of truth: if this file and it disagree, `tokens.css` wins and this file is stale. Product context is in `PRODUCT.md`. The repo's `CLAUDE.md` beats any design skill.

## Overview

**Creative North Star: "Apple's own app, for one reader's paper money."**

Since 2026-09-29 the floor is drawn the way Apple draws its apps (Evan: "making the website iOS and macOS and Apple beautiful"): San Francisco, Apple's system colours as light-dark() pairs, cards on a grouped page, a translucent bar that blurs what scrolls under it, a large title on a phone that scrolls away, segmented controls and sheets as iOS draws them, and a tab bar along the foot of a phone. It is an **Operate** surface: the reader is checking a desk, so scanning, consistency and familiar controls outrank expression, and brand lives in precise details. The reference is Apple's own Stocks app first (see `docs/design/references/README.md`).

The page is laid out for reading: nothing under 12px, figures all one width (`tabular-nums`), money signed and coloured only by direction. Four views follow what is happening (Today, Games, Markets, Activity). Everything that leads somewhere opens a sheet or a view. No pixel room and no bots are drawn (Evan's call, 2026-09-25).

**Key Characteristics:**
- Light or dark as the device is set (`color-scheme: light dark`).
- The system font only; no web font is loaded on the floor.
- Cards at 22px radius on a grouped page; sheets at 28px.
- Text is 4.5:1 or better on every surface in both appearances (`tools/tokens-test.js`).
- A colour never stands alone: a swatch sits beside the name of the part it marks.

## Colors

Apple's system palette in two appearances, named by job in `tokens.css`. `desk.css` writes no colour of its own (held by `tools/tokens-test.js`). Values are in the frontmatter; do not restate them here.

### Neutral
- **Page** (`--bg-0`): iOS's grouped background. **Card** (`--bg-1`): a card or sheet face. **Segment on** (`--seg-on`): the picked segment.
- **Ink strong / body / label** (`--ink-1/2/3`): figures and names; body text; labels, times and units. Nothing on the page is fainter than `--ink-3`.
- **Lines** (`--line-1/2`, `--rule-1/2`): list separators, scrollbars and the chart's grid.
- **Material, scrim and fills** (`--material`, `--scrim`, `--fill-1/2`): the blurred bar, the dim behind a sheet, a chip or a segmented control's track.

### Primary
- **Apple blue** (`--accent`): links and text buttons only. **Focus blue** (`--focus`): the keyboard ring.

### Money and state
- **Gain and loss** (`--gain`, `--loss`; chart lines `--gain-line`, `--loss-line`): which way money went. Zero is neither (`.zero`, no sign, no green).
- **Desk state** (`--ok`, `--warn`, `--bad`): working, waiting or amber, stopped or silent. Named apart from gain and loss because it is a different question, though they share hues.

### Parts
- **Crypto** orange, **SPY** blue, **games** indigo, **arbs and maker** purple, **lab** teal (`--book-crypto`, `--book-stocks`, `--part-games`, `--part-side`, `--part-lab`): a swatch beside a part's name, its line on a chart, a game tile's pick. No chart draws two.

### Named Rules
**The Tokens Only Rule.** `desk.css` and `desk.js` take every colour from `tokens.css`. A hex, `rgb()` or colour name in them fails `tools/tokens-test.js`.

**The 4.5 Rule.** Any new text colour is added to the test's ink list and reads at 4.5:1 on both grounds in light and dark.

**The Direction Only Rule.** Green and red mean money went up or down. They do not decorate.

## Typography

**Font:** the system's own (`--sans`: San Francisco on an iPhone or a Mac, Segoe UI or Roboto elsewhere), figures all one width.

**Character:** plain and Apple-like. Sentence case, tight tracking on titles, weight (not size) carries most hierarchy.

### Hierarchy
- **Headline** (700, 52px, 1.05; 44px on a phone): the day's total, Today only.
- **Figure** (700, 28px, 1.15): a verdict or a headline number.
- **Title** (600, 17px, 1.25): a card's title, a sheet's title, a row's figure.
- **Body** (400, 14px, 1.45): running text.
- **Small** (13px): leads, notes and secondary lines.
- **Label** (600, 12px, 0 tracking): the floor. Nothing is smaller.

### Named Rules
**The 12px Floor.** No type under `--type-label` (12px). `tools/tokens-test.js` fails any `font` under it, and `tools/phone-audit.mjs` flags it in the rendered page.

**The One Width Rule.** `font-variant-numeric: tabular-nums` on `body` stays, so a changing price does not shift its neighbours.

## Layout

A twelve-column grid per view (`.view`, 16px gap) in a page up to 1,680px wide, padded by the safe areas. Today puts the games and the crypto rule in a 7-of-12 column and next up, the lab, the arbs and the health in 5 of 12. Narrower: at 1,023px columns stack and the views become a row under the name; at **640px and under** (a phone) everything is one column, the title is large and scrolls away leaving the desk's light and the time pinned, and the views are a **tab bar along the foot** over the home indicator, with room left for it (`calc(76px + safe area)`). Spacing is a 4px base (`--space-1` to `--space-6`). Game tiles are two to a row on a phone and one to a row under 360px.

## Elevation & Depth

Hybrid. A light card rests on the page with a soft two-layer shadow (`--shadow-card`); a dark card is lighter than the page instead, and its shadow is fully transparent. The bar and the tab bar are translucent (`--material`) and blur what is under them. Sheets and the large chart sit over a scrim that blurs the page, with `--shadow-dialog`. The bar's own hairline (`--line-2`) appears once something scrolls under it.

### Named Rules
**The Concentric Rule.** A card's corner is the corner inside it plus the card's padding.

**The Offset Rule.** Shadows carry an offset and a soft blur; no zero-blur block shadows.

## Shapes

Continuous, iOS-like corners: 14px (the banner), 22px (cards; 20px on a phone), 28px (the large chart sheet and sheets) and a pill (999px) for the desk's light, the views control and segmented controls. Hairline borders (1px `--line-1`) separate list rows. Chevrons are drawn with borders, not glyphs. Icons in the tab bar are 26px, 1.7px stroke, round caps, one consistent weight.

## Components

### Cards
Face `--bg-1`, radius 22px, padding 16px 20px (16px on a phone), title in sentence case, a "see all" link or button at the right of the header.

### The desk's light (state pill)
A 30px pill with a dot in the state's colour and the words in ink; a wash behind it when the state wants a look. The working dot breathes (only motion at rest, and only without `prefers-reduced-motion`).

### Segmented controls
Pill track (`--fill-1`), the picked segment raised on `--seg-on` with `--shadow-seg`. Used for the views (wide screens), the chart's range, the league and the activity filters.

### Tab bar (phone)
Icon over its name, the one showing in the accent, translucent, fixed to the foot, padded by the home indicator.

### Rows and tiles
A row is a swatch, a name, a figure and a chevron with a line under it. A game tile is a scoreboard cell with the league, state and teams. Every one that leads somewhere is a button or link that opens a sheet or a view.

### Sheets
Over the page with a scrim: title centred, Back at the left, Done at the right in the accent. On a phone a sheet comes up from the foot with a grabber. The page behind is inert and Tab is trapped.

### Banner
14px radius, a wash of the bad (or warn) colour, a dot, one sentence. Used for no signal and for the desk not buying.

### Chart
TradingView Lightweight Charts, vendored, drawing the desk's own numbers in tokens colours read from `tokens.css` at run time, and again when the device changes appearance. It keeps its logo.

## Do's and Don'ts

### Do:
- **Do** take every colour from `tokens.css` and every size from its scales.
- **Do** keep text at 12px or more and 4.5:1 on both grounds, light and dark.
- **Do** check the phone first: run `node tools/phone-audit.mjs` on the demo and look at the Simulator.
- **Do** match the references in `docs/design/references/` for density, hierarchy and number alignment before inventing.
- **Do** give anything with more behind it a link or a sheet.
- **Do** leave `hover` styling inside `@media (hover: hover)` so a finger leaves none stuck.

### Don't:
- **Don't** change tokens, radii, type scale or the Apple look. The system is locked; a change needs Evan to ask for it.
- **Don't** add a web font, a package, a build step or another vendored library.
- **Don't** draw the pixel room or the bots back.
- **Don't** use colour as decoration or as the only mark of a part.
- **Don't** add TradingView data, an order control or any path to a broker.

## Impeccable commands

The Impeccable skill (`~/.claude/skills/impeccable`) may be used by hand: read its `reference/*.md` and apply them. Do **not** run its launcher script (it downloads a binary).

**Allowed:** `critique`, `audit`, `polish`, `quieter`, `distill`.

**Banned:** `bolder`, `colorize`, `overdrive`, `delight`. They add expression, and the system is locked.

Other design skills installed for Evan (`apple-design`, `break-ui`, `mobile-native`, `prototype`) may inform a review. Where a skill and `CLAUDE.md` conflict, `CLAUDE.md` wins.
