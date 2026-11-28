import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, AudioLines, Box, ExternalLink } from 'lucide-react';
import { api, sourceURL, type Memory, type Snapshot } from './model';

type Connection = { connected: boolean; account?: string; visionReady: boolean };
export function GenerationForm({ state, event, done }: { state: Snapshot; event: Memory; done: () => Promise<void> }) {
  const base = '/projects/' + state.projectId;
  const photos = state.media.filter(item => event.sourceIds.includes(item.id) && item.provenance === 'original' && item.mime.startsWith('image/'));
  const draftKey = 'everwhere-scene-' + state.projectId + '-' + event.id;
  const [draft] = useState(() => { try { return JSON.parse(sessionStorage.getItem(draftKey) || '{}') as { sourceId?: string; description?: string }; } catch { return {}; } });
  const [sourceId, setSourceId] = useState(photos.find(photo => photo.id === draft.sourceId)?.id ?? photos[0]?.id ?? '');
  const [description, setDescription] = useState(draft.description ?? '');
  const [consent, setConsent] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiceHelp, setVoiceHelp] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const jobs = (state.sceneJobs ?? []).filter(job => job.eventId === event.id);
  const active = jobs.find(job => ['queued', 'interpreting', 'building'].includes(job.status));
  const refreshConnection = () => api<Connection>(base + '/higgsfield').then(setConnection).catch(err => setError(err.message));
  useEffect(() => { void refreshConnection(); }, [base]);
  useEffect(() => { sessionStorage.setItem(draftKey, JSON.stringify({ sourceId, description })); }, [draftKey, sourceId, description]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await api(base + '/scene-jobs', { sourceId, eventId: event.id, description, consent, expectedRevision: state.revision, requestId: requestId.current });
      requestId.current = crypto.randomUUID();
      sessionStorage.removeItem(draftKey);
      await done();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="form-stack generation-form" onSubmit={submit}>
    <p className="muted">Choose a photo of the place. Add the details you remember, then build an explorable scene with Higgsfield.</p>
    {photos.length ? <><label>Reference photo<select value={sourceId} onChange={e => { setSourceId(e.target.value); requestId.current = crypto.randomUUID(); }}>
      {photos.map(photo => <option key={photo.id} value={photo.id}>{photo.caption}</option>)}
    </select></label><img className="generation-reference" src={sourceURL(state.projectId, sourceId, '?variant=thumb')} alt={photos.find(photo => photo.id === sourceId)?.caption ?? 'Reference photo'} /></> :
      <p className="notice">Add and confirm an original photo in Capture to generate this memory.</p>}
    <label htmlFor="scene-memory">What else do you remember?</label>
    <textarea ref={input} id="scene-memory" value={description} onChange={e => { setDescription(e.target.value); requestId.current = crypto.randomUUID(); }}
      rows={4} maxLength={4000} placeholder="The yellow armchair was beside the window. There was a small table behind me, with a red mug on it." />
    <button type="button" className="btn compact self-start" onClick={() => { setVoiceHelp(true); input.current?.focus(); }}><AudioLines size={16} /> Use VoiceOS · Fn</button>
    {voiceHelp && <p className="muted" role="status">Keep the description field focused. Hold Fn, describe your memory, then release to insert the words. Review them before generating. VoiceOS must be running with Fn configured for dictation. You can also type here.</p>}
    <div className="notice"><Box size={20} /><div><strong>{connection?.connected ? 'Higgsfield connected' : 'Connect Higgsfield'}</strong>
      <p>{connection?.account || 'Authorize Everwhere with the Higgsfield account you want to use.'}</p>
      {!connection?.connected && <button type="button" className="btn compact" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { const result = await api<{ url: string }>(base + '/higgsfield/connect', { eventId: event.id }); location.assign(result.url); }
        catch (err) { setError((err as Error).message); setBusy(false); }
      }}>Connect account <ExternalLink size={14} /></button>}
      {connection?.connected && <button type="button" className="btn compact subtle" disabled={busy || !!active} onClick={async () => {
        setBusy(true); setError('');
        try { await api(base + '/higgsfield', {}, 'DELETE'); await refreshConnection(); }
        catch (err) { setError((err as Error).message); }
        finally { setBusy(false); }
      }}>Disconnect account</button>}
    </div></div>
    {connection && !connection.visionReady && <p className="notice">Start Ollama on the Everwhere server and install qwen3-vl:4b for photo interpretation. <button type="button" className="btn compact" onClick={refreshConnection}>Check again</button></p>}
    <label className="check-row"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
      <span>I have permission to use this photo and send its interpreted layout and these remembered details to Higgsfield.</span></label>
    <p className="muted">The scene is stored in your Higgsfield account. It estimates scale and unseen areas. Your original photo stays intact. Review the reconstruction before entering it.</p>
    {active && <p role="status" className="notice">{active.status === 'interpreting' ? 'Interpreting your photo and memory…' : active.status === 'building' ? 'Building your scene in Higgsfield…' : 'Scene generation queued…'} You can close this panel while it runs.</p>}
    {jobs[0]?.error && <p className="form-error" role="alert">{jobs[0].error}</p>}
    {jobs[0]?.status === 'failed' && <button type="button" className="btn self-start" disabled={busy || !!active} onClick={async () => {
      setBusy(true); setError('');
      try { await api(base + '/scene-jobs/' + jobs[0].id + '/resume', {}); await done(); }
      catch (err) { setError((err as Error).message); }
      finally { setBusy(false); }
    }}>Check and resume generation</button>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="btn primary self-start" disabled={busy || !!active || !consent || !sourceId || !connection?.connected || !connection?.visionReady}>
      {busy ? 'Starting…' : 'Generate immersive scene'} <ArrowRight size={16} />
    </button>
  </form>;
}
