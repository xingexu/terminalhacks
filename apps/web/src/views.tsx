import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Box, Camera, Check, ChevronLeft, ChevronRight, CircleHelp,
  Clapperboard, Compass, Eye, Film, Image, MapPin, Maximize, Pause, Play, Plus, Search, Sparkles, X
} from 'lucide-react';
import {
  api, artifactURL, displayDate, isVisual, sourceURL, sourcesFor,
  type Anchor, type Job, type Memory, type Profile, type SearchResult, type Snapshot, type Source, type View, type World
} from './model';

import { updateScenePointer, useScenePalette } from './scene';
import { art, AsciiArt, AsciiImage } from './ascii';

const Spatial = lazy(() => import('./spatial'));
const Scan = lazy(() => import('./scan'));
const WalkableAlbum = lazy(() => import('./album'));
import { orderedPhotos } from './album-layout';

export type ViewActions = {
  select: (input: { eventId?: string; anchorId?: string; view?: View }) => void;
  openSource: (source: Source) => void;
  openCapture: () => void;
  openMemory: () => void;
  openCorrection: () => void;
  openRecollection: () => void;
  addWaypoint: (position: [number, number, number], sourceId?: string, worldId?: string) => void;
  render: () => void;
  approve: (job: Job | World) => void;
  setGrade: (profile: Profile) => void;
  openWorld: () => void;
  openGeneration: () => void;
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

function MediaGrid({ state, sources, open }: { state: Snapshot; sources: Source[]; open: ViewActions['openSource'] }) {
  return <div className="media-grid">{sources.map(source =>
    <button className="media-card" key={source.id} onClick={() => open(source)}>
      <div className="media-image" onPointerMove={updateScenePointer}>
        <Thumb project={state.projectId} source={source} className="media-base" />
        <Thumb project={state.projectId} source={source} className="media-reveal" />
        {source.mime.startsWith('video/') && <span className="media-play"><Play size={17} fill="currentColor" /></span>}
      </div>
      <div className="media-meta"><strong>{source.caption}</strong><span>{source.provenance === 'imagined' ? 'Imagined demo' : 'Original'}</span></div>
    </button>)}</div>;
}

export function Timeline({ state, event, actions }: { state: Snapshot; event?: Memory; actions: ViewActions }) {
  return <section className="timeline">
    <div className="section-heading"><h2>Journey timeline</h2>
      <button className="btn compact" onClick={actions.openMemory}><Plus size={15} /> New memory</button></div>
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

export function Explore({ state, event, actions }: { state: Snapshot; event?: Memory; actions: ViewActions }) {
  const [entered, setEntered] = useState(false);
  const [showStory, setShowStory] = useState(false);
  const [spatial, setSpatial] = useState<string | null>(null);
  const activeEvent = event?.id;
  const selectedAnchor = state.anchors.find(item => item.id === state.session.anchorId);
  useEffect(() => {
    setEntered(Boolean(state.session.anchorNavigationId && selectedAnchor?.worldId === 'trail-' + activeEvent));
    setShowStory(false);
  }, [state.session.anchorNavigationId, activeEvent, state.session.lens]);
  const worlds = state.worlds.filter(item => item.eventId === activeEvent && item.approved && item.status !== 'stale' && state.session.lens === 'all' &&
    item.sourceIds.every(id => event?.sourceIds.includes(id)));
  const world = worlds.find(item => item.id === spatial) ?? worlds.at(-1);
  useEffect(() => { setSpatial(worlds.some(item => item.id === selectedAnchor?.worldId) ? selectedAnchor!.worldId : null); },
    [activeEvent, selectedAnchor?.worldId, state.session.lens]);
  if (!event) return <Empty icon={<AsciiArt art={art.compass} />} title="Start with a place you remember">
    <p>Give a moment a name, then add the photos and stories you want to keep.</p>
    <button className="btn primary" onClick={actions.openMemory}><Plus size={17} /> Add a memory</button>
  </Empty>;
  const media = sourcesFor(state, event.sourceIds).filter(isVisual);
  const photos = orderedPhotos(media);
  const anchors = state.anchors.filter(anchor => anchor.eventId === event.id && anchor.worldId === 'trail-' + event.id && anchor.sourceIds.some(id => media.some(source => source.id === id)));
  const anchor = anchors.find(item => item.id === state.session.anchorId) ?? anchors[0];
  const active = sourcesFor(state, anchor?.sourceIds ?? []).find(isVisual) ?? media[0];
  const index = state.events.findIndex(memory => memory.id === event.id);
  const accounts = state.recollections.filter(item => item.eventId === event.id && (!item.anchorId || item.anchorId === anchor?.id));
  const next = (distance: number) => {
    const candidate = anchors[anchors.findIndex(item => item.id === anchor?.id) + distance];
    if (candidate) actions.select({ anchorId: candidate.id });
    else {
      const neighbor = state.events[index + distance];
      if (neighbor) actions.select({ eventId: neighbor.id });
    }
  };
  function openAlbum() {
    setEntered(true);
    setShowStory(false);
  }
  const pendingWorld = state.worlds.find(item => item.eventId === event.id && !item.approved && item.status !== 'stale' &&
    item.sourceIds.every(id => event.sourceIds.includes(id)));
  return <section className="view-explore">
    <div className="explore-stage">
    {entered && photos.length > 0 && <Suspense fallback={<div className="notice" role="status">Opening immersive album…</div>}>
      <WalkableAlbum key={state.projectId + event.id + state.session.lens + photos.map(photo => photo.id).join(',')}
        state={state} photos={photos} title={event.title} onClose={() => setEntered(false)}
        onWaypoint={(sourceId, position) => actions.addWaypoint(position, sourceId)} />
    </Suspense>}
    {spatial && world?.id === spatial ? <div className="spatial-frame">
      <Suspense fallback={<div className="spatial-state">Loading 3D viewer…</div>}>
        {world.format === 'glb' ? <Scan url={'/v1/projects/' + state.projectId + '/worlds/' + spatial + '/scene.glb'}
          projectId={state.projectId} eventId={event.id} worldId={world.id} revision={state.revision}
          generation={world.generation} position={selectedAnchor?.worldId === spatial ? selectedAnchor.position : undefined}
          anchors={state.anchors.filter(item => item.worldId === spatial)}
          selectedAnchor={selectedAnchor?.worldId === spatial ? selectedAnchor : undefined}
          recollections={state.recollections} onSelectAnchor={anchorId => actions.select({ anchorId })} onRecollect={actions.openRecollection}
          onClose={() => setSpatial(null)} onWaypoint={position => actions.addWaypoint(position, world.sourceIds[0], spatial)} /> :
        <Spatial url={'/v1/projects/' + state.projectId + '/worlds/' + spatial + '/scene.spz'}
          position={selectedAnchor?.worldId === spatial ? selectedAnchor.position : undefined}
          onClose={() => setSpatial(null)} onWaypoint={position => actions.addWaypoint(position, world.sourceIds[0], spatial)} />}
      </Suspense>
      <div className="spatial-waypoints">
        {state.anchors.filter(item => item.worldId === spatial).map(item =>
          <button className="btn compact" key={item.id} onClick={() => actions.select({ anchorId: item.id })}><MapPin size={14} />{item.title}</button>)}
        {selectedAnchor?.worldId === spatial && <button className="btn compact" onClick={actions.openRecollection}><BookOpen size={15} /> Add a recollection here</button>}
      </div>
    </div> : <div className={'hero grade-' + state.visualProfile + (active ? '' : ' hero-empty')} onPointerMove={updateScenePointer}>
      {active && <>
        <AsciiImage key={'ascii-' + active.id} src={sourceURL(state.projectId, active.id, '?variant=thumb')} focusY={0.55} />
        <img className="hero-img" key={active.id} src={sourceURL(state.projectId, active.id, '?variant=thumb')} alt={active.caption} />
        <img className="hero-img hero-reveal" src={sourceURL(state.projectId, active.id, '?variant=thumb')} alt="" aria-hidden="true" />
      </>}
      <div className="hero-shade" />
      <div className="hero-top"><div className="hero-badges"><span className="glass-pill"><Compass size={14} /> {photos.length} {photos.length === 1 ? 'photo' : 'photos'} to explore</span>
        {active?.provenance === 'imagined' && <span className="scene-sample">Imagined demo</span>}</div>
        <div className="hero-top-actions">
          {active && <button className="glass-icon" aria-label="View source media" title="View source media" onClick={() => actions.openSource(active)}><Eye size={17} /></button>}
          <button className="glass-icon" aria-label="Enter immersive album" title="Enter immersive album" onClick={openAlbum} disabled={!photos.length}><Maximize size={16} /></button>
        </div>
      </div>
      {showStory && <aside className="hotspot-panel"><div className="panel-title"><strong>{anchor?.title || event.title}</strong><button className="icon-btn" onClick={() => setShowStory(false)} aria-label="Close waypoint"><X size={16} /></button></div>
        <p>{event.story || 'Add a recollection about this waypoint.'}</p>
        {accounts.map(item => <blockquote key={item.id}>{item.text}</blockquote>)}
        <div className="button-row">
          {active && <button className="btn compact" onClick={() => actions.openSource(active)}><Image size={14} /> Source</button>}
          <button className="btn compact" onClick={actions.openRecollection}><Plus size={14} /> Add recollection</button>
        </div></aside>}
      <div className="hero-bottom">
        <div className="hero-content">
          <h2>{event.title}</h2>
          <div className="hero-location"><MapPin size={15} /> {event.placeLabel}{anchor && <><span className="dot-separator" /> {anchor.title}</>}</div>
          <div className="button-row">
            <button className="btn hero-cta" onClick={actions.openGeneration}><Box size={17} /> Step inside this photo <ArrowRight size={16} /></button>
            {photos.length > 0 ? <button className="btn hero-cta" onClick={openAlbum}><Compass size={17} /> Enter photo album <ArrowRight size={16} /></button> :
              <button className="btn hero-cta" onClick={actions.openCapture}><Camera size={16} /> Add photos</button>}
            {active && <button className="glass-icon" aria-label="Waypoint story" onClick={() => setShowStory(!showStory)}><BookOpen size={17} /></button>}
          </div>
        </div>
        <div className="hero-controls">
          <div className="waypoint-list">{anchors.map(a => <button className={'waypoint' + (a.id === anchor?.id ? ' selected' : '')} key={a.id} onClick={() => actions.select({ anchorId: a.id })}><MapPin size={12} />{a.title}</button>)}</div>
          <div className="hero-controls-row">
            <button className="glass-icon" onClick={() => next(-1)} disabled={index === 0 && (!anchors.length || anchors[0]?.id === anchor?.id)} aria-label="Previous waypoint or memory"><ChevronLeft size={19} /></button>
            <button className="glass-icon" onClick={() => next(1)} disabled={index >= state.events.length - 1 && (!anchors.length || anchors.at(-1)?.id === anchor?.id)} aria-label="Next waypoint or memory"><ChevronRight size={19} /></button>
          </div>
        </div>
      </div>
    </div>}
    {(state.sceneJobs ?? []).filter(job => job.eventId === event.id && job.status !== 'ready').slice(0, 1).map(job =>
      <div className="notice" role="status" key={job.id}><Box size={18} /><div><strong>{job.status === 'interpreting' ? 'Interpreting your photo' : job.status === 'building' ? 'Building your scene in Higgsfield' : job.status === 'queued' ? 'Scene generation queued' : 'Scene needs attention'}</strong>
        <p>{job.error || 'You can continue browsing while the scene is prepared.'}</p><button className="btn compact" onClick={actions.openGeneration}>Scene details</button></div></div>)}
    {(pendingWorld || world || media.some(item => item.provenance === 'original' && item.mime.startsWith('image/'))) && <div className="world-actions button-row">
      {worlds.map(item => item.id !== spatial && <button key={item.id} className="btn compact" onClick={() => setSpatial(item.id)}><Box size={15} /> {item.format === 'glb' ? 'Walk in ' : 'Explore '}{item.title}</button>)}
      {pendingWorld && <button className="btn compact" onClick={() => actions.approve(pendingWorld)}><Check size={15} /> Approve reconstruction</button>}
      {media.some(item => item.provenance === 'original' && item.mime.startsWith('image/')) && <button className="btn compact subtle" onClick={actions.openWorld}><Plus size={15} /> Import 3D scene</button>}
    </div>}
    </div>
    <Timeline state={state} event={event} actions={actions} />
  </section>;
}

export function Watch({ state, event, actions }: { state: Snapshot; event?: Memory; actions: ViewActions }) {
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const media = event ? sourcesFor(state, event.sourceIds).filter(isVisual) : [];
  const source = media[frame % (media.length || 1)];
  useEffect(() => { setFrame(0); setPlaying(false); }, [event?.id, state.session.lens]);
  useEffect(() => {
    if (!playing || !media.length) return;
    const timer = window.setInterval(() => setFrame(value => (value + 1) % media.length), 4800);
    return () => window.clearInterval(timer);
  }, [playing, media.length]);
  const jobs = state.jobs.filter(item => item.eventId === event?.id && item.lens === state.session.lens);
  const current = jobs.find(item => ['queued', 'running', 'ready'].includes(item.status));
  const filmReady = current?.status === 'ready';
  const showVideo = filmReady && current.approved;
  const rendering = current?.status === 'queued' || current?.status === 'running';
  const image = source && sourceURL(state.projectId, source.id, '?variant=thumb');
  const palette = useScenePalette(image, filmReady || rendering || playing);
  const status = filmReady ? (showVideo ? 'Your film is ready to watch' : 'Film ready for approval') :
    current?.status === 'queued' ? 'Film queued' : 'Rendering your film';
  return <div className={'view-stack view-watch grade-' + state.visualProfile + (filmReady ? ' is-film-ready' : '') +
    (rendering ? ' is-film-rendering' : '') + (playing ? ' is-storyboard-playing' : '')} style={palette}>
    <div className="section-heading page-section"><h2>Films from your memories</h2>
      {!current && !!media.length && <button className="btn primary" onClick={actions.render}><Clapperboard size={17} />
        {jobs[0]?.status === 'stale' ? 'Render updated film' : jobs[0] ? 'Try rendering again' : 'Create film'}</button>}</div>
    {showVideo && current ? <div className="film-stage"><video controls playsInline preload="metadata" src={artifactURL(state.projectId, current.id)} poster={source && sourceURL(state.projectId, source.id, '?variant=thumb')}>
      <track default kind="captions" label="English captions" srcLang="en" src={artifactURL(state.projectId, current.id, 'captions')} />
    </video></div> : source ? <div className="film-stage film-preview" onPointerMove={updateScenePointer}>
      {image && <AsciiImage key={image} src={image} />}
      <Thumb project={state.projectId} source={source} className="film-preview-img" />
      <Thumb project={state.projectId} source={source} className="film-preview-img film-reveal" />
      <span className="glass-pill film-tag"><Film size={14} /> Storyboard preview</span>
      <button className="film-play" aria-label={playing ? 'Pause storyboard' : 'Play storyboard'} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={29} fill="currentColor" /> : <Play size={29} fill="currentColor" />}</button>
      <div className="film-caption"><strong>{event?.title}</strong><span>{source.caption} · {source.provenance === 'imagined' ? 'Imagined demo' : 'Original source'}</span></div>
    </div> : <Empty icon={<AsciiArt art={art.film} />} title="Your film starts with a source"><p>Link a photo or video to this memory.</p><button className="btn" onClick={actions.openCapture}>Add sources</button></Empty>}
    <div className="film-status" role="status">
      {current && <div className="notice render-notice"><Film size={19} /><div><strong>{status}</strong>
        <p>{filmReady ? 'Saved from memory revision ' + current.revision + '.' : 'You can keep exploring while the film is prepared.'}</p></div>
        {filmReady && (showVideo ? <a className="btn compact" href={artifactURL(state.projectId, current.id) + '?download=1'}><ArrowDownToLine size={16} /> Download MP4</a> :
          <button className="btn compact primary" onClick={() => actions.approve(current)}><Check size={16} /> Approve film</button>)}</div>}
      {!current && jobs[0] && <div className="notice"><CircleHelp size={18} /><p>{jobs[0].status === 'stale' ? 'This memory changed. Render an updated film to use the current sources.' : jobs[0].error || 'This film is unavailable.'}</p></div>}
    </div>
    {media.length > 0 && <><div className="section-heading"><h2>Storyboard</h2><span className="muted">{media.length} {media.length === 1 ? 'source' : 'sources'}</span></div>
      <div className="storyboard">{media.map((item, index) => <button className={'storyboard-card' + (source?.id === item.id ? ' selected' : '')}
        key={item.id} aria-pressed={showVideo ? undefined : source?.id === item.id}
        onClick={() => showVideo ? actions.openSource(item) : setFrame(index)}><Thumb project={state.projectId} source={item} /><span>{item.caption}</span></button>)}</div></>}
  </div>;
}

const profiles: { id: Profile; name: string; description: string }[] = [
  { id: 'natural', name: 'Natural', description: 'True-to-source color' },
  { id: 'nostalgic', name: 'Nostalgic', description: 'Warm, soft highlights' },
  { id: 'documentary', name: 'Documentary', description: 'Cooler, restrained color' },
  { id: 'vivid', name: 'Vivid', description: 'Stronger color and contrast' }
];

function PhotoAlbum({ state, event, actions }: { state: Snapshot; event?: Memory; actions: ViewActions }) {
  const [scope, setScope] = useState<'memory' | 'project'>('memory');
  const [excluded, setExcluded] = useState<string[]>([]);
  const [entered, setEntered] = useState(false);
  const sourceIds = scope === 'memory' ? event?.sourceIds || [] : [...new Set(state.events.flatMap(memory => memory.sourceIds))];
  const photos = orderedPhotos(sourcesFor(state, sourceIds));
  const selected = photos.filter(photo => !excluded.includes(photo.id));
  const title = scope === 'project' ? state.title : event?.title || 'Photo album';
  useEffect(() => { setExcluded([]); setEntered(false); }, [scope]);
  return <section className="photo-album">
    <div className="album-toolbar">
      <label>Include <select aria-label="Album scope" value={scope} onChange={e => setScope(e.target.value as 'memory' | 'project')}>
        <option value="memory">This memory</option><option value="project">Whole project</option>
      </select></label>
      {photos.length > 0 && <button className="text-button" onClick={() => setExcluded(selected.length === photos.length ? photos.map(photo => photo.id) : [])}>
        {selected.length === photos.length ? 'Deselect all' : 'Select all'}</button>}
    </div>
    {photos.length ? <>
      <div className="album-launch">
        <div><span className="eyebrow">Immersive photo album</span><h3>{title}</h3><p>{selected.length} photos selected · Ordered by capture date</p></div>
        <button className="btn primary" disabled={!selected.length} onClick={() => setEntered(true)}><Compass size={18} /> Enter album <ArrowRight size={16} /></button>
      </div>
      <p className="album-instruction">Choose photos for your walk. Open a photo to view its original source.</p>
      <div className="media-grid">{photos.map(photo => <div className={'media-card album-card' + (excluded.includes(photo.id) ? ' excluded' : '')} key={photo.id}>
        <button className="album-source" onClick={() => actions.openSource(photo)} aria-label={'View ' + photo.caption}>
          <MediaPicture project={state.projectId} source={photo} className="media-image" />
          <div className="media-meta"><strong>{photo.caption}</strong><span>{photo.provenance === 'imagined' ? 'Imagined demo' : 'Original'} · {displayDate(photo.capturedAt, true)}</span></div>
        </button>
        <button className="album-check" aria-label={'Include ' + photo.caption} aria-pressed={!excluded.includes(photo.id)}
          onClick={() => setExcluded(previous => previous.includes(photo.id) ? previous.filter(id => id !== photo.id) : [...previous, photo.id])}>
          {!excluded.includes(photo.id) && <Check size={16} />}
        </button>
      </div>)}</div>
    </> : <Empty icon={<AsciiArt art={art.photo} />} title="Your album starts with a photo"><p>Add photos in Capture, then review and confirm their memory links.</p><button className="btn" onClick={actions.openCapture}>Add photos</button></Empty>}
    {entered && selected.length > 0 && <Suspense fallback={<div className="notice" role="status">Opening immersive album…</div>}>
      <WalkableAlbum key={state.projectId + state.session.lens + selected.map(photo => photo.id).join(',')} state={state} photos={selected} title={title} onClose={() => setEntered(false)} />
    </Suspense>}
  </section>;
}

export function Create({ state, event, actions }: { state: Snapshot; event?: Memory; actions: ViewActions }) {
  const [tab, setTab] = useState<'photos' | 'clips' | 'journal'>('photos');
  const [compare, setCompare] = useState(false);
  const [openAlbum, setOpenAlbum] = useState<string | null>(null);
  const items = event ? sourcesFor(state, event.sourceIds) : [];
  const media = items.filter(source => source.mime.startsWith(tab === 'photos' ? 'image/' : 'video/'));
  const first = items.find(source => source.mime.startsWith('image/'));
  const rec = state.recollections.filter(item => item.eventId === event?.id);
  const albumKey = event?.id + ':' + tab;
  const albumAvailable = tab !== 'journal' && media.length > 0;
  const albumOpen = albumAvailable && openAlbum === albumKey;
  const albumCover = media[0] && sourceURL(state.projectId, media[0].id, '?variant=thumb');
  const palette = useScenePalette(albumCover, albumOpen);
  const chooseTab = (next: typeof tab) => {
    if (next !== tab) setOpenAlbum(null);
    setTab(next);
  };
  return <div className={'view-stack view-create grade-' + (compare ? 'natural' : state.visualProfile) + (albumOpen ? ' is-album-open' : '')} style={palette}>
    <div className="section-heading page-section"><h2>Memory studio</h2>
      <button className="btn" onClick={actions.openCapture}><Plus size={17} /> Add media</button></div>
    <div className="studio-toolbar"><div className="tab-set" aria-label="Studio views">
      <button className={tab === 'photos' ? 'selected' : ''} aria-pressed={tab === 'photos'} onClick={() => chooseTab('photos')}><Image size={16} /> Photo album</button>
      <button className={tab === 'clips' ? 'selected' : ''} aria-pressed={tab === 'clips'} onClick={() => chooseTab('clips')}><Film size={16} /> Video album</button>
      <button className={tab === 'journal' ? 'selected' : ''} aria-pressed={tab === 'journal'} onClick={() => chooseTab('journal')}><BookOpen size={16} /> Journal</button></div>
      {albumAvailable && <div className="studio-actions button-row">
        <button className={'btn compact' + (albumOpen ? '' : ' primary')} onClick={() => setOpenAlbum(albumOpen ? null : albumKey)}>
          {albumOpen ? 'Close album' : 'Open album'}
        </button>
        <button className="btn compact" aria-pressed={compare} onClick={() => { setOpenAlbum(albumKey); setCompare(!compare); }}><Eye size={15} /> {compare ? 'Show grade' : 'Compare ungraded'}</button>
      </div>}
    </div>
    {tab === 'photos' ? <PhotoAlbum key={state.projectId + event?.id + state.session.lens} state={state} event={event} actions={actions} /> : tab === 'journal' ? event ? <article className="journal">
      <span className="eyebrow">{displayDate(event.startAt)} · {event.placeLabel}</span><h2>{event.title}</h2>
      {event.story && <p>{event.story}</p>}
      {rec.map(item => <blockquote key={item.id}>{item.text}<cite>{item.contributor} · Recollection</cite></blockquote>)}
      <div className="journal-sources">{items.map(item => <button className="btn compact" key={item.id} onClick={() => actions.openSource(item)}><Image size={14} /> {item.caption}</button>)}</div>
      <div className="button-row"><button className="btn" onClick={actions.openRecollection}><Plus size={16} /> Add recollection</button><button className="btn" onClick={actions.openCorrection}>Correct memory</button></div>
    </article> : <Empty icon={<AsciiArt art={art.book} />} title="No journal entries yet" /> :
      media.length ? <MediaGrid state={state} sources={media} open={actions.openSource} /> :
        <Empty icon={<AsciiArt art={art.film} />} title="No videos in this view">
          <p>Select an item from your camera roll and review it in Capture.</p><button className="btn" onClick={actions.openCapture}>Add a source</button>
        </Empty>}
    <div className="section-heading"><h2>Visual DNA</h2><span className="muted">One grade across your experience</span></div>
    <div className="grade-grid">{profiles.map(profile => <button className={'grade-card grade-' + profile.id + (state.visualProfile === profile.id ? ' selected' : '')}
      key={profile.id} onClick={() => state.visualProfile !== profile.id && actions.setGrade(profile.id)} aria-pressed={state.visualProfile === profile.id} disabled={!event}>
      <Thumb project={state.projectId} source={first} /><span><strong>{profile.name}</strong><small>{profile.description}</small></span>
      {state.visualProfile === profile.id && <Check size={16} />}
    </button>)}</div>
  </div>;
}

export function Remember({ state, event, actions }: { state: Snapshot; event?: Memory; actions: ViewActions }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [question, setQuestion] = useState<{ question: string; sourceIds: string[] } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const accounts = state.recollections.filter(item => item.eventId === event?.id);
  useEffect(() => {
    let ignore = false;
    setQuestion(null);
    if (event) api<{ question: string; sourceIds: string[] }>('/projects/' + state.projectId + '/gaps?eventId=' + event.id)
      .then(value => { if (!ignore) setQuestion(value); }).catch(() => {});
    return () => { ignore = true; };
  }, [event?.id, state.projectId, state.revision, state.session.lens]);
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = query.trim();
    if (!value || searching) return;
    setError('');
    setSearching(true);
    try { setResults(await api('/projects/' + state.projectId + '/search?q=' + encodeURIComponent(value))); }
    catch (err) { setError(String((err as Error).message)); }
    finally { setSearching(false); }
  };
  return <div className="view-stack view-remember">
    <div className="section-heading page-section"><h2>What do you remember?</h2>
      <button className="btn primary" onClick={actions.openRecollection} disabled={!event}><Plus size={16} /> Add a recollection</button></div>
    <form className="search-bar" onSubmit={search}><Search size={19} /><input ref={searchInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search places, captions, and memories" aria-label="Search your memories" required /><button className="btn compact" type="submit" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</button></form>
    {error && <div className="notice" role="alert">{error}</div>}
    {results && <section className="surface"><div className="section-heading"><h3>Matching sources</h3><button className="icon-btn" onClick={() => { setResults(null); setQuery(''); searchInput.current?.focus(); }} aria-label="Clear search"><X size={18} /></button></div>
      {!results.length && <p className="muted">No matching sources. Try a location or a word from the caption.</p>}
      {results.map(result => {
        const item = state.media.find(value => value.id === result.mediaId);
        if (!item) return null;
        return <div className="result-row" key={result.mediaId}><button className="text-button" onClick={() => actions.openSource(item)}>{result.caption}</button><span>{result.reason}</span>
          {result.eventId && <button className="icon-btn" aria-label="Select matching memory" onClick={() => actions.select({ eventId: result.eventId! })}><ArrowRight size={17} /></button>}</div>;
      })}</section>}
    {event && <div className="storyroom-grid">
      <section className="surface"><span className="eyebrow">{displayDate(event.startAt)}</span><h3 className="serif">{event.title}</h3>
        {event.story && <p>{event.story}</p>}{accounts.length === 0 && <p className="muted">Recollections you confirm appear here.</p>}
        {accounts.map(item => <article className="account" key={item.id}><span className="eyebrow">{item.contributor} · Recollected</span><p>{item.text}</p>
          {item.audioMediaId && <audio controls src={sourceURL(state.projectId, item.audioMediaId)} />}</article>)}
        <button className="btn compact" onClick={actions.openCorrection}>Correct memory</button>
      </section>
      {question && <section className="surface story-prompt"><span className="eyebrow"><Sparkles size={14} /> STORY PROMPT</span><h3 className="serif">{question.question}</h3>
        <div className="prompt-sources">{sourcesFor(state, question.sourceIds).map(item => <button key={item.id} onClick={() => actions.openSource(item)} aria-label={item.caption}><Thumb project={state.projectId} source={item} /></button>)}</div>
        <button className="btn" onClick={actions.openRecollection}><AudioLines size={16} /> Add your account</button></section>}
    </div>}
    <Timeline state={state} event={event} actions={actions} />
  </div>;
}
