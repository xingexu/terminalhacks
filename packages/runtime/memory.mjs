import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import formats from 'ajv-formats';

const ajv = new Ajv({ strict: false });
formats(ajv);
const schema = name => JSON.parse(readFileSync(new URL('../contracts/' + name + '.schema.json', import.meta.url)));
export const validateCommand = ajv.compile(schema('command-envelope'));
export const validateObservation = ajv.compile(schema('capture-observation'));
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const profiles = ['natural', 'nostalgic', 'documentary', 'vivid'];
export const views = ['explore', 'watch', 'create', 'remember', 'archive'];

export class Problem extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export function requireCondition(condition, status, code, message, details) {
  if (!condition) throw new Problem(status, code, message, details);
}

export function digest(value) {
  function canonical(item) {
    if (item === undefined) return null;
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(canonical);
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const demoEvents = [
  { id: 'e-lake', title: 'Lago di Braies', placeLabel: 'South Tyrol, Italy', startAt: '2024-10-12T10:00:00+02:00', story: 'The lake was still that morning. From the old boathouse, the mountains seemed to go on forever below the waterline.', gps: [46.694, 12.085], sourceIds: ['m-lake', 'm-boats'], tags: 'lake water harbor rowboats dock dolomites autumn' },
  { id: 'e-cabin', title: 'The mountain refuge', placeLabel: 'South Tyrol, Italy', startAt: '2024-10-13T16:00:00+02:00', story: 'After a long climb, we found a little wooden refuge tucked against the mountain.', gps: [46.675, 12.113], sourceIds: ['m-cabin'], tags: 'cabin coffee refuge dinner wood afternoon dolomites' },
  { id: 'e-trail', title: 'Sunrise at Tre Cime', placeLabel: 'Belluno, Italy', startAt: '2024-10-14T07:00:00+02:00', story: 'We set out before sunrise and reached the ridge as the first light found the peaks.', gps: [46.618, 12.303], sourceIds: ['m-trail'], tags: 'sunrise hike trail mountain dawn peaks dolomites' }
];
const demoMedia = [
  ['lake', 'From the lakeshore'],
  ['boats', 'The old boathouse'],
  ['cabin', 'A refuge in the mountains'],
  ['trail', 'First light on the ridge']
];

export function createMemory(title, demo = false) {
  const events = demo ? demoEvents.map(event => ({ ...structuredClone(event), version: 0 })) : [];
  const media = demo ? demoMedia.map(([name, caption]) => ({
    id: 'm-' + name, mime: 'image/webp', caption, capturedAt: null, provenance: 'imagined',
    demoFile: name + '.webp', hash: digest(name)
  })) : [];
  const anchors = demo ? [
    { id: 'a-lake', eventId: 'e-lake', sourceIds: ['m-lake'], title: 'Lakeshore', position: [0, 0, 0] },
    { id: 'a-boats', eventId: 'e-lake', sourceIds: ['m-boats'], title: 'Boathouse', position: [1, 0, 0] },
    { id: 'a-cabin', eventId: 'e-cabin', sourceIds: ['m-cabin'], title: 'Refuge', position: [0, 0, 0] },
    { id: 'a-trail', eventId: 'e-trail', sourceIds: ['m-trail'], title: 'Ridge', position: [0, 0, 0] }
  ].map(anchor => ({ ...anchor, worldId: 'trail-' + anchor.eventId })) : [];
  return {
    title, demo, revision: 0, seq: 0, visualProfile: 'natural', events, media, anchors,
    session: { eventId: events[0]?.id ?? null, anchorId: anchors[0]?.id ?? null, view: 'explore', lens: demo ? 'all' : 'originals' },
    recollections: [], history: [], changes: [], requests: {}, previews: {}, jobs: [], worlds: [],
    capture: { sessions: [], observations: [] }
  };
}

export const eventById = (state, id) => state.events.find(event => event.id === id);
export const mediaById = (state, id) => state.media.find(item => item.id === id && !item.revoked);
export const isOriginal = item => item?.provenance === 'original';
export const lensAllows = (item, lens) => Boolean(item && !item.revoked && (lens === 'all' || isOriginal(item)));

export function eventDependencies(state, eventId, lens, worldId = null) {
  const event = eventById(state, eventId);
  if (!event) return null;
  const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
  const material = event.sourceIds.map(id => mediaById(state, id)).filter(item => !item?.pending && lensAllows(item, lens));
  const recollections = state.recollections.filter(item => item.eventId === eventId && (!item.audioMediaId || mediaById(state, item.audioMediaId)))
    .sort((a, b) => (time(a.at) - time(b.at) || a.id.localeCompare(b.id)));
  const media = material.filter(item => item.mime.startsWith('image/') || item.mime.startsWith('video/'))
    .sort((a, b) => (time(a.capturedAt) - time(b.capturedAt) || a.id.localeCompare(b.id)));
  const available = new Set(media.map(item => item.id));
  const worlds = lens === 'all' ? (state.worlds || []).filter(world => world.eventId === eventId && world.approved &&
    !world.revoked && world.status === 'ready' && world.sourceIds.length && world.sourceIds.every(id => available.has(id)) &&
    (!world.evidenceHash || world.evidenceHash === digest(generationDependencies(state, eventId, world.evidenceRefs)))) : [];
  const world = worldId ? worlds.find(item => item.id === worldId) : worlds.filter(item => item.format === 'glb').at(-1) ?? worlds.at(-1);
  const planned = world?.plan?.sourceIds?.filter(id => world.sourceIds.includes(id) && available.has(id)) || [];
  const selected = [...new Set([...planned, ...media.filter(item => !world || world.sourceIds.includes(item.id)).map(item => item.id)])];
  const sourceIds = [...selected, ...media.filter(item => !selected.includes(item.id)).map(item => item.id)];
  const cut = selected.slice(0, 8);
  const seconds = cut.length ? Math.max(4, Math.ceil(30 / cut.length)) : 0;
  const usedAccounts = new Set();
  const frames = cut.map(sourceId => {
    const item = media.find(item => item.id === sourceId);
    const account = recollections.find(item => !usedAccounts.has(item.id) && item.text?.trim() &&
      item.anchorId && state.anchors.some(anchor => anchor.id === item.anchorId && anchor.sourceIds.includes(sourceId))) ??
      recollections.find(item => !usedAccounts.has(item.id) && item.text?.trim() && !item.anchorId);
    if (account) usedAccounts.add(account.id);
    const accountText = Array.from(account?.text.replace(/\s+/g, ' ').trim() ?? '');
    return { sourceId, seconds, caption: item.caption, provenance: item.provenance, capturedAt: item.capturedAt ?? null,
      ...(account && { recollection: { id: account.id, contributor: 'You',
        text: accountText.slice(0, 180).join('') + (accountText.length > 180 ? '…' : ''), excerpt: accountText.length > 180 } }) };
  });
  const narratedAccount = recollections.find(item => {
    const audio = mediaById(state, item.audioMediaId);
    return usedAccounts.has(item.id) && audio?.mime.startsWith('audio/') && !audio.pending && lensAllows(audio, lens);
  });
  const narration = narratedAccount ? mediaById(state, narratedAccount.audioMediaId) : null;
  const narratedFrame = frames.findIndex(frame => frame.recollection?.id === narratedAccount?.id);
  const narrationPlan = narration ? { sourceId: narration.id, recollectionId: narratedAccount.id,
    startSeconds: frames.slice(0, narratedFrame).reduce((sum, frame) => sum + frame.seconds, 0),
    seconds: Math.min(Number.isFinite(narration.duration) && narration.duration > 0 ? narration.duration : Infinity, frames[narratedFrame].seconds) } : null;
  const cutPlan = { eventId, kind: 'source_montage', basis: planned.length ? 'world_plan' : world ? 'world_sources' : 'memory_sources',
    worldId: world?.id ?? null, planId: planned.length ? world.planId ?? world.plan.id ?? null : null,
    sourceIds, excludedSourceIds: sourceIds.slice(cut.length), frames, durationSeconds: cut.length * seconds, narration: narrationPlan,
    omittedRecollections: recollections.filter(item => item.text?.trim() && !usedAccounts.has(item.id)).length };
  return {
    event, profile: state.visualProfile, lens,
    media, storyboard: { id: digest(cutPlan), ...cutPlan },
    world: world ? { id: world.id, inputHash: world.inputHash, contentHash: world.contentHash } : null,
    anchors: state.anchors.filter(anchor => anchor.eventId === eventId),
    recollections,
    narration
  };
}

export function filmDependencies(state, eventId, lens, recording = null) {
  const manifest = eventDependencies(state, eventId, lens, recording?.worldId);
  if (!recording) return manifest;
  if (!manifest || manifest.world?.id !== recording.worldId) return null;
  const { storage, ...sceneRecording } = recording;
  const scale = recording.durationSeconds / manifest.storyboard.durationSeconds;
  const frames = manifest.storyboard.frames.map(frame => ({ ...frame, seconds: frame.seconds * scale }));
  const original = manifest.storyboard.narration;
  const narration = original ? { ...original, startSeconds: original.startSeconds * scale,
    seconds: Math.min(original.seconds, frames.find(frame => frame.recollection?.id === original.recollectionId).seconds) } : null;
  const { id, ...sourcePlan } = manifest.storyboard;
  const plan = { ...sourcePlan, kind: 'scene_recording', durationSeconds: recording.durationSeconds, frames, narration };
  return { ...manifest, storyboard: { id: digest({ ...plan, path: recording.path.cameraPath }), ...plan }, sceneRecording };
}

// Only evidence affects a generated scene; approvals and camera waypoints do not.
export function generationDependencies(state, eventId, selected) {
  const event = eventById(state, eventId);
  if (!event) return null;
  const { title, placeLabel, startAt, gps, story } = event;
  const media = event.sourceIds.map(id => mediaById(state, id)).filter(item => item && !item.pending && (!selected || selected.mediaIds.includes(item.id)))
    .map(({ id, hash, caption, mime, capturedAt, capturedLocal, gps, provenance }) => ({ id, hash, caption, mime, capturedAt, capturedLocal, gps, provenance }));
  const recollections = state.recollections.filter(item => item.eventId === eventId && (!item.audioMediaId || mediaById(state, item.audioMediaId)) &&
    (!selected || selected.recollectionIds.includes(item.id)))
    .map(({ id, text, audioMediaId }) => ({ id, text, audioMediaId }));
  return { eventId, title, placeLabel, startAt, gps, story, media, recollections };
}

export function invalidateJobs(state) {
  for (const job of state.jobs) {
    if (!['queued', 'running', 'ready'].includes(job.status)) continue;
    if (job.inputHash !== digest(filmDependencies(state, job.eventId, job.lens, job.manifest?.sceneRecording))) {
      job.status = 'stale';
      job.approved = false;
    }
  }
  for (const world of state.worlds || []) {
    if (world.evidenceHash && world.evidenceHash !== digest(generationDependencies(state, world.eventId, world.evidenceRefs))) {
      world.status = 'stale';
      world.approved = false;
      delete world.plan;
    }
  }
  for (const [eventId, research] of Object.entries(state.locationResearch || {})) {
    if (research.inputHash !== digest(generationDependencies(state, eventId))) delete state.locationResearch[eventId];
  }
  for (const [token, preview] of Object.entries(state.previews || {})) {
    if (preview.kind === 'world' && preview.plan.inputHash !== digest(generationDependencies(state, preview.plan.eventId))) delete state.previews[token];
    if (preview.kind === 'film' && preview.inputHash !== digest(eventDependencies(state, preview.eventId, preview.lens))) delete state.previews[token];
    if (preview.kind === 'scene-film' && preview.inputHash !== digest(filmDependencies(state, preview.eventId, preview.lens, preview.recording))) delete state.previews[token];
  }
}

export function appendChange(state, label, eventId, inverse = null) {
  state.revision += 1;
  state.history.unshift({ revision: state.revision, label, eventId, at: now() });
  if (inverse) state.changes.unshift({ revision: state.revision, ...inverse });
  invalidateJobs(state);
}

export function applyCommand(state, command, actor, observationId) {
  const { targetId, payload, type } = command;
  const event = eventById(state, targetId);
  requireCondition(event, 404, 'EVENT_NOT_FOUND', 'That memory is unavailable.');
  let inverse;
  let label;
  let data;
  switch (type) {
    case 'event.correct': {
      const { position, ...patch } = payload.patch;
      const anchor = state.anchors.find(item => item.id === state.session.anchorId && item.eventId === event.id);
      requireCondition(!position || anchor, 400, 'ANCHOR_REQUIRED', 'Select a waypoint before editing its position.');
      const before = Object.fromEntries(Object.keys(patch).map(key => [key, event[key]]));
      inverse = { type, targetId, before, ...(position && { anchorId: anchor.id, position: anchor.position }) };
      Object.assign(event, patch);
      if (position) anchor.position = position;
      event.version += 1;
      label = 'Corrected ' + event.title;
      data = { before, after: patch };
      break;
    }
    case 'event.media.link': {
      const source = mediaById(state, payload.mediaId);
      requireCondition(source && source.mime !== 'audio/webm' && source.mime !== 'audio/mp4', 404, 'SOURCE_NOT_FOUND', 'That visual source is unavailable.');
      requireCondition(!source.pending || state.capture.observations.some(item =>
        item.id === observationId && item.status === 'pending' && item.mediaId === source.id),
        409, 'REVIEW_REQUIRED', 'Review this source through the Capture inbox.');
      requireCondition(!event.sourceIds.includes(source.id), 409, 'ALREADY_LINKED', 'This source is already linked to the memory.');
      event.sourceIds.push(source.id);
      event.relations = { ...event.relations, [source.id]: payload.relation };
      event.version += 1;
      inverse = { type, targetId, mediaId: source.id };
      label = 'Linked ' + source.caption;
      data = { mediaId: source.id, caption: source.caption, relation: payload.relation };
      break;
    }
    case 'recollection.add': {
      const anchor = state.anchors.find(item => item.id === payload.anchorId && item.eventId === targetId);
      const audio = mediaById(state, payload.audioMediaId);
      requireCondition(!payload.anchorId || anchor, 404, 'ANCHOR_NOT_FOUND', 'That waypoint is unavailable.');
      requireCondition(!payload.audioMediaId || audio?.mime.startsWith('audio/'), 404, 'SOURCE_NOT_FOUND', 'That voice recording is unavailable.');
      requireCondition(!audio?.pending || state.capture.observations.some(item =>
        item.id === observationId && item.status === 'pending' && item.mediaId === audio.id),
        409, 'REVIEW_REQUIRED', 'Review this voice note through the Capture inbox.');
      const item = { ...payload, id: uid(), eventId: event.id, actor, provenance: 'recollected', at: now() };
      state.recollections.push(item);
      inverse = { type, targetId, id: item.id };
      label = 'Added a recollection to ' + event.title;
      data = { text: item.text };
      break;
    }
    case 'anchor.add': {
      const world = state.worlds?.find(item => item.id === payload.worldId && item.eventId === event.id && item.approved && !item.revoked);
      requireCondition(world || payload.worldId === 'trail-' + event.id, 404, 'WORLD_NOT_FOUND', 'That scene is unavailable.');
      requireCondition(payload.sourceIds.every(id => event.sourceIds.includes(id) && mediaById(state, id)), 404, 'SOURCE_NOT_FOUND', 'A waypoint source is unavailable.');
      const anchor = { ...payload, id: uid(), eventId: event.id, title: 'Waypoint ' + (state.anchors.filter(item => item.eventId === event.id).length + 1) };
      state.anchors.push(anchor);
      inverse = { type, targetId, id: anchor.id };
      label = 'Added ' + anchor.title;
      data = { title: anchor.title, position: anchor.position };
      break;
    }
    case 'profile.set':
      inverse = { type, targetId, profile: state.visualProfile };
      data = { before: state.visualProfile, after: payload.preset };
      state.visualProfile = payload.preset;
      label = 'Applied ' + payload.preset + ' grade';
      break;
    case 'artifact.approve': {
      const job = state.jobs.find(item => item.id === payload.artifactId && item.eventId === targetId);
      const world = state.worlds?.find(item => item.id === payload.artifactId && item.eventId === targetId && !item.revoked);
      const asset = world || job;
      requireCondition(asset?.status === 'ready' && asset.inputHash === payload.dependencyHash && asset.contentHash,
        409, 'ARTIFACT_CHANGED', 'This export is no longer ready for approval.');
      asset.approved = true;
      inverse = { type, targetId, id: asset.id };
      label = world ? (world.provenance === 'imagined' ? 'Approved an imagined scene' : 'Approved a reconstructed scene') : 'Approved a film export';
      data = { artifactId: asset.id, contentHash: asset.contentHash };
      break;
    }
    case 'undo': {
      const change = state.changes[0];
      requireCondition(change?.revision === payload.revisionToUndo && change.targetId === targetId, 409, 'UNDO_UNAVAILABLE', 'That change can no longer be undone.');
      undoChange(state, event, change);
      state.changes.shift();
      label = 'Undid revision ' + change.revision;
      data = { revisionToUndo: change.revision };
      break;
    }
  }
  appendChange(state, label, event.id, inverse);
  return { label, ...data };
}

function undoChange(state, event, change) {
  switch (change.type) {
    case 'event.correct': {
      Object.assign(event, change.before);
      const anchor = state.anchors.find(item => item.id === change.anchorId);
      if (anchor) anchor.position = change.position;
      event.version += 1;
      break;
    }
    case 'event.media.link':
      event.sourceIds = event.sourceIds.filter(id => id !== change.mediaId);
      delete event.relations?.[change.mediaId];
      event.version += 1;
      break;
    case 'recollection.add':
      state.recollections = state.recollections.filter(item => item.id !== change.id);
      break;
    case 'anchor.add':
      state.anchors = state.anchors.filter(item => item.id !== change.id);
      state.recollections = state.recollections.map(item => item.anchorId === change.id ? { ...item, anchorId: undefined } : item);
      if (state.session.anchorId === change.id) state.session.anchorId = null;
      break;
    case 'profile.set':
      state.visualProfile = change.profile;
      break;
    case 'artifact.approve': {
      const asset = state.jobs.find(item => item.id === change.id) || state.worlds?.find(item => item.id === change.id);
      if (asset) asset.approved = false;
      break;
    }
  }
}

export function rank(state, query, eventId = null) {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const matches = value => tokens.filter(word => word.length > 1 && value.toLowerCase().includes(word)).length;
  return state.media.filter(item => !item.pending && lensAllows(item, state.session.lens)).flatMap(item => {
    const events = state.events.filter(event => event.sourceIds.includes(item.id));
    if (eventId && !events.some(event => event.id === eventId)) return [];
    const caption = matches(item.caption);
    const eventMatch = events.map(event => ({ event, score: matches([event.title, event.placeLabel, event.tags, event.story].join(' ')) }))
      .sort((a, b) => b.score - a.score)[0];
    const score = caption * 3 + (eventMatch?.score ?? 0);
    return score ? [{ mediaId: item.id, caption: item.caption, eventId: eventMatch?.event.id ?? null, score, reason: caption ? 'Source caption match' : 'Linked memory match' }] : [];
  }).sort((a, b) => b.score - a.score || a.mediaId.localeCompare(b.mediaId)).slice(0, 5);
}
