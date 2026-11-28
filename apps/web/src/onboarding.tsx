import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, X } from 'lucide-react';
import { AsciiImage } from './ascii';
import type { View } from './model';

export type TourAction = 'capture' | 'voice';

// Introduce the workspace before offering capture and optional voice setup.
const steps: { kicker: string; title: string; text: string; note?: string; view?: View; target?: string; action?: TourAction; label?: string; link?: { href: string; label: string } }[] = [
  { kicker: 'Welcome to Everwhere', title: 'Keep the moments that stay with you.',
    text: 'Bring your photos, places and stories together. Take a quick look around, then start with a memory of your own.',
    note: 'You can skip this tour and reopen it anytime with the help button in the menu bar.' },
  { kicker: 'Explore', title: 'A place to come back to.',
    text: 'Explore is your home. Open a memory to see its photos and place. On a computer, move over the ASCII picture to reveal the photograph.',
    note: 'The menu bar takes you to Explore, Remember, Watch and Create.',
    view: 'explore', target: '.hero' },
  { kicker: 'Your timeline', title: 'One moment leads to another.',
    text: 'Choose a memory in the timeline to revisit it. Use New memory to add a title, place and date for another moment.',
    view: 'explore', target: '.timeline' },
  { kicker: 'Remember', title: 'Keep the story behind the photo.',
    text: 'Search photos and notes, answer a story prompt, or add a recollection in your own words. Review your changes before confirming them.',
    view: 'remember', target: '.menu button:nth-child(2)' },
  { kicker: 'Watch', title: 'See the moments together.',
    text: 'Play the storyboard to preview the sequence. Choose Create film to render a film from the memory\'s media, then review and approve it to watch or download.',
    view: 'watch', target: '.menu button:nth-child(3)' },
  { kicker: 'Create', title: 'Make it your own.',
    text: 'Browse photo and video albums, choose photos for an immersive album, or read the memory as a journal. Visual DNA sets the color grade across your project.',
    view: 'create', target: '.menu button:nth-child(4)' },
  { kicker: 'Capture', title: 'Start with something you kept.',
    text: 'Open Capture, confirm permission and choose your photos or clips. Review each item, select the memory it belongs to, then confirm the link.',
    note: 'Close Capture to continue the tour. Use the project picker beside the logo to start a private collection.',
    view: 'explore', target: '.top-capture', action: 'capture', label: 'Open Capture' },
  { kicker: 'Optional · VoiceOS', title: 'Tell it in your own voice.',
    text: 'Type your memories, or use VoiceOS on Mac. Open VoiceOS from Applications, focus a text field here and hold Fn to dictate. Review the words before continuing.',
    note: 'For voice commands, open Apps → Custom → Everwhere in VoiceOS and enter the connection details from setup.',
    view: 'explore', target: '.menu-actions', action: 'voice', label: 'Set up VoiceOS',
    link: { href: 'https://www.voiceos.com', label: 'Get VoiceOS' } }
];

export function Tour({ step, setStep, close, view, paused, ready, go, run }: {
  step: number; setStep: (step: number) => void; close: () => void; view: View; paused: boolean; ready: boolean;
  go: (view: View) => void; run: (action: TourAction) => void;
}) {
  const current = steps[step];
  const last = step === steps.length - 1;
  const [leaving, setLeaving] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeTimer = useRef(0);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      window.clearTimeout(closeTimer.current);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!paused) panel.current?.querySelector<HTMLElement>('#tour-title')?.focus({ preventScroll: true });
  }, [step, paused]);
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
      window.clearTimeout(timer);
      if (!element?.isConnected) element = document.querySelector<HTMLElement>(current.target!);
      if (!element) { if (tries++ < 15) timer = window.setTimeout(measure, 150); return; }
      const box = element.getBoundingClientRect();
      setSpot(old => old && old.top === box.top && old.left === box.left && old.width === box.width && old.height === box.height ? old :
        { top: box.top, left: box.left, width: box.width, height: box.height });
      timer = window.setTimeout(measure, 200);
    };
    const start = window.setTimeout(() => {
      document.querySelector<HTMLElement>(current.target!)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      measure();
    }, 120);
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => { window.clearTimeout(start); window.clearTimeout(timer); window.removeEventListener('scroll', measure); window.removeEventListener('resize', measure); };
  }, [step, view, paused]);
  const docked = !!current.target;
  const side = spot && spot.left + spot.width / 2 > window.innerWidth / 2 ? ' dock-left' : '';
  // Fade out before unmounting.
  const leave = () => {
    if (closeTimer.current) return;
    setLeaving(true);
    closeTimer.current = window.setTimeout(close, 220);
  };
  useEffect(() => {
    if (paused || leaving) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); leave(); }
      if (event.key === 'Tab' && !docked) {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? []);
        const first = buttons[0];
        const end = buttons.at(-1);
        if (!buttons.includes(document.activeElement as HTMLElement) || document.activeElement === (event.shiftKey ? first : end)) {
          event.preventDefault();
          (event.shiftKey ? end : first)?.focus();
        }
      }
      if (!panel.current?.contains(event.target as Node)) return;
      if (event.key === 'ArrowRight' && !last) { event.preventDefault(); setStep(step + 1); }
      if (event.key === 'ArrowLeft' && step > 0) { event.preventDefault(); setStep(step - 1); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [step, paused, last, docked, leaving]);
  return <div className={'tour-backdrop' + (leaving ? ' is-leaving' : '') + (docked ? ' is-docked' + side : '') + (current.target === '.timeline' ? ' dock-top' : '')} hidden={paused}>
    {docked && spot && <div className="tour-spot" aria-hidden="true" style={{ top: spot.top - 8, left: spot.left - 8, width: spot.width + 16, height: spot.height + 16 }} />}
    <section ref={panel} className="tour" role="dialog" aria-modal={!docked} aria-labelledby="tour-title" aria-describedby="tour-description">
      <div className="tour-head"><span className="tour-badge">Quick tour</span>
        <span className="tutorial-count" aria-label={`Step ${step + 1} of ${steps.length}`}>[{steps.map((item, index) => index <= step ? '#' : '.').join('')}] {step + 1}/{steps.length}</span>
        <button className="icon-btn" onClick={leave} aria-label="Close tutorial"><X size={18} /></button></div>
      {step === 0 && <div className="tutorial-image"><AsciiImage src="/landing/photos/lake.webp" /><img src="/landing/photos/lake.webp" alt="" /></div>}
      <div className="tour-body" key={step} aria-live="polite">
        <p className="eyebrow">{current.kicker}</p>
        <h3 id="tour-title" tabIndex={-1}>{current.title}</h3>
        <p id="tour-description">{current.text}</p>
        {current.note && <p className="tour-note">{current.note}</p>}
        {(current.action || current.link) && <div className="tour-do">
          {current.action && <button className="btn primary" onClick={() => run(current.action!)}>{current.label} <ArrowRight size={16} /></button>}
          {current.link && <a className="btn" href={current.link.href} target="_blank" rel="noreferrer">{current.link.label} <ExternalLink size={16} /></a>}
        </div>}
      </div>
      <div className="tour-actions">
        {step === 0 ? <button className="text-button" onClick={leave}>Skip tutorial</button> :
          <button className="text-button" onClick={() => setStep(step - 1)}><ArrowLeft size={15} /> Back</button>}
        <button className={'btn' + (current.action || current.link ? '' : ' primary')} onClick={() => last ? leave() : setStep(step + 1)}>{last ? 'Start exploring' : step === 0 ? 'Show me around' : 'Next'} <ArrowRight size={16} /></button>
      </div>
    </section>
  </div>;
}
