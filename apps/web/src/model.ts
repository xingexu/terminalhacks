export type View = 'explore' | 'watch' | 'create' | 'remember' | 'archive';
export type Lens = 'all' | 'originals';
export type Profile = 'natural' | 'nostalgic' | 'documentary' | 'vivid';
export type Project = { id: string; title: string; demo: boolean };
export type Memory = { id: string; title: string; startAt: string | null; placeLabel: string; sourceIds: string[]; story: string; gps: [number, number] | null };
export type Source = { id: string; mime: string; caption: string; provenance: 'original' | 'imagined'; capturedAt: string | null; gps?: [number, number] | null };
export type Anchor = { id: string; worldId: string; eventId: string; title: string; sourceIds: string[]; position: [number, number, number] };
export type Recollection = { id: string; eventId: string; anchorId?: string; audioMediaId?: string; contributor: string; text: string; at: string };
export type Job = { id: string; eventId: string; lens: Lens; status: string; approved: boolean; inputHash: string; revision: number; error?: string };
export type World = { id: string; eventId: string; title: string; approved: boolean; inputHash: string; sourceIds: string[]; points: number };
export type Session = { eventId: string | null; anchorId: string | null; view: View; lens: Lens };
export type Snapshot = {
  projectId: string; title: string; demo: boolean; revision: number; seq: number; visualProfile: Profile; session: Session;
  events: Memory[]; media: Source[]; anchors: Anchor[]; recollections: Recollection[]; jobs: Job[];
  worlds: World[];
  history: { revision: number; label: string; at: string }[]; undo: { revision: number; targetId: string } | null;
  capture: { sessions: { id: string; grantId: string; source: string; status: string; expires: number }[] };
};
export type Observation = {
  id: string; caption: string; text?: string; media: Source | null;
  candidates: { id: string; title: string; reason: string }[];
};
export type Diff = { label: string; before?: unknown; after?: unknown; text?: string; caption?: string; containsImagined?: boolean; sources?: number; narration?: boolean };
export type Proposal = { previewToken: string; diff: Diff; command?: Command };
export type Command = { type: string; targetId: string; expectedRevision: number; payload: Record<string, unknown> };
export type SearchResult = { mediaId: string; reason: string; caption: string; eventId: string | null };
export const sourceURL = (project: string, id: string, suffix = '') => '/v1/projects/' + project + '/sources/' + id + suffix;
export const artifactURL = (project: string, id: string, suffix = '') => '/v1/projects/' + project + '/artifacts/' + id + '/' + (suffix || 'file');
export const isVisual = (source: Source) => !source.mime.startsWith('audio/');
export const displayDate = (value?: string | null, short = false) => value ?
  new Intl.DateTimeFormat('en-US', { month: short ? 'short' : 'long', day: 'numeric', ...(short ? {} : { year: 'numeric' }), timeZone: 'UTC' }).format(new Date(value.slice(0, 10) + 'T12:00:00Z')) : 'Date unknown';
export const allowed = (source: Source, lens: Lens) => lens === 'all' || source.provenance === 'original';
export function sourcesFor(state: Snapshot, ids: string[]) {
  return ids.flatMap(id => state.media.filter(item => item.id === id && allowed(item, state.session.lens)));
}
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch('/v1' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: form || body === undefined ? (form ? { 'X-Capture-Id': crypto.randomUUID() } : {}) : { 'Content-Type': 'application/json' },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error(json.message || 'The request could not be completed.');
  return json.data as T;
}
