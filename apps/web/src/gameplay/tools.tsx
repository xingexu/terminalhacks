import { useEffect, useState } from 'react';
import { api } from '../model';
import type { Context } from './contracts';
import type { PathRecorder } from './path';
import type { FrameMetrics } from './performance';

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
  details: () => { renderer: string; width: number; height: number; geometries: number; textures: number };
};

export function RuntimeTools({ runtime, contextURL, focus }: { runtime: RuntimeControls | null; contextURL?: string; focus: () => void }) {
  const [, update] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const timer = setInterval(() => update(value => value + 1), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { setPaused(false); setError(''); }, [runtime]);
  if (!runtime) return null;
  const recorder = runtime.recorder;
  const stats = runtime.metrics.read();
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); update(value => value + 1); }
  }
  return <details className="runtime-tools"><summary>Scene tools</summary><div>
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
    <p>Virtual camera motion · maximum 60 seconds</p>
    {!contextURL && <p>Select a single memory to export its camera path.</p>}
    {(error || recorder.message) && <p role="status">{error || recorder.message}</p>}
    <details><summary>Performance</summary>
      <p>{stats.frames} frames · {stats.elapsedSeconds.toFixed(1)}s measured</p>
      <p>Median {stats.medianFps.toFixed(1)} FPS · p95 {stats.p95FrameMs.toFixed(1)} ms</p>
      <p>{runtime.details().renderer} · {runtime.details().width} × {runtime.details().height}</p>
      <p>{runtime.details().geometries} geometries · {runtime.details().textures} textures</p>
      <button onClick={() => runtime.metrics.reset()}>Restart measurement</button>
    </details>
  </div></details>;
}
