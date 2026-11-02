// Phone check for the floor at / (public/desk.html). Headless Chrome over the DevTools protocol, at an iPhone's width
// (iOS user agent, touch): for every route its status, script errors, sideways scroll, text under the floor, small
// controls, text cut off by its own box, and length in screens; a screenshot of each flagged route. Read-only: it loads
// pages and clicks nothing but the sheet openers it is told to.
//
// usage: node tools/phone-audit.mjs BASE OUTDIR URLFILE [width=375] [light|dark]
//   BASE     the server, e.g. http://127.0.0.1:8799 (the demo: see below) or the live floor
//   OUTDIR   where audit.json and the screenshots go (made if absent)
//   URLFILE  one route a line, a path with its hash: /#today, /#markets/crypto. A route may end in sheet=ID to open that
//            sheet first and check the sheet instead of the page: /#today sheet=book:crypto (ids: desk, book:<key>,
//            mkt:<sym>, game:<id>, lab, health; sheets are not part of the address, so the audit taps a stand-in for
//            what opens them). Blank lines and lines starting with # are skipped; a line must start with /. See
//            tools/phone-audit-urls.txt.
//   width    CSS pixels, default 375 (the iPhone 18 Pro Max is 440; 320 is the narrowest the floor lays out for)
//   scheme   light or dark, default light
// Environment (all optional):
//   CHROME    path to a Chrome or Chromium binary (default: Google Chrome in /Applications on a Mac)
//   MIN_FONT  smallest text, px (default 12: tokens.css --type-label is the floor, and tools/tokens-test.js holds desk.css to it)
//   TAP_MIN   smallest control, px (default 44, Apple's; desk.css asks 32 for a segment button and 24 for a link,
//             so findings between those and 44 are advisory, not a break of the repo's own rule)
//   FULL=1    screenshots of the whole page, not only the first screen
//   STRICT=1  exit 1 when any route is flagged (default: exit 0, read audit.json)
//   HEX_COOKIE  the floor's hexsession cookie value, for a floor behind the login. Pass it by command substitution
//             and never echo it; this tool never prints it. The demo and a loopback server need none.
// Node 22 or newer: it uses the global WebSocket (Node 20, the repo's floor for the server, has none) and global fetch.
// Zero dependencies, as the repo is: node:child_process, node:fs, node:net, node:os, node:path only.
//
// Run it on the demo, never on a funded or real setup (the floor is paper only either way):
//   DEMO=1 DATA_DIR=<scratch dir> PORT=8799 node server.js &
//   node tools/phone-audit.mjs http://127.0.0.1:8799 <outdir> tools/phone-audit-urls.txt 375 light
// then stop the server (lsof -ti:8799 | xargs kill).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

if (typeof WebSocket === "undefined") {
  console.error("phone-audit needs Node 22 or newer (the global WebSocket). This is " + process.version + ".");
  process.exit(2);
}
const [base, outdir, urlFile, width = "375", scheme = "light"] = process.argv.slice(2);
if (!base || !outdir || !urlFile || !/^https?:\/\//.test(base) || !["light", "dark"].includes(scheme) || !(+width >= 280)) {
  console.error("usage: node tools/phone-audit.mjs BASE OUTDIR URLFILE [width=375] [light|dark]");
  process.exit(2);
}
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(CHROME)) { console.error("no Chrome at " + CHROME + " (set CHROME to a Chrome or Chromium binary)"); process.exit(2); }
const MIN_FONT = +(process.env.MIN_FONT || 12);
const TAP_MIN = +(process.env.TAP_MIN || 44);

// the routes: "/#today" or "/#today sheet=book:crypto"
const ROUTES = readFileSync(urlFile, "utf8").split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#")).map(line => {
  const m = line.match(/^(\/\S*)(?:\s+sheet=(\S+))?$/);
  if (!m) { console.error("bad line in " + urlFile + ": " + line); process.exit(2); }
  return { path: m[1], sheet: m[2] || null };
});
mkdirSync(outdir, { recursive: true });
// Chrome's profile lives beside the results, not in the system's temp folder, and goes when the run ends
const prof = mkdtempSync(join(outdir, ".chrome-profile-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

let chrome = null, ws = null;
// Chrome is stopped and waited for before its profile goes: it writes while it exits and would leave the folder behind
const cleanup = async () => {
  try { ws && ws.close(); } catch {}
  if (chrome && chrome.exitCode === null) {
    const gone = new Promise(r => chrome.once("exit", r));
    try { chrome.kill(); } catch {}
    await Promise.race([gone, sleep(4000)]);
  }
  try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(143); });

// What the page is asked, in the page. Returns JSON. ROOT is the page (body) or, for a sheet, the sheet's box.
const check = (sheetMode) => `(() => {
  const MIN_FONT = ${MIN_FONT}, TAP_MIN = ${TAP_MIN}, W = innerWidth, H = innerHeight;
  const ROOT = ${sheetMode ? `document.querySelector("#sheet .shbox")` : `document.body`};
  if (!ROOT) return JSON.stringify({ noRoot: true });
  const q = (sel) => [...ROOT.querySelectorAll(sel)];
  const desc = el => { let s = el.tagName.toLowerCase(); if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) s += "." + [...el.classList].slice(0, 3).join(".");
    const card = el.closest("section.card, section.view, .shbox"); const h = card && card.querySelector("h2");
    return s + (h && h !== el ? " in [" + h.textContent.trim().slice(0, 36) + "]" : ""); };
  // not ours to judge: hidden, screen-reader-only, a script, the vendored chart library (it keeps its logo), and, for a
  // page check, the sheets (a sheet is checked on its own run)
  const skip = el => el.closest('[hidden], .sr, script, style, .tv-lightweight-charts' + ${sheetMode ? `""` : `", #sheet, #chartbig"`});
  const shown = el => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
  const clipped = el => { for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { const r = p.getBoundingClientRect(); return r.right <= W + 1 && r.left >= -1; } } return false; };

  // sideways overflow: a box that reaches past the screen and is not inside a scroller that fits
  const over = [];
  for (const el of ROOT.querySelectorAll("*")) {
    if (skip(el) || el.closest("svg") && el.tagName.toLowerCase() !== "svg" || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > W + 1 || r.left < -1) && !clipped(el)) over.push(desc(el) + " " + Math.round(r.left) + "-" + Math.round(r.right));
  }

  // text under the floor
  const tiny = new Set();
  const tw = document.createTreeWalker(ROOT, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!n.textContent.trim()) continue;
    const p = n.parentElement; if (!p || skip(p) || !shown(p)) continue;
    const fs = parseFloat(getComputedStyle(p).fontSize);
    if (fs < MIN_FONT - 0.01) tiny.add(desc(p) + " " + fs + "px");
  }

  // controls under TAP_MIN: buttons, selects, summaries, inputs, the sheet openers, the tab bar, and a link that stands
  // on its own (a link inside a sentence is exempt, as Apple and WCAG 2.5.8 allow)
  const alone = a => { const t = a.textContent.trim(), pt = a.parentElement ? a.parentElement.textContent.trim() : t; return t && t === pt; };
  const small = [];
  for (const el of ROOT.querySelectorAll('button, select, summary, textarea, input:not([type="hidden"]), [role="button"], [role="tab"], [data-sheet], [data-expand], .views a, a[href]')) {
    if (skip(el) || !shown(el)) continue;
    if (el.matches("a[href]") && !el.matches(".views a, .seeall, .shback") && !alone(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < TAP_MIN - 0.5 || r.width < TAP_MIN - 0.5) small.push(desc(el) + " " + Math.round(r.width) + "x" + Math.round(r.height));
  }

  // text cut off by its own box: overflow hidden or clip (or an ellipsis) on a box whose content is wider or taller than it
  const cut = [];
  for (const el of ROOT.querySelectorAll("*")) {
    if (skip(el) || el.closest("svg, .pnl") || !shown(el)) continue;
    const s = getComputedStyle(el);
    const text = (el.innerText || "").trim().replace(/\\s+/g, " ");
    if (!text) continue;
    const clipX = /(hidden|clip)/.test(s.overflowX), clipY = /(hidden|clip)/.test(s.overflowY);
    const byW = (clipX || s.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 1;
    const byH = clipY && !clipX && el.scrollHeight > el.clientHeight + 1 && s.display !== "inline";
    if (byW || byH) cut.push(desc(el) + " " + (byW ? "by " + (el.scrollWidth - el.clientWidth) + "px wide" : "by " + (el.scrollHeight - el.clientHeight) + "px tall") + ' "' + text.slice(0, 40) + '"');
  }

  const frame = !document.getElementById("floor").hasAttribute("aria-busy");
  return JSON.stringify({ title: document.title, frame, screens: +(document.documentElement.scrollHeight / H).toFixed(1),
    wide: document.documentElement.scrollWidth > W + 1 ? document.documentElement.scrollWidth : 0,
    over: over.slice(0, 6), nOver: over.length, tiny: [...tiny].slice(0, 6), nTiny: tiny.size,
    small: small.slice(0, 8), nSmall: small.length, cut: cut.slice(0, 8), nCut: cut.length });
})()`;

// opens a sheet the way a tap on its opener does: desk.js listens for a click on anything with data-sheet
const openSheet = (id) => `(() => { const b = document.createElement("button"); b.type = "button"; b.dataset.sheet = ${JSON.stringify(id)}; b.hidden = false;
  document.body.appendChild(b); b.click(); b.remove(); const s = document.getElementById("sheet"); return !!s && !s.hidden; })()`;

const results = [];
try {
  const port = await freePort();
  chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + prof, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch("http://127.0.0.1:" + port + "/json")).json()).find(t => t.type === "page"); } catch {}
  }
  if (!target) throw new Error("Chrome did not open a page on the debugging port");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("could not connect to Chrome"))); });
  let id = 0, events = []; const waiting = new Map();
  ws.addEventListener("message", m => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else events.push(d); });
  ws.addEventListener("close", () => { for (const f of waiting.values()) f({ error: { message: "Chrome closed" } }); waiting.clear(); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id; const t = setTimeout(() => { waiting.delete(n); rej(new Error(method + " timed out")); }, 30000);
    waiting.set(n, d => { clearTimeout(t); res(d); }); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalIn = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.error) throw new Error(r.error.message); return r.result && r.result.result && r.result.result.value; };

  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Log.enable");
  // a floor behind the login: the cookie is set from the environment and is never printed
  if (process.env.HEX_COOKIE) await send("Network.setCookie", { name: "hexsession", value: process.env.HEX_COOKIE, url: base });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Emulation.setDeviceMetricsOverride", { width: +width, height: 812, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1" });

  for (const route of ROUTES) {
    // A hash change alone is not a page load, so each route starts from a blank page: a deep link is tested as a deep link.
    await send("Page.navigate", { url: "about:blank" });
    await sleep(150);
    events = [];
    const t0 = Date.now();
    await send("Page.navigate", { url: base + route.path });
    for (let i = 0; i < 60; i++) { await sleep(250); if (events.some(e => e.method === "Page.loadEventFired")) break; }
    // the floor says aria-busy until its first frame (a frame is due every two seconds)
    let frame = false;
    for (let i = 0; i < 60 && !frame; i++) {
      try { frame = await evalIn(`!!document.getElementById("floor") && !document.getElementById("floor").hasAttribute("aria-busy")`); } catch { frame = false; }
      if (!frame) await sleep(250);
    }
    await sleep(500);
    let sheetOpened = null;
    if (route.sheet) { try { sheetOpened = await evalIn(openSheet(route.sheet)); } catch { sheetOpened = false; } await sleep(700); }
    const ms = Date.now() - t0;
    const doc = events.find(e => e.method === "Network.responseReceived" && e.params.type === "Document");
    const bad = events.filter(e => e.method === "Network.responseReceived" && e.params.response.status >= 400 && e.params.type !== "Document")
      .map(e => e.params.response.status + " " + e.params.response.url.replace(base, ""));
    const exc = events.filter(e => e.method === "Runtime.exceptionThrown").map(e => (e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text);
    const cons = events.filter(e => e.method === "Runtime.consoleAPICalled" && e.params.type === "error").map(e => e.params.args.map(a => a.value || a.description).join(" "));
    const logs = events.filter(e => e.method === "Log.entryAdded" && e.params.entry.level === "error").map(e => e.params.entry.text + " " + (e.params.entry.url || "").replace(base, ""));
    let r = {};
    try { r = JSON.parse(await evalIn(check(!!route.sheet))); } catch (e) { r = { evalError: String(e.message || e) }; }
    const row = { route: route.path + (route.sheet ? " sheet=" + route.sheet : ""), status: doc ? doc.params.response.status : 0, ms, sheetOpened, ...r,
      bad, exc: exc.slice(0, 3), cons: cons.slice(0, 3), logs: logs.slice(0, 3) };
    results.push(row);
    const flags = [row.status !== 200 && "STATUS " + row.status, row.evalError && "EVAL", row.noRoot && "NOSHEET", route.sheet && sheetOpened === false && "SHEET-NOT-OPEN",
      !row.noRoot && !row.evalError && !row.frame && "NO-FRAME", row.wide && "WIDE " + row.wide, row.nOver && "OVER " + row.nOver, row.nTiny && "TINY " + row.nTiny,
      row.nSmall && "TAP " + row.nSmall, row.nCut && "CUT " + row.nCut, (exc.length || cons.length || logs.length) && "JS", bad.length && "RES"].filter(Boolean);
    row.flags = flags;
    process.stderr.write(`${row.route} ${row.status} ${ms}ms ${row.screens == null ? "?" : row.screens + " screens"} ${flags.join(" ") || "ok"}\n`);
    if (flags.length) {
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: process.env.FULL === "1" });
      if (shot.result) writeFileSync(join(outdir, (row.route.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "home") + ".png"), Buffer.from(shot.result.data, "base64"));
    }
  }
  writeFileSync(join(outdir, "audit.json"), JSON.stringify({ base, width: +width, scheme, minFont: MIN_FONT, tapMin: TAP_MIN, results }, null, 1));
} catch (e) {
  console.error("phone-audit failed: " + (e && e.message || e));
  process.exitCode = 2;
} finally {
  await cleanup();
}
if (!process.exitCode && process.env.STRICT === "1" && results.some(r => r.flags && r.flags.length)) process.exitCode = 1;
