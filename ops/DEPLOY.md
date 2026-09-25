# Running the desk in the cloud

The desk runs on a Fly.io box (app `hexagon-desk`): since 2026-09-25 that is two desks in one process,
the stocks, crypto and options desk (`src/desk/`, its floor at `/`, its ledger in `/data/desk/`) and
the prediction-market desk winding down to settlement (its floor at `/pm`). The Mac's launchd autostart
(`ops/install-autostart.sh`) exists but is not installed: a desk on the Mac stops when the machine
sleeps, and the one thing this strategy needs is **days of uninterrupted tape**.

## The two things that make this safe

**Paper mode needs no credentials at all.** The Kalshi API key and private key sign live orders
in live mode (`src/broker.js`, `LiveKalshiBroker`) and, in any mode *if they are present*, the
handshake for the read-only market-data socket (`src/kalshi-ws.js`). Absent, the maker desk polls
the trade tape every two seconds as it always did, and the poll pages back so nothing is lost. A
paper deployment carries no secrets, so there is nothing on that box worth stealing. Nothing here
uploads `.env` or `*.pem`, and both are gitignored.

**The dashboard has a password now, and the server refuses to start without one** on any address
that is not loopback. `/api/positions` and the full activity log are unauthenticated otherwise,
and a desk carrying live-trading code should not sit open on a public address. The refusal is a
startup failure rather than a warning, for the same reason the live-mode guard is.

## Deploy (Fly.io)

Fly is the recommendation: US regions — Kalshi's API is US-facing and a European box is a needless
risk — a persistent volume on the cheap tier, and machines that idle without being suspended. A
market maker that gets paused between page views is not a market maker; `fly.toml` disables
auto-stop for exactly that reason.

```bash
brew install flyctl && fly auth signup        # once

cd ~/Hexagon
fly launch --no-deploy --copy-config --name hexagon-desk   # reads fly.toml
fly volumes create hexagon_data --region iad --size 1      # the journals live here
fly ips allocate-egress -a hexagon-desk -r iad             # its own outgoing IP (below)

fly secrets set DASH_PASS="$(openssl rand -base64 18)"     # prints nothing; read it back below
fly secrets list                                            # confirms it is set, not its value
fly deploy
fly open                                                    # browser prompts: user "hexagon"
```

You need the password you generated, so either pick your own instead of `openssl rand`, or run
the `openssl` line on its own first and copy the output.

**The box has its own outgoing IP** (209.71.108.223, allocated 2026-09-15). Kalshi rate-limits by
address, and on Fly's shared outgoing IP the desk was refused 10-27 Kalshi calls every 5 minutes
from traffic that was not its own; on its own address, 0. If Kalshi 429s come back, check the box's
outgoing IP first (from `fly ssh console`, fetch `api.ipify.org`; it should read 209.71.108.223)
before tuning `KALSHI_GAP_MS` or the retry code. Do not allocate a second one. A region move needs a
new egress IP in the new region, and the old one released with `fly ips release-egress`, so it is
not billed twice.

Roughly $8–9/month: a shared-cpu-2x with a 1GB volume ($4–5) plus the static egress IP (~$3.60). It
was a shared-cpu-1x until 2026-09-22, when the desk was found pinned at that size's CPU cap (6.25%
of a core); `fly.toml` has the numbers.

### Auto-deploy

Every push to `main` deploys itself (`.github/workflows/test.yml`, job `deploy`): it waits for the
test matrix, stands down if a newer push has landed on `main`, skips pushes that touch nothing the
box runs (`ops/` notes, CLAUDE.md; README.md and ops/DEPLOY.md do deploy, because the Ask panel's
docs tool reads them from the image), and refuses to ship
unless `fly.toml` still says `MODE = "paper"`. It authenticates with a deploy-scoped token stored as
the GitHub secret `FLY_API_TOKEN`, created once without either value ever being printed:

```bash
fly tokens create deploy -a hexagon-desk -x 8760h | gh secret set FLY_API_TOKEN -R evankaplan6-hub/Hexagon
```

The token is scoped to this one app and expires after a year; rerun the line to renew it. A
manual `fly deploy` still works and is still how to ship from a branch.

**The box always ends on the newest `main`.** Deploys run one at a time, but not in merge order:
two PRs merged seconds apart can finish their tests in either order. On 2026-09-13 #11 deployed
first and #10's deploy (the older commit) landed 30 seconds later, rolling whale watch off the box.
So each deploy first checks that its commit is still the head of `main`; if not, it stands down and
the newer push's run deploys instead. If that newer push fails its tests, nothing deploys until
`main` is green again — the box stays on the last good deploy rather than getting untested code.

**The `fly-deployed` tag marks what the box runs.** After every successful deploy the job moves
the git tag `fly-deployed` to that commit (this is why the job has `contents: write`). The
"did anything the box runs change?" check compares against that tag, not against the push before.
That way a code change whose deploy stood down still ships when the next push is only a README
edit. To see what's on the box: `git fetch --tags --force && git log -1 fly-deployed`. If the tag
is missing or behind, the next deploy just ships — the safe direction. A manual `fly deploy` does
not move the tag, so after shipping a branch by hand, put `main` back with a manual `fly deploy`
from `main` — a docs-only push won't do it.

## Any other host

The Dockerfile is plain and hostless:

```bash
docker build -t hexagon .
docker run -d --restart=always -p 8787:8787 \
  -v hexagon_data:/data -e DASH_PASS='pick-something-long' hexagon
```

Works on a $5 VPS, a Raspberry Pi, or anything that runs Docker. Keep the region in the US.

## Checking on it

```bash
fly logs                        # live; the stocks, crypto and options desk's lines start "desk "
curl -s -u "hexagon:$DASH_PASS" https://hexagon-desk.fly.dev/api/desk/state | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["pnl"], [(b["key"], b["pnl"], b["benchPnl"]) for b in s["books"]])'
fly ssh console -C "tail -n 20 /data/desk/journal-$(TZ=America/New_York date +%F).jsonl"   # today's fills and verdicts on the box
node tools/fillcheck.js         # on the Mac, from the pulled tape: does the ledger fill the way its tape says, and where the rest goes
fly ssh console -C "node tools/maker-report.js"
```

### Which commit is the box actually running?

The deploy stamps the commit into the image (`Dockerfile` ARG `GIT_SHA`, passed by the workflow),
and the desk reports it:

```bash
curl -s https://hexagon-desk.fly.dev/api/state | python3 -c 'import json,sys; print(json.load(sys.stdin)["build"])'
```

The dashboard shows the same thing under the status panel: `build 3ebaa5d · restarted 12m ago`,
with the full SHA on hover. A desk run from a working copy is unstamped and says `dev`.

Read `restarted` and not `Up`: `Up` is the ACCOUNT's age and survives every restart, so it keeps
counting through a deploy. On 2026-09-20 it read 248h on a box that had just been redeployed, and
there was no way to tell from the outside whether the new code was live. That is what this answers.
The `fly-deployed` tag is the pipeline's record of the same fact; this is the box's own.

## When the desk freezes

On 2026-09-19 the taker cycle and the maker's requote loop stopped in the same second (15:32Z) and
stayed stopped for over an hour. The process was up at 0% CPU, the whale feed and the any-market
crawl kept logging, and from outside it looked like a quiet market. Both loops refuse to start a
round on top of an unfinished one, so a single round that never returns silences its loop for good.

`src/watchdog.js` now watches for it. Each loop leaves a beat when a round finishes (or throws); if
either has none for `WATCHDOG_SEC` (300; 0 is off), the desk logs `WATCHDOG: no finished round in ...`,
writes a `WATCHDOG` line to the journal, saves and exits 1. `fly.toml` sets `[[restart]] policy =
"always"` so Fly starts it again (the default, on-failure with ten retries, would have left the box
dead after the tenth stall). In live mode it only reports: restarting under an order in flight is
the operator's call. A process that was asleep (a Mac lid) is given a fresh start, not restarted.

The journal line is the evidence for what froze: `inflight` lists Kalshi and Polymarket calls
started and not finished, oldest first, with their age against a 15s timeout, and `queued` counts
calls still waiting for their turn. Old calls in flight mean a request that never timed out; none
in flight and none queued mean something else awaited forever, and the cause is still to be found.

```bash
fly ssh console -C "grep WATCHDOG /data/journal-*.jsonl"     # has it fired?
```

**Every start and stop is journaled too (2026-09-24).** `server.js` writes `START` at boot (with the
build sha), `STOP` when a signal ends it (a deploy stops it with SIGTERM) and `CRASH` from its
last-resort handlers, with the first 800 characters of the stack. Before, a crash was one console
line, and `fly logs` keeps about 30 minutes of those. `tools/restarts.js` (step 4 of
`ops/daily-check.sh`) counts every `START` whose previous lifecycle line is none of `STOP`,
`WATCHDOG` or `CRASH`: that is an OOM kill or a heap abort, which run no handler.

## Keeping the disk from filling

The box's `/data` volume is 1 GB. The tick tape (`ticks-<Eastern date>.jsonl`) grows about 90-130
MB a day since sports joined the crawl on 2026-09-19 (about a quarter of it the maker's book and
prints, the rest the paired markets). With about 600 MB free after a pull, the brake's 200 MB floor
is about four days away if the pull stops; it deletes the two already-copied days first, so a tape
that never reached the Mac is lost after about six. A full disk stops the journal and `state.json`
too, not just the tape. Nothing on the box reads old tapes, so they move to the Mac.

**On the Mac, hourly until the day is done: `tools/fly-pull.js`.** It copies every finished
Eastern day (tapes, journals, whales, probes) into `data/fly/archive/`, and since 2026-09-25 the
stocks, crypto and options desk's journals from `/data/desk` into `data/fly/archive/desk/`. Each file downloads under a
temp name and is kept only if its sha256 matches the box's; a dropped download is tried three times
in all, 30 seconds apart, from an empty temp file. With `--trim` it then deletes box tapes and probe
files older than the newest 3 Eastern days (today counts as one), but only files whose Mac copy
matched in that same run (probe files since 2026-09-24: 14 of them, about 50 MB, had never been
deleted). It never deletes journals (the desk's included), whales, `state.json` or anything of today's. A failed copy
keeps only its own file on the box (since 2026-09-24; before, one failed download stopped every
delete, and on 09-22 and 09-23 two already-copied tapes stayed on the box while free space fell to
411 MB). A listing that fails, or a box that does not say its date, still deletes nothing that
run. It never writes to the frozen `data/fly/` snapshot itself.
"Today" is the earlier of the Mac's and the box's Eastern date, so a clock running fast past
midnight can't close the tape the box is still writing.

The archive is always the **main checkout's** `data/fly/archive`, even when the tool is run from a
git worktree under `.claude/worktrees/`: a worktree's `data/` is deleted along with the worktree,
so it is no place for the only copy of a tape. `--trim` with a `--dest` inside a worktree is refused.

```bash
node tools/fly-pull.js --trim --dry-run    # what it would copy and delete; changes nothing
node tools/fly-pull.js                     # copy only
node tools/fly-pull.js --trim              # copy, then trim the box
#   --keep 3   days of tape left on the box     --app hexagon-desk     --dest data/fly/archive
```

Each run adds one line to `data/fly/archive/pull.log` and exits non-zero on any problem. A Mac copy
that differs from the box and isn't just an older, shorter copy is never overwritten. It's reported,
and that box tape stays.

**The job** is a LaunchAgent that runs `ops/run-pull.sh` (which runs `fly-pull.js --trim`) every
hour at :30, since 2026-09-24. It was 09:30 and 13:30 before, and 9 of the 21 runs from 09-15
failed: launchd started most of them in a two-second battery DarkWake, the Mac fell back asleep
mid-run, and the frozen run timed out hours later. A run exits at once, writing nothing, when
`pull.log`'s last pull line and `backup.log`'s last line are both `ok` and dated today (Eastern), so a
good day costs one run and a frozen one is followed by another within the hour. If the Mac is asleep
at a slot, it runs on wake; if the Mac is off, the slot is skipped. On wake the network is often not
back yet, so the job waits up to ten minutes for Fly to answer. The installer refuses from a
worktree, and if `fly` is missing or logged out. Before installing, it runs the pull as a dry run
and the backup for real, both from launchd's bare environment, and refuses if either fails:

```bash
bash ~/Hexagon/ops/install-pull.sh   # install, from the main checkout (run it yourself)
launchctl start com.hexagon.pull     # run it now
bash ~/Hexagon/ops/uninstall-pull.sh # remove; stops the pull and the backup, leaves the archive, the iCloud copy and the box alone
```

**The same job is the Mac's backup** (installed and first run 2026-09-24). After the pull, whether
or not it worked, `run-pull.sh` copies `data/chains`, `data/options` and `data/fly/archive` with
`rsync -a` into `~/Library/Mobile Documents/com~apple~CloudDocs/Hexagon-backup/` (iCloud Drive): no
`--delete`, no `.part` files, never `.env` or a `.pem`, and it refuses when iCloud Drive does not
exist rather than make a local folder that only looks like a backup. A failed copy writes its own
`PROBLEM backup` line to `pull.log` (which does not mean the box went unpulled) and to `backup.log`,
and is tried again the next hour; a good one writes an `ok` line to `backup.log`. The job's exit
code is the pull's. `bash ops/run-pull.sh --backup-only` runs only the copy. `.env` and
`kalshi-private-key.pem` are deliberately not in it: back them up separately (Time Machine on an
external disk covers them). If macOS ever refuses the LaunchAgent write access to iCloud Drive, the
only sign is an hourly `PROBLEM backup` line.

Every run that does anything leaves a line in `data/fly/archive/pull.log`, including runs that fail
before the pull starts (no node, no fly, logged out, offline). No new line for a day, or a `PROBLEM`
line, means look (`ops/daily-check.sh` step 1 reads it). Full output of each run goes to `~/Library/Logs/hexagon-pull.log`.

**On the box, the emergency brake** (`src/recorder.js`). This is only for when the pull has
stopped. The recorder checks free space on the first write and then once an hour. Below
`TAPE_MIN_FREE_MB` (200 on a Fly machine), it deletes the oldest `ticks-*.jsonl` files one at a
time, never more than that one reading of free space calls for, and stops as soon as free space is
back above the limit. It never deletes today's (Eastern) tape or anything that isn't a tick tape.
Each deletion goes in the activity log as `TESS OPS disk low · …`, which says the tape may not
have reached the Mac and to run `tools/fly-pull.js`. Seeing that line means the pull isn't
running. `TAPE_MIN_FREE_MB=0` turns the brake off. It is off by default anywhere but a Fly machine
(Fly sets `FLY_MACHINE_ID`): the Mac's own `data/ticks-*.jsonl` exist nowhere else.

## Two things to be clear about

**Do not put the Kalshi private key on a cloud box to run live.** A key sitting on a rented
machine, reachable by a web process, is a different risk from a key on a laptop — and the desk has
not earned it: the paper books have lost money (2026-09-10 → 09-24 17:58Z realised: convergence −$643,
locked arbs −$222, maker −$852; `tools/pnl-report.js`), so there is no edge to fund. If that changes, the right shape is a separate, locked-down machine that runs no
web server at all, not this one with more environment variables. That includes putting the key
there just for the trade socket: the socket is a Mac-side improvement, and the cloud box keeps
polling — the tape reports `tape: polling` on its dashboard, and that is the intended state.

**Both boxes will trade the same markets.** Two desks quoting the same book compete with each
other and each one's fills look better than the pair deserves. Stop the Mac copy when the cloud one
is live:

```bash
bash ops/uninstall-autostart.sh
```
