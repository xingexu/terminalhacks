import { useEffect, useRef, useState } from 'react';
import { Box, Plus, X } from 'lucide-react';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { Color, PerspectiveCamera, Scene, Sphere, Spherical, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

type Position = [number, number, number];

export default function Spatial({ url, provenance = 'reconstructed', position, onClose, onWaypoint }: {
  url: string; provenance?: 'imagined' | 'reconstructed'; position?: Position; onClose: () => void; onWaypoint: (position: Position) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<{ move: (position: Position) => void; read: () => Position; orbit: (key: string) => void } | null>(null);
  const [phase, setPhase] = useState<'load' | 'ready' | 'error'>('load');
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' }); }
    catch { setPhase('error'); return; }
    let active = true;
    let mesh: SplatMesh | null = null;
    const download = new AbortController();
    const scene = new Scene();
    scene.background = new Color('#111913');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.domElement.setAttribute('aria-hidden', 'true');
    element.appendChild(renderer.domElement);
    const camera = new PerspectiveCamera(56, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.enablePan = false;
    controls.maxPolarAngle = Math.PI * 0.91;
    controls.minPolarAngle = Math.PI * 0.04;
    const spark = new SparkRenderer({ renderer });
    scene.add(spark);
    const resize = new ResizeObserver(([entry]) => {
      if (!entry || !active) return;
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resize.observe(element);
    const contextLost = (event: Event) => { event.preventDefault(); renderer.setAnimationLoop(null); setPhase('error'); };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    void (async () => {
      try {
        const response = await fetch(url, { signal: download.signal });
        if (!response.ok) throw new Error('Unavailable world');
        const fileBytes = await response.arrayBuffer();
        if (!active) return;
        mesh = new SplatMesh({ fileBytes, fileName: 'scene.spz', raycastable: false });
        await mesh.initialized;
        if (!active) { mesh.dispose(); return; }
        const bounds = mesh.getBoundingBox(true).getBoundingSphere(new Sphere());
        if (!Number.isFinite(bounds.radius) || bounds.radius <= 0 || !bounds.center.toArray().every(Number.isFinite)) throw new Error('Empty world');
        const radius = bounds.radius;
        camera.near = Math.max(0.0001, radius / 50000);
        camera.far = Math.max(20, radius * 12);
        camera.updateProjectionMatrix();
        controls.target.copy(bounds.center);
        controls.minDistance = radius * 0.07;
        controls.maxDistance = radius * 3.5;
        camera.position.copy(bounds.center).add(new Vector3(0, radius * 0.25, radius * 1.25));
        controls.update();
        controlsRef.current = {
          read: () => camera.position.toArray(),
          move: point => { camera.position.fromArray(point); controls.update(); },
          orbit: key => {
            const offset = camera.position.clone().sub(controls.target);
            const view = new Spherical().setFromVector3(offset);
            if (['a', 'arrowleft'].includes(key)) view.theta -= 0.12;
            if (['d', 'arrowright'].includes(key)) view.theta += 0.12;
            if (['w', 'arrowup'].includes(key)) view.radius = Math.max(controls.minDistance, view.radius * 0.88);
            if (['s', 'arrowdown'].includes(key)) view.radius = Math.min(controls.maxDistance, view.radius * 1.12);
            camera.position.copy(controls.target).add(offset.setFromSpherical(view));
            controls.update();
          }
        };
        scene.add(mesh);
        renderer.setAnimationLoop(() => { if (document.hidden) return; controls.update(); renderer.render(scene, camera); });
        setPhase('ready');
      } catch { if (active) setPhase('error'); }
    })();
    return () => {
      active = false;
      download.abort();
      controlsRef.current = null;
      resize.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      controls.dispose();
      if (mesh?.isInitialized) mesh.dispose();
      spark.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url]);
  useEffect(() => { if (position && phase === 'ready') controlsRef.current?.move(position); }, [position?.[0], position?.[1], position?.[2], phase]);
  return <div className="spatial" tabIndex={0} aria-label="3D scene. Use arrow keys to orbit or zoom."
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.target !== event.currentTarget) return;
      const key = event.key.toLowerCase();
      if (['a', 'd', 'w', 's', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
        event.preventDefault(); controlsRef.current?.orbit(key);
      }
    }}>
    <div className="spatial-canvas" ref={host} />
    <div className="spatial-bar"><span className="glass-pill"><Box size={15} /> {provenance === 'imagined' ? 'Generated interpretation' : 'Reconstructed scan'} · Guided inspection · Scale unverified</span>
      <button className="glass-icon" onClick={onClose} aria-label="Close 3D scene"><X size={18} /></button></div>
    {phase === 'load' && <div className="spatial-state" role="status">Loading the scene…</div>}
    {phase === 'error' && <div className="spatial-state" role="status"><p>The 3D scene could not be loaded on this device.</p><button className="btn" onClick={onClose}>Return to photo trail</button></div>}
    {phase === 'ready' && <div className="spatial-help"><span>Drag to orbit · Scroll to zoom · Walking requires a collision mesh</span><button className="btn compact" onClick={() => {
      const point = controlsRef.current?.read();
      if (point) onWaypoint(point);
    }}><Plus size={16} /> Add waypoint</button></div>}
  </div>;
}
