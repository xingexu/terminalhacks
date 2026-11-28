import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AudioLines, Camera, Check, FolderOpen, Image, Mic, Square, Trash2, Upload, X } from 'lucide-react';
import { api, displayDate, sourceURL, type Observation, type Snapshot } from './model';

type CaptureProps = {
  state: Snapshot; base: string; items: Observation[];
  reload: () => Promise<void>;
  preview: (item: Observation, eventId: string, text?: string) => Promise<void>;
  renderMemoryForm: (onCreated: () => void) => ReactNode;
};

export function Capture({ state, base, items, reload, preview, renderMemoryForm }: CaptureProps) {
  const [consent, setConsent] = useState(false);
  const [keepLocation, setKeepLocation] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [queued, setQueued] = useState(false);
  const [recording, setRecording] = useState<'off' | 'requesting' | 'recording'>('off');
  const [note, setNote] = useState<Blob | null>(null);
  const [noteURL, setNoteURL] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const [creatingMemory, setCreatingMemory] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(false);
  const folder = useRef<HTMLInputElement>(null);
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
          form.append('file', file);
          const result = await api<{ duplicate: boolean }>(base + '/capture/sessions/' + sessionId + '/files', form);
          if (result.duplicate) duplicates += 1;
          else done += 1;
        } catch (err) { messages.push(file.name + ' · ' + (err as Error).message); }
      }
      if (kind === 'browser_audio' && done + duplicates) setNote(null);
      if (kind === 'selected_file') setFiles([]);
      setProgress(done + ' added to review' + (duplicates ? ' · ' + duplicates + ' duplicate' + (duplicates === 1 ? '' : 's') : '') + (messages.length ? ' · ' + messages.length + ' failed' : ''));
      setFailures(messages);
    } catch (err) { setError((err as Error).message); }
    finally {
      if (sessionId) await api(base + '/capture/sessions/' + sessionId + '/stop', {}).catch(() => {});
      await reload().catch(() => {});
      setQueued(false);
    }
  }
  return <div className="capture-content">
    <div className="capture-info"><Camera size={23} /><p>Choose photos, clips, or a voice note. Review each source before it becomes part of a memory.</p></div>
    <label className="check-row"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} />
      <span>I have permission to keep these sources in this private project.</span></label>
    <div className="capture-inputs">
      <div className="capture-choice"><Image size={20} /><strong>Photos &amp; clips</strong>
        <div className="button-row"><label className={'btn compact file-btn' + (busy ? ' disabled' : '')}><Upload size={15} /> Select files
          <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple disabled={busy} onChange={e => { setFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /></label>
          <label className={'btn compact file-btn' + (busy ? ' disabled' : '')}><FolderOpen size={15} /> Folder
            <input ref={folder} type="file" multiple disabled={busy} onChange={e => { setFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /></label></div>
        <label className="check-row"><input type="checkbox" checked={keepLocation} disabled={busy} onChange={e => setKeepLocation(e.target.checked)} />
          <span>Keep embedded photo locations</span></label>
        {files.length > 0 && <div className="file-stack"><p>{files.length} {files.length === 1 ? 'file' : 'files'} selected</p>
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
