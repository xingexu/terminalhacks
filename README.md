# Everwhere

Everwhere is a private memory app for turning selected photos, clips, and recollections into an explorable timeline, albums, journals, and films. This build implements the private web workflow from the V2 handoff. The landing page opens into a short first-use tutorial, which can be replayed with the sidebar help button. Choose **Create a project** to begin, or explore an illustrated Dolomites sample with fictional copy and labeled, generated imagery.

## Run locally

Use Node.js 24 or newer and put `ffmpeg` and `ffprobe` on your PATH. FFmpeg needs the H.264 and AAC encoders. Run the following from the project directory.

```sh
npm ci
npm run build
npm start
```

Open `http://localhost:4173`. Set `PORT` to change the port and `EVERWHERE_DATA` to choose a persistent directory for SQLite and original files. The server defaults to `.data`. Keep that directory private and outside any static web root. Project access belongs to the browser session on that app origin. Use the same browser profile to reopen it. Account recovery and cross-device sign-in are outside this build.

## Try the workflow

1. Create or select a memory. Open **Capture**, confirm permission, and choose photos, clips, or a voice note. Each upload waits in the review inbox. Use **New memory** in the inbox when you need a destination.
2. Use the candidate reasons to choose a memory, preview the link or attributed recollection, and confirm it. Switch between **Memories**, **Studio**, and **Stories** to see the updated memory. **Library** records revisions.
3. In **Films**, preview a film, render it, and approve it before playback or download. A confirmed voice note can become narration. Corrections and revocation can make a prior film stale.
4. **Studio → Photo album** lets you select reviewed photos from one memory or the whole project, ordered by capture date. Choose **Enter album** to walk through a designed coastal setting. Use WASD or the on-screen arrows to move, drag to look, Shift to sprint, and E to open a nearby photograph and its story. The map and **Next photo** let you jump between stops. Photo selections apply to the current walk, and visited-photo progress is saved in this browser. **Memories → Enter memory** opens the same experience for that memory.
5. **Memories** also imports prebuilt `.spz` reconstructions. Link an original image, import the SPZ, and approve it. Turn off **Originals only** to open the reconstruction. The walkable album lays out photos in a designed environment. Reconstruction of the photographed place requires a separately produced scene.
6. Use **Project settings** to revoke a capture grant or delete a project.

## VoiceOS

1. On the Mac running VoiceOS, clone this repository and complete **Run locally** above. Keep the API running. Open its local address in your browser, then **VoiceOS** in the sidebar.
2. Open **VoiceOS** from Applications or Spotlight on your Mac. In VoiceOS 0.1.43, installed custom integrations are under **Apps → Custom → Everwhere**. Keep Everwhere enabled. If it is missing, install this repository folder, which contains `voiceos.integration.json`. Versions with folder import expose **Settings → Agent Mode → Integrations → Install from folder**. Version 0.1.43 may omit that control, so check the official installation guide for your version. Node must be available to VoiceOS. If a shell-only Node installation is unavailable to the desktop app, set `runtime.command` in the manifest to the absolute Node executable path and reload.
3. In the integration's setup fields, set **API origin** to the running server address and copy the **Project ID** from Everwhere's **VoiceOS → Pairing settings**. Create a pairing token there and paste it into VoiceOS's secure **Pairing token** field. Save.
4. Check your **Agent Mode** shortcut in VoiceOS Settings. For a **Control + Option** shortcut, hold both keys, ask “What memory is open in Everwhere?”, then release. Everwhere shows **Bridge reached this project** after a successful authenticated tool call. Try “Switch Everwhere to Remember”, then ask it to preview a recollection and confirm the reviewed change.
5. Pairing expires after two hours. Create a replacement token and update the integration's setup fields to continue. **Revoke token** immediately removes the existing bridge's access. Everwhere's tutorial ends with a **Set up VoiceOS** button, and setup remains accessible from the desktop sidebar and mobile header.

The included manifest permits the loopback aliases `127.0.0.1`, `localhost`, and `[::1]`. For a different local hostname or HTTPS deployment, download the server manifest from the browser panel, replace the repository's manifest, and reinstall or reload. The manifest contains the API origin and permissions. Secrets stay in VoiceOS setup fields. `npm run voiceos:manifest` regenerates the default manifest from the canonical tool schemas.

Devin previews require an interactive Devin login. Run Everwhere locally for desktop pairing, or host the API at an HTTPS origin reachable by the bridge. Each server has its own projects and pairing tokens.

The integration uses standard MCP over stdio, native result cards, and confirmation before committing reviewed changes. The test suite verifies the real MCP handshake, manifest/tool parity, pairing status, revocation, and live browser events. Authenticated VoiceOS Agent Mode on macOS remains a separate verification step. [VoiceOS installation guide](https://docs.voiceos.com/integrations/distribution) · [Manifest reference](https://docs.voiceos.com/integrations/reference/manifest)

## Verify

```sh
npm run typecheck
npm run build
npm test
python3 -m venv .venv
.venv/bin/pip install jsonschema==4.26.0 rfc3339-validator==0.1.4
.venv/bin/python packages/contracts/validate_contracts.py
.venv/bin/python packages/contracts/validate_capture.py
```

`npm test` starts the real API with temporary SQLite data, exercises the MCP process, compiles a film with FFmpeg, and checks SPZ file authorization. See [the release evidence](docs/release-evidence.csv) for measured results and open gates. The handoff's reference tests were run separately from its original ZIP.

Live VoiceOS Agent Mode, browser microphone and WebGL performance remain unverified. Reconstruction generation through a hosted provider and V3 shared universes are outside this build. The app is served as a session preview.
