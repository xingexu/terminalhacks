import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive as ArchiveIcon, ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Box, Camera, ChevronDown, ChevronRight,
  CircleHelp, Compass, Feather, Film, Fingerprint, Images, LockKeyhole, MapPin, Mic, Plus, Settings, X
} from 'lucide-react';
import '@fontsource-variable/dm-sans';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './style.css';
import './experience.css';
import { Tutorial } from './onboarding';
import { VoicePanel } from './voice';
import { Generation } from './generation';
import { Capture } from './capture';
import { Archive, AtlasMark, Create, Explore, NarrationPreview, Remember, Watch, type ViewActions } from './views';
import {
  api, displayDate, localDateTime, sourceURL, storyboardBasis, type Command, type Lens, type Memory, type Observation, type Project, type Proposal,
  type Session, type Snapshot, type Source, type View
} from './model';

const nav = [
  { id: 'explore', name: 'Memories', icon: Compass },
  { id: 'watch', name: 'Films', icon: Film },
  { id: 'create', name: 'Studio', icon: Feather },
  { id: 'remember', name: 'Stories', icon: BookOpen },
  { id: 'archive', name: 'Library', icon: ArchiveIcon }
] as const;

type Dialog =
  { kind: 'library' | 'settings' | 'voice' | 'capture' | 'memory' | 'recollection' | 'correction' | 'help' | 'world' | 'generation' } |
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
  const [coordinateError, setCoordinateError] = useState('');
  const coordinateErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (coordinateError) coordinateErrorRef.current?.focus(); }, [coordinateError]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title')).trim();
    const place = String(form.get('place') || '').trim();
    const date = String(form.get('date') || '');
    const story = String(form.get('story') || '').trim();
    const lat = String(form.get('lat') || '').trim();
    const lon = String(form.get('lon') || '').trim();
    setError('');
    setCoordinateError('');
    if (Boolean(lat) !== Boolean(lon)) {
      setCoordinateError('Enter both latitude and longitude, or leave both blank to remove the coordinates.');
      return;
    }
    const gps: [number, number] | null = lat && lon ? [Number(lat), Number(lon)] : null;
    if (gps && (!gps.every(Number.isFinite) || Math.abs(gps[0]) > 90 || Math.abs(gps[1]) > 180)) {
      setCoordinateError('Use a latitude from −90 to 90 and a longitude from −180 to 180. Both must be finite numbers.');
      return;
    }
    setBusy(true);
    try {
      const originalClock = localDateTime(event?.startAt);
      const startAt = date === originalClock && event ? event.startAt : date ? new Date(date).toISOString() : null;
      if (event) {
        const values = { title, ...(place && { placeLabel: place }), startAt, ...(story && { story }), gps };
        const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => key === 'gps'
          ? JSON.stringify(event.gps ?? null) !== JSON.stringify(value) : event[key as keyof Memory] !== value));
        if (!Object.keys(patch).length) throw new Error('Change a field before previewing the correction.');
        await onSubmit({ patch });
      } else {
        await onSubmit({ title, placeLabel: place || undefined, startAt, gps });
      }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <form className="form-stack" onSubmit={submit}>
    <label>Memory title<input name="title" required maxLength={180} defaultValue={event?.title} placeholder="A moment worth remembering" /></label>
    <div className="form-columns"><label>Place<input name="place" maxLength={180} defaultValue={event?.placeLabel} placeholder="Unknown location" /></label>
      <label>Date and time<input type="datetime-local" name="date" defaultValue={localDateTime(event?.startAt)} /></label></div>
    <p className="muted" id="coordinates-help">Coordinates are optional. Leave both fields blank to remove the memory’s coordinates.</p>
    <div className="form-columns">
      <label>Latitude<input name="lat" type="number" step="any" min="-90" max="90" defaultValue={event?.gps?.[0] ?? ''}
        aria-describedby={'coordinates-help' + (coordinateError ? ' coordinates-error' : '')} aria-invalid={!!coordinateError}
        onChange={() => setCoordinateError('')} onInvalid={e => { e.preventDefault(); setCoordinateError('Enter a finite latitude from −90 to 90.'); }} /></label>
      <label>Longitude<input name="lon" type="number" step="any" min="-180" max="180" defaultValue={event?.gps?.[1] ?? ''}
        aria-describedby={'coordinates-help' + (coordinateError ? ' coordinates-error' : '')} aria-invalid={!!coordinateError}
        onChange={() => setCoordinateError('')} onInvalid={e => { e.preventDefault(); setCoordinateError('Enter a finite longitude from −180 to 180.'); }} /></label>
    </div>
    {coordinateError && <p className="form-error" role="alert" id="coordinates-error" tabIndex={-1} ref={coordinateErrorRef}>{coordinateError}</p>}
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

function Confirmation({ value, projectId, worldTitle, commit, back }: { value: Extract<Dialog, { kind: 'confirm' }>; projectId: string; worldTitle?: string; commit: (requestId: string) => Promise<void>; back: () => void }) {
  const requestId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const diff = value.proposal.diff;
  const showValue = (field: unknown) => {
    if (typeof field === 'object' && field !== null) return Object.entries(field).map(([key, value]) =>
      <span key={key}><strong>{{ placeLabel: 'Place', startAt: 'Date', title: 'Title', story: 'Story', gps: 'Coordinates' }[key] || key}</strong> {key === 'gps' ? Array.isArray(value) ? value.join(', ') : 'Not set' : String(value ?? 'Unknown')}</span>);
    return <span>{String(field ?? 'Unknown')}</span>;
  };
  return <div className="form-stack">
    <div className="notice"><Fingerprint size={20} /><div><strong>{diff.label}</strong><p>Based on revision {value.revision}</p></div></div>
    {diff.before !== undefined && <div className="diff"><div><small>Previous</small>{showValue(diff.before)}</div><div><small>Proposed</small>{showValue(diff.after)}</div></div>}
    {diff.text && <blockquote>{diff.text}</blockquote>}
    {diff.caption && <p>Source: {diff.caption}</p>}
    {value.film && <>
      <p>{diff.sources} visual {diff.sources === 1 ? 'source' : 'sources'} · {diff.storyboard?.durationSeconds ?? '30–60'} seconds · local photo/video montage{diff.narration ? ' · includes a confirmed voice note' : ''}{diff.containsImagined ? ' · includes labeled imagined demo imagery' : ''}</p>
      {diff.storyboard && <>
        <p>{storyboardBasis[diff.storyboard.basis]} This film does not record the 3D walk.</p>
        {worldTitle && <p>Based on world: <strong>{worldTitle}</strong></p>}
        <ol className="form-stack" aria-label="Film storyboard">{diff.storyboard.frames.map(item => <li key={item.sourceId} style={{ overflowWrap: 'anywhere' }}>
          <strong>{item.caption}</strong> · {item.seconds}s · {item.provenance === 'imagined' ? 'Imagined demo' : 'Original source'} · {displayDate(item.capturedAt, true)}
          {item.recollection && <blockquote>{item.recollection.text}<br /><small>{item.recollection.contributor} · Recollection{item.recollection.excerpt ? ' excerpt' : ''}</small></blockquote>}
        </li>)}</ol>
        {diff.storyboard.narration && <NarrationPreview projectId={projectId} narration={diff.storyboard.narration} />}
        {!!diff.storyboard.excludedSourceIds.length && <p>{diff.storyboard.excludedSourceIds.length} additional visual {diff.storyboard.excludedSourceIds.length === 1 ? 'source remains' : 'sources remain'} in your album and journal, outside this cut.</p>}
        {!!diff.storyboard.omittedRecollections && <p>{diff.storyboard.omittedRecollections} additional {diff.storyboard.omittedRecollections === 1 ? 'recollection remains' : 'recollections remain'} in your journal, outside this cut.</p>}
      </>}
    </>}
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
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [provenance, setProvenance] = useState<'imagined' | 'reconstructed'>('imagined');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const sceneInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const sources = state.media.filter(item => event.sourceIds.includes(item.id) && item.mime.startsWith('image/') && item.provenance === 'original');
  const selectedSources = sourceIds.filter(id => sources.some(item => item.id === id));
  useEffect(() => {
    if (!sourceIds.some(id => !sources.some(item => item.id === id))) return;
    setSourceIds([]); setConsent(false);
    if (sceneInput.current) sceneInput.current.value = '';
    setError('A selected source is no longer available. Select the current sources and a scene made without withdrawn content, then confirm again.');
  }, [sourceIds, state.media, event.sourceIds]);
  return <form className="form-stack" aria-busy={busy} onSubmit={async e => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get('scene');
    if (busy || !(file instanceof File) || !file.size || !consent || !selectedSources.length || selectedSources.length !== sourceIds.length) return;
    setBusy(true); setError('');
    try {
      const upload = new FormData(); upload.append('file', file);
      const query = new URLSearchParams({ sourceIds: JSON.stringify(selectedSources), provenance,
        consent: '1', expectedRevision: String(state.revision) });
      for (const key of ['provider', 'title']) {
        const value = String(form.get(key) || '').trim();
        if (value) query.set(key, value);
      }
      await api(base + '/memories/' + event.id + '/worlds?' + query, upload);
      await done();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }}><p className="muted">Import an existing GLB mesh for walking, or an SPZ splat for viewpoint inspection. The file is uploaded to this private Everwhere project; this form does not send photos to a generation provider. You will review and approve the scene before entering it.</p>
    <label>How was this scene made?<select name="provenance" value={provenance} disabled={busy} onChange={e => setProvenance(e.target.value as 'imagined' | 'reconstructed')}>
      <option value="imagined">Generated or authored interpretation</option>
      <option value="reconstructed">Reconstructed from a scan or photogrammetry</option>
    </select></label>
    <p className="muted">{provenance === 'imagined' ? 'Generated or invented surroundings remain labeled as imagined, even when they look realistic.' : 'Choose reconstruction only for geometry derived from measurements or overlapping photographs of this place.'}</p>
    <label>Creator or provider (optional)<input name="provider" maxLength={120} disabled={busy} placeholder="Who made the scene?" /></label>
    <label>Scene title (optional)<input name="title" maxLength={120} disabled={busy} placeholder="Uses the file name if left blank" /></label>
    <div className="form-stack" role="group" aria-labelledby="world-source-title" aria-describedby="world-source-help">
      <strong id="world-source-title">Original source photos</strong>
      <p className="muted" id="world-source-help">Select every original photo used to create or document this scene. Withdrawing a selected source will also make this scene unavailable.</p>
      {sources.map(item => <label className="check-row" key={item.id} style={{ minHeight: 44 }}><input type="checkbox" name="source" value={item.id}
        checked={selectedSources.includes(item.id)} disabled={busy || (selectedSources.length >= 100 && !selectedSources.includes(item.id))}
        onChange={e => setSourceIds(ids => e.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} />
        <span>{item.caption || 'Untitled photo'} · {displayDate(item.capturedAt)}</span></label>)}
      {!sources.length && <p className="notice">Link an original photo to this memory through Capture before importing a scene.</p>}
      {selectedSources.length >= 100 && <p className="muted" role="status">100 photos selected. Each import supports up to 100 source photos.</p>}
    </div>
    <label>3D scene<input ref={sceneInput} type="file" name="scene" accept=".spz,.glb" required disabled={busy} /></label>
    <p className="muted">GLB exports need embedded textures, meter units, Y-up orientation, and at most 250,000 triangles. Upload limit 48 MB.</p>
    <label className="check-row" style={{ minHeight: 44 }}><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />
      <span>I have permission to keep this scene in this project, and I have selected all of its source photos.</span></label>
    {error && <p className="form-error" ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
    {busy && <p className="muted" role="status">Uploading and validating the scene…</p>}
    <button className="btn primary self-start" disabled={!consent || busy || !selectedSources.length}><Box size={16} aria-hidden="true" /> {busy ? 'Uploading…' : 'Import scene for review'}</button>
  </form>;
}

function SettingsPanel({ base, state, reload, deleteProject }: { base: string; state: Snapshot; reload: () => void; deleteProject: () => Promise<void> }) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const perform = async (task: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await task(); reload(); setConfirm(''); } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="form-stack"><div className="notice"><LockKeyhole size={20} /><div><strong>Private project</strong><p>Project access is tied to this browser session. Photos and conversations stay on the Everwhere server. Only an opted-in place query and rounded coordinates are sent to Wikipedia.</p></div></div>
    <h3>Capture permissions</h3>
    {!state.capture.sessions.length && <p className="muted">No capture sessions have been started.</p>}
    {state.capture.sessions.filter(item => item.status !== 'revoked').map(item => <div className="result-row" key={item.id}>
      <strong>{item.source === 'browser_audio' ? 'Voice note' : item.source === 'voiceos_text' ? 'VoiceOS text' : 'Selected files'} · {item.status}</strong>
      <button className="btn compact" disabled={busy} onClick={() => setConfirm(item.grantId)}>Revoke</button>
      {confirm === item.grantId && <div className="permission-confirm"><p>Withdraw the sources captured in this session and make dependent worlds and films unavailable?</p>
        <button className="btn compact danger" onClick={() => perform(() => api(base + '/capture/grants/' + item.grantId + '/revoke', {}))} disabled={busy}>Withdraw sources</button></div>}
    </div>)}
    <hr />
    {confirm === 'delete' ? <div className="form-stack"><p>Delete this project, its private sources, and all hosted exports?</p>
      <button className="btn danger self-start" disabled={busy} onClick={() => perform(deleteProject)}>Permanently delete project</button></div> :
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
  const [map, setMap] = useState(false);
  const [loading, setLoading] = useState(true);
  const ref = useRef('');
  const earlyRoute = useRef<View | null>(null);
  const base = '/projects/' + project;
  const current = state?.events.find(item => item.id === state.session.eventId) ?? state?.events[0];
  const activeContext = useRef({ dialog, project, eventId: current?.id, revision: state?.revision, lens: state?.session.lens });
  activeContext.current = { dialog, project, eventId: current?.id, revision: state?.revision, lens: state?.session.lens };

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
    if (id) localStorage.setItem('everwhere-project', id);
    else history.replaceState(null, '', '/app' + location.search);
  }, []);
  useEffect(() => {
    loadProjects().then(list => {
      const [, p, id, view] = location.pathname.split('/');
      const requested = p === 'p' && list.some(item => item.id === id) ? id : '';
      if (requested && nav.some(item => item.id === view)) earlyRoute.current = view as View;
      const last = localStorage.getItem('everwhere-project');
      chooseProject(requested || list.find(item => item.id === last)?.id || list[0]?.id || '');
      if (!last) setDialog({ kind: 'help' });
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
        if (view) await api(base + '/session', { view });
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
    const target = '/p/' + project + '/' + state.session.view;
    if (location.pathname !== target) history.replaceState(null, '', target);
    document.title = 'Everwhere · ' + state.title;
  }, [project, state]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!state || dialog?.kind !== 'confirm' || !dialog.film) return;
    if (state.revision !== dialog.revision || dialog.proposal.diff.storyboard?.id !== state.storyboards[current?.id || '']?.id) {
      setDialog(null);
      setNotice('The memory changed. Review the current storyboard before rendering.');
    }
  }, [state, current?.id, dialog]);

  const show = (kind: Extract<Dialog, { kind: 'library' | 'settings' | 'voice' | 'capture' | 'memory' | 'recollection' | 'correction' | 'help' | 'world' | 'generation' }>['kind']) => setDialog({ kind });
  const dismiss = () => {
    setDialog(null);
  };
  const guarded = (work: () => Promise<unknown>) => { void work().catch(err => setNotice((err as Error).message)); };
  const select = (input: Partial<Session>) => guarded(async () => { await api(base + '/session', input); await refresh(); });
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
    openCorrection: () => show('correction'),
    openRecollection: () => show('recollection'),
    addWaypoint: (position, sourceId, worldId) => guarded(() => preview('anchor.add', { position, worldId: worldId ?? 'trail-' + current?.id, sourceIds: sourceId ? [sourceId] : [] })),
    render: () => guarded(async () => {
      const context = activeContext.current;
      const proposal = await api<Proposal>(base + '/film-preview', { eventId: current?.id, expectedRevision: state?.revision });
      const latest = activeContext.current;
      if (latest.dialog !== context.dialog || latest.project !== context.project || latest.eventId !== context.eventId ||
        latest.revision !== context.revision || latest.lens !== context.lens) return;
      setDialog({ kind: 'confirm', proposal, film: true, revision: state!.revision });
    }),
    approve: job => guarded(() => preview('artifact.approve', { artifactId: job.id, dependencyHash: job.inputHash })),
    setGrade: preset => guarded(() => preview('profile.set', { preset })),
    openSettings: () => show('settings'),
    openWorld: () => show('world'),
    openGeneration: () => show('generation'),
    undo: () => { if (state?.undo) guarded(() => preview('undo', { revisionToUndo: state.undo!.revision }, state.undo!.targetId)); }
  };

  const currentNav = nav.find(item => item.id === state?.session.view) ?? nav[0];
  const currentAnchor = state?.anchors.find(item => item.id === state.session.anchorId && item.eventId === current?.id);
  const hasMedia = state && !!project;
  const captureOpen = dialog?.kind === 'capture' || (dialog?.kind === 'confirm' && !!dialog.fromCapture);
  const dateLabel = state?.demo && state.events.length ? 'October 12–14, 2024' : current?.startAt ? displayDate(current.startAt) : '';
  const sectionTitles: Record<Dialog['kind'], string> = {
    library: 'Projects', settings: 'Project settings', voice: 'Connect VoiceOS', capture: 'Capture memory',
    memory: 'New memory', recollection: 'Add a recollection', correction: 'Correct memory',
    help: 'Welcome to Everwhere', source: 'Source evidence', confirm: 'Review change', world: 'Import 3D scene', generation: 'Generate memory world'
  };
  return <div className="app-frame">
    <a className="skip-link" href="#experience">Skip to experience</a>
    <aside className="sidebar" aria-label="Workspace">
      <a className="brand" href="/" aria-label="Everwhere home">Everwhere</a>
      <button className="workspace-project" onClick={() => show('library')}><span className="project-icon"><Images size={17} /></span><span><strong>{state?.title || 'Projects'}</strong><small>{state?.demo ? 'Sample project' : 'Private collection'}</small></span><ChevronDown size={15} /></button>
      <div className="nav-groups">
        <nav aria-label="Main navigation">{nav.map(({ id, name, icon: Icon }) =>
          <button key={id} className={currentNav.id === id ? 'active' : ''} aria-current={currentNav.id === id ? 'page' : undefined}
            onClick={() => { setMap(false); select({ view: id }); }} disabled={!state}><Icon size={19} />{name}{currentNav.id === id && <ChevronRight size={15} className="nav-caret" />}</button>)}</nav>
      </div>
      <div className="sidebar-bottom">
        <button className="voice-card" onClick={() => show('voice')} disabled={!state} aria-label="Connect VoiceOS"><span className="voice-icon"><AudioLines size={21} /></span><span><strong>VoiceOS</strong><small>Setup & voice controls</small></span><ArrowRight size={15} /></button>
        <div className="sidebar-footer"><button className="text-button" onClick={() => show('settings')} disabled={!state} aria-label="Project settings"><Settings size={18} /> Settings</button><button className="icon-btn" onClick={() => show('help')} aria-label="Open tutorial" title="Open tutorial"><CircleHelp size={20} /></button></div>
      </div>
    </aside>
    <main className="main" id="experience">
      <header className="topbar">
        <div className="breadcrumbs"><button onClick={() => show('library')}>Projects</button><ChevronRight size={14} /><span>{currentNav.name}</span></div>
        <div className="top-actions"><span className="private-label"><LockKeyhole size={14} /> Private</span>
          <button className="btn top-capture" onClick={() => state ? show('capture') : show('library')}><Plus size={17} /> <span>{state ? 'Capture' : 'New project'}</span>{!!items.length && <span className="pending-count" aria-label={items.length + ' sources awaiting review'}>{items.length}</span>}</button></div>
      </header>
      {startupError && <div className="notice main-notice" role="alert">{startupError}<button className="btn compact" onClick={() => location.reload()}>Retry</button></div>}
      {loading && <div className="load-state" role="status"><AtlasMark size={38} /> Opening your memories…</div>}
      {!loading && !state && !project && <div className="load-state"><Images size={42} /><h1>Your memories start here.</h1><button className="btn primary" onClick={() => show('library')}><Plus size={17} /> Create a project</button></div>}
      {state && <div className="main-content">
        <div className="project-head"><div>
          {state.demo && <span className="sample-label">Sample project</span>}
          <h1>{state.title}</h1>
          <div className="project-details">{dateLabel && <span>{dateLabel}</span>}{dateLabel && current && <span className="dot-separator" />}
            {current && <span><MapPin size={14} />{state.demo ? 'The Italian Alps' : current.placeLabel}</span>}
            {!!state.events.length && <><span className="dot-separator" /><span>{state.events.length} {state.events.length === 1 ? 'memory' : 'memories'}</span></>}
          </div></div>
          <button className={'btn lens-toggle' + (state.session.lens === 'originals' ? ' lens-active' : '')}
            aria-pressed={state.session.lens === 'originals'} onClick={() => select({ lens: (state.session.lens === 'originals' ? 'all' : 'originals') as Lens })}>
            <Fingerprint size={16} /><span>Originals only</span><span className="switch-track"><i /></span></button>
        </div>
        {currentNav.id === 'explore' && <Explore state={state} event={current} actions={actions} />}
        {currentNav.id === 'watch' && <Watch state={state} event={current} actions={actions} />}
        {currentNav.id === 'create' && <Create state={state} event={current} actions={actions} />}
        {currentNav.id === 'remember' && <Remember state={state} event={current} actions={actions} />}
        {currentNav.id === 'archive' && <Archive state={state} event={current} actions={actions} initialMap={map} />}
      </div>}
    </main>
    {notice && <aside className="toast" role="status">{notice}<button className="icon-btn" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={17} /></button></aside>}
    {dialog && <Modal key={captureOpen ? 'capture' : dialog.kind} title={sectionTitles[dialog.kind]} onClose={dismiss} wide={captureOpen || dialog.kind === 'source' || dialog.kind === 'generation'}>
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
      {state && current && dialog.kind === 'generation' && <Generation key={project + current.id} state={state} event={current} base={base} onCorrect={() => show('correction')} onRefresh={refresh}
        onGenerated={async () => {
          // Object identity distinguishes a reopened dialog, even for the same memory.
          const isCurrentDialog = () => activeContext.current.dialog === dialog &&
            activeContext.current.project === project && activeContext.current.eventId === current.id;
          if (!isCurrentDialog()) return;
          await api(base + '/session', { eventId: current.id, view: 'explore', lens: 'all' });
          if (!isCurrentDialog()) return;
          await refresh();
          if (!isCurrentDialog()) return;
          dismiss(); setNotice('Imagined world generated. Select Approve imagined world to review it before entering.');
        }} />}
      {state && current && dialog.kind === 'world' && <WorldForm key={project + current.id} state={state} event={current} base={base}
        done={async () => {
          const isCurrentDialog = () => activeContext.current.dialog === dialog &&
            activeContext.current.project === project && activeContext.current.eventId === current.id;
          if (!isCurrentDialog()) return;
          await refresh();
          if (!isCurrentDialog()) return;
          dismiss(); setNotice('Scene imported for approval.');
        }} />}
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
        <p className="muted">{!dialog.source.capturedAt && dialog.source.capturedLocal ? dialog.source.capturedLocal.replace('T', ' · ') + ' · Timezone unknown' : displayDate(dialog.source.capturedAt)}</p>
        {dialog.source.gps && <p className="muted">Embedded coordinates: {dialog.source.gps.map(value => value.toFixed(5)).join(', ')}</p>}
        {dialog.source.provenance === 'original' && <a className="btn self-start" href={sourceURL(project, dialog.source.id, '?download=1&variant=original')}><ArrowDownToLine size={16} /> Download original</a>}</div>}
      {state && dialog.kind === 'confirm' && <Confirmation key={dialog.proposal.previewToken} value={dialog} projectId={project}
        worldTitle={state.worlds.find(world => world.id === dialog.proposal.diff.storyboard?.worldId)?.title}
        back={() => dialog.fromCapture ? show('capture') : dismiss()} commit={async requestId => {
        const common = { requestId, previewToken: dialog.proposal.previewToken };
        if (dialog.film) await api(base + '/jobs', common);
        else if (dialog.command) await api(base + '/commands', { ...dialog.command, ...common });
        else throw new Error('This preview does not contain a change.');
        await refresh();
        if (dialog.film && (activeContext.current.dialog !== dialog || activeContext.current.project !== project ||
          activeContext.current.eventId !== current?.id)) return;
        setNotice(dialog.film ? 'Film rendering started.' : dialog.fromCapture ? 'Captured evidence linked.' : 'Change confirmed.');
        if (dialog.fromCapture) show('capture');
        else dismiss();
      }} />}
    </Modal>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
