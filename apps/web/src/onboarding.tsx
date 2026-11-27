import { useState } from 'react';
import { ArrowLeft, ArrowRight, AudioLines, Camera, Check, Compass } from 'lucide-react';

const steps = [
  { title: 'Keep the moment.', text: 'Start a private project, then use Capture to add selected photos, clips, or a voice note.', icon: Camera, image: 'lake', caption: 'Photos · clips · voice notes' },
  { title: 'Give it a place.', text: 'Create a memory with a title, place, and date. In the capture inbox, choose the memory, preview the link, and confirm it.', icon: Check, image: 'desert', caption: 'Capture → review → confirm' },
  { title: 'Come back to it.', text: 'Explore your photo trail. Keep stories in Remember, curate an album in Create, or render a film in Watch.', icon: Compass, image: 'ocean', caption: 'Your memories, connected' },
  { title: 'Say what you remember.', text: 'Open VoiceOS in the sidebar for installation and pairing. Once connected, ask it to find a memory or preview a recollection.', icon: AudioLines, image: 'stars', caption: '“Show me the lake memory.”' }
];

export function Tutorial({ finish, create }: { finish: () => void; create: () => void }) {
  const [step, setStep] = useState(0);
  const current = steps[step];
  const Icon = current.icon;
  return <div className="tutorial">
    <div className="tutorial-image">
      <img src={'/landing/photos/' + current.image + '.webp'} alt="" />
      <span><Icon size={18} />{current.caption}</span>
    </div>
    <div className="tutorial-copy" aria-live="polite" aria-atomic="true">
      <p className="tutorial-step">A quick introduction · {step + 1} of {steps.length}</p>
      <h3>{current.title}</h3><p>{current.text}</p>
    </div>
    <div className="tutorial-progress" aria-label="Tutorial steps">{steps.map((item, index) =>
      <button key={item.title} onClick={() => setStep(index)} aria-label={'Step ' + (index + 1) + ', ' + item.title} aria-current={index === step ? 'step' : undefined} />)}</div>
    <div className="tutorial-actions">
      <button className="text-button" onClick={step ? () => setStep(step - 1) : finish}>{step ? <><ArrowLeft size={15} /> Back</> : 'Skip tour'}</button>
      {step < steps.length - 1 ? <button className="btn primary" onClick={() => setStep(step + 1)}>Continue <ArrowRight size={16} /></button> :
        <div className="button-row"><button className="btn" onClick={finish}>Explore sample</button><button className="btn primary" onClick={create}>Create a project <ArrowRight size={16} /></button></div>}
    </div>
  </div>;
}
