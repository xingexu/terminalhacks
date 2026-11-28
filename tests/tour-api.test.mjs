import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createApp } from '../apps/api/server.mjs';

const image = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#ccbbaa' } }).jpeg().toBuffer();
const picture = 'data:image/jpeg;base64,' + image.toString('base64');

async function setup(t, configure) {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-tour-api-'));
  const app = await createApp({ dataDir: dir, serveWeb: false });
  configure?.(app);
  t.after(async () => { app.server.closeAllConnections(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const root = await app.listen({ port: 0, host: '127.0.0.1' });
  async function browser() {
    const response = await fetch(root + '/v1/bootstrap');
    await response.arrayBuffer();
    return response.headers.get('set-cookie').split(';')[0];
  }
  const cookie = await browser();
  async function request(path, body, { status = 200, actor = cookie, headers = {} } = {}) {
    const form = body instanceof FormData;
    const response = await fetch(root + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: actor, ...(body !== undefined && !form && { 'Content-Type': 'application/json' }), ...headers },
      body: form ? body : body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return status >= 400 ? json : json.data;
  }
  const project = await request('/v1/projects', { title: 'Fictional birthday demo QA' }, { status: 201 });
  const p = '/v1/projects/' + project.id;
  const event = await request(p + '/memories', { title: 'Imagined birthday gathering', placeLabel: 'Fictional venue', expectedRevision: 0 });
  return { root, dir, p, event, cookie, browser, request, snap: () => request(p + '/snapshot'),
    files: () => readdir(join(dir, 'projects', project.id)).catch(error => { if (error.code === 'ENOENT') return []; throw error; }) };
}

function form(data, name) {
  const value = new FormData();
  value.append('file', new File([data], name));
  return value;
}

async function source(ctx, provenance = 'imagined', review = true) {
  const capture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const result = await ctx.request(ctx.p + '/capture/sessions/' + capture.id + '/files' + (provenance ? '?provenance=' + provenance : ''), form(image, 'birthday-illustration.jpg'));
  if (review) {
    const proposal = await ctx.request(ctx.p + '/capture/observations/' + result.observationId + '/preview', {
      eventId: ctx.event.id, expectedRevision: (await ctx.snap()).revision, relation: 'reference'
    });
    await ctx.request(ctx.p + '/commands', { ...proposal.command, requestId: randomUUID(), previewToken: proposal.previewToken });
  }
  return { ...result, capture };
}

const tour = sourceId => ({ version: 'everwhere-tour-1', title: 'Birthday photo walkthrough', startNodeId: 'outside', nodes: [
  { id: 'outside', title: 'Outside', description: 'Imagined demonstration, not a real birthday.', projection: 'perspective', image: picture,
    sourceIds: [sourceId], links: [{ to: 'inside', label: 'Enter', kind: 'door' }] },
  { id: 'inside', title: 'Inside', projection: 'streetview', streetViewEmbedUrl: 'https://www.google.com/maps/embed?pb=!4v1234',
    links: [{ to: 'outside', label: 'Go outside' }] }
] });

async function importTour(ctx, sourceIds, { manifest = tour(sourceIds[0]), filename = 'birthday.tour.json', status = 200, query = {}, actor, headers } = {}) {
  const params = new URLSearchParams({ consent: '1', provenance: 'imagined', sourceIds: JSON.stringify(sourceIds),
    expectedRevision: String((await ctx.snap()).revision), ...query });
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const result = await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/worlds?' + params, form(bytes, filename), { status, ...(actor && { actor }), headers });
  return { ...result, bytes };
}

async function commit(ctx, type, payload) {
  const command = { type, targetId: ctx.event.id, expectedRevision: (await ctx.snap()).revision, payload };
  const proposal = await ctx.request(ctx.p + '/previews', command);
  return ctx.request(ctx.p + '/commands', { ...command, previewToken: proposal.previewToken, requestId: randomUUID() });
}

async function asset(ctx, id, { name = 'tour.json', cookie = ctx.cookie, status = 200 } = {}) {
  const response = await fetch(ctx.root + ctx.p + '/worlds/' + id + '/' + name, { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(response.status, status);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes };
}

test('paired camera requests keep actual uploaded frames pending until the existing review flow confirms them', async t => {
  const ctx = await setup(t);
  const pair = await ctx.request(ctx.p + '/pairing', { confirm: true });
  const voice = (name, body, options = {}) => ctx.request(ctx.p + '/voice/' + name, body,
    { ...options, headers: { Authorization: 'Bearer ' + pair.token } });
  await voice('camera_action', { action: 'open' }, { status: 409 });
  await ctx.request(ctx.p + '/session', { cameraViewerId: 'camera-browser' });
  const opened = await voice('camera_action', { action: 'open' });
  assert.equal(opened.status, 'queued');
  assert.equal((await ctx.snap()).session.cameraReady, false);
  await ctx.request(ctx.p + '/camera-action-ack', { requestId: opened.command.id, viewerId: 'camera-browser', status: 'opened' },
    { status: 403, headers: { Authorization: 'Bearer ' + pair.token } });
  await ctx.request(ctx.p + '/camera-action-ack', { requestId: opened.command.id, viewerId: 'camera-browser', status: 'opened' });
  const shot = await voice('camera_action', { action: 'capture' });
  const capture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const uploaded = await ctx.request(ctx.p + '/capture/sessions/' + capture.id + '/files', form(image, 'Camera frame - original date unknown.jpg'),
    { headers: { 'X-Capture-Id': shot.command.id } });
  await ctx.request(ctx.p + '/camera-action-ack', { requestId: shot.command.id, viewerId: 'camera-browser', status: 'captured', observationId: uploaded.observationId });
  const pending = await ctx.snap();
  assert.equal(pending.media.some(item => item.id === uploaded.media.id), false);
  assert.equal(pending.events[0].sourceIds.includes(uploaded.media.id), false);
  assert.equal(uploaded.media.capturedAt, null);
  const inbox = await voice('get_capture_inbox', {});
  assert.ok(JSON.stringify(inbox).includes(uploaded.observationId));
  const preview = await voice('preview_capture_link', { observationId: uploaded.observationId, eventId: ctx.event.id });
  await voice('confirm_change', { previewToken: preview.previewToken, expectedRevision: (await ctx.snap()).revision, requestId: randomUUID() });
  const reviewed = await ctx.snap();
  assert.ok(reviewed.events[0].sourceIds.includes(uploaded.media.id));
  assert.ok(reviewed.media.some(item => item.id === uploaded.media.id));
});

test('live route capability survives approved import and persisted authored place without weakening source revocation', async t => {
  const ctx = await setup(t);
  const input = await source(ctx);
  const manifest = { version: 'everwhere-tour-1', title: 'Village reference route', startNodeId: 'village', nodes: [
    { id: 'village', title: 'Village', description: 'Reviewed public village stop; no interior is implied.', projection: 'streetview', streetView: { lat: 46.21, lng: -74.58, heading: 45 },
      sourceIds: [input.media.id], links: [] }
  ] };
  const imported = await importTour(ctx, [input.media.id], { manifest });
  let world = (await ctx.snap()).worlds.find(item => item.id === imported.id);
  assert.equal(world.tour.liveStreetView, true);
  assert.doesNotMatch(JSON.stringify(world.tour), /streetView"|panoId|"lat"|"lng"/);
  await ctx.request(ctx.p + '/session', { activeWorldId: world.id, viewerId: 'viewer' }, { status: 404 });
  await commit(ctx, 'artifact.approve', { artifactId: world.id, dependencyHash: world.inputHash });
  await ctx.request(ctx.p + '/session', { lens: 'all', activeWorldId: world.id, viewerId: 'viewer' });
  const pair = await ctx.request(ctx.p + '/pairing', { confirm: true });
  const nav = { worldId: world.id, nodeId: 'village', heading: 45, availableDirections: ['forward'] };
  await ctx.request(ctx.p + '/session', { viewerId: 'viewer', streetViewNavigation: nav },
    { status: 403, headers: { Authorization: 'Bearer ' + pair.token } });
  await ctx.request(ctx.p + '/session', { viewerId: 'viewer', streetViewNavigation: nav });
  const context = await ctx.request(ctx.p + '/voice/get_context', {}, { headers: { Authorization: 'Bearer ' + pair.token } });
  assert.match(context.navigation.instructions, /EACH turn/);
  assert.equal(context.navigation.stops[0].description, manifest.nodes[0].description);
  assert.deepEqual(context.navigation.current.availableDirections, ['forward']);
  assert.doesNotMatch(JSON.stringify(context.navigation), /"lat"|"lng"|"panoId"/);
  await ctx.request(ctx.p + '/session', { viewerId: 'viewer', streetViewPlace: { worldId: world.id, nodeId: 'village', heading: 75 } });
  await ctx.request(ctx.p + '/session', { activeWorldId: null, viewerId: 'viewer' });
  const closed = await ctx.snap();
  assert.equal(closed.session.activeWorldId, null);
  assert.deepEqual(closed.session.streetViewPlace, { worldId: world.id, nodeId: 'village', heading: 75 });
  await ctx.request(ctx.p + '/session', { activeWorldId: world.id, viewerId: 'reopened' });
  assert.equal((await ctx.snap()).session.streetViewPlace.heading, 75);
  await asset(ctx, world.id);
  await ctx.request(ctx.p + '/capture/grants/' + input.capture.grantId + '/revoke', {});
  const revoked = await ctx.snap();
  assert.equal(revoked.session.activeWorldId, null);
  assert.equal(revoked.session.activeViewerId, undefined);
  assert.equal(revoked.session.streetViewPlace, undefined);
  await asset(ctx, world.id, { status: 404 });
  await ctx.request(ctx.p + '/session', { activeWorldId: world.id, viewerId: 'again' }, { status: 404 });
});

test('imagined capture is explicit, preserves bytes and refuses provenance laundering through deduplication', async t => {
  const ctx = await setup(t);
  const uploaded = await source(ctx);
  assert.equal(uploaded.media.provenance, 'imagined');
  assert.match(uploaded.media.caption, /^Imagined reference · /);
  const original = await fetch(ctx.root + ctx.p + '/sources/' + uploaded.media.id + '?variant=original', { headers: { Cookie: ctx.cookie } });
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), image);
  const count = (await ctx.files()).length;
  const endpoint = ctx.p + '/capture/sessions/' + uploaded.capture.id + '/files';
  assert.equal((await ctx.request(endpoint + '?provenance=imagined', form(image, 'retry.jpg'))).duplicate, true);
  assert.equal((await ctx.request(endpoint, form(image, 'launder.jpg'), { status: 409 })).code, 'PROVENANCE_CONFLICT');
  assert.equal((await ctx.request(endpoint + '?provenance=reconstructed', form(image, 'invalid.jpg'), { status: 400 })).code, 'INVALID_PROVENANCE');
  assert.equal((await ctx.files()).length, count);
  const audio = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'browser_audio' });
  await ctx.request(ctx.p + '/capture/sessions/' + audio.id + '/files?provenance=imagined', form(image, 'wrong.jpg'), { status: 400 });
});

test('tour imports have compact snapshots, node anchors, separate approval, safe navigation and revocable delivery', async t => {
  const ctx = await setup(t);
  const input = await source(ctx);
  const imported = await importTour(ctx, [input.media.id]);
  const snapshot = await ctx.snap();
  const world = snapshot.worlds.find(item => item.id === imported.id);
  assert.equal(world.format, 'tour');
  assert.equal(world.provenance, 'imagined');
  assert.equal(world.approved, false);
  assert.equal(world.tour.startNodeId, 'outside');
  assert.deepEqual(world.tour.nodes, [{ id: 'outside', title: 'Outside', sourceIds: [input.media.id] }, { id: 'inside', title: 'Inside' }]);
  assert.doesNotMatch(JSON.stringify(world), /base64|data:image|streetViewEmbedUrl|storage|contentHash/);
  const anchors = snapshot.anchors.filter(item => item.worldId === world.id);
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors.map(item => ({ nodeId: item.nodeId, sourceIds: item.sourceIds, position: item.position })), [
    { nodeId: 'outside', sourceIds: [input.media.id], position: [0, 0, 0] }, { nodeId: 'inside', sourceIds: [], position: [0, 0, 0] }
  ]);
  await asset(ctx, world.id, { status: 404 });
  await ctx.request(ctx.p + '/session', { lens: 'all', anchorId: anchors[1].id }, { status: 404 });
  await commit(ctx, 'artifact.approve', { artifactId: world.id, dependencyHash: world.inputHash });
  await ctx.request(ctx.p + '/session', { lens: 'all', anchorId: anchors[1].id });
  const delivered = await asset(ctx, world.id);
  assert.match(delivered.response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(delivered.bytes, imported.bytes);
  const download = await asset(ctx, world.id, { name: 'tour.json?download=1' });
  assert.match(download.response.headers.get('content-disposition'), /everwhere-memory.tour.json/);
  assert.deepEqual(download.bytes, imported.bytes);
  await asset(ctx, world.id, { name: 'scene.spz', status: 404 });
  await asset(ctx, world.id, { name: 'scene.glb', status: 404 });
  await asset(ctx, world.id, { status: 401, cookie: '' });
  await asset(ctx, world.id, { status: 404, cookie: await ctx.browser() });
  await ctx.request(ctx.p + '/session', { lens: 'originals' });
  assert.equal((await ctx.snap()).session.anchorId, null);
  await asset(ctx, world.id, { status: 404 });
  await ctx.request(ctx.p + '/session', { anchorId: anchors[1].id }, { status: 404 });
  await ctx.request(ctx.p + '/session', { lens: 'all', anchorId: anchors[0].id });
  await ctx.request(ctx.p + '/capture/grants/' + input.capture.grantId + '/revoke', {});
  await asset(ctx, world.id, { status: 404 });
  await ctx.request(ctx.p + '/session', { anchorId: anchors[1].id }, { status: 404 });
  const revoked = await ctx.snap();
  assert.equal(revoked.worlds.length, 0);
  assert.equal(revoked.anchors.filter(item => item.worldId === world.id).length, 0);
  assert.equal(revoked.session.anchorId, null);
  assert.equal((await ctx.files()).some(name => name.endsWith('.tour.json')), false);
});

test('original images stay the default and can support a tour without duplicate imports or duplicate node anchors', async t => {
  const ctx = await setup(t);
  const uploaded = await source(ctx, null);
  assert.equal(uploaded.media.provenance, 'original');
  const first = await importTour(ctx, [uploaded.media.id]);
  const second = await importTour(ctx, [uploaded.media.id]);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal((await ctx.snap()).anchors.filter(item => item.worldId === first.id).length, 2);
  assert.equal((await ctx.files()).filter(name => name.endsWith('.tour.json')).length, 1);
});

test('tour import rejects zero sources, pending or foreign evidence, non-imagined claims and non-subset node sources', async t => {
  const ctx = await setup(t);
  const uploaded = await source(ctx);
  const before = (await ctx.files()).sort();
  await importTour(ctx, [], { status: 400 });
  await importTour(ctx, ['foreign-photo'], { status: 400 });
  await importTour(ctx, [uploaded.media.id], { query: { provenance: 'reconstructed' }, status: 400 });
  const badNode = tour(uploaded.media.id); badNode.nodes[1].sourceIds = ['foreign-photo'];
  const rejected = await importTour(ctx, [uploaded.media.id], { manifest: badNode, status: 400 });
  assert.equal(rejected.code, 'INVALID_TOUR_SOURCES');
  await importTour(ctx, [uploaded.media.id], { query: { consent: '0' }, status: 400 });
  await importTour(ctx, [uploaded.media.id], { actor: await ctx.browser(), status: 404 });
  await importTour(ctx, [uploaded.media.id], { headers: { Origin: 'https://foreign.example', 'Sec-Fetch-Site': 'cross-site' }, status: 403 });
  assert.equal((await ctx.snap()).worlds.length, 0);
  assert.deepEqual((await ctx.files()).sort(), before, 'Rejected imports cannot leave stored tour files');
  const pendingContext = await setup(t);
  const pending = await source(pendingContext, 'imagined', false);
  await importTour(pendingContext, [pending.media.id], { status: 400 });
  assert.equal((await pendingContext.snap()).worlds.length, 0);
});

test('imagined images cannot be laundered into reconstructed GLB or SPZ imports', async t => {
  const ctx = await setup(t);
  const uploaded = await source(ctx);
  for (const filename of ['fake.glb', 'fake.spz']) {
    const result = await importTour(ctx, [uploaded.media.id], { filename, query: { provenance: 'reconstructed' }, status: 400 });
    assert.equal(result.code, 'ORIGINAL_REQUIRED');
  }
  assert.equal((await ctx.snap()).worlds.length, 0);
});

test('source withdrawal during tour upload rolls back world and anchors and removes the late asset', async t => {
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const ctx = await setup(t, app => app.addHook('preHandler', async req => {
    if (!req.url.includes('/worlds?')) return;
    const file = req.file.bind(req);
    req.file = async (...args) => { started.resolve(); await resume.promise; return file(...args); };
  }));
  const uploaded = await source(ctx);
  const pending = importTour(ctx, [uploaded.media.id], { status: 409 });
  try {
    await started.promise;
    await ctx.request(ctx.p + '/capture/grants/' + uploaded.capture.grantId + '/revoke', {});
  } finally { resume.resolve(); }
  assert.equal((await pending).code, 'REVISION_CONFLICT');
  assert.equal((await ctx.snap()).worlds.length, 0);
  assert.equal((await ctx.snap()).anchors.length, 0);
  assert.equal((await ctx.files()).some(name => name.endsWith('.tour.json')), false);
});

test('tour navigation refuses coordinate-only manual anchors that do not identify a tour node', async t => {
  const ctx = await setup(t);
  const uploaded = await source(ctx);
  const imported = await importTour(ctx, [uploaded.media.id]);
  const world = (await ctx.snap()).worlds.find(item => item.id === imported.id);
  await commit(ctx, 'artifact.approve', { artifactId: world.id, dependencyHash: world.inputHash });
  await ctx.request(ctx.p + '/session', { lens: 'all' });
  await commit(ctx, 'anchor.add', { worldId: world.id, sourceIds: [], position: [2, 0, 3] });
  const manual = (await ctx.snap()).anchors.find(item => item.worldId === world.id && !item.nodeId);
  await ctx.request(ctx.p + '/session', { anchorId: manual.id }, { status: 404 });
});
