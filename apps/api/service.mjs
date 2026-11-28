import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendChange, applyCommand, digest, eventById, eventDependencies, filmDependencies, invalidateJobs,
  lensAllows, mediaById, now, rank, requireCondition as check, uid, validateCommand, validateObservation, views
} from '../../packages/runtime/memory.mjs';
import { renderFilm } from '../../packages/media/local.mjs';
import { renderSceneFilm } from '../../packages/media/scene-film.mjs';

const twoHours = 2 * 3600_000;
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const revision = (state, expected) => check(state.revision === expected, 409, 'REVISION_CONFLICT',
  'This memory has changed. Review the latest version and try again.', { revision: state.revision });
const bodyMatches = (value, saved) => digest(value) === saved.hash;

function replay(state, key, payload) {
  const saved = state.requests[key];
  if (!saved) return null;
  check(bodyMatches(payload, saved), 409, 'REQUEST_ID_REUSED', 'This request ID was already used for different content.');
  check(!saved.unavailable, 409, 'EVIDENCE_REVOKED', 'This request used evidence that has been revoked.');
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

export function cleanJob(job) {
  const { manifest, output, captions, storyboard, ...details } = job;
  return { ...details, ...(['queued', 'running', 'ready'].includes(job.status) && manifest?.storyboard && { storyboard: manifest.storyboard }) };
}

export function walkableWorlds(state) {
  const event = eventById(state, state.session.eventId);
  return state.session.lens === 'all' && event ? (state.worlds ?? []).filter(world =>
    world.eventId === event.id && (world.format === 'glb' || (world.format === 'tour' && world.tour?.liveStreetView === true)) && world.status === 'ready' && world.approved && !world.revoked &&
    world.sourceIds.length > 0 && world.sourceIds.every(id => {
      const source = mediaById(state, id);
      return source && !source.pending && source.mime?.startsWith('image/') && event.sourceIds.includes(id);
    })) : [];
}

export function defaultWalkableWorld(state) {
  const available = walkableWorlds(state);
  // Older GLB clients did not register a viewer. Never infer an open Street View
  // client, and never fall back after a registered viewer explicitly closes.
  return state.session.activeWorldId === undefined
    ? available.filter(world => world.format === 'glb').at(-1)
    : available.find(world => world.id === state.session.activeWorldId);
}

export function movementSession(state) {
  const session = { ...state.session };
  const available = new Set(walkableWorlds(state).map(world => world.id));
  if (session.movement && !available.has(session.movement.worldId)) delete session.movement;
  if (session.movementReceipt && !available.has(session.movementReceipt.worldId)) delete session.movementReceipt;
  if (session.activeWorldId && !available.has(session.activeWorldId)) {
    session.activeWorldId = null;
    delete session.activeViewerId;
  }
  if (session.streetViewPlace && !available.has(session.streetViewPlace.worldId)) delete session.streetViewPlace;
  if (session.streetViewNavigation && (!available.has(session.streetViewNavigation.worldId) ||
    session.streetViewNavigation.worldId !== session.activeWorldId || session.streetViewNavigation.viewerId !== session.activeViewerId ||
    Date.parse(session.streetViewNavigation.expiresAt) <= Date.now())) delete session.streetViewNavigation;
  return session;
}

function authoredTourNodes(world) {
  // Older imports retained only compact node IDs/titles. Read the approved
  // authored manifest locally; never fetch or retain Google's panorama graph.
  let authored = world.tour.nodes;
  if (world.storage) {
    try {
      const document = JSON.parse(readFileSync(world.storage, 'utf8'));
      if (Array.isArray(document.nodes)) authored = document.nodes;
    } catch { /* The compact reviewed stops remain available if storage fails. */ }
  }
  return authored;
}

export function resolveAnchorDescription(state, query) {
  check(text(query, 2000), 400, 'QUERY_REQUIRED', 'Describe a reviewed route stop.');
  const ignored = new Set('the and with this that from into please take show photo picture image memory place spot mont tremblant quebec canada want would could there here'.split(' '));
  const aliases = { door: 'entrance', doorway: 'entrance', entry: 'entrance', interior: 'inside', indoors: 'inside', exterior: 'outside', outdoors: 'outside' };
  const words = value => [...new Set((value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .filter(word => !ignored.has(word)).map(word => aliases[word] ?? word))];
  const requested = words(query);
  const candidates = walkableWorlds(state).filter(world => world.tour?.liveStreetView === true).flatMap(world => {
    const authored = authoredTourNodes(world);
    return world.tour.nodes.flatMap(node => {
      const anchor = state.anchors.find(anchor => anchor.eventId === state.session.eventId && anchor.worldId === world.id && anchor.nodeId === node.id);
      if (!anchor) return [];
      const detail = authored.find(item => item.id === node.id);
      const titleWords = words(node.title), descriptionWords = words(detail?.description ?? '');
      const matchedWords = requested.filter(word => titleWords.includes(word) || descriptionWords.includes(word));
      return [{ anchorId: anchor.id, nodeId: node.id, title: node.title, matchedWords,
        matchedFields: ['title', 'description'].filter(field => requested.some(word => (field === 'title' ? titleWords : descriptionWords).includes(word))),
        titleWords }];
    });
  });
  const matches = candidates.filter(candidate => candidate.matchedWords.length);
  const publicMatch = ({ titleWords, ...candidate }) => candidate;
  check(matches.length > 0, 404, 'ANCHOR_NO_MATCH', 'No reviewed route stop matches that supplied description. Name a stop or describe a distinctive feature.',
    { method: 'supplied_description', candidates: candidates.map(({ anchorId, nodeId, title }) => ({ anchorId, nodeId, title })) });
  const distinctive = matches.filter(candidate => candidate.matchedWords.some(word => matches.filter(other => other.matchedWords.includes(word)).length === 1) ||
    (candidate.titleWords.length > 1 && candidate.titleWords.every(word => requested.includes(word))));
  check(distinctive.length === 1, 409, 'ANCHOR_AMBIGUOUS', 'That description matches more than one reviewed stop. Choose the intended destination.',
    { method: 'supplied_description', candidates: matches.map(publicMatch) });
  return { method: 'supplied_description', ...publicMatch(distinctive[0]) };
}

export function navigateAnchor(state, input) {
  check(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => ['anchorId', 'query'].includes(key)) &&
    ((input.anchorId !== undefined) !== (input.query !== undefined)) && (input.anchorId === undefined || text(input.anchorId, 128)),
    400, 'INVALID_NAVIGATION', 'Supply one reviewed anchor ID or one place description.');
  const resolution = input.query !== undefined ? resolveAnchorDescription(state, input.query) : null;
  const session = updateSession(state, { anchorId: resolution?.anchorId ?? input.anchorId, view: 'explore' });
  return resolution ? { ...session, resolution, arrival: 'unconfirmed', message: 'Selected a reviewed stop from your supplied description. The browser must load it before arrival is confirmed.' } : session;
}

export function navigationGuide(state) {
  const world = defaultWalkableWorld(state);
  if (world?.tour?.liveStreetView !== true) return null;
  const authored = authoredTourNodes(world);
  return {
    mode: 'linked_streetview_panoramas', worldId: world.id, title: world.title,
    instructions: 'This is a navigable Street View route, not a fixed photograph. A move follows one available panorama link; a turn changes heading. The 90-degree limit applies to EACH turn, not the whole visit. Repeat separate move_player calls, wait for each browser receipt, and refresh get_context between steps. For a broad walk-around request, take a short sequence of available steps and reassess. Use navigate_anchor for a named reviewed stop or interior; do not invent unavailable coverage.',
    current: movementSession(state).streetViewNavigation ?? null,
    stops: world.tour.nodes.map(node => {
      const detail = authored.find(item => item.id === node.id);
      return { nodeId: node.id, title: node.title,
        ...(detail?.description && { description: detail.description }),
        ...(Array.isArray(detail?.links) && { authoredConnections: detail.links.map(({ to, label, kind }) => ({ to, label, ...(kind && { kind }) })) }),
        anchorId: state.anchors.find(anchor => anchor.worldId === world.id && anchor.nodeId === node.id)?.id ?? null };
    })
  };
}

export function queueMovement(state, input, clock = Date.now()) {
  const available = walkableWorlds(state);
  const worldId = input.worldId === undefined ? defaultWalkableWorld(state)?.id : input.worldId;
  check(available.some(world => world.id === worldId), 404, 'WORLD_UNAVAILABLE', 'Open an approved walkable scene in the active memory with all sources visible.');
  const world = available.find(world => world.id === worldId);
  check((state.session.activeWorldId === undefined && world.format === 'glb') ||
    (state.session.activeWorldId === worldId && text(state.session.activeViewerId, 128)),
  409, 'VIEWER_NOT_ACTIVE', 'Open this scene before asking VoiceOS to move.');
  const directions = ['forward', 'backward', 'left', 'right', 'turn_left', 'turn_right', 'stop'];
  const durationSeconds = input.durationSeconds ?? 2;
  const degrees = input.degrees ?? 30;
  check(directions.includes(input.direction) && Number.isFinite(durationSeconds) && durationSeconds >= 0.1 && durationSeconds <= 5 &&
    Number.isFinite(degrees) && degrees >= 1 && degrees <= 90, 400, 'INVALID_MOVEMENT', 'Choose a supported movement lasting at most 5 seconds or a turn of at most 90 degrees.');
  const command = { id: uid(), worldId, ...(state.session.activeViewerId && { viewerId: state.session.activeViewerId }), direction: input.direction, durationSeconds, degrees,
    issuedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 10_000).toISOString() };
  state.session.movement = command;
  delete state.session.movementReceipt;
  return { status: 'queued', command };
}

export function acknowledgeMovement(state, worldId, input, clock = Date.now()) {
  const world = walkableWorlds(state).find(world => world.id === worldId);
  check(world, 404, 'WORLD_UNAVAILABLE', 'This walkable scene is unavailable.');
  check(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['commandId', 'status', 'position', 'reason', 'viewerId', 'nodeId', 'heading'].includes(key)) &&
    text(input.commandId, 128) && ['completed', 'blocked', 'stopped', 'ignored'].includes(input.status) &&
    (input.position === undefined || (Array.isArray(input.position) && input.position.length === 3 && input.position.every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000))) &&
    (input.reason === undefined || text(input.reason, 240)), 400, 'INVALID_MOVEMENT_RECEIPT', 'Supply a valid browser movement result.');
  if (world.format === 'tour') {
    check(input.position === undefined && (input.nodeId === undefined || world.tour.nodes.some(node => node.id === input.nodeId)) &&
      (input.heading === undefined || (Number.isFinite(input.heading) && input.heading >= 0 && input.heading <= 360)) &&
      (input.status !== 'completed' || (input.nodeId !== undefined && input.heading !== undefined)),
    400, 'INVALID_MOVEMENT_RECEIPT', 'Street View results use an authored node ID and heading, not 3D coordinates.');
  } else check(input.nodeId === undefined && input.heading === undefined, 400, 'INVALID_MOVEMENT_RECEIPT', 'Use 3D coordinates for a mesh movement result.');
  const command = state.session.movement;
  check(command?.id === input.commandId && command.worldId === worldId, 409, 'MOVEMENT_SUPERSEDED', 'This movement is no longer the current command.');
  check(command.viewerId === undefined ? input.viewerId === undefined :
    input.viewerId === command.viewerId && state.session.activeViewerId === command.viewerId && state.session.activeWorldId === worldId,
  409, 'VIEWER_NOT_ACTIVE', 'This viewer no longer owns movement for the scene.');
  const prior = state.session.movementReceipt;
  const receipt = { commandId: command.id, worldId, status: input.status,
    ...(input.position && { position: input.position }), ...(input.reason && { reason: input.reason }),
    ...(input.viewerId !== undefined && { viewerId: input.viewerId }), ...(input.nodeId !== undefined && { nodeId: input.nodeId }),
    ...(input.heading !== undefined && { heading: input.heading }) };
  if (prior?.commandId === command.id) {
    const { receivedAt, ...saved } = prior;
    check(digest(saved) === digest(receipt), 409, 'MOVEMENT_ALREADY_REPORTED', 'This movement already has a browser result.');
    return prior;
  }
  // A command can start just before expiry and finish its bounded five-second movement.
  check(clock <= Date.parse(command.expiresAt) + 5_000, 409, 'MOVEMENT_EXPIRED', 'This movement result arrived too late.');
  state.session.movementReceipt = { ...receipt, receivedAt: new Date(clock).toISOString() };
  if (world.format === 'tour' && input.status === 'completed') state.session.streetViewPlace = { worldId, nodeId: input.nodeId, heading: input.heading };
  return state.session.movementReceipt;
}

export function queueCameraAction(state, input, clock = Date.now()) {
  check(['open', 'capture', 'close'].includes(input.action), 400, 'INVALID_CAMERA_ACTION', 'Choose open, capture or close.');
  check(text(state.session.cameraViewerId, 128), 409, 'CAMERA_VIEWER_REQUIRED', 'Open Everwhere in a visible browser tab first.');
  check(input.action !== 'capture' || state.session.cameraReady === true,
    409, 'CAMERA_NOT_READY', 'Open the camera and review its live preview before capturing a photo.');
  const command = { id: uid(), action: input.action, viewerId: state.session.cameraViewerId,
    eventId: state.session.eventId ?? null, issuedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 30_000).toISOString() };
  state.session.cameraAction = command;
  delete state.session.cameraReceipt;
  return { status: 'queued', command };
}

export function acknowledgeCameraAction(state, input, clock = Date.now()) {
  check(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['requestId', 'viewerId', 'status', 'observationId', 'reason'].includes(key)) &&
    text(input.requestId, 128) && text(input.viewerId, 128) && ['opened', 'captured', 'closed', 'blocked', 'ignored'].includes(input.status) &&
    (input.reason === undefined || text(input.reason, 240)), 400, 'INVALID_CAMERA_RECEIPT', 'Supply a valid camera action result.');
  const command = state.session.cameraAction;
  check(command?.id === input.requestId, 409, 'CAMERA_SUPERSEDED', 'This camera request is no longer current.');
  check(command.viewerId === input.viewerId && state.session.cameraViewerId === input.viewerId,
    409, 'VIEWER_NOT_ACTIVE', 'This tab no longer owns the camera request.');
  check(['blocked', 'ignored'].includes(input.status) || input.status === { open: 'opened', capture: 'captured', close: 'closed' }[command.action],
    400, 'INVALID_CAMERA_RECEIPT', 'The result does not match the requested camera action.');
  check(clock <= Date.parse(command.expiresAt) + 5_000, 409, 'CAMERA_EXPIRED', 'This camera request expired.');
  if (input.status === 'captured') {
    const observation = state.capture.observations.find(item => item.id === input.observationId && item.externalId === command.id && item.status === 'pending');
    const media = observation && mediaById(state, observation.mediaId);
    check(media?.pending && media.mime?.startsWith('image/'), 400, 'CAMERA_CAPTURE_REQUIRED', 'Upload this camera frame for review before reporting it captured.');
  } else check(input.observationId === undefined, 400, 'INVALID_CAMERA_RECEIPT', 'Only captured results identify a pending photo.');
  const receipt = { requestId: command.id, viewerId: input.viewerId, status: input.status,
    ...(input.observationId !== undefined && { observationId: input.observationId }), ...(input.reason !== undefined && { reason: input.reason }) };
  if (state.session.cameraReceipt?.requestId === command.id) {
    const { receivedAt, ...prior } = state.session.cameraReceipt;
    check(digest(prior) === digest(receipt), 409, 'CAMERA_ALREADY_REPORTED', 'This camera request already has a browser result.');
    return state.session.cameraReceipt;
  }
  if (input.status === 'opened') state.session.cameraReady = true;
  if (input.status === 'closed' || (command.action === 'open' && input.status === 'blocked')) state.session.cameraReady = false;
  state.session.cameraReceipt = { ...receipt, receivedAt: new Date(clock).toISOString() };
  return state.session.cameraReceipt;
}

export function getSnapshot(projectId, state) {
  return {
    projectId, title: state.title, demo: state.demo, revision: state.revision, seq: state.seq,
    visualProfile: state.visualProfile, session: movementSession(state), events: state.events, anchors: state.anchors,
    media: state.media.filter(item => !item.revoked && !item.pending).map(cleanMedia),
    recollections: state.recollections.map(({ actor, ...item }) => ({ ...item, contributor: 'You' })),
    jobs: state.jobs.map(cleanJob), history: state.history,
    storyboards: Object.fromEntries(state.events.map(event => [event.id, eventDependencies(state, event.id, state.session.lens).storyboard])),
    worlds: (state.worlds || []).filter(item => !item.revoked).map(({ storage, contentHash, plan, evidenceHash, tour, ...item }) => ({ ...item,
      ...(tour && { tour: { startNodeId: tour.startNodeId, ...(tour.liveStreetView === true && { liveStreetView: true }), nodes: tour.nodes.map(({ id, title, sourceIds }) => ({ id, title, ...(sourceIds && { sourceIds }) })) } }) })),
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
  delete state.session.movement;
  delete state.session.movementReceipt;
  appendChange(state, 'Created ' + event.title, event.id);
  return event;
}

export function updateSession(state, input) {
  // A delayed close from an older tab must not unregister the newer owner.
  if (input.activeWorldId === null && input.viewerId !== state.session.activeViewerId) return state.session;
  if (input.cameraViewerId === null && input.viewerId !== state.session.cameraViewerId) return state.session;
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
    const event = anchor && eventById(state, anchor.eventId);
    check(anchor && event && anchor.sourceIds.every(id => {
      const source = mediaById(state, id);
      return source && !source.pending && event.sourceIds.includes(id) && lensAllows(source, state.session.lens);
    }), 404, 'ANCHOR_NOT_FOUND', 'That waypoint is unavailable.');
    if (anchor.worldId !== 'trail-' + event.id) {
      const world = state.worlds?.find(item => item.id === anchor.worldId && item.eventId === event.id);
      check(world?.approved && !world.revoked && (!world.status || world.status === 'ready') && state.session.lens === 'all' &&
        world.sourceIds.length > 0 && world.sourceIds.every(id => {
          const source = mediaById(state, id);
          return source && !source.pending && event.sourceIds.includes(id);
        }),
      404, 'ANCHOR_NOT_FOUND', 'That waypoint is unavailable.');
      if (world.format === 'tour') check(world.tour?.nodes.some(node => node.id === anchor.nodeId),
        404, 'ANCHOR_NOT_FOUND', 'That walkthrough viewpoint is unavailable.');
    } else check(anchor.sourceIds.length > 0, 404, 'ANCHOR_NOT_FOUND', 'That waypoint is unavailable.');
    Object.assign(state.session, { anchorId, eventId: anchor.eventId });
  }
  const activeAnchor = state.anchors.find(item => item.id === state.session.anchorId);
  const activeWorld = state.worlds?.find(item => item.id === activeAnchor?.worldId);
  if (activeWorld?.format === 'tour' && (!activeWorld.approved || activeWorld.revoked || activeWorld.status !== 'ready' || state.session.lens !== 'all')) {
    state.session.anchorId = null;
  }
  const available = new Set(walkableWorlds(state).map(world => world.id));
  if (state.session.activeWorldId && (!available.has(state.session.activeWorldId) ||
    (anchorId !== undefined && activeAnchor?.worldId !== state.session.activeWorldId))) {
    state.session.activeWorldId = null;
    delete state.session.activeViewerId;
    delete state.session.movement;
    delete state.session.movementReceipt;
    delete state.session.streetViewNavigation;
  }
  if (input.activeWorldId !== undefined) {
    check(text(input.viewerId, 128) && /^[A-Za-z0-9_-]+$/.test(input.viewerId),
      400, 'INVALID_VIEWER', 'Use a valid per-viewer identifier.');
    check(input.activeWorldId === null || available.has(input.activeWorldId),
      404, 'WORLD_UNAVAILABLE', 'Open an approved scene in the active memory with all sources visible.');
    if (state.session.activeWorldId !== input.activeWorldId || state.session.activeViewerId !== input.viewerId) {
      delete state.session.movement;
      delete state.session.movementReceipt;
      delete state.session.streetViewNavigation;
    }
    state.session.activeWorldId = input.activeWorldId;
    if (input.activeWorldId === null) delete state.session.activeViewerId;
    else state.session.activeViewerId = input.viewerId;
  }
  if (input.streetViewPlace !== undefined) {
    const place = input.streetViewPlace;
    check(place && typeof place === 'object' && !Array.isArray(place) &&
      Object.keys(place).every(key => ['worldId', 'nodeId', 'heading'].includes(key)),
    400, 'INVALID_STREET_VIEW_PLACE', 'Save an authored route stop and heading.');
    const world = walkableWorlds(state).find(world => world.id === place.worldId && world.tour?.liveStreetView === true);
    check(world, 404, 'WORLD_UNAVAILABLE', 'This Street View route is unavailable.');
    check(state.session.activeWorldId === place.worldId && text(input.viewerId, 128) && input.viewerId === state.session.activeViewerId,
      409, 'VIEWER_NOT_ACTIVE', 'This viewer no longer owns the active scene.');
    check(world.tour.nodes.some(node => node.id === place.nodeId) && Number.isFinite(place.heading) && place.heading >= 0 && place.heading <= 360,
      400, 'INVALID_STREET_VIEW_PLACE', 'Save a valid authored route stop and a heading from 0 to 360 degrees.');
    state.session.streetViewPlace = { worldId: place.worldId, nodeId: place.nodeId, heading: place.heading };
  }
  if (input.cameraViewerId !== undefined) {
    check(input.cameraViewerId === null || (text(input.cameraViewerId, 128) && /^[A-Za-z0-9_-]+$/.test(input.cameraViewerId)),
      400, 'INVALID_VIEWER', 'Use a valid camera viewer identifier.');
    if (state.session.cameraViewerId !== input.cameraViewerId) {
      state.session.cameraReady = false;
      delete state.session.cameraAction;
      delete state.session.cameraReceipt;
    }
    state.session.cameraViewerId = input.cameraViewerId;
  }
  if (input.streetViewNavigation !== undefined) {
    const context = input.streetViewNavigation;
    check(context && typeof context === 'object' && !Array.isArray(context) &&
      Object.keys(context).every(key => ['worldId', 'nodeId', 'heading', 'availableDirections'].includes(key)),
      400, 'INVALID_NAVIGATION_CONTEXT', 'Report only the authored stop, heading and available movement directions.');
    const world = walkableWorlds(state).find(world => world.id === context.worldId && world.tour?.liveStreetView === true);
    check(world, 404, 'WORLD_UNAVAILABLE', 'This Street View route is unavailable.');
    check(state.session.activeWorldId === context.worldId && text(input.viewerId, 128) && input.viewerId === state.session.activeViewerId,
      409, 'VIEWER_NOT_ACTIVE', 'Only the active viewer can report available routes.');
    check(world.tour.nodes.some(node => node.id === context.nodeId) && Number.isFinite(context.heading) && context.heading >= 0 && context.heading <= 360 &&
      Array.isArray(context.availableDirections) && context.availableDirections.length <= 4 &&
      new Set(context.availableDirections).size === context.availableDirections.length &&
      context.availableDirections.every(direction => ['forward', 'backward', 'left', 'right'].includes(direction)),
      400, 'INVALID_NAVIGATION_CONTEXT', 'Use a valid authored stop, heading and distinct supported directions.');
    const clock = Date.now();
    state.session.streetViewNavigation = { worldId: context.worldId, nodeId: context.nodeId, heading: context.heading,
      availableDirections: [...context.availableDirections], viewerId: input.viewerId,
      updatedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 30_000).toISOString() };
  }
  if (state.session.movement && !available.has(state.session.movement.worldId)) delete state.session.movement;
  if (state.session.movementReceipt && !available.has(state.session.movementReceipt.worldId)) delete state.session.movementReceipt;
  return state.session;
}

export function savePreview(state, entry) {
  for (const [key, prior] of Object.entries(state.previews)) {
    if (prior.expires <= Date.now()) delete state.previews[key];
  }
  check(Object.keys(state.previews).length < 100, 429, 'TOO_MANY_PREVIEWS', 'Finish or wait for an existing preview.');
  const token = uid();
  const expires = Date.now() + (entry.kind === 'scene-film' ? 15 : 5) * 60_000;
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

export function resolvePreview(state, token, actor, kind) {
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
    check(!existing.unavailable, 409, 'EVIDENCE_REVOKED', 'This request used evidence that has been revoked.');
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
    // Keep provenance after undo removes the inverse from the undo stack.
    if (proposed.type === 'recollection.add') obs.recollectionId = state.changes[0].id;
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
  for (const item of files) Object.assign(item, { revoked: true, caption: 'Withdrawn source' });
  const observationRevisions = new Set(affected.map(item => item.reviewRevision).filter(Boolean));
  const recollectionIds = new Set([
    ...affected.map(item => item.recollectionId).filter(Boolean),
    ...state.changes.filter(item => item.type === 'recollection.add' && observationRevisions.has(item.revision)).map(item => item.id)
  ]);
  const audioRecollections = new Set(state.recollections.filter(item => ids.has(item.audioMediaId)).map(item => item.id));
  for (const change of state.changes) {
    if (audioRecollections.has(change.id) || ids.has(change.mediaId)) observationRevisions.add(change.revision);
  }
  for (const entry of state.history) if (observationRevisions.has(entry.revision)) entry.label = 'Removed capture evidence';
  const withdrawnRecollections = new Set([...recollectionIds, ...audioRecollections]);
  const worlds = (state.worlds || []).filter(world => !world.revoked && (world.sourceIds.some(id => ids.has(id)) ||
    world.evidenceRefs?.mediaIds.some(id => ids.has(id)) || world.evidenceRefs?.recollectionIds.some(id => withdrawnRecollections.has(id))));
  for (const world of worlds) {
    Object.assign(world, { revoked: true, approved: false });
    delete world.plan;
  }
  if (worlds.some(world => world.id === state.session.movement?.worldId)) delete state.session.movement;
  if (worlds.some(world => world.id === state.session.movementReceipt?.worldId)) delete state.session.movementReceipt;
  if (worlds.some(world => world.id === state.session.activeWorldId)) {
    state.session.activeWorldId = null;
    delete state.session.activeViewerId;
  }
  if (worlds.some(world => world.id === state.session.streetViewPlace?.worldId)) delete state.session.streetViewPlace;
  if (worlds.some(world => world.id === state.session.streetViewNavigation?.worldId)) delete state.session.streetViewNavigation;
  // Stale and failed jobs can still retain evidence and completed output files.
  // Return only their deletion handles before removing persisted private copies.
  const outputs = [];
  for (const job of state.jobs) {
    const manifest = job.manifest;
    if (!manifest || !(manifest.media.some(item => ids.has(item.id)) || worlds.some(world => world.id === manifest.world?.id) || ids.has(manifest.narration?.id) ||
      manifest.recollections.some(item => withdrawnRecollections.has(item.id) || ids.has(item.audioMediaId)))) continue;
    outputs.push({ id: job.id, output: job.output, captions: job.captions,
      ...(job.manifest?.sceneRecording?.storage && { recording: job.manifest.sceneRecording.storage }) });
    Object.assign(job, { status: 'stale', approved: false });
    delete job.manifest;
    delete job.output;
    delete job.captions;
    delete job.contentHash;
    delete job.recording;
  }
  const revokedArtifacts = new Set([...worlds, ...outputs].map(item => item.id));
  for (const request of Object.values(state.requests)) {
    if (observationRevisions.has(request.result?.revision) || revokedArtifacts.has(request.result?.artifactId) ||
      revokedArtifacts.has(request.result?.id)) {
      request.result = { revision: request.result.revision, revoked: true };
      request.unavailable = true;
    }
  }
  const observationIds = new Set(affected.map(item => item.id));
  for (const [token, preview] of Object.entries(state.previews)) {
    const payload = preview.proposed?.payload;
    if (observationIds.has(preview.observation) || ids.has(payload?.audioMediaId) || ids.has(payload?.mediaId) ||
      payload?.sourceIds?.some(id => ids.has(id))) delete state.previews[token];
  }
  state.recollections = state.recollections.filter(item => !withdrawnRecollections.has(item.id));
  state.changes = state.changes.filter(item => !observationRevisions.has(item.revision) && !ids.has(item.mediaId) && !audioRecollections.has(item.id));
  const removedAnchors = new Set();
  for (const anchor of state.anchors) {
    const hadSources = anchor.sourceIds.length > 0;
    anchor.sourceIds = anchor.sourceIds.filter(id => !ids.has(id));
    const world = state.worlds?.find(item => item.id === anchor.worldId && item.eventId === anchor.eventId && !item.revoked);
    if (revokedArtifacts.has(anchor.worldId) || (anchor.sourceIds.length === 0 && (hadSources || !world))) removedAnchors.add(anchor.id);
  }
  state.anchors = state.anchors.filter(anchor => !removedAnchors.has(anchor.id));
  if (removedAnchors.has(state.session.anchorId)) state.session.anchorId = null;
  for (const recollection of state.recollections) if (removedAnchors.has(recollection.anchorId)) delete recollection.anchorId;
  for (const event of state.events) {
    if (!event.sourceIds.some(id => ids.has(id))) continue;
    event.sourceIds = event.sourceIds.filter(id => !ids.has(id));
    for (const id of ids) delete event.relations?.[id];
    event.version += 1;
  }
  if (ids.size || recollectionIds.size) appendChange(state, discard ? 'Discarded a capture' : 'Revoked capture evidence', null);
  return { files, outputs, worlds };
}

export function previewFilm(state, { eventId, expectedRevision }, actor) {
  revision(state, expectedRevision);
  const lens = state.session.lens;
  const manifest = eventDependencies(state, eventId, lens);
  check(manifest?.storyboard.frames.length, 400, 'FILM_NEEDS_MEDIA', 'Link at least one photo or clip before rendering a film.');
  const inputHash = digest(manifest);
  return savePreview(state, {
    kind: 'film', actor, expectedRevision, eventId, lens, inputHash,
    diff: { label: 'Render a 1080p memory film', sources: manifest.storyboard.frames.length,
      storyboard: manifest.storyboard, containsImagined: manifest.storyboard.frames.some(item => item.provenance === 'imagined'),
      narration: Boolean(manifest.narration), cost: 'Local render' }
  });
}

export function queueFilm(state, input, actor) {
  check(text(input.requestId, 128) && text(input.previewToken, 128), 400, 'INVALID_REQUEST', 'Confirm a current film preview.');
  const key = 'film:' + input.requestId;
  const prior = replay(state, key, input);
  if (prior) {
    const job = state.jobs.find(item => item.id === prior.id);
    check(job, 409, 'FILM_UNAVAILABLE', 'This film is unavailable. Review a new storyboard.');
    return cleanJob(job);
  }
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
  record(state, key, input, { id: job.id });
  return cleanJob(job);
}

export function createFilmWorker(store, dataDir, demoDir) {
  let promise = null;
  let stopped = false;
  const startupFiles = new Set();
  const projects = store.all();
  const queuedInputs = new Set(projects.flatMap(project => project.state.jobs
    .filter(job => job.status === 'queued' && job.manifest?.storyboard).map(job => job.manifest?.sceneRecording?.storage).filter(Boolean)));
  const projectsDir = join(dataDir, 'projects');
  let directories = [];
  try { directories = readdirSync(projectsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Snapshot names before accepting uploads; a later upload must not be swept as an orphan.
  for (const directory of directories) {
    const dir = join(projectsDir, directory.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && /\.scene\.(mp4|webm)$/.test(entry.name) && !queuedInputs.has(path)) startupFiles.add(path);
    }
  }
  for (const { id, actor, state } of projects) {
    for (const job of state.jobs.filter(item => ['running', 'failed'].includes(item.status) || (item.status === 'stale' && !item.output))) {
      for (const path of [job.output, job.captions, ...['.mp4', '.vtt', '-work', '-scene-work'].map(suffix => join(projectsDir, id, job.id + suffix))]) {
        if (path) startupFiles.add(path);
      }
    }
    if (state.jobs.some(job => job.status === 'running' || (['queued', 'ready'].includes(job.status) && !job.manifest?.storyboard))) store.update(actor, id, 'job.changed', current => {
      for (const job of current.jobs.filter(item => item.status === 'running')) {
        job.status = 'failed';
        job.approved = false;
        job.error = 'The server restarted during this render. Start a new render to retry.';
        delete job.output;
        delete job.captions;
        delete job.contentHash;
        if (job.manifest?.sceneRecording?.storage) {
          startupFiles.add(job.manifest.sceneRecording.storage);
          delete job.manifest.sceneRecording.storage;
        }
      }
      for (const job of current.jobs.filter(item => ['queued', 'ready'].includes(item.status) && !item.manifest?.storyboard)) {
        Object.assign(job, { status: 'stale', approved: false, error: 'Review the current storyboard and render a new film.' });
      }
    });
  }
  async function drain() {
    await Promise.all([...startupFiles].map(file => rm(file, { recursive: true, force: true })));
    startupFiles.clear();
    while (!stopped) {
      for (const project of store.all()) {
        const stale = project.state.jobs.filter(job => !['queued', 'running'].includes(job.status) && job.manifest?.sceneRecording?.storage);
        if (stale.length) {
          await Promise.all(stale.map(job => rm(job.manifest.sceneRecording.storage, { force: true })));
          if (store.read(project.actor, project.id, false)) store.update(project.actor, project.id, null, current => {
            for (const job of current.jobs) if (stale.some(item => item.id === job.id) && job.manifest?.sceneRecording) delete job.manifest.sceneRecording.storage;
          });
        }
      }
      const next = store.all().find(project => project.state.jobs.some(job => job.status === 'queued'));
      if (!next) return;
      const { actor, id, state } = next;
      const job = state.jobs.find(item => item.status === 'queued');
      const dir = join(dataDir, 'projects', id);
      store.update(actor, id, 'job.changed', current => { current.jobs.find(item => item.id === job.id).status = 'running'; });
      let result;
      try {
        result = job.kind === 'scene_recording' ? await renderSceneFilm(job.manifest, dir, job.id) : await renderFilm(job.manifest, dir, job.id, demoDir);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(result.output)) hash.update(chunk);
        if (!store.read(actor, id, false)) {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
        const accepted = store.update(actor, id, 'job.changed', current => {
          const target = current.jobs.find(item => item.id === job.id);
          if (target.status !== 'running' || target.inputHash !== digest(filmDependencies(current, target.eventId, target.lens, target.manifest?.sceneRecording))) {
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
      } finally {
        if (job.manifest?.sceneRecording?.storage) {
          await rm(job.manifest.sceneRecording.storage, { force: true });
          if (store.read(actor, id, false)) store.update(actor, id, null, current => {
            const target = current.jobs.find(item => item.id === job.id);
            if (target?.manifest?.sceneRecording) delete target.manifest.sceneRecording.storage;
          });
        }
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
