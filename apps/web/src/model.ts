import type { SceneManifest } from './gameplay/contracts';

export type View = 'universe' | 'explore' | 'watch' | 'create' | 'remember' | 'archive';
export type Lens = 'all' | 'originals';
export type Profile = 'natural' | 'nostalgic' | 'documentary' | 'vivid';
export type Project = { id: string; title: string; demo: boolean };
export type Memory = { id: string; title: string; startAt: string | null; placeLabel: string; sourceIds: string[]; story: string; gps: [number, number] | null };
export type Source = { id: string; mime: string; caption: string; provenance: 'original' | 'imagined'; capturedAt: string | null; capturedLocal?: string | null; gps?: [number, number] | null;
  attribution?: { kind: 'public_reference'; title: string | null; creator: string; sourceUrl: string; license: string; licenseUrl: string; reportedDate: string | null; dateNote: string } };
export type Anchor = { id: string; worldId: string; eventId: string; title: string; sourceIds: string[]; position: [number, number, number]; nodeId?: string };
export type Recollection = { id: string; eventId: string; anchorId?: string; audioMediaId?: string; contributor: string; text: string; at: string };
export type Storyboard = {
  id: string; eventId: string; kind: 'source_montage' | 'scene_recording'; basis: 'world_plan' | 'world_sources' | 'memory_sources';
  worldId: string | null; planId: string | null; sourceIds: string[]; excludedSourceIds: string[];
  durationSeconds: number; omittedRecollections: number;
  narration: { sourceId: string; recollectionId: string; startSeconds: number; seconds: number } | null;
  frames: { sourceId: string; seconds: number; caption: string; provenance: 'original' | 'imagined'; capturedAt: string | null;
    recollection?: { id: string; text: string; contributor: 'You'; excerpt: boolean } }[];
};
export const storyboardBasis = {
  world_plan: 'Follows the approved world’s photo order.',
  world_sources: 'Uses the approved world’s sources in capture-date order; unknown dates follow.',
  memory_sources: 'Uses this memory’s sources in capture-date order; unknown dates follow.'
};
export type SceneRecording = { worldId: string; worldTitle: string; provenance: 'imagined' | 'reconstructed'; durationSeconds: number; width: number; height: number };
export type Job = { id: string; eventId: string; kind?: 'source_montage' | 'scene_recording'; lens: Lens; status: string; approved: boolean; inputHash: string; revision: number; error?: string; storyboard?: Storyboard; recording?: SceneRecording };
export type World = {
  id: string; eventId: string; title: string; approved: boolean; inputHash: string; sourceIds: string[]; points: number;
  format?: 'spz' | 'glb' | 'tour'; provenance?: 'imagined' | 'reconstructed'; status?: 'ready' | 'stale';
  tour?: { startNodeId: string; liveStreetView?: boolean; nodes: { id: string; title: string; sourceIds?: string[] }[] };
  provider?: string; planId?: string; sceneManifest?: SceneManifest;
};
export type Environment = 'mountain' | 'coast' | 'forest' | 'urban' | 'open';
export type Season = 'green' | 'snow' | 'autumn';
export type PlaceResearch = {
  inputHash: string; lookup: { query: string; coordinates: [number, number] | null }; fetchedAt: string; provider: string;
  articles: { title: string; extract: string; url: string; provenance: 'web_context' }[]; attribution: string;
};
export type GenerationEvidence = {
  eventId: string; title: string; placeLabel: string; startAt: string | null; gps: [number, number] | null;
  story: string; media: Source[]; recollections: { id: string; text: string; audioMediaId?: string }[];
  inputHash: string; photoLocations: { sourceId: string; coordinates: [number, number] }[];
  research: PlaceResearch | null; unknowns: string[];
  suggestion: { environment: Environment; season: Season; basis: string };
  lookup: { query: string; coordinates: [number, number] | null };
};
export type WorldPreview = {
  previewToken: string; expires: string;
  plan: { id: string; revision: number; title: string; environment: Environment; season: Season; sourceIds: string[];
    evidence: GenerationEvidence; provenance: 'imagined'; provider: string };
  diff: { label: string; text: string };
};
export type Movement = { id: string; worldId: string; viewerId?: string; direction: 'forward' | 'backward' | 'left' | 'right' | 'turn_left' | 'turn_right' | 'stop'; durationSeconds: number; degrees: number; issuedAt: string; expiresAt: string };
export type Session = { anchorNavigationId?: string | null; eventId: string | null; anchorId: string | null; view: View; lens: Lens; movement?: Movement;
  cameraViewerId?: string | null; cameraReceipt?: unknown;
  cameraAction?: { id: string; action: 'open' | 'capture' | 'close'; viewerId: string; eventId: string; issuedAt: string; expiresAt: string };
  activeWorldId?: string | null; activeViewerId?: string; streetViewPlace?: { worldId: string; nodeId: string; heading: number } };
export type Snapshot = {
  projectId: string; title: string; demo: boolean; revision: number; seq: number; visualProfile: Profile; session: Session;
  events: Memory[]; media: Source[]; anchors: Anchor[]; recollections: Recollection[]; jobs: Job[];
  worlds: World[]; storyboards: Record<string, Storyboard>;
  history: { revision: number; label: string; at: string }[]; undo: { revision: number; targetId: string } | null;
  capture: { sessions: { id: string; grantId: string; source: string; status: string; expires: number }[] };
};
export type Observation = {
  id: string; caption: string; text?: string; media: Source | null;
  candidates: { id: string; title: string; reason: string }[];
};
export type Diff = { label: string; before?: unknown; after?: unknown; text?: string; caption?: string; containsImagined?: boolean; sources?: number; narration?: boolean; storyboard?: Storyboard; recording?: SceneRecording };
export type Proposal = { previewToken: string; diff: Diff; command?: Command; expires?: string };
export type Command = { type: string; targetId: string; expectedRevision: number; payload: Record<string, unknown> };
export type SearchResult = { mediaId: string; reason: string; caption: string; eventId: string | null };
export const sourceURL = (project: string, id: string, suffix = '') => '/v1/projects/' + project + '/sources/' + id + suffix;
export const artifactURL = (project: string, id: string, suffix = '') => '/v1/projects/' + project + '/artifacts/' + id + '/' + (suffix || 'file');
export const isVisual = (source: Source) => !source.mime.startsWith('audio/');
export function localDateTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
export const displayDate = (value?: string | null, short = false) => {
  if (!value) return 'Date unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unknown';
  return new Intl.DateTimeFormat('en-US', { month: short ? 'short' : 'long', day: 'numeric', ...(short ? {} : { year: 'numeric' }) }).format(date);
};
export const allowed = (source: Source, lens: Lens) => lens === 'all' || source.provenance === 'original';
export function sourcesFor(state: Snapshot, ids: string[]) {
  return ids.flatMap(id => state.media.filter(item => item.id === id && allowed(item, state.session.lens)));
}
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch('/v1' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: form || body === undefined ? (form ? { 'X-Capture-Id': crypto.randomUUID() } : {}) : { 'Content-Type': 'application/json' },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new ApiError(json.message || 'The request could not be completed.', response.status, json.code);
  return json.data as T;
}
