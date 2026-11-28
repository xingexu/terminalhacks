import { useEffect, useRef, useState } from 'react';
import { api, sourceURL, type Job, type Proposal } from '../model';
import type { Context } from './contracts';
import type { PathRecorder } from './path';
import type { FrameMetrics } from './performance';

async function discardFilm(base: string, token: string, requestId: string) {
  const response = await fetch('/v1' + base + '/scene-films/' + token + '/cancel', {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId })
  });
  if (!response.ok) throw new Error('Film cancellation could not reach the server.');
}

export type RuntimeControls = {
  recorder: PathRecorder;
  metrics: FrameMetrics;
  canRecord: () => boolean;
  replay: () => void;
  stopReplay: () => void;
  setPaused: (value: boolean) => void;
  setReducedMotion: (value: boolean) => void;
  setQuality: (value: 'standard' | 'low') => void;
  setCreativeLighting: (value: 'sunset' | 'daylight') => void;
  captureFilm?: (signal: AbortSignal, progress: (seconds: number) => void) => Promise<Blob>;
  cancelFilm?: (message: string) => void;
  details: () => { renderer: string; width: number; height: number; geometries: number; textures: number };
};

export function RuntimeTools({ runtime, contextURL, focus, revision, filmBase, onFilmBusy }: {
  runtime: RuntimeControls | null; contextURL?: string; focus: () => void;
  revision?: number; filmBase?: string; onFilmBusy?: (busy: boolean) => void;
}) {
  const [, update] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [review, setReview] = useState<{ proposal: Proposal; context: Context; pathId: string } | null>(null);
  const [filmStage, setFilmStage] = useState<'reviewing' | 'recording' | 'uploading' | null>(null);
  const [filmSeconds, setFilmSeconds] = useState(0);
  const [filmSaved, setFilmSaved] = useState(false);
  const operation = useRef<{ controller: AbortController; requestId: string; base: string; token?: string } | null>(null);
  const mounted = useRef(true);
  const runSequence = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  async function cancelFilm(message = 'Film cancelled. You can review the path and try again.') {
    const pending = operation.current;
    operation.current = null;
    runSequence.current += 1;
    pending?.controller.abort();
    runtime?.cancelFilm?.(message);
    if (mounted.current) { setReview(null); setFilmStage(null); setError(message); setBusy(false); }
    onFilmBusy?.(false);
    if (pending?.token) {
      try { await discardFilm(pending.base, pending.token, pending.requestId); }
      catch { if (mounted.current && !operation.current) setError(message + ' Cancellation could not reach the server. Check Watch before retrying; no film is approved automatically.'); }
    }
  }
  useEffect(() => {
    const timer = setInterval(() => update(value => value + 1), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    mounted.current = true;
    setPaused(false); setError('');
    return () => { mounted.current = false; void cancelFilm('Scene closed. The unfinished recording was discarded.'); };
  }, [runtime]);
  useEffect(() => {
    if (review && review.context.revision !== revision) void cancelFilm('Memory updated. Record and review a new camera path.');
  }, [revision, review]);
  useEffect(() => { if (review && !filmStage) reviewHeading.current?.focus(); }, [review, filmStage]);
  useEffect(() => { if (error) errorElement.current?.focus(); }, [error]);
  useEffect(() => {
    const hidden = () => { if (document.hidden && filmStage === 'recording' && operation.current) void cancelFilm('Recording stopped because the page was hidden. Keep this page visible and try again.'); };
    const leaving = (event: BeforeUnloadEvent) => { if (filmStage) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('beforeunload', leaving);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('beforeunload', leaving); };
  }, [filmStage]);
  if (!runtime) return null;
  const recorder = runtime.recorder;
  const stats = runtime.metrics.read();
  const duration = recorder.path?.keyframes.at(-1)?.t ?? 0;
  const filmLocked = Boolean(filmStage || review);
  async function run(action: () => Promise<void>) {
    const sequence = ++runSequence.current;
    setBusy(true); setError('');
    try { await action(); } catch (err) { if (mounted.current && sequence === runSequence.current) setError((err as Error).message); }
    finally { if (mounted.current && sequence === runSequence.current) { setBusy(false); update(value => value + 1); } }
  }
  return <details className="runtime-tools"><summary>Scene tools</summary><div>
    <fieldset disabled={filmLocked}>
    <button onClick={() => { runtime.setPaused(!paused); setPaused(!paused); }}>{paused ? 'Resume' : 'Pause'}</button>
    <label><input type="checkbox" checked={reduced} onChange={event => {
      setReduced(event.target.checked); runtime.setReducedMotion(event.target.checked);
    }} /> Reduced motion</label>
    <label>Rendering<select defaultValue="standard" onChange={event => runtime.setQuality(event.target.value as 'standard' | 'low')}>
      <option value="standard">Standard</option><option value="low">Lower resolution</option></select></label>
    <label>Artistic lighting<select defaultValue="sunset" onChange={event => runtime.setCreativeLighting(event.target.value as 'sunset' | 'daylight')}>
      <option value="sunset">Warm</option><option value="daylight">Daylight</option></select></label>
    <div className="runtime-record">
      <button disabled={busy || paused || (!recorder.recording && (!contextURL || !runtime.canRecord()))} onClick={() => void run(async () => {
        if (recorder.recording) recorder.stop();
        else {
          const context = await api<Context>(contextURL!);
          if (!runtime.canRecord()) throw new Error('Return to walking before recording.');
          recorder.start(context); focus();
        }
      })}>{recorder.recording ? 'Stop recording' : 'Record camera path'}</button>
      <button disabled={!recorder.path || recorder.recording || paused} onClick={() => {
        if (recorder.playing) runtime.stopReplay(); else runtime.replay();
        focus(); update(value => value + 1);
      }}>{recorder.playing ? 'Stop replay' : 'Replay path'}</button>
      <button disabled={!recorder.path || busy || !contextURL || recorder.recording} onClick={() => void run(async () => {
        const context = await api<Context>(contextURL!);
        const data = recorder.export(context);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = 'everwhere-camera-path.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>Export path</button>
    </div>
    </fieldset>
    <p>Virtual camera motion · maximum 60 seconds</p>
    {runtime.captureFilm && filmBase && <section className="scene-film-tools" aria-label="Record a scene film">
      <h3>Film this world</h3>
      <p>Record a 30–60 second camera path, replay it to check the route, then review its source references and narration.</p>
      {!review && !filmStage && <button disabled={busy || paused || recorder.recording || recorder.playing || duration < 30 || duration > 60 || !contextURL}
        onClick={() => void run(async () => {
          const pending = { controller: new AbortController(), requestId: crypto.randomUUID(), base: filmBase, token: undefined as string | undefined };
          operation.current = pending; setFilmStage('reviewing'); setFilmSaved(false);
          try {
            const context = await api<Context>(contextURL!);
            const path = recorder.export(context);
            const proposal = await api<Proposal>(filmBase + '/scene-film-preview', { expectedRevision: context.revision, path });
            pending.token = proposal.previewToken;
            if (operation.current !== pending || pending.controller.signal.aborted) {
              await discardFilm(filmBase, proposal.previewToken, pending.requestId);
              return;
            }
            setReview({ proposal, context, pathId: path.cameraPath.id });
          } finally { if (operation.current === pending) setFilmStage(null); }
        })}>Review scene film</button>}
      {duration > 0 && duration < 30 && <p>Current path: {duration.toFixed(1)} seconds. Record at least 30 seconds to make a film.</p>}
      {review && !filmStage && <div className="scene-film-review">
        <h4 tabIndex={-1} ref={reviewHeading}>Review the scene recording</h4>
        <p><strong>{review.proposal.diff.recording?.worldTitle}</strong> · {review.proposal.diff.recording?.provenance === 'imagined' ? 'Imagined interpretation' : 'Reconstructed world'}</p>
        <p>{review.proposal.diff.storyboard?.durationSeconds.toFixed(1)} seconds · 1920 × 1080. Footage follows your recorded camera path. The source references below guide captions and narration; they do not identify exactly what the camera is looking at.</p>
        <ol aria-label="Scene film source references">{review.proposal.diff.storyboard?.frames.map(item => <li key={item.sourceId}>
          <strong>{item.caption}</strong> · {item.seconds.toFixed(1)}s · {item.provenance === 'original' ? 'Original source' : 'Imagined source'}
          {item.recollection && <blockquote>{item.recollection.text}<br /><small>{item.recollection.contributor} · Recollection{item.recollection.excerpt ? ' excerpt' : ''}</small></blockquote>}
        </li>)}</ol>
        {review.proposal.diff.storyboard?.narration && <section aria-label="Scene film narration">
          <p>The first {review.proposal.diff.storyboard.narration.seconds.toFixed(1)} seconds of this original note play at {review.proposal.diff.storyboard.narration.startSeconds.toFixed(1)} seconds in the film.</p>
          <audio controls preload="none" aria-label="Preview scene film voice note" src={sourceURL(review.context.projectId, review.proposal.diff.storyboard.narration.sourceId, '?variant=playback')} />
        </section>}
        <p>Keep this page visible while it records. Afterwards, review and approve the film separately in Watch.</p>
        <button onClick={() => { if (recorder.playing) runtime.stopReplay(); else runtime.replay(); update(value => value + 1); }}>{recorder.playing ? 'Stop review replay' : 'Replay camera path for review'}</button>
        <button className="walk-primary" onClick={() => void run(async () => {
          const pending = operation.current;
          if (!pending?.token || pending.controller.signal.aborted) throw new Error('Review the scene film again.');
          onFilmBusy?.(true); setFilmSeconds(0); setFilmStage('recording');
          try {
            const remaining = Date.parse(review.proposal.expires ?? '') - Date.now();
            if (!Number.isFinite(remaining) || remaining < (duration + 150) * 1000) throw new Error('This review is expiring. Review the scene film again before recording.');
            const context = await api<Context>(contextURL!);
            const path = recorder.export(context);
            if (path.cameraPath.id !== review.pathId || operation.current !== pending) throw new Error('The camera path changed. Review it again.');
            const blob = await runtime.captureFilm!(pending.controller.signal, seconds => setFilmSeconds(Math.floor(seconds * 10) / 10));
            if (operation.current !== pending || pending.controller.signal.aborted) return;
            setFilmStage('uploading');
            const form = new FormData(); form.append('file', blob, 'everwhere-scene.webm');
            const response = await fetch('/v1' + filmBase + '/scene-films/' + pending.token, {
              method: 'POST', body: form, headers: { 'X-Request-Id': pending.requestId }, signal: pending.controller.signal
            });
            const result = await response.json() as { ok: boolean; message?: string; data: Job };
            if (!response.ok || !result.ok) throw new Error(result.message || 'The recording could not be saved. Review and try again.');
            if (operation.current !== pending) return;
            operation.current = null; setReview(null); setFilmStage(null); setFilmSaved(true); setError(''); onFilmBusy?.(false);
          } catch (error) {
            if (operation.current === pending) await cancelFilm((error as Error).message);
          }
        })}>Record 1080p film</button>
      </div>}
      {filmStage && <p role="status">{filmStage === 'reviewing' ? 'Preparing the scene-film review…' : filmStage === 'recording' ? 'Recording scene: ' + filmSeconds.toFixed(1) + ' seconds…' : 'Saving the scene recording…'}</p>}
      {(review || filmStage) && <button onClick={() => void cancelFilm()}>Cancel film</button>}
      {filmSaved && <p role="status">Recording saved for processing. <a href={'/p/' + filmBase.split('/').at(-1) + '/watch'}>Open Watch to review and approve it.</a></p>}
    </section>}
    {!contextURL && <p>Select a single memory to export its camera path.</p>}
    {(error || recorder.message) && <p ref={errorElement} tabIndex={error ? -1 : undefined} role={error ? 'alert' : 'status'}>{error || recorder.message}</p>}
    <details><summary>Performance</summary>
      <p>{stats.frames} frames · {stats.elapsedSeconds.toFixed(1)}s measured</p>
      <p>Median {stats.medianFps.toFixed(1)} FPS · p95 {stats.p95FrameMs.toFixed(1)} ms</p>
      <p>{runtime.details().renderer} · {runtime.details().width} × {runtime.details().height}</p>
      <p>{runtime.details().geometries} geometries · {runtime.details().textures} textures</p>
      <button onClick={() => runtime.metrics.reset()}>Restart measurement</button>
    </details>
  </div></details>;
}
