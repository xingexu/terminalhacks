export type TourLink = { to: string; label: string; yaw?: number; pitch?: number; kind?: 'walk' | 'door' };
export type TourNode = { id: string; title: string; description: string; image?: string;
  projection: 'perspective' | 'equirectangular' | 'streetview'; links: TourLink[];
  facts?: { text: string; url: string }[]; sourceIds?: string[]; streetViewUrl?: string; streetViewEmbedUrl?: string; streetView?: StreetViewLocator };
export type StreetViewLocator = { lat: number; lng: number; heading?: number; pitch?: number; panoId?: string };
export type Tour = { version: 'everwhere-tour-1'; title: string; startNodeId: string; nodes: TourNode[]; liveStreetView?: true };

export function safeStreetViewLocator(value: unknown): StreetViewLocator | undefined {
  const input = value as StreetViewLocator;
  const within = (item: unknown, min: number, max: number, optional = false) => item === undefined ? optional : typeof item === 'number' && Number.isFinite(item) && item >= min && item <= max;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).every(key => ['lat', 'lng', 'heading', 'pitch', 'panoId'].includes(key)) ||
    !within(input.lat, -90, 90) || !within(input.lng, -180, 180) || !within(input.heading, 0, 360, true) || !within(input.pitch, -90, 90, true) ||
    (input.panoId !== undefined && (typeof input.panoId !== 'string' || !input.panoId || input.panoId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.panoId)))) return;
  return { ...input };
}

// Chooses the provider link closest to the requested direction relative to where the viewer is looking.
export function panoramaLink<T extends { heading?: number | null; pano?: string | null }>(links: (T | null | undefined)[], heading: number, direction: 'forward' | 'backward' | 'left' | 'right') {
  const target = heading + { forward: 0, backward: 180, left: -90, right: 90 }[direction];
  return links.filter((link): link is T & { heading: number; pano: string } => !!link?.pano && typeof link.heading === 'number' && Number.isFinite(link.heading))
    .map(link => ({ link, off: Math.abs(normalizedYaw(link.heading - target)) }))
    .filter(item => item.off <= 60).sort((a, b) => a.off - b.off)[0]?.link;
}

export function safeReferenceURL(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Invalid citation. */ }
}

export function safeStreetViewEmbed(value: unknown): string | undefined {
  const href = safeReferenceURL(value);
  if (!href) return;
  const url = new URL(href);
  const keys = [...url.searchParams.keys()];
  if (url.origin === 'https://www.google.com' && url.pathname === '/maps/embed' && !url.hash && keys.length === 1 && keys[0] === 'pb' && url.searchParams.get('pb')?.trim()) return url.href;
}

export function readTour(value: unknown): Tour {
  const input = value as Tour;
  const text = (item: unknown, max = 2000): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= max;
  if (!input || input.version !== 'everwhere-tour-1' || !text(input.title, 200) || !Array.isArray(input.nodes) ||
    !input.nodes.length || input.nodes.length > 8) throw new Error('This walkthrough has an unsupported scene format.');
  const ids = new Set<string>();
  for (const node of input.nodes) {
    if (!node || !text(node.id, 128) || ids.has(node.id) || !text(node.title, 200) ||
      (node.description !== undefined && (typeof node.description !== 'string' || node.description.length > 4000)) ||
      (node.projection !== 'streetview' && node.streetView !== undefined) ||
      (node.projection === 'streetview' ? (node.streetView !== undefined ? !safeStreetViewLocator(node.streetView) || node.streetViewEmbedUrl !== undefined : !safeStreetViewEmbed(node.streetViewEmbedUrl)) :
        typeof node.image !== 'string' || !/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(node.image)) ||
      !['perspective', 'equirectangular', 'streetview'].includes(node.projection) || !Array.isArray(node.links) || node.links.length > 8) {
      throw new Error('A viewpoint is missing its image or has invalid scene details.');
    }
    ids.add(node.id);
  }
  if (!ids.has(input.startNodeId)) throw new Error('The starting viewpoint is unavailable.');
  const nodes = input.nodes.map(node => {
    for (const link of node.links) {
      if (!link || !ids.has(link.to) || !text(link.label, 160) ||
        (link.kind !== undefined && !['walk', 'door'].includes(link.kind)) ||
        (link.yaw !== undefined && (!Number.isFinite(link.yaw) || Math.abs(link.yaw) > 180)) ||
        (link.pitch !== undefined && (!Number.isFinite(link.pitch) || Math.abs(link.pitch) > 90))) {
        throw new Error('A route points to a missing or invalid viewpoint.');
      }
    }
    return { ...node, description: node.description ?? '', facts: Array.isArray(node.facts) ? node.facts.filter(fact => fact && text(fact.text, 2048) && safeReferenceURL(fact.url)).slice(0, 8) : [],
      sourceIds: Array.isArray(node.sourceIds) ? node.sourceIds.filter(id => text(id, 128)) : [],
      streetViewUrl: safeReferenceURL(node.streetViewUrl), streetViewEmbedUrl: safeStreetViewEmbed(node.streetViewEmbedUrl),
      ...(node.streetView !== undefined && { streetView: safeStreetViewLocator(node.streetView) }) };
  });
  return { version: 'everwhere-tour-1', title: input.title, startNodeId: input.startNodeId, nodes, ...(nodes.every(node => node.streetView) && { liveStreetView: true as const }) };
}

export const normalizedYaw = (degrees: number) => ((degrees + 180) % 360 + 360) % 360 - 180;
export const linkYaw = (link: TourLink, index: number) => normalizedYaw(link.yaw ?? (index === 0 ? 0 : index % 2 ? -45 : 45));

export function directionLink(node: TourNode, direction: 'forward' | 'left' | 'right' | 'back', lookYaw = 0): TourLink | undefined {
  const target = { forward: 0, left: -90, right: 90, back: 180 }[direction];
  return node.links.map((link, index) => ({ link, yaw: normalizedYaw(linkYaw(link, index) - lookYaw) }))
    .filter(({ yaw }) => direction === 'forward' ? Math.abs(yaw) <= 90 : direction === 'back' ? Math.abs(yaw) > 90 : direction === 'left' ? yaw < -10 : yaw > 10)
    .sort((a, b) => Math.abs(normalizedYaw(a.yaw - target)) - Math.abs(normalizedYaw(b.yaw - target)))[0]?.link;
}
