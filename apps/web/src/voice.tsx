import { useCallback, useEffect, useState } from 'react';
import { AudioLines, Check, Copy, Download, ExternalLink } from 'lucide-react';
import { api, type Snapshot } from './model';

type PairingStatus = { active: boolean; expires: number | null; lastSeen: number | null };

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
    <ol className="setup-steps">
      <li><strong>Install Everwhere on your Mac</strong><p>Install Node.js 24+ and FFmpeg, then clone the repository and run the setup commands in its README. Keep Everwhere running.</p>
        <a className="text-button" href="https://github.com/xingexu/terminalhacks/tree/team/coordinator/everwhere-experience#voiceos" target="_blank" rel="noreferrer">Open installation guide <ExternalLink size={13} /></a></li>
      <li><strong>Install the integration folder</strong><p>In VoiceOS, open Settings → Agent Mode → Integrations → Install from folder. Choose the Everwhere repository folder containing voiceos.integration.json.</p>
        <p className="muted">For an HTTPS deployment, download its manifest below and replace the repository’s manifest before importing. It declares this server’s hostname.</p>
        <a className="text-button" href={'/v1' + base + '/pairing/manifest?origin=' + encodeURIComponent(location.origin)} download="voiceos.integration.json"><Download size={13} /> Download server manifest</a></li>
      <li><strong>Configure and pair</strong><p>In the integration’s Configure form, paste these values. Save, then ask VoiceOS “What memory is open in Everwhere?”</p></li>
    </ol>
    <label>API origin<div className="copy-field"><input readOnly value={location.origin} onFocus={e => e.target.select()} /><button className="icon-btn" aria-label="Copy API origin" onClick={() => void copy(location.origin, 'API origin')}><Copy size={15} /></button></div></label>
    <label>Project ID<div className="copy-field"><input readOnly value={state.projectId} onFocus={e => e.target.select()} /><button className="icon-btn" aria-label="Copy project ID" onClick={() => void copy(state.projectId, 'Project ID')}><Copy size={15} /></button></div></label>
    {token && <label>Pairing token<div className="copy-field"><input type="password" readOnly value={token} autoComplete="off" onFocus={e => e.target.select()} /><button className="icon-btn" aria-label="Copy pairing token" onClick={() => void copy(token, 'Pairing token')}><Copy size={15} /></button></div></label>}
    {message && <p className="muted" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="button-row"><button className="btn primary" disabled={busy} onClick={() => void pair()}><AudioLines size={16} /> {status?.active ? 'Replace pairing token' : 'Create pairing token'}</button>
      <button className="btn" disabled={busy || !status?.active} onClick={() => void pair(true)}>Revoke token</button></div>
    <p className="muted">Creating a new token replaces the previous one. After expiry, update the token in VoiceOS Configure.</p>
  </div>;
}
