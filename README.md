# Everwhere

Everwhere is a private memory app for turning selected photos, clips, and recollections into an explorable timeline, albums, journals, and films. This build implements the private web workflow from the V2 handoff. The first visit opens an illustrated Dolomites project with fictional copy and labeled, generated imagery. Choose **My universe → New project** to start with an empty project.

## Run locally

Use Node.js 24 or newer and put `ffmpeg` and `ffprobe` on your PATH. FFmpeg needs the H.264 and AAC encoders. Run the following from the project directory.

```sh
npm ci
npm run build
npm start
```

Open `http://localhost:4173`. Set `PORT` to change the port and `EVERWHERE_DATA` to choose a persistent directory for SQLite and original files. The server defaults to `.data`. Keep that directory private and outside any static web root. Project access belongs to the browser session on that app origin. Use the same browser profile to reopen it. Account recovery and cross-device sign-in are outside this build.

## Try the workflow

1. Create or select a memory. Open **Capture memory**, confirm permission, and choose photos, clips, or a voice note. Each upload waits in the review inbox.
2. Use the candidate reasons to choose a memory, preview the link or attributed recollection, and confirm it. Switch between **Explore**, **Create**, and **Remember** to see the updated memory. **Archive** records revisions.
3. In **Watch**, preview a film, render it, and approve it before playback or download. A confirmed voice note can become narration. Corrections and revocation can make a prior film stale.
4. **Explore** can open a photo trail or import a prebuilt `.spz` reconstruction. To use the reconstruction, link an original image, import the SPZ, and approve it. Turn off **Originals only** to open the scene.
5. Use **Project settings** to revoke a capture grant or delete a project.

## VoiceOS

Open **Connect VoiceOS** and create a time-limited pairing token. In the VoiceOS MCP integration, launch Node with the absolute path to `apps/mcp/index.mjs` as its argument and supply `EVERWHERE_API`, `EVERWHERE_PROJECT`, and `EVERWHERE_PAIRING_TOKEN` through the integration environment. The API origin must be reachable from the bridge process. Use HTTPS for a remote origin or HTTP on loopback. Revoke the pairing from Everwhere when finished. The local SDK test exercises the bridge over stdio. The release gate for real VoiceOS Agent Mode requires a separate run. [VoiceOS MCP guide](https://www.voiceos.com/guide/build-mcp-integration)

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
