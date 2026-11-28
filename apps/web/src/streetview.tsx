import { useEffect, useRef } from 'react';
import { normalizedYaw, panoramaLink, type StreetViewLocator } from './panorama-navigation';

export type StreetViewMove = 'forward' | 'backward' | 'left' | 'right' | 'turn_left' | 'turn_right';
export type StreetViewResult = { status: 'completed' | 'blocked' | 'stopped'; heading: number; reason?: string };
export type StreetViewHandle = { move: (direction: StreetViewMove, degrees: number) => Promise<StreetViewResult>; stop: () => void; heading: () => number;
  navigation: () => { heading: number; availableDirections: string[] } };

const KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'];
// The official Maps JavaScript API is untyped here: no @types/google.maps dependency for one component.
let maps: Promise<any> | undefined;
let authFailure: (() => void) | null = null;

function loadMaps(): Promise<any> {
  const key = (import.meta as any).env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
  if (!key) return Promise.reject(new Error('Street View needs a Google Maps key. Add VITE_GOOGLE_MAPS_API_KEY to apps/web/.env.local and restart Everwhere.'));
  return maps ??= new Promise((resolve, reject) => {
    const global = window as any;
    const script = document.createElement('script');
    const fail = (message: string) => { clearTimeout(timer); maps = undefined; script.remove(); reject(new Error(message)); };
    const timer = setTimeout(() => fail('Google Maps took too long to load. Check your connection and retry.'), 15000);
    global.gm_authFailure = () => authFailure?.();
    global.__everwhereMaps = () => { clearTimeout(timer); resolve(global.google.maps); };
    script.src = 'https://maps.googleapis.com/maps/api/js?v=weekly&loading=async&callback=__everwhereMaps&key=' + encodeURIComponent(key);
    script.async = true;
    script.onerror = () => fail('Google Maps could not be loaded. Check your connection and retry.');
    document.head.append(script);
  });
}

export default function StreetView({ locator, heading, title, reduced, onReady, onError, onKey, onLook }: {
  locator: StreetViewLocator; heading?: number; title: string; reduced: boolean;
  onReady: (handle: StreetViewHandle | null) => void; onError: (message: string) => void;
  onKey: (key: string) => void; onLook: (heading: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ heading, reduced, onReady, onError, onKey, onLook });
  latest.current = { heading, reduced, onReady, onError, onKey, onLook };
  useEffect(() => {
    const element = host.current!;
    let active = true, token = 0, cancel: (() => void) | null = null, api: any, pano: any, lookTimer = 0;
    const keys = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!KEYS.includes(key) || event.metaKey || event.ctrlKey || event.altKey) return;
      // Google’s viewer walks on arrow keys itself; Everwhere’s executor must be the only one that moves.
      event.stopPropagation(); event.preventDefault(); latest.current.onKey(key);
    };
    element.addEventListener('keydown', keys, true);
    // Dragging the view or hiding the page takes over from a running move; plain blur (a VoiceOS overlay) does not.
    const takeover = () => { token++; cancel?.(); };
    const hidden = () => { if (document.hidden) takeover(); };
    element.addEventListener('pointerdown', takeover, true);
    document.addEventListener('visibilitychange', hidden);
    authFailure = () => { if (active) latest.current.onError('Google refused this Maps key. Check its API and website restrictions, then reload.'); };
    // Resolves true only after Google reports the expected panorama as loaded; a requested pano alone proves nothing.
    const settle = (expected: string | null, timeout: number) => new Promise<boolean>(resolve => {
      const done = (ok: boolean) => { clearTimeout(timer); listeners.forEach(item => item.remove()); cancel = null; resolve(ok); };
      const check = () => {
        const status = pano.getStatus();
        if (status === 'OK' && (!expected || pano.getPano() === expected)) done(true);
        else if (status && status !== 'OK') done(false);
      };
      const listeners = ['status_changed', 'links_changed', 'position_changed'].map(name => pano.addListener(name, check));
      const timer = setTimeout(() => done(false), timeout);
      cancel = () => done(false);
      // The first load may already be OK with no later event. A hop must wait for an event: its old status is still OK.
      if (!expected) check();
    });
    void (async () => {
      try {
        api = await loadMaps();
        const service = new api.StreetViewService();
        const location = { lat: locator.lat, lng: locator.lng };
        let found: any;
        for (const request of [locator.panoId && { pano: locator.panoId }, { location, radius: 50, source: 'outdoor' }, { location, radius: 50 }]) {
          if (!request) continue;
          // Provider panorama IDs are replaceable hints; fall back to the authored location.
          try {
            found = (await Promise.race([service.getPanorama(request), new Promise<never>((_, reject) => setTimeout(reject, 6000))])).data;
            if (found?.location?.pano) break;
          } catch { /* No coverage, refusal or timeout: try the next locator. */ }
          if (!active) return;
        }
        if (!active) return;
        if (!found?.location?.pano) throw new Error('Google Street View is unavailable at this stop: no coverage was found, or the request was refused.');
        pano = new api.StreetViewPanorama(element, {
          pano: found.location.pano, pov: { heading: latest.current.heading ?? locator.heading ?? 0, pitch: locator.pitch ?? 0 },
          disableDefaultUI: true, linksControl: false, panControl: false, zoomControl: false, addressControl: false, fullscreenControl: false,
          enableCloseButton: false, motionTracking: false, motionTrackingControl: false, clickToGo: false, showRoadLabels: false
        });
        const loaded = await settle(null, 12000);
        if (!active) return;
        if (!loaded) throw new Error('Google Street View did not load this stop. Retry, or return to the memory.');
        const current = () => ((pano.getPov().heading % 360) + 360) % 360;
        const result = (status: StreetViewResult['status'], reason?: string): StreetViewResult => ({ status, heading: current(), ...(reason && { reason }) });
        pano.addListener('pov_changed', () => { clearTimeout(lookTimer); lookTimer = window.setTimeout(() => { if (active) latest.current.onLook(current()); }, 800); });
        latest.current.onReady({
          heading: current,
          // Directions Google actually links from here, relative to the current view. No provider IDs leave the viewer.
          navigation: () => ({ heading: current(), availableDirections: (['forward', 'backward', 'left', 'right'] as const)
            .filter(direction => panoramaLink(pano.getLinks() ?? [], pano.getPov().heading, direction)) }),
          stop: () => { token++; cancel?.(); },
          move: async (direction, degrees) => {
            const run = ++token; cancel?.();
            if (direction === 'turn_left' || direction === 'turn_right') {
              const from = pano.getPov().heading, pitch = pano.getPov().pitch, delta = direction === 'turn_left' ? -degrees : degrees;
              const steps = latest.current.reduced ? 1 : 18;
              // Timers, not animation frames: a VoiceOS overlay or background tab must not strand the turn.
              await new Promise<void>(resolve => {
                let step = 0;
                const timer = setInterval(() => {
                  if (run !== token || !active) { clearInterval(timer); resolve(); return; }
                  pano.setPov({ heading: from + delta * ++step / steps, pitch });
                  if (step >= steps) { clearInterval(timer); resolve(); }
                }, 18);
              });
              if (run !== token || !active) return result('stopped', 'The turn was stopped.');
              return Math.abs(normalizedYaw(pano.getPov().heading - from - delta)) < 1 ? result('completed') : result('blocked', 'The view did not turn.');
            }
            const link = panoramaLink(pano.getLinks() ?? [], pano.getPov().heading, direction);
            // A link back to the current panorama would never emit a load event; report it honestly now.
            if (!link || link.pano === pano.getPano()) return result('blocked', 'Street View has no path in that direction from here.');
            const arrived = settle(link.pano, 5000);
            pano.setPano(link.pano);
            const ok = await arrived;
            if (run !== token || !active) return result('stopped', 'Stopped before the next view was confirmed.');
            return ok ? result('completed') : result('blocked', 'Google did not load the next Street View position in time.');
          }
        });
      } catch (reason) { if (active) latest.current.onError((reason as Error).message); }
    })();
    return () => {
      active = false; token++; cancel?.(); clearTimeout(lookTimer); authFailure = null;
      element.removeEventListener('keydown', keys, true);
      element.removeEventListener('pointerdown', takeover, true);
      document.removeEventListener('visibilitychange', hidden);
      if (pano) { api.event.clearInstanceListeners(pano); pano.setVisible(false); }
      element.replaceChildren();
      latest.current.onReady(null);
    };
  }, [locator.lat, locator.lng, locator.panoId]);
  return <div className="tour-live-view" ref={host} aria-label={title + ' — Google Street View'} />;
}
