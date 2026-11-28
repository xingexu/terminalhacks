import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, X } from 'lucide-react';
import { AsciiImage } from './ascii';
import type { View } from './model';

export type TourAction = 'capture' | 'generate' | 'voice';

// The setup in the order a new person needs it: VoiceOS first, then one memory from photo to walkable scene.
const steps: { kicker: string; title: string; text: string; note?: string; view?: View; target?: string; action?: TourAction; label?: string; link?: { href: string; label: string } }[] = [
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
  { kicker: 'Menu bar', title: 'Four tabs are the whole app.',
    text: 'Explore, Remember, Watch and Create. Each one is a different way into the same memory. The next steps open them one at a time.',
    view: 'explore', target: '.menu' },
  { kicker: 'Tab 1 of 4', title: 'This is Explore, your home.',
    text: 'This is the sample memory, Place Saint-Bernard in Mont-Tremblant. The picture is drawn in characters: move your cursor over it and the photograph shows through. Try it now.',
    view: 'explore', target: '.hero' },
  { kicker: 'Explore', title: 'This is your journey timeline.',
    text: 'Every memory in the project, in order. Click one and Explore switches to it. New memory adds a moment with a title, place and date.',
    view: 'explore', target: '.timeline' },
  { kicker: 'Tab 2 of 4', title: 'Remember holds your words.',
    text: 'Search your photos and notes, answer the story prompt, or add a recollection in your own words. Every change is previewed before you confirm it.',
    view: 'remember', target: '.menu button:nth-child(2)' },
  { kicker: 'Tab 3 of 4', title: 'Watch turns a memory into a film.',
    text: 'Press play to preview the storyboard, then choose Create film to render a 1080p film from the memory\'s photos. You approve it before it can be watched or downloaded.',
    view: 'watch', target: '.menu button:nth-child(3)' },
  { kicker: 'Tab 4 of 4', title: 'Create is your studio.',
    text: 'Choose which photos go into the walkable album, read the memory as a journal, and set one color grade for the whole project under Visual DNA.',
    view: 'create', target: '.menu button:nth-child(4)' },
  { kicker: 'Your photo', title: 'Upload your own image.',
    text: 'Open Capture, tick the permission box and choose a photo. It waits in the review inbox: pick the memory it belongs to, or make a new one, then confirm the link.',
    view: 'explore', target: '.top-capture', action: 'capture', label: 'Open Capture' },
  { kicker: 'Walk through it', title: 'Step inside the real place.',
    text: 'Choose Enter memory world. Everwhere opens Google Street View at Place Saint-Bernard. W and S move along the street, A and D turn, and you can drag to look around.',
    note: 'Street View needs a Google Maps key in apps/web/.env.local. Without one, Open photo album still shows the memory\'s pictures.',
    view: 'explore', target: '.hero .hero-cta' },
  { kicker: 'By voice', title: 'Ask VoiceOS to move.',
    text: 'With VoiceOS paired, hold your Agent Mode shortcut and say "go forward", "turn left" or "stop". Name a stop, such as the lower village, to go straight there.',
    note: 'Remember, Watch and Create in the menu bar hold your stories, films and albums whenever you want them.',
    view: 'explore', target: '.hero' }
];

export function Tour({ step, setStep, close, view, paused, ready, go, run }: {
  step: number; setStep: (step: number) => void; close: () => void; view: View; paused: boolean; ready: boolean;
  go: (view: View) => void; run: (action: TourAction) => void;
}) {
  const current = steps[step];
  const last = step === steps.length - 1;
  const [leaving, setLeaving] = useState(false);
  useEffect(() => { if (ready && current.view && current.view !== view) go(current.view); }, [step, ready]);
  // Steps that describe something on the page step aside and light it up, so the real thing can be seen and used.
  const [spot, setSpot] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useEffect(() => {
    setSpot(null);
    if (paused || !current.target) return;
    let element: HTMLElement | null = null;
    let tries = 0;
    let timer = 0;
    const measure = () => {
      if (!element?.isConnected) element = document.querySelector<HTMLElement>(current.target!);
      if (!element) { if (tries++ < 15) timer = window.setTimeout(measure, 150); return; }
      const box = element.getBoundingClientRect();
      setSpot(old => old && old.top === box.top && old.left === box.left && old.width === box.width && old.height === box.height ? old :
        { top: box.top, left: box.left, width: box.width, height: box.height });
      timer = window.setTimeout(measure, 200);
    };
    const start = window.setTimeout(() => {
      document.querySelector<HTMLElement>(current.target!)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      measure();
    }, 120);
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { window.clearTimeout(start); window.clearTimeout(timer); window.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, [step, view, paused]);
  const docked = !!current.target;
  const side = spot && spot.left + spot.width / 2 > window.innerWidth / 2 ? ' dock-left' : '';
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
  return <div className={'tour-backdrop' + (leaving ? ' is-leaving' : '') + (docked ? ' is-docked' + side : '')} hidden={paused}>
    {docked && spot && <div className="tour-spot" style={{ top: spot.top - 8, left: spot.left - 8, width: spot.width + 16, height: spot.height + 16 }} />}
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
