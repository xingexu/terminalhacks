import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, LogOut, UserRound, X } from 'lucide-react';
import { api } from './model';
import './account.css';

export type Account = { email: string };
export type AccountMode = 'login' | 'register' | 'manage';
export type AccountAction = 'login' | 'register' | 'logout';

type AccountResponse = { account: Account | null };
type AccountControlProps = {
  initialMode?: AccountMode;
  autoRegisterAfterMs?: number;
  onSessionChange: (account: Account | null, action: AccountAction) => void;
};

export function AccountControl({ initialMode, autoRegisterAfterMs, onSessionChange }: AccountControlProps) {
  const [account, setAccount] = useState<Account | null>(null);
  const [mode, setMode] = useState<AccountMode | null>(initialMode ?? null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const emailField = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const promptHandled = useRef(Boolean(initialMode));
  const titleId = useId();
  const hintId = useId();
  const open = mode !== null;
  const register = mode === 'register';
  const title = account ? 'Your account' : register ? 'Create an account' : 'Sign in';

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSessionError(false);
    api<AccountResponse>('/auth/session')
      .then(data => { if (active) setAccount(data.account); })
      .catch(() => { if (active) setSessionError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);

  useEffect(() => {
    if (autoRegisterAfterMs === undefined) return;
    let active = true;
    let checking = false;
    const due = autoRegisterAfterMs;
    const eligible = () => active && !promptHandled.current && !document.hidden &&
      !document.documentElement.dataset.leaving && performance.now() >= due;
    const checkGuest = async () => {
      if (!eligible() || checking) return;
      checking = true;
      try {
        const session = await api<AccountResponse>('/auth/session');
        if (!eligible() || session.account !== null) return;
        promptHandled.current = true;
        setSessionError(false);
        opener.current = trigger.current;
        setMode('register');
      } catch { /* Wait for a confirmed guest session before prompting. */ }
      finally { checking = false; }
    };
    const timer = window.setTimeout(checkGuest, Math.ceil(Math.max(0, due - performance.now())));
    document.addEventListener('visibilitychange', checkGuest);
    window.addEventListener('pageshow', checkGuest);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', checkGuest);
      window.removeEventListener('pageshow', checkGuest);
    };
  }, [autoRegisterAfterMs]);

  useEffect(() => {
    if (!open) return;
    const el = dialog.current;
    el?.showModal();
    return () => {
      el?.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open || loading) return;
    if (emailField.current) emailField.current.focus();
    else heading.current?.focus();
  }, [open, mode, account, loading]);

  function chooseMode(next: AccountMode, trigger?: HTMLButtonElement) {
    promptHandled.current = true;
    if (trigger) opener.current = trigger;
    setError('');
    setShowPassword(false);
    setMode(next);
  }

  function dismiss() {
    setMode(null);
    setEmail('');
    setShowPassword(false);
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const action: AccountAction = account ? 'logout' : register ? 'register' : 'login';
    const payload = account ? {} : { email: email.trim(), password: new FormData(event.currentTarget).get('password') };
    setBusy(true);
    setError('');
    try {
      const response = await api<AccountResponse>('/auth/' + action, payload);
      setAccount(response.account);
      dismiss();
      onSessionChange(response.account, action);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const triggerLabel = account ? 'Your account' : 'Sign in or register';
  return <div className="account-control">
    <button ref={trigger} type="button" className="account-trigger" aria-haspopup="dialog" aria-label={triggerLabel} title={triggerLabel}
      onClick={event => chooseMode(account ? 'manage' : 'login', event.currentTarget)}>
      <UserRound aria-hidden="true" size={19} />
    </button>
    {open && createPortal(<dialog ref={dialog} className="account-dialog" aria-labelledby={titleId}
      onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}
      onCancel={event => { event.preventDefault(); if (!busy) dismiss(); }}
      onClick={event => {
        if (busy || event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
      }}>
      <div className="account-panel">
        <div className="account-heading">
          <h2 ref={heading} id={titleId} tabIndex={-1}>{title}</h2>
          <button type="button" className="account-close" aria-label="Close account dialog" disabled={busy} onClick={dismiss}><X size={20} /></button>
        </div>
        {loading ? <p role="status" className="account-message">Checking your account…</p>
          : sessionError ? <div className="account-fields"><p role="alert" className="account-message">Your account details couldn’t be loaded.</p>
            <button className="account-submit" type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>
          : <form className="account-fields" onSubmit={submit}>
            {account ? <div className="account-details"><span>Email address</span><strong>{account.email}</strong></div> : <>
              <label htmlFor={titleId + '-email'}>Email address</label>
              <input ref={emailField} id={titleId + '-email'} type="email" name="email" required maxLength={254} autoComplete="username"
                autoCapitalize="none" spellCheck={false} value={email} onChange={event => setEmail(event.target.value)} />
              <label htmlFor={titleId + '-password'}>Password</label>
              <div className="account-password">
                <input key={mode} id={titleId + '-password'} type={showPassword ? 'text' : 'password'} name="password" required
                  minLength={register ? 12 : undefined} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'}
                  aria-describedby={register ? hintId : undefined} />
                <button type="button" className="account-reveal" aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
              </div>
              {register && <p className="account-hint" id={hintId}>Use at least 12 characters.</p>}
            </>}
            {error && <p className="account-error" role="alert">{error}</p>}
            <button className="account-submit" type="submit" disabled={busy}>
              {account && <LogOut size={16} aria-hidden="true" />}
              {account ? (busy ? 'Signing out…' : 'Sign out') : register ? (busy ? 'Creating account…' : 'Create account') : (busy ? 'Signing in…' : 'Sign in')}
            </button>
            {!account && <div className="account-switch">
              {register ? 'Already have an account?' : 'New to Everwhere?'}
              <button type="button" disabled={busy} onClick={() => chooseMode(register ? 'login' : 'register')}>{register ? 'Sign in' : 'Register'}</button>
            </div>}
          </form>}
      </div>
    </dialog>, document.body)}
  </div>;
}
