import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { AsciiImage } from './ascii';
import type { View } from './model';

export type TourAction = 'library' | 'capture' | 'memory' | 'recollection' | 'film' | 'generate' | 'voice';

// Each step points at one real control. "target" is highlighted on the page; "action" presses it for the user.
const steps: { title: string; text: string; note?: string; view?: View; target?: string; action?: TourAction; label?: string }[] = [
  { title: 'Choose a project',
    text: 'A project holds one trip or chapter of your life. You start in the Dolomites sample. Open the project switcher to start a private project of your own, or to change a project\'s settings.',
    target: '.menubar > .workspace-project', action: 'library', label: 'Open projects' },
  { title: 'Capture photos, clips or a voice note',
    text: 'Capture is how anything gets in. Tick the permission box, choose files or record a note, and each item waits in the review inbox until you link it to a memory and confirm.',
    target: '.top-capture', action: 'capture', label: 'Open Capture' },
  { title: 'Give it a memory',
    text: 'A memory is one moment: a title, a place and a date. Create one here, then link captured sources to it from the inbox.',
    view: 'explore', target: '.timeline .section-heading .btn', action: 'memory', label: 'Create a memory' },
  { title: 'Explore a memory',
    text: 'Explore is home. The picture is drawn in characters until your cursor passes over it. Pick a memory in the journey timeline, then choose Enter photo album to walk through its photos with W A S D.',
    view: 'explore', target: '.hero' },
  { title: 'Remember: add your own words',
    text: 'Search your sources, answer the story prompt, or add a recollection in your own words. Every change is previewed before you confirm it.',
    view: 'remember', target: '.view-remember .section-heading .btn', action: 'recollection', label: 'Add a recollection' },
  { title: 'Watch: turn a memory into a film',
    text: 'Play the storyboard to preview, then create a 1080p film from the memory\'s sources. You approve it before it can be watched or downloaded.',
    view: 'watch', target: '.view-watch .section-heading .btn, .film-play', action: 'film', label: 'Create film' },
  { title: 'Create: albums, journal and color',
    text: 'Choose which photos go into the walkable album, read the memory as a journal, and set one color grade for the whole project under Visual DNA.',
    view: 'create', target: '.view-create .tab-set' },
  { title: 'Connection 1 of 2: Higgsfield',
    text: 'Step inside this photo builds a 3D scene you can walk through. In its dialog, choose Connect account to authorize your Higgsfield account, pick a reference photo, describe what you remember, and tick the permission box.',
    note: 'It needs an original photo you captured (the sample\'s illustrated pictures do not count) and Ollama running on the Everwhere server with qwen3-vl:4b installed.',
    view: 'explore', target: '.hero-cta', action: 'generate', label: 'Open scene setup' },
  { title: 'Connection 2 of 2: VoiceOS',
    text: 'VoiceOS lets you find memories and review changes by voice. In its dialog, create a pairing token. On your Mac open VoiceOS, go to Apps, then Custom, then Everwhere, and paste the API origin, project ID and token. Then hold your Agent Mode shortcut and ask: "What memory is open in Everwhere?"',
    note: 'Keep Everwhere running while you use it. A token lasts two hours; Revoke token cuts access at once.',
    target: '.menu-voice', action: 'voice', label: 'Open VoiceOS setup' }
];
export const tourLength = steps.length;

const meter = (step: number) => '[' + steps.map((item, index) => index <= step ? '#' : '.').join('') + '] ' + (step + 1) + '/' + steps.length;

export function Welcome({ start, skip }: { start: () => void; skip: () => void }) {
  return <div className="tutorial">
    <div className="tutorial-image">
      <AsciiImage src="/landing/photos/lake.webp" />
      <img src="/landing/photos/lake.webp" alt="" />
      <span>A private place for your memories</span>
    </div>
    <div className="tutorial-copy">
      <p className="tutorial-step">Guided tour · {steps.length} steps · about two minutes</p>
      <h3>Let me show you around.</h3>
      <p>The tour points at each control in turn and can press it for you: projects, capture, the four views, then the two connections, Higgsfield and VoiceOS.</p>
    </div>
    <ol className="tutorial-outline">{steps.map(item => <li key={item.title}>{item.title}</li>)}</ol>
    <div className="tutorial-actions">
      <button className="text-button" onClick={skip}>Skip for now</button>
      <button className="btn primary" onClick={start}>Start the tour <ArrowRight size={16} /></button>
    </div>
  </div>;
}

/** A coach card that stays out of the way while the control it describes pulses on the page. */
export function Tour({ step, setStep, close, view, paused, ready, go, run }: {
  step: number; setStep: (step: number) => void; close: () => void; view: View; paused: boolean; ready: boolean;
  go: (view: View) => void; run: (action: TourAction) => void;
}) {
  const current = steps[step];
  const [found, setFound] = useState(false);
  useEffect(() => { if (ready && current.view && current.view !== view) go(current.view); }, [step, ready]);
  useEffect(() => {
    if (paused) return;
    let target: HTMLElement | null = null;
    let tries = 0;
    let timer = 0;
    const find = () => {
      target = current.target ? document.querySelector<HTMLElement>(current.target) : null;
      if (target) {
        target.classList.add('tour-target');
        const box = target.getBoundingClientRect();
        if (box.top < 80 || box.bottom > window.innerHeight - 40) window.scrollTo({ top: Math.max(0, window.scrollY + box.top - 150), behavior: 'smooth' });
        setFound(true);
      } else if (tries++ < 12) timer = window.setTimeout(find, 150);
      else setFound(false);
    };
    find();
    return () => { window.clearTimeout(timer); target?.classList.remove('tour-target'); };
  }, [step, view, paused]);
  const last = step === steps.length - 1;
  return <aside className="tour" role="dialog" aria-label={'Guided tour, step ' + (step + 1) + ' of ' + steps.length} hidden={paused}>
    <div className="tour-head"><span className="tutorial-count">{meter(step)}</span>
      <button className="icon-btn" onClick={close} aria-label="End tour"><X size={17} /></button></div>
    <h3>{current.title}</h3>
    <p aria-live="polite">{current.text}</p>
    {current.note && <p className="tour-note">{current.note}</p>}
    {current.target && !found && <p className="tour-note">This control is not on screen right now. Use the button below to open it.</p>}
    <div className="tour-actions">
      <button className="text-button" onClick={() => setStep(step - 1)} disabled={step === 0}><ArrowLeft size={15} /> Back</button>
      <div className="button-row">
        {current.action && <button className="btn compact" onClick={() => run(current.action!)}>{current.label}</button>}
        <button className="btn compact primary" onClick={() => last ? close() : setStep(step + 1)}>{last ? 'Finish' : 'Next'} <ArrowRight size={15} /></button>
      </div>
    </div>
  </aside>;
}
