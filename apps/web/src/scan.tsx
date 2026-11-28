import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Footprints, MapPin, MoveUpRight, X } from 'lucide-react';
import {
  ACESFilmicToneMapping, AnimationMixer, Box3, Color, DirectionalLight, HemisphereLight, LoadingManager,
  Material, Mesh, PerspectiveCamera, Ray, Raycaster, Scene, SRGBColorSpace, Texture, Vector2, Vector3, WebGLRenderer
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Octree } from 'three/addons/math/Octree.js';
import { collisionFromObject, safeCameraPosition, validatedSceneSpawn, worldSurfaceNormal } from './collision';
import { PathRecorder } from './gameplay/path';
import { FrameMetrics } from './gameplay/performance';
import { RuntimeTools, type RuntimeControls } from './gameplay/tools';
import { Walker } from './walking';
import { api, type Anchor, type Recollection, type Movement } from './model';
import './album.css';

type Position = [number, number, number];
export default function Scan({ url, projectId, eventId, worldId, revision, provenance = 'reconstructed', planId, position, onClose, onWaypoint, anchors, selectedAnchor, recollections, onSelectAnchor, onRecollect, movement }: {
  projectId: string; eventId: string; worldId: string; revision: number;
  provenance?: 'imagined' | 'reconstructed'; planId?: string;
  url: string; position?: Position; onClose: () => void; onWaypoint: (position: Position) => void;
  anchors: Anchor[]; selectedAnchor?: Anchor; recollections: Recollection[];
  onSelectAnchor: (id: string) => void; onRecollect: () => void;
  movement?: Movement;
}) {
  const host = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<string>());
  const appliedPosition = useRef('');
  const actions = useRef<{ choose: () => void; selectFloor: () => void; overview: () => void; read: () => Position; move: (point: Position) => void; voice: (command: Movement) => void; stopVoice: () => void } | null>(null);
  const [phase, setPhase] = useState<'loading' | 'overview' | 'choose' | 'walk' | 'error'>('loading');
  const [notice, setNotice] = useState('');
  const [runtime, setRuntime] = useState<RuntimeControls | null>(null);
  const [filmBusy, setFilmBusy] = useState(false);
  useEffect(() => {
    if (!runtime) return;
    const recorder = runtime.recorder;
    recorder.manifest.anchors = anchors.map(anchor => ({ id: anchor.id, position: anchor.position, sourceIds: anchor.sourceIds }));
    if (recorder.manifest.revision !== revision) {
      runtime.cancelFilm?.('The memory changed. Record and review a new path.');
      recorder.interrupt();
      recorder.path = null;
      recorder.manifest.revision = revision;
      recorder.message = 'Memory updated. Record a new path for this revision.';
    }
  }, [runtime, revision, anchors]);
  useEffect(() => {
    appliedPosition.current = '';
    const element = host.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.focus();
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: true }); }
    catch { setPhase('error'); return () => { document.body.style.overflow = overflow; previousFocus?.focus(); }; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    element.appendChild(renderer.domElement);
    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    const scene = new Scene();
    scene.background = new Color('#15242c');
    scene.add(new HemisphereLight('#fff7e5', '#7b828b', 2));
    const sun = new DirectionalLight('#ffe7c6', 2);
    sun.position.set(-6, 15, 8);
    scene.add(sun);
    const camera = new PerspectiveCamera(65, 1, 0.05, 1000);
    camera.rotation.order = 'YXZ';
    const orbit = new OrbitControls(camera, canvas);
    orbit.enableDamping = false;
    let collision = new Octree();
    let walker: Walker | null = null;
    let walkSpeed = 2.8;
    let mode: 'overview' | 'choose' | 'walk' = 'overview';
    let active = true;
    let yaw = 0;
    let pitch = 0;
    let last = 0;
    let paused = false;
    let animation: AnimationMixer | null = null;
    const mountedAt = Date.now();
    const consumed = new Set<string>();
    let voice: { command: Movement; remaining: number; start: Vector3 } | null = null;
    const receipt = (command: Movement, status: string, reason?: string) => {
      void api('/projects/' + projectId + '/worlds/' + worldId + '/movement-ack',
        { commandId: command.id, status, position: camera.position.toArray(), ...(reason && { reason }) }).catch(() => {});
    };
    const stopVoice = (reason = 'Manual control took over.') => {
      if (voice) receipt(voice.command, 'stopped', reason);
      voice = null;
    };
    let reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const metrics = new FrameMetrics();
    let recorder: PathRecorder | null = null;
    let capture: { started: number; elapsed: number; duration: number; media: MediaRecorder; progress: (seconds: number) => void; cancel: (message: string) => void } | null = null;
    const sceneBounds = new Box3();
    let drag: { id: number; x: number; y: number } | null = null;
    const download = new AbortController();
    const pick = new Raycaster();
    const pointer = new Vector2();
    const normal = new Vector3();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    const disposeModel = (model: Scene | import('three').Group) => model.traverse(object => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      const surfaces = Array.isArray(object.material) ? object.material : [object.material];
      surfaces.forEach(surface => {
        materials.add(surface);
        Object.values(surface).forEach(value => { if (value instanceof Texture) textures.add(value); });
      });
    });
    const setMode = (value: typeof mode) => {
      if (capture) return;
      stopVoice('Walking mode changed.');
      recorder?.interrupt();
      mode = value;
      orbit.enabled = value === 'overview';
      keys.current.clear();
      drag = null;
      if (value === 'choose') { yaw = camera.rotation.y; pitch = camera.rotation.x; }
      setPhase(value);
    };
    const overview = () => {
      setMode('overview');
      setNotice('Drag to inspect the world, then choose a clear floor to begin walking.');
      orbit.target.copy(camera.position).add(new Vector3(0, 0, -3).applyQuaternion(camera.quaternion));
      orbit.update();
    };
    function place(point: Vector3) {
      if (capture) return;
      recorder?.interrupt();
      const floor = collision.rayIntersect(new Ray(point.clone().add(new Vector3(0, 0.3, 0)), new Vector3(0, -1, 0)));
      if (!floor || floor.distance > 0.5 || floor.triangle.getNormal(normal).y < 0.55) {
        setNotice('This saved position has no safe floor. Choose a clear floor surface.'); return;
      }
      const candidate = new Walker(collision, point.clone().add(new Vector3(0, 0.03, 0)), walkSpeed);
      const overlap = collision.capsuleIntersect(candidate.capsule);
      if (overlap && overlap.depth > 0.05) {
        setNotice('There is not enough standing room here. Choose an open floor area.');
        return;
      }
      walker = candidate;
      yaw = camera.rotation.y;
      pitch = 0;
      camera.position.copy(walker.eye);
      setMode('walk');
      setNotice('WASD to walk · Drag to look · Shift to sprint · Space to jump');
      element.focus();
    }
    function selectFloor(point: Vector2) {
      pick.setFromCamera(point, camera);
      const hit = pick.intersectObjects(scene.children, true)[0];
      if (!hit?.face) { setNotice('Choose a visible floor surface in the world.'); return; }
      normal.copy(worldSurfaceNormal(hit.object, hit.face.normal, hit.instanceId));
      if (normal.y < 0.55) { setNotice('Choose a level floor. This surface is too steep to stand on.'); return; }
      place(hit.point);
    }
    void (async () => {
      try {
        const response = await fetch(url, { signal: download.signal });
        if (!response.ok) throw new Error('This world is unavailable. Return to the memory to check its approval and evidence.');
        const bytes = await response.arrayBuffer();
        const manager = new LoadingManager();
        manager.setURLModifier(resource => {
          if (!resource.startsWith('blob:') && !resource.startsWith('data:')) throw new Error('The scene must embed its textures.');
          return resource;
        });
        const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
        if (!active) { disposeModel(gltf.scene); materials.forEach(item => item.dispose()); textures.forEach(item => item.dispose()); return; }
        scene.add(gltf.scene);
        const bounds = new Box3().setFromObject(gltf.scene);
        sceneBounds.copy(bounds); sceneBounds.max.y += 3;
        const center = bounds.getCenter(new Vector3());
        const size = bounds.getSize(new Vector3());
        if (!Number.isFinite(size.length()) || size.length() <= 0) throw new Error('This scene has no usable geometry.');
        const radius = size.length() / 2;
        camera.far = Math.max(100, radius * 10);
        camera.updateProjectionMatrix();
        camera.position.copy(center).add(new Vector3(radius, radius * 0.75, radius));
        orbit.target.copy(center);
        orbit.update();
        collision = collisionFromObject(gltf.scene);
        // shortcut: collision is static; animated content must stay outside the walking area until dynamic collision is added.
        if (gltf.animations.length) {
          animation = new AnimationMixer(gltf.scene);
          gltf.animations.forEach(clip => animation!.clipAction(clip).play());
        }
        const metadata = gltf.parser.json.asset?.extras;
        const photoSet = provenance === 'imagined' && metadata?.provider === 'photo-set-v1';
        if (photoSet) walkSpeed = 1.2;
        const spawn = ((planId && metadata?.planId === planId) || photoSet) && metadata.method === 'procedural' &&
          metadata.units === 'm' && metadata.coordinateSystem === 'right-handed-y-up'
          ? validatedSceneSpawn(collision, sceneBounds, metadata.spawn) : null;
        recorder = new PathRecorder(camera, {
          id: worldId, planId: planId ?? 'import-' + worldId, revision, format: 'glb', assetId: worldId, collisionAssetId: worldId,
          units: 'm', coordinateSystem: 'right-handed-y-up', scaleConfidence: null,
          boundsMin: sceneBounds.min.toArray(), boundsMax: sceneBounds.max.toArray(), spawn: spawn ?? center.toArray(),
          anchors: anchors.map(anchor => ({ id: anchor.id, position: anchor.position, sourceIds: anchor.sourceIds })),
          capability: 'free_roam', provenance
        }, point => safeCameraPosition(collision, point));
        const pathRecorder = recorder;
        setRuntime({
          recorder: pathRecorder, metrics,
          canRecord: () => active && mode === 'walk' && !paused && !capture && !pathRecorder.playing,
          captureFilm: async (signal, progress) => {
            const duration = pathRecorder.path?.keyframes.at(-1)?.t ?? 0;
            if (!active || document.hidden || capture || paused || mode !== 'walk' || duration < 30 || duration > 60 || signal.aborted) throw new Error('Return to a visible, unpaused scene with a reviewed 30–60 second path.');
            if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error('This browser cannot record the scene. Use a current desktop Chrome browser.');
            const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
            if (!mimeType) throw new Error('This browser cannot encode a WebM scene recording. Use desktop Chrome.');
            const pixelRatio = renderer.getPixelRatio();
            const originalAspect = camera.aspect;
            const originalPosition = camera.position.clone();
            const originalQuaternion = camera.quaternion.clone();
            const originalFov = camera.fov;
            const fit = canvas.style.objectFit;
            let stream: MediaStream | undefined;
            let media: MediaRecorder | undefined;
            let abort = () => {};
            let timer = 0;
            keys.current.clear(); drag = null; orbit.enabled = false;
            try {
              renderer.setPixelRatio(1); renderer.setSize(1920, 1080, false);
              camera.aspect = 1920 / 1080; camera.updateProjectionMatrix();
              canvas.style.objectFit = 'contain';
              pathRecorder.replay(); pathRecorder.advanceReplay(0);
              renderer.render(scene, camera);
              stream = canvas.captureStream(24);
              const recording = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
              media = recording;
              return await new Promise<Blob>((resolve, reject) => {
                const chunks: Blob[] = [];
                let bytes = 0;
                let failure = '';
                const cancel = (message: string) => {
                  if (failure) return;
                  failure = message;
                  reject(new Error(message));
                  if (recording.state !== 'inactive') recording.stop();
                };
                capture = { started: Infinity, elapsed: 0, duration, media: recording, progress, cancel };
                abort = () => cancel('Scene recording cancelled. Review and try again.');
                signal.addEventListener('abort', abort, { once: true });
                recording.onstart = () => { if (capture) capture.started = performance.now(); };
                recording.ondataavailable = event => {
                  if (!event.data.size) return;
                  chunks.push(event.data); bytes += event.data.size;
                  if (bytes > 47 * 1024 ** 2 && recording.state !== 'inactive') cancel('This recording exceeded the upload limit. Record a shorter path and try again.');
                };
                recording.onerror = () => cancel('The browser could not record the scene. Review and try again.');
                recording.onstop = () => failure ? reject(new Error(failure)) : bytes ? resolve(new Blob(chunks, { type: mimeType })) : reject(new Error('The scene recording was empty. Try again.'));
                timer = window.setTimeout(() => cancel('Scene recording stalled. Keep this page visible and try again.'), (duration + 8) * 1000);
                recording.start(500);
              });
            } finally {
              signal.removeEventListener('abort', abort); window.clearTimeout(timer);
              if (media && media.state !== 'inactive') media.stop();
              capture = null;
              stream?.getTracks().forEach(track => track.stop());
              pathRecorder.playing = false;
              camera.position.copy(originalPosition); camera.quaternion.copy(originalQuaternion); camera.fov = originalFov;
              camera.aspect = originalAspect; camera.updateProjectionMatrix();
              canvas.style.objectFit = fit;
              if (active) {
                renderer.setPixelRatio(pixelRatio); renderer.setSize(element.clientWidth || 1, element.clientHeight || 1);
                camera.aspect = (element.clientWidth || 1) / (element.clientHeight || 1); camera.updateProjectionMatrix();
                walker?.place(camera.position.clone().add(new Vector3(0, -1.6, 0)));
                yaw = camera.rotation.y; pitch = camera.rotation.x;
                orbit.enabled = false;
                renderer.render(scene, camera);
              }
            }
          },
          cancelFilm: message => capture?.cancel(message),
          replay: () => { keys.current.clear(); pathRecorder.replay(); },
          stopReplay: () => {
            pathRecorder.playing = false;
            walker?.place(camera.position.clone().add(new Vector3(0, -1.6, 0)));
            yaw = camera.rotation.y; pitch = camera.rotation.x;
          },
          setPaused: value => { if (capture) return; paused = value; keys.current.clear(); pathRecorder.interrupt(); orbit.enabled = !value && mode === 'overview'; },
          setReducedMotion: value => { if (!capture) reducedMotion = value; },
          setCreativeLighting: value => { if (capture) return; sun.color.set(value === 'daylight' ? '#ffffff' : '#ffe7c6'); sun.intensity = value === 'daylight' ? 3 : 2; },
          setQuality: value => { if (capture) return; renderer.setPixelRatio(value === 'low' ? 0.5 : Math.min(devicePixelRatio, 1)); metrics.reset(); },
          details: () => ({ renderer: renderer.getContext().getParameter(renderer.getContext().RENDERER), width: canvas.width, height: canvas.height,
            geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures })
        });
        actions.current = {
          choose: () => { setMode('choose'); setNotice('Click a clear floor, or aim with arrow keys and press Enter.'); element.focus(); },
          selectFloor: () => selectFloor(new Vector2()),
          overview,
          read: () => camera.position.toArray(),
          move: point => {
            stopVoice();
            const feet = new Vector3().fromArray(point).add(new Vector3(0, -1.6, 0));
            place(feet);
          },
          stopVoice,
          voice: command => {
            if (consumed.has(command.id) || command.worldId !== worldId) return;
            consumed.add(command.id);
            // An inactive viewer must not claim another tab's movement receipt.
            if (Date.parse(command.issuedAt) < mountedAt || Date.parse(command.expiresAt) <= Date.now() ||
              mode !== 'walk' || paused || capture || recorder?.playing || document.hidden) return;
            if (!Number.isFinite(command.durationSeconds) || command.durationSeconds < 0.1 || command.durationSeconds > 5 ||
              !Number.isFinite(command.degrees) || command.degrees < 1 || command.degrees > 90) {
              receipt(command, 'ignored', 'Invalid movement command.'); return;
            }
            stopVoice('Replaced by a new voice command.');
            keys.current.clear();
            if (command.direction === 'stop') { receipt(command, 'stopped'); setNotice('Stopped.'); return; }
            voice = { command, remaining: command.durationSeconds, start: camera.position.clone() };
            setNotice(command.direction.startsWith('turn_') ? 'Turning…' : 'Walking…');
          }
        };
        setPhase('overview');
        setNotice('Scale is unverified. Inspect the world, then choose a clear floor to begin walking.');
        if (spawn && !position) {
          camera.rotation.set(0, Number.isFinite(metadata.spawnYaw) ? metadata.spawnYaw : 0, 0);
          place(new Vector3(...spawn).add(new Vector3(0, -1.6, 0)));
          if (photoSet && walker) setNotice('WASD to walk · drag to look · VoiceOS can walk, turn and stop.');
        }
      } catch (error) {
        if (active) { setNotice((error as Error).message); setPhase('error'); }
      }
    })();
    const resize = new ResizeObserver(() => {
      if (capture || !element.clientWidth || !element.clientHeight) return;
      renderer.setSize(element.clientWidth, element.clientHeight);
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
    });
    resize.observe(element);
    const pointerDown = (event: PointerEvent) => {
      stopVoice();
      if (capture || paused || recorder?.playing) return;
      element.focus();
      if (mode === 'choose') {
        const rect = canvas.getBoundingClientRect();
        pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
        selectFloor(pointer);
      } else if (mode === 'walk') {
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (capture || !drag || mode !== 'walk') return;
      yaw -= (event.clientX - drag.x) * 0.003;
      pitch = Math.max(-1.2, Math.min(1.2, pitch - (event.clientY - drag.y) * 0.003));
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const pointerUp = () => { drag = null; };
    const clear = () => { keys.current.clear(); drag = null; if (document.hidden) { stopVoice('Movement stopped when the page was hidden.'); capture?.cancel('Recording stopped because the page was hidden. Keep this page visible and try again.'); } };
    const lost = (event: Event) => { event.preventDefault(); capture?.cancel('The graphics context was lost. Reopen the scene and try again.'); recorder?.interrupt(); setRuntime(null); renderer.setAnimationLoop(null); setPhase('error'); setNotice('The graphics context was lost. Reopen the scene to try again.'); };
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    canvas.addEventListener('webglcontextlost', lost);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    renderer.setAnimationLoop(time => {
      const elapsed = last ? time - last : 0;
      const delta = Math.min(elapsed / 1000, 0.15);
      last = time;
      if (document.hidden) { recorder?.interrupt(); return; }
      if (!paused && !reducedMotion) animation?.update(delta);
      if (capture) {
        const seconds = Math.max(0, Math.min(capture.duration, (performance.now() - capture.started) / 1000));
        recorder?.advanceReplay(Math.max(0, seconds - capture.elapsed));
        capture.elapsed = seconds;
        renderer.render(scene, camera);
        capture.progress(seconds);
        if (seconds >= capture.duration && capture.media.state === 'recording') capture.media.stop();
        return;
      }
      if (!paused) metrics.record(elapsed);
      if (voice && (paused || capture || recorder?.playing || Date.now() >= Date.parse(voice.command.expiresAt))) stopVoice('Voice movement expired or the player was paused.');
      if (recorder?.playing && !paused) {
        recorder.advanceReplay(delta);
        if (!recorder.playing) {
          walker?.place(camera.position.clone().add(new Vector3(0, -1.6, 0)));
          yaw = camera.rotation.y; pitch = camera.rotation.x;
        }
      } else if (mode === 'walk' && walker && !paused) {
        const drive = new Set(keys.current);
        if (voice) {
          const step = Math.min(delta, voice.remaining);
          const direction = voice.command.direction;
          if (direction === 'turn_left' || direction === 'turn_right') yaw += (direction === 'turn_left' ? 1 : -1) *
            (voice.command.degrees * Math.PI / 180) * step / voice.command.durationSeconds;
          else { const key = { forward: 'w', backward: 's', left: 'a', right: 'd', stop: '' }[direction]; if (key) drive.add(key); }
          voice.remaining -= step;
        }
        yaw += (Number(keys.current.has('arrowleft')) - Number(keys.current.has('arrowright'))) * delta * (reducedMotion ? 0.8 : 1.5);
        camera.position.copy(walker.update(delta, yaw, drive));
        keys.current.delete(' ');
        if (!sceneBounds.containsPoint(camera.position)) { walker.reset(); camera.position.copy(walker.eye); recorder?.interrupt(); }
        camera.rotation.set(pitch, yaw, 0, 'YXZ');
        if (voice && voice.remaining <= 0) {
          const moved = voice.command.direction.startsWith('turn_') || voice.start.distanceTo(camera.position) > 0.04;
          receipt(voice.command, moved ? 'completed' : 'blocked', moved ? undefined : 'The walking surface blocked movement.');
          setNotice(moved ? 'Ready · WASD to walk or ask VoiceOS.' : 'The path is blocked. Turn or walk another way.'); voice = null;
        }
      } else if (mode === 'choose' && !paused) {
        yaw += (Number(keys.current.has('arrowleft')) - Number(keys.current.has('arrowright'))) * delta;
        pitch = Math.max(-1.5, Math.min(1.5, pitch + (Number(keys.current.has('arrowup')) - Number(keys.current.has('arrowdown'))) * delta));
        camera.rotation.set(pitch, yaw, 0, 'YXZ');
      }
      if (!paused && mode === 'walk') recorder?.update(delta);
      renderer.render(scene, camera);
    });
    return () => {
      stopVoice('The scene was closed.');
      active = false;
      capture?.cancel('The scene was closed. The unfinished recording was discarded.');
      recorder?.interrupt();
      setRuntime(null);
      actions.current = null;
      download.abort();
      renderer.setAnimationLoop(null);
      if (animation) { animation.stopAllAction(); animation.uncacheRoot(animation.getRoot()); }
      resize.disconnect();
      orbit.dispose();
      collision.clear();
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerUp);
      canvas.removeEventListener('webglcontextlost', lost);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
      disposeModel(scene);
      materials.forEach(surface => surface.dispose());
      textures.forEach(texture => { (texture.source.data as ImageBitmap)?.close?.(); texture.dispose(); });
      renderer.dispose();
      canvas.remove();
      document.body.style.overflow = overflow;
      previousFocus?.focus();
    };
  }, [url, provenance, planId]);
  useEffect(() => {
    const key = JSON.stringify(position);
    if (position && actions.current && key !== appliedPosition.current) {
      appliedPosition.current = key;
      actions.current.move(position);
    }
  }, [position?.[0], position?.[1], position?.[2], phase]);
  useEffect(() => { if (movement && actions.current) actions.current.voice(movement); }, [movement?.id, phase]);
  return createPortal(<div className="walk-album" ref={wrapper} role="dialog" aria-modal="true" aria-label={provenance === 'imagined' ? 'Walkable imagined world' : 'Walkable reconstruction'}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
      if (event.key === 'Tab') {
        const items = [...(wrapper.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, audio[controls], [tabindex="0"]') || [])]
          .filter(item => item.getClientRects().length > 0);
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
      const key = event.key.toLowerCase();
      if (event.target === host.current) actions.current?.stopVoice();
      if (filmBusy && event.target === host.current) return;
      if (event.target === host.current && phase === 'choose' && key === 'enter') {
        event.preventDefault();
        actions.current?.selectFloor();
      }
      if (event.target === host.current && ['w', 'a', 's', 'd', 'shift', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
        if (key !== ' ' || !event.repeat) keys.current.add(key);
      }
    }} onKeyUp={event => {
      if (event.key !== ' ') keys.current.delete(event.key.toLowerCase());
    }}>
    <div className="walk-canvas" ref={host} tabIndex={0} aria-label={(provenance === 'imagined' ? 'Imagined world. ' : 'Reconstruction. ') + 'Choose a floor, then use WASD to walk and drag to look.'} onBlur={() => keys.current.clear()} />
    <header className="walk-header"><div className="walk-brand">everwhere<span>{provenance === 'imagined' ? 'Imagined · generated interpretation' : 'Reconstructed · imported mesh'}</span></div><div className="walk-header-actions"><button onClick={onClose}><X size={16} /> Exit</button></div></header>
    <RuntimeTools runtime={runtime} contextURL={'/projects/' + projectId + '/memories/' + eventId + '/scene-context?world=' + worldId}
      revision={revision} filmBase={'/projects/' + projectId} onFilmBusy={setFilmBusy} focus={() => host.current?.focus()} />
    {anchors.length > 0 && <aside className="scan-waypoints" aria-label="Saved places">
      <h2>Saved places</h2>
      {anchors.map(anchor => <button disabled={filmBusy} key={anchor.id} aria-pressed={selectedAnchor?.id === anchor.id} onClick={() => onSelectAnchor(anchor.id)}><MapPin size={14} /> {anchor.title}</button>)}
      {selectedAnchor && <><button disabled={filmBusy} onClick={onRecollect}>Add a recollection here</button>
        {recollections.filter(item => item.anchorId === selectedAnchor.id).map(item => <blockquote key={item.id}><p>{item.text}</p><cite>{item.contributor} · Recollection</cite></blockquote>)}
      </>}
    </aside>}
    <div className="scan-actions">
      {phase === 'loading' ? <p role="status">Loading the world and its walking surfaces…</p> : <p role="status">{notice}</p>}
      {phase === 'overview' && <button className="walk-primary" onClick={() => actions.current?.choose()}><Footprints size={16} /> Choose floor to walk</button>}
      {phase === 'choose' && <button onClick={() => actions.current?.overview()}>Cancel placement</button>}
      {phase === 'walk' && <><button disabled={filmBusy} onClick={() => actions.current?.overview()}><MoveUpRight size={16} /> Inspect scene</button>
        <button disabled={filmBusy} onClick={() => { const point = actions.current?.read(); if (point) onWaypoint(point); }}><MapPin size={16} /> Save waypoint</button></>}
      {phase === 'error' && <button onClick={onClose}>Return to memory</button>}
    </div>
    {(phase === 'walk' || phase === 'choose') && <div className="walk-reticle" aria-hidden="true" />}
    {phase === 'walk' && <div className="walk-movement" aria-label="Movement controls">
      {[['w', 'Walk forward', ArrowUp], ['a', 'Step left', ArrowLeft], ['s', 'Walk backward', ArrowDown], ['d', 'Step right', ArrowRight]].map(([key, name, Icon]) => {
        return <button disabled={filmBusy} key={String(key)} className={'walk-key-' + key} aria-label={String(name)}
          onPointerDown={event => { event.preventDefault(); actions.current?.stopVoice(); event.currentTarget.setPointerCapture(event.pointerId); keys.current.add(String(key)); }}
          onPointerUp={() => keys.current.delete(String(key))} onPointerCancel={() => keys.current.delete(String(key))}
          onLostPointerCapture={() => keys.current.delete(String(key))}
          onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); actions.current?.stopVoice(); keys.current.add(String(key)); } }}
          onKeyUp={() => keys.current.delete(String(key))} onBlur={() => keys.current.delete(String(key))}>{String(key).toUpperCase()}</button>;
      })}</div>}
  </div>, document.body);
}
