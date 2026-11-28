import { useEffect, useRef, useState } from 'react';
import { Camera, Square, Video } from 'lucide-react';
import { api, type ApiError, type Session } from './model';

export type CameraAction = NonNullable<Session['cameraAction']>;
export type CameraViewer = { id: string; since: number };
type AckStatus = 'opened' | 'captured' | 'closed' | 'blocked' | 'ignored';

// Shared by App and CameraPanel so one request is never executed twice.
const handled = new Set<string>();

/** True once per request, and only for this tab's live, post-mount actions. */
export function claimCameraAction(action: CameraAction | undefined, viewer: CameraViewer | null): action is CameraAction {
  if (!action || !viewer || action.viewerId !== viewer.id || handled.has(action.id)) return false;
  if (Date.now() > Date.parse(action.expiresAt) || Date.parse(action.issuedAt) < viewer.since - 1000) return false;
  handled.add(action.id);
  return true;
}
export const isOwnCameraAction = (action: CameraAction | undefined, viewer: CameraViewer | null): action is CameraAction =>
  !!action && !!viewer && action.viewerId === viewer.id && !handled.has(action.id) && Date.now() <= Date.parse(action.expiresAt) &&
  Date.parse(action.issuedAt) >= viewer.since - 1000;

export const ackFailed = 'Voice control did not receive this camera result. Use the buttons here, or ask again.';
/** Resends the identical receipt (never the action itself); false when voice control never got it. */
export async function ackCamera(base: string, action: CameraAction, status: AckStatus, extra: { observationId?: string; reason?: string } = {}) {
  const receipt = { requestId: action.id, viewerId: action.viewerId, status, ...extra };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => window.setTimeout(resolve, 600));
    try { await api(base + '/camera-action-ack', receipt); return true; }
    catch (err) { if ([400, 404, 409].includes((err as ApiError).status)) return false; }
  }
  return false;
}

/** Registers this visible tab as the camera owner; a fresh ID per run keeps a stale unregister from clearing it. */
export function useCameraViewer(base: string, enabled: boolean, serverViewerId?: string | null): { viewer: CameraViewer | null; notice: string } {
  const [viewer, setViewer] = useState<CameraViewer | null>(null);
  const [notice, setNotice] = useState('');
  const confirmed = useRef(false);
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const change = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (!enabled || hidden) return;
    const id = crypto.randomUUID();
    let live = true;
    confirmed.current = false;
    setNotice('');
    api(base + '/session', { cameraViewerId: id }).then(() => { if (live) setViewer({ id, since: Date.now() }); })
      .catch(() => { if (live) setNotice('Voice camera control is unavailable right now. The camera buttons here still work.'); });
    return () => {
      live = false;
      setViewer(null);
      void api(base + '/session', { cameraViewerId: null, viewerId: id }).catch(() => {});
    };
  }, [base, enabled, hidden]);
  useEffect(() => {
    if (!viewer) return;
    if (serverViewerId === viewer.id) confirmed.current = true;
    // Only after the server showed this tab as owner, so a snapshot older than our registration cannot evict us.
    else if (confirmed.current) {
      confirmed.current = false;
      setViewer(null);
      setNotice('Another tab now controls the voice camera, so the camera here was stopped.');
    }
  }, [serverViewerId, viewer]);
  return { viewer, notice };
}

const failure = (err: unknown) => {
  const name = (err as Error)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied. Allow the camera for this site, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is in use by another app.';
  return (err as Error)?.message || 'The camera could not be started.';
};

export function CameraPanel({ base, viewer, notice = '', action, consent, visible, busy, uploadFrame }: {
  base: string; viewer: CameraViewer | null; notice?: string; action?: CameraAction; consent: boolean; visible: boolean; busy: boolean;
  /** Sends one frame through the consented review path; resolves the pending observation ID, or null for a duplicate. */
  uploadFrame: (frame: File, captureId: string) => Promise<string | null>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const run = useRef(0);
  const [status, setStatus] = useState<'off' | 'requesting' | 'live'>('off');
  const [message, setMessage] = useState('');
  const latest = useRef({ consent, uploadFrame });
  latest.current = { consent, uploadFrame };

  function stop() {
    run.current += 1;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setStatus('off');
  }
  async function start(expiresAt = Infinity) {
    if (stream.current) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use a camera here.');
    const mine = ++run.current;
    setMessage('');
    setStatus('requesting');
    let granted: MediaStream | null = null;
    try {
      const expired = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('The camera did not start in time.')), 25_000));
      const pending = navigator.mediaDevices.getUserMedia({ video: true });
      // A late grant must still be released if the race was lost.
      pending.then(late => window.setTimeout(() => { if (late !== stream.current) late.getTracks().forEach(track => track.stop()); }, 0)).catch(() => {});
      granted = await Promise.race([pending, expired]);
      if (mine !== run.current || document.hidden || Date.now() > expiresAt || !video.current) throw new Error('The camera request ended before permission was granted.');
      stream.current = granted;
      granted.getVideoTracks()[0]?.addEventListener('ended', () => { if (stream.current === granted) { stop(); setMessage('The camera stopped. Start it again to continue.'); } });
      video.current.srcObject = granted;
      await Promise.race([video.current.play(), expired]);
      if (mine !== run.current) throw new Error('The camera request ended before the preview started.');
      setStatus('live');
    } catch (err) {
      if (mine === run.current) stop();
      else if (granted && granted !== stream.current) granted.getTracks().forEach(track => track.stop());
      throw new Error(failure(err));
    }
  }
  async function take(captureId: string) {
    const element = video.current;
    if (!stream.current || !element?.videoWidth) throw new Error('Open the camera and check the live preview before taking a photo.');
    if (!latest.current.consent) throw new Error('Confirm you have permission to keep sources, then take the photo again.');
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    canvas.getContext('2d')!.drawImage(element, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('The camera frame could not be read.');
    const id = await latest.current.uploadFrame(new File([blob], 'Camera photo.jpg', { type: 'image/jpeg' }), captureId);
    setMessage(id ? 'Photo added to the review inbox. Link it to a memory to keep it.' : 'This exact photo is already in the project.');
    return id;
  }
  const manual = (work: () => Promise<unknown>) => { work().catch(err => setMessage((err as Error).message)); };

  useEffect(() => () => stop(), []);
  useEffect(() => { if (!visible) stop(); }, [visible]);
  const owned = useRef(false);
  // Losing voice ownership (another tab, or this tab hidden) releases the camera.
  useEffect(() => { if (viewer) owned.current = true; else if (owned.current) { owned.current = false; stop(); } }, [viewer?.id]);
  useEffect(() => {
    const change = () => { if (document.hidden && stream.current) { stop(); setMessage('The camera stopped while this tab was hidden.'); } };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (!visible || !isOwnCameraAction(action, viewer)) return;
    // Deferred so React StrictMode's discarded first mount cannot consume the request.
    const timer = window.setTimeout(async () => {
      if (!claimCameraAction(action, viewer)) return;
      let status: AckStatus = 'blocked';
      let extra: { observationId?: string; reason?: string } = {};
      try {
        if (action.action === 'open') { await start(Date.parse(action.expiresAt)); status = 'opened'; }
        else if (action.action === 'close') { stop(); setMessage('Camera stopped.'); status = 'closed'; }
        else {
          const observationId = await take(action.id);
          if (observationId) { status = 'captured'; extra = { observationId }; }
          else extra = { reason: 'This exact photo is already in the project; no new photo was added.' };
        }
      } catch (err) {
        extra = { reason: (err as Error).message.slice(0, 240) };
        setMessage(extra.reason!);
      }
      if (!await ackCamera(base, action, status, extra)) setMessage(text => (text ? text + ' ' : '') + ackFailed);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [action?.id, viewer?.id, visible]);

  return <div className="capture-choice"><Video size={20} /><strong>Camera</strong>
    <video ref={video} hidden={status !== 'live'} autoPlay muted playsInline aria-label="Live camera preview"
      style={{ width: '100%', maxHeight: '46dvh', borderRadius: 7, background: '#000' }} />
    <div className="button-row">
      {status === 'off' ? <button className="btn compact" onClick={() => manual(() => start())}><Camera size={15} /> Start camera</button> : <>
        <button className="btn compact primary" disabled={status !== 'live' || !consent || busy} onClick={() => manual(() => take(crypto.randomUUID()))}><Camera size={15} /> Take photo</button>
        <button className="btn compact record-stop" onClick={() => { stop(); setMessage(''); }}><Square size={14} fill="currentColor" /> Stop camera</button></>}
    </div>
    {status === 'requesting' && <p className="muted" role="status">Waiting for camera permission…</p>}
    {status === 'live' && !consent && <small className="muted">Confirm permission to keep sources above before taking a photo.</small>}
    {message && <p className="muted" role="status">{message}</p>}
    {notice && <p className="form-error" role="alert">{notice}</p>}
  </div>;
}
