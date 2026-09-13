# Running the desk in the cloud

The desk currently runs on the Mac under launchd. That is fine for watching it, but it stops when
the machine sleeps, and the one thing this strategy needs is **days of uninterrupted tape**. A
cloud box fixes that.

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

fly secrets set DASH_PASS="$(openssl rand -base64 18)"     # prints nothing; read it back below
fly secrets list                                            # confirms it is set, not its value
fly deploy
fly open                                                    # browser prompts: user "hexagon"
```

You need the password you generated, so either pick your own instead of `openssl rand`, or run
the `openssl` line on its own first and copy the output.

Roughly $2–4/month for a shared-cpu-1x with a 1GB volume.

### Auto-deploy

Every push to `main` deploys itself (`.github/workflows/test.yml`, job `deploy`): it waits for the
test matrix, stands down if a newer push has landed on `main`, skips pushes that touch nothing the
box runs (docs, `ops/` notes), and refuses to ship
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
fly logs                        # live
fly ssh console -C "node tools/fillcheck.js 24"    # the one number that matters
fly ssh console -C "node tools/maker-report.js"
```

## Two things to be clear about

**Do not put the Kalshi private key on a cloud box to run live.** A key sitting on a rented
machine, reachable by a web process, is a different risk from a key on a laptop — and the desk has
not earned it: live fills are running at 50% of the modelled rate and the held-out edge is a few
dollars a day. If that changes, the right shape is a separate, locked-down machine that runs no
web server at all, not this one with more environment variables. That includes putting the key
there just for the trade socket: the socket is a Mac-side improvement, and the cloud box keeps
polling — the tape reports `tape: polling` on its dashboard, and that is the intended state.

**Both boxes will trade the same markets.** Two desks quoting the same book compete with each
other and each one's fills look better than the pair deserves. Stop the Mac copy when the cloud one
is live:

```bash
bash ops/uninstall-autostart.sh
```
