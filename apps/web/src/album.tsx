import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Compass, MapPin, RotateCcw, X } from 'lucide-react';
import { createAlbumScene, type AlbumControls, type AlbumFrame } from './album-scene';
import { albumEnd, photoStops } from './album-layout';
import { displayDate, sourceURL, type Snapshot, type Source } from './model';
import './album.css';
import { RuntimeTools } from './gameplay/tools';

export default function CoastalWalk({ state, photos: sources, title, onClose, onWaypoint, notifications, onDiscover }: {
  state: Snapshot; photos: Source[]; title: string; onClose: () => void;
  onWaypoint?: (sourceId: string, position: [number, number, number]) => void;
  notifications?: ReactNode;
  onDiscover?: (source: Source) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const controls = useRef<AlbumControls | null>(null);
  const lastStop = useRef(-1);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [frame, setFrame] = useState<AlbumFrame>({ x: 0, y: 1.65, z: 6, yaw: 0 });
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [help, setHelp] = useState(false);
  const sourceIds = sources.map(source => source.id).join(',');
  const storageKey = 'everwhere-album-visits-' + state.projectId;
  const [visited, setVisited] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
  });
  const visitedRef = useRef(visited);
  const inspected = sources.find(source => source.id === inspectedId);
  const memory = state.events.find(event => inspected && event.sourceIds.includes(inspected.id));
  const recollections = state.recollections.filter(item => item.eventId === memory?.id && (!item.anchorId ||
    state.anchors.some(anchor => anchor.id === item.anchorId && inspected && anchor.sourceIds.includes(inspected.id))));
  const visitedCount = sources.filter(source => visited.includes(source.id)).length;
  const stops = photoStops(sources);
  const end = albumEnd(sources.length);
  const nearby = sources.find(source => source.id === frame.nearby);
  const complete = sources.length > 0 && visitedCount === sources.length;
  const nextUnvisited = sources.findIndex(source => !visited.includes(source.id));
  const canOpenNearby = nearby && (!visited.includes(nearby.id) || complete);
  const cue = canOpenNearby ? nearby : sources[nextUnvisited];
  const cueLabel = canOpenNearby ? 'Open waypoint' : visitedCount === 0 ? 'Go to first waypoint' : 'Go to next waypoint';
  const pathMemory = sources.length ? state.events.find(item => sources.every(source => item.sourceIds.includes(source.id))) : undefined;
  const contextURL = pathMemory ? '/projects/' + state.projectId + '/memories/' + pathMemory.id +
    '/scene-context?sources=' + encodeURIComponent(sourceIds) : undefined;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    host.current?.focus();
    return () => { document.body.style.overflow = overflow; previousFocus?.focus(); };
  }, []);

  useEffect(() => {
    if (!host.current) return;
    setPhase('loading');
    try {
      controls.current = createAlbumScene(host.current, sources, value => {
        setFrame(value);
        if (value.nearby) lastStop.current = sources.findIndex(source => source.id === value.nearby);
      }, () => setPhase('error'));
      setPhase('ready');
    } catch { setPhase('error'); }
    return () => { controls.current?.dispose(); controls.current = null; };
  }, [state.projectId, sourceIds]);

  useEffect(() => {
    const anchor = state.anchors.find(item => item.id === state.session.anchorId && item.worldId === 'trail-' + item.eventId);
    const index = sources.findIndex(source => anchor?.sourceIds.includes(source.id));
    if (index >= 0) controls.current?.visit(index, anchor?.position);
  }, [state.session.anchorId, state.session.anchorNavigationId, sourceIds]);

  useEffect(() => {
    controls.current?.pause(Boolean(inspected || help));
    if (inspected || help || phase === 'error') dialog.current?.querySelector<HTMLButtonElement>('.walk-overlay button')?.focus();
    else host.current?.focus();
  }, [inspected?.id, help, phase]);

  function inspect() {
    if (!nearby) return;
    setImageFailed(false);
    setInspectedId(nearby.id);
    if (visitedRef.current.includes(nearby.id)) return;
    const next = [...visitedRef.current, nearby.id];
    visitedRef.current = next;
    setVisited(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Browsing still works when storage is disabled. */ }
    onDiscover?.(nearby);
  }
  function goToWaypoint(index: number) {
    lastStop.current = index;
    controls.current?.visit(index);
    host.current?.focus();
  }
  function nextWaypoint() {
    goToWaypoint(nextUnvisited >= 0 ? nextUnvisited : (lastStop.current + 1) % sources.length);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    if (event.key === 'Tab') {
      const overlayOpen = inspected || help || phase === 'error';
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]'
      ) || [])].filter(element => element.getClientRects().length && (!overlayOpen || element.closest('.walk-overlay')));
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
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'e', ' '].includes(key)) {
      event.preventDefault();
      if (key === 'e' && !event.repeat) inspect();
      else if (key !== ' ' || !event.repeat) controls.current?.keys.add(key);
    }
  }
  function hold(event: PointerEvent<HTMLButtonElement>, key: string) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    controls.current?.keys.add(key);
  }
  function release(key: string) { controls.current?.keys.delete(key); }
  const movement = [
    { key: 'w', name: 'Walk forward', icon: ArrowUp },
    { key: 'a', name: 'Step left', icon: ArrowLeft },
    { key: 's', name: 'Walk backward', icon: ArrowDown },
    { key: 'd', name: 'Step right', icon: ArrowRight }
  ];
  return createPortal(<div className="walk-album walk-coast" role="dialog" aria-modal="true" aria-label={title + ' immersive scene'} ref={dialog}
    onKeyDown={keyDown} onKeyUp={event => {
      if (event.key !== ' ') controls.current?.keys.delete(event.key.toLowerCase());
    }}>
    <div className="walk-canvas" ref={host} tabIndex={0} aria-label="First-person scene. WASD to move, arrow keys to turn, drag to look, E to open a nearby waypoint."
      onBlur={() => controls.current?.keys.clear()} />
    <div className="walk-vignette" />
    <header className="walk-header">
      <div className="walk-brand">everwhere<span>Immersive gameplay</span></div>
      <div className="walk-header-actions">
        <button onClick={() => setHelp(true)}>Controls</button>
        <button className="walk-exit" aria-label="Exit scene" onClick={onClose}><X size={16} /> <span>Exit scene</span></button>
        {notifications && <div className="walk-notifications" onFocusCapture={() => controls.current?.keys.clear()}
          onPointerDownCapture={() => controls.current?.keys.clear()}>{notifications}</div>}
      </div>
    </header>
    {phase === 'ready' && <RuntimeTools runtime={controls.current?.runtime ?? null} contextURL={contextURL} focus={() => host.current?.focus()} />}
    <section className="walk-mission" aria-label="Scene progress">
      <span className="walk-kicker">Designed coastal scene</span>
      <h1>{title}</h1>
      {sources.length > 0 && <>
        <p>{complete ? 'You explored every waypoint.' : 'Follow the lit markers or jump to a waypoint.'}</p>
        <div className="walk-progress" aria-hidden="true"><span style={{ width: (visitedCount / sources.length * 100) + '%' }} /></div>
        <span className="walk-count" aria-live="polite">{visitedCount} / {sources.length} waypoints visited</span>
      </>}
    </section>
    {phase === 'ready' && <>
      <div className="walk-reticle" aria-hidden="true" />
      <div className="walk-dock">
        {sources.length > 0 && <>
          <div className="walk-interact">
            {cue ? <button className="walk-next-action" onClick={canOpenNearby ? inspect : nextWaypoint}>
              {canOpenNearby ? <kbd aria-hidden="true">E</kbd> : <MapPin size={19} />}
              <span><strong>{cueLabel}</strong><small>{cue.caption}</small></span><ArrowRight size={18} />
            </button> : <span className="walk-direction">Choose a waypoint on the map to revisit it.</span>}
            {nearby && !canOpenNearby && <button className="walk-reopen" onClick={inspect}>Reopen this waypoint</button>}
          </div>
          <nav className="walk-map" aria-label="Scene map">
            <div className="walk-map-title"><Compass size={14} /><span>Waypoints</span><span>N</span></div>
            <div className="walk-map-ground">
              <div className="walk-map-path" />
              {stops.map((stop, index) => <button key={stop.sourceId} className={'walk-map-stop' + (visited.includes(stop.sourceId) ? ' visited' : '')}
                title={'Go to ' + sources[index].caption} aria-label={'Go to waypoint ' + (index + 1) + ', ' + sources[index].caption}
                aria-current={nearby?.id === stop.sourceId ? 'location' : undefined}
                style={{ left: (50 + stop.x * 7) + '%', top: ((stop.z - end) / (10 - end) * 82 + 7) + '%' }}
                onClick={() => goToWaypoint(index)}>{visited.includes(stop.sourceId) ? <Check size={10} /> : index + 1}</button>)}
              <span className="walk-map-player" aria-label="Your position" style={{ left: (50 + frame.x * 7) + '%', top: ((frame.z - end) / (10 - end) * 82 + 7) + '%', transform: `translate(-50%,-50%) rotate(${-frame.yaw}rad)` } as CSSProperties} />
            </div>
            {complete && sources.length > 1 && <button className="walk-next" onClick={nextWaypoint}>Next waypoint <ArrowRight size={14} /></button>}
          </nav>
        </>}
        <div className="walk-movement" aria-label="Movement controls">
          {movement.map(({ key, name, icon: Icon }) => <button className={'walk-key-' + key} key={key} aria-label={name}
            onPointerDown={event => hold(event, key)} onPointerUp={() => release(key)} onPointerCancel={() => release(key)}
            onLostPointerCapture={() => release(key)}
            onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); controls.current?.keys.add(key); } }}
            onKeyUp={() => release(key)} onBlur={() => release(key)}><Icon size={19} /></button>)}
          <div className="walk-touch-actions">
            <button onPointerDown={event => hold(event, 'shift')} onPointerUp={() => release('shift')}
              onPointerCancel={() => release('shift')} onLostPointerCapture={() => release('shift')}
              onKeyDown={event => { if (['Enter', ' '].includes(event.key)) controls.current?.keys.add('shift'); }}
              onKeyUp={() => release('shift')} onBlur={() => release('shift')}>Sprint</button>
            <button onClick={() => controls.current?.keys.add(' ')}>Jump</button>
          </div>
        </div>
      </div>
      <footer className="walk-footer"><span><kbd>W A S D</kbd> move <kbd>Shift</kbd> sprint <kbd>Space</kbd> jump <span>Drag to look</span></span><span>Designed coast · {frame.environment ? <a href="https://polyhaven.com" target="_blank" rel="noreferrer">Poly Haven lighting &amp; materials</a> : 'Base materials'}</span></footer>
    </>}
    {phase !== 'ready' && <div className="walk-overlay walk-loading" role="status"><div>
      <Compass size={30} /><h2>{phase === 'loading' ? 'Opening the scene…' : 'This scene could not open'}</h2>
      {phase === 'error' && <><p>Try a browser with WebGL enabled.</p><button className="walk-primary" onClick={onClose}>Return to Everwhere</button></>}
    </div></div>}
    {inspected && <div className="walk-overlay"><article className="walk-photo">
      <button className="walk-photo-close" aria-label="Close waypoint" onClick={() => setInspectedId(null)}><X size={20} /></button>
      <div className="walk-photo-image">{imageFailed ? <p role="alert">The source image for this waypoint could not load.</p> :
        <img key={inspected.id} src={sourceURL(state.projectId, inspected.id)} alt={inspected.caption} onError={() => setImageFailed(true)} />}</div>
      <div className="walk-photo-copy"><span className="walk-kicker">{inspected.provenance === 'imagined' ? 'Imagined demo' : 'Original photograph'}</span>
        <h2>{inspected.caption}</h2><p className="walk-photo-meta">{displayDate(inspected.capturedAt || memory?.startAt)}{memory?.placeLabel && ' · ' + memory.placeLabel}</p>
        {memory?.story && <p>{memory.story}</p>}
        {recollections.map(item => <blockquote key={item.id}>{item.text}<cite>{item.contributor} · Recollection</cite></blockquote>)}
        <div className="walk-help-actions"><button className="walk-primary" onClick={() => setInspectedId(null)}>Continue exploring <ArrowRight size={16} /></button>
          {onWaypoint && <button onClick={() => onWaypoint(inspected.id, [frame.x, frame.y, frame.z])}><MapPin size={16} /> Save viewpoint</button>}
        </div>
      </div>
    </article></div>}
    {help && <div className="walk-overlay"><section className="walk-help">
      <button className="walk-photo-close" aria-label="Close controls" onClick={() => setHelp(false)}><X size={20} /></button>
      <Compass size={28} /><h2>Explore the coast</h2>
      <p>Walk along the waterfront and open a waypoint to discover its story. The coast is a designed environment.</p>
      <dl><dt>Walk or strafe</dt><dd>W A S D or the on-screen arrows</dd><dt>Look around</dt><dd>Drag the scene or use the left and right arrow keys.</dd><dt>Sprint or jump</dt><dd>Hold Shift to sprint. Press Space to jump.</dd><dt>Open a waypoint</dt><dd>Press E near a marker or tap Open waypoint.</dd><dt>Jump to a waypoint</dt><dd>Choose one on the map.</dd><dt>Close or exit</dt><dd>Press Escape.</dd></dl>
      <p className="walk-help-note">Waypoint visits are remembered in this browser. Original sources and recollections stay linked to their memory.</p>
      <div className="walk-help-actions"><button onClick={() => { controls.current?.reset(); setHelp(false); }}><RotateCcw size={16} /> Return to entrance</button><button className="walk-primary" onClick={() => setHelp(false)}>Keep exploring</button></div>
    </section></div>}
  </div>, document.body);
}
