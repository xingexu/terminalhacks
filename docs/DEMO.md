# Everwhere — Mont-Tremblant demo

## Current build (November 28, 2026)

**Latest execution checkpoint — November 28, 2026.** This status supersedes the earlier GLB/procedural milestones in the historical documents. The integration lead verified **186 passing tests, typecheck and production build**; real browser panorama movement, source inspection, saved stop/heading reopening and the 390px layout passed. The user confirmed a native spoken turn worked. A real **640×480 camera preview opened with a browser receipt**, and a newly uploaded public sample photo was reviewed and attached to the same memory. Five synthetic camera lifecycle checks passed; these are not hardware or native-speech capture proof.

**Still pending:** native broad “walk around Le Shack” navigation, native physical-photo capture, a reviewed spoken recollection/correction, and the complete timed rehearsal. Do not report the whole end-to-end goal as verified until those steps are observed. The finished companion film is linked below.

The active one-hour sprint runs **11:51:38–12:51:38 America/Toronto**. The live experience uses Google Maps JavaScript Street View. Navigation arrows are disabled with supported controls; Google and photographer attribution remain visible. This replaces the rejected photo-box walking experiment. Panorama-to-panorama movement is accepted; this is not a continuous 3D reconstruction.

The prepared memory is **Winter in Mont-Tremblant**. Its reviewed route has three stops: **Village terrace → Le Shack entrance → Inside Le Shack**, with return routes. Le Shack’s own published virtual tour supplies the real interior coverage. Reference images and public place context are not evidence of the user’s trip or its date.

### Run locally

```sh
cd "/Users/tejasskaushik/Documents/ChatGPT/Terminal Hacks Hackathon/repo"
npm run build
EVERWHERE_DATA="$PWD/.data/terminal-hacks-demo" PORT=4173 npm start
```

Open `http://127.0.0.1:4173/p/193a740f-5e50-47d9-bddd-c9e9f7599dd3/explore` in the prepared browser profile. The prepared data is backed up in ignored `.data/terminal-hacks-demo` (SQLite quick_check passed). The browser needs its existing project cookie. The restricted Maps browser key is in ignored `apps/web/.env.local`; never paste it into a submission or commit it. Another computer needs its own configured key, allowed referrer, data and pairing.

VoiceOS runs the absolute Node command pointing at `apps/mcp/index.mjs`. The private pairing configuration is read on every call. The current pairing expires **2:39:40 p.m. Toronto**; refresh pairing before the afternoon presentation. Restart VoiceOS after adapter/tool-schema changes and confirm refreshed custom actions if requested. Keep the intended demo tab visible: another open viewer can own voice commands.

### Five-minute route

1. **Purpose and inputs (30s).** “Everwhere connects a memory’s photos and context to a place you can revisit by voice.” State that this demo uses public/generated references and Google’s current available imagery; personal dates remain unknown.
2. **Capture and review (60s).** Open the computer camera through VoiceOS. Show a permitted photo, check the live preview, then capture it. Review the pending source and choose its memory before confirming. The camera is acquiring a source; it is not generating the Google panorama. If native camera capture has not passed rehearsal, use the visible camera controls and disclose that limitation.
3. **Explore (90s).** Enter Village terrace. W/S follow connected panorama positions; A/D turn; drag to look. In VoiceOS, ask for a forward step, a turn and stop. “Walk around Le Shack” uses current available directions and reviewed destinations; 90° is a per-turn bound, not a fixed-view limit. Use the named entrance and interior controls, then return outside.
4. **Sources and context (60s).** Open About this place and inspect the public reference. Show the newly reviewed camera image in the memory's Capture/library view. Add a presenter disclosure or real recollection using preview/confirm; never invent a personal memory. Linking a new photo attaches it to the memory; it does not regenerate Google's panorama or automatically add it to the existing route's source associations. Appending a photo/recollection leaves this imported route approved. Withdrawing one of its existing sources makes it unavailable; generated assets and films can also become stale when their dependencies change.
5. **Persistence and close (60s).** Exit, reload and reopen. The authored stop and viewing direction persist; an arbitrary intermediate Google panorama is not promised to persist. Close with the working scope and next step.

### What has actually been checked

- Live Google route and real interior rendered in the browser.
- Keyboard turn and actual provider-panorama hop passed; authored stop/heading survived exit/reload/reopen.
- Sources panel and linked source opened; 390px layout had no clipped controls and retained credits.
- User confirmed native spoken turn worked after correcting the tab they were watching.
- Real 640×480 browser camera preview and its receipt passed. A new credited public photo was uploaded, reviewed and saved. Five synthetic permission/retry/cleanup/late-resolution/ownership checks passed separately.
- Broader native natural-language navigation, physical-photo capture/review, and a reviewed spoken write remain separate rehearsal gates until observed.
- Integration lead verified 186 passing tests, typecheck and production build. These checks do not establish native speech or physical-photo capture.

### Sixty-second companion presentation

The companion video is produced separately and is not part of this repository. Its60-second outline: sample photo and supplied location; review known place context; clearly labeled concept visuals; actual app navigation; VoiceOS command examples. Generated footage must not be presented as a recording of working app behavior. Current actual-app footage shows keyboard and on-screen navigation; native speech is not shown.

### Recovery and submission

No available path: turn or choose a reviewed destination. A blocked movement is not success. No Google coverage/network/key: show the readable error and retry or return. Wrong browser: return to the intended tab and reopen its scene. Source withdrawal and dependency invalidation must not be bypassed.

#### Pairing recovery before 2:39:40 p.m. Toronto

The relocated demo database retains the current pairing's **November 28, 2026, 2:39:40 p.m. Toronto hard expiry**. Calls update activity, not expiry. A replacement lasts two hours from creation and immediately revokes the old token.

1. In the prepared browser/profile at the local project, open **Connect VoiceOS → Pairing settings → Replace pairing token** (or **Create pairing token** after expiry). Keep Everwhere running and keep the displayed token private.
2. Update the configuration actually used by the native MCP process. This setup uses the private `~/.config/everwhere/voiceos.json` file when no explicit environment setup exists: preserve its `api` and `project`, replace its `token`, and keep the file owned by the user with mode `600`; its parent directory must not be group/world-writable. Do not put the token in Git, chat, screenshots or logs.
3. If the native process has any of `EVERWHERE_API`, `EVERWHERE_PROJECT` or `EVERWHERE_PAIRING_TOKEN` configured, that environment configuration takes precedence over the file as one complete group. Update its token and retain the matching API/project there, then reload that native integration. Do not assume editing the fallback file overrides an old environment token.
4. File-based token changes are read on the next tool call; they do not require an API-server restart. Adapter/tool-list changes do require reloading the native integration. Ask VoiceOS which memory is open, verify the intended project and updated bridge activity, then perform one visible turn and check its matching receipt in the intended tab. A successful context lookup alone is not movement proof.

The previously recorded official rules and schedule specify a working web app, a five-minute live demonstration without slides, and a 4 p.m. build end. Published judging dimensions include functionality, brief fit, live demonstration and six-hour scope; numerical weights are unknown. The user reports organizer permission for the existing repository and advance coding. Recheck organizer instructions before submitting. Deployment and external submission are not established by localhost tests. No new sprint changes have been pushed as of this document update.

### Final integration check — November28,12:40 Toronto

The real browser accepted a new Ccheck7 public-reference photo with credits, previewed and confirmed its memory link, retained it after reload, rejected generic/ambiguous place descriptions, and opened Le Shack entrance from the supplied description. A clearly labeled demo note was previewed and confirmed through actual MCP; this was a tool-driven check, not native speech. Native Fable5.2 reviewed the merged viewer/camera lifecycle and found no blocking regression. The latest team UI is retained while the old external video-generation API pipeline is removed.
