import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, DoorOpen, ExternalLink, MapPin, RotateCcw, X } from 'lucide-react';
import { Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, SphereGeometry, SRGBColorSpace, TextureLoader, WebGLRenderer } from 'three';
import { directionLink, linkYaw, normalizedYaw, readTour, type Tour, type TourLink, type TourNode } from './panorama-navigation';
import StreetView, { type StreetViewHandle } from './streetview';
import { api, type Movement } from './model';
import './panorama.css';

type Look = { yaw: number; pitch: number };
type Pending = { id: string; back: boolean; kind?: 'walk' | 'door' };

function SceneImage({ node, look, onError }: { node: TourNode; look: Look; onError: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const draw = useRef<((look: Look) => void) | null>(null);
  const latest = useRef({ look, onError });
  latest.current = { look, onError };
  useEffect(() => {
    if (node.projection !== 'equirectangular' || !host.current) return;
    const element = host.current;
    let active = true;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ antialias: true }); }
    catch { latest.current.onError(); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    element.appendChild(renderer.domElement);
    const scene = new Scene();
    const camera = new PerspectiveCamera(70, 1, 0.1, 50);
    camera.rotation.order = 'YXZ';
    const geometry = new SphereGeometry(10, 64, 40);
    geometry.scale(-1, 1, 1);
    const material = new MeshBasicMaterial();
    const sphere = new Mesh(geometry, material);
    sphere.rotation.y = -Math.PI / 2;
    scene.add(sphere);
    draw.current = value => {
      camera.rotation.set(value.pitch * Math.PI / 180, -value.yaw * Math.PI / 180, 0, 'YXZ');
      renderer.render(scene, camera);
    };
    const resize = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      renderer.setSize(element.clientWidth, element.clientHeight);
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      draw.current?.(latest.current.look);
    });
    resize.observe(element);
    const texture = new TextureLoader().load(node.image!, image => {
      if (!active) { image.dispose(); return; }
      image.colorSpace = SRGBColorSpace;
      material.map = image; material.needsUpdate = true;
      draw.current?.(latest.current.look);
    }, undefined, () => { if (active) latest.current.onError(); });
    const lost = (event: Event) => { event.preventDefault(); latest.current.onError(); };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    return () => {
      active = false; draw.current = null; resize.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      texture.dispose(); geometry.dispose(); material.dispose(); renderer.dispose(); renderer.domElement.remove();
    };
  }, [node.id, node.image, node.projection]);
  useEffect(() => { draw.current?.(look); }, [look]);
  if (node.projection === 'streetview') return <iframe className="tour-streetview" src={node.streetViewEmbedUrl}
    title={node.title + ' — Google Street View reference'} loading="eager" allowFullScreen
    referrerPolicy="strict-origin-when-cross-origin" onError={onError} />;
  return node.projection === 'equirectangular' ? <div className="tour-sphere" ref={host} /> :
    <img className="tour-image" src={node.image} alt={node.description || node.title} draggable={false}
      style={{ transform: `scale(1.12) translate(${-look.yaw * 0.25}%, ${look.pitch * 0.25}%)` }} />;
}

export default function Panorama({ url, title, initialNodeId, onNodeChange, onClose, onSource, projectId, worldId, movement, place, owner }: {
  url: string; title: string; initialNodeId?: string; onNodeChange: (nodeId: string) => void | Promise<void>;
  onClose: () => void; onSource?: (node: TourNode) => void;
  projectId?: string; worldId?: string; movement?: Movement; place?: { nodeId: string; heading: number }; owner?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const sourcesButton = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const latest = useRef({ initialNodeId, onNodeChange });
  latest.current = { initialNodeId, onNodeChange };
  const [tour, setTour] = useState<Tour | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [look, setLook] = useState<Look>({ yaw: 0, pitch: 0 });
  const [previous, setPrevious] = useState<TourNode | null>(null);
  const [entering, setEntering] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const images = useRef(new Map<string, Promise<void>>());
  const navigation = useRef(0);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const node = tour?.nodes.find(item => item.id === nodeId);
  const live = !!node?.streetView;
  const viewer = useRef<StreetViewHandle | null>(null);
  const viewerId = useRef('');
  const consumed = useRef(new Set<string>());
  const busy = useRef<'key' | 'voice' | null>(null);
  const runs = useRef(0);
  const [ready, setReady] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [notice, setNotice] = useState('');
  const session = '/projects/' + projectId + '/session';
  // Read through a ref: a move awaits Google, and must save and acknowledge against the state at completion, not at key press.
  const now = useRef({ registered, nodeId });
  now.current = { registered, nodeId };
  const report = () => {
    const { registered, nodeId } = now.current;
    if (registered && nodeId && viewer.current) void api(session, { streetViewNavigation: { worldId, nodeId, ...viewer.current.navigation() }, viewerId: viewerId.current }).catch(() => {});
  };
  const save = (heading: number) => {
    const { registered, nodeId } = now.current;
    if (registered && nodeId) void api(session, { streetViewPlace: { worldId, nodeId, heading }, viewerId: viewerId.current })
      .catch(() => setNotice('This view direction could not be saved. Reopening may return to an earlier direction.'));
    // Sent separately and best-effort: live exits help VoiceOS plan steps but must never block saving the place.
    report();
  };
  const ack = (command: Movement | undefined, status: string, heading?: number, reason?: string) => {
    if (command) void api('/projects/' + projectId + '/worlds/' + worldId + '/movement-ack', { commandId: command.id, status, viewerId: command.viewerId ?? viewerId.current,
      ...(heading !== undefined && { nodeId: now.current.nodeId, heading }), ...(reason && { reason }) })
      // 409 means a newer command or viewer superseded this one, which is expected; anything else is a lost receipt.
      .catch(failure => { if ((failure as { status?: number }).status !== 409) setNotice('The movement result could not be reported to VoiceOS. Check your connection.'); });
  };
  // Keyboard and VoiceOS share this one executor; a receipt reports only what the provider confirmed.
  async function drive(direction: Movement['direction'], degrees: number, command?: Movement) {
    const view = viewer.current;
    if (!view) { ack(command, 'blocked', undefined, 'Street View is still loading.'); return; }
    if (direction === 'stop') { runs.current++; busy.current = null; view.stop(); ack(command, 'stopped', view.heading()); setNotice('Stopped.'); return; }
    if (busy.current) {
      if (!command && busy.current === 'key') return;
      view.stop();
      // A key press during a voice movement is a manual takeover: it cancels rather than queues.
      if (!command) { runs.current++; busy.current = null; setNotice('Voice movement stopped.'); return; }
    }
    const run = ++runs.current;
    busy.current = command ? 'voice' : 'key';
    setNotice(direction.startsWith('turn_') ? 'Turning…' : 'Moving to the next Street View position…');
    const result = await view.move(direction, degrees);
    ack(command, result.status, result.heading, result.reason);
    if (run !== runs.current) return;
    busy.current = null;
    setNotice(result.status === 'completed' ? '' : result.reason ?? 'Stopped.');
    if (result.status === 'completed') save(result.heading);
  }
  useEffect(() => {
    if (!tour?.liveStreetView || !projectId || !worldId) return;
    // A fresh ID per registration: a delayed close from an earlier mount cannot unregister this one.
    const id = viewerId.current = crypto.randomUUID();
    let current = true;
    api(session, { activeWorldId: worldId, viewerId: id }).then(() => { if (current) setRegistered(true); })
      .catch(() => { if (current) setNotice('Voice movement is unavailable: this view could not be registered. Keyboard controls still work.'); });
    return () => { current = false; setRegistered(false); void api(session, { activeWorldId: null, viewerId: id }).catch(() => {}); };
  }, [tour, projectId, worldId]);
  useEffect(() => {
    const command = movement;
    if (!command || !registered || !ready || consumed.current.has(command.id) || command.worldId !== worldId || command.viewerId !== viewerId.current) return;
    consumed.current.add(command.id);
    // The per-registration viewer ID already excludes commands from before this viewer opened, without trusting clocks.
    if (Date.parse(command.expiresAt) <= Date.now()) { ack(command, 'ignored', undefined, 'The command expired before this view could run it.'); return; }
    if (!Number.isFinite(command.degrees) || command.degrees < 1 || command.degrees > 90) { ack(command, 'ignored', undefined, 'Invalid movement command.'); return; }
    if (drawer || error || pending || document.hidden) { ack(command, 'blocked', undefined, 'Show the Street View without an open panel before moving.'); return; }
    void drive(command.direction, command.degrees, command);
  }, [movement?.id, registered, ready]);
  useEffect(() => { if (ready && registered && viewer.current) save(viewer.current.heading()); }, [ready, registered]);
  // The server expires reported exits after 30 seconds; refresh while this viewer is live.
  const reporting = useRef(report);
  reporting.current = report;
  useEffect(() => { if (!ready || !registered) return; const timer = setInterval(() => reporting.current(), 15000); return () => clearInterval(timer); }, [ready, registered]);
  const owned = useRef(false);
  useEffect(() => {
    // Another tab registering for this scene takes voice ownership: cancel pending work here.
    if (owner === viewerId.current) { owned.current = true; return; }
    if (!owned.current || !registered) return;
    owned.current = false; runs.current++; busy.current = null; viewer.current?.stop(); setRegistered(false);
    setNotice('Voice movement moved to another open view of this memory. Reopen this walkthrough to take it back.');
  }, [owner]);
  useEffect(() => { if (!notice || notice.endsWith('…')) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);
  function preload(target: TourNode) {
    if (target.projection === 'streetview') return Promise.resolve();
    const saved = images.current.get(target.id);
    if (saved) return saved;
    const loading = new Promise<void>((resolve, reject) => {
      const image = new Image();
      const timer = window.setTimeout(() => { image.onload = null; image.onerror = null; reject(new Error('The next view took too long to load.')); }, 15000);
      image.onload = () => { clearTimeout(timer); image.naturalWidth ? resolve() : reject(new Error('This viewpoint has no usable image.')); };
      image.onerror = () => { clearTimeout(timer); reject(new Error('This viewpoint could not be loaded.')); };
      image.src = target.image!;
    }).catch(reason => { images.current.delete(target.id); throw reason; });
    images.current.set(target.id, loading);
    return loading;
  }
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; stage.current?.focus();
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => { navigation.current++; document.body.style.overflow = overflow; media.removeEventListener('change', change); focused?.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const request = ++navigation.current;
    setTour(null); setNodeId(''); setHistory([]); setError(''); setPending(null); images.current.clear();
    void (async () => {
      try {
        const location = new URL(url, window.location.href);
        if (location.origin !== window.location.origin) throw new Error('This walkthrough must come from your Everwhere project.');
        const response = await fetch(location, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) throw new Error('This walkthrough is unavailable. Return to the memory to check its sources and approval.');
        const next = readTour(await response.json());
        const first = next.nodes.find(item => item.id === latest.current.initialNodeId) ?? next.nodes.find(item => item.id === next.startNodeId)!;
        await preload(first);
        if (request !== navigation.current) return;
        setTour(next); setNodeId(first.id); setLook({ yaw: 0, pitch: 0 });
      } catch (reason) { if (!controller.signal.aborted && request === navigation.current) setError((reason as Error).message); }
    })();
    return () => { controller.abort(); navigation.current++; };
  }, [url, retry]);
  useEffect(() => {
    if (!node || !tour) return;
    for (const link of node.links) { const target = tour.nodes.find(item => item.id === link.to); if (target) void preload(target).catch(() => {}); }
  }, [node, tour]);
  useEffect(() => { if (drawer) drawerClose.current?.focus(); }, [drawer]);
  useEffect(() => { if (!previous && !entering) return; const timer = setTimeout(() => { setPrevious(null); setEntering(false); }, reduced ? 0 : 450); return () => clearTimeout(timer); }, [previous, entering, reduced]);
  async function travel(targetId: string, back = false, kind?: 'walk' | 'door', notify = true) {
    const target = tour?.nodes.find(item => item.id === targetId);
    if (!target || !node || target.id === node.id) return;
    const request = ++navigation.current;
    setPending({ id: targetId, back, kind }); setError(''); setDrawer(false);
    try {
      await preload(target);
      if (request !== navigation.current) return;
      // Keep route controls pending until persistence finishes. A failed save leaves
      // the previous view intact and can use the same retry path as a failed image.
      if (notify) await latest.current.onNodeChange(target.id);
      if (request !== navigation.current) return;
      setPrevious(!reduced && node.projection === 'perspective' && target.projection === 'perspective' ? node : null);
      setEntering(!reduced && kind === 'door'); setNodeId(target.id); setLook({ yaw: 0, pitch: 0 });
      setHistory(items => back ? items.slice(0, -1) : [...items, node.id]);
      setPending(null); stage.current?.focus();
    } catch (reason) { if (request === navigation.current) setError((reason as Error).message); }
  }
  useEffect(() => {
    // The current user navigation owns its history/door transition while its
    // session acknowledgement arrives. Other external selections still navigate.
    if (tour && initialNodeId && initialNodeId !== nodeId && initialNodeId !== pending?.id && tour.nodes.some(item => item.id === initialNodeId)) void travel(initialNodeId, false, undefined, false);
  }, [initialNodeId]);
  const backId = history.at(-1);
  const goBack = () => { if (backId) void travel(backId, true); else { const link = node && directionLink(node, 'back'); if (link) void travel(link.to, false, link.kind); } };
  const closeDrawer = () => { setDrawer(false); sourcesButton.current?.focus(); };
  const direction = (key: string) => {
    if (live) {
      void drive(['w', 'arrowup'].includes(key) ? 'forward' : ['s', 'arrowdown'].includes(key) ? 'backward' : ['a', 'arrowleft'].includes(key) ? 'turn_left' : 'turn_right', 30);
      return;
    }
    if (['s', 'arrowdown'].includes(key)) { goBack(); return; }
    if (!node) return;
    const link = directionLink(node, ['a', 'arrowleft'].includes(key) ? 'left' : ['d', 'arrowright'].includes(key) ? 'right' : 'forward', look.yaw);
    if (link) void travel(link.to, false, link.kind);
  };
  return createPortal(<div ref={dialog} className={'everwhere-tour' + (reduced ? ' tour-reduced' : '') + (node?.projection === 'streetview' ? ' tour-reference' : '') + (live ? ' tour-live' : '')} role="dialog" aria-modal="true" aria-label={title + ' walkthrough'}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); drawer ? closeDrawer() : onClose(); return; }
      if (event.key === 'Tab') {
        const scope = drawer ? dialog.current?.querySelector('.tour-sources') : dialog.current;
        const items = [...(scope?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], iframe, [tabindex="0"]') ?? [])].filter(item => item.getClientRects().length);
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
      if (event.target === stage.current && !pending && !drawer && !event.repeat && ['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'].includes(event.key.toLowerCase())) {
        event.preventDefault(); direction(event.key.toLowerCase());
      }
    }}>
    <div className="tour-stage" ref={stage} tabIndex={0} aria-label={live ? 'Google Street View. Drag to look. W or up moves to the next Street View position; S or down moves back. A and D turn.' : 'Scene view. Drag to look. W or up goes forward; S or down goes back. A and D follow side routes.'}
      onPointerDown={event => { if (!node || node.projection === 'streetview' || pending || drawer) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; }}
      onPointerMove={event => {
        const pointer = drag.current;
        if (!pointer || pointer.id !== event.pointerId || !node) return;
        const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
        pointer.x = event.clientX; pointer.y = event.clientY;
        setLook(value => ({ yaw: node.projection === 'equirectangular' ? normalizedYaw(value.yaw - dx * .16) : Math.max(-12, Math.min(12, value.yaw - dx * .04)),
          pitch: Math.max(node.projection === 'equirectangular' ? -75 : -8, Math.min(node.projection === 'equirectangular' ? 75 : 8, value.pitch + dy * (node.projection === 'equirectangular' ? .12 : .03))) }));
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {node?.streetView && <StreetView key={node.id + retry} locator={node.streetView} title={node.title} reduced={reduced}
        heading={place?.nodeId === node.id ? place.heading : undefined}
        onReady={handle => { viewer.current = handle; setReady(!!handle); if (!handle) { runs.current++; busy.current = null; } }}
        onError={message => { viewer.current = null; setReady(false); setError(message); }}
        onKey={key => { if (!pending && !drawer && !error) direction(key); }} onLook={save} />}
      {node && !node.streetView && <SceneImage key={node.id + retry} node={node} look={look} onError={() => setError('This viewpoint could not be displayed on this device. Retry or return to the previous view.')} />}
      {previous && <img className="tour-previous" src={previous.image} alt="" aria-hidden="true" />}
    </div>
    <div className="tour-shade" />
    <header className="tour-header"><div className="tour-brand">everwhere<span>{live ? 'Google Street View' : node?.projection === 'streetview' ? 'Street View reference' : 'Imagined reconstruction'}</span></div>
      <button className="tour-icon" onClick={onClose} aria-label="Exit walkthrough"><X size={20} /></button></header>
    {entering && <div className="tour-door-cue" role="status"><DoorOpen size={17} /> Through the doorway</div>}
    {live && notice && !entering && <div className="tour-door-cue" role="status">{notice}</div>}
    {node && !error && <>
      <div className="tour-caption"><span className="tour-eyebrow"><MapPin size={13} /> {tour?.title || title}</span><h1>{node.title}</h1><p>{node.description}</p></div>
      {node.projection !== 'streetview' && <div className="tour-hotspots" aria-label="Routes from this viewpoint">{node.links.slice(0, 3).map((link, index) => {
        const angle = normalizedYaw(linkYaw(link, index) - look.yaw);
        if (Math.abs(angle) > 85) return null;
        const style = { '--hotspot-x': `${Math.max(12, Math.min(88, 50 + angle * .5))}%`, '--hotspot-y': `${Math.max(40, Math.min(65, 57 - ((link.pitch ?? 0) - look.pitch) * .4))}%` } as CSSProperties;
        return <button style={style} key={link.to + index} className={'tour-hotspot' + (link.kind === 'door' ? ' tour-door' : '')} disabled={!!pending}
          onClick={() => void travel(link.to, false, link.kind)}>{link.kind === 'door' ? <DoorOpen size={20} /> : <ArrowUpRight size={22} />}<span>{link.label}</span></button>;
      })}</div>}
      <footer className="tour-footer"><div className="tour-hint">{live ? <>Drag to look <span>·</span> W / S move between Street View positions <span>·</span> A / D turn <span>·</span> Not free walking</> : node.projection === 'streetview' ? 'Explore with Google’s controls. Use the routes below to continue your memory.' : <>Drag to look <span>·</span> W A S D to follow routes <span>·</span> Linked viewpoints</>}</div>
        <nav className="tour-route" aria-label="Walkthrough navigation"><button className="tour-back" onClick={goBack} disabled={!!pending || (!backId && !directionLink(node, 'back'))}><ArrowLeft size={18} /><span>Back</span></button>
          <div className="tour-route-links">{node.links.map((link, index) => <button key={link.to + index} disabled={!!pending} onClick={() => void travel(link.to, false, link.kind)}>
            {link.kind === 'door' ? <DoorOpen size={17} /> : <ArrowRight size={17} />}<span>{link.label}</span></button>)}{!node.links.length && <span className="tour-end">Take a moment. You’ve reached the last view.</span>}</div>
          <button ref={sourcesButton} className="tour-context" onClick={() => setDrawer(true)} aria-expanded={drawer}><BookOpen size={18} /><span>About this place</span></button></nav>
        <div className="tour-count"><span>{String((tour?.nodes.findIndex(item => item.id === node.id) ?? 0) + 1).padStart(2, '0')}</span> / {String(tour?.nodes.length ?? 0).padStart(2, '0')} viewpoints</div>
      </footer>
    </>}
    {(!node || pending || (live && !ready)) && !error && <div className={'tour-loading' + (pending?.kind === 'door' ? ' tour-entering' : '')} role="status" aria-live="polite">
      {pending?.kind === 'door' ? <DoorOpen size={24} /> : <MapPin size={24} />}<p>{pending?.kind === 'door' ? 'Opening the next space…' : pending ? 'Moving to the next viewpoint…' : live && node ? 'Opening Google Street View…' : 'Opening your walkthrough…'}</p></div>}
    {error && <div className="tour-error" role="alert"><div><span className="tour-eyebrow">View unavailable</span><h2>Let’s find our way back.</h2><p>{error}</p><div className="tour-error-actions">
      <button onClick={() => pending ? void travel(pending.id, pending.back, pending.kind) : setRetry(value => value + 1)}><RotateCcw size={17} /> Retry</button>
      {node && pending && <button onClick={() => { setError(''); setPending(null); navigation.current++; stage.current?.focus(); }}><ArrowLeft size={17} /> Stay here</button>}
      {node && backId && <button onClick={goBack}><ArrowLeft size={17} /> Previous view</button>}
      <button onClick={onClose}>Return to memory</button></div></div></div>}
    {drawer && node && <div className="tour-source-scrim" onClick={closeDrawer}><aside className="tour-sources" aria-label="About this place" onClick={event => event.stopPropagation()}>
      <div className="tour-source-heading"><span className="tour-eyebrow">Place & provenance</span><button ref={drawerClose} className="tour-icon" onClick={closeDrawer} aria-label="Close place details"><X size={19} /></button></div>
      <h2>{node.title}</h2><p>{node.description}</p><div className="tour-disclosure"><strong>{live ? 'Google Street View' : node.projection === 'streetview' ? 'Street View reference' : 'Imagined reconstruction'}</strong><p>{live ? 'This is Google’s own imagery of the place, shown with Google’s attribution and capture date. Its season and date are Google’s, not your occasion’s; it is location context, not evidence of who was there.' : node.projection === 'streetview' ? 'This is Google’s embedded view of the place, with its original attribution. It provides location context, not evidence of your occasion or its date.' : 'These linked views are a generated interpretation. Details beyond the source photographs are imagined; this is not a measured reconstruction or a live view.'}</p></div>
      {!!node.facts?.length && <section><h3>Context from public sources</h3><ul>{node.facts.map((fact, index) => <li key={index}><p>{fact.text}</p><a href={fact.url} target="_blank" rel="noopener noreferrer">Read source <ExternalLink size={13} /></a></li>)}</ul></section>}
      {!node.facts?.length && <p className="tour-muted">No verified place facts have been attached to this viewpoint.</p>}
      {node.streetViewUrl && <a className="tour-source-link" href={node.streetViewUrl} target="_blank" rel="noopener noreferrer">Compare with Street View <ExternalLink size={15} /></a>}
      {onSource && !!node.sourceIds?.length && <button className="tour-source-link" onClick={() => { closeDrawer(); onSource(node); }}>View linked sources <ArrowUpRight size={16} /></button>}
    </aside></div>}
    <span className="tour-sr-only" role="status" aria-live="polite">{node && !pending ? `Viewpoint: ${node.title}. ${node.links.length} routes available.` : ''}</span>
  </div>, document.body);
}
