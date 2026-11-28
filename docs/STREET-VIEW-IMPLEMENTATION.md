# Street View implementation

## Scope and deadline

One-hour implementation window: November28,2026,11:51:38–12:51:38 America/Toronto. One Mont-Tremblant route. Codex owns integration and final verification; native Claude Fable5.2 handled frontend work and focused review; scoped workers handled API/MCP tests and independent checks.

## Critical journey

Permitted photo → review attachment to memory → supplied location description → resolve reviewed stop → photographic Street View → keyboard/VoiceOS navigation → inspect sources and reviewed recollection → save/reopen.

Photo inspection reads available metadata. Place resolution uses the user's description against approved route titles/descriptions; it is not image recognition. Ambiguous/no-match requests do not silently select a location. A new image joins the memory and does not generate Google's panorama.

## Implementation

- Official Maps JavaScript Street View with linksControl/clickToGo disabled and required attribution retained.
- Connected provider panoramas for directional movement; named approved anchors for entrance/interior transitions.
- Same controller for keyboard and native movement requests, viewer ownership, stale-command expiry, cancellation and matching browser receipts.
- Camera open/capture/close through existing MCP actions; explicit browser permission and source consent. Frames enter review, never automatic memory linking.
- Private browser project access and expiring native pairing. Sources, unknown dates and recollections retain provenance; withdrawing a route source blocks the route.
- Native tools expose current available directions and reviewed route connections for short multi-step requests. A90-degree bound is per turn.

## Release checks

Run tests/typecheck/build, test actual route and failures, then independent review. Confirm native speech separately from direct API/MCP tests. Preserve and inspect existing changes before the authorized Git push. No deployment or submission is implied by a push.

The separate companion presentation is60seconds and distinguishes generated concepts from working-app capture. Video production files and credentials are excluded from this code deliverable.

See [DEMO.md](DEMO.md) and [ACCEPTANCE.md](ACCEPTANCE.md) for current operating instructions and verification status.
