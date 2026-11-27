# Release acceptance matrix
Record each test as PASS / FAIL / NOT RUN, with commit, environment, elapsed time, evidence link and owner. All P0 must pass for full claim; fallback never silently counts as primary feature. Targets below are internal, not measured results.

| ID | Test | Pass condition | Owner |
|---|---|---|---|
| A00 | Rules & data | Actual event confirms permitted team size, agent use, code timing; consented assets and provider rights | 1,10 |
| A01 | Sponsor integration | Real VoiceOS Agent Mode invokes `get_context` and 2 mutations; browser receives live change without typing | 2 |
| A02 | Import | Fresh 40 images + 3 clips, no silent losses, duplicates grouped, missing metadata remains unknown | 3 |
| A03 | Retrieval | 20 human-labeled queries with at least 5 relevant items each; mean precision@5 ≥0.85; report p50/p95, target p95 <2s after index | 3 |
| A04 | Storyroom | 5 new nonleading queries, user-confirmed story stored with participant and source, real voice commands; no unsupported fact | 2,4 |
| A05 | World | Genuine user-media-conditioned world from API or measured reconstruction, loaded and navigable; ≥30 median FPS on demo machine during 30s walkthrough; note resolution and p95 frame time | 5 |
| A06 | Anchoring | Enter world, navigate by voice, add confirmed story at waypoint, reopen source photo and account | 5 |
| A07 | RealityPatch | One spoken confirmed correction updates world anchor/event metadata, film manifest, album, map, journal; p95 <1s from commit to view on 20 local trials; originals unchanged | 4,7 |
| A08 | Revision safety | Duplicate request same result; different payload same ID rejected; concurrent stale write 409; undo new revision; unrelated event edit doesn't invalidate independent scene; stale job cannot publish | 4,8 |
| A09 | Continuity | Switch Explore→Watch→Create→Remember on same event; reload restores selection | 7 |
| A10 | Compiler | Real playable 30–60s MP4 export at 1080p; actual photo and video albums; journal with references; story checkpoints; consistent grade | 6,7 |
| A11 | Integrity | Every generated asset clearly labeled and approved before inclusion; originals-only excludes reconstructed content; contradictory accounts preserved | 4,10 |
| A12 | Privacy | Cross-project ID access rejected; tokens expire; no public original URLs; signed URL policy; deletion cancels jobs/revokes access; no secrets in browser/repo/logs | 8,10 |
| A13 | Reliability | 20 unscripted supported commands ≥18 valid successes, report failure types; no fake tool success | 2,10 |
| A14 | Resilience | Disable each provider, simulate timeout, late completion and duplicate callback; honest fallback, no unapproved render; budget stops paid retry | 8,10 |
| A15 | Deployment | Fresh browser and local backup, 2 consecutive complete demo runs, no uncaught exception, no blocker | 1,10 |
| A16 | Visual/accessibility | Keyboard navigation, reduced motion, captions, visible focus, contrast, mobile album view | 7,10 |
| A17 | Collaboration (P1) | Second contributor media suggestions confirmed, separate accounts and private access | 9 |
| A18 | 4K (P1) | Real file reports 3840×2160 via ffprobe, disclose source detail/upscale, playback works | 6 |
| A19 | POV (P1) | Actual generated clip with user-approved description, label, no unsupported factual claim | 6,9 |
| A20 | Demo | Unseen consented input, genuine VoiceOS, real viewer and MP4; disclose prep, time and cached assets | 10 |

## Scorecard (not a probability of winning)
Problem 10 (A04, A20); differentiation 15 (competitor review + A06/A07/A09/A10); VoiceOS 10 (A01/A13); visual 10 (A05/A10/A16); engineering 10 (A07/A08/A14); emotional 10 (A04 and consented user feedback); cohesion 10 (A09/A10); commercial 5 (credible target + feedback, no fake traction); feasibility 10 (A00/A02/A05/A15); reliability 10 (A12–A15/A20). Evidence required for full marks. Global uniqueness cannot be established from a public search.

## Required failure drills
1. Two edits same revision; one succeeds, other gets 409 and re-preview. 2. Same command retry after network loss, no duplicate recollection. 3. Two accounts disagree, both remain. 4. Unknown person/place, candidates not invented. 5. Missing EXIF, uncertain event ordering. 6. Stale render finishes after correction, excluded. 7. Unrelated event edit, existing independent render remains valid. 8. Deleted source job completes, discard. 9. Unapproved generated clip requested, blocked. 10. Cross-project asset ID and expired pairing token, rejected. 11. Provider 429 / budget exceeded, queue or fallback. 12. SSE dropped, snapshot resync. 13. Poor GPU, reduce detail, no false 3D claim. 14. Browser no WebGL, clearly labeled photo trail. 15. Voice ambiguous, clarification and preview. 16. No narration permission, text only. 17. Audio provider fails, silent export. 18. Unsupported video codec, transcode or informative rejection. 19. Offline venue, local known-good demo with explicit cached assets. 20. Judge asks unsupported action, explain supported options, no claim of completion.

## V2 capture acceptance (required C00–C07, optional C08–C10)
| ID | Test | Required evidence | Owner |
|---|---|---|---|
| C00 | Capture consent | Starts only after explicit grant; visible state; stop prevents further ingest | 2,8 |
| C01 | Incremental input | Newly selected photo not in original fixture enters inbox; real source hash and ID | 3,8 |
| C02 | Candidate matching | 10 labeled pairs including missing GPS and competing events; reasons shown; no silent association | 3,4 |
| C03 | Voice review | Real VoiceOS preview + confirm of fresh source association, append user recollection | 2,4 |
| C04 | Cross-view enrichment | Same event source panel, journal and album update; old dependent film stale; unrelated assets unchanged | 4,5,6,7 |
| C05 | Replay & duplicate | Duplicate input returns same ID; conflicting same source ID rejected; no double link; stale revision rejected | 8,4 |
| C06 | Revocation | Revoked grant rejects new and delayed input; affected jobs/artifacts/index entries inaccessible; no resurrection by undo | 8,10 |
| C07 | Honest return | Reload saved project; source/confirmed revisions survive; no claim of untested device or regenerated geometry | 7,10 |
| C08 | Offline queue (P1) | Stop/revoke while offline, reconnect rejects stale entries and offers explicit reauthorization | 3,8 |
| C09 | Contributor capture (P1) | Two users add authorized media, preserve perspective and no cross-user leak | 9 |
| C10 | Device connector (P2) | Real authorized wearable/native flow, platform lifecycle/permission/battery tests; no claim from mocks | 2,3,8 |
All C statuses begin NOT RUN. Browser microphone is optional where genuine VoiceOS completed text is captured; if demonstrated, explicitly record its permission and stop behavior. Require C00–C07 for full V2 demo claims in addition to prior A gates. No capture test turns reference checks into production validation.
