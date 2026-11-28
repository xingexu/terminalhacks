import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Archive as ArchiveIcon, ArrowDownToLine, ArrowRight, AudioLines, Box, Camera, ChevronDown, ChevronRight,
  CircleHelp, Compass, Fingerprint, Images, LockKeyhole, MapPin, Mic, Plus, Settings, X
} from 'lucide-react';
import '@fontsource-variable/dm-sans';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './style.css';
import './experience.css';
import './ascii.css';
import { Tutorial } from './onboarding';
import { VoicePanel } from './voice';
import { Capture } from './capture';
import { GenerationForm } from './generation';
import { Archive, Explore, type ViewActions } from './views';
import { NotificationBell, type Notification } from './notifications';
import { AccountControl, type AccountMode, type AccountAction, type Account } from './account';
import { art, AsciiArt, AsciiSpinner } from './ascii';
import {
  api, displayDate, isVisual, sourceURL, type Command, type Lens, type Memory, type Observation, type Project, type Proposal,
  type Session, type Snapshot, type Source
} from './model';

type Screen = 'explore' | 'archive';

type Dialog =
  { kind: 'library' | 'settings' | 'voice' | 'capture' | 'memory' | 'recollection' | 'help' | 'world' } |
  { kind: 'generate'; eventId: string } |
  { kind: 'source'; source: Source } |
  { kind: 'confirm'; proposal: Proposal; revision: number; command?: Command; fromCapture?: boolean };

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

function EventForm({ onSubmit }: { onSubmit: (body: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title')).trim();
    const place = String(form.get('place') || '').trim();
    const date = String(form.get('date') || '');
    const lat = String(form.get('lat') || '');
    const lon = String(form.get('lon') || '');
    setBusy(true);
    setError('');
    try {
      if (Boolean(lat) !== Boolean(lon)) throw new Error('Enter both latitude and longitude.');
      const startAt = date ? new Date(date).toISOString() : null;
      await onSubmit({ title, placeLabel: place || undefined, startAt, gps: lat && lon ? [Number(lat), Number(lon)] : null });
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <form className="form-stack" onSubmit={submit}>
    <label>Memory title<input name="title" required maxLength={180} placeholder="A moment worth remembering" /></label>
    <div className="form-columns"><label>Place<input name="place" maxLength={180} placeholder="Unknown location" /></label>
      <label>Date and time<input type="datetime-local" name="date" /></label></div>
    <details><summary>Optional map location</summary><div className="form-columns"><label>Latitude<input name="lat" type="number" step="any" min="-90" max="90" /></label>
      <label>Longitude<input name="lon" type="number" step="any" min="-180" max="180" /></label></div></details>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="btn primary self-start" disabled={busy}>Create memory <ArrowRight size={16} /></button>
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
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="button-row"><button className="btn primary" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await commit(requestId.current); } catch (err) { setError((err as Error).message); }
      finally { setBusy(false); }
    }}>Confirm change <ArrowRight size={16} /></button>
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
  return <div className="form-stack"><div className="notice"><LockKeyhole size={20} /><div><strong>Private project</strong><p>Guests can access their projects in this browser. With an account, you can sign in to reopen your projects. Capture processing stays on the Everwhere server.</p></div></div>
    <h3>Capture permissions</h3>
    {!state.capture.sessions.length && <p className="muted">No capture sessions have been started.</p>}
    {state.capture.sessions.filter(item => item.status !== 'revoked').map(item => <div className="result-row" key={item.id}>
      <strong>{item.source === 'browser_audio' ? 'Voice note' : item.source === 'voiceos_text' ? 'VoiceOS text' : 'Selected files'} · {item.status}</strong>
      <button className="btn compact" disabled={busy} onClick={() => setConfirm(item.grantId)}>Revoke</button>
      {confirm === item.grantId && <div className="permission-confirm"><p>Withdraw these sources and make scenes that rely on them unavailable?</p>
        <button className="btn compact danger" onClick={() => perform(() => api(base + '/capture/grants/' + item.grantId + '/revoke', {}))} disabled={busy}>Withdraw sources</button></div>}
    </div>)}
    <hr />
    {confirm === 'delete' ? <div className="form-stack"><p>Delete this project, its private sources, and all hosted exports?</p>
      <button className="btn danger self-start" disabled={busy} onClick={() => perform(deleteProject, () => {})}>Permanently delete project</button></div> :
      <button className="btn danger self-start" onClick={() => setConfirm('delete')}>Delete project</button>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export function WorkspaceApp({ covered = false }: { covered?: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState('');
  const [state, setState] = useState<Snapshot | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [items, setItems] = useState<Observation[]>([]);
  const [notice, setNotice] = useState('');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [startupError, setStartupError] = useState('');
  const [map, setMap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [startPlaying, setStartPlaying] = useState(false);
  const [landingEntry, setLandingEntry] = useState(covered);
  const [entryURL] = useState(() => new URL(covered ? '/app?tour=0' : location.href, location.origin));
  const firstWorkspaceVisit = useRef(entryURL.pathname === '/app' && entryURL.searchParams.get('play') !== '1');
  const [accountEntry] = useState<AccountMode | undefined>(() => {
    const mode = entryURL.searchParams.get('account');
    return mode === 'login' || mode === 'register' || mode === 'manage' ? mode : undefined;
  });
  const ref = useRef('');
  const earlyRoute = useRef<Screen | null>(null);
  const latestSnapshot = useRef<Snapshot | null>(null);
  const preload = useRef<{ project: string; request: Promise<void> } | null>(null);
  const observedJobs = useRef(new Map<string, string>());
  const base = '/projects/' + project;
  const current = state?.events.find(item => item.id === state.session.eventId) ?? state?.events[0];

  const addNotification = useCallback((projectId: string, message: string, id: string = crypto.randomUUID()) => {
    if (!projectId) return;
    setNotifications(current => current.some(item => item.projectId === projectId && item.id === id)
      ? current : [{ id, projectId, message, read: false }, ...current].slice(0, 40));
  }, []);

  const loadProjects = useCallback(async () => {
    const list = await api<Project[]>('/bootstrap');
    setProjects(list);
    return list;
  }, []);
  const chooseProject = useCallback((id: string) => {
    ref.current = id;
    latestSnapshot.current = null;
    setProject(id);
    setState(null);
    setItems([]);
    setStartupError('');
    if (id) localStorage.setItem('everwhere-project', id);
    else localStorage.removeItem('everwhere-project');
  }, []);
  useEffect(() => {
    loadProjects().then(list => {
      const [, p, id, view] = entryURL.pathname.split('/');
      const requested = p === 'p' && list.some(item => item.id === id) ? id : '';
      const query = entryURL.searchParams;
      const returnEvent = query.get('generate');
      const requestedDemo = query.get('play') === '1' && !returnEvent && !requested;
      const demo = requestedDemo ? list.find(item => item.demo) : undefined;
      earlyRoute.current = requested && view === 'archive' ? 'archive' : 'explore';
      const last = localStorage.getItem('everwhere-project');
      chooseProject(requested || demo?.id || list.find(item => item.id === last)?.id || list[0]?.id || '');
      setStartPlaying(!!demo);
      if (requestedDemo && !demo) setNotice('The built-in demo is unavailable in this workspace.');
      const showTutorial = !accountEntry && (query.get('tour') === '1' || (query.get('tour') !== '0' && !demo && !requested));
      setDialog(returnEvent ? { kind: 'generate', eventId: returnEvent } : showTutorial ? { kind: 'help' } : null);
      if (returnEvent) history.replaceState(null, '', location.pathname);
    }).catch(err => setStartupError((err as Error).message)).finally(() => setLoading(false));
  }, [accountEntry, chooseProject, entryURL, loadProjects]);

  useEffect(() => {
    if (covered) return;
    const refreshIdentity = (event: StorageEvent) => {
      if (event.key === 'everwhere-auth-change') location.replace('/app?tour=0');
    };
    const restorePage = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener('storage', refreshIdentity);
    window.addEventListener('pageshow', restorePage);
    return () => {
      window.removeEventListener('storage', refreshIdentity);
      window.removeEventListener('pageshow', restorePage);
    };
  }, [covered]);

  const accountChanged = (_account: Account | null, action: AccountAction) => {
    localStorage.setItem('everwhere-auth-change', crypto.randomUUID());
    if (action === 'logout') location.replace('/');
    else if (action === 'register' && project) location.replace('/p/' + project + '/' + screen);
    else location.replace('/app?tour=0');
  };

  const refresh = useCallback(async () => {
    if (!project) return;
    const [fresh, inbox] = await Promise.all([api<Snapshot>(base + '/snapshot'), api<Observation[]>(base + '/capture/inbox')]);
    if (ref.current !== project || (latestSnapshot.current?.seq ?? -1) > fresh.seq) return;
    latestSnapshot.current = fresh;
    setState(fresh);
    setItems(inbox);
  }, [base, project]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    let events: EventSource | undefined;
    let timer: number | undefined;
    const load = async () => {
      try {
        if (covered) {
          const request = refresh();
          preload.current = { project, request };
          await request;
          return;
        }
        if (preload.current?.project === project) {
          await preload.current.request.catch(() => {});
          if (cancelled) return;
          preload.current = null;
        }
        const view = earlyRoute.current;
        earlyRoute.current = null;
        if (view && latestSnapshot.current?.session.view !== view) {
          await api(base + '/session', { view });
          await refresh();
        } else if (!latestSnapshot.current) {
          await refresh();
        }
        if (cancelled) return;
        setLandingEntry(false);
        setStartupError('');
        events = new EventSource('/v1' + base + '/events');
        events.onmessage = event => {
          const update = JSON.parse(event.data);
          if (update.kind !== 'project.deleted' && update.seq !== latestSnapshot.current?.seq) void refresh().catch(() => {});
        };
        timer = window.setInterval(() => { if (events?.readyState !== EventSource.OPEN) void refresh().catch(() => {}); }, 4000);
      } catch (err) { if (!cancelled) setStartupError((err as Error).message); }
    };
    void load();
    return () => { cancelled = true; events?.close(); window.clearInterval(timer); };
  }, [project, base, covered, refresh]);

  const screen: Screen = !landingEntry && state?.session.view === 'archive' ? 'archive' : 'explore';
  useEffect(() => {
    if (covered) return;
    if (!state) {
      if (!loading && !project && !startupError) history.replaceState(null, '', '/app');
      document.title = 'Everwhere · Gameplay';
      return;
    }
    if (state.projectId !== project) return;
    const target = '/p/' + project + '/' + screen;
    if (location.pathname !== target || location.search) history.replaceState(null, '', target);
    document.title = 'Everwhere · ' + state.title;
  }, [covered, loading, project, screen, startupError, state]);
  useEffect(() => {
    if (!state) return;
    for (const job of state.sceneJobs ?? []) {
      const key = `${state.projectId}:${job.id}`;
      const previous = observedJobs.current.get(key);
      observedJobs.current.set(key, job.status);
      if (!previous || previous === job.status) continue;
      const title = state.events.find(item => item.id === job.eventId)?.title;
      if (job.status === 'ready') addNotification(state.projectId, `${title || 'A scene'} is ready for review.`, `scene:${job.id}:ready`);
      if (job.status === 'failed') addNotification(state.projectId, `Scene generation needs attention${title ? ` for ${title}` : ''}.`, `scene:${job.id}:failed`);
    }
  }, [state, addNotification]);
  useEffect(() => {
    if (state) {
      firstWorkspaceVisit.current = false;
      if (startPlaying) setStartPlaying(false);
    }
  }, [state, startPlaying]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const show = (kind: Extract<Dialog, { kind: 'library' | 'settings' | 'voice' | 'capture' | 'memory' | 'recollection' | 'help' | 'world' }>['kind']) => setDialog({ kind });
  const dismiss = () => {
    setDialog(null);
  };
  const report = (message: string) => {
    addNotification(project, message);
    if (ref.current === project) setNotice(message);
  };
  const guarded = (work: () => Promise<unknown>) => { void work().catch(err => setNotice((err as Error).message)); };
  const select = (input: Partial<Session>) => guarded(async () => { await api(base + '/session', input); await refresh(); });
  const openView = (view: Screen) => {
    setMap(false);
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
    openMap: () => { setMap(true); select({ view: 'archive' }); },
    openMemory: () => show('memory'),
    openRecollection: () => show('recollection'),
    addWaypoint: (position, sourceId, worldId) => guarded(() => preview('anchor.add', { position, worldId: worldId ?? 'trail-' + current?.id, sourceIds: sourceId ? [sourceId] : [] })),
    approve: world => guarded(() => preview('artifact.approve', { artifactId: world.id, dependencyHash: world.inputHash })),
    openSettings: () => show('settings'),
    openWorld: () => show('world'),
    openGeneration: () => { if (current) setDialog({ kind: 'generate', eventId: current.id }); },
    undo: () => { if (state?.undo) guarded(() => preview('undo', { revisionToUndo: state.undo!.revision }, state.undo!.targetId)); }
  };

  const currentAnchor = state?.anchors.find(item => item.id === state.session.anchorId && item.eventId === current?.id);
  const hasMedia = state && !!project;
  const captureOpen = dialog?.kind === 'capture' || (dialog?.kind === 'confirm' && !!dialog.fromCapture);
  const bell = <NotificationBell key={project} notifications={notifications.filter(item => item.projectId === project)}
    markRead={() => setNotifications(current => current.map(item => item.projectId === project && !item.read ? { ...item, read: true } : item))} />;
  // "Originals only" can empty a memory whose pictures are all illustrated; say so instead of showing blank frames.
  const memoryPictures = state && current ? state.media.filter(item => current.sourceIds.includes(item.id) && isVisual(item)) : [];
  const hiddenByLens = state?.session.lens === 'originals' ? memoryPictures.filter(item => item.provenance !== 'original').length : 0;
  const lensHidesAll = hiddenByLens > 0 && hiddenByLens === memoryPictures.length;
  const dateLabel = state?.demo && state.events.length ? 'October 12–14, 2024' : current?.startAt ? displayDate(current.startAt) : '';
  const sectionTitles: Record<Dialog['kind'], string> = {
    library: 'Projects', settings: 'Project settings', voice: 'Connect VoiceOS', capture: 'Capture memory',
    memory: 'New memory', recollection: 'Add a recollection',
    help: 'Welcome to Everwhere', source: 'Source evidence', confirm: 'Review change', world: 'Import 3D scene', generate: 'Step inside your photo'
  };
  return <div className="app-frame gameplay-workspace">
    <a className="skip-link" href="#experience">Skip to experience</a>
    <aside className="sidebar" aria-label="Workspace">
      <a className="brand" href="/" aria-label="Everwhere home"><span className="brand-mark"><AsciiArt art={art.mark} /></span><span className="rail-label">everwhere<span className="brand-period">.</span></span></a>
      <button className="workspace-project" onClick={() => show('library')} aria-label={'Switch project, current project ' + (state?.title || 'Projects')}><span className="project-icon"><Images size={17} /></span><span className="rail-label"><strong>{state?.title || 'Memory projects'}</strong><small>{state?.demo ? 'Illustrated sample' : 'Private project'}</small></span><ChevronDown className="rail-label" size={15} /></button>
      <div className="nav-groups">
        <nav aria-label="Experience">
          <button className={screen === 'explore' ? 'active' : ''} aria-current={screen === 'explore' ? 'page' : undefined}
            onClick={() => openView('explore')} disabled={!state}><Compass size={18} /><span className="rail-label">Gameplay</span></button>
        </nav>
      </div>
      <div className="sidebar-bottom">
        <button className="voice-card" onClick={() => show('voice')} disabled={!state} aria-label="Connect VoiceOS"><span className="voice-icon"><AudioLines size={21} /></span><span className="rail-label"><strong>VoiceOS</strong><small>Setup & voice controls</small></span></button>
        <nav className="nav-utilities" aria-label="Project tools">
          <button className="text-button" aria-current={screen === 'archive' ? 'page' : undefined} onClick={() => openView('archive')} disabled={!state}><ArchiveIcon size={16} /><span className="rail-label">Project history</span></button>
          <button className="text-button" onClick={() => show('settings')} disabled={!state}><Settings size={16} /><span className="rail-label">Settings</span></button>
          <button className="icon-btn" onClick={() => show('help')} aria-label="Open tutorial" title="Open tutorial"><CircleHelp size={17} /><span className="rail-label tutorial-label">Tutorial</span></button>
        </nav>
      </div>
    </aside>
    <main className={'main screen-' + screen} id="experience" tabIndex={-1}>
      <header className="topbar">
        <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><button className="breadcrumb-project" onClick={() => show('library')} aria-label="Switch memory project">{state?.title || 'Projects'}</button></div>
        <div className="top-actions"><span className="private-label"><LockKeyhole size={14} /> Private</span>
          <button className="btn top-capture" onClick={() => state ? show('capture') : show('library')}><Camera size={17} /> <span>{state ? 'Capture memory' : 'Projects'}</span>{items.length > 0 && <span className="pending-count" aria-label={items.length + ' pending sources'}>{items.length}</span>}</button>
          <AccountControl initialMode={accountEntry} onSessionChange={accountChanged} />{bell}</div>
      </header>
      {startupError && <div className="notice main-notice" role="alert">{startupError}<button className="btn compact" onClick={() => location.reload()}>Retry</button></div>}
      {!startupError && (loading || (!state && project)) && <div className="load-state" role="status"><AsciiSpinner /> Opening your universe…</div>}
      {!loading && !state && !project && <div className="load-state"><AsciiArt art={art.universe} /><h1>Every life is a world.</h1><button className="btn primary" onClick={() => show('library')}><Plus size={17} /> Create a project</button></div>}
      {state && <div className="main-content">
        <div className="project-head"><div>
          {state.demo && <p className="eyebrow project-kicker">Illustrated sample</p>}
          <h1>{state.title}</h1>
          <div className="project-details">{dateLabel && <span>{dateLabel}</span>}{dateLabel && current && <span className="dot-separator" />}
            {current && <span><MapPin size={14} />{state.demo ? 'The Italian Alps' : current.placeLabel}</span>}
            {!!state.events.length && <><span className="dot-separator" /><span>{state.events.length} {state.events.length === 1 ? 'memory' : 'memories'}</span></>}
          </div></div>
          <button className={'btn lens-toggle' + (state.session.lens === 'originals' ? ' lens-active' : '')}
            aria-pressed={state.session.lens === 'originals'} onClick={() => select({ lens: (state.session.lens === 'originals' ? 'all' : 'originals') as Lens })}>
            <Fingerprint size={16} /><span>Originals only</span><span className="switch-track"><i /></span></button>
        </div>
        {lensHidesAll && <div className="notice lens-notice" role="status"><Fingerprint size={18} /><div><strong>Originals only is on</strong>
          <p>{hiddenByLens} {hiddenByLens === 1 ? 'picture in this memory is illustrated or imagined, so it is' : 'pictures in this memory are illustrated or imagined, so they are'} hidden.</p></div>
          <button className="btn compact" onClick={() => select({ lens: 'all' })}>Show all pictures</button></div>}
        {screen === 'explore' && <Explore state={state} event={current} actions={actions} startPlaying={startPlaying && state.demo} startInWorkspace={firstWorkspaceVisit.current}
          notifications={<><AccountControl onSessionChange={accountChanged} />{bell}</>} onDiscover={source => addNotification(project, `Waypoint discovered: ${source.caption}`, `waypoint:${current?.id}:${source.id}`)} />}
        {screen === 'archive' && <Archive state={state} event={current} actions={actions} initialMap={map} />}
      </div>}
    </main>
    {notice && <aside className="toast" role="status">{notice}<button className="icon-btn" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={17} /></button></aside>}
    {dialog && <Modal key={captureOpen ? 'capture' : dialog.kind} title={sectionTitles[dialog.kind]} onClose={dismiss} wide={captureOpen || dialog.kind === 'source'}>
      {dialog.kind === 'library' && <><p className="muted">Open a project or start a private collection.</p>
        <div className="library-list">{projects.map(item => <button className="workspace-project" key={item.id} onClick={() => { if (item.id !== project) chooseProject(item.id); dismiss(); }}>
          <span className="project-icon"><Images size={17} /></span><span><strong>{item.title}</strong><small>{item.demo ? 'Sample project' : 'Private project'}</small></span><ChevronRight size={17} /></button>)}</div>
        <NameForm handle={async title => { const created = await api<Project>('/projects', { title }); await loadProjects(); chooseProject(created.id); dismiss(); }} /></>}
      {dialog.kind === 'help' && <Tutorial finish={dismiss} canConnectVoice={!!state}
        connectVoice={() => show('voice')}
        create={() => show('library')} />}
      {hasMedia && state && dialog.kind === 'settings' && <SettingsPanel state={state} base={base} reload={() => void refresh().catch(() => {})} deleteProject={async () => {
        await api(base, { confirm: true }, 'DELETE'); const list = await loadProjects(); chooseProject(list[0]?.id || ''); dismiss();
      }} />}
      {hasMedia && state && dialog.kind === 'voice' && <VoicePanel base={base} state={state} />}
      {state && dialog.kind === 'generate' && state.events.filter(event => event.id === dialog.eventId).map(event => <GenerationForm key={event.id} state={state} event={event}
        done={async () => { await refresh(); dismiss(); report('Scene generation started.'); }} />)}
      {state && current && dialog.kind === 'world' && <WorldForm state={state} event={current} base={base}
        done={async () => { await refresh(); dismiss(); report('Reconstruction uploaded for approval.'); }} />}
      {hasMedia && state && captureOpen && <div hidden={dialog.kind === 'confirm'}><Capture state={state} base={base} items={items} visible={dialog.kind === 'capture'} reload={refresh}
        renderMemoryForm={done => <EventForm onSubmit={async body => {
          await api(base + '/memories', { ...body, expectedRevision: state.revision }); await refresh(); done();
        }} />}
        preview={async (item, eventId, text) => {
          const proposal = await api<Proposal>(base + '/capture/observations/' + item.id + '/preview', {
            eventId, expectedRevision: state.revision, text, ...(eventId === current?.id && currentAnchor && { anchorId: currentAnchor.id })
          });
          setDialog({ kind: 'confirm', revision: state.revision, proposal, command: proposal.command, fromCapture: true });
        }} /></div>}
      {state && dialog.kind === 'memory' && <EventForm onSubmit={async body => {
        await api(base + '/memories', { ...body, expectedRevision: state.revision }); await refresh(); dismiss();
      }} />}
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
        if (dialog.command) await api(base + '/commands', { ...dialog.command, ...common });
        else throw new Error('This preview does not contain a change.');
        await refresh();
        report(dialog.fromCapture ? 'Captured evidence linked.' : 'Change confirmed.');
        if (dialog.fromCapture) show('capture');
        else dismiss();
      }} />}
    </Modal>}
  </div>;
}
