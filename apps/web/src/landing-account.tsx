import { createRoot } from 'react-dom/client';
import { AccountControl } from './account';

const host = document.getElementById('landing-account');
if (host) {
  createRoot(host).render(<AccountControl autoRegisterAfterMs={5000} onSessionChange={(_account, action) => {
    localStorage.setItem('everwhere-auth-change', crypto.randomUUID());
    location.assign(action === 'logout' ? '/' : '/app?tour=0');
  }} />);
}

window.addEventListener('storage', event => {
  if (event.key === 'everwhere-auth-change') location.reload();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});
