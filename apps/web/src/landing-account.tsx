import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';
import { AccountControl } from './account';

const accountRoot = createRoot(document.getElementById('landing-account')!);
accountRoot.render(<AccountControl autoRegisterAfterMs={5000} onSessionChange={(_account, action) => {
  localStorage.setItem('everwhere-auth-change', crypto.randomUUID());
  location.assign(action === 'logout' ? '/' : '/app?tour=0');
}} />);

const layer = document.querySelector<HTMLElement>('.landing-layer')!;
const host = document.getElementById('workspace-root')!;
const workspaceRoot = createRoot(host);
const landingPath = location.pathname;
let covered = true;
let Workspace: ComponentType<{ covered?: boolean }> | undefined;
let preloadFailed = false;

// Start the same workspace instance that the visitor will interact with after the reveal.
void import('./workspace').then(({ WorkspaceApp }) => {
  Workspace = WorkspaceApp;
  workspaceRoot.render(<Workspace covered={covered} />);
  if (!covered) focusWorkspace();
}).catch(() => {
  preloadFailed = true;
  if (!covered) location.replace('/app?tour=0');
});

function focusWorkspace() {
  requestAnimationFrame(() => {
    const target = host.querySelector<HTMLElement>('#experience') ?? host;
    target.focus({ preventScroll: true });
  });
}

window.addEventListener('everwhere:enter-workspace', event => {
  if (preloadFailed) return;
  event.preventDefault();
  if (!covered) return;
  covered = false;
  history.pushState(null, '', '/app?tour=0');
  document.querySelector('base')?.remove();
  document.title = 'Everwhere · Workspace';
  layer.hidden = true;
  accountRoot.unmount();
  document.body.classList.remove('landing-active');
  delete document.documentElement.dataset.leaving;
  host.inert = false;
  host.removeAttribute('aria-hidden');
  if (Workspace) workspaceRoot.render(<Workspace covered={false} />);
  focusWorkspace();
});

window.addEventListener('popstate', () => {
  if (!covered && location.pathname === landingPath) location.reload();
});

window.addEventListener('storage', event => {
  if (covered && event.key === 'everwhere-auth-change') location.reload();
});
window.addEventListener('pageshow', event => {
  if (covered && event.persisted) location.reload();
});
