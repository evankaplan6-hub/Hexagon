# Design review

Fingerprint: 0c8e48e0bcb2fddcc418cfcfdb705290f5ab8e33b37f21dfd71c286838fb48f3
Verdict: pass
Checks: none (only the gate's own files changed)
Tool: claude-code
Reviewed: 2026-11-17 22:31 UTC
Files: .github/workflows/test.yml, ops/design-gate.json, ops/design-gate.mjs

## Notes

Gate-only change: ops/design-gate.mjs, ops/design-gate.json and .github/workflows/test.yml (no screen files), so no design checks and no phone audits apply.
What changed: one script for every gated repo. A repo's broken-route flags and render settings live in its ops/design-gate.json (Hexagon's flags are unchanged). record accepts a second audit.json shape (a list of rows plus meta.json, Sera's tool) and reads the routes file from the base. The built-in defaults no longer name public/ or test.yml; Hexagon's settings list both, plus tools/phone-audit.mjs and tools/phone-audit-urls.txt. The CI self-tests skip on a branch with no gate tests. The fingerprint code is unchanged.
Checked: the gate's own tests, 33 of 33; Hexagon's npm test; the merge guard hook's tests against this script; a full headless render of this branch with the new skill (5 audits and desktop shots, all loaded).
