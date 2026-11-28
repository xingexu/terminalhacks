import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, X } from 'lucide-react';
import { AsciiImage } from './ascii';
import type { View } from './model';

export type TourAction = 'capture' | 'generate' | 'voice';

// The setup in the order a new person needs it: VoiceOS first, then one memory from photo to walkable scene.
const steps: { kicker: string; title: string; text: string; note?: string; view?: View; action?: TourAction; label?: string; link?: { href: string; label: string } }[] = [
  { kicker: 'Welcome', title: 'Set up Everwhere in a few minutes.',
    text: 'This tutorial walks you through the whole setup: install VoiceOS, pair it, then turn one of your own photos into a place you can walk through.',
    note: 'Each step has a button that opens the right place for you. Close what it opens and you come straight back here.' },
  { kicker: 'First', title: 'Download VoiceOS.',
    text: 'Everwhere listens through VoiceOS, so install it before anything else. Download it on this Mac, open it from Applications, and sign in.',
    note: 'Come back here when VoiceOS is running.',
    link: { href: 'https://www.voiceos.com', label: 'Get VoiceOS' } },
  { kicker: 'Connect', title: 'Pair VoiceOS with Everwhere.',
    text: 'Open VoiceOS setup and create a pairing token. In VoiceOS go to Apps, then Custom, then Everwhere, and paste the API origin, project ID and token. Then hold your Agent Mode shortcut and ask: "What memory is open in Everwhere?"',
    note: 'A token lasts two hours. Keep Everwhere running while you use your voice.',
    action: 'voice', label: 'Open VoiceOS setup' },
  { kicker: 'Explore', title: 'This is Explore, your home.',
    text: 'Explore shows one memory at a time. The picture is drawn in characters until your cursor passes over it, and the journey timeline beside it switches between memories.',
    view: 'explore' },
  { kicker: 'Your photo', title: 'Upload your own image.',
    text: 'Open Capture, tick the permission box and choose a photo. It waits in the review inbox: pick the memory it belongs to, or make a new one, then confirm the link.',
    view: 'explore', action: 'capture', label: 'Open Capture' },
  { kicker: 'Your words', title: 'Add what you remember.',
    text: 'Choose Step inside this photo. Pick your photo as the reference, then describe the place in a few sentences. Hold Fn to dictate it with VoiceOS. Connect your Higgsfield account in the same dialog and tick the permission box.',
    note: 'This needs a photo you captured yourself, and Ollama running on the Everwhere server with qwen3-vl:4b installed.',
    view: 'explore', action: 'generate', label: 'Open Step inside this photo' },
  { kicker: 'Watch it form', title: 'Your memory takes shape.',
    text: 'Progress appears in Explore while your photo is interpreted and the scene is built. You can keep browsing. When it finishes, review the reconstruction and choose Approve.',
    view: 'explore' },
  { kicker: 'Walk through it', title: 'Step inside.',
    text: 'Choose Walk in on the finished scene. Move with W A S D, drag to look around, hold Shift to sprint and press Space to jump. Enter photo album gives you the same walk through a memory\'s photographs.',
    note: 'Remember, Watch and Create in the menu bar hold your stories, films and albums whenever you want them.',
    view: 'explore' }
];

export function Tour({ step, setStep, close, view, paused, ready, go, run }: {
  step: number; setStep: (step: number) => void; close: () => void; view: View; paused: boolean; ready: boolean;
  go: (view: View) => void; run: (action: TourAction) => void;
}) {
  const current = steps[step];
  const last = step === steps.length - 1;
  const [leaving, setLeaving] = useState(false);
  useEffect(() => { if (ready && current.view && current.view !== view) go(current.view); }, [step, ready]);
  // Fade out before unmounting.
  const leave = () => { setLeaving(true); window.setTimeout(close, 220); };
  useEffect(() => {
    if (paused) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') leave();
      if (event.key === 'ArrowRight' && !last) setStep(step + 1);
      if (event.key === 'ArrowLeft' && step > 0) setStep(step - 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [step, paused, last]);
  return <div className={'tour-backdrop' + (leaving ? ' is-leaving' : '')} hidden={paused}>
    <section className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="tour-head"><span className="tour-badge">Tutorial</span>
        <span className="tutorial-count">[{steps.map((item, index) => index <= step ? '#' : '.').join('')}] {step + 1}/{steps.length}</span>
        <button className="icon-btn" onClick={leave} aria-label="Close tutorial"><X size={18} /></button></div>
      {step === 0 && <div className="tutorial-image"><AsciiImage src="/landing/photos/lake.webp" /><img src="/landing/photos/lake.webp" alt="" /></div>}
      <div className="tour-body" key={step} aria-live="polite">
        <p className="eyebrow">{current.kicker}</p>
        <h3 id="tour-title">{current.title}</h3>
        <p>{current.text}</p>
        {current.note && <p className="tour-note">{current.note}</p>}
        {(current.action || current.link) && <div className="tour-do">
          {current.link && <a className="btn primary" href={current.link.href} target="_blank" rel="noreferrer">{current.link.label} <ExternalLink size={16} /></a>}
          {current.action && <button className="btn primary" onClick={() => run(current.action!)}>{current.label} <ArrowRight size={16} /></button>}
        </div>}
      </div>
      <div className="tour-actions">
        {step === 0 ? <button className="text-button" onClick={leave}>Skip tutorial</button> :
          <button className="text-button" onClick={() => setStep(step - 1)}><ArrowLeft size={15} /> Back</button>}
        <button className={'btn' + (current.action || current.link ? '' : ' primary')} onClick={() => last ? leave() : setStep(step + 1)}>{last ? 'Finish' : step === 0 ? 'Begin' : 'Next'} <ArrowRight size={16} /></button>
      </div>
    </section>
  </div>;
}
