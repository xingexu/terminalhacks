import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Box, Camera, ChevronDown, ChevronRight,
  CircleHelp, Compass, Feather, Film, Fingerprint, Images, LockKeyhole, MapPin, Mic, Plus, Settings, X
} from 'lucide-react';
import '@fontsource-variable/dm-sans';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './style.css';
import './experience.css';
import './ascii.css';
import { Tour, type TourAction } from './onboarding';
import { VoicePanel } from './voice';
import { Capture } from './capture';
import { GenerationForm } from './generation';
import { Create, Explore, Remember, Watch, type ViewActions } from './views';
import { art, AsciiArt, AsciiSpinner } from './ascii';
import {
  api, displayDate, isVisual, localDateTime, sourceURL, type Command, type Memory, type Observation, type Project, type Proposal,
  type Session, type Snapshot, type Source, type View
} from './model';

const nav = [
  { id: 'explore', name: 'Explore', icon: Compass },
  { id: 'remember', name: 'Remember', icon: BookOpen },
  { id: 'watch', name: 'Watch', icon: Film },
  { id: 'create', name: 'Create', icon: Feather }
] as const;

type Dialog =
  { kind: 'library' | 'settings' | 'voice' | 'capture' | 'memory' | 'recollection' | 'correction' | 'help' | 'world' } |
  { kind: 'generate'; eventId: string } |
  { kind: 'source'; source: Source } |
  { kind: 'confirm'; proposal: Proposal; revision: number; command?: Command; film?: boolean; fromCapture?: boolean };

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('#dialog-title')?.focus(); }, [title]);
  return <dialog ref={ref} className={'modal' + (wide ? ' modal-wide' : '')} aria-labelledby="dialog-title"
    onCancel={e => { e.preventDefault(); onClose(); }} onPointerDown={e => {
      if (e.target !== ref.current) return;
      const bounds = e.currentTarget.getBoundingClientRect();
      if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) onClose();
    }}>
    <div className="modal-inner"><div className="modal-head"><h2 id="dialog-title" tabIndex={-1}>{title}</h2>
      <button className="icon-btn" onClick={onClose} aria-label="Close dialog"><X size={21} /></button></div>{children}</div>
  </dialog>;
}

function EventForm({ event, name, onSubmit }: { event?: Memory; name: string; onSubmit: (body: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title')).trim();
    const place = String(form.get('place') || '').trim();
    const date = String(form.get('date') || '');
    const story = String(form.get('story') || '').trim();
    setBusy(true);
    setError('');
    try {
      const originalClock = localDateTime(event?.startAt);
      const startAt = date === originalClock && event ? event.startAt : date ? new Date(date).toISOString() : null;
      if (event) {
        const values = { title, ...(place && { placeLabel: place }), startAt, ...(story && { story }) };
        const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => event[key as keyof Memory] !== value));
        if (!Object.keys(patch).length) throw new Error('Change a field before previewing the correction.');
        await onSubmit({ patch });
      } else {
        await onSubmit({ title, placeLabel: place || undefined, startAt, gps: null });
      }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <form className="form-stack" onSubmit={submit}>
    <label>Memory title<input name="title" required maxLength={180} defaultValue={event?.title} placeholder="A moment worth remembering" /></label>
    <div className="form-columns"><label>Place<input name="place" maxLength={180} defaultValue={event?.placeLabel} placeholder="Unknown location" /></label>
      <label>Date and time<input type="datetime-local" name="date" defaultValue={localDateTime(event?.startAt)} /></label></div>
    {event && <label>Story<textarea name="story" rows={4} maxLength={4000} defaultValue={event.story} /></label>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="btn primary self-start" disabled={busy}>{name} <ArrowRight size={16} /></button>
  </form>;
}

function NameForm({ handle }: { handle: (title: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="form-stack new-project" onSubmit={async e => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get('title')).trim();
    setBusy(true); setError('');
    try { await handle(title); } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }}><label>New project<input name="title" placeholder="Give your project a name" maxLength={120} required /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="btn primary self-start" disabled={busy}><Plus size={17} /> Create private project</button></form>;
}

function RecollectionForm({ onSubmit, onCapture, anchor }: { onSubmit: (text: string) => Promise<void>; onCapture: () => void; anchor?: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <form className="form-stack" onSubmit={async e => {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get('text')).trim();
    if (!text) return;
    setBusy(true); setError('');
    try { await onSubmit(text); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }}><p className="muted">Your account is stored with attribution{anchor ? ' at ' + anchor : ''}.</p>
    <label>What do you remember?<textarea rows={5} maxLength={4000} name="text" required placeholder="In your own words…" /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="button-row"><button className="btn primary" disabled={busy}>Preview recollection <ArrowRight size={16} /></button>
      <button className="btn" type="button" onClick={onCapture}><Mic size={16} /> Record a voice note</button></div>
  </form>;
}

function Confirmation({ value, commit, back }: { value: Extract<Dialog, { kind: 'confirm' }>; commit: (requestId: string) => Promise<void>; back: () => void }) {
  const requestId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const diff = value.proposal.diff;
  const showValue = (field: unknown) => {
    if (typeof field === 'object' && field !== null) return Object.entries(field).map(([key, value]) =>
      <span key={key}><strong>{{ placeLabel: 'Place', startAt: 'Date', title: 'Title', story: 'Story' }[key] || key}</strong> {String(value ?? 'Unknown')}</span>);
    return <span>{String(field ?? 'Unknown')}</span>;
  };
  return <div className="form-stack">
    <div className="notice"><Fingerprint size={20} /><div><strong>{diff.label}</strong><p>Based on revision {value.revision}</p></div></div>
    {diff.before !== undefined && <div className="diff"><div><small>Previous</small>{showValue(diff.before)}</div><div><small>Proposed</small>{showValue(diff.after)}</div></div>}
    {diff.text && <blockquote>{diff.text}</blockquote>}
    {diff.caption && <p>Source: {diff.caption}</p>}
    {value.film && <p>{diff.sources} visual {diff.sources === 1 ? 'source' : 'sources'} · 30–60 seconds · local render{diff.narration ? ' · includes a confirmed voice note' : ''}{diff.containsImagined ? ' · includes labeled imagined demo imagery' : ''}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="button-row"><button className="btn primary" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await commit(requestId.current); } catch (err) { setError((err as Error).message); }
      finally { setBusy(false); }
    }}>{value.film ? 'Start render' : 'Confirm change'} <ArrowRight size={16} /></button>
      <button className="btn" onClick={back}>Cancel</button></div>
  </div>;
}

function WorldForm({ state, event, base, done }: { state: Snapshot; event: Memory; base: string; done: () => Promise<void> }) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sources = state.media.filter(item => event.sourceIds.includes(item.id) && item.mime.startsWith('image/') && item.provenance === 'original');
  return <form className="form-stack" onSubmit={async e => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get('scene');
    if (!(file instanceof File) || !file.size || !consent) return;
    setBusy(true); setError('');
    try {
      const upload = new FormData(); upload.append('file', file);
      const query = new URLSearchParams({ sourceId: String(form.get('source')), consent: '1', expectedRevision: String(state.revision) });
      await api(base + '/memories/' + event.id + '/worlds?' + query, upload);
      await done();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }}><p className="muted">Upload a GLB mesh from a LiDAR or photogrammetry scan to walk on its actual surfaces, or an SPZ splat to explore its viewpoints. Link an original photo of the scanned place, then approve the import.</p>
    <label>Original source<select name="source" required>{sources.map(item => <option key={item.id} value={item.id}>{item.caption}</option>)}</select></label>
    <label>3D scene<input type="file" name="scene" accept=".spz,.glb" required /></label>
    <p className="muted">GLB exports need embedded textures, meter units, Y-up orientation, and at most 250,000 triangles. Upload limit 48 MB.</p>
    <label className="check-row"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
      <span>I have permission to use this reconstruction and the selected photo documents this place.</span></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="btn primary self-start" disabled={!consent || busy || !sources.length}><Box size={16} /> {busy ? 'Uploading…' : 'Import reconstruction'}</button>
  </form>;
}

function SettingsPanel({ base, state, reload, deleteProject }: { base: string; state: Snapshot; reload: () => void; deleteProject: () => Promise<void> }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const perform = async (task: () => Promise<unknown>, after = reload) => {
    setBusy(true); setError('');
    try { await task(); after(); setConfirm(''); } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="form-stack"><div className="notice"><LockKeyhole size={20} /><div><strong>Private project</strong><p>Project access is tied to this browser session. Capture processing stays on the Everwhere server.</p></div></div>
    <h3>Capture permissions</h3>
    {!state.capture.sessions.length && <p className="muted">No capture sessions have been started.</p>}
    {state.capture.sessions.filter(item => item.status !== 'revoked').map(item => <div className="result-row" key={item.id}>
      <strong>{item.source === 'browser_audio' ? 'Voice note' : item.source === 'voiceos_text' ? 'VoiceOS text' : 'Selected files'} · {item.status}</strong>
      <button className="btn compact" disabled={busy} onClick={() => setConfirm(item.grantId)}>Revoke</button>
      {confirm === item.grantId && <div className="permission-confirm"><p>Withdraw the sources captured in this session and make dependent films unavailable?</p>
        <button className="btn compact danger" onClick={() => perform(() => api(base + '/capture/grants/' + item.grantId + '/revoke', {}))} disabled={busy}>Withdraw sources</button></div>}
    </div>)}
    <hr />
    {confirm === 'delete' ? <div className="form-stack"><p>Delete this project, its private sources, and all hosted exports?</p>
      <button className="btn danger self-start" disabled={busy} onClick={() => perform(deleteProject, () => {})}>Permanently delete project</button></div> :
      <button className="btn danger self-start" onClick={() => setConfirm('delete')}>Delete project</button>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState('');
  const [state, setState] = useState<Snapshot | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [items, setItems] = useState<Observation[]>([]);
  const [notice, setNotice] = useState('');
  const [startupError, setStartupError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tour, setTour] = useState<number | null>(null);
  const ref = useRef('');
  const earlyRoute = useRef<View | null>(null);
  const tabs = useRef<HTMLElement>(null);
  const base = '/projects/' + project;
  const current = state?.events.find(item => item.id === state.session.eventId) ?? state?.events[0];

  const loadProjects = useCallback(async () => {
    const list = await api<Project[]>('/bootstrap');
    setProjects(list);
    return list;
  }, []);
  const chooseProject = useCallback((id: string) => {
    ref.current = id;
    setProject(id);
    setState(null);
    setItems([]);
    setStartupError('');
    if (id) localStorage.setItem('everwhere-project', id);
    else {
      localStorage.removeItem('everwhere-project');
      history.replaceState(null, '', '/app');
    }
  }, []);
  useEffect(() => {
    loadProjects().then(list => {
      const [, p, id, view] = location.pathname.split('/');
      const requested = p === 'p' && list.some(item => item.id === id) ? id : '';
      if (requested && nav.some(item => item.id === view)) earlyRoute.current = view as View;
      const last = localStorage.getItem('everwhere-project');
      chooseProject(requested || list.find(item => item.id === last)?.id || list[0]?.id || '');
      const returnEvent = new URLSearchParams(location.search).get('generate');
      if (returnEvent) setDialog({ kind: 'generate', eventId: returnEvent });
      else setTour(0);
      if (returnEvent) history.replaceState(null, '', location.pathname);
    }).catch(err => setStartupError((err as Error).message)).finally(() => setLoading(false));
  }, [chooseProject, loadProjects]);

  const refresh = useCallback(async () => {
    if (!project) return;
    const [fresh, inbox] = await Promise.all([api<Snapshot>(base + '/snapshot'), api<Observation[]>(base + '/capture/inbox')]);
    if (ref.current !== project) return;
    setState(old => old && old.projectId === project && old.seq > fresh.seq ? old : fresh);
    setItems(inbox);
  }, [base, project]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const load = async () => {
      try {
        const view = earlyRoute.current;
        earlyRoute.current = null;
        await api(base + '/session', { lens: 'all', ...(view && { view }) });
        await refresh();
      } catch (err) { if (!cancelled) setStartupError((err as Error).message); }
    };
    void load();
    const events = new EventSource('/v1' + base + '/events');
    events.onmessage = event => {
      if (JSON.parse(event.data).kind !== 'project.deleted') void refresh().catch(() => {});
    };
    const timer = window.setInterval(() => { if (events.readyState !== EventSource.OPEN) void refresh().catch(() => {}); }, 4000);
    return () => { cancelled = true; events.close(); window.clearInterval(timer); };
  }, [project, base, refresh]);

  useEffect(() => {
    if (!state || state.projectId !== project) return;
    // Sessions saved before Universe and Archive were removed fall back to Explore.
    const target = '/p/' + project + '/' + (nav.find(item => item.id === state.session.view) ?? nav[0]).id;
    if (location.pathname !== target) history.replaceState(null, '', target);
    document.title = 'Everwhere · ' + state.title;
  }, [project, state]);
  // On a phone the menu scrolls sideways; keep the current one in sight without moving the page.
  const activeView = state?.session.view;
  useEffect(() => {
    const bar = tabs.current;
    const active = bar?.querySelector<HTMLElement>('.active');
    if (!bar || !active) return;
    // The highlight slides to the current view instead of jumping.
    bar.style.setProperty('--pill-x', active.offsetLeft + 'px');
    bar.style.setProperty('--pill-w', active.offsetWidth + 'px');
    if (active.offsetLeft < bar.scrollLeft) bar.scrollLeft = active.offsetLeft - 8;
    else if (active.offsetLeft + active.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = active.offsetLeft + active.offsetWidth - bar.clientWidth + 8;
  }, [activeView]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const show = (kind: Extract<Dialog, { kind: 'library' | 'settings' | 'voice' | 'capture' | 'memory' | 'recollection' | 'correction' | 'help' | 'world' }>['kind']) => setDialog({ kind });
  const dismiss = () => {
    setDialog(null);
  };
  const guarded = (work: () => Promise<unknown>) => { void work().catch(err => setNotice((err as Error).message)); };
  const select = (input: Partial<Session>) => guarded(async () => { await api(base + '/session', input); await refresh(); });
  const openView = (view: View) => {
    select({ view });
    window.scrollTo(0, 0);
  };
  const preview = async (type: string, payload: Record<string, unknown>, target = current?.id) => {
    if (!state || !target) throw new Error('Select a memory to continue.');
    const command = { type, targetId: target, expectedRevision: state.revision, payload };
    const proposal = await api<Proposal>(base + '/previews', command);
    setDialog({ kind: 'confirm', proposal, command, revision: state.revision });
  };
  const actions: ViewActions = {
    select,
    openSource: source => setDialog({ kind: 'source', source }),
    openCapture: () => show('capture'),
    openMemory: () => show('memory'),
    openCorrection: () => show('correction'),
    openRecollection: () => show('recollection'),
    addWaypoint: (position, sourceId, worldId) => guarded(() => preview('anchor.add', { position, worldId: worldId ?? 'trail-' + current?.id, sourceIds: sourceId ? [sourceId] : [] })),
    render: () => guarded(async () => {
      const proposal = await api<Proposal>(base + '/film-preview', { eventId: current?.id, expectedRevision: state?.revision });
      setDialog({ kind: 'confirm', proposal, film: true, revision: state!.revision });
    }),
    approve: job => guarded(() => preview('artifact.approve', { artifactId: job.id, dependencyHash: job.inputHash })),
    setGrade: preset => guarded(() => preview('profile.set', { preset })),
    openWorld: () => show('world'),
    openGeneration: () => { if (current) setDialog({ kind: 'generate', eventId: current.id }); }
  };

  // The tour's buttons press the same controls the user would.
  const runTour = (action: TourAction) => {
    if (!state) show('library');
    else if (action === 'generate') current ? actions.openGeneration() : show('memory');
    else show(action);
  };
  const currentNav = nav.find(item => item.id === state?.session.view) ?? nav[0];
  const screen = currentNav.id;
  const currentAnchor = state?.anchors.find(item => item.id === state.session.anchorId && item.eventId === current?.id);
  const hasMedia = state && !!project;
  const captureOpen = dialog?.kind === 'capture' || (dialog?.kind === 'confirm' && !!dialog.fromCapture);
  // "Originals only" can empty a memory whose pictures are all illustrated; say so instead of showing blank frames.
  const memoryPictures = state && current ? state.media.filter(item => current.sourceIds.includes(item.id) && isVisual(item)) : [];
  const hiddenByLens = state?.session.lens === 'originals' ? memoryPictures.filter(item => item.provenance !== 'original').length : 0;
  const lensHidesAll = hiddenByLens > 0 && hiddenByLens === memoryPictures.length;
  const dateLabel = state?.demo && state.events.length ? 'October 12–14, 2024' : current?.startAt ? displayDate(current.startAt) : '';
  const sectionTitles: Record<Dialog['kind'], string> = {
    library: 'Projects', settings: 'Project settings', voice: 'Connect VoiceOS', capture: 'Capture memory',
    memory: 'New memory', recollection: 'Add a recollection', correction: 'Correct memory',
    help: 'Welcome to Everwhere', source: 'Source evidence', confirm: 'Review change', world: 'Import 3D scene', generate: 'Step inside your photo'
  };
  return <div className="app-frame">
    <a className="skip-link" href="#experience">Skip to experience</a>
    <header className="menubar">
      <a className="brand" href="/" aria-label="Everwhere home"><span className="brand-mark"><AsciiArt art={art.mark} /></span><img className="brand-logo" src="/landing/everwhere-logo.webp" alt="Everwhere" width="480" height="174" /></a>
      <button className="workspace-project" onClick={() => show('library')} aria-label={'Switch project, current project ' + (state?.title || 'Projects')}><span className="project-icon"><Images size={17} /></span><strong>{state?.title || 'Projects'}</strong><ChevronDown size={15} /></button>
      <nav className="menu" aria-label="Views" ref={tabs}>{nav.map(({ id, name, icon: Icon }) =>
        <button key={id} className={screen === id ? 'active' : ''} aria-current={screen === id ? 'page' : undefined}
          onClick={() => openView(id)} disabled={!state}><Icon size={17} />{name}</button>)}</nav>
      <div className="menu-actions">
        <button className="btn compact subtle menu-voice" onClick={() => show('voice')} disabled={!state} aria-label="Connect VoiceOS"><AudioLines size={16} /> <span>VoiceOS</span></button>
        <button className="btn top-capture" onClick={() => state ? show('capture') : show('library')}><Camera size={17} /> <span>{state ? <>Capture<span className="capture-word"> memory</span></> : 'Projects'}</span>{items.length > 0 && <span className="pending-count" aria-label={items.length + ' pending sources'}>{items.length}</span>}</button>
        <button className="icon-btn" onClick={() => setTour(0)} aria-label="Open tutorial" title="Open tutorial"><CircleHelp size={18} /></button>
      </div>
    </header>
    <main className={'main screen-' + screen} id="experience" tabIndex={-1}>
      {startupError && <div className="notice main-notice" role="alert">{startupError}<button className="btn compact" onClick={() => location.reload()}>Retry</button></div>}
      {!startupError && (loading || (!state && project)) && <div className="load-state" role="status"><AsciiSpinner /> Opening your universe…</div>}
      {!loading && !state && !project && <div className="load-state"><AsciiArt art={art.universe} /><h1>Every life is a world.</h1><button className="btn primary" onClick={() => show('library')}><Plus size={17} /> Create a project</button></div>}
      {state && <div className="main-content">
        <div className="project-head"><div>
          <h1>{state.title}</h1>
          <div className="project-details">{dateLabel && <span>{dateLabel}</span>}{dateLabel && current && <span className="dot-separator" />}
            {current && <span><MapPin size={14} />{state.demo ? 'The Italian Alps' : current.placeLabel}</span>}
            {!!state.events.length && <><span className="dot-separator" /><span>{state.events.length} {state.events.length === 1 ? 'memory' : 'memories'}</span></>}
          </div></div>
        </div>
        {lensHidesAll && <div className="notice lens-notice" role="status"><Fingerprint size={18} /><div><strong>Originals only is on</strong>
          <p>{hiddenByLens} {hiddenByLens === 1 ? 'picture in this memory is illustrated or imagined, so it is' : 'pictures in this memory are illustrated or imagined, so they are'} hidden.</p></div>
          <button className="btn compact" onClick={() => select({ lens: 'all' })}>Show all pictures</button></div>}
        {screen === 'explore' && <Explore state={state} event={current} actions={actions} />}
        {screen === 'watch' && <Watch state={state} event={current} actions={actions} />}
        {screen === 'create' && <Create state={state} event={current} actions={actions} />}
        {screen === 'remember' && <Remember state={state} event={current} actions={actions} />}
      </div>}
    </main>
    {tour !== null && <Tour step={tour} setStep={setTour} close={() => setTour(null)} view={screen} paused={!!dialog} ready={!!state} go={openView} run={runTour} />}
    {notice && <aside className="toast" role="status">{notice}<button className="icon-btn" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={17} /></button></aside>}
    {dialog && <Modal key={captureOpen ? 'capture' : dialog.kind} title={sectionTitles[dialog.kind]} onClose={dismiss} wide={captureOpen || dialog.kind === 'source'}>
      {dialog.kind === 'library' && <><p className="muted">Open a project or start a private collection.</p>
        <div className="library-list">{projects.map(item => <button className="workspace-project" key={item.id} onClick={() => { if (item.id !== project) chooseProject(item.id); dismiss(); }}>
          <span className="project-icon"><Images size={17} /></span><span><strong>{item.title}</strong><small>{item.demo ? 'Sample project' : 'Private project'}</small></span><ChevronRight size={17} /></button>)}</div>
        {state && <button className="btn compact subtle self-start library-settings" onClick={() => show('settings')}><Settings size={15} /> Settings for {state.title}</button>}
        <NameForm handle={async title => { const created = await api<Project>('/projects', { title }); await loadProjects(); chooseProject(created.id); dismiss(); }} /></>}
      {hasMedia && state && dialog.kind === 'settings' && <SettingsPanel state={state} base={base} reload={() => void refresh().catch(() => {})} deleteProject={async () => {
        await api(base, { confirm: true }, 'DELETE'); const list = await loadProjects(); chooseProject(list[0]?.id || ''); dismiss();
      }} />}
      {hasMedia && state && dialog.kind === 'voice' && <VoicePanel base={base} state={state} />}
      {state && dialog.kind === 'generate' && state.events.filter(event => event.id === dialog.eventId).map(event => <GenerationForm key={event.id} state={state} event={event}
        done={async () => { await refresh(); dismiss(); setNotice('Scene generation started. Progress appears in Explore.'); }} />)}
      {state && current && dialog.kind === 'world' && <WorldForm state={state} event={current} base={base}
        done={async () => { await refresh(); dismiss(); setNotice('Reconstruction uploaded for approval.'); }} />}
      {hasMedia && state && captureOpen && <div hidden={dialog.kind === 'confirm'}><Capture state={state} base={base} items={items} visible={dialog.kind === 'capture'} reload={refresh}
        renderMemoryForm={done => <EventForm name="Create memory" onSubmit={async body => {
          await api(base + '/memories', { ...body, expectedRevision: state.revision }); await refresh(); done();
        }} />}
        preview={async (item, eventId, text) => {
          const proposal = await api<Proposal>(base + '/capture/observations/' + item.id + '/preview', {
            eventId, expectedRevision: state.revision, text, ...(eventId === current?.id && currentAnchor && { anchorId: currentAnchor.id })
          });
          setDialog({ kind: 'confirm', revision: state.revision, proposal, command: proposal.command, fromCapture: true });
        }} /></div>}
      {state && dialog.kind === 'memory' && <EventForm name="Create memory" onSubmit={async body => {
        await api(base + '/memories', { ...body, expectedRevision: state.revision }); await refresh(); dismiss();
      }} />}
      {current && dialog.kind === 'correction' && <EventForm name="Preview correction" event={current} onSubmit={payload => preview('event.correct', payload)} />}
      {current && dialog.kind === 'recollection' && <RecollectionForm anchor={currentAnchor?.title} onCapture={() => show('capture')}
        onSubmit={text => preview('recollection.add', { text, ...(currentAnchor && { anchorId: currentAnchor.id }) })} />}
      {state && dialog.kind === 'source' && <div className="source-detail"><span className="eyebrow">{dialog.source.provenance === 'imagined' ? 'IMAGINED DEMO IMAGE' : 'ORIGINAL SOURCE'}</span>
        <h3>{dialog.source.caption}</h3>
        {dialog.source.mime.startsWith('image/') ? <img src={sourceURL(project, dialog.source.id)} alt={dialog.source.caption} /> :
          dialog.source.mime.startsWith('video/') ? <video controls playsInline src={sourceURL(project, dialog.source.id)} /> :
            <audio controls src={sourceURL(project, dialog.source.id)} />}
        <p className="muted">{displayDate(dialog.source.capturedAt)}</p>
        {dialog.source.gps && <p className="muted">Embedded coordinates: {dialog.source.gps.map(value => value.toFixed(5)).join(', ')}</p>}
        {dialog.source.provenance === 'original' && <a className="btn self-start" href={sourceURL(project, dialog.source.id, '?download=1&variant=original')}><ArrowDownToLine size={16} /> Download original</a>}</div>}
      {state && dialog.kind === 'confirm' && <Confirmation key={dialog.proposal.previewToken} value={dialog} back={() => dialog.fromCapture ? show('capture') : dismiss()} commit={async requestId => {
        const common = { requestId, previewToken: dialog.proposal.previewToken };
        if (dialog.film) await api(base + '/jobs', common);
        else if (dialog.command) await api(base + '/commands', { ...dialog.command, ...common });
        else throw new Error('This preview does not contain a change.');
        await refresh();
        setNotice(dialog.film ? 'Film rendering started.' : dialog.fromCapture ? 'Captured evidence linked.' : 'Change confirmed.');
        if (dialog.fromCapture) show('capture');
        else dismiss();
      }} />}
    </Modal>}
  </div>;
}

// A bare /app visit starts at the landing page; "Try it out" there brings the visitor back here.
let entered = true;
try { entered = sessionStorage.getItem('everwhere-entered') === '1'; } catch { /* Storage may be unavailable. */ }
if (location.pathname === '/app' && !location.search && !location.hash && !entered) location.replace('/');
else createRoot(document.getElementById('root')!).render(<App />);
