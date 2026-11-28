import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../apps/api/store.mjs';
import { createApp } from '../apps/api/server.mjs';
import { acknowledgeCameraAction, acknowledgeMovement, defaultWalkableWorld, movementSession, navigateAnchor, navigationGuide, queueCameraAction, queueMovement, resolveAnchorDescription, updateSession, walkableWorlds } from '../apps/api/service.mjs';

function sceneState() {
  return { session: { eventId: 'event', lens: 'all', view: 'explore', anchorId: null },
    events: [{ id: 'event', title: 'Imagined winter', sourceIds: ['photo'] }, { id: 'other', sourceIds: [] }],
    media: [{ id: 'photo', mime: 'image/jpeg', provenance: 'imagined', hash: 'photo-hash' }], anchors: [],
    worlds: [{ id: 'world', title: 'Winter walking set', eventId: 'event', format: 'glb', status: 'ready', approved: true, sourceIds: ['photo'] }] };
}
const errorCode = (fn, code) => assert.throws(fn, error => error.code === code);

test('camera actions need a registered tab, a live-preview receipt and a real pending photo', () => {
  const state = sceneState(); state.capture = { observations: [] };
  errorCode(() => queueCameraAction(state, { action: 'open' }), 'CAMERA_VIEWER_REQUIRED');
  updateSession(state, { cameraViewerId: 'camera-tab' });
  errorCode(() => queueCameraAction(state, { action: 'record' }), 'INVALID_CAMERA_ACTION');
  errorCode(() => queueCameraAction(state, { action: 'capture' }), 'CAMERA_NOT_READY');
  const open = queueCameraAction(state, { action: 'open' }, 1_000).command;
  assert.equal(open.viewerId, 'camera-tab');
  errorCode(() => acknowledgeCameraAction(state, { requestId: open.id, viewerId: 'wrong-tab', status: 'opened' }, 2_000), 'VIEWER_NOT_ACTIVE');
  errorCode(() => acknowledgeCameraAction(state, { requestId: open.id, viewerId: 'camera-tab', status: 'captured' }, 2_000), 'INVALID_CAMERA_RECEIPT');
  acknowledgeCameraAction(state, { requestId: open.id, viewerId: 'camera-tab', status: 'opened' }, 2_000);
  const capture = queueCameraAction(state, { action: 'capture' }, 3_000).command;
  const receipt = { requestId: capture.id, viewerId: 'camera-tab', status: 'captured', observationId: 'frame-observation' };
  errorCode(() => acknowledgeCameraAction(state, receipt, 4_000), 'CAMERA_CAPTURE_REQUIRED');
  state.media.push({ id: 'frame', mime: 'image/jpeg', pending: true });
  state.capture.observations.push({ id: 'frame-observation', mediaId: 'frame', externalId: 'wrong-request', status: 'pending' });
  errorCode(() => acknowledgeCameraAction(state, receipt, 4_000), 'CAMERA_CAPTURE_REQUIRED');
  state.capture.observations[0].externalId = capture.id;
  assert.equal(acknowledgeCameraAction(state, receipt, 4_000).status, 'captured');
  assert.equal(state.media.at(-1).pending, true, 'The camera action must not approve its source');
  assert.deepEqual(acknowledgeCameraAction(state, receipt, 5_000), state.session.cameraReceipt);
  const close = queueCameraAction(state, { action: 'close' }, 6_000).command;
  acknowledgeCameraAction(state, { requestId: close.id, viewerId: 'camera-tab', status: 'closed' }, 7_000);
  assert.equal(state.session.cameraReady, false);
  errorCode(() => queueCameraAction(state, { action: 'capture' }), 'CAMERA_NOT_READY');
});

test('camera ownership changes clear old work and expired actions cannot claim success', () => {
  const state = sceneState();
  updateSession(state, { cameraViewerId: 'tab-a' });
  const old = queueCameraAction(state, { action: 'open' }, 1_000).command;
  errorCode(() => acknowledgeCameraAction(state, { requestId: old.id, viewerId: 'tab-a', status: 'opened' }, 36_001), 'CAMERA_EXPIRED');
  updateSession(state, { cameraViewerId: 'tab-b' });
  assert.equal(state.session.cameraAction, undefined);
  assert.equal(state.session.cameraReady, false);
  updateSession(state, { cameraViewerId: null, viewerId: 'tab-a' });
  assert.equal(state.session.cameraViewerId, 'tab-b');
  errorCode(() => acknowledgeCameraAction(state, { requestId: old.id, viewerId: 'tab-a', status: 'opened' }, 2_000), 'CAMERA_SUPERSEDED');
  const fresh = queueCameraAction(state, { action: 'open' }, 2_000).command;
  acknowledgeCameraAction(state, { requestId: fresh.id, viewerId: 'tab-b', status: 'blocked', reason: 'Camera permission denied' }, 3_000);
  assert.equal(state.session.cameraReady, false);
  updateSession(state, { cameraViewerId: null, viewerId: 'tab-b' });
  errorCode(() => queueCameraAction(state, { action: 'open' }), 'CAMERA_VIEWER_REQUIRED');
});

function liveState() {
  const state = sceneState();
  Object.assign(state.worlds[0], { format: 'tour', tour: { liveStreetView: true, startNodeId: 'village', nodes: [
    { id: 'village', title: 'Village' }, { id: 'inside', title: 'Verified interior' }
  ] } });
  state.anchors = [{ id: 'inside-anchor', title: 'Verified interior', eventId: 'event', worldId: 'world', nodeId: 'inside', sourceIds: [] }];
  return state;
}

function descriptionState() {
  const state = liveState();
  state.worlds[0].tour.nodes = [
    { id: 'village', title: 'Village terrace', description: 'Snow on the terrace with the pedestrian village beside you.' },
    { id: 'entrance', title: 'Le Shack entrance', description: 'The restaurant doorway in the village.' },
    { id: 'inside', title: 'Inside Le Shack', description: 'A real restaurant interior in the connected route.' }
  ];
  state.anchors = state.worlds[0].tour.nodes.map(node => ({ id: node.id + '-anchor', nodeId: node.id, title: node.title, eventId: 'event', worldId: 'world', sourceIds: [] }));
  return state;
}

test('supplied descriptions resolve reviewed authored stops with lexical evidence, not image vision', () => {
  const state = descriptionState();
  const result = navigateAnchor(state, { query: 'Please take me to the restaurant doorway in this picture' });
  assert.equal(result.resolution.anchorId, 'entrance-anchor');
  assert.equal(result.resolution.method, 'supplied_description');
  assert.ok(result.resolution.matchedWords.includes('entrance'));
  assert.ok(result.resolution.matchedFields.includes('description'));
  assert.equal(result.arrival, 'unconfirmed');
  assert.equal(state.session.anchorId, 'entrance-anchor');
  assert.equal(resolveAnchorDescription(state, 'inside Le Shack').nodeId, 'inside');
  assert.equal(resolveAnchorDescription(state, 'snow on the terrace').nodeId, 'village');
});

test('ambiguous, generic, unavailable and wrong-memory description matches never select a stop', () => {
  for (const [query, code] of [['Le Shack', 'ANCHOR_AMBIGUOUS'], ['restaurant', 'ANCHOR_AMBIGUOUS'],
    ['Mont Tremblant', 'ANCHOR_NO_MATCH'], ['show this photo please', 'ANCHOR_NO_MATCH'], ['Banff waterfall', 'ANCHOR_NO_MATCH'],
    ['doorway and restaurant interior', 'ANCHOR_AMBIGUOUS']]) {
    const state = descriptionState();
    errorCode(() => navigateAnchor(state, { query }), code);
    assert.equal(state.session.anchorId, null);
  }
  for (const change of [state => state.session.eventId = 'other', state => state.session.lens = 'originals',
    state => state.media[0].revoked = true, state => state.worlds[0].approved = false]) {
    const state = descriptionState(); change(state);
    assert.throws(() => navigateAnchor(state, { query: 'restaurant doorway' }), error => error.code === 'ANCHOR_NO_MATCH' && error.details.candidates.length === 0);
    assert.equal(state.session.anchorId, null);
  }
});

test('fresh live navigation exposes coarse available directions and explains per-turn limits', () => {
  const state = liveState();
  updateSession(state, { activeWorldId: 'world', viewerId: 'navigation-viewer' });
  const context = { worldId: 'world', nodeId: 'village', heading: 330, availableDirections: ['forward', 'backward'] };
  updateSession(state, { viewerId: 'navigation-viewer', streetViewNavigation: context });
  assert.deepEqual(navigationGuide(state).current.availableDirections, ['forward', 'backward']);
  assert.match(navigationGuide(state).instructions, /EACH turn/);
  assert.match(navigationGuide(state).instructions, /Repeat separate move_player/);
  assert.equal(navigationGuide(state).stops[1].anchorId, 'inside-anchor');
  assert.equal(Date.parse(state.session.streetViewNavigation.expiresAt) - Date.parse(state.session.streetViewNavigation.updatedAt), 30_000);
  errorCode(() => updateSession(state, { viewerId: 'other-viewer', streetViewNavigation: context }), 'VIEWER_NOT_ACTIVE');
  for (const patch of [{ nodeId: 'unknown' }, { heading: 361 }, { availableDirections: ['enter'] },
    { availableDirections: ['forward', 'forward'] }, { panoId: 'provider-data' }, { links: [] }]) {
    errorCode(() => updateSession(state, { viewerId: 'navigation-viewer', streetViewNavigation: { ...context, ...patch } }), 'INVALID_NAVIGATION_CONTEXT');
  }
  state.session.streetViewNavigation.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal(navigationGuide(state).current, null);
  updateSession(state, { viewerId: 'navigation-viewer', streetViewNavigation: context });
  updateSession(state, { activeWorldId: null, viewerId: 'navigation-viewer' });
  assert.equal(state.session.streetViewNavigation, undefined);
  assert.equal(navigationGuide(state), null);
});

test('live Street View requires eligible reviewed sources and an explicitly registered active viewer', () => {
  const state = liveState();
  assert.equal(defaultWalkableWorld(state), undefined);
  errorCode(() => queueMovement(state, { worldId: 'world', direction: 'forward' }), 'VIEWER_NOT_ACTIVE');
  updateSession(state, { activeWorldId: 'world', viewerId: 'first-viewer' });
  const command = queueMovement(state, { direction: 'forward' }).command;
  assert.equal(command.worldId, 'world');
  assert.equal(command.viewerId, 'first-viewer');
  for (const change of [s => s.session.lens = 'originals', s => s.session.eventId = 'other', s => s.worlds[0].approved = false,
    s => s.worlds[0].revoked = true, s => s.worlds[0].status = 'stale', s => s.worlds[0].tour.liveStreetView = false,
    s => s.worlds[0].sourceIds = [], s => s.media[0].pending = true, s => s.media[0].revoked = true,
    s => s.events[0].sourceIds = [], s => s.media[0].mime = 'audio/wav']) {
    const candidate = structuredClone(state); change(candidate);
    assert.equal(walkableWorlds(candidate).length, 0);
    assert.equal(movementSession(candidate).movement, undefined);
    errorCode(() => queueMovement(candidate, { worldId: 'world', direction: 'forward' }), 'WORLD_UNAVAILABLE');
  }
});

test('viewer ownership protects saves, movement receipts and delayed closes across tabs', () => {
  const state = liveState();
  updateSession(state, { activeWorldId: 'world', viewerId: 'tab-a' });
  const old = queueMovement(state, { direction: 'forward' }, 1_000).command;
  updateSession(state, { activeWorldId: 'world', viewerId: 'tab-b' });
  assert.equal(state.session.movement, undefined);
  updateSession(state, { activeWorldId: null, viewerId: 'tab-a' });
  assert.equal(state.session.activeViewerId, 'tab-b');
  errorCode(() => updateSession(state, { viewerId: 'tab-a', streetViewPlace: { worldId: 'world', nodeId: 'village', heading: 10 } }), 'VIEWER_NOT_ACTIVE');
  errorCode(() => acknowledgeMovement(state, 'world', { commandId: old.id, viewerId: 'tab-a', status: 'completed', nodeId: 'village', heading: 10 }, 2_000), 'MOVEMENT_SUPERSEDED');
  const command = queueMovement(state, { direction: 'turn_right' }, 2_000).command;
  errorCode(() => acknowledgeMovement(state, 'world', { commandId: command.id, viewerId: 'tab-a', status: 'completed', nodeId: 'village', heading: 30 }, 3_000), 'VIEWER_NOT_ACTIVE');
  const receipt = { commandId: command.id, viewerId: 'tab-b', status: 'completed', nodeId: 'village', heading: 30 };
  assert.equal(acknowledgeMovement(state, 'world', receipt, 3_000).heading, 30);
  assert.deepEqual(state.session.streetViewPlace, { worldId: 'world', nodeId: 'village', heading: 30 });
  assert.deepEqual(acknowledgeMovement(state, 'world', receipt, 4_000), state.session.movementReceipt);
  updateSession(state, { activeWorldId: null, viewerId: 'tab-b' });
  assert.equal(state.session.activeWorldId, null);
  assert.equal(state.session.movement, undefined);
  assert.equal(state.session.streetViewPlace.heading, 30);
  errorCode(() => queueMovement(state, { direction: 'forward' }), 'WORLD_UNAVAILABLE');
  updateSession(state, { activeWorldId: 'world', viewerId: 'reopened' });
  assert.equal(state.session.streetViewPlace.nodeId, 'village');
  updateSession(state, { anchorId: 'inside-anchor', view: 'explore' });
  assert.equal(state.session.activeViewerId, 'reopened', 'An authored same-world destination keeps the current viewer');
});

test('a registered live viewer wins over a newer GLB and closing cannot fall back to that unrelated scene', () => {
  const state = liveState();
  state.worlds.push({ ...state.worlds[0], id: 'newer-glb', format: 'glb', tour: undefined });
  updateSession(state, { activeWorldId: 'world', viewerId: 'live-viewer' });
  assert.equal(defaultWalkableWorld(state).id, 'world');
  assert.equal(queueMovement(state, { direction: 'forward' }).command.worldId, 'world');
  errorCode(() => queueMovement(state, { worldId: 'newer-glb', direction: 'forward' }), 'VIEWER_NOT_ACTIVE');
  updateSession(state, { activeWorldId: null, viewerId: 'live-viewer' });
  assert.equal(defaultWalkableWorld(state), undefined);
  errorCode(() => queueMovement(state, { direction: 'forward' }), 'WORLD_UNAVAILABLE');
});

test('Street View receipts and saved places accept only authored nodes and bounded headings', () => {
  const state = liveState();
  updateSession(state, { activeWorldId: 'world', viewerId: 'viewer' });
  const command = queueMovement(state, { direction: 'forward' }, 1_000).command;
  for (const details of [{}, { nodeId: 'missing', heading: 0 }, { nodeId: 'village', heading: -1 },
    { nodeId: 'village', heading: 361 }, { nodeId: 'village', heading: NaN }, { nodeId: 'village', heading: '0' },
    { nodeId: 'village', heading: 0, position: [46.2, 0, -74.5] }]) {
    errorCode(() => acknowledgeMovement(state, 'world', { commandId: command.id, viewerId: 'viewer', status: 'completed', ...details }, 2_000), 'INVALID_MOVEMENT_RECEIPT');
  }
  for (const details of [{ nodeId: 'missing', heading: 0 }, { nodeId: 'village', heading: Infinity },
    { nodeId: 'village', heading: 0, panoId: 'do-not-persist-provider-data' }]) {
    errorCode(() => updateSession(state, { viewerId: 'viewer', streetViewPlace: { worldId: 'world', ...details } }), 'INVALID_STREET_VIEW_PLACE');
  }
  assert.equal(acknowledgeMovement(state, 'world', { commandId: command.id, viewerId: 'viewer', status: 'blocked', reason: 'No forward coverage' }, 2_000).status, 'blocked');
  updateSession(state, { viewerId: 'viewer', streetViewPlace: { worldId: 'world', nodeId: 'inside', heading: 360 } });
  updateSession(state, { lens: 'originals' });
  assert.equal(state.session.activeWorldId, null);
  assert.equal(movementSession(state).streetViewPlace, undefined);
});

test('omitting worldId selects the latest approved walkable scene without weakening explicit targeting', () => {
  const state = sceneState();
  state.worlds.push({ ...state.worlds[0], id: 'newest-approved' },
    { ...state.worlds[0], id: 'pending-latest', approved: false });
  assert.equal(queueMovement(state, { direction: 'forward' }).command.worldId, 'newest-approved');
  assert.equal(queueMovement(state, { worldId: 'world', direction: 'stop' }).command.worldId, 'world');
  for (const worldId of ['missing', 'pending-latest', '', null]) {
    errorCode(() => queueMovement(state, { worldId, direction: 'forward' }), 'WORLD_UNAVAILABLE');
  }
  state.worlds = [];
  errorCode(() => queueMovement(state, { direction: 'forward' }), 'WORLD_UNAVAILABLE');
});

test('continuous commands are bounded, expire and are never claimed executed before a browser receipt', () => {
  const state = sceneState();
  const queued = queueMovement(state, { worldId: 'world', direction: 'forward' }, 1_000);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.command.durationSeconds, 2);
  assert.equal(queued.command.degrees, 30);
  assert.equal(Date.parse(queued.command.expiresAt) - Date.parse(queued.command.issuedAt), 10_000);
  assert.equal(state.session.movementReceipt, undefined);
  for (const input of [{ direction: 'teleport' }, { durationSeconds: 6 }, { durationSeconds: 0 }, { degrees: 91 }, { degrees: NaN }]) {
    errorCode(() => queueMovement(state, { worldId: 'world', direction: 'forward', ...input }), 'INVALID_MOVEMENT');
  }
  const receipt = { commandId: queued.command.id, status: 'completed', position: [0, 1.65, -2] };
  assert.equal(acknowledgeMovement(state, 'world', receipt, 3_000).status, 'completed');
  assert.deepEqual(acknowledgeMovement(state, 'world', receipt, 4_000), state.session.movementReceipt);
  errorCode(() => acknowledgeMovement(state, 'world', { ...receipt, status: 'blocked' }, 4_000), 'MOVEMENT_ALREADY_REPORTED');
  const next = queueMovement(state, { worldId: 'world', direction: 'stop' }, 5_000);
  assert.notEqual(next.command.id, queued.command.id);
  assert.equal(state.session.movementReceipt, undefined);
  errorCode(() => acknowledgeMovement(state, 'world', receipt, 6_000), 'MOVEMENT_SUPERSEDED');
  errorCode(() => acknowledgeMovement(state, 'world', { commandId: next.command.id, status: 'ignored' }, 20_001), 'MOVEMENT_EXPIRED');
  for (const position of [[1, 2], [1, Infinity, 3], [1, 2, 1e8]]) {
    errorCode(() => acknowledgeMovement(state, 'world', { commandId: next.command.id, status: 'completed', position }, 6_000), 'INVALID_MOVEMENT_RECEIPT');
  }
});

test('movement only targets approved linked reviewed GLBs in the active all-sources memory', () => {
  const changes = [s => s.session.lens = 'originals', s => s.session.eventId = 'other', s => s.worlds[0].approved = false,
    s => s.worlds[0].revoked = true, s => s.worlds[0].status = 'running', s => s.worlds[0].format = 'tour',
    s => s.worlds[0].format = 'spz', s => s.worlds[0].sourceIds = [], s => s.media[0].pending = true,
    s => s.media[0].revoked = true, s => s.events[0].sourceIds = [], s => s.media[0].mime = 'audio/wav'];
  for (const change of changes) {
    const state = sceneState();
    const command = queueMovement(state, { worldId: 'world', direction: 'forward' }).command;
    change(state);
    assert.deepEqual(walkableWorlds(state), []);
    assert.equal(movementSession(state).movement, undefined);
    errorCode(() => queueMovement(state, { worldId: 'world', direction: 'stop' }), 'WORLD_UNAVAILABLE');
    errorCode(() => acknowledgeMovement(state, 'world', { commandId: command.id, status: 'completed' }), 'WORLD_UNAVAILABLE');
  }
  const state = sceneState();
  queueMovement(state, { worldId: 'world', direction: 'turn_left' });
  updateSession(state, { lens: 'originals' });
  updateSession(state, { lens: 'all' });
  assert.equal(state.session.movement, undefined, 'Switching lenses cannot replay an old movement');
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-movement-'));
  const store = createStore(dir);
  const browser = store.newBrowser();
  const stranger = store.newBrowser();
  const project = store.create(browser.actor, 'Movement QA');
  store.update(browser.actor, project.id, null, state => Object.assign(state, sceneState()));
  const pair = store.pair(browser.actor, project.id);
  const foreign = store.create(stranger.actor, 'Other private project');
  const foreignPair = store.pair(stranger.actor, foreign.id);
  const app = await createApp({ dataDir: dir, serveWeb: false });
  t.after(async () => { await app.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const p = '/v1/projects/' + project.id;
  async function request(path, payload, { status = 200, headers = {} } = {}) {
    const response = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url: p + path,
      headers: { cookie: 'ew_session=' + browser.token, ...headers }, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, status, response.body);
    return status >= 400 ? response.json() : response.json().data;
  }
  return { dir, store, browser, stranger, project, foreignPair, request,
    voice: (name, body = {}, options = {}) => request('/voice/' + name, body,
      { ...options, headers: { authorization: 'Bearer ' + pair.token, ...options.headers } }) };
}

test('voice default world matches the latest approved GLB used by Enter memory world', async t => {
  const ctx = await fixture(t);
  ctx.store.update(ctx.browser.actor, ctx.project.id, null, state => {
    state.worlds.push({ ...state.worlds[0], id: 'newer-world', title: 'Refined walking set' });
  });
  assert.equal((await ctx.voice('get_context')).defaultWalkableWorldId, 'newer-world');
  ctx.store.update(ctx.browser.actor, ctx.project.id, null, state => { state.worlds[1].approved = false; });
  assert.equal((await ctx.voice('get_context')).defaultWalkableWorldId, 'world');
  await ctx.request('/session', { lens: 'originals' });
  assert.equal((await ctx.voice('get_context')).defaultWalkableWorldId, null);
});

test('paired voice queues commands, browser reports actual movement, and foreign or forged callers fail', async t => {
  const ctx = await fixture(t);
  assert.deepEqual((await ctx.voice('get_context')).walkableWorlds, [{ id: 'world', title: 'Winter walking set', format: 'glb' }]);
  await ctx.request('/voice/move_player', { worldId: 'world', direction: 'forward' }, { status: 401 });
  await ctx.voice('move_player', { worldId: 'world', direction: 'forward' }, { status: 404, headers: { authorization: 'Bearer ' + ctx.foreignPair.token } });
  await ctx.voice('move_player', { worldId: 'world', direction: 'forward', durationSeconds: 50 }, { status: 400 });
  const queued = await ctx.voice('move_player', { direction: 'forward', durationSeconds: 0.5 });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.command.worldId, 'world');
  assert.equal((await ctx.voice('get_context')).movementReceipt, undefined);
  const receipt = { commandId: queued.command.id, status: 'blocked', position: [1, 1.65, 2], reason: 'Collision boundary' };
  await ctx.voice('../worlds/world/movement-ack', receipt, { status: 403 });
  await ctx.request('/worlds/world/movement-ack', receipt, { status: 404, headers: { cookie: 'ew_session=' + ctx.stranger.token } });
  await ctx.request('/worlds/world/movement-ack', receipt, { status: 403, headers: { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' } });
  await ctx.request('/worlds/world/movement-ack', receipt);
  assert.equal((await ctx.voice('get_context')).movementReceipt.status, 'blocked');
  await ctx.request('/session', { lens: 'originals' });
  assert.deepEqual((await ctx.voice('get_context')).walkableWorlds, []);
  await ctx.voice('move_player', { worldId: 'world', direction: 'forward' }, { status: 404 });
});

test('live voice targets the registered viewer and browser-only ownership persists through authenticated API calls', async t => {
  const ctx = await fixture(t);
  ctx.store.update(ctx.browser.actor, ctx.project.id, null, state => Object.assign(state, liveState()));
  await ctx.voice('move_player', { worldId: 'world', direction: 'forward' }, { status: 409 });
  await ctx.request('/session', { activeWorldId: 'world', viewerId: 'active-tab' }, { status: 401, headers: { cookie: '' } });
  await ctx.request('/session', { activeWorldId: 'world', viewerId: 'active-tab' },
    { status: 404, headers: { cookie: 'ew_session=' + ctx.stranger.token } });
  await ctx.voice('../session', { activeWorldId: 'world', viewerId: 'forged' }, { status: 403 });
  await ctx.request('/session', { activeWorldId: 'world', viewerId: 'active-tab' });
  let context = await ctx.voice('get_context');
  assert.equal(context.defaultWalkableWorldId, 'world');
  assert.equal(context.activeViewerId, 'active-tab');
  assert.deepEqual(context.anchors, [{ id: 'inside-anchor', title: 'Verified interior', worldId: 'world', nodeId: 'inside' }]);
  const queued = await ctx.voice('move_player', { direction: 'turn_right' });
  assert.equal(queued.command.viewerId, 'active-tab');
  const receipt = { commandId: queued.command.id, viewerId: 'active-tab', status: 'completed', nodeId: 'village', heading: 30 };
  await ctx.voice('../worlds/world/movement-ack', receipt, { status: 403 });
  await ctx.request('/worlds/world/movement-ack', { ...receipt, viewerId: 'stale-tab' }, { status: 409 });
  await ctx.request('/worlds/world/movement-ack', receipt);
  context = await ctx.voice('get_context');
  assert.equal(context.movementReceipt.nodeId, 'village');
  assert.equal(context.streetViewPlace.heading, 30);
  await ctx.voice('navigate_anchor', { anchorId: 'inside-anchor' });
  assert.equal((await ctx.voice('get_context')).anchorId, 'inside-anchor');
  await ctx.request('/session', { activeWorldId: null, viewerId: 'active-tab' });
  await ctx.voice('move_player', { direction: 'forward' }, { status: 404 });
  assert.equal((await ctx.voice('get_context')).defaultWalkableWorldId, null);
});

test('browser and paired description navigation share matches while rejecting foreign callers and ambiguous input', async t => {
  const ctx = await fixture(t);
  ctx.store.update(ctx.browser.actor, ctx.project.id, null, state => Object.assign(state, descriptionState()));
  const query = { query: 'the restaurant doorway' };
  await ctx.request('/navigate-anchor', query, { status: 401, headers: { cookie: '' } });
  await ctx.request('/navigate-anchor', query, { status: 404, headers: { cookie: 'ew_session=' + ctx.stranger.token } });
  await ctx.request('/navigate-anchor', query, { status: 403, headers: { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' } });
  await ctx.voice('../navigate-anchor', query, { status: 403 });
  const browser = await ctx.request('/navigate-anchor', query);
  assert.equal(browser.resolution.nodeId, 'entrance');
  const voice = await ctx.voice('navigate_anchor', query);
  assert.deepEqual(voice.resolution, browser.resolution);
  assert.equal(voice.arrival, 'unconfirmed');
  await ctx.voice('navigate_anchor', { query: 'inside', anchorId: 'inside-anchor' }, { status: 400 });
  const ambiguous = await ctx.request('/navigate-anchor', { query: 'Le Shack' }, { status: 409 });
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal((await ctx.voice('get_context')).anchorId, 'entrance-anchor');
  const generic = await ctx.request('/navigate-anchor', { query: 'Mont Tremblant' }, { status: 404 });
  assert.equal(generic.code, 'ANCHOR_NO_MATCH');
  await ctx.request('/navigate-anchor', { anchorId: 'inside-anchor' });
  assert.equal((await ctx.voice('get_context')).anchorId, 'inside-anchor');
});

function glb() {
  const positions = Buffer.from(new Float32Array([-5, 0, -5, 5, 0, -5, 0, 0, 5]).buffer);
  const scene = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: positions.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-5, 0, -5], max: [5, 0, 5] }] };
  const json = Buffer.from(JSON.stringify(scene));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(padded);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + positions.length, 8); header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binary = Buffer.alloc(8); binary.writeUInt32LE(positions.length); binary.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binary, positions]);
}

test('reviewed imagined images support imagined GLB imports while scans, SPZ, unreviewed and zero-source imports stay blocked', async t => {
  const ctx = await fixture(t);
  const bytes = glb();
  const upload = async (provenance, filename, ids = ['photo'], status = 400) => {
    const boundary = 'everwhere-movement-test';
    const body = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\r\nContent-Type: application/octet-stream\r\n\r\n'), bytes, Buffer.from('\r\n--' + boundary + '--\r\n')]);
    const params = new URLSearchParams({ consent: '1', provenance, sourceIds: JSON.stringify(ids), expectedRevision: String(ctx.store.read(ctx.browser.actor, ctx.project.id).revision) });
    return ctx.request('/memories/event/worlds?' + params, body, { status, headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } });
  };
  assert.equal((await upload('reconstructed', 'scene.glb')).code, 'ORIGINAL_REQUIRED');
  assert.equal((await upload('imagined', 'scene.spz')).code, 'ORIGINAL_REQUIRED');
  await upload('imagined', 'scene.glb', []);
  ctx.store.update(ctx.browser.actor, ctx.project.id, null, state => { state.media[0].pending = true; });
  await upload('imagined', 'scene.glb');
  ctx.store.update(ctx.browser.actor, ctx.project.id, null, state => { state.media[0].pending = false; });
  const saved = await upload('imagined', 'scene.glb', ['photo'], 200);
  const world = (await ctx.request('/snapshot')).worlds.find(item => item.id === saved.id);
  assert.equal(world.provenance, 'imagined');
  assert.equal(world.approved, false);
  assert.equal((await readdir(join(ctx.dir, 'projects', ctx.project.id))).filter(name => name.endsWith('.glb')).length, 1);
});
