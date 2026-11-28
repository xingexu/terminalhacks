# Release acceptance matrix

## Current execution status — November 28, 2026

**This section supersedes the historical milestones and status below.** The active one-hour goal is **11:51:38–12:51:38 America/Toronto**, with the event's separate 4 p.m. cutoff. The selected experience is the approved **Google Maps JavaScript Street View** route through the Mont-Tremblant village and Le Shack interior. Panorama-position transitions are accepted; the rejected photo-box/continuous-mesh experiment is not the demo. Google/photographer attribution stays visible. See [current run and rehearsal instructions](DEMO.md).

| Current gate | Status and evidence |
|---|---|
| S01 — Local checks | **PASS:** integration lead verified 186 tests, typecheck and production build. This is local validation, not deployment. |
| S02 — Real route | **PASS:** real browser exterior/interior, keyboard turn and provider-panorama hop; linked-source inspection and authored stop/heading save/reopen verified by lead. |
| S03 — Native movement | **PARTIAL:** user confirmed a native spoken turn worked after watching the correct tab. Broad native “walk around Le Shack” navigation remains **NOT VERIFIED**. Backend support and browser-only tests are not its substitute. |
| S04 — Camera | **PARTIAL:** real 640×480 camera preview opened with a browser receipt. No physical photo was captured. Five [synthetic lifecycle checks](DEMO.md) passed, covering denial, retry, cleanup, late permission and owner takeover; these do not establish hardware capture or native speech. |
| S05 — Reviewed memory input | **NOT VERIFIED LIVE:** native camera capture plus one reviewed spoken recollection/correction, remain required. Existing automated capture/review tests do not pass this gate. |
| S06 — Responsive presentation | **PASS:** lead verified 390px controls and retained provider credits. |
| S07 — Companion film | **PASS:** [final film](DEMO.md), 60s, 1920×1080, 30fps H.264; deliberately silent AAC and seven caption cues. Lead verified decode and sampled frames. Generated concepts and actual app recording are labeled distinctly; no native VoiceOS audio is implied. See [film QA](DEMO.md). |
| S08 — Complete rehearsal | **NOT VERIFIED:** finish the live native/camera/write sequence and timed five-minute rehearsal. A passing subset is not end-to-end completion. |
| S09 — Handoff/submission | Runnable data is now ignored `repo/.data/terminal-hacks-demo` on port4173; original temporary backup is preserved. New sprint push, deployment and submission remain unestablished unless separately recorded. |

**Source attachment is not panorama generation.** A reviewed camera image joins the memory. It does not alter Google's imagery or automatically join the imported route's fixed source list. A read-only cloned-state check showed adding a source/recollection leaves the current imported route ready and approved. Revoking a source actually used by the route still blocks it. Generated scenes/films can be retired when their own dependencies change; preserve those checks.

**Pairing recovery:** the current token expires at **2:39:40 p.m. Toronto on November28**, regardless of activity. Follow the exact [recovery procedure in DEMO.md](DEMO.md): replace through the prepared browser, update the authoritative native environment or private `~/.config/everwhere/voiceos.json` configuration, preserve API/project and file permissions, and verify a context lookup plus visible movement. Replacing the browser token alone does not update native configuration. Current native tool inventory is **21 tools**, with manifest v0.4.0; old 19/20-tool counts below are historical.
