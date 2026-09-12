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
