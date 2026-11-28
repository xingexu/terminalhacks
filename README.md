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
2. Use the candidate reasons to choose a memory, preview the link or attributed recollection, and confirm it. Switch between **Memories**, **Studio**, and **Stories** to see the updated memory.
3. In **Films**, preview a film, render it, and approve it before playback or download. A confirmed voice note can become narration. Corrections and revocation can make a prior film stale.
4. **Studio → Photo album** lets you select reviewed photos from one memory or the whole project, ordered by capture date. Choose **Enter album** to walk through a designed coastal setting. Use WASD or the on-screen arrows to move, drag to look, Shift to sprint, and E to open a nearby photograph and its story. The map and **Next photo** let you jump between stops. Photo selections apply to the current walk, and visited-photo progress is saved in this browser. **Memories → Enter memory** opens the same experience for that memory.
5. **Memories → Import 3D scene** accepts prebuilt `.spz` reconstructions or self-contained `.glb` meshes from LiDAR/photogrammetry. Link an original photo documenting the place, import the scene, and approve it. For GLB, choose **Choose floor to walk**, then click an open floor surface. WASD, mouse/touch look, Shift sprint and Space jump use capsule collisions, gravity and fixed physics steps against the actual mesh. Scans need meter units, Y-up orientation, embedded textures, at most 250,000 triangles, and a file size below 48 MB. The walkable album lays out photos in a designed environment. Reconstruction of the photographed place requires a separately produced scene.
6. Open the project switcher in the menu bar and choose **Settings for** your project to revoke a capture grant or delete a project.

## Generate a scene from a photo and memory

Install [Ollama](https://ollama.com/download), start its server on `127.0.0.1:11434`, and run `ollama pull qwen3-vl:4b` on the machine running Everwhere. The model download is approximately 3.3 GB.

In **Explore → Step inside this photo**, select a confirmed original photo. Type remembered details or focus the description field and hold **Fn** with VoiceOS running and configured for dictation. Release Fn, review the inserted words, and connect the desired Higgsfield account. This OAuth connection belongs to Everwhere and requires its own authorization. Confirm permission and select **Generate immersive scene**.

The local vision model interprets the photo into a bounded scene plan. Higgsfield 3D Jutsu builds that plan as editable geometry and exports a GLB. This version uses estimated geometry and simple materials. Scale and hidden areas are inferred. The photo remains local, while the interpreted layout and remembered details are sent to Higgsfield and retained in its account. Everwhere stores OAuth credentials server-side in owner-only files under the private data directory.

Progress appears in Explore. Approve the completed reconstruction and choose **Walk in** the scene. The viewer tries the generated standing position and uses the mesh for collision. If that position is obstructed, choose a clear floor surface. WASD moves, dragging turns, Shift sprints, and Space jumps. Imported scans and the designed photo album remain available alongside generated scenes.

Jobs retain source identity, request identity, provider project and operation IDs. A changed or withdrawn source invalidates its generated scene. **Check and resume generation** reconciles saved operations after interruption. Removing a local source makes the Everwhere scene unavailable. Manage copies retained by Higgsfield in that account.

## Immersive runtime and V3.1 camera paths

In a single-memory album or an approved GLB, open **Scene tools** to pause, reduce motion, change artistic lighting or lower rendering resolution. Walk to a safe position, select **Record camera path**, explore for at least ten seconds, then stop. **Replay path** uses timestamped position and quaternion interpolation. **Export path** downloads a V3.1 envelope containing `context`, `sceneManifest` and `cameraPath`, each matching its definition in `packages/contracts/engine-exchange.schema.json`. This is the camera-path subset of the exchange, ready for Arin's renderer. It contains virtual movement and source IDs. Imported-scene scale remains unverified. Whole-project albums require choosing one memory before path export.

The runtime derives bounds and collision from loaded, approved geometry and records the user-selected safe spawn. Existing imports have no provider-supplied scene plan, so their runtime manifests identify the import and report null scale confidence. It samples at up to 20 Hz, simplifies within 2 cm / 0.01 rad, checks interpolated capsule clearance, and binds exports to the current server-authorized revision and input hash. Changing permissions or graph state requires a new recording. The current owner-only authorization policy has version 1. Source revocation and current authorization are checked again before export. Downloaded files remain on the recipient's computer.

**Performance** displays actual frame intervals, nearest-rank median FPS, p95 frame time, canvas resolution and GPU allocation counts. Restart measurement after loading. Paused and hidden frames are excluded. A guided SPZ inspection remains available when no collision mesh exists. Original photos remain available after a WebGL failure. Shared-world portals and skiing are P1 follow-ups, gated as described in the execution package. Provider reconstruction belongs to the scene-generation workstream.

The designed coast uses CC0 Poly Haven HDR lighting and concrete PBR maps, bundled locally. Run `node scripts/fetch-polyhaven.mjs` to refresh the four pinned asset selections through the documented public API. The script identifies Everwhere, verifies sizes and hashes, and records licenses, source pages and SHA-256 hashes in `apps/web/public/environment/provenance.json`. Private media stays on Everwhere. These materials enhance the designed environment and are independent of the photographed location.

Reusable implementations are Three.js `Octree`, `Capsule`, `GLTFLoader`, `HDRLoader` and `OrbitControls`, plus the existing Spark splat renderer. Poly Haven assets are CC0. Three.js and Spark retain their dependency licenses. Unreal Pixel Streaming requires a separately hosted engine application and streaming infrastructure.

- https://polyhaven.com/our-api
- https://polyhaven.com/license
- https://threejs.org/docs/pages/HDRLoader.html
- https://github.com/mrdoob/three.js/blob/dev/examples/games_fps.html
- https://dev.epicgames.com/documentation/unreal-engine/pixel-streaming-in-unreal-engine

## VoiceOS

1. On the Mac running VoiceOS, clone this repository and complete **Run locally** above. Keep the API running. Open its local address in your browser, then **VoiceOS** in the menu bar.
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

Hardware microphone input, real-device graphics performance, and V3 shared universes need separate verification. Generated scenes require the local vision runtime and a live Higgsfield connection.
