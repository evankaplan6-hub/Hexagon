# public/vendor

One file, kept here on purpose so the dashboard needs no network fetch and no `npm install`.

| | |
|---|---|
| File | `lightweight-charts.standalone.production.js` |
| What | [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) v5.2.1, the standalone build (`window.LightweightCharts`) |
| Source | `https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js` |
| Size | 197,922 bytes |
| SHA-256 (base64) | `4hzFyqAibvML2FScULnvkmYV8qTua05IY1NHelX1mM8=` (matches the hash jsdelivr publishes for that file) |
| Licence | Apache 2.0. The licence and copyright notice sit in the file's own header, unedited. |
| Added | 2026-09-19 |

**Attribution.** TradingView's terms ask for a visible credit. Every chart draws their logo, linked to
tradingview.com (`attributionLogo: true` in `public/app.js`). The page's footer is hidden by CSS, so it
cannot carry the credit instead: keep the logo on.

**Do not edit the file.** To update it, download the new version from the same URL pattern, check its
hash against `https://data.jsdelivr.com/v1/packages/npm/lightweight-charts@VERSION?structure=flat`, replace
the file, and update the table above. `public/app.js` (search for `LightweightCharts`) is the only user.
