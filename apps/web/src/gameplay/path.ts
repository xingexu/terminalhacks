import { Box3, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { CameraPath, Context, Keyframe, PathExport, Position, SceneManifest } from './contracts';

export function samplePath(frames: Keyframe[], seconds: number): Keyframe {
  const right = frames.findIndex(frame => frame.t >= seconds);
  if (right <= 0) return structuredClone(right === 0 ? frames[0] : frames[frames.length - 1]);
  const before = frames[right - 1];
  const after = frames[right];
  const alpha = (seconds - before.t) / (after.t - before.t);
  return { t: seconds,
    position: new Vector3().fromArray(before.position).lerp(new Vector3().fromArray(after.position), alpha).toArray(),
    quaternion: new Quaternion().fromArray(before.quaternion).slerp(new Quaternion().fromArray(after.quaternion), alpha).normalize().toArray(),
    fov: before.fov + (after.fov - before.fov) * alpha };
}

export function simplifyPath(frames: Keyframe[]): Keyframe[] {
  if (frames.length < 3) return frames;
  let worst = 1;
  let split = -1;
  const ends = [frames[0], frames[frames.length - 1]];
  for (let i = 1; i < frames.length - 1; i++) {
    const interpolated = samplePath(ends, frames[i].t);
    const distance = new Vector3().fromArray(interpolated.position).distanceTo(new Vector3().fromArray(frames[i].position));
    const angle = new Quaternion().fromArray(interpolated.quaternion).angleTo(new Quaternion().fromArray(frames[i].quaternion));
    const error = Math.max(distance / 0.02, angle / 0.01, Math.abs(interpolated.fov - frames[i].fov) / 0.1);
    if (error > worst) { worst = error; split = i; }
  }
  if (split < 0) return ends;
  return [...simplifyPath(frames.slice(0, split + 1)).slice(0, -1), ...simplifyPath(frames.slice(split))];
}

export function validatePath(path: CameraPath, manifest: SceneManifest, safe: (point: Position) => boolean) {
  if (path.sceneId !== manifest.id || path.revision !== manifest.revision || path.keyframes.length < 2 ||
      path.keyframes.length > 1802 || path.keyframes[0].t !== 0) throw new Error('The camera path belongs to a different scene or revision.');
  const bounds = new Box3(new Vector3().fromArray(manifest.boundsMin), new Vector3().fromArray(manifest.boundsMax));
  let previous: Keyframe | null = null;
  for (const frame of path.keyframes) {
    if (![frame.t, frame.fov, ...frame.position, ...frame.quaternion].every(Number.isFinite) ||
        frame.t < 0 || frame.t > 90 || frame.fov < 20 || frame.fov > 120 ||
        Math.abs(frame.quaternion.reduce((sum, value) => sum + value * value, 0) - 1) > 1e-5 ||
        !bounds.containsPoint(new Vector3().fromArray(frame.position)) || !safe(frame.position)) throw new Error('The camera path leaves the safe scene geometry.');
    if (previous) {
      if (frame.t <= previous.t) throw new Error('Camera timestamps must increase.');
      const from = new Vector3().fromArray(previous.position);
      const to = new Vector3().fromArray(frame.position);
      const distance = from.distanceTo(to);
      if (distance > (frame.t - previous.t) * 12 + 0.1) throw new Error('Stop recording before changing photo stops or waypoints.');
      const steps = Math.max(1, Math.ceil(distance / 0.04));
      for (let i = 1; i < steps; i++) if (!safe(from.clone().lerp(to, i / steps).toArray())) throw new Error('The interpolated path crosses collision geometry.');
    }
    previous = frame;
  }
}

export class PathRecorder {
  manifest: SceneManifest;
  private camera: PerspectiveCamera;
  private safe: (point: Position) => boolean;
  private context: Context | null = null;
  private frames: Keyframe[] = [];
  private time = 0;
  recording = false;
  playing = false;
  path: CameraPath | null = null;
  message = '';
  private replayTime = 0;

  constructor(camera: PerspectiveCamera, manifest: SceneManifest, safe: (point: Position) => boolean) {
    this.camera = camera; this.manifest = manifest; this.safe = safe;
  }
  start(context: Context) {
    if (!this.safe(this.camera.position.toArray())) throw new Error('Choose a safe walking position first.');
    this.context = structuredClone(context);
    this.manifest.revision = context.revision;
    this.manifest.spawn = this.camera.position.toArray();
    this.frames = []; this.time = 0; this.path = null; this.playing = false; this.recording = true; this.message = '';
    this.capture(0);
  }
  private capture(t: number) {
    this.frames.push({ t, position: this.camera.position.toArray(), quaternion: this.camera.quaternion.clone().normalize().toArray(), fov: this.camera.fov });
  }
  update(delta: number) {
    if (!this.recording) return;
    this.time += delta;
    if (this.time - this.frames[this.frames.length - 1].t >= 0.05 - 1e-6) this.capture(this.time);
    if (this.time >= 60) this.stop();
  }
  stop() {
    if (!this.recording) return;
    this.recording = false;
    try {
      const path: CameraPath = { id: crypto.randomUUID(), sceneId: this.manifest.id, revision: this.manifest.revision,
        provenance: this.manifest.provenance, keyframes: this.frames };
      validatePath(path, this.manifest, this.safe);
      const reduced = { ...path, keyframes: simplifyPath(this.frames) };
      // Keep the measured samples if simplification would cut a corner through geometry.
      try { validatePath(reduced, this.manifest, this.safe); this.path = reduced; }
      catch { this.path = path; }
      this.message = 'Recorded virtual camera movement · ' + this.time.toFixed(1) + ' seconds';
    } catch (error) { this.path = null; this.message = (error as Error).message; }
  }
  interrupt() { this.stop(); this.playing = false; }
  replay() { if (this.path) { validatePath(this.path, this.manifest, this.safe); this.replayTime = 0; this.playing = true; } }
  advanceReplay(delta: number) {
    if (!this.playing || !this.path) return;
    this.replayTime += delta;
    const frame = samplePath(this.path.keyframes, this.replayTime);
    this.camera.position.fromArray(frame.position); this.camera.quaternion.fromArray(frame.quaternion); this.camera.fov = frame.fov;
    this.camera.updateProjectionMatrix();
    if (this.replayTime >= this.path.keyframes[this.path.keyframes.length - 1].t) this.playing = false;
  }
  export(context: Context): PathExport {
    if (!this.path || !this.context || JSON.stringify(context) !== JSON.stringify(this.context)) throw new Error('This memory or its permissions changed. Record a new path.');
    validatePath(this.path, this.manifest, this.safe);
    return structuredClone({ version: '3.1-proposal', context, sceneManifest: this.manifest, cameraPath: this.path });
  }
}
