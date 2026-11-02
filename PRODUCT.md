# Product

<!-- impeccable:product-schema 1 -->

<!-- Written 2026-11-01 from the repository only (CLAUDE.md, README.md, public/desk.*, tools/*-test.js) and the
     assignment that asked for it. No interview took place. Facts that come from the assignment and not from the
     repo are marked "(stated, not in the repo)". Nothing here is a feature the repo does not have. -->

## Platform

web

## Stack
Plain HTML, CSS and JavaScript served by a Node server (`server.js`, Node 20 or newer), with **zero npm dependencies** on purpose. The one file of third-party code is TradingView Lightweight Charts, vendored in `public/vendor/` (see `public/vendor/README.md`); it draws the desk's own numbers and makes no requests. Nothing is built or bundled. The floor at `/` is `public/desk.html`, `public/desk.css`, `public/desk.js` on `public/tokens.css`. It is a web page that can be added to an iPhone's Home Screen or a Mac's Dock (`public/manifest.webmanifest`), not a native app.

## Users
One person: **Evan**, the only user and the owner of the money the desk pretends to trade. One login (a single password, `DASH_PASS`, and a 30-day cookie). He reads the desk on his **phone first** (stated, not in the repo; the repo agrees: the page is added to the Home Screen, has a tab bar and a large title on a phone, and was checked in the iOS Simulator on an iPhone 18 Pro Max) and on a Mac second. His job is to look and know in a glance whether the desk is working, how the paper books stand against simply holding, and what it did or will do next. He does not trade from this page.

## Product Purpose
The Hexagon is a **paper trading desk for stocks, crypto and options**. Bots run paper books on free public prices (crypto live from Coinbase, SPY from Cboe about 15 minutes late) and a prediction-market desk (Polymarket and Kalshi) trades in simulation beside them. The floor at `/` shows all of it. Success is a reader who can trust the numbers and see, honestly, whether a rule beats holding. The plan since 2026-10-17 is to run the crypto rule and say what it does, test any idea Evan brings the same way, and keep collecting tapes. No new books.

## Positioning
A desk that reports against **just holding** and says so when a rule does not win. The page states what the money is (paper only, no broker, no way to place a real order) and treats a desk that trades rarely, or not at all, as correct behavior. No neighbouring dashboard is built around that stance.

## Operating Context
- The floor has four views, each a link: **Today** (`#today`), **Games** (`#games`), **Markets** (`#markets`, one card by `#markets/crypto`, `#markets/pm-arbs`, `#markets/side`) and **Activity** (`#activity`). Old links (`#overview`, `#desk`, `#pm`) still land.
- Anything with more behind it opens a **sheet** (the whole Hexagon, a book, a market, a game, the lab, the health). Sheets are not part of the address.
- A server stream sends a frame every two seconds and the page patches its boards in place so focus survives.
- The desk runs on a Fly box (`hexagon-desk`) and locally. A demo mode (`DEMO=1`) runs the prediction-market desk on synthetic fills.
- Light or dark follows the device. The page can be a Home Screen app.

## Capabilities and Constraints
- **Paper only.** No code path to any broker or exchange. Real orders are Evan's to place by hand.
- **Read-only page.** `tools/floor-test.js` holds it to reading; it has no order controls.
- **No TradingView data** anywhere in the repo, the page or its data (CLAUDE.md, Terms section 3).
- Type is never under 12px (`--type-label`); every text colour reads at 4.5:1 or better in both appearances (`tools/tokens-test.js`).
- No web fonts on the floor; the system font only. (The old `/pm` and lookout pages still load Google Fonts and are not the floor.)
- The server binds `127.0.0.1`. The floor's icons and manifest are served before the login and nothing else is.
- Open decisions: none recorded. Reference screenshots for matching (Apple Stocks and others) have not been supplied yet.

## Brand Commitments
- The name is **The Hexagon** (short name **Hexagon** on the Home Screen).
- The app icon is graphite with a white hexagon mark and a core in the gain's green (`--icon-*`, drawn by `tools/icons.js`).
- Since 2026-09-29 the floor is drawn the way Apple draws its own apps (Evan: "making the website iOS and macOS and Apple beautiful"). That call is binding.
- Since 2026-09-25 no pixel room and no bots drawn (Evan's call).
- The visual system is **locked** for the stage-3 work: see DESIGN.md.

## Evidence on Hand
- Real, running data: the desk's ledgers and journals (`data/`, gitignored), the demo mode, and the tests listed in `tools/test.js`.
- Verified checks: `tools/tokens-test.js`, `tools/floor-test.js`.
- Absent, and not to be invented: user research, analytics, testimonials, and any reference screenshots (`docs/design/references/` is empty until Evan adds images).

## Product Principles
1. **Say what the money is.** Paper, late prices and the rule's own reason are on the page, not hidden.
2. **Show what is happening, not the code.** The views follow the day (Today, Games, Markets, Activity), not the modules.
3. **Against just holding.** A figure comes with the comparison that tells whether it was worth it.
4. **Everything with more behind it opens it.** A tile, bar or line that leads somewhere is a link or opens a sheet.
5. **Readable first.** 12px and up, 4.5:1 text, figures all one width so a changing price does not shift its neighbours.

## Accessibility & Inclusion
- Text 4.5:1 or better in light and dark, held by `tools/tokens-test.js`.
- Visible keyboard focus (`:focus-visible`, 3px `--focus` ring) and a focus trap in sheets; the page behind a sheet is inert.
- Motion honours `prefers-reduced-motion`.
- Safe areas respected around a notch (`viewport-fit=cover`, `env(safe-area-inset-*)`).
- A colour is never the only thing that says which part something is: a swatch sits beside the name.
