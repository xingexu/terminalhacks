import { useState } from 'react';
import { ArrowLeft, ArrowRight, AudioLines, Camera, Check, Compass } from 'lucide-react';
import { VoiceShortcut } from './voice';
import { AsciiImage } from './ascii';

const steps = [
  { title: 'Take a walk along the coast.', text: 'Choose Play scene to follow memory stops around a designed coast. Move with WASD or the on-screen controls, drag to look around, and press E at a nearby stop.', icon: Compass, image: 'ocean', caption: 'Designed coastal demo' },
  { title: 'Bring a place you remember.', text: 'Create a private project and a memory, then use Capture to add a photo of the place. Choose that memory in the review inbox and confirm the link.', icon: Camera, image: 'lake', caption: 'Capture → review → confirm' },
  { title: 'Walk through your own scene.', text: 'Create a reconstruction from a confirmed photo and what you remember, or import a 3D scan. Review and approve it, then choose Walk in scene for a walkable reconstruction.', icon: Check, image: 'desert', caption: 'Review a reconstruction before entering' },
  { title: 'Describe the place by voice.', text: 'For optional voice controls, open VoiceOS from Applications on your Mac. Go to Apps → Custom → Everwhere to check your connection.', icon: AudioLines, image: 'stars', caption: '“What memory is open in Everwhere?”' }
];

export function Tutorial({ finish, create, connectVoice, canConnectVoice }: {
  finish: () => void; create: () => void; connectVoice: () => void; canConnectVoice: boolean;
}) {
  const [step, setStep] = useState(0);
  const current = steps[step];
  const Icon = current.icon;
  return <div className="tutorial">
    <div className="tutorial-image">
      <AsciiImage key={current.image} src={'/landing/photos/' + current.image + '.webp'} />
      <img src={'/landing/photos/' + current.image + '.webp'} alt="" />
      <span><Icon size={18} />{current.caption}</span>
    </div>
    <div className="tutorial-copy" aria-live="polite" aria-atomic="true">
      <p className="tutorial-step">A quick introduction · <span className="tutorial-count">[{steps.map((item, index) => index <= step ? '#' : '.').join('')}] {step + 1}/{steps.length}</span></p>
      <h3>{current.title}</h3><p>{current.text}</p>
    </div>
    {step === 1 && <button className="text-button tutorial-create" onClick={create}>Create a private project <ArrowRight size={15} /></button>}
    {step === steps.length - 1 && <div className="tutorial-voice">
      <p>To describe a scene, focus its memory-description field, hold <kbd>Fn</kbd>, speak, then release. VoiceOS inserts the words for you to review. Set Fn to dictation in VoiceOS Settings.</p>
      <VoiceShortcut />
      <p>{canConnectVoice ? <>Choose <strong>Set up VoiceOS</strong> below to pair this project.</> : <>Create a project first, then open <strong>VoiceOS</strong> to pair it.</>} You can reopen setup from the <strong>VoiceOS</strong> button in Everwhere’s sidebar or mobile header.</p>
    </div>}
    <div className="tutorial-progress" aria-label="Tutorial steps">{steps.map((item, index) =>
      <button key={item.title} onClick={() => setStep(index)} aria-label={'Step ' + (index + 1) + ', ' + item.title} aria-current={index === step ? 'step' : undefined} />)}</div>
    <div className="tutorial-actions">
      <button className="text-button" onClick={step ? () => setStep(step - 1) : finish}>{step ? <><ArrowLeft size={15} /> Back</> : 'Skip tour'}</button>
      {step < steps.length - 1 ? <button className="btn primary" onClick={() => setStep(step + 1)}>Continue <ArrowRight size={16} /></button> :
        <div className="button-row"><button className="btn" onClick={canConnectVoice ? connectVoice : create}>{canConnectVoice ? 'Set up VoiceOS' : 'Create a project'}</button><button className="btn primary" onClick={finish}>Open Gameplay <ArrowRight size={16} /></button></div>}
    </div>
  </div>;
}
