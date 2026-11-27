import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendChange, applyCommand, digest, eventById, eventDependencies, invalidateJobs,
  lensAllows, mediaById, now, rank, requireCondition as check, uid, validateCommand, validateObservation, views
} from '../../packages/runtime/memory.mjs';
import { renderFilm } from '../../packages/media/local.mjs';

const twoHours = 2 * 3600_000;
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const revision = (state, expected) => check(state.revision === expected, 409, 'REVISION_CONFLICT',
  'This memory has changed. Review the latest version and try again.', { revision: state.revision });
const bodyMatches = (value, saved) => digest(value) === saved.hash;

function replay(state, key, payload) {
  const saved = state.requests[key];
  if (!saved) return null;
  check(bodyMatches(payload, saved), 409, 'REQUEST_ID_REUSED', 'This request ID was already used for different content.');
  return saved.result;
}

function record(state, key, payload, result) {
  state.requests[key] = { hash: digest(payload), result };
  return result;
}

export function cleanMedia(media) {
  const { storage, thumb, playback, hash, demoFile, revoked, ...item } = media;
  return item;
}

function cleanJob(job) {
  const { manifest, output, captions, ...details } = job;
  return details;
}

export function getSnapshot(projectId, state) {
  return {
    projectId, title: state.title, demo: state.demo, revision: state.revision, seq: state.seq,
    visualProfile: state.visualProfile, session: state.session, events: state.events, anchors: state.anchors,
    media: state.media.filter(item => !item.revoked && !item.pending).map(cleanMedia),
    recollections: state.recollections.map(({ actor, ...item }) => ({ ...item, contributor: 'You' })),
    jobs: state.jobs.map(cleanJob), history: state.history,
    worlds: (state.worlds || []).filter(item => !item.revoked).map(({ storage, contentHash, ...item }) => item),
    undo: state.changes[0] ? { revision: state.changes[0].revision, targetId: state.changes[0].targetId } : null,
    capture: { sessions: state.capture.sessions.map(session => ({ ...session, status: session.status === 'active' && session.expires <= Date.now() ? 'expired' : session.status })) }
  };
}

export function createEvent(state, input) {
  check(text(input.title, 180), 400, 'INVALID_TITLE', 'Give this memory a name.');
  check(!input.startAt || (typeof input.startAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(input.startAt) &&
    Number.isFinite(Date.parse(input.startAt))), 400, 'INVALID_DATE', 'Use a full date and time with a time zone.');
  check(input.gps == null || (Array.isArray(input.gps) && input.gps.length === 2 && input.gps.every(Number.isFinite) &&
    Math.abs(input.gps[0]) <= 90 && Math.abs(input.gps[1]) <= 180), 400, 'INVALID_LOCATION', 'Enter valid latitude and longitude.');
  const event = {
    id: uid(), title: input.title.trim(), placeLabel: text(input.placeLabel, 180) ? input.placeLabel.trim() : 'Unknown location',
    startAt: input.startAt || null, gps: input.gps ?? null, sourceIds: [], version: 0, story: ''
  };
  state.events.push(event);
  state.session = { ...state.session, eventId: event.id, anchorId: null };
  appendChange(state, 'Created ' + event.title, event.id);
  return event;
}

export function updateSession(state, input) {
  const { eventId, view, lens, anchorId } = input;
  if (eventId !== undefined) {
    check(eventById(state, eventId), 404, 'EVENT_NOT_FOUND', 'That memory is unavailable.');
    if (eventId !== state.session.eventId) state.session.anchorId = state.anchors.find(item => item.eventId === eventId)?.id ?? null;
    state.session.eventId = eventId;
  }
  if (view !== undefined) {
    check(views.includes(view), 400, 'INVALID_MODE', 'Choose an available view.');
    state.session.view = view;
  }
  if (lens !== undefined) {
    check(['all', 'originals'].includes(lens), 400, 'INVALID_LENS', 'Choose an available source filter.');
    state.session.lens = lens;
  }
  if (anchorId !== undefined) {
    const anchor = state.anchors.find(item => item.id === anchorId);
    check(anchor, 404, 'ANCHOR_NOT_FOUND', 'That waypoint is unavailable.');
    Object.assign(state.session, { anchorId, eventId: anchor.eventId });
  }
  return state.session;
}

function savePreview(state, entry) {
  for (const [key, prior] of Object.entries(state.previews)) {
    if (prior.expires <= Date.now()) delete state.previews[key];
  }
  check(Object.keys(state.previews).length < 100, 429, 'TOO_MANY_PREVIEWS', 'Finish or wait for an existing preview.');
  const token = uid();
  const expires = Date.now() + 5 * 60_000;
  state.previews[token] = { ...entry, expires };
  return { previewToken: token, diff: entry.diff, expires: new Date(expires).toISOString() };
}

export function previewCommand(state, input, actor, observation = null) {
  const { type, targetId, expectedRevision, payload } = input;
  const proposed = { type, targetId, expectedRevision, payload, previewToken: 'preview', requestId: 'preview' };
  check(validateCommand(proposed), 400, 'INVALID_COMMAND', 'The change is incomplete or contains unsupported information.');
  revision(state, expectedRevision);
  const diff = applyCommand(structuredClone(state), proposed, actor, observation);
  return savePreview(state, {
    kind: 'command', proposed, diff, actor, observation,
    ...(payload.patch?.position && { anchorId: state.session.anchorId })
  });
}

function resolvePreview(state, token, actor, kind) {
  const preview = state.previews[token];
  check(preview?.kind === kind && preview.actor === actor && preview.expires > Date.now(),
    409, 'PREVIEW_EXPIRED', 'This preview expired. Review the change again.');
  return preview;
}

export function commitCommand(state, input, actor, tokenOnly = false) {
  check(text(input.requestId, 128) && text(input.previewToken, 128) && Number.isInteger(input.expectedRevision),
    400, 'INVALID_COMMAND', 'A request ID, preview, and current revision are required.');
  const key = 'command:' + input.requestId;
  const existing = state.requests[key];
  if (existing) {
    if (tokenOnly) {
      const { expectedRevision, previewToken, requestId } = input;
      check(digest({ expectedRevision, previewToken, requestId }) === existing.tokenHash, 409, 'REQUEST_ID_REUSED', 'This request ID was used already.');
      return existing.result;
    }
    return replay(state, key, input);
  }
  const { previewToken, requestId, expectedRevision } = input;
  revision(state, expectedRevision);
  const preview = resolvePreview(state, previewToken, actor, 'command');
  const proposed = { ...preview.proposed, previewToken, requestId };
  check((tokenOnly || (validateCommand(input) && digest(input) === digest(proposed))) && expectedRevision === proposed.expectedRevision,
    409, 'PREVIEW_MISMATCH', 'The confirmed change differs from the preview.');
  check(!preview.anchorId || preview.anchorId === state.session.anchorId, 409, 'ANCHOR_CHANGED', 'The selected waypoint changed. Preview the edit again.');
  let obs;
  if (preview.observation) {
    obs = state.capture.observations.find(item => item.id === preview.observation && item.status === 'pending');
    check(obs, 409, 'OBSERVATION_UNAVAILABLE', 'This capture is no longer awaiting review.');
  }
  const result = applyCommand(state, proposed, actor, preview.observation);
  if (obs) {
    obs.status = 'linked';
    obs.eventId = proposed.targetId;
    obs.reviewRevision = state.revision;
    if (obs.mediaId) {
      const item = mediaById(state, obs.mediaId);
      if (item) item.pending = false;
    }
    invalidateJobs(state);
  }
  delete state.previews[previewToken];
  const data = record(state, key, proposed, { ...result, revision: state.revision });
  state.requests[key].tokenHash = digest({ expectedRevision, previewToken, requestId });
  return data;
}

export function startCapture(state, input) {
  check(input.consent === true, 400, 'CONSENT_REQUIRED', 'Confirm permission to keep the selected sources in this private project.');
  check(['selected_file', 'browser_audio', 'voiceos_text'].includes(input.source), 400, 'CAPTURE_UNAVAILABLE', 'This capture source is unavailable.');
  const session = { id: uid(), grantId: uid(), source: input.source, status: 'active', expires: Date.now() + twoHours, purpose: 'private memory review',
    locationMode: input.source === 'selected_file' && input.keepLocation === true ? 'precise' : 'none' };
  state.capture.sessions.push(session);
  return session;
}

export function assertCapture(state, id, source) {
  const session = state.capture.sessions.find(item => item.id === id);
  check(session?.status === 'active' && session.expires > Date.now() && (!source || source === session.source),
    403, 'CAPTURE_INACTIVE', 'This capture session is no longer active.');
  return session;
}

export function observe(state, input) {
  check(validateObservation(input) && input.location === null, 400, 'INVALID_OBSERVATION', 'This capture needs a supported source and valid metadata.');
  const session = assertCapture(state, input.sessionId, input.source);
  const prior = state.capture.observations.find(item => item.sessionId === input.sessionId && item.externalId === input.externalId && item.source === input.source);
  if (prior) {
    check(prior.inputHash === digest(input), 409, 'CAPTURE_CONFLICT', 'This capture ID refers to different content.');
    check(!['revoked', 'discarded'].includes(prior.status), 404, 'OBSERVATION_UNAVAILABLE', 'This capture is unavailable.');
    return { observationId: prior.id, duplicate: true };
  }
  const media = input.mediaId ? mediaById(state, input.mediaId) : null;
  check(!input.mediaId || media?.captureGrant === session.grantId, 404, 'SOURCE_NOT_FOUND', 'That source is unavailable for this capture session.');
  const item = { ...input, capturedAt: media ? media.capturedAt : input.capturedAt,
    id: uid(), grantId: session.grantId, receivedAt: now(), inputHash: digest(input), status: 'pending' };
  state.capture.observations.push(item);
  return { observationId: item.id, duplicate: false };
}

function nearbyLocation(source, event) {
  if (!source?.gps || !event.gps) return false;
  const radians = degrees => degrees * Math.PI / 180;
  const [lat, lon] = source.gps.map(radians);
  const [eventLat, eventLon] = event.gps.map(radians);
  const distance = Math.sin((lat - eventLat) / 2) ** 2 +
    Math.cos(lat) * Math.cos(eventLat) * Math.sin((lon - eventLon) / 2) ** 2;
  return distance < Math.sin(2 / (2 * 6371)) ** 2;
}

export function inbox(state) {
  return state.capture.observations.filter(item => item.status === 'pending').map(({ inputHash, ...item }) => {
    const source = mediaById(state, item.mediaId);
    const caption = source?.caption || item.text || '';
    const active = eventById(state, state.session.eventId);
    const words = new Set(caption.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    const candidates = state.events.flatMap(event => {
      const terms = [event.title, event.placeLabel, event.tags].join(' ').toLowerCase();
      const matched = [...words].filter(word => terms.includes(word)).length;
      const nearTime = item.capturedAt && event.startAt && Math.abs(Date.parse(item.capturedAt) - Date.parse(event.startAt)) < 12 * 3600_000;
      const nearPlace = nearbyLocation(source, event);
      const current = active?.id === event.id;
      const reasons = [nearTime && 'Capture time is near this memory', nearPlace && 'Embedded photo location is nearby',
        matched && 'Matches the source name or text', current && 'Currently selected memory'].filter(Boolean);
      return reasons.length ? [{ id: event.id, title: event.title, reason: reasons.join(' · '),
        score: (nearTime ? 5 : 0) + (nearPlace ? 5 : 0) + matched + (current ? 0.25 : 0) }] : [];
    }).sort((a, b) => b.score - a.score);
    return { ...item, caption, media: source && cleanMedia(source), candidates };
  });
}

export function capturePreview(state, observationId, input, actor) {
  const observation = state.capture.observations.find(item => item.id === observationId && item.status === 'pending');
  check(observation, 404, 'OBSERVATION_UNAVAILABLE', 'That capture is no longer awaiting review.');
  const source = mediaById(state, observation.mediaId);
  const audio = source?.mime.startsWith('audio/');
  const recollection = observation.kind === 'recollection' || audio;
  const payload = recollection ?
    { text: observation.text || input.text, ...(audio && { audioMediaId: source.id }), ...(input.anchorId && { anchorId: input.anchorId }) } :
    { mediaId: observation.mediaId, relation: input.relation || 'depicts' };
  const command = {
    type: recollection ? 'recollection.add' : 'event.media.link', targetId: input.eventId,
    expectedRevision: input.expectedRevision, payload
  };
  return { ...previewCommand(state, command, actor, observationId), command };
}

export function revokeCapture(state, id, discard = false) {
  const selected = state.capture.observations.find(item => item.id === id);
  const session = state.capture.sessions.find(item => item.grantId === id);
  check(discard ? selected && ['pending', 'discarded'].includes(selected.status) : session,
    404, 'CAPTURE_UNAVAILABLE', 'This capture is unavailable.');
  if (!discard) session.status = 'revoked';
  const affected = state.capture.observations.filter(item => discard ? item.id === id : item.grantId === id);
  for (const item of affected) {
    item.status = discard ? 'discarded' : 'revoked';
    delete item.text;
  }
  const files = state.media.filter(item => !item.revoked && (discard ? selected.mediaId === item.id : item.captureGrant === id));
  const ids = new Set(files.map(item => item.id));
  for (const item of files) item.revoked = true;
  const worlds = (state.worlds || []).filter(world => !world.revoked && world.sourceIds.some(id => ids.has(id)));
  for (const world of worlds) Object.assign(world, { revoked: true, approved: false });
  const observationRevisions = new Set(affected.map(item => item.reviewRevision).filter(Boolean));
  const recollectionIds = new Set(state.changes.filter(item => item.type === 'recollection.add' && observationRevisions.has(item.revision)).map(item => item.id));
  const audioRecollections = new Set(state.recollections.filter(item => ids.has(item.audioMediaId)).map(item => item.id));
  state.recollections = state.recollections.filter(item => !recollectionIds.has(item.id) && !audioRecollections.has(item.id));
  state.changes = state.changes.filter(item => !observationRevisions.has(item.revision) && !ids.has(item.mediaId) && !audioRecollections.has(item.id));
  for (const anchor of state.anchors) anchor.sourceIds = anchor.sourceIds.filter(id => !ids.has(id));
  for (const event of state.events) {
    if (!event.sourceIds.some(id => ids.has(id))) continue;
    event.sourceIds = event.sourceIds.filter(id => !ids.has(id));
    for (const id of ids) delete event.relations?.[id];
    event.version += 1;
  }
  if (ids.size || recollectionIds.size) appendChange(state, discard ? 'Discarded a capture' : 'Revoked capture evidence', null);
  const outputs = state.jobs.filter(job => job.status === 'stale' &&
    (job.manifest.media.some(item => ids.has(item.id)) || ids.has(job.manifest.narration?.id)));
  return { files, outputs, worlds };
}

export function previewFilm(state, { eventId, expectedRevision }, actor) {
  revision(state, expectedRevision);
  const lens = state.session.lens;
  const manifest = eventDependencies(state, eventId, lens);
  check(manifest?.media.length, 400, 'FILM_NEEDS_MEDIA', 'Link at least one photo or clip before rendering a film.');
  const inputHash = digest(manifest);
  return savePreview(state, {
    kind: 'film', actor, expectedRevision, eventId, lens, inputHash,
    diff: { label: 'Render a 1080p MP4', sources: Math.min(8, manifest.media.length), containsImagined: manifest.media.some(item => item.provenance === 'imagined'),
      narration: Boolean(manifest.narration), cost: 'Local render' }
  });
}

export function queueFilm(state, input, actor) {
  check(text(input.requestId, 128) && text(input.previewToken, 128), 400, 'INVALID_REQUEST', 'Confirm a current film preview.');
  const key = 'film:' + input.requestId;
  const prior = replay(state, key, input);
  if (prior) return prior;
  const preview = resolvePreview(state, input.previewToken, actor, 'film');
  revision(state, preview.expectedRevision);
  check(preview.lens === state.session.lens, 409, 'LENS_CHANGED', 'The source filter changed. Preview the film again.');
  const manifest = eventDependencies(state, preview.eventId, preview.lens);
  check(preview.inputHash === digest(manifest), 409, 'INPUT_CHANGED', 'The film sources changed. Preview the film again.');
  const equivalent = state.jobs.find(item => item.inputHash === preview.inputHash && ['queued', 'running', 'ready'].includes(item.status));
  if (!equivalent) check(state.jobs.filter(item => ['queued', 'running'].includes(item.status)).length < 2, 429, 'RENDER_LIMIT', 'Wait for a film render to finish.');
  const job = equivalent || { id: uid(), eventId: preview.eventId, lens: preview.lens, manifest, inputHash: preview.inputHash,
    revision: state.revision, status: 'queued', approved: false, createdAt: now(), format: 'mp4' };
  if (!equivalent) state.jobs.unshift(job);
  delete state.previews[input.previewToken];
  return record(state, key, input, cleanJob(job));
}

export function createFilmWorker(store, dataDir, demoDir) {
  let promise = null;
  let stopped = false;
  for (const { id, actor, state } of store.all()) {
    if (state.jobs.some(job => job.status === 'running')) store.update(actor, id, 'job.changed', current => {
      for (const job of current.jobs.filter(item => item.status === 'running')) {
        job.status = 'failed';
        job.error = 'The server restarted during this render. Start a new render to retry.';
      }
    });
  }
  async function drain() {
    while (!stopped) {
      const next = store.all().find(project => project.state.jobs.some(job => job.status === 'queued'));
      if (!next) return;
      const { actor, id, state } = next;
      const job = state.jobs.find(item => item.status === 'queued');
      const dir = join(dataDir, 'projects', id);
      store.update(actor, id, 'job.changed', current => { current.jobs.find(item => item.id === job.id).status = 'running'; });
      let result;
      try {
        result = await renderFilm(job.manifest, dir, job.id, demoDir);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(result.output)) hash.update(chunk);
        if (!store.read(actor, id, false)) {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
        const accepted = store.update(actor, id, 'job.changed', current => {
          const target = current.jobs.find(item => item.id === job.id);
          if (target.status !== 'running' || target.inputHash !== digest(eventDependencies(current, target.eventId, target.lens))) {
            target.status = 'stale';
            return false;
          }
          Object.assign(target, result, { status: 'ready', contentHash: hash.digest('hex'), completedAt: now() });
          return true;
        }).data;
        if (!accepted) await Promise.all(Object.values(result).map(file => rm(file, { force: true })));
      } catch {
        if (store.read(actor, id, false)) store.update(actor, id, 'job.changed', current => {
          const target = current.jobs.find(item => item.id === job.id);
          if (target.status === 'running') Object.assign(target, { status: 'failed', error: 'Film rendering failed. Check FFmpeg and try again.' });
        });
      }
    }
  }
  const worker = {
    start() { if (!promise && !stopped) promise = drain().finally(() => { promise = null; }); },
    async stop() { stopped = true; await promise; }
  };
  worker.start();
  return worker;
}

export function gapQuestion(state, eventId) {
  const event = eventById(state, eventId);
  check(event, 404, 'EVENT_NOT_FOUND', 'That memory is unavailable.');
  const samples = event.sourceIds.map(id => mediaById(state, id)).filter(item => lensAllows(item, state.session.lens));
  const previous = state.recollections.filter(item => item.eventId === eventId).length;
  const alternatives = ['What do you remember happening next?', 'What do you remember about the people who were there?',
    'What would you want someone else to know about this moment?', 'What, if anything, would you add about how that day began?'];
  const question = previous === 0 && samples.length > 1 ? 'What do you remember about the time between these two sources?' :
    alternatives[(previous + (samples.length > 1 ? 3 : 0)) % alternatives.length];
  return { eventId, question, sourceIds: samples.slice(0, 2).map(item => item.id) };
}

export function resolveEvent(state, query) {
  check(text(query), 400, 'QUERY_REQUIRED', 'Describe a memory to select it.');
  const normalized = query.trim().toLowerCase();
  const exact = state.events.find(item => item.title.toLowerCase() === normalized || item.id === normalized);
  if (exact) return exact;
  const ranked = rank(state, query).map(item => item.eventId);
  const candidates = state.events.filter(item => ranked.includes(item.id) || item.title.toLowerCase().includes(normalized));
  check(candidates.length === 1, candidates.length ? 409 : 404, 'EVENT_AMBIGUOUS', candidates.length ? 'Several memories match. Choose one.' : 'No matching memory was found.',
    { candidates: candidates.map(({ id, title }) => ({ id, title })) });
  return candidates[0];
}
