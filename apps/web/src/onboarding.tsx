import { useState } from 'react';
import { ArrowLeft, ArrowRight, AudioLines, Camera, Check, Compass } from 'lucide-react';
import { VoiceShortcut } from './voice';

const steps = [
  { title: 'Keep the moment.', text: 'Start a private project, then use Capture to add selected photos, clips, or a voice note.', icon: Camera, image: 'lake', caption: 'Photos · clips · voice notes' },
  { title: 'Give it a place.', text: 'Create a memory with a title, place, and date. In the capture inbox, choose the memory, preview the link, and confirm it.', icon: Check, image: 'desert', caption: 'Capture → review → confirm' },
  { title: 'Come back to it.', text: 'In Studio, choose photos and select Enter album. Walk with WASD or the on-screen arrows, drag to look, and open nearby photos with E. Keep recollections in Stories or render a film in Films.', icon: Compass, image: 'ocean', caption: 'Your memories, connected' },
  { title: 'Your memories, by voice.', text: 'Open the VoiceOS app from Applications on your Mac. Go to Apps → Custom → Everwhere to check your connection.', icon: AudioLines, image: 'stars', caption: '“What memory is open in Everwhere?”' }
];

export function Tutorial({ finish, create, connectVoice, canConnectVoice }: {
  finish: () => void; create: () => void; connectVoice: () => void; canConnectVoice: boolean;
}) {
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
    {step === 0 && <button className="text-button tutorial-create" onClick={create}>Create a private project <ArrowRight size={15} /></button>}
    {step === steps.length - 1 && <div className="tutorial-voice">
      <VoiceShortcut />
      <p>{canConnectVoice ? <>Choose <strong>Set up VoiceOS</strong> below to pair this project.</> : <>Create a project first, then open <strong>VoiceOS</strong> to pair it.</>} You can reopen setup from the <strong>VoiceOS</strong> button in Everwhere’s sidebar or mobile header.</p>
    </div>}
    <div className="tutorial-progress" aria-label="Tutorial steps">{steps.map((item, index) =>
      <button key={item.title} onClick={() => setStep(index)} aria-label={'Step ' + (index + 1) + ', ' + item.title} aria-current={index === step ? 'step' : undefined} />)}</div>
    <div className="tutorial-actions">
      <button className="text-button" onClick={step ? () => setStep(step - 1) : finish}>{step ? <><ArrowLeft size={15} /> Back</> : 'Skip tour'}</button>
      {step < steps.length - 1 ? <button className="btn primary" onClick={() => setStep(step + 1)}>Continue <ArrowRight size={16} /></button> :
        <div className="button-row"><button className="btn" onClick={finish}>Open workspace</button><button className="btn primary" onClick={canConnectVoice ? connectVoice : create}>{canConnectVoice ? 'Set up VoiceOS' : 'Create a project'} <ArrowRight size={16} /></button></div>}
    </div>
  </div>;
}
