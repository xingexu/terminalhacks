import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, BookOpen, Box, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, Compass, Eye, Image, Map, MapPin, Play, Plus, Upload, X
} from 'lucide-react';
import {
  displayDate, isVisual, sourceURL, sourcesFor, type Lens, type Memory, type Snapshot, type Source, type View, type World
} from './model';
import { orderedPhotos } from './album-layout';
import { updateScenePointer, useScenePalette } from './scene';
import { art, AsciiArt, AsciiImage, AsciiMap } from './ascii';
import './gameplay-launcher.css';

const Spatial = lazy(() => import('./spatial'));
const Scan = lazy(() => import('./scan'));
const CoastalScene = lazy(() => import('./album'));

export type ViewActions = {
  select: (input: { eventId?: string; anchorId?: string; view?: View }) => void;
  openSource: (source: Source) => void;
  openCapture: () => void;
  openMap: () => void;
  openMemory: () => void;
  openRecollection: () => void;
  addWaypoint: (position: [number, number, number], sourceId?: string, worldId?: string) => void;
  approve: (world: World) => void;
  openSettings: () => void;
  openWorld: () => void;
  openGeneration: () => void;
  undo: () => void;
};

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty">{icon}<h3>{title}</h3>{children}</div>;
}

function Thumb({ project, source, className = '' }: { project: string; source?: Source; className?: string }) {
  return source ? <img className={className} src={sourceURL(project, source.id, '?variant=thumb')} alt="" loading="lazy" /> :
    <span className={'thumb-empty ' + className}><AsciiArt art={art.frame} /></span>;
}

function MediaPicture({ project, source, className }: { project: string; source?: Source; className: string }) {
  return <span className={className} onPointerMove={updateScenePointer}>
    <Thumb project={project} source={source} className="media-base" />
    {source && <Thumb project={project} source={source} className="media-reveal" />}
  </span>;
}

export function Timeline({ state, event, actions }: { state: Snapshot; event?: Memory; actions: ViewActions }) {
  return <section className="timeline">
    <div className="section-heading"><h2>Journey timeline</h2><div className="button-row">
      <button className="btn compact subtle" onClick={actions.openMap}><Map size={15} /> View map</button>
      <button className="btn compact" onClick={actions.openMemory}><Plus size={15} /> New memory</button></div></div>
    {state.events.length ? <div className="timeline-grid">
      {state.events.map(memory => {
        const source = sourcesFor(state, memory.sourceIds).find(isVisual);
        const active = memory.id === event?.id;
        return <button key={memory.id} className={'timeline-card' + (active ? ' active' : '')} onClick={() => actions.select({ eventId: memory.id })} aria-current={active ? 'step' : undefined}>
          <MediaPicture project={state.projectId} source={source} className="timeline-picture" />
          <span className="timeline-copy"><span className="timeline-date">{displayDate(memory.startAt, true)}</span><strong>{memory.title}</strong>
            <span className="timeline-place">{memory.placeLabel}</span></span>
          {active && <span className="active-dot" aria-hidden="true" />}
        </button>;
      })}
    </div> : <button className="btn" onClick={actions.openMemory}><Plus size={16} /> Add your first memory</button>}
  </section>;
}

type SceneEntry = { eventId: string; lens: Lens; worldId: string | null };

export function Explore({ state, event, actions, startPlaying = false, startInWorkspace = false, notifications, onDiscover }: {
  state: Snapshot; event?: Memory; actions: ViewActions; startPlaying?: boolean; startInWorkspace?: boolean;
  notifications?: ReactNode; onDiscover?: (source: Source) => void;
}) {
  const activeEvent = event?.id;
  const lens = state.session.lens;
  const trailId = 'trail-' + activeEvent;
  const [entry, setEntry] = useState<SceneEntry | null>(() =>
    startPlaying && state.demo && activeEvent ? { eventId: activeEvent, lens, worldId: null } : null);
  const [showStory, setShowStory] = useState(false);
  const storyId = useId();
  const handledNavigation = useRef(startInWorkspace || startPlaying ? state.session.anchorNavigationId : null);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const storyAction = useRef<HTMLButtonElement>(null);
  const closeWorldFocus = useRef(false);
  const worldFrame = useRef<HTMLDivElement>(null);

  const selectedAnchor = state.anchors.find(item => item.id === state.session.anchorId && item.eventId === activeEvent);
  const media = sourcesFor(state, event?.sourceIds ?? []).filter(isVisual);
  const photos = orderedPhotos(media);
  const originalPhoto = photos.some(source => source.provenance === 'original');
  const anchors = state.anchors.filter(item => item.eventId === activeEvent && item.worldId === trailId &&
    item.sourceIds.length > 0 && item.sourceIds.every(id => media.some(source => source.id === id)));
  const anchor = anchors.find(item => item.id === selectedAnchor?.id) ?? anchors[0];
  const active = sourcesFor(state, anchor?.sourceIds ?? []).find(isVisual) ?? media[0];
  const sceneSources = (scene: World) => scene.sourceIds.every(id => event?.sourceIds.includes(id));
  const worlds = state.worlds.filter(item => item.eventId === activeEvent && item.approved && item.status !== 'stale' &&
    lens === 'all' && sceneSources(item));
  const preferredWorld = worlds.at(-1);
  const navigableWorldId = worlds.find(item => item.id === selectedAnchor?.worldId)?.id;
  const currentEntry = entry?.eventId === activeEvent && entry?.lens === lens ? entry : null;
  const playingWorld = worlds.find(item => item.id === currentEntry?.worldId);
  const alternateWorlds = worlds.filter(item => item.id !== (playingWorld ?? preferredWorld)?.id);
  const playingCoast = currentEntry?.worldId === null;
  const openScene = Boolean(playingWorld || playingCoast);
  const paletteSource = (playingWorld && sourcesFor(state, playingWorld.sourceIds).find(isVisual)) || active;
  const palette = useScenePalette(paletteSource && sourceURL(state.projectId, paletteSource.id, '?variant=thumb'), openScene);

  useEffect(() => {
    setShowStory(false);
  }, [activeEvent, lens, state.session.anchorId]);
  useEffect(() => {
    setEntry(current => current && (current.eventId !== activeEvent || current.lens !== lens) ? null : current);
  }, [activeEvent, lens]);
  useEffect(() => {
    const navigation = state.session.anchorNavigationId;
    if (!activeEvent || !navigation || navigation === handledNavigation.current) return;
    handledNavigation.current = navigation;
    if (selectedAnchor?.worldId === trailId) setEntry({ eventId: activeEvent, lens, worldId: null });
    else if (navigableWorldId) setEntry({ eventId: activeEvent, lens, worldId: navigableWorldId });
  }, [activeEvent, lens, state.session.anchorNavigationId, selectedAnchor?.worldId, trailId, navigableWorldId]);
  useEffect(() => {
    if (playingWorld?.id) worldFrame.current?.focus();
    else if (closeWorldFocus.current) {
      closeWorldFocus.current = false;
      primaryAction.current?.focus();
    }
  }, [playingWorld?.id]);

  if (!event) return <section className="view-explore gameplay-launcher">
    <Empty icon={<AsciiArt art={art.compass} />} title="Start with a memory">
      <p>Add a memory to take a first-person walk. You can attach photos after you start.</p>
      <button className="btn primary" onClick={actions.openMemory}><Plus size={17} /> Add a memory</button>
    </Empty>
  </section>;

  function play(worldId: string | null) {
    if (!activeEvent) return;
    setShowStory(false);
    setEntry({ eventId: activeEvent, lens, worldId });
  }
  function closeWorld() {
    closeWorldFocus.current = true;
    setEntry(null);
  }
  function closeStory() {
    setShowStory(false);
    storyAction.current?.focus();
  }

  const accounts = state.recollections.filter(item => item.eventId === event.id && (!item.anchorId || item.anchorId === anchor?.id));
  const memoryIndex = state.events.findIndex(memory => memory.id === event.id);
  const nextMemory = (offset: number) => {
    const next = state.events[memoryIndex + offset];
    if (next) actions.select({ eventId: next.id });
  };
  const pendingScene = state.worlds.find(item => item.eventId === event.id && !item.approved && item.status !== 'stale' && sceneSources(item));
  const latestJob = state.sceneJobs?.find(job => job.eventId === event.id);
  const sceneJob = latestJob?.status === 'ready' ? undefined : latestJob;
  const generating = sceneJob && ['queued', 'interpreting', 'building'].includes(sceneJob.status);
  const jobStatus = sceneJob?.status === 'queued' ? 'Scene generation queued' :
    sceneJob?.status === 'interpreting' ? 'Interpreting your photo' :
    sceneJob?.status === 'building' ? 'Building your scene' : 'Scene needs attention';
  const previewUrl = active && sourceURL(state.projectId, active.id, '?variant=thumb');
  const playLabel = preferredWorld?.format === 'glb' ? 'Walk in scene' : preferredWorld ? 'Enter world' : 'Play scene';
  const sceneType = preferredWorld?.generation ? 'AI reconstruction' : preferredWorld ? 'Imported 3D world' : 'Designed coastal scene';
  const sceneSummary = preferredWorld?.format === 'glb' ? 'Walk through the approved reconstruction of this place.' :
    preferredWorld ? 'Explore the approved reconstruction from different viewpoints.' :
    photos.length ? 'Walk a fictional coast and discover the photos linked to this memory.' : 'Take a first-person walk along a fictional coast.';

  return <section className={'view-explore gameplay-launcher' + (openScene ? ' is-scene-open' : '')} style={palette}>
    <div className="explore-stage">
      {playingCoast && <Suspense fallback={<div className="notice" role="status">Opening the scene…</div>}>
        <CoastalScene key={state.projectId + ':' + event.id + ':' + lens + ':' + photos.map(photo => photo.id).join(',')}
          state={state} photos={photos} title={event.title} onClose={() => setEntry(null)}
          notifications={notifications} onDiscover={onDiscover}
          onWaypoint={(sourceId, position) => actions.addWaypoint(position, sourceId)} />
      </Suspense>}
      {playingWorld ? <div className="spatial-frame" ref={worldFrame} tabIndex={-1} role="region" aria-label={playingWorld.title}
        onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) closeWorld(); }}>
        <Suspense fallback={<div className="spatial-state" role="status">Loading the 3D scene…</div>}>
          {playingWorld.format === 'glb' ? <Scan key={playingWorld.id}
            url={'/v1/projects/' + state.projectId + '/worlds/' + playingWorld.id + '/scene.glb'}
            projectId={state.projectId} eventId={event.id} worldId={playingWorld.id} revision={state.revision}
            generation={playingWorld.generation} position={selectedAnchor?.worldId === playingWorld.id ? selectedAnchor.position : undefined}
            anchors={state.anchors.filter(item => item.worldId === playingWorld.id)}
            selectedAnchor={selectedAnchor?.worldId === playingWorld.id ? selectedAnchor : undefined}
            recollections={state.recollections} onSelectAnchor={anchorId => actions.select({ anchorId })} onRecollect={actions.openRecollection}
            notifications={notifications} onClose={closeWorld} onWaypoint={position => actions.addWaypoint(position, playingWorld.sourceIds[0], playingWorld.id)} /> :
            <Spatial key={playingWorld.id} url={'/v1/projects/' + state.projectId + '/worlds/' + playingWorld.id + '/scene.spz'}
              position={selectedAnchor?.worldId === playingWorld.id ? selectedAnchor.position : undefined}
              notifications={notifications} onClose={closeWorld} onWaypoint={position => actions.addWaypoint(position, playingWorld.sourceIds[0], playingWorld.id)} />}
        </Suspense>
        <div className="spatial-waypoints" aria-label="Scene waypoints">
          {state.anchors.filter(item => item.worldId === playingWorld.id).map(item =>
            <button className="btn compact" key={item.id} onClick={() => actions.select({ anchorId: item.id })}><MapPin size={14} />{item.title}</button>)}
          {selectedAnchor?.worldId === playingWorld.id && <button className="btn compact" onClick={actions.openRecollection}><BookOpen size={15} /> Add a recollection here</button>}
        </div>
      </div> : <div className={'hero gameplay-hero' + (previewUrl ? '' : ' hero-empty')} onPointerMove={updateScenePointer}>
        {previewUrl && <>
          <AsciiImage key={previewUrl} src={previewUrl} focusY={0.55} />
          <img className="hero-img" src={previewUrl} alt={active.caption} />
          <img className="hero-img hero-reveal" src={previewUrl} alt="" aria-hidden="true" />
        </>}
        <div className="hero-shade" />
        <div className="hero-top">
          <div className="hero-badges">
            <span className="glass-pill"><Compass size={14} /> {sceneType}</span>
            {active?.provenance === 'imagined' && <span className="scene-sample">Illustrated sample</span>}
          </div>
          {active && <button className="glass-icon" aria-label="View source media" title="View source media" onClick={() => actions.openSource(active)}><Eye size={17} /></button>}
        </div>
        <div className="hero-bottom">
          <div className="hero-content">
            <h2>{event.title}</h2>
            <div className="hero-location"><MapPin size={15} /> {event.placeLabel}</div>
            <p className="gameplay-summary">{sceneSummary}</p>
            <button ref={primaryAction} className="btn hero-cta" onClick={() => play(preferredWorld?.id ?? null)}><Play size={17} fill="currentColor" /> {playLabel}</button>
          </div>
        </div>
      </div>}
      {!playingWorld && <>
        <div className="gameplay-browse-bar">
          <button ref={storyAction} className="btn subtle" aria-expanded={showStory} aria-controls={storyId} onClick={() => setShowStory(!showStory)}>
            <BookOpen size={17} /> Memory story <ChevronDown size={16} />
          </button>
          {state.events.length > 1 && <div className="gameplay-browse-arrows" role="group" aria-label="Browse memories">
            <button className="btn subtle" onClick={() => nextMemory(-1)} disabled={memoryIndex <= 0} aria-label="Previous memory"><ChevronLeft size={19} /></button>
            <button className="btn subtle" onClick={() => nextMemory(1)} disabled={memoryIndex >= state.events.length - 1} aria-label="Next memory"><ChevronRight size={19} /></button>
          </div>}
        </div>
        <section id={storyId} className="gameplay-story" hidden={!showStory}>
          <div className="panel-title"><h3>{anchor?.title || event.title}</h3><button className="icon-btn" onClick={closeStory} aria-label="Close memory story"><X size={16} /></button></div>
          <p>{event.story || 'Add a recollection about this memory.'}</p>
          {accounts.map(item => <blockquote key={item.id}>{item.text}</blockquote>)}
          <div className="button-row">
            {active && <button className="btn compact" onClick={() => actions.openSource(active)}><Image size={14} /> View source</button>}
            <button className="btn compact" onClick={actions.openRecollection}><Plus size={14} /> Add recollection</button>
          </div>
        </section>
      </>}
      {!playingWorld && (sceneJob || pendingScene || originalPhoto || !state.demo) && <section className="gameplay-setup" aria-label="Reconstruction setup">
        {pendingScene && <div className="gameplay-setup-row gameplay-setup-status">
          <div><h3>Reconstruction ready for review</h3><p>Review and approve the scene to make it playable.</p></div>
          <button className="btn" onClick={() => actions.approve(pendingScene)}><Check size={16} /> Approve reconstruction</button>
        </div>}
        {sceneJob && <div className="gameplay-setup-row gameplay-setup-status">
          <div role="status"><h3>{jobStatus}</h3><p>{sceneJob.error || (generating ? 'You can keep exploring while it runs.' : 'Open the job to see what happened.')}</p></div>
          <button className="btn" onClick={actions.openGeneration}>Scene details</button>
        </div>}
        <div className="gameplay-setup-row">
          <div><h3>{preferredWorld ? 'Add another reconstruction' : 'Recreate this place'}</h3>
            <p>{originalPhoto ? 'Build from a linked photo or import an existing GLB or SPZ file.' : 'Link an original photo of this place before generating or importing a scene.'}</p></div>
          <div className="button-row">
            {originalPhoto ? <>
              {!sceneJob && <button className="btn" onClick={actions.openGeneration}><Box size={16} /> Generate from a photo</button>}
              <button className="btn subtle" onClick={actions.openWorld}><Upload size={16} /> Import 3D scene</button>
            </> : <button className="btn" onClick={actions.openCapture}><Camera size={16} /> Add source photos</button>}
          </div>
        </div>
      </section>}
      {alternateWorlds.length > 0 && <details className="gameplay-worlds">
        <summary>Other approved scenes <ChevronDown size={17} /></summary>
        <div className="button-row">{alternateWorlds.map(item =>
          <button key={item.id} className="btn" onClick={() => play(item.id)}><Box size={16} /> Enter {item.title}</button>)}</div>
      </details>}
    </div>
    <Timeline state={state} event={event} actions={actions} />
  </section>;
}

const degrees = (value: number, positive: string, negative: string) => Math.abs(value).toFixed(2) + '° ' + (value < 0 ? negative : positive);

export function MemoryMap({ state, actions }: { state: Snapshot; actions: ViewActions }) {
  const located = state.events.filter(memory => memory.gps);
  if (!located.length) return <Empty icon={<AsciiArt art={art.map} />} title="No confirmed map locations"><p>Add coordinates when you create a memory to place it on the map.</p></Empty>;
  const lats = located.map(item => item.gps![0]);
  const lons = located.map(item => item.gps![1]);
  const dist = Math.max(0.05, Math.max(...lats) - Math.min(...lats), Math.max(...lons) - Math.min(...lons));
  const latCenter = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lonCenter = (Math.min(...lons) + Math.max(...lons)) / 2;
  const points = located.map(memory => ({ memory, x: 50 + (memory.gps![1] - lonCenter) * 76 / dist, y: 50 - (memory.gps![0] - latCenter) * 74 / dist }));
  return <div className="map-view">
    <div className="map-canvas" aria-label="Schematic map of confirmed memory locations">
      <AsciiMap points={points} />
      <div className="map-north" aria-hidden="true">^ N</div>
      {points.map(({ memory, x, y }, i) => <button key={memory.id} className={'map-point' + (memory.id === state.session.eventId ? ' selected' : '')}
        style={{ left: x + '%', top: y + '%' }} title={memory.title} aria-label={'Explore ' + memory.title}
        onClick={() => actions.select({ eventId: memory.id, view: 'explore' })}><span>{i + 1}</span></button>)}
    </div>
    <p className="map-caption"><span>Schematic map · The line follows memory order.</span>
      <span>{degrees(Math.min(...lats), 'N', 'S')} to {degrees(Math.max(...lats), 'N', 'S')} · {degrees(Math.min(...lons), 'E', 'W')} to {degrees(Math.max(...lons), 'E', 'W')}</span></p>
    <div className="map-legend">{points.map(({ memory }, i) => <button className="btn compact" key={memory.id} onClick={() => actions.select({ eventId: memory.id, view: 'explore' })}>
      <span>{i + 1}.</span>{memory.title}</button>)}</div>
  </div>;
}

export function Archive({ state, event, actions, initialMap = false }: { state: Snapshot; event?: Memory; actions: ViewActions; initialMap?: boolean }) {
  const [tab, setTab] = useState(initialMap ? 'map' : 'revisions');
  useEffect(() => { if (initialMap) setTab('map'); }, [initialMap]);
  return <div className="view-stack">
    <div className="section-heading page-section"><h2>Memory archive</h2>
      <button className="btn" onClick={actions.openSettings}>Project settings</button></div>
    <div className="tab-set" aria-label="Archive views">{[['revisions', 'Revisions'], ['map', 'Map']].map(([key, label]) =>
      <button key={key} className={key === tab ? 'selected' : ''} aria-pressed={key === tab} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === 'map' && <MemoryMap state={state} actions={actions} />}
    {tab === 'revisions' && <section className="surface"><div className="section-heading"><h3>Revision {state.revision}</h3>
      <button className="btn compact" disabled={!state.undo} onClick={actions.undo}><ArrowLeft size={15} /> Undo last change</button></div>
      {state.history.map(item => <div className="result-row" key={item.revision}><strong>{item.label}</strong><span>{displayDate(item.at, true)} · Rev {item.revision}</span></div>)}
      {!state.history.length && <p className="muted">Confirmed edits will appear here.</p>}</section>}
    <Timeline state={state} event={event} actions={actions} />
  </div>;
}
