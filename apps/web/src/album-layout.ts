import type { Source } from './model';

export type AlbumPosition = { x: number; z: number };
export type PhotoStop = AlbumPosition & { sourceId: string; yaw: number };

export function orderedPhotos(sources: Source[]) {
  return sources.filter(source => source.mime.startsWith('image/')).sort((a, b) => {
    const first = Date.parse(a.capturedAt || '');
    const second = Date.parse(b.capturedAt || '');
    if (!Number.isFinite(first)) return Number.isFinite(second) ? 1 : 0;
    if (!Number.isFinite(second)) return -1;
    return first - second;
  });
}

export function photoStops(sources: Source[]): PhotoStop[] {
  return sources.map((source, index) => ({
    sourceId: source.id,
    x: index % 2 === 0 ? -4.6 : 4.6,
    z: -Math.floor(index / 2) * 9,
    yaw: index % 2 === 0 ? Math.PI / 2 : -Math.PI / 2
  }));
}

export function albumEnd(count: number) {
  return -Math.max(1, Math.ceil(count / 2)) * 9;
}

// The promenade's railings and photo walls bound the walkable area.
export function moveInAlbum(position: AlbumPosition, yaw: number, forward: number, strafe: number, distance: number, end: number): AlbumPosition {
  const length = Math.max(1, Math.hypot(forward, strafe));
  const x = position.x + (-Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * distance / length;
  const z = position.z + (-Math.cos(yaw) * forward - Math.sin(yaw) * strafe) * distance / length;
  return { x: Math.max(-3.4, Math.min(3.4, x)), z: Math.max(end + 2, Math.min(7, z)) };
}

export function nearbyPhoto(position: AlbumPosition, stops: PhotoStop[]) {
  let nearest: PhotoStop | undefined;
  let distance = 4.3;
  for (const stop of stops) {
    const candidate = Math.hypot(position.x - stop.x, position.z - stop.z);
    if (candidate < distance) { nearest = stop; distance = candidate; }
  }
  return nearest;
}
