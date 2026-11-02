# References: screenshots to match against

This folder holds screenshots that Claude compares the floor against before and after a design change. **Evan adds the images himself.** Nothing here is scraped or downloaded from a third-party site, and Claude does not fetch any: if a folder below is empty, say so and ask, do not look one up.

The images go in subfolders named for the target (`apple-stocks/`, `tradingview/`, `koyfin/`, `unusual-whales/`); none exists yet. This file keeps the folder in git, so no `.gitkeep` is needed.

## How to add one

Save a PNG or JPG as `<target>/<what>-<light|dark>-<phone|desktop>.png`, for example `apple-stocks/watchlist-dark-phone.png`. Phone first. Note the date and the device in the file name or a one-line `NOTES.md` beside it. Keep each file well under a few MB.

Third-party screenshots are for comparison inside this repo only. Do not commit anything that carries Evan's real account data, balances or positions, and none of it goes in `data/` or on the page (the repo's rule: no TradingView value anywhere in Hexagon; a screenshot of his chart is for comparison, not for use).

## The targets, in order

### 1. Apple's own Stocks app (first)
The floor is drawn the way Apple draws its apps, so this is the primary reference. Both Evan's sites follow Apple's look.
- **Density:** rows per screen on a phone, row height, padding inside a card, gap between cards.
- **Hierarchy:** one large figure, a quiet label, a single accent. Sentence-case titles. What is bold and what is not.
- **Number alignment:** figures all one width and right-aligned in a column, sign and colour treatment, the unit's weight.
- **Empty and loading states:** what Stocks shows before data arrives and when a list is empty; compare to the floor's "Waiting for the first desk round" and its "Connecting to the desk" first paint.
- Also: sheet shape and the grabber, tab bar, translucent bar, large title that scrolls away, dark mode surfaces.

### 2. TradingView
- **Density:** how much a chart screen and a watchlist hold on a phone.
- **Hierarchy:** where the price, the change and the range selector sit relative to the chart.
- **Number alignment:** the watchlist's columns, decimals and colour of change.
- **Empty and loading states:** a chart with no data, a symbol that cannot load.
- Remember: no TradingView data goes into Hexagon (CLAUDE.md). This is a look-only reference.

### 3. Koyfin
- **Density:** dashboards and tables with many numbers per screen; how it keeps them readable.
- **Hierarchy:** how a panel's title, the figure and its comparison (against a benchmark) are ordered. Compare to "against just holding".
- **Number alignment:** column alignment in tables, units in headers, negative values.
- **Empty and loading states:** a panel with no data, a table loading.

### 4. Unusual Whales
- **Density:** feeds and flow tables on a phone; how many rows before the page feels crowded.
- **Hierarchy:** how a feed row separates what happened, size and time (compare to the Activity view's rows).
- **Number alignment:** premium, size and strike columns, colour used for direction.
- **Empty and loading states:** a feed with nothing new, a filter with no results.

## What to compare, every time

For each target, put the same screen next to the floor's at the same width (375 and 440 on a phone, light and dark) and note, in this order: density, hierarchy, number alignment, empty and loading states. Report differences as findings. The floor's system is locked (`DESIGN.md`): a reference may show that something is off, but it does not license new colours, type sizes or radii. Anything that would change a token needs Evan to ask.
