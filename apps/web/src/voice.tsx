import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Check, Copy, Download, ExternalLink, Images } from 'lucide-react';
import { api, type Snapshot } from './model';

type PairingStatus = { active: boolean; expires: number | null; lastSeen: number | null };

export function VoiceShortcut() {
  return <div className="voice-shortcut">
    <AudioLines size={20} aria-hidden="true" />
    <div><strong>Hold, speak, release.</strong>
      <p>Use your Agent Mode shortcut. For <kbd>control</kbd> + <kbd>option</kbd>, hold both keys, ask a question, then release.</p>
      <small>Check your Agent Mode shortcut in VoiceOS Settings.</small>
    </div>
  </div>;
}

type LibraryStatus = { allowed: boolean; source: 'apple-photos' | 'folder' | 'none'; events: { id: string; name: string; count: number }[]; problem?: string };

/** Lets the person turn photo library access on, see their events, and pull one into a memory. */
function PhotoLibrary({ base }: { base: string }) {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label); setError(''); setMessage('');
    try { await work(); } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  useEffect(() => { void run('check', async () => setStatus(await api<LibraryStatus>(base + '/photo-library'))); }, [base]);
  const allow = (value: boolean) => run('access', async () => setStatus(await api<LibraryStatus>(base + '/photo-library/access', { allow: value })));
  const pull = (name: string) => run(name, async () => {
    const result = await api<{ title: string; alreadyHere: number }>(base + '/photo-library/pull', { event: name });
    setMessage(result.title + (result.alreadyHere ? '. ' + result.alreadyHere + ' already here.' : '.') + ' Close this window to see the memory in Explore.');
  });
  return <section className="voice-start photo-library" aria-labelledby="photo-library-title">
    <h3 id="photo-library-title">Your photo library</h3>
    <p>{status?.source === 'folder' ? 'Everwhere reads the event folders on this computer.' : 'Everwhere reads the albums in the Photos app on this Mac. Each album is one event.'} With
      access on, VoiceOS can list your events and pull up to 24 photos from one into a memory. Copies stay on this computer.</p>
    {status?.source === 'none' && <p className="setup-note">This server is not a Mac with the Photos app, so there is no library to read here.</p>}
    <div className="button-row">
      {status?.allowed ? <button className="btn" disabled={!!busy} onClick={() => void allow(false)}>Turn access off</button> :
        <button className="btn primary" disabled={!status || !!busy || status.source === 'none'} onClick={() => void allow(true)}><Images size={16} /> {busy === 'access' ? 'Asking…' : 'Allow photo library access'}</button>}
      {status?.allowed && <button className="btn" disabled={!!busy} onClick={() => void allow(true)}>{busy === 'access' ? 'Reading…' : 'Refresh events'}</button>}
    </div>
    {!status?.allowed && status?.source === 'apple-photos' && <p className="muted">macOS will then ask whether the app running Everwhere may control Photos. Choose Allow.</p>}
    {status?.allowed && status.problem && <p className="form-error" role="alert">{status.problem}</p>}
    {status?.allowed && !status.problem && (status.events.length ? <ul className="library-events">
      {status.events.map(item => <li key={item.id}><span><strong>{item.name}</strong><small>{item.count} {item.count === 1 ? 'photo' : 'photos'}</small></span>
        <button className="btn compact" disabled={!!busy} onClick={() => void pull(item.name)}>{busy === item.name ? 'Pulling…' : 'Pull photos'}</button></li>)}
    </ul> : <p className="muted">No events with photos were found.</p>)}
    {status?.allowed && <div className="voice-example"><div><small>Or say it to VoiceOS</small><p>“Pull the photos from {status.events[0]?.name ?? 'my trip'}”, then “Open the walk”.</p></div></div>}
    {message && <p className="muted" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

export function VoicePanel({ base, state }: { base: string; state: Snapshot }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = location.hostname.endsWith('.preview.devinapps.com');
  const refresh = useCallback(async () => {
    const value = await api<PairingStatus>(base + '/pairing');
    setStatus(value);
    if (!value.active) setToken('');
    setError('');
  }, [base]);
  useEffect(() => {
    const check = () => { void refresh().catch(err => setError((err as Error).message)); };
    check();
    const timer = window.setInterval(check, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setMessage(label + ' copied.'); }
    catch { setError('Clipboard access is unavailable. Select and copy the field manually.'); }
  }
  async function pair(revoke = false) {
    setBusy(true); setError(''); setMessage('');
    try {
      if (revoke) { await api(base + '/pairing', undefined, 'DELETE'); setToken(''); setMessage('Pairing revoked.'); }
      else {
        const value = await api<{ token: string }>(base + '/pairing', { confirm: true });
        setToken(value.token);
        setMessage('Paste this token into VoiceOS. It expires in two hours.');
      }
      await refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="form-stack voice-setup">
    <div className="connection-state" role="status">
      {status?.active && status.lastSeen ? <Check size={20} /> : <AudioLines size={20} />}
      <div><strong>{!status ? 'Checking pairing…' : !status.active ? 'Ready to pair' : status.lastSeen ? 'Bridge reached this project' : 'Waiting for the first tool call'}</strong>
        <p>{status?.active && status.lastSeen ? 'Last activity ' + new Date(status.lastSeen).toLocaleTimeString() : 'Connect your memories to VoiceOS Agent Mode.'}</p>
        {status?.active && status.expires && <small>Token expires at {new Date(status.expires).toLocaleTimeString()}</small>}
      </div>
    </div>
    {preview && <p className="setup-note">This preview requires a Devin login. For VoiceOS, run Everwhere on your Mac and open its local address to create a project and pair there. Preview project IDs and tokens belong to this server.</p>}
    <section className="voice-start" aria-labelledby="voice-start-title">
      <h3 id="voice-start-title">Open VoiceOS on your Mac</h3>
      <p>Launch <strong>VoiceOS</strong> from Applications or Spotlight. Open <strong>Apps → Custom → Everwhere</strong> and keep the integration enabled.</p>
      <VoiceShortcut />
      <div className="voice-example"><div><small>Try your first question</small><p>“What memory is open in Everwhere?”</p></div>
        <button className="icon-btn" aria-label="Copy example question" onClick={() => void copy('What memory is open in Everwhere?', 'Example question')}><Copy size={16} /></button></div>
      <p className="muted">Keep Everwhere running. A successful command updates the bridge activity above.</p>
    </section>
    <PhotoLibrary base={base} />
    <details className="voice-pairing" open={!status?.lastSeen || !!token}>
      <summary>Pairing settings <span>{state.title}</span></summary>
      <div className="form-stack">
        <p className="muted">Open VoiceOS → Apps → Custom → Everwhere, then paste these three values into the integration’s setup fields and save.</p>
        <label>API origin<div className="copy-field"><input readOnly value={location.origin} onFocus={e => e.target.select()} /><button className="icon-btn" aria-label="Copy API origin" onClick={() => void copy(location.origin, 'API origin')}><Copy size={15} /></button></div></label>
        <label>Project ID<div className="copy-field"><input readOnly value={state.projectId} onFocus={e => e.target.select()} /><button className="icon-btn" aria-label="Copy project ID" onClick={() => void copy(state.projectId, 'Project ID')}><Copy size={15} /></button></div></label>
        {token && <label>Pairing token<div className="copy-field"><input type="password" readOnly value={token} autoComplete="off" onFocus={e => e.target.select()} /><button className="icon-btn" aria-label="Copy pairing token" onClick={() => void copy(token, 'Pairing token')}><Copy size={15} /></button></div></label>}
        <div className="button-row"><button className="btn primary" disabled={busy} onClick={() => void pair()}><AudioLines size={16} /> {busy ? 'Updating…' : status?.active ? 'Replace pairing token' : 'Create pairing token'}</button>
          <button className="btn" disabled={busy || !status?.active} onClick={() => void pair(true)}>Revoke token</button></div>
        <p className="muted">Tokens expire after two hours. Create a replacement here and update the integration’s pairing token in VoiceOS. Replacing or revoking a token removes the previous token’s access.</p>
      </div>
    </details>
    <details className="voice-install">
      <summary>Everwhere isn’t listed in VoiceOS?</summary>
      <p>Install the Everwhere integration folder on the Mac running VoiceOS. It contains <code>voiceos.integration.json</code>. Node.js 24+ must be available to the desktop app.</p>
      <p>Versions with folder import use Settings → Agent Mode → Integrations → Install from folder. VoiceOS 0.1.43 uses Apps → Custom and may not show this import control. Check VoiceOS’s installation guide for availability in your version.</p>
      <div className="voice-links"><a className="text-button" href="https://docs.voiceos.com/integrations/distribution" target="_blank" rel="noreferrer">VoiceOS installation guide <ExternalLink size={13} /></a>
        <a className="text-button" href="https://github.com/xingexu/terminalhacks/blob/main/README.md#voiceos" target="_blank" rel="noreferrer">Everwhere setup guide <ExternalLink size={13} /></a>
        <a className="text-button" href={'/v1' + base + '/pairing/manifest?origin=' + encodeURIComponent(location.origin)} download="voiceos.integration.json"><Download size={13} /> Download server manifest</a></div>
      <p className="muted">For a different server address, replace the repository’s manifest with this download before importing. It declares the server’s hostname.</p>
    </details>
    {message && <p className="muted" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
