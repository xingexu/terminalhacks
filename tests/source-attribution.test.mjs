import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createApp } from '../apps/api/server.mjs';
import { normalizeAttribution } from '../packages/media/attribution.mjs';

const credit = {
  title: 'Street in Mont Tremblant', creator: 'Artur Staszewski',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Street_in_Mont_Tremblant_(6873305022).jpg',
  license: 'CC BY-SA 2.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/',
  reportedDate: '2012-03-12',
  dateNote: 'Flickr reports Taken March 12, 2012; downloaded EXIF has only a ModifyDate. Commons also reports digitization December 31, 2011. Exact capture time and timezone are unverified.'
};

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-attribution-'));
  const app = await createApp({ dataDir: dir, serveWeb: false });
  t.after(async () => { app.server.closeAllConnections(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const root = await app.listen({ port: 0, host: '127.0.0.1' });
  async function browser() {
    const result = await fetch(root + '/v1/bootstrap');
    await result.arrayBuffer();
    return result.headers.get('set-cookie').split(';')[0];
  }
  const cookie = await browser();
  async function request(path, body, { status = 200, headers = {}, actor = cookie } = {}) {
    const multipart = body instanceof FormData;
    const result = await fetch(root + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: actor, ...(body !== undefined && !multipart && { 'Content-Type': 'application/json' }), ...headers },
      body: multipart ? body : body === undefined ? undefined : JSON.stringify(body) });
    const json = await result.json();
    assert.equal(result.status, status, JSON.stringify(json));
    return status >= 400 ? json : json.data;
  }
  const project = await request('/v1/projects', { title: 'Tremblant public reference' }, { status: 201 });
  const p = '/v1/projects/' + project.id;
  const event = await request(p + '/memories', { title: 'Tremblant reference scene', placeLabel: 'Mont-Tremblant, Quebec', expectedRevision: 0 });
  return { dir, root, cookie, browser, request, p, event, snap: () => request(p + '/snapshot'),
    files: () => readdir(join(dir, 'projects', project.id)).catch(error => { if (error.code === 'ENOENT') return []; throw error; }) };
}

async function photograph(color = '#ccddee') {
  return sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).jpeg().toBuffer();
}

function form(bytes, attribution, order = 'before') {
  const data = new FormData();
  if (attribution !== undefined && order === 'before') data.append('attribution', JSON.stringify(attribution));
  data.append('file', new File([bytes], 'public-street-reference.jpg', { type: 'image/jpeg' }));
  if (attribution !== undefined && order === 'after') data.append('attribution', JSON.stringify(attribution));
  return data;
}

async function upload(ctx, attribution = credit, color, order) {
  const capture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const bytes = await photograph(color);
  const result = await ctx.request(ctx.p + '/capture/sessions/' + capture.id + '/files', form(bytes, attribution, order));
  return { ...result, capture, bytes };
}

async function review(ctx, observationId) {
  const proposal = await ctx.request(ctx.p + '/capture/observations/' + observationId + '/preview', {
    eventId: ctx.event.id, expectedRevision: (await ctx.snap()).revision, relation: 'reference'
  });
  assert.equal(proposal.command.payload.relation, 'reference');
  return ctx.request(ctx.p + '/commands', { ...proposal.command, requestId: randomUUID(), previewToken: proposal.previewToken });
}

async function approve(ctx, world) {
  const body = { type: 'artifact.approve', targetId: ctx.event.id, payload: { artifactId: world.id, dependencyHash: world.inputHash }, expectedRevision: (await ctx.snap()).revision };
  const proposal = await ctx.request(ctx.p + '/previews', body);
  await ctx.request(ctx.p + '/commands', { ...body, previewToken: proposal.previewToken, requestId: randomUUID() });
  await ctx.request(ctx.p + '/session', { lens: 'all' });
}

function glb() {
  const positions = Buffer.from(new Float32Array([-5, 0, -5, 0, 0, 5, 5, 0, -5]).buffer);
  const scene = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: positions.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-5, 0, -5], max: [5, 0, 5] }] };
  const json = Buffer.from(JSON.stringify(scene));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const header = Buffer.alloc(20);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + positions.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binary = Buffer.alloc(8);
  binary.writeUInt32LE(positions.length); binary.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binary, positions]);
}

test('public attribution validates bounded links and dates without inventing a capture instant', () => {
  assert.deepEqual(normalizeAttribution(credit), { kind: 'public_reference', ...credit });
  assert.equal(normalizeAttribution(undefined), undefined);
  assert.equal(normalizeAttribution({ ...credit, reportedDate: '' }).reportedDate, null);
  assert.equal(normalizeAttribution({ ...credit, dateNote: 'Source date uncertain.\nTimezone unknown.' }).dateNote, 'Source date uncertain.\nTimezone unknown.');
  for (const input of [null, [], { ...credit, unexpected: 'field' }, { ...credit, creator: '' }, { ...credit, title: 'x'.repeat(181) },
    { ...credit, reportedDate: '2012-02-30' }, { ...credit, reportedDate: '2012-03-12T00:00:00Z' }, { ...credit, dateNote: 'x'.repeat(1001) },
    { ...credit, dateNote: 'bad\u0000note' }, { ...credit, creator: 'bad\nname' },
    ...['javascript:alert(1)', 'data:text/html,hello', 'https://name:password@example.com/photo', 'http://127.0.0.1/photo', 'http://localhost/photo', 'https://foo.local/photo'].map(sourceUrl => ({ ...credit, sourceUrl }))]) {
    assert.throws(() => normalizeAttribution(input), error => error.status === 400 && error.code === 'INVALID_ATTRIBUTION');
  }
});

test('a multiline public-photo date note survives the capture form upload', async t => {
  const ctx = await setup(t);
  const attribution = { ...credit, dateNote: 'Flickr reports March 12, 2012.\r\nExact capture time and timezone remain unknown.' };
  const source = await upload(ctx, attribution);
  assert.equal(source.media.attribution.dateNote, attribution.dateNote);
  await review(ctx, source.observationId);
  assert.equal((await ctx.snap()).media.find(item => item.id === source.media.id).attribution.dateNote, attribution.dateNote);
});

test('public credits survive upload, inbox and review; original bytes and uncertain dates are preserved', async t => {
  const ctx = await setup(t);
  const source = await upload(ctx, credit, undefined, 'after');
  const expected = normalizeAttribution(credit);
  assert.deepEqual(source.media.attribution, expected);
  assert.equal(source.media.capturedAt, null);
  assert.equal(source.media.capturedLocal, null);
  const inbox = await ctx.request(ctx.p + '/capture/inbox');
  assert.deepEqual(inbox.find(item => item.id === source.observationId).media.attribution, expected);
  assert.equal((await ctx.snap()).media.length, 0, 'Unreviewed uploads stay out of the timeline');
  await review(ctx, source.observationId);
  assert.deepEqual((await ctx.snap()).media.find(item => item.id === source.media.id).attribution, expected);
  assert.equal((await ctx.snap()).events[0].startAt, null, 'A public source date is not a personal trip date');
  const original = await fetch(ctx.root + ctx.p + '/sources/' + source.media.id + '?download=1&variant=original', { headers: { Cookie: ctx.cookie } });
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), source.bytes);
  const before = (await ctx.files()).sort();
  const endpoint = ctx.p + '/capture/sessions/' + source.capture.id + '/files';
  assert.equal((await ctx.request(endpoint, form(source.bytes, credit))).duplicate, true);
  assert.equal((await ctx.request(endpoint, form(source.bytes, { ...credit, creator: 'Different creator' }), { status: 409 })).code, 'ATTRIBUTION_CONFLICT');
  assert.equal((await ctx.request(endpoint, form(source.bytes), { status: 409 })).code, 'ATTRIBUTION_CONFLICT');
  assert.deepEqual((await ctx.files()).sort(), before, 'Duplicate and conflicting uploads leave no orphan files');
  const privateCapture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const privatePhoto = await ctx.request(ctx.p + '/capture/sessions/' + privateCapture.id + '/files', form(await photograph('#ffddaa')));
  assert.equal(privatePhoto.media.attribution, undefined, 'Legacy uploads need no credit fields');
});

test('bad metadata, multipart abuse and unauthorized uploads leave no source files', async t => {
  const ctx = await setup(t);
  const capture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const endpoint = ctx.p + '/capture/sessions/' + capture.id + '/files';
  const bytes = await photograph();
  const malformed = form(bytes);
  malformed.append('attribution', '{not json');
  await ctx.request(endpoint, malformed, { status: 400 });
  await ctx.request(endpoint, form(bytes, { ...credit, sourceUrl: 'javascript:alert(1)' }, 'after'), { status: 400 });
  const unknown = form(bytes);
  unknown.append('unknown', 'hello');
  await ctx.request(endpoint, unknown, { status: 400 });
  const huge = form(bytes);
  huge.append('attribution', 'x'.repeat(9000));
  await ctx.request(endpoint, huge, { status: 400 });
  const duplicate = form(bytes, credit);
  duplicate.append('attribution', JSON.stringify(credit));
  await ctx.request(endpoint, duplicate, { status: 413 });
  await ctx.request(endpoint, form(bytes, credit), { status: 403, headers: { Origin: 'https://unrelated.example', 'Sec-Fetch-Site': 'cross-site' } });
  await ctx.request(endpoint, form(bytes, credit), { status: 404, actor: await ctx.browser() });
  assert.deepEqual(await ctx.files(), []);
  assert.deepEqual(await ctx.request(ctx.p + '/capture/inbox'), []);
});

test('world companion credits include every public source and follow approval, ownership, lens and revocation', async t => {
  const ctx = await setup(t);
  const first = await upload(ctx);
  const secondCredit = { ...credit, title: 'Second public reference', creator: 'Second photographer', reportedDate: '', dateNote: 'Capture date unknown.' };
  const second = await upload(ctx, secondCredit, '#aabbcc');
  const privateCapture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const privatePhoto = await ctx.request(ctx.p + '/capture/sessions/' + privateCapture.id + '/files', form(await photograph('#556677')));
  for (const source of [first, second, privatePhoto]) await review(ctx, source.observationId);
  const data = new FormData();
  const assetBytes = glb();
  data.append('file', new File([assetBytes], 'Tremblant imagined extension.glb'));
  const sourceIds = [first.media.id, second.media.id, privatePhoto.media.id];
  const saved = await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/worlds?consent=1&provenance=imagined&expectedRevision=' + (await ctx.snap()).revision + '&sourceIds=' + encodeURIComponent(JSON.stringify(sourceIds)), data);
  const world = (await ctx.snap()).worlds.find(item => item.id === saved.id);
  const creditsURL = ctx.root + ctx.p + '/worlds/' + world.id + '/credits.json';
  async function denied(status, cookie = ctx.cookie) {
    const result = await fetch(creditsURL, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(result.status, status);
    await result.arrayBuffer();
  }
  await denied(404);
  await approve(ctx, world);
  const result = await fetch(creditsURL, { headers: { Cookie: ctx.cookie } });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-disposition'), /attachment; filename="everwhere-source-credits.json"/);
  const credits = await result.json();
  assert.equal(credits.version, 'everwhere-source-credits-1');
  assert.equal(credits.sources.length, 2);
  assert.deepEqual(credits.sources.find(source => source.sourceId === first.media.id), { sourceId: first.media.id, ...normalizeAttribution(credit) });
  assert.equal(credits.sources.find(source => source.sourceId === second.media.id).reportedDate, null);
  assert.equal(credits.sourcesWithoutPublicCredits, 1);
  assert.match(credits.distribution, /ShareAlike/);
  assert.match(credits.distribution, /not embedded/);
  assert.match(credits.interpretation, /not a measured reconstruction or a personal trip record/);
  assert.doesNotMatch(JSON.stringify(credits), /storage|capturedAt|gps|cookie|captureGrant|recollections/);
  await denied(401, '');
  await denied(404, await ctx.browser());
  await ctx.request(ctx.p + '/session', { lens: 'originals' });
  await denied(404);
  await ctx.request(ctx.p + '/session', { lens: 'all' });
  const scene = await fetch(ctx.root + ctx.p + '/worlds/' + world.id + '/scene.glb?download=1', { headers: { Cookie: ctx.cookie } });
  assert.deepEqual(Buffer.from(await scene.arrayBuffer()), assetBytes, 'Credits do not rewrite imported scene bytes');
  await ctx.request(ctx.p + '/capture/grants/' + second.capture.grantId + '/revoke', {});
  await denied(404);
  assert.ok(!(await ctx.snap()).media.some(source => source.id === second.media.id));
});
