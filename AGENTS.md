# Hexagon — agent instructions

See **[CLAUDE.md](CLAUDE.md)**. It is the single source of truth for this project's layout,
the commands that run it, and the safety invariants around `MODE` / `DEMO` / `LIVE_CONFIRM`.
A change to `public/` merges only with a design review on record: follow the design-gate skill and commit the
`design-reviews/` file it writes (CLAUDE.md, "UI changes").

This file used to carry its own copy of those instructions and drifted out of sync with
CLAUDE.md (stale repo path, stale assertion count). Do not reintroduce the duplicate —
edit CLAUDE.md instead.
