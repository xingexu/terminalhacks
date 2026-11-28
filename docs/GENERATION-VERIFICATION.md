# Procedural generation verification — November 28, 2026

Implementation commit `e7437ea`, integrated with PR4's focus-restoration commit `1015688` at `284d822`. Codex was integration lead; three focused Codex workers owned generator, frontend and API tests. An actual interactive Claude Code session in cmux (`9a1cd63f-ed56-453c-ab88-7eee57310626`) performed independent review with a native security subagent. Both native reviewers finished and their workspace was closed.

## Independently checked by the integration lead

- `npm test`: **77/77 passed**, 10.7 seconds, Node 24 on the demo Mac. Includes actual API/SQLite, real stdio MCP, 30-second 1920×1080 H.264/AAC film, 15 generator variants, collision, timezone/GPS retention, actor isolation, stale evidence, idempotence and revocation.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed. Typecheck/build were repeated after merging the team's focus fix. Existing large Three.js/SPZ bundle warning remains.
- Installed Playwright MCP, Chrome, local production build at `127.0.0.1:4173`, isolated data directory and explicitly synthetic fixtures: create project/memory; invalid GPS rejection; upload three EXIF/GPS photos; individually review links; add a recollection via the actual MCP process; observe the browser update live; research Wikipedia with real cited results; preview/generate/approve a world; enforce Originals only; enter the WebGL world and walk using saved stops and keyboard input.
- Browser scene: 60-second camera path recording, replay, JSON export, reduced-motion toggle and pause. Displayed rolling 1,800-frame sample: **120.5 median FPS, 9.2 ms p95, 1200×1159 render buffer**, four geometries/four textures. At this frame rate the retained sample is approximately 15 seconds, not a whole-session benchmark.
- Responsive generation panel at **390×844**: no horizontal overflow; form/preview usable. Keyboard Escape dismisses dialogs. Additional screen-reader and contrast audits were not performed.
- Failure drills: synthetic 502 place lookup offers retry/own-evidence continuation; definitive generation 409 unlocks a fresh preview; discarded generation response retries with the exact same request ID and returns one pending world; delayed old generation does not dismiss a newly opened memory dialog. Pending worlds display stable variant numbers.

The full browser flow used synthetic files visibly marked as such. It proves application behavior, not reconstruction quality or a real participant's consent.

## Review findings resolved

CodeRabbit's actual uncommitted review returned two minor findings: late completion could dismiss another dialog, and pending-world buttons were indistinguishable. Both were fixed and checked in the browser.

Native Claude found exact-GPS leakage to voice responses, personal titles in place searches, raw evidence in handoff exports, a stale-preview retry trap, and revocation copies in film manifests/approval caches/anchors. Fixes round voice GPS, send only the place label to Wikipedia, export evidence counts/citations rather than private text, recover from rejected previews, and scrub affected derived records. Whole-state regression tests cover withdrawn recollection text. Claude's final static re-review found all requested fixes resolved and no new material issue; the integration lead separately ran the tests above.

## Open gates and limits

- **Native spoken VoiceOS is NOT VERIFIED.** The stdio MCP handshake, commands, confirmation path and browser update passed. VoiceOS was unavailable in accessible installed/running apps; the user was asked where it is installed. Its native research-consent card must be seen before claiming the sponsor journey complete.
- **Procedural, imagined surroundings.** This is the owner's selected fallback. Original A05 measured reconstruction/provider-world criterion is not met. No native Unreal import, Pixel Streaming, hosted generation, deployment or hackathon submission is claimed.
- Source corrections retire worlds; inaccessible stale GLBs remain on disk until revocation/project deletion. Revoked media tombstones retain GPS/timestamp/hash in SQLite; authenticated snapshots and asset routes filter them out. No retention migration or secure-erasure claim.
- New captures preserve recollection identity through undo. Legacy captures already undone before that field existed may leave inaccessible stale artifacts or historical cached text. Use a fresh project for the demo; no speculative migration was applied to user data.
- Replaying a historical approval after ordinary staleness can return its cached success, without restoring the world. Revocation replays are rejected. Downloaded GLBs contain private photos and cannot be remotely withdrawn.
- No Python handoff-reference suite rerun: `jsonschema` was absent in the local Python environment. The Node suite checks the active runtime contracts. No new Python environment was installed for unrelated reference fixtures.
- A rebuild while an old browser page was open invalidated its hashed lazy-load URLs; reloading recovered. Freeze the build and reload before rehearsal. Expected injected failures and server-restart disconnects were separated from application results.

Use [DEMO.md](DEMO.md) for the five-minute run. Reserve 2:30–4 p.m. Toronto for native-device rehearsal and submission checks; do not expand scope before those gates pass.
