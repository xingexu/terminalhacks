import {
  ACESFilmicToneMapping, AmbientLight, BoxGeometry, BufferGeometry, CatmullRomCurve3,
  Color, CylinderGeometry, DirectionalLight, DoubleSide, Float32BufferAttribute, Fog, Group,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Scene,
  ShaderMaterial, SphereGeometry, SRGBColorSpace, Texture, TubeGeometry, Vector3, WebGLRenderer
} from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Walker } from './walking';
import { albumEnd, nearbyPhoto, photoStops, type PhotoStop } from './album-layout';
import { sourceURL, type Source } from './model';
import { loadEnvironment } from './gameplay/environment';
import { PathRecorder } from './gameplay/path';
import { FrameMetrics } from './gameplay/performance';
import { safeCameraPosition } from './collision';
import type { RuntimeControls } from './gameplay/tools';

export type AlbumFrame = { x: number; y: number; z: number; yaw: number; nearby?: string; environment?: boolean };
export type AlbumControls = {
  keys: Set<string>;
  pause: (value: boolean) => void;
  visit: (index: number, position?: [number, number, number]) => void;
  reset: () => void;
  dispose: () => void;
  runtime: RuntimeControls;
};

export function createAlbumScene(host: HTMLElement, project: string, photos: Source[], onFrame: (frame: AlbumFrame) => void, onError: () => void): AlbumControls {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);
  const scene = new Scene();
  scene.background = new Color('#ca8a9b');
  scene.fog = new Fog('#cf94a2', 45, 180);
  const camera = new PerspectiveCamera(65, 1, 0.1, 500);
  camera.rotation.order = 'YXZ';
  const stops = photoStops(photos);
  const end = albumEnd(photos.length);
  const length = 18 - end;
  let yaw = 0;
  let pitch = -0.02;
  let paused = false;
  let active = true;
  let previous = 0;
  let lastReport = 0;
  let dragging: { id: number; x: number; y: number } | null = null;
  const keys = new Set<string>();
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<MeshStandardMaterial | MeshBasicMaterial | ShaderMaterial>();
  const downloads = new Map<string, AbortController>();
  const loaded = new Map<string, { texture: Texture; mesh: Mesh; bitmap: ImageBitmap }>();
  const failures = new Set<string>();
  const frames = new Map<string, Mesh>();
  const solids: Mesh[] = [];
  let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let manuallyPaused = false;
  const metrics = new FrameMetrics();

  function material(color: string, emissive = false) {
    const result = new MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.12,
      ...(emissive ? { emissive: color, emissiveIntensity: 2 } : {}) });
    materials.add(result);
    return result;
  }
  function mesh(geometry: BufferGeometry, surface: MeshStandardMaterial | MeshBasicMaterial | ShaderMaterial, x: number, y: number, z: number, parent: Scene | Group = scene) {
    geometries.add(geometry);
    materials.add(surface);
    const item = new Mesh(geometry, surface);
    item.castShadow = surface instanceof MeshStandardMaterial;
    item.receiveShadow = surface instanceof MeshStandardMaterial;
    item.position.set(x, y, z);
    parent.add(item);
    return item;
  }
  function box(width: number, height: number, depth: number, surface: MeshStandardMaterial, x: number, y: number, z: number, parent: Scene | Group = scene) {
    const item = mesh(new BoxGeometry(width, height, depth), surface, x, y, z, parent);
    solids.push(item);
    return item;
  }

  scene.add(new AmbientLight('#c6bbef', 1.9));
  const sunLight = new DirectionalLight('#ffd2a4', 3.5);
  sunLight.position.set(-40, 25, -60);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.left = -25;
  sunLight.shadow.camera.right = 25;
  sunLight.shadow.camera.top = 30;
  sunLight.shadow.camera.bottom = -30;
  sunLight.shadow.camera.far = 150;
  sunLight.shadow.normalBias = 0.04;
  scene.add(sunLight);
  const rim = new DirectionalLight('#79d4dc', 1.6);
  rim.position.set(30, 8, 20);
  scene.add(rim);

  const skyMaterial = new ShaderMaterial({
    side: DoubleSide,
    depthWrite: false,
    uniforms: { top: { value: new Color('#3f4c83') }, middle: { value: new Color('#d18ba8') }, bottom: { value: new Color('#ffc9a0') } },
    vertexShader: 'varying vec3 vPosition; void main(){ vPosition=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 middle; uniform vec3 bottom; varying vec3 vPosition;
      void main(){ float h=normalize(vPosition).y; vec3 color=mix(bottom,middle,smoothstep(-0.05,0.2,h)); color=mix(color,top,smoothstep(0.18,0.8,h)); gl_FragColor=vec4(color,1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`
  });
  const sky = mesh(new SphereGeometry(230, 32, 20), skyMaterial, 0, 0, 0);
  const sun = mesh(new SphereGeometry(9, 32, 24), new MeshBasicMaterial({ color: '#ffe3b0', fog: false }), -90, 18, -170);

  const waterMaterial = new ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: 'varying vec3 p; void main(){ p=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `uniform float time; varying vec3 p;
      void main(){
        float wave=sin(p.x*1.6+sin(p.y*0.2)+time*0.6)*sin(p.y*2.3-time*0.4);
        float ripple=pow(max(0.0,wave),8.0);
        float glow=exp(-pow((p.x+42.0+p.y*0.18)/18.0,2.0));
        vec3 sea=mix(vec3(0.08,0.28,0.33),vec3(0.58,0.48,0.57),smoothstep(-140.0,140.0,p.y));
        sea+=vec3(0.44,0.23,0.12)*glow*(0.25+ripple);
        sea+=vec3(0.12,0.22,0.22)*ripple;
        gl_FragColor=vec4(sea,1.0);
      }`
  });
  const water = mesh(new PlaneGeometry(600, 600), waterMaterial, 0, -0.45, -50);
  water.rotation.x = -Math.PI / 2;

  const stone = material('#d8b5a6');
  const dark = material('#253b42');
  const concrete = material('#ebd6c2');
  let environmentReady = false;
  const disposeEnvironment = loadEnvironment(scene, concrete, [3.85, length / 2], ready => { environmentReady = ready; });
  const brass = material('#917a62');
  const pink = material('#ee91b5', true);
  const teal = material('#7ce4d4', true);
  box(15, 0.5, length, stone, 0, -0.28, (end + 12) / 2);
  box(7.7, 0.03, length, concrete, 0, -0.01, (end + 12) / 2);
  // Thin inlaid strips establish scale and make translation legible.
  for (let z = 10; z > end; z -= 2) {
    box(14.5, 0.012, 0.025, brass, 0, 0.015, z);
  }
  for (const x of [-7.15, 7.15]) {
    box(0.09, 0.09, length, dark, x, 0.95, (end + 12) / 2);
    box(0.05, 0.04, length, brass, x, 0.48, (end + 12) / 2);
    for (let z = 10; z > end; z -= 3) box(0.075, 1, 0.075, dark, x, 0.48, z);
    box(0.06, 0.025, length, x < 0 ? pink : teal, x / 2, 0.025, (end + 12) / 2);
  }
  for (const z of [end + 0.5, 11.5]) {
    box(14.5, 1.1, 0.18, stone, 0, 0.55, z);
    box(14.5, 0.05, 0.22, brass, 0, 1.12, z);
  }
  // Palm fronds are curved strips with tapered leaflets, all real scene geometry.
  const bark = material('#77604e');
  const leaf = material('#244f42');
  leaf.side = DoubleSide;
  function palm(x: number, z: number, turn: number) {
    const group = new Group();
    group.position.set(x, 0, z);
    group.rotation.y = turn;
    scene.add(group);
    const curve = new CatmullRomCurve3([new Vector3(0, 0, 0), new Vector3(0.15, 2, 0), new Vector3(0.6, 4, 0), new Vector3(0.9, 6, 0)]);
    solids.push(mesh(new TubeGeometry(curve, 16, 0.14, 7, false), bark, 0, 0, 0, group));
    for (let index = 0; index < 9; index++) {
      const angle = index / 9 * Math.PI * 2;
      const vertices: number[] = [];
      for (let section = 0; section < 13; section++) {
        const t = section / 13;
        const next = (section + 1) / 13;
        const point = (part: number, side: number) => {
          const radius = part * 3.2;
          const width = Math.sin(part * Math.PI) * 0.43 * side;
          return [0.9 + Math.cos(angle) * radius + Math.sin(angle) * width,
            6 + Math.sin(part * Math.PI) * 0.8 - part * part * 1.1,
            Math.sin(angle) * radius - Math.cos(angle) * width];
        };
        vertices.push(...point(t, 0), ...point(t + 0.025, 1), ...point(next - 0.005, 1));
        vertices.push(...point(t, 0), ...point(next - 0.005, 1), ...point(next, 0));
        vertices.push(...point(t, 0), ...point(next - 0.005, -1), ...point(t + 0.025, -1));
        vertices.push(...point(t, 0), ...point(next, 0), ...point(next - 0.005, -1));
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
      geometry.computeVertexNormals();
      mesh(geometry, leaf, 0, 0, 0, group);
    }
    mesh(new CylinderGeometry(0.7, 0.55, 0.55, 20), concrete, 0, 0.27, 0, group);
  }
  for (let z = 6; z > Math.max(end, -120); z -= 12) {
    palm(-6.2, z, 0.6);
    palm(6.2, z - 4, 2.1);
  }

  // The distant waterfront supplies a coastal skyline without source imagery.
  const buildingColors = ['#b68b9b', '#799ba3', '#b6afa9', '#c69ea0'];
  for (let i = 0; i < 22; i++) {
    const height = 7 + ((i * 13) % 23);
    const x = 48 + (i % 7) * 7;
    const z = -125 + Math.floor(i / 7) * 18;
    const building = material(buildingColors[i % buildingColors.length]);
    box(5, height, 7, building, x, height / 2 - 0.5, z);
    for (let y = 3; y < height; y += 3) box(5.05, 0.45, 7.05, brass, x, y, z);
    if (i % 3 === 0) box(5.1, 0.15, 7.1, pink, x, height, z);
  }

  const placeholder = new MeshBasicMaterial({ color: '#30444b' });
  for (const stop of stops) {
    const group = new Group();
    group.position.set(stop.x, 0, stop.z);
    group.rotation.y = stop.yaw;
    scene.add(group);
    box(4.7, 3.9, 0.28, dark, 0, 2, 0, group);
    box(4.5, 0.035, 0.08, stop.x < 0 ? pink : teal, 0, 3.92, 0.18, group);
    box(4.9, 0.15, 0.8, stone, 0, 0.06, 0, group);
    const surface = mesh(new PlaneGeometry(4.3, 2.9), placeholder, 0, 2.15, 0.151, group);
    frames.set(stop.sourceId, surface);
  }

  scene.updateMatrixWorld(true);
  const collisionGeometry = new Group();
  solids.forEach(solid => {
    const collider = new Mesh(solid.geometry);
    collider.matrix.copy(solid.matrixWorld);
    collider.matrixAutoUpdate = false;
    collisionGeometry.add(collider);
  });
  const collisionWorld = new Octree().fromGraphNode(collisionGeometry);
  const walker = new Walker(collisionWorld, new Vector3(0, 0.05, 6));

  async function loadPhoto(stop: PhotoStop) {
    const abort = new AbortController();
    downloads.set(stop.sourceId, abort);
    try {
      const response = await fetch(sourceURL(project, stop.sourceId, '?variant=thumb'), { signal: abort.signal });
      if (!response.ok) throw new Error('Photo unavailable');
      const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'flipY' });
      if (!active || abort.signal.aborted) { bitmap.close(); return; }
      const texture = new Texture(bitmap);
      texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      const surface = frames.get(stop.sourceId)!;
      const surfaceMaterial = new MeshBasicMaterial({ map: texture });
      materials.add(surfaceMaterial);
      surface.material = surfaceMaterial;
      // Fit the whole image inside its frame, preserving portrait and landscape ratios.
      const aspect = bitmap.width / bitmap.height;
      surface.scale.set(Math.min(1, aspect * 2.9 / 4.3), Math.min(1, 4.3 / aspect / 2.9), 1);
      loaded.set(stop.sourceId, { texture, mesh: surface, bitmap });
    } catch {
      if (active && !abort.signal.aborted) failures.add(stop.sourceId);
    } finally { downloads.delete(stop.sourceId); }
  }
  function updatePhotos() {
    for (const [id, item] of loaded) {
      const stop = stops.find(value => value.sourceId === id)!;
      if (Math.abs(stop.z - camera.position.z) <= 45) continue;
      item.texture.dispose();
      item.bitmap.close();
      const surface = item.mesh.material as MeshBasicMaterial;
      surface.dispose();
      materials.delete(surface);
      item.mesh.material = placeholder;
      loaded.delete(id);
    }
    for (const stop of stops) {
      if (downloads.size >= 3) break;
      if (Math.abs(stop.z - camera.position.z) < 32 && !loaded.has(stop.sourceId) && !downloads.has(stop.sourceId) && !failures.has(stop.sourceId)) void loadPhoto(stop);
    }
  }

  const recorder = new PathRecorder(camera, {
    id: 'album-' + photos.map(photo => photo.id).join('-'), planId: 'designed-coastal-album-v1', revision: 0,
    format: 'original_trail', assetId: 'coastal-album-v1', collisionAssetId: 'coastal-album-collision-v1',
    units: 'm', coordinateSystem: 'right-handed-y-up', scaleConfidence: 1,
    boundsMin: [-7, 0, end + 0.8], boundsMax: [7, 8, 11.1], spawn: [0, 1.65, 6],
    anchors: stops.map(stop => ({ id: stop.sourceId, position: [stop.x < 0 ? -1.5 : 1.5, 1.6, stop.z], sourceIds: [stop.sourceId] })),
    capability: 'free_roam', provenance: 'imagined'
  }, point => safeCameraPosition(collisionWorld, point));
  function reset() { recorder.interrupt(); walker.place(new Vector3(0, 0.05, 6)); camera.position.copy(walker.eye); yaw = 0; pitch = -0.02; keys.clear(); }
  function visit(index: number, position?: [number, number, number]) {
    recorder.interrupt();
    const stop = stops[index];
    if (!stop) return;
    const saved = position && position.every(Number.isFinite) && position[0] >= -6.7 && position[0] <= 6.7 &&
      position[1] >= 1.55 && position[1] <= 7 && position[2] >= end + 0.8 && position[2] <= 11.1 &&
      safeCameraPosition(collisionWorld, position);
    walker.place(saved ? new Vector3().fromArray(position).add(new Vector3(0, -1.6, 0)) :
      new Vector3(stop.x < 0 ? -1.8 : 1.8, 0.05, stop.z + 0.1));
    camera.position.copy(walker.eye);
    yaw = stop.x < 0 ? Math.PI / 2 : -Math.PI / 2;
    pitch = 0.06;
    keys.clear();
  }
  reset();
  const resize = new ResizeObserver(() => {
    if (!host.clientWidth || !host.clientHeight) return;
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
  });
  resize.observe(host);
  const pointerDown = (event: PointerEvent) => {
    if (paused || manuallyPaused || recorder.playing || event.button !== 0) return;
    dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    host.focus();
  };
  const pointerMove = (event: PointerEvent) => {
    if (!dragging || paused || manuallyPaused || recorder.playing) return;
    yaw -= (event.clientX - dragging.x) * 0.003;
    pitch = Math.max(-0.9, Math.min(0.9, pitch - (event.clientY - dragging.y) * 0.003));
    dragging.x = event.clientX;
    dragging.y = event.clientY;
  };
  const pointerUp = () => { dragging = null; };
  const clear = () => { keys.clear(); dragging = null; };
  const contextLost = (event: Event) => { event.preventDefault(); renderer.setAnimationLoop(null); onError(); };
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  canvas.addEventListener('webglcontextlost', contextLost);
  window.addEventListener('blur', clear);
  document.addEventListener('visibilitychange', clear);

  renderer.setAnimationLoop(time => {
    const elapsed = previous ? time - previous : 0;
    const delta = Math.min(elapsed / 1000, 0.15);
    previous = time;
    if (document.hidden) { recorder.interrupt(); return; }
    if (!paused && !manuallyPaused) metrics.record(elapsed);
    const replaying = recorder.playing;
    if (replaying && !paused && !manuallyPaused) {
      recorder.advanceReplay(delta);
      if (!recorder.playing) {
        walker.place(camera.position.clone().add(new Vector3(0, -1.6, 0)));
        yaw = camera.rotation.y; pitch = camera.rotation.x;
      }
    }
    else if (!paused && !manuallyPaused) {
      yaw += (Number(keys.has('arrowleft')) - Number(keys.has('arrowright'))) * delta * 1.5;
      camera.position.copy(walker.update(delta, yaw, keys));
    }
    if (!replaying) camera.rotation.set(pitch, yaw, 0, 'YXZ');
    if (!paused && !manuallyPaused) recorder.update(delta);
    sky.position.copy(camera.position);
    sun.position.set(camera.position.x - 90, 18, camera.position.z - 170);
    water.position.z = camera.position.z - 50;
    if (!reducedMotion && !paused && !manuallyPaused) waterMaterial.uniforms.time.value = time / 1000;
    if (time - lastReport > 120) {
      lastReport = time;
      const nearby = nearbyPhoto(camera.position, stops);
      onFrame({ x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw, nearby: nearby?.sourceId, environment: environmentReady });
      updatePhotos();
    }
    renderer.render(scene, camera);
  });
  return {
    runtime: {
      recorder, metrics,
      canRecord: () => active && !paused && !manuallyPaused && !recorder.playing,
      replay: () => { clear(); recorder.replay(); },
      stopReplay: () => { recorder.playing = false; reset(); },
      setPaused: value => { manuallyPaused = value; recorder.interrupt(); clear(); },
      setReducedMotion: value => { reducedMotion = value; },
      setCreativeLighting: value => {
        sunLight.color.set(value === 'daylight' ? '#fff5df' : '#ffd2a4');
        sunLight.intensity = value === 'daylight' ? 4.5 : 3.5;
        scene.environmentIntensity = value === 'daylight' ? 1 : 0.5;
      },
      setQuality: value => { renderer.setPixelRatio(value === 'low' ? 0.5 : Math.min(devicePixelRatio, 1)); metrics.reset(); },
      details: () => ({ renderer: renderer.getContext().getParameter(renderer.getContext().RENDERER), width: canvas.width, height: canvas.height,
        geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures })
    },
    keys,
    reset,
    visit,
    pause(value) { paused = value; if (value) recorder.interrupt(); clear(); },
    dispose() {
      active = false;
      renderer.setAnimationLoop(null);
      resize.disconnect();
      downloads.forEach(abort => abort.abort());
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerUp);
      canvas.removeEventListener('webglcontextlost', contextLost);
      loaded.forEach(item => { item.texture.dispose(); item.bitmap.close(); });
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(surface => surface.dispose());
      disposeEnvironment();
      collisionWorld.clear();
      sunLight.shadow.map?.dispose();
      renderer.dispose();
      canvas.remove();
    }
  };
}
