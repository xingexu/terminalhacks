import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AudioLines, Camera, Check, FolderOpen, Image, MapPin, Mic, Square, Trash2, Upload, X } from 'lucide-react';
import { api, displayDate, sourceURL, type Observation, type Snapshot } from './model';
import { CameraPanel, type CameraViewer } from './camera-action';

type CaptureProps = {
  state: Snapshot; base: string; items: Observation[];
  visible: boolean;
  cameraViewer?: CameraViewer | null; cameraNotice?: string;
  reload: () => Promise<void>;
  onNavigated: (message: string) => void;
  preview: (item: Observation, eventId: string, text?: string) => Promise<void>;
  renderMemoryForm: (onCreated: () => void) => ReactNode;
};

const emptyCredit = { title: '', creator: '', sourceUrl: '', license: '', licenseUrl: '', reportedDate: '', dateNote: '' };

export function Capture({ state, base, items, visible, cameraViewer = null, cameraNotice, reload, onNavigated, preview, renderMemoryForm }: CaptureProps) {
  const [consent, setConsent] = useState(false);
  const [keepLocation, setKeepLocation] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [publicReference, setPublicReference] = useState(false);
  const [imagined, setImagined] = useState(false);
  const [credit, setCredit] = useState(emptyCredit);
  const [queued, setQueued] = useState(false);
  const [recording, setRecording] = useState<'off' | 'requesting' | 'recording'>('off');
  const [note, setNote] = useState<Blob | null>(null);
  const [noteURL, setNoteURL] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const [creatingMemory, setCreatingMemory] = useState(false);
  const [place, setPlace] = useState('');
  const [finding, setFinding] = useState(false);
  const [placeError, setPlaceError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(false);
  const folder = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible) content.current?.querySelectorAll('audio').forEach(audio => audio.pause());
  }, [visible]);
  useEffect(() => {
    mounted.current = true;
    folder.current?.setAttribute('webkitdirectory', '');
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach(track => track.stop());
    };
  }, []);
  useEffect(() => {
    if (!note) { setNoteURL(''); return; }
    const url = URL.createObjectURL(note);
    setNoteURL(url);
    return () => URL.revokeObjectURL(url);
  }, [note]);
  const busy = queued || recording !== 'off';
  function chooseFiles(selection: File[]) {
    setFiles(selection);
    setPublicReference(false);
    setImagined(false);
    setCredit(emptyCredit);
  }
  function stopRecording() {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    stream.current?.getTracks().forEach(track => track.stop());
    window.clearTimeout(timer.current);
  }
  async function startRecording() {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('Microphone recording is unavailable in this browser.');
      return;
    }
    let granted: MediaStream | null = null;
    try {
      setRecording('requesting');
      granted = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { granted.getTracks().forEach(track => track.stop()); return; }
      stream.current = granted;
      const instance = new MediaRecorder(granted);
      recorder.current = instance;
      const chunks: Blob[] = [];
      instance.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      instance.onstop = () => {
        if (!mounted.current) return;
        const blob = new Blob(chunks, { type: instance.mimeType.split(';')[0] });
        setRecording('off');
        if (blob.size) setNote(blob);
        else setError('The recording contains no audio. Try again.');
      };
      instance.onerror = () => { stopRecording(); if (mounted.current) setError('The recording was interrupted.'); };
      instance.start();
      setRecording('recording');
      timer.current = window.setTimeout(stopRecording, 115000);
    } catch (err) {
      granted?.getTracks().forEach(track => track.stop());
      if (mounted.current) {
        setRecording('off');
        setError((err as Error).name === 'NotAllowedError' ? 'Microphone permission was denied. You can still write a recollection.' : 'No microphone could be started.');
      }
    }
  }
  async function upload(selection: File[], kind: 'selected_file' | 'browser_audio') {
    if (!selection.length || !consent) return;
    const withCredit = kind === 'selected_file' && publicReference;
    if (withCredit && (selection.length !== 1 || !selection[0].type.startsWith('image/'))) {
      setError('Select one public reference photo at a time so its credits stay with the right image.');
      return;
    }
    if (withCredit && [credit.creator, credit.sourceUrl, credit.license, credit.licenseUrl].some(value => !value.trim())) {
      setError('Add the photo’s creator, source URL, license and license URL before uploading.');
      return;
    }
    setQueued(true);
    setError('');
    setFailures([]);
    let sessionId: string | null = null;
    let done = 0;
    let duplicates = 0;
    const messages: string[] = [];
    try {
      sessionId = (await api<{ id: string }>(base + '/capture/sessions', { source: kind, consent: true, keepLocation })).id;
      for (const [index, file] of selection.entries()) {
        setProgress('Reviewing file ' + (index + 1) + ' of ' + selection.length + '…');
        try {
          const form = new FormData();
          if (withCredit) form.append('attribution', JSON.stringify(credit));
          form.append('file', file);
          const result = await api<{ duplicate: boolean }>(base + '/capture/sessions/' + sessionId + '/files' +
            (kind === 'selected_file' && imagined ? '?provenance=imagined' : ''), form);
          if (result.duplicate) duplicates += 1;
          else done += 1;
        } catch (err) { messages.push(file.name + ' · ' + (err as Error).message); }
      }
      if (kind === 'browser_audio' && done + duplicates) setNote(null);
      if (kind === 'selected_file' && !messages.length) chooseFiles([]);
      setProgress(done + ' added to review' + (duplicates ? ' · ' + duplicates + ' duplicate' + (duplicates === 1 ? '' : 's') : '') + (messages.length ? ' · ' + messages.length + ' failed' : ''));
      setFailures(messages);
    } catch (err) { setError((err as Error).message); }
    finally {
      if (sessionId) await api(base + '/capture/sessions/' + sessionId + '/stop', {}).catch(() => {});
      await reload().catch(() => {});
      setQueued(false);
    }
  }
  async function findPlace() {
    setFinding(true);
    setPlaceError('');
    try {
      // The server matches the typed description against approved route stops; nothing is saved and no image is analysed.
      const result = await api<{ message?: string }>(base + '/navigate-anchor', { query: place.trim() });
      await reload().catch(() => {});
      if (mounted.current) onNavigated(result.message || 'Selected a reviewed stop. Arrival is not confirmed until the scene loads.');
    } catch (err) { if (mounted.current) setPlaceError((err as Error).message); }
    finally { if (mounted.current) setFinding(false); }
  }
  async function uploadFrame(frame: File, captureId: string) {
    if (!consent) throw new Error('Confirm you have permission to keep sources, then take the photo again.');
    setQueued(true);
    setError('');
    let sessionId: string | null = null;
    try {
      sessionId = (await api<{ id: string }>(base + '/capture/sessions', { source: 'selected_file', consent: true, keepLocation: false })).id;
      const form = new FormData();
      form.append('file', frame);
      // api() assigns a random capture ID; a camera frame must carry its request ID.
      const response = await fetch('/v1' + base + '/capture/sessions/' + sessionId + '/files', { method: 'POST', headers: { 'X-Capture-Id': captureId }, body: form });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.message || 'The photo could not be uploaded.');
      return json.data.duplicate ? null : json.data.observationId as string;
    } finally {
      if (sessionId) await api(base + '/capture/sessions/' + sessionId + '/stop', {}).catch(() => {});
      await reload().catch(() => {});
      if (mounted.current) setQueued(false);
    }
  }
  return <div className="capture-content" ref={content}>
    <div className="capture-info"><Camera size={23} /><p>Choose photos, clips, or a voice note. Review each source before it becomes part of a memory.</p></div>
    <form className="form-stack" onSubmit={e => { e.preventDefault(); void findPlace(); }}>
      <label>Where in Mont-Tremblant?<input maxLength={500} value={place} disabled={finding} aria-describedby="place-hint"
        onChange={e => { setPlace(e.target.value); setPlaceError(''); }} placeholder="Describe the place in your own words" /></label>
      <small className="muted" id="place-hint">Matches your description to a reviewed route stop. Photos are not analysed and still need review before linking.</small>
      <div className="button-row"><button className="btn compact" type="submit" disabled={!place.trim() || finding}><MapPin size={15} /> {finding ? 'Finding…' : 'Find this place'}</button></div>
      {placeError && <p className="form-error" role="alert">{placeError}</p>}
    </form>
    <label className="check-row"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} />
      <span>I have permission to keep these sources in this private project.</span></label>
    <div className="capture-inputs">
      <div className="capture-choice"><Image size={20} /><strong>Photos &amp; clips</strong>
        <div className="button-row"><label className={'btn compact file-btn' + (busy ? ' disabled' : '')}><Upload size={15} /> Select files
          <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple disabled={busy} onChange={e => { chooseFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /></label>
          <label className={'btn compact file-btn' + (busy ? ' disabled' : '')}><FolderOpen size={15} /> Folder
            <input ref={folder} type="file" multiple disabled={busy} onChange={e => { chooseFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /></label></div>
        <label className="check-row"><input type="checkbox" checked={keepLocation} disabled={busy} onChange={e => setKeepLocation(e.target.checked)} />
          <span>Keep embedded photo locations</span></label>
        {files.length > 0 && <div className="file-stack"><p>{files.length} {files.length === 1 ? 'file' : 'files'} selected</p>
          <label className="check-row"><input type="checkbox" checked={imagined} disabled={busy || !files.every(file => file.type.startsWith('image/'))}
            onChange={e => setImagined(e.target.checked)} /><span>These images are AI-generated or imagined illustrations</span></label>
          <label className="check-row"><input type="checkbox" checked={publicReference} disabled={busy || files.length !== 1 || !files[0].type.startsWith('image/')} onChange={e => setPublicReference(e.target.checked)} />
            <span>Public reference photo — keep its creator and license credits</span></label>
          {files.length !== 1 && <small className="muted">Upload public reference photos individually to credit each one correctly.</small>}
          {publicReference && <fieldset className="form-stack" disabled={busy} style={{ minWidth: 0, width: '100%' }}>
            <legend>Credits for {files[0].name}</legend>
            <label>Photo title (optional)<input maxLength={180} value={credit.title} onChange={e => setCredit({ ...credit, title: e.target.value })} /></label>
            <label>Creator<input required maxLength={200} value={credit.creator} onChange={e => setCredit({ ...credit, creator: e.target.value })} /></label>
            <label>Original source URL<input required type="url" maxLength={2048} value={credit.sourceUrl} onChange={e => setCredit({ ...credit, sourceUrl: e.target.value })} /></label>
            <label>License<input required maxLength={100} placeholder="CC BY-SA 2.0" value={credit.license} onChange={e => setCredit({ ...credit, license: e.target.value })} /></label>
            <label>License URL<input required type="url" maxLength={2048} value={credit.licenseUrl} onChange={e => setCredit({ ...credit, licenseUrl: e.target.value })} /></label>
            <label>Source-reported date (optional)<input type="date" value={credit.reportedDate} onChange={e => setCredit({ ...credit, reportedDate: e.target.value })} /></label>
            <label>Date evidence and uncertainty<textarea rows={2} maxLength={1000} placeholder="Who reports this date? Note conflicting metadata or unknown time/timezone." value={credit.dateNote} onChange={e => setCredit({ ...credit, dateNote: e.target.value })} /></label>
            <p className="muted">A public reference is not a personal trip record. Dates entered here stay separate from embedded capture timestamps. Share the scene with its credits file and follow the source license, including ShareAlike when applicable.</p>
          </fieldset>}
          <button className="btn compact primary" disabled={!consent || busy} onClick={() => upload(files, 'selected_file')}><Upload size={14} /> Upload for review</button></div>}
      </div>
      <div className="capture-choice"><AudioLines size={20} /><strong>Voice note</strong>
        {recording === 'recording' ? <button className="btn compact record-stop" onClick={stopRecording}><Square size={14} fill="currentColor" /> Stop recording</button> :
          <button className="btn compact" disabled={!consent || busy} onClick={startRecording}><Mic size={15} /> {recording === 'requesting' ? 'Waiting for permission' : 'Start recording'}</button>}
        {note && <div className="file-stack"><audio controls src={noteURL} />
          <div className="button-row"><button className="btn compact primary" disabled={!consent || busy} onClick={() => upload([new File([note], note.type.includes('mp4') ? 'Voice note.mp4' : 'Voice note.webm', { type: note.type })], 'browser_audio')}><Check size={15} /> Keep for review</button>
            <button className="icon-btn" aria-label="Clear recording" onClick={() => setNote(null)}><X size={16} /></button></div></div>}
      </div>
    </div>
    <CameraPanel base={base} viewer={cameraViewer} notice={cameraNotice} action={state.session.cameraAction} consent={consent} visible={visible} busy={busy} uploadFrame={uploadFrame} />
    {progress && <p className="muted" role="status">{progress}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!!failures.length && <ul className="form-error">{failures.map((item, i) => <li key={i}>{item}</li>)}</ul>}
    <div className="inbox-title"><h3>Review inbox</h3><span>{items.length} pending</span><button type="button" className="text-button" disabled={busy || creatingMemory} onClick={() => setCreatingMemory(true)}>New memory</button></div>
    {creatingMemory && <div className="surface">
      <div className="inbox-title"><h3>Create a memory</h3><button type="button" className="text-button" onClick={() => setCreatingMemory(false)}>Cancel new memory</button></div>
      {renderMemoryForm(() => setCreatingMemory(false))}
    </div>}
    {!state.events.length && <p className="empty-inbox">Create a memory before linking a source. <button type="button" className="text-button" disabled={busy || creatingMemory} onClick={() => setCreatingMemory(true)}>Add a memory</button></p>}
    {!items.length && <p className="empty-inbox">New photos, videos, and voice notes will appear here.</p>}
    {items.map(item => <InboxItem key={item.id} item={item} state={state} base={base} refresh={reload} preview={preview} captureBusy={busy} />)}
  </div>;
}

function InboxItem({ item, state, base, refresh, preview, captureBusy }: {
  item: Observation; state: Snapshot; base: string; refresh: () => Promise<void>; preview: CaptureProps['preview']; captureBusy: boolean;
}) {
  const [eventId, setEventId] = useState(item.candidates[0]?.id ?? state.session.eventId ?? '');
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const audio = item.media?.mime.startsWith('audio/');
  const matching = item.candidates.find(candidate => candidate.id === eventId);
  async function discard() {
    setBusy(true);
    try { await api(base + '/capture/observations/' + item.id + '/discard', {}); await refresh(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return <article className="inbox-item">
    <div className="inbox-item-heading">{item.media && !audio && <img src={sourceURL(state.projectId, item.media.id, '?variant=thumb')} alt="" />}
      {audio && <AudioLines size={26} />}<div><strong>{item.caption}</strong><small>{displayDate(item.media?.capturedAt)}</small></div>
      <button className="icon-btn" title="Discard capture" aria-label="Discard capture" onClick={() => setConfirm(!confirm)}><Trash2 size={16} /></button></div>
    {item.media?.attribution && <p className="muted">Public reference · {item.media.attribution.creator} · <a href={item.media.attribution.sourceUrl} target="_blank" rel="noopener noreferrer">Source</a> · <a href={item.media.attribution.licenseUrl} target="_blank" rel="noopener noreferrer">{item.media.attribution.license}</a><br />
      Source-reported date: {item.media.attribution.reportedDate || 'unknown'} · {item.media.attribution.dateNote}</p>}
    {confirm ? <div className="button-row"><span className="muted">Remove this unreviewed source?</span><button className="btn compact danger" onClick={discard} disabled={busy}>Discard</button></div> : <>
      {audio && item.media && <><audio controls src={sourceURL(state.projectId, item.media.id)} />
        <label>Recollection<textarea rows={2} maxLength={4000} value={text} onChange={e => setText(e.target.value)} placeholder="Write the account that goes with this recording" /></label></>}
      <label>Link to memory<select value={eventId} onChange={e => setEventId(e.target.value)}><option value="">Select a memory</option>
        {state.events.map(event => <option key={event.id} value={event.id}>{event.title}</option>)}</select></label>
      {matching && <small className="muted">{matching.reason}</small>}
      <button className="btn compact primary" disabled={!eventId || (!!audio && !text.trim()) || busy || captureBusy} onClick={() => {
        setBusy(true);
        preview(item, eventId, text || undefined).catch(err => setError((err as Error).message)).finally(() => setBusy(false));
      }}>Review {audio ? 'recollection' : 'link'}</button></>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </article>;
}
