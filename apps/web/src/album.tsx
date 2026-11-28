import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Compass, RotateCcw, X } from 'lucide-react';
import { createAlbumScene, type AlbumControls, type AlbumFrame } from './album-scene';
import { albumEnd, photoStops } from './album-layout';
import { displayDate, sourceURL, type Snapshot, type Source } from './model';
import './album.css';

export default function WalkableAlbum({ state, photos, title, onClose }: {
  state: Snapshot; photos: Source[]; title: string; onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const controls = useRef<AlbumControls | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [frame, setFrame] = useState<AlbumFrame>({ x: 0, z: 6, yaw: 0 });
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [help, setHelp] = useState(false);
  const photoKey = photos.map(photo => photo.id).join(',');
  const storageKey = 'everwhere-album-visits-' + state.projectId;
  const [visited, setVisited] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  });
  const inspected = photos.find(photo => photo.id === inspectedId);
  const memory = state.events.find(event => inspected && event.sourceIds.includes(inspected.id));
  const recollections = state.recollections.filter(item => item.eventId === memory?.id);
  const visitedCount = photos.filter(photo => visited.includes(photo.id)).length;
  const stops = photoStops(photos);
  const end = albumEnd(photos.length);
  const nearby = photos.find(photo => photo.id === frame.nearby);
  const complete = photos.length > 0 && visitedCount === photos.length;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    host.current?.focus();
    return () => { document.body.style.overflow = overflow; previousFocus?.focus(); };
  }, []);

  useEffect(() => {
    if (!host.current || !photos.length) return;
    setPhase('loading');
    try {
      controls.current = createAlbumScene(host.current, state.projectId, photos, setFrame, () => setPhase('error'));
      setPhase('ready');
    } catch { setPhase('error'); }
    return () => { controls.current?.dispose(); controls.current = null; };
  }, [state.projectId, photoKey]);

  useEffect(() => {
    controls.current?.pause(Boolean(inspected || help));
    if (inspected || help) dialog.current?.querySelector<HTMLButtonElement>('.walk-overlay button')?.focus();
    else host.current?.focus();
  }, [inspected?.id, help]);

  function inspect() {
    if (!nearby) return;
    setImageFailed(false);
    setInspectedId(nearby.id);
  }
  function markVisited(id: string) {
    if (visited.includes(id)) return;
    const next = [...visited, id];
    setVisited(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Browsing still works when storage is disabled. */ }
  }
  function nextPhoto() {
    const next = photos.findIndex(photo => !visited.includes(photo.id));
    const current = photos.findIndex(photo => photo.id === nearby?.id);
    controls.current?.visit(next >= 0 ? next : (current + 1) % photos.length);
    host.current?.focus();
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') || [])]
        .filter(element => element.getClientRects().length && (!inspected && !help || element.closest('.walk-overlay')));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (inspectedId) setInspectedId(null);
      else if (help) setHelp(false);
      else onClose();
    }
    if (event.target !== host.current || inspected || help) return;
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'e'].includes(key)) {
      event.preventDefault();
      if (key === 'e' && !event.repeat) inspect();
      else controls.current?.keys.add(key);
    }
  }
  function hold(event: PointerEvent<HTMLButtonElement>, key: string) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    controls.current?.keys.add(key);
  }
  const movement = [
    { key: 'w', name: 'Walk forward', icon: ArrowUp },
    { key: 'a', name: 'Step left', icon: ArrowLeft },
    { key: 's', name: 'Walk backward', icon: ArrowDown },
    { key: 'd', name: 'Step right', icon: ArrowRight }
  ];
  return createPortal(<div className="walk-album" role="dialog" aria-modal="true" aria-label={title + ' immersive album'} ref={dialog}
    onKeyDown={keyDown} onKeyUp={event => controls.current?.keys.delete(event.key.toLowerCase())}>
    <div className="walk-canvas" ref={host} tabIndex={0} aria-label="Walk through your album. WASD to move, arrow keys to turn, drag to look, E to open a nearby photo."
      onBlur={() => controls.current?.keys.clear()} />
    <div className="walk-vignette" />
    <header className="walk-header">
      <div className="walk-brand">everwhere<span>Immersive album</span></div>
      <div className="walk-header-actions">
        <button onClick={() => setHelp(true)}>Controls</button>
        <button className="walk-exit" onClick={onClose}><X size={16} /> Exit</button>
      </div>
    </header>
    <section className="walk-mission" aria-label="Album progress">
      <span className="walk-kicker">{complete ? 'Album explored' : 'Explore your album'}</span>
      <h1>{title}</h1>
      <p>{complete ? 'Every photograph has a place here.' : 'Find the photographs. Revisit the moments.'}</p>
      <div className="walk-progress"><span style={{ width: (photos.length ? visitedCount / photos.length * 100 : 0) + '%' }} /></div>
      <span className="walk-count" aria-live="polite">{visitedCount} / {photos.length} photos visited</span>
    </section>
    {phase === 'ready' && <>
      <div className="walk-reticle" aria-hidden="true" />
      <div className="walk-interact">
        {nearby ? <button onClick={inspect}><kbd>E</kbd><span>Open photo<strong>{nearby.caption}</strong></span><ArrowRight size={20} /></button> :
          <span className="walk-direction">Walk toward a photo frame or choose a stop on the map.</span>}
      </div>
      <nav className="walk-map" aria-label="Album map">
        <div className="walk-map-title"><Compass size={14} /><span>Photo walk</span><span>N</span></div>
        <div className="walk-map-ground">
          <div className="walk-map-path" />
          {stops.map((stop, index) => <button key={stop.sourceId} className={'walk-map-stop' + (visited.includes(stop.sourceId) ? ' visited' : '')}
            title={'Go to ' + photos[index].caption} aria-label={'Go to photo ' + (index + 1) + ', ' + photos[index].caption}
            style={{ left: (50 + stop.x * 7) + '%', top: ((stop.z - end) / (10 - end) * 82 + 7) + '%' }}
            onClick={() => { controls.current?.visit(index); host.current?.focus(); }}>{visited.includes(stop.sourceId) ? <Check size={10} /> : index + 1}</button>)}
          <span className="walk-map-player" aria-label="Your position" style={{ left: (50 + frame.x * 7) + '%', top: ((frame.z - end) / (10 - end) * 82 + 7) + '%', transform: `translate(-50%,-50%) rotate(${-frame.yaw}rad)` } as CSSProperties} />
        </div>
        <button className="walk-next" onClick={nextPhoto}>Next photo <ArrowRight size={14} /></button>
      </nav>
      <div className="walk-movement" aria-label="Movement controls">{movement.map(({ key, name, icon: Icon }) =>
        <button className={'walk-key-' + key} key={key} aria-label={name} onPointerDown={event => hold(event, key)}
          onPointerUp={() => controls.current?.keys.delete(key)} onPointerCancel={() => controls.current?.keys.delete(key)}
          onLostPointerCapture={() => controls.current?.keys.delete(key)}
          onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); controls.current?.keys.add(key); } }}
          onKeyUp={() => controls.current?.keys.delete(key)} onBlur={() => controls.current?.keys.delete(key)}><Icon size={19} /></button>)}</div>
      <footer className="walk-footer"><span><kbd>W A S D</kbd> move <kbd>Shift</kbd> sprint <span>Drag to look</span></span><span>Designed coastal setting</span></footer>
    </>}
    {phase !== 'ready' && <div className="walk-overlay walk-loading" role="status"><div>
      <Compass size={30} /><h2>{phase === 'loading' ? 'Opening your album…' : 'This device could not open the 3D album'}</h2>
      {phase === 'error' && <><p>Try a WebGL-enabled browser. Your photos are available in Studio.</p><button className="walk-primary" onClick={onClose}>Return to album</button></>}
    </div></div>}
    {inspected && <div className="walk-overlay"><article className="walk-photo">
      <button className="walk-photo-close" aria-label="Close photo" onClick={() => setInspectedId(null)}><X size={20} /></button>
      <div className="walk-photo-image">{imageFailed ? <p role="alert">This photo is unavailable. Close the album and refresh your project.</p> :
        <img key={inspected.id} src={sourceURL(state.projectId, inspected.id)} alt={inspected.caption} onLoad={() => markVisited(inspected.id)} onError={() => setImageFailed(true)} />}</div>
      <div className="walk-photo-copy"><span className="walk-kicker">{inspected.provenance === 'imagined' ? 'Imagined demo' : 'Original photograph'}</span>
        <h2>{inspected.caption}</h2><p className="walk-photo-meta">{displayDate(inspected.capturedAt || memory?.startAt)}{memory?.placeLabel && ' · ' + memory.placeLabel}</p>
        {memory?.story && <p>{memory.story}</p>}
        {recollections.map(item => <blockquote key={item.id}>{item.text}<cite>{item.contributor} · Recollection</cite></blockquote>)}
        <button className="walk-primary" onClick={() => setInspectedId(null)}>Continue exploring <ArrowRight size={16} /></button>
      </div>
    </article></div>}
    {help && <div className="walk-overlay"><section className="walk-help">
      <button className="walk-photo-close" aria-label="Close controls" onClick={() => setHelp(false)}><X size={20} /></button>
      <Compass size={28} /><h2>A place for your photographs.</h2>
      <p>Walk along the waterfront and open each photograph to discover its story. The coastal setting is designed for your album.</p>
      <dl><dt>Walk / strafe</dt><dd>W A S D or the on-screen arrows</dd><dt>Look around</dt><dd>Drag the scene. ← → turns, ↑ ↓ walks.</dd><dt>Move faster</dt><dd>Hold Shift while walking</dd><dt>Open a nearby photo</dt><dd>Press E or tap Open photo</dd><dt>Go straight to a photo</dt><dd>Choose its stop on the map or Next photo</dd><dt>Close a photo / leave</dt><dd>Escape</dd></dl>
      <p className="walk-help-note">Visited photos are remembered in this browser. Original media and attributed recollections stay linked to your project.</p>
      <div className="walk-help-actions"><button onClick={() => { controls.current?.reset(); setHelp(false); }}><RotateCcw size={16} /> Return to entrance</button><button className="walk-primary" onClick={() => setHelp(false)}>Keep exploring</button></div>
    </section></div>}
  </div>, document.body);
}
