import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ExternalLink, Globe, RefreshCw, Sparkles } from 'lucide-react';
import { ApiError, api, sourceURL, type Environment, type GenerationEvidence, type Memory, type Season, type Snapshot, type WorldPreview } from './model';
import './generation.css';

function timestamp(value: string | null, local?: string | null) {
  if (!value && local) return local.replace('T', ' · ') + ' · Timezone unknown';
  if (!value || Number.isNaN(new Date(value).getTime())) return 'Date or timezone unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
const coordinates = (value?: [number, number] | null) => value ? value.map(item => item.toFixed(2)).join(', ') : 'No coordinates';

function Evidence({ value, project, state }: { value: GenerationEvidence; project: string; state: Snapshot }) {
  return <section className="generation-evidence" aria-labelledby="generation-evidence-title">
    <h3 id="generation-evidence-title">What this world is based on</h3>
    <dl className="generation-facts"><div><dt>Memory date</dt><dd>{timestamp(value.startAt)}</dd></div>
      <div><dt>Place</dt><dd>{value.placeLabel || 'Unknown location'}</dd></div>
      <div><dt>Memory coordinates</dt><dd>{coordinates(value.gps)}</dd></div></dl>
    <p className="muted">Times with a known timezone are displayed in your timezone; other times stay as recorded. Coordinates below are rounded. Metadata offers context, not proof of what happened.</p>
    {value.story && <div className="generation-account"><strong>Your memory description</strong><p>{value.story}</p></div>}
    <details><summary>Linked sources ({value.media.length})</summary>
      {value.media.length ? <ul className="generation-sources">{value.media.map(item => <li key={item.id}>
        {item.mime.startsWith('image/') && <img src={sourceURL(project, item.id, '?variant=thumb')} alt="" width="64" height="64" loading="lazy" />}
        <div><strong>{item.caption || 'Untitled source'}</strong><small>{item.provenance === 'original' ? 'Original source' : 'Imagined source'} · {timestamp(item.capturedAt, item.capturedLocal)}</small>
          <small>GPS: {coordinates(item.gps)}</small></div>
      </li>)}</ul> : <p>No sources are linked. Add an original photo through Capture first.</p>}
    </details>
    <details><summary>Personal recollections ({value.recollections.length})</summary>
      {value.recollections.length ? value.recollections.map(item => <blockquote className="generation-account" key={item.id}>
        <p>{item.text}</p><cite>{state.recollections.find(account => account.id === item.id)?.contributor || 'Contributor'} · Recollection{item.audioMediaId ? ' · Linked voice note' : ''}</cite>
      </blockquote>) : <p>No recollections yet. You can add one through Stories or VoiceOS before generating.</p>}
    </details>
    <div className="generation-unknowns"><strong>What remains uncertain</strong><ul>{value.unknowns.map(item => <li key={item}>{item}</li>)}</ul></div>
  </section>;
}

function ResearchSources({ value }: { value: GenerationEvidence['research'] }) {
  if (!value) return <p className="muted">Optional. You can generate using only your own sources and recollections.</p>;
  return <div className="generation-research"><p className="muted">{value.provider} · Retrieved {timestamp(value.fetchedAt)}. Place context is not evidence of your personal experience.</p>
    {value.articles.length ? value.articles.map(article => <article key={article.url}>
      <h4><a href={/^https:\/\/en\.wikipedia\.org\//.test(article.url) ? article.url : undefined} target="_blank" rel="noreferrer">{article.title} <ExternalLink size={13} aria-hidden="true" /></a></h4>
      <p>{article.extract}</p>
    </article>) : <p>No matching articles were found. Continue with your recollection or correct the place in the memory.</p>}
    <small>{value.attribution}</small>
  </div>;
}

export function Generation({ state, event, base, onGenerated, onCorrect, onRefresh }: {
  state: Snapshot; event: Memory; base: string; onGenerated: () => Promise<void>; onCorrect: () => void; onRefresh: () => Promise<void>;
}) {
  const [evidence, setEvidence] = useState<{ value: GenerationEvidence; revision: number; seq: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [environment, setEnvironment] = useState<Environment>('open');
  const [season, setSeason] = useState<Season>('green');
  const [consent, setConsent] = useState(false);
  const [preview, setPreview] = useState<WorldPreview | null>(null);
  const [busy, setBusy] = useState<'research' | 'preview' | 'generate' | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [created, setCreated] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const selectionEdited = useRef(false);
  const attempt = useRef<{ requestId: string; previewToken: string; expectedRevision: number } | null>(null);
  const inFlight = useRef(false);
  const version = useRef({ revision: state.revision, seq: state.seq });
  version.current = { revision: state.revision, seq: state.seq };
  const errorRef = useRef<HTMLParagraphElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setConsent(false); setLoadError('');
    if (!attempt.current) setPreview(null);
    void api<GenerationEvidence>(base + '/memories/' + event.id + '/evidence').then(value => {
      if (!active) return;
      setEvidence({ value, revision: state.revision, seq: state.seq });
      if (!selectionEdited.current) { setEnvironment(value.suggestion.environment); setSeason(value.suggestion.season); }
    }).catch(err => { if (active) { setEvidence(null); setLoadError((err as Error).message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [base, event.id, state.revision, state.seq, reload]);
  const visibleError = loadError || error;
  useEffect(() => { if (visibleError) errorRef.current?.focus(); }, [visibleError]);
  useEffect(() => {
    if (!preview) return;
    previewRef.current?.focus();
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);
  const current = evidence && evidence.revision === state.revision && evidence.seq === state.seq;
  const expired = !!preview && Date.parse(preview.expires) <= clock;
  const hasPhoto = evidence?.value.media.some(item => item.provenance === 'original' && item.mime.startsWith('image/'));
  async function run(kind: NonNullable<typeof busy>, work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(kind); setError('');
    try { await work(); } catch (err) { setError((err as Error).message); }
    finally { inFlight.current = false; setBusy(null); }
  }
  async function generate() {
    if (!preview) return;
    attempt.current ??= { requestId: crypto.randomUUID(), previewToken: preview.previewToken, expectedRevision: preview.plan.revision };
    try {
      await api(base + '/world-jobs', attempt.current);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // A definitive rejection cannot be recovered by replaying this preview.
        attempt.current = null; setPreview(null); setEvidence(null);
        await onRefresh();
        setReload(value => value + 1);
        throw new Error(err.message + ' Review the refreshed evidence and preview again.');
      }
      throw err;
    }
    setCreated(true);
    await onGenerated();
  }
  if (created) return <div className="form-stack generation"><div className="notice" role="status"><Check size={20} aria-hidden="true" /><p>Your imagined world is ready for approval. Originals only must be off to view it.</p></div>
    {error && <p className="form-error" ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
    <button className="btn primary" disabled={!!busy} onClick={() => void run('generate', onGenerated)}>Return to approval <ArrowRight size={16} aria-hidden="true" /></button></div>;
  return <div className="form-stack generation" aria-busy={loading || !!busy}>
    <p>Turn the details of <strong>{event.title}</strong> into a walkable, imagined world. Review the evidence and surroundings first.</p>
    <p className="generation-label">Imagined · Procedural surroundings, not a measured reconstruction</p>
    <button className="btn self-start" disabled={!!busy || !!attempt.current} onClick={onCorrect}>Correct memory details</button>
    {loading ? <p role="status">Loading memory evidence…</p> : evidence && <>
      <Evidence value={evidence.value} project={state.projectId} state={state} />
      <section className="generation-section" aria-labelledby="generation-research-title"><h3 id="generation-research-title">Optional place context</h3>
        <ResearchSources value={evidence.value.research} />
        <p>Research sends this place query and available rounded coordinates to Wikipedia. Photos and recollections stay on this server.</p>
        <dl className="generation-facts"><div><dt>Place query</dt><dd>{evidence.value.lookup.query || 'No named place'}</dd></div>
          <div><dt>Rounded coordinates</dt><dd>{coordinates(evidence.value.lookup.coordinates)}</dd></div></dl>
        <label className="check-row"><input name="placeResearchConsent" type="checkbox" checked={consent} disabled={!!busy || !!attempt.current} onChange={e => setConsent(e.target.checked)} />
          <span>Allow this place lookup with Wikipedia.</span></label>
        <button className="btn self-start" disabled={!consent || !!busy || !current || !!attempt.current} onClick={() => void run('research', async () => {
          await api(base + '/memories/' + event.id + '/place-context', { expectedRevision: evidence.revision, consent: true });
          setPreview(null); setReload(value => value + 1);
        })}><Globe size={16} aria-hidden="true" />{busy === 'research' ? 'Researching place…' : evidence.value.research ? 'Refresh place context' : 'Research this place'}</button>
      </section>
      <section className="generation-section" aria-labelledby="generation-surroundings-title"><h3 id="generation-surroundings-title">Choose the imagined surroundings</h3>
        <p className="muted">Suggestion based on: {evidence.value.suggestion.basis}. Change either choice to match your intention.</p>
        <div className="form-columns"><label>Environment<select name="environment" value={environment} disabled={!!busy || !!attempt.current} onChange={e => { selectionEdited.current = true; setEnvironment(e.target.value as Environment); setPreview(null); }}>
          <option value="mountain">Mountains</option><option value="coast">Coast or lakeside</option><option value="forest">Forest</option><option value="urban">Urban</option><option value="open">Open landscape</option>
        </select></label><label>Season<select name="season" value={season} disabled={!!busy || !!attempt.current} onChange={e => { selectionEdited.current = true; setSeason(e.target.value as Season); setPreview(null); }}>
          <option value="green">Green</option><option value="snow">Snow</option><option value="autumn">Autumn</option>
        </select></label></div>
        {!hasPhoto && <p className="notice">Link at least one original photo through Capture to generate a world. Imagined sample images do not qualify.</p>}
        {!attempt.current && <button className="btn primary self-start" disabled={!!busy || !current || !hasPhoto} onClick={() => void run('preview', async () => {
          const result = await api<WorldPreview>(base + '/world-preview', { eventId: event.id, expectedRevision: evidence.revision, environment, season });
          if (version.current.revision !== evidence.revision || version.current.seq !== evidence.seq) throw new Error('The memory changed. Review its refreshed evidence and preview again.');
          setClock(Date.now()); setPreview(result);
        })}>{busy === 'preview' ? 'Preparing preview…' : preview ? 'Refresh preview' : 'Preview memory world'} <ArrowRight size={16} aria-hidden="true" /></button>}
      </section>
    </>}
    {preview && <section className="generation-preview" ref={previewRef} tabIndex={-1} aria-labelledby="generation-preview-title">
      <h3 id="generation-preview-title">Review your imagined world</h3><p>{preview.diff.text}</p>
      <p><strong>{preview.plan.title}</strong> · {preview.plan.environment} · {preview.plan.season}</p>
      <p className="muted">Original photos remain unchanged. This creates a procedural scene for separate approval, not historical footage or a scan.</p>
      <p className="muted">{expired ? 'Preview expired. Refresh the preview before starting a new generation.' : 'Preview expires at ' + new Date(preview.expires).toLocaleTimeString()} · Revision {preview.plan.revision}</p>
      {attempt.current && <p className="muted">Retry sends the same generation request so a completed world is returned without creating another one.</p>}
      <button className="btn primary self-start" disabled={!!busy || (!attempt.current && (expired || !current || loading))} onClick={() => void run('generate', generate)}>
        <Sparkles size={16} aria-hidden="true" />{busy === 'generate' ? 'Generating imagined world…' : attempt.current ? 'Retry generation request' : 'Generate imagined world'}</button>
    </section>}
    {busy && <p className="muted" role="status">{busy === 'research' ? 'Looking up public place context…' : busy === 'preview' ? 'Preparing your review…' : 'Creating the scene and refreshing your memory…'}</p>}
    {visibleError && <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{visibleError}</p>}
    {!loading && !evidence && <button className="btn self-start" disabled={!!busy} onClick={() => void run('preview', async () => { await onRefresh(); setReload(value => value + 1); })}><RefreshCw size={16} aria-hidden="true" /> Retry loading evidence</button>}
  </div>;
}
