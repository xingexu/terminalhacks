# Everwhere

Revisit a memory through its photos, your description, and a photographic view of the place.

This hackathon build focuses on **Mont-Tremblant and Le Shack**. Add a permitted photo, review its attachment to a memory, describe the location, and open a matching reviewed Street View stop. Use the keyboard or the paired VoiceOS app to explore. Photos and recollections remain attached to the memory; they do not regenerate Google's imagery.

## Run

Requires Node.js24+, FFmpeg and ffprobe. From this repository:

```sh
npm ci
cp apps/web/.env.example apps/web/.env.local
# Set VITE_GOOGLE_MAPS_API_KEY in the private .env.local file.
npm run build
EVERWHERE_DATA="$PWD/.data" PORT=4173 npm start
```

Open http://127.0.0.1:4173. Enable Maps JavaScript API and restrict the browser key to the intended HTTP referrer and API. Never commit .env.local, the private data directory, or pairing tokens. A browser key is necessarily delivered to the browser; restrictions are essential.

Create a project and memory, then import and approve an authorized Street View tour using the existing scene import. The prepared demo's private data is not included in Git. Project access uses a browser session; retain the same origin/profile. [Tour format](packages/media/tour.mjs) and [demo guide](docs/DEMO.md) describe the supported path.

## Demo flow

1. **Capture and review:** choose a photo or open the computer camera. Camera permission and source consent are explicit; captures wait in the inbox until reviewed.
2. **Describe the place:** provide a location such as “the entrance of Le Shack.” Matching uses the supplied description and reviewed route titles, not computer vision. Ambiguous places require a choice.
3. **Revisit:** open the approved location. W/S move between linked panorama positions, A/D turn, and dragging changes the view. Supported API settings hide navigation arrows; Google and photographer attribution remain visible.
4. **VoiceOS:** pair under Connect VoiceOS and install the custom-action manifest. Movement waits briefly for a matching browser receipt; a queued command is not reported as completed. Use reviewed anchors for restaurant entry/return.
5. **Remember:** inspect linked sources, save a reviewed recollection, exit and reopen. The authored stop and heading are retained. Arbitrary intermediate Google panorama positions are not persisted.

The current route is Village terrace → Le Shack entrance → Inside Le Shack, with return links and actual available interior coverage. Coverage, imagery season and capture dates come from Google; they do not establish a personal trip's date.

## VoiceOS setup

```sh
npm run voiceos:manifest
node apps/mcp/index.mjs
```

Use an absolute Node path and absolute adapter path in the native integration. Configuration may use EVERWHERE_API, EVERWHERE_PROJECT and EVERWHERE_PAIRING_TOKEN, or a private `~/.config/everwhere/voiceos.json` containing `api`, `project`, `token` (file0600, directory0700). Any environment configuration takes precedence. The local file is re-read on each call. Tokens expire after two hours; replace them in the browser and update the same private configuration. Restart VoiceOS after tool-schema changes.

## Verify

```sh
npm test
npm run typecheck
npm run build
```

See [acceptance status](docs/ACCEPTANCE.md) for exactly what was verified. Native speech, physical camera capture, local execution, deployment and submission are separate checks. This repository contains the app, not the separately produced companion film or video-generation production files.
