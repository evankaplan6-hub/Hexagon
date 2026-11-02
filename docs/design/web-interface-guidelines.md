# Web interface guidelines: a checklist for Hexagon's floor

Source: Vercel's Web Interface Guidelines, `command.md` of [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines), MIT licensed (notice at the foot). Rewritten here as a checklist for this repo's plain HTML, CSS and JS (`public/desk.html`, `public/desk.css`, `public/desk.js`, and the login page in `server.js`). The rules are Vercel's; the wording is trimmed and the framework terms are translated.

## How to use it

1. Read the files under review, then walk the sections below in order. Skip a rule under "Does not apply" or "Conflicts" unless the note says otherwise.
2. Report each finding as `file:line - the problem`, grouped by file, terse. A file with none says `pass`.
3. Fix nothing as a side effect of a review. Report first.
4. Where a rule here and `CLAUDE.md`, `PRODUCT.md` or `DESIGN.md` disagree, **the repo wins** (see "Conflicts" below).
5. Pair it with `node tools/phone-audit.mjs` for what a rendered page shows (cut-off text, sideways scroll, small controls) and with `tools/tokens-test.js` and `tools/floor-test.js` for what the tests already hold.

## Does not apply here

- **React, Next.js, hydration:** the whole "Hydration Safety" section, `onChange`/`defaultValue`, `suppressHydrationWarning`, `<Link>`, `htmlFor`, `spellCheck={false}`, `<Suspense>`, `useState`, `priority` on images, router guards. The page is not server-rendered by a framework; `desk.js` builds the DOM.
- **Tailwind:** `focus-visible:ring-*`, `hover:`, `truncate`, `line-clamp-*`, `min-w-0`, `overflow-x-hidden` as class names. Use the CSS they stand for, which this checklist names.
- **Libraries not in the repo:** `virtua`, `nuqs`. Zero npm dependencies is a rule (`CLAUDE.md`). Use `content-visibility: auto` and the URL hash.
- **No forms on the floor:** the form rules (autocomplete, input types, paste, labels, submit state, inline errors, placeholders, unsaved-changes warning) apply only to the login page in `server.js`. The floor has no fields.
- **Web fonts:** "preload critical fonts", `font-display`, "preconnect for CDN domains". The floor loads no font and no CDN (`tools/tokens-test.js` fails any). The old `/pm` and lookout pages are not the floor.
- **Destructive actions:** the floor is read-only and has no delete control (`tools/floor-test.js`).
- **Video and GIF rules:** the floor has none.
- **Locale detection by `Accept-Language`:** Hexagon reads in `America/New_York` and en-US on purpose (the market's clock); keep using `Intl.DateTimeFormat` and `Intl.NumberFormat` with explicit options.

## Conflicts with this repo (the repo rule wins)

| Vercel says | This repo says | Do this |
|---|---|---|
| `…` not `...`; loading states and placeholders end with `…` | `CLAUDE.md` has no ellipsis rule. Evan's standing writing rule, set in Sera on 2026-10-21 (no ellipses, no run-on sentences), is the one he applies to his writing; new text for this repo follows it. The floor's copy has none since the 2026-11-01 audit fixes ("Connecting to the desk" in `public/desk.js` lost its `…` then); one comment quotes a cut-off name. | Write no new ellipsis in visible copy. Say what is happening in a plain phrase ("Connecting to the desk") or leave the label bare. Ask Evan to confirm the rule for Hexagon if it matters. |
| Title Case for headings and buttons | Cards and sheets use **sentence case**, as iOS titles a group (`desk.css`, `.label`). | Sentence case. |
| Animate `transform` and `opacity` only | `desk.css` transitions `background-color`, `box-shadow` and `color` for 0.15 to 0.2s on purpose, as iOS does, and blurs the bar with `backdrop-filter`. | Keep those. Still flag `transition: all`, which `desk.css` has none of, and anything that animates layout (width, height, top). |
| `text-overflow` and `truncate` to handle long text | `desk.css` notes that cut-short team names read "Central C…" on a phone and lets such names wrap onto two lines. | Prefer wrapping (`overflow-wrap: anywhere`, two lines) to cutting. Truncate only where a box is fixed (a sheet's title, the tab bar's labels) and then let `tools/phone-audit.mjs` report it. |
| "Page rubber-band suppression" (`overscroll-behavior: none` on `html`) | `desk.css` sets no `overscroll-behavior` on `html` (only `contain` on a sheet's body), so the system's own page behaviour, pull to refresh included, is left as it is. | Leave the page's defaults. |
| `autocomplete="off"` on non-auth fields | The login page's fields should let a password manager fill them. | Do not add `off` to the login. |
| Mobile controls "44px" (Vercel's README) | `desk.css` asks 32px for a segment button, 44px for a text button on a coarse pointer, and 24px for a link (WCAG 2.2). | Report under 44px as advisory; a control under the repo's own floor is a real finding. `TAP_MIN` sets the audit's bar. |
| Text size | `CLAUDE.md` and `tokens.css`: nothing under 12px. Not in Vercel's list. | 12px is the floor, held by `tools/tokens-test.js`. |

## Checklist

### Accessibility
- [ ] Icon-only buttons have `aria-label` (or visible text beside the icon).
- [ ] Form controls have a `<label>` or `aria-label`.
- [ ] `<button>` for actions, `<a href>` for navigation. No `<div>` or `<span>` with a click handler.
- [ ] Interactive elements work from the keyboard (a native `button` or `a` does; a custom one needs key handlers).
- [ ] Images have `alt` (or `alt=""` if decorative). Decorative SVG icons have `aria-hidden="true"` (the tab bar's do).
- [ ] Async updates (a fill, a stopped desk) are announced through a live region (`#announce`, `role="status"`).
- [ ] Semantic HTML before ARIA. Headings are hierarchical (`h1` then `h2`); a skip link to `main` is present.
- [ ] `scroll-margin-top` on anything a link scrolls to (`[data-anchor]` has it).
- [ ] Media has captions or descriptions; media controls work by keyboard.

### Focus states
- [ ] Every interactive element shows a visible focus ring (`:focus-visible`; `desk.css` draws a 3px `--focus` ring).
- [ ] No `outline: none` without a replacement (`desk.css` has none).
- [ ] `:focus-visible`, not `:focus`.
- [ ] `:focus-within` for a compound control that should ring as a group.
- [ ] A sticky bar, tab bar or sheet never covers the focused element (`scroll-padding-top` is set; the phone's tab bar has `padding-bottom` on `.wrap`).

### Forms (login page only)
- [ ] Inputs have `autocomplete` and a meaningful `name`; correct `type` and `inputmode`.
- [ ] Paste is never blocked. Labels are clickable. Errors sit next to the field.
- [ ] Field text is 16px or more on a phone so iOS Safari does not zoom (the login uses 17px).

### Animation
- [ ] Honour `prefers-reduced-motion` (`desk.css` wraps its animations in `no-preference`).
- [ ] Never `transition: all`; list properties.
- [ ] Prefer `transform` and `opacity` (see the conflict above for what this repo does on purpose).
- [ ] Correct `transform-origin`. SVG transforms on a `<g>` with `transform-box: fill-box; transform-origin: center`.
- [ ] Animations are interruptible by input.
- [ ] Autoplay motion longer than 5 seconds has a way to stop it; decorative loops stop under reduced motion.

### Typography
- [ ] No new `...` where `…` is meant, **and no new ellipsis at all** (see the conflict).
- [ ] Curly quotes in visible copy. Non-breaking spaces in `10&nbsp;MB`, a figure and its unit, and the brand name.
- [ ] `font-variant-numeric: tabular-nums` on numbers that change or line up (set on `body`).
- [ ] `text-wrap: balance` or `pretty` on headings.

### Content handling
- [ ] Containers handle long content: wrap (`overflow-wrap: anywhere`), clamp, or truncate on purpose.
- [ ] Flex and grid children that must shrink have `min-width: 0` (`.view` and `.card` do).
- [ ] Empty states render something useful, not broken UI, for an empty string or array.
- [ ] Anticipate short, average and very long names (a team name, a market title).

### Images
- [ ] `<img>` has explicit `width` and `height`. Below the fold: `loading="lazy"`. Above the fold: `fetchpriority="high"`.

### Performance
- [ ] Long lists (more than about 50 rows) use `content-visibility: auto` or are capped.
- [ ] No layout reads (`getBoundingClientRect`, `offsetHeight`, `scrollTop`) in a render pass; batch reads and writes.
- [ ] The 2-second frame patches in place (`morph`) rather than rebuilding, so focus and scroll survive.

### Navigation and state
- [ ] URL reflects state: the view and the card are in the hash (`#markets/crypto`). A sheet is not in the address; do not add state that would be lost on reload without saying so.
- [ ] Links are `<a href>` so Cmd/Ctrl-click and middle-click work.
- [ ] Back, forward and reload land where they were.

### Touch and interaction
- [ ] `touch-action: manipulation` on controls. `-webkit-tap-highlight-color` set on purpose (`transparent`, with `:active` dimming).
- [ ] `overscroll-behavior: contain` in sheets and scrolling panels.
- [ ] No gesture-only action: a drag or swipe has a tap and a keyboard alternative.
- [ ] No `autofocus` on a phone.
- [ ] Hit targets: at least 24px everywhere, 44px for a phone's controls (see the conflict for the repo's own floor).

### Safe areas and layout
- [ ] Full-bleed layout pads by `env(safe-area-inset-*)`, with `viewport-fit=cover`.
- [ ] No unwanted sideways scroll at 320, 375 and 440 wide (run `tools/phone-audit.mjs`).
- [ ] Flex and grid, not JS measurement, for layout.

### Dark mode and theming
- [ ] `color-scheme: light dark` on `:root` (set in `tokens.css`).
- [ ] `<meta name="theme-color">` matches the page background in both appearances (`tools/tokens-test.js` holds it).
- [ ] Native `select` and inputs set an explicit `background-color` and `color`.

### Locale
- [ ] Dates, times and numbers go through `Intl.DateTimeFormat` and `Intl.NumberFormat`, not hard-coded formats.
- [ ] Brand names and tickers that must not be translated carry `translate="no"` where the page is likely to be auto-translated.

### Hover and interactive states
- [ ] Buttons and links have a hover state, inside `@media (hover: hover)` so a finger leaves none stuck (`tools/tokens-test.js` holds it).
- [ ] Hover, active and focus are more prominent than the rest state.

### Content and copy
- [ ] Active voice. Numerals for counts ("8 deployments"). Second person, no first person.
- [ ] Specific labels ("Large chart", "Every test"), not "Continue".
- [ ] Error text names the problem and the next step.
- [ ] `&` for "and" only where space is tight.
- [ ] Sentence case (see the conflict).

### Anti-patterns to flag
- [ ] `user-scalable=no` or `maximum-scale=1` (none today).
- [ ] `onpaste` with `preventDefault`.
- [ ] `transition: all`.
- [ ] `outline: none` without a `:focus-visible` replacement.
- [ ] Inline navigation by script instead of `<a href>`.
- [ ] A `<div>` or `<span>` with a click handler instead of a `<button>`.
- [ ] Images without dimensions.
- [ ] Inputs without labels. Icon buttons without `aria-label`.
- [ ] Hard-coded date or number formats.
- [ ] `autofocus` without a reason.
- [ ] A gesture with no tap or keyboard alternative.

## Output format

```text
## public/desk.js

public/desk.js:LINE - ellipsis in visible copy (repo style: none)
public/desk.js:LINE - icon button missing aria-label

## public/desk.css

public/desk.css:LINE - transition: all -> list properties

## public/desk.html

pass
```

State the issue and the location. Skip the explanation unless the fix is not obvious.

---

The rules above are adapted from `command.md` in vercel-labs/web-interface-guidelines.

MIT License

Copyright (c) 2025 Vercel Labs

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
