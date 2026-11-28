import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../apps/api/server.mjs';

const recollection = 'I remember snow on the mountain and a red bench beside the path.';
const article = { pageid: 12345, title: 'Pragser Wildsee', extract: 'A lake in the Dolomites surrounded by mountain peaks.' };

async function setup(t, fetcher) {
  const calls = [];
  const contextFetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return fetcher ? fetcher(url, options) : Response.json({ query: { pages: { [article.pageid]: article } } });
  };
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-generation-'));
  const app = await createApp({ dataDir: dir, serveWeb: false, contextFetch });
  t.after(async () => {
    // Finished streamed responses can leave a keep-alive connection open during teardown.
    app.server.closeAllConnections();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const root = await app.listen({ port: 0, host: '127.0.0.1' });
  async function browser() {
    const response = await fetch(root + '/v1/bootstrap');
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const cookie = await browser();
  async function request(path, body, options = {}) {
    const multipart = body instanceof FormData;
    const response = await fetch(root + path, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Cookie: options.cookie ?? cookie, ...(body !== undefined && !multipart && { 'Content-Type': 'application/json' }), ...options.headers },
      body: multipart ? body : body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await response.json();
    const status = options.status ?? 200;
    assert.equal(response.status, status, `${path}: ${JSON.stringify(json)}`);
    return status >= 400 ? json : json.data;
  }
  const project = await request('/v1/projects', { title: 'Private generation test' }, { status: 201 });
  const p = '/v1/projects/' + project.id;
  const event = await request(p + '/memories', { title: 'Lago di Braies', placeLabel: 'South Tyrol, Italy', expectedRevision: 0 });
  const ctx = { dir, root, cookie, browser, request, project, p, event, calls, snap: () => request(p + '/snapshot') };
  ctx.evidence = () => request(p + '/memories/' + event.id + '/evidence');
  ctx.asset = (id, name, actorCookie = cookie) => fetch(root + p + '/worlds/' + id + '/' + name, { headers: { Cookie: actorCookie } });
  return ctx;
}

async function photograph(metadata = true, { date = '2024:10:12 10:00:00', offset = '+02:00', color = '#668866' } = {}) {
  let image = sharp({ create: { width: 48, height: 32, channels: 3, background: color } });
  if (metadata) image = image.withExif({
    IFD2: { DateTimeOriginal: date, ...(metadata !== 'local-time' && { OffsetTimeOriginal: offset }) },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '46/1 41/1 384/10', GPSLongitudeRef: 'E', GPSLongitude: '12/1 5/1 66/10' }
  });
  return image.jpeg().toBuffer();
}

async function upload(ctx, { metadata = true, keepLocation = true, photoOptions } = {}) {
  const capture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file', keepLocation });
  const bytes = await photograph(metadata, photoOptions);
  const form = new FormData();
  form.append('file', new File([bytes], 'Private lakeside photo.jpg', { type: 'image/jpeg' }));
  const result = await ctx.request(ctx.p + '/capture/sessions/' + capture.id + '/files', form);
  return { ...result, capture, bytes };
}

async function review(ctx, observationId, details = {}) {
  const preview = await ctx.request(ctx.p + '/capture/observations/' + observationId + '/preview', {
    eventId: ctx.event.id, expectedRevision: (await ctx.snap()).revision, ...details
  });
  return ctx.request(ctx.p + '/commands', { ...preview.command, requestId: randomUUID(), previewToken: preview.previewToken });
}

async function commit(ctx, type, payload, targetId = ctx.event.id) {
  const command = { type, targetId, payload, expectedRevision: (await ctx.snap()).revision };
  const preview = await ctx.request(ctx.p + '/previews', command);
  return ctx.request(ctx.p + '/commands', { ...command, requestId: randomUUID(), previewToken: preview.previewToken });
}

async function reviewedInput(ctx) {
  const source = await upload(ctx);
  await review(ctx, source.observationId);
  await commit(ctx, 'recollection.add', { text: recollection });
  return source;
}

async function capturedRecollection(ctx, text) {
  const capture = await ctx.request(ctx.p + '/capture/sessions', { source: 'voiceos_text', consent: true });
  const spoken = await ctx.request(ctx.p + '/capture/observations', {
    sessionId: capture.id, externalId: randomUUID(), source: 'voiceos_text', kind: 'recollection',
    capturedAt: null, location: null, text
  });
  await review(ctx, spoken.observationId);
  return capture;
}

async function preview(ctx) {
  const expectedRevision = (await ctx.snap()).revision;
  const result = await ctx.request(ctx.p + '/world-preview', { eventId: ctx.event.id, expectedRevision, environment: 'mountain', season: 'snow' });
  return { ...result, expectedRevision };
}

async function generate(ctx, proposal) {
  const input = { requestId: randomUUID(), previewToken: proposal.previewToken, expectedRevision: proposal.expectedRevision };
  return { input, job: await ctx.request(ctx.p + '/world-jobs', input) };
}

async function approve(ctx, id) {
  const world = (await ctx.snap()).worlds.find(item => item.id === id);
  assert.ok(world, 'The generated result is visible for review');
  await commit(ctx, 'artifact.approve', { artifactId: id, dependencyHash: world.inputHash });
  await ctx.request(ctx.p + '/session', { lens: 'all' });
}

test('snow changes the suggested season without replacing street or coast surroundings', async t => {
  for (const [placeLabel, story, environment] of [
    ['Toronto, Canada', 'Snow settled on the city street.', 'urban'],
    ['A rocky coast', 'Snow covered the beach beside the ocean.', 'coast']
  ]) {
    const ctx = await setup(t);
    await commit(ctx, 'event.correct', { patch: { title: 'A winter visit', placeLabel, story } });
    const evidence = await ctx.evidence();
    assert.equal(evidence.suggestion.environment, environment);
    assert.equal(evidence.suggestion.season, 'snow');
    assert.equal(ctx.calls.length, 0);
  }
});

async function unavailable(ctx, id, cookie = ctx.cookie) {
  for (const asset of ['scene.glb', 'plan.json']) {
    const response = await ctx.asset(id, asset, cookie);
    assert.equal(response.status, 404, `${asset} must not be delivered`);
    await response.arrayBuffer();
  }
}

function storedState(ctx) {
  const database = new DatabaseSync(join(ctx.dir, 'everwhere.sqlite'), { readOnly: true });
  try { return JSON.parse(database.prepare('SELECT state FROM projects WHERE id = ?').get(ctx.project.id).state); }
  finally { database.close(); }
}

function assertCoarseLocations(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['gps', 'coordinates'].includes(key) && Array.isArray(item)) {
      for (const coordinate of item) assert.equal(coordinate, Number(coordinate.toFixed(2)), `${key} must contain only coarse coordinates`);
    } else assertCoarseLocations(item);
  }
}

test('reviewed originals, EXIF and recollection reach an explicitly imagined approved GLB with cited place context', async t => {
  const ctx = await setup(t);
  const source = await reviewedInput(ctx);
  const evidence = await ctx.evidence();
  assert.equal(evidence.media.length, 1);
  assert.equal(evidence.media[0].id, source.media.id);
  assert.equal(evidence.media[0].provenance, 'original');
  assert.equal(evidence.media[0].capturedAt, '2024-10-12T10:00:00+02:00');
  assert.ok(Math.abs(evidence.media[0].gps[0] - 46.694) < 0.000001);
  assert.ok(Math.abs(evidence.media[0].gps[1] - 12.0851666667) < 0.000001);
  assert.equal(evidence.recollections[0].text, recollection);
  assert.equal(evidence.research, null);
  assert.equal(ctx.calls.length, 0, 'Reading evidence must not transmit it externally');

  const lookup = ctx.p + '/memories/' + ctx.event.id + '/place-context';
  const revision = (await ctx.snap()).revision;
  await ctx.request(lookup, { expectedRevision: revision, consent: false }, { status: 400 });
  assert.equal(ctx.calls.length, 0, 'A rejected consent must never start a lookup');
  await ctx.request(lookup, { expectedRevision: revision, consent: true });
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url.origin, 'https://en.wikipedia.org');
  assert.equal(ctx.calls[0].url.searchParams.get('ggscoord'), '46.69|12.09', 'Only coarse location is transmitted');
  assert.equal(ctx.calls[0].url.href.includes('Private lakeside photo'), false);
  assert.equal(ctx.calls[0].url.href.includes('red bench'), false, 'Personal recollection stays out of the lookup');
  assert.equal(ctx.calls[0].options.body, undefined);
  const researched = await ctx.evidence();
  assert.equal(researched.research.articles[0].extract, article.extract);
  assert.equal(researched.research.articles[0].url, 'https://en.wikipedia.org/?curid=12345');
  assert.equal(researched.research.articles[0].provenance, 'web_context');
  assert.match(researched.unknowns.join(' '), /does not prove what happened/);

  const proposal = await preview(ctx);
  assert.equal(proposal.plan.provenance, 'imagined');
  assert.equal(proposal.plan.environment, 'mountain');
  assert.equal(proposal.plan.season, 'snow');
  assert.deepEqual(proposal.plan.sourceIds, [source.media.id]);
  assert.equal(proposal.plan.scaleConfidence, null);
  assert.match(JSON.stringify(proposal.diff), /procedural|imagined/i);
  assert.equal((await ctx.snap()).worlds.length, 0, 'Preview must not generate or approve an artifact');
  const { job } = await generate(ctx, proposal);
  assert.equal(job.status, 'ready');
  const beforeApproval = (await ctx.snap()).worlds.find(item => item.id === job.id);
  assert.equal(beforeApproval.approved, false);
  assert.equal(beforeApproval.provenance, 'imagined');
  await ctx.request(ctx.p + '/session', { lens: 'all' });
  await unavailable(ctx, job.id);
  await approve(ctx, job.id);

  const response = await ctx.asset(job.id, 'scene.glb');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /model\/gltf-binary/);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  assert.ok(gltf.meshes.length > 0, 'The deliverable contains real mesh geometry');
  const planResponse = await ctx.asset(job.id, 'plan.json');
  assert.equal(planResponse.status, 200);
  const exported = await planResponse.json();
  assert.equal(exported.version, 'everwhere-generation-1');
  assert.equal(exported.context.projectId, ctx.project.id);
  assert.equal(exported.context.eventId, ctx.event.id);
  assert.deepEqual(exported.context.sourceIds, [source.media.id]);
  assert.equal(exported.sceneManifest.format, 'glb');
  assert.equal(exported.sceneManifest.units, 'm');
  assert.equal(exported.sceneManifest.coordinateSystem, 'right-handed-y-up');
  assert.equal(exported.sceneManifest.provenance, 'imagined');
  assert.equal(exported.sceneManifest.scaleConfidence, null);
  const plan = exported.plan;
  assert.equal(plan.eventId, ctx.event.id);
  assert.equal(plan.provenance, 'imagined');
  assert.deepEqual(plan.sourceIds, [source.media.id]);
  assert.equal(Object.hasOwn(plan, 'evidence'), false, 'The handoff must not include private evidence');
  assert.equal(plan.evidenceSummary.mediaCount, 1);
  assert.equal(plan.evidenceSummary.recollectionCount, 1);
  assert.equal(plan.evidenceSummary.sources[0].url, 'https://en.wikipedia.org/?curid=12345');
  assert.equal(plan.evidenceSummary.sources[0].provenance, 'web_context');
  assert.equal(JSON.stringify(exported).includes(recollection), false);
  assert.equal(JSON.stringify(exported).includes('46.694'), false);
  assert.equal(JSON.stringify(exported).includes('12.085166'), false);

  const original = await fetch(ctx.root + ctx.p + '/sources/' + source.media.id, { headers: { Cookie: ctx.cookie } });
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), source.bytes, 'Generation must preserve the original bytes');
  await ctx.request(ctx.p + '/session', { lens: 'originals' });
  await unavailable(ctx, job.id);
  await ctx.request(ctx.p + '/session', { lens: 'all' });
  await unavailable(ctx, job.id, await ctx.browser());
  assert.equal((await ctx.asset(job.id, 'scene.glb', '')).status, 401);
});

test('pending sources and recollections are excluded, and missing capture metadata stays unknown', async t => {
  const ctx = await setup(t);
  const source = await upload(ctx, { metadata: false });
  const capture = await ctx.request(ctx.p + '/capture/sessions', { source: 'voiceos_text', consent: true });
  const spoken = await ctx.request(ctx.p + '/capture/observations', {
    sessionId: capture.id, externalId: randomUUID(), source: 'voiceos_text', kind: 'recollection',
    capturedAt: null, location: null, text: recollection
  });
  const before = await ctx.evidence();
  assert.deepEqual(before.media, []);
  assert.deepEqual(before.recollections, []);
  const rejected = await ctx.request(ctx.p + '/world-preview', {
    eventId: ctx.event.id, expectedRevision: (await ctx.snap()).revision, environment: 'mountain', season: 'snow'
  }, { status: 400 });
  assert.equal(rejected.code, 'ORIGINAL_REQUIRED');
  assert.equal((await ctx.snap()).worlds.length, 0);
  await review(ctx, source.observationId);
  await review(ctx, spoken.observationId);
  const after = await ctx.evidence();
  assert.equal(after.media[0].capturedAt, null);
  assert.equal(after.media[0].gps, null);
  assert.equal(after.recollections[0].text, recollection);
  assert.match(after.unknowns.join(' '), /timezone/);
  assert.match(after.unknowns.join(' '), /No coordinates/);
  assert.equal(ctx.calls.length, 0);
});

test('without GPS Wikipedia receives only the named place, never a personal memory title', async t => {
  const ctx = await setup(t);
  const source = await upload(ctx, { metadata: false });
  await review(ctx, source.observationId);
  const privateTitle = "Sam's private birthday surprise";
  const placeLabel = 'South Tyrol, Italy';
  await commit(ctx, 'event.correct', { patch: { title: privateTitle, placeLabel } });
  await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/place-context', { expectedRevision: (await ctx.snap()).revision, consent: true });
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].url.searchParams.get('gsrsearch'), placeLabel);
  assert.equal(ctx.calls[0].url.searchParams.has('ggscoord'), false);
  assert.equal(decodeURIComponent(ctx.calls[0].url.href).includes(privateTitle), false);
  await commit(ctx, 'event.correct', { patch: { placeLabel: 'Unknown location' } });
  const unavailable = await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/place-context', {
    expectedRevision: (await ctx.snap()).revision, consent: true
  }, { status: 400 });
  assert.equal(unavailable.code, 'LOCATION_REQUIRED');
  assert.equal(ctx.calls.length, 1, 'A private title must not substitute for a missing place');
});

test('world photo stops follow capture instants, with unknown or timezone-less captures last', async t => {
  const ctx = await setup(t);
  const fixtures = [
    { key: 'unknown', metadata: false, photoOptions: { color: '#aa3333' } },
    { key: 'late', photoOptions: { date: '2024:10:12 12:00:00', offset: '+02:00' } },
    { key: 'early', photoOptions: { date: '2024:10:12 10:00:00', offset: '+03:00' } },
    { key: 'middle', photoOptions: { date: '2024:10:12 09:30:00', offset: '+00:00' } },
    { key: 'local-only', metadata: 'local-time', photoOptions: { date: '2024:10:11 06:00:00' } }
  ];
  const ids = {};
  for (const fixture of fixtures) {
    const source = await upload(ctx, fixture);
    assert.equal(source.duplicate, false);
    await review(ctx, source.observationId);
    ids[fixture.key] = source.media.id;
  }
  const proposal = await preview(ctx);
  assert.deepEqual(proposal.plan.sourceIds.slice(0, 3), [ids.early, ids.middle, ids.late]);
  assert.deepEqual(new Set(proposal.plan.sourceIds.slice(3)), new Set([ids.unknown, ids['local-only']]));
});

test('another browser cannot read evidence, research a place, preview or confirm a private world', async t => {
  const ctx = await setup(t);
  await reviewedInput(ctx);
  const proposal = await preview(ctx);
  const cookie = await ctx.browser();
  await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/evidence', undefined, { cookie, status: 404 });
  await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/place-context', { expectedRevision: proposal.expectedRevision, consent: true }, { cookie, status: 404 });
  await ctx.request(ctx.p + '/world-preview', { eventId: ctx.event.id, expectedRevision: proposal.expectedRevision, environment: 'mountain', season: 'snow' }, { cookie, status: 404 });
  await ctx.request(ctx.p + '/world-jobs', { requestId: randomUUID(), previewToken: proposal.previewToken, expectedRevision: proposal.expectedRevision }, { cookie, status: 404 });
  assert.equal(ctx.calls.length, 0);
  assert.equal((await ctx.snap()).worlds.length, 0);
});

test('an EXIF local timestamp without an offset is preserved without inventing UTC, and GPS requires retention consent', async t => {
  const ctx = await setup(t);
  const source = await upload(ctx, { metadata: 'local-time', keepLocation: false });
  await review(ctx, source.observationId);
  const evidence = await ctx.evidence();
  assert.equal(evidence.media[0].capturedAt, null);
  assert.equal(evidence.media[0].capturedLocal, '2024-10-12T10:00:00');
  assert.equal(evidence.media[0].gps, null);
  assert.match(evidence.unknowns.join(' '), /timezone/);
  assert.equal(evidence.lookup.coordinates, null);
});

test('video ISO6709 coordinates enter reviewed evidence only when location retention is authorized', async t => {
  for (const tag of ['location', 'com.apple.quicktime.location.ISO6709']) {
    for (const keepLocation of [false, true]) await t.test(`${tag}, retention ${keepLocation}`, async t => {
      const ctx = await setup(t);
      const file = join(ctx.dir, 'location-fixture.mp4');
      execFileSync(process.env.FFMPEG || 'ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=12',
        '-t', '0.25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(tag === 'location' ? ['-metadata', 'creation_time=2024-10-12T08:00:00Z'] : []),
        '-metadata', tag + '=+46.6940+012.0852+0150.0/', ...(tag.startsWith('com.apple') ? ['-movflags', 'use_metadata_tags'] : []), file], { timeout: 10000 });
      const capture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file', keepLocation });
      const bytes = await readFile(file);
      const form = new FormData();
      form.append('file', new File([bytes], 'Lakeside clip.mp4', { type: 'video/mp4' }));
      const source = await ctx.request(ctx.p + '/capture/sessions/' + capture.id + '/files', form);
      assert.equal(source.media.mime, 'video/mp4');
      if (tag === 'location') assert.equal(Date.parse(source.media.capturedAt), Date.parse('2024-10-12T08:00:00Z'));
      else assert.equal(source.media.capturedAt, null);
      assert.deepEqual(source.media.gps, keepLocation ? [46.694, 12.0852] : null);
      assert.deepEqual((await ctx.evidence()).media, [], 'Metadata from an unreviewed clip is not yet scene evidence');
      await review(ctx, source.observationId);
      const evidence = await ctx.evidence();
      assert.deepEqual(evidence.media[0].gps, keepLocation ? [46.694, 12.0852] : null);
      assert.deepEqual(evidence.lookup.coordinates, keepLocation ? [46.69, 12.09] : null);
      assert.equal(ctx.calls.length, 0, 'Importing location metadata does not authorize an external lookup');
      const original = await fetch(ctx.root + ctx.p + '/sources/' + source.media.id, { headers: { Cookie: ctx.cookie } });
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    });
  }
});

test('memory GPS corrections validate coordinate ranges, invalidate the old world and can be cleared through the voice command path', async t => {
  const ctx = await setup(t);
  const source = await upload(ctx, { metadata: false });
  await review(ctx, source.observationId);
  const { job } = await generate(ctx, await preview(ctx));
  await approve(ctx, job.id);
  const { token } = await ctx.request(ctx.p + '/pairing', { confirm: true });
  const headers = { Authorization: 'Bearer ' + token };
  const revision = (await ctx.snap()).revision;
  for (const gps of [[90.01, 0], [-90.01, 0], [0, 180.01], [0, -180.01], [46], ['46', 12]]) {
    await ctx.request(ctx.p + '/previews', { type: 'event.correct', targetId: ctx.event.id, expectedRevision: revision, payload: { patch: { gps } } }, { status: 400 });
    await ctx.request(ctx.p + '/voice/preview_correction', { eventId: ctx.event.id, expectedRevision: revision, patch: { gps } }, { headers, status: 400 });
  }
  assert.equal((await ctx.snap()).revision, revision);
  assert.equal((await ctx.evidence()).gps, null);
  assert.equal((await ctx.snap()).worlds.find(item => item.id === job.id).approved, true, 'Invalid corrections cannot invalidate an approved scene');
  await commit(ctx, 'event.correct', { patch: { gps: [46.694, 12.0852] } });
  assert.deepEqual((await ctx.evidence()).gps, [46.694, 12.0852]);
  assert.deepEqual((await ctx.evidence()).lookup.coordinates, [46.69, 12.09]);
  await unavailable(ctx, job.id);
  await commit(ctx, 'event.correct', { patch: { gps: [-90, 180] } });
  assert.deepEqual((await ctx.evidence()).gps, [-90, 180], 'Coordinate boundary values are valid');
  const expectedRevision = (await ctx.snap()).revision;
  const clear = await ctx.request(ctx.p + '/voice/preview_correction', { eventId: ctx.event.id, expectedRevision, patch: { gps: null } }, { headers });
  assert.deepEqual((await ctx.evidence()).gps, [-90, 180], 'Previewing a GPS clear does not mutate evidence');
  await ctx.request(ctx.p + '/voice/confirm_change', { expectedRevision, requestId: randomUUID(), previewToken: clear.previewToken }, { headers });
  const cleared = await ctx.evidence();
  assert.equal(cleared.gps, null);
  assert.equal(cleared.lookup.coordinates, null);
  assert.match(cleared.unknowns.join(' '), /No coordinates/);
});

test('an in-flight place lookup cannot persist context after its evidence or revision changes', async t => {
  for (const change of ['source revocation', 'place correction']) await t.test(change, async t => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const ctx = await setup(t, async () => {
      started.resolve();
      await release.promise;
      return Response.json({ query: { pages: { [article.pageid]: article } } });
    });
    const source = await reviewedInput(ctx);
    const lookup = ctx.request(ctx.p + '/memories/' + ctx.event.id + '/place-context', {
      expectedRevision: (await ctx.snap()).revision, consent: true
    }, { status: 409 });
    const guard = setTimeout(() => started.reject(new Error('Place lookup did not start')), 3000);
    try {
      await started.promise;
      if (change === 'source revocation') {
        await ctx.request(ctx.p + '/capture/grants/' + source.capture.grantId + '/revoke', {});
      } else {
        await commit(ctx, 'event.correct', { patch: { placeLabel: 'Another lake' } });
      }
    } finally {
      clearTimeout(guard);
      release.resolve();
    }
    assert.equal((await lookup).code, 'REVISION_CONFLICT');
    assert.equal((await ctx.evidence()).research, null);
    const database = new DatabaseSync(join(ctx.dir, 'everwhere.sqlite'), { readOnly: true });
    try {
      const state = JSON.parse(database.prepare('SELECT state FROM projects WHERE id = ?').get(ctx.project.id).state);
      assert.equal(state.locationResearch?.[ctx.event.id], undefined, 'A late response cannot repopulate retired research');
    } finally { database.close(); }
    assert.equal(ctx.calls.length, 1);
  });
});

test('stale revisions and expired world previews cannot generate an artifact', async t => {
  const ctx = await setup(t);
  await reviewedInput(ctx);
  const old = await preview(ctx);
  await commit(ctx, 'event.correct', { patch: { story: 'The path was beside a different shore.' } });
  const rejected = await ctx.request(ctx.p + '/world-jobs', {
    requestId: randomUUID(), previewToken: old.previewToken, expectedRevision: old.expectedRevision
  }, { status: 409 });
  assert.ok(['REVISION_CONFLICT', 'PREVIEW_EXPIRED'].includes(rejected.code), 'Changed evidence may retire the old preview entirely');
  await ctx.request(ctx.p + '/world-preview', { eventId: ctx.event.id, expectedRevision: old.expectedRevision, environment: 'mountain', season: 'snow' }, { status: 409 });
  const fresh = await preview(ctx);
  const clock = t.mock.method(Date, 'now', () => Date.parse(fresh.expires) + 1);
  try {
    const expired = await ctx.request(ctx.p + '/world-jobs', {
      requestId: randomUUID(), previewToken: fresh.previewToken, expectedRevision: fresh.expectedRevision
    }, { status: 409 });
    assert.equal(expired.code, 'PREVIEW_EXPIRED');
  } finally { clock.mock.restore(); }
  assert.equal((await ctx.snap()).worlds.length, 0);
});

test('generation confirmation is idempotent and cannot reuse a request ID for another preview', async t => {
  const ctx = await setup(t);
  await reviewedInput(ctx);
  const proposal = await preview(ctx);
  const { input, job } = await generate(ctx, proposal);
  const revision = (await ctx.snap()).revision;
  assert.deepEqual(await ctx.request(ctx.p + '/world-jobs', input), job);
  assert.equal((await ctx.snap()).revision, revision);
  assert.equal((await ctx.snap()).worlds.length, 1);
  const other = await preview(ctx);
  const reused = await ctx.request(ctx.p + '/world-jobs', { ...input, previewToken: other.previewToken }, { status: 409 });
  assert.equal(reused.code, 'REQUEST_ID_REUSED');
  await ctx.request(ctx.p + '/world-jobs', { ...input, requestId: randomUUID(), expectedRevision: revision }, { status: 409 });
  assert.equal((await ctx.snap()).worlds.length, 1, 'A consumed preview must not create a second world');
});

test('a new recollection preserves an approved world built from previously reviewed evidence', async t => {
  const ctx = await setup(t);
  await reviewedInput(ctx);
  const { job } = await generate(ctx, await preview(ctx));
  await approve(ctx, job.id);
  await commit(ctx, 'recollection.add', { text: 'We also stopped for coffee afterwards.' });
  const world = (await ctx.snap()).worlds.find(item => item.id === job.id);
  assert.equal(world.approved, true);
  assert.equal(world.status, 'ready');
  const scene = await ctx.asset(job.id, 'scene.glb');
  assert.equal(scene.status, 200);
  await scene.arrayBuffer();
  const exported = await (await ctx.asset(job.id, 'plan.json')).json();
  assert.equal(exported.plan.evidenceSummary.recollectionCount, 1, 'The historical plan must not silently absorb later accounts');
  assert.equal(Object.hasOwn(exported.plan, 'evidence'), false);
});

test('correcting a place or revoking a used source blocks both old scene and plan delivery', async t => {
  for (const change of ['place correction', 'source revocation']) await t.test(change, async t => {
    const ctx = await setup(t);
    const source = await reviewedInput(ctx);
    await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/place-context', { expectedRevision: (await ctx.snap()).revision, consent: true });
    const { job } = await generate(ctx, await preview(ctx));
    await approve(ctx, job.id);
    const available = await ctx.asset(job.id, 'scene.glb');
    assert.equal(available.status, 200);
    await available.arrayBuffer();
    if (change === 'place correction') {
      await commit(ctx, 'event.correct', { patch: { placeLabel: 'A different mountain lake' } });
    } else {
      await ctx.request(ctx.p + '/capture/grants/' + source.capture.grantId + '/revoke', {});
    }
    await unavailable(ctx, job.id);
    assert.equal((await ctx.evidence()).research, null, 'Stale external context is no longer current evidence');
    const old = (await ctx.snap()).worlds.find(item => item.id === job.id);
    assert.ok(!old || !old.approved, 'An evidence change invalidates prior artifact approval');
    if (change === 'source revocation') {
      assert.deepEqual((await ctx.evidence()).media, []);
      const original = await fetch(ctx.root + ctx.p + '/sources/' + source.media.id, { headers: { Cookie: ctx.cookie } });
      assert.equal(original.status, 404);
    }
  });
});

test('revoking a used text capture invalidates its world and removes cached copies of the withdrawn text', async t => {
  const ctx = await setup(t);
  const source = await upload(ctx);
  await review(ctx, source.observationId);
  const withdrawnText = 'Private recollection to withdraw: the yellow canoe was by the northern gate.';
  const capture = await capturedRecollection(ctx, withdrawnText);
  const { job, input } = await generate(ctx, await preview(ctx));
  await approve(ctx, job.id);
  await preview(ctx); // An outstanding preview also holds the account before revocation.
  await ctx.request(ctx.p + '/capture/grants/' + capture.grantId + '/revoke', {});
  await unavailable(ctx, job.id);
  assert.deepEqual((await ctx.evidence()).recollections, []);
  await ctx.request(ctx.p + '/world-jobs', input, { status: 409 });
  assert.equal(JSON.stringify(storedState(ctx)).includes(withdrawnText), false, 'Withdrawn text must be absent from the entire persisted project');
});

test('revoking a reused audio capture scrubs every derived recollection and unconfirmed preview from persisted state', async t => {
  const ctx = await setup(t);
  const photo = await upload(ctx);
  await review(ctx, photo.observationId);
  const audioFile = join(ctx.dir, 'synthetic-account.webm');
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
    '-c:a', 'libopus', audioFile], { timeout: 10000 });
  const capture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'browser_audio' });
  const form = new FormData();
  form.append('file', new File([await readFile(audioFile)], 'Synthetic account.webm', { type: 'audio/webm' }));
  const audio = await ctx.request(ctx.p + '/capture/sessions/' + capture.id + '/files', form);
  const accounts = ['Withdrawn initial audio account: the purple boat.', 'Withdrawn reused audio account: the silver lantern.', 'Withdrawn unconfirmed audio account: the orange bridge.'];
  await review(ctx, audio.observationId, { text: accounts[0] });
  await commit(ctx, 'recollection.add', { text: accounts[1], audioMediaId: audio.media.id });
  const { job } = await generate(ctx, await preview(ctx));
  await approve(ctx, job.id);
  await ctx.request(ctx.p + '/previews', {
    type: 'recollection.add', targetId: ctx.event.id, expectedRevision: (await ctx.snap()).revision,
    payload: { text: accounts[2], audioMediaId: audio.media.id }
  });
  const before = JSON.stringify(storedState(ctx));
  for (const text of accounts) assert.ok(before.includes(text), 'The fixture must exercise each retained copy before revocation');
  await ctx.request(ctx.p + '/capture/grants/' + capture.grantId + '/revoke', {});
  await unavailable(ctx, job.id);
  assert.deepEqual((await ctx.evidence()).recollections, []);
  const after = JSON.stringify(storedState(ctx));
  for (const text of accounts) assert.equal(after.includes(text), false, `Revocation retained a derived account: ${text}`);
});

test('network failures report unavailable context without inventing research or preventing an own-evidence preview', async t => {
  for (const failure of ['network rejection', 'HTTP failure']) await t.test(failure, async t => {
    const ctx = await setup(t, async () => {
      if (failure === 'network rejection') throw new Error('Simulated offline connection');
      return new Response('Upstream unavailable', { status: 503 });
    });
    await reviewedInput(ctx);
    const revision = (await ctx.snap()).revision;
    const result = await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/place-context', { expectedRevision: revision, consent: true }, { status: 502 });
    assert.equal(result.code, 'CONTEXT_UNAVAILABLE');
    assert.match(result.message, /unavailable/i);
    assert.equal((await ctx.snap()).revision, revision);
    const evidence = await ctx.evidence();
    assert.equal(evidence.research, null);
    assert.equal(evidence.recollections[0].text, recollection);
    const proposal = await preview(ctx);
    assert.equal(proposal.plan.evidence.research, null);
    assert.equal(proposal.plan.provenance, 'imagined');
    assert.equal(ctx.calls.length, 1, 'Evidence and preview do not silently retry external transmission');
    assert.equal((await ctx.snap()).worlds.length, 0);
  });
});

test('paired MCP tools use the same evidence, consent and world confirmation path', async t => {
  const ctx = await setup(t);
  await reviewedInput(ctx);
  const exactLocation = [45.1234567, -73.9876543];
  await commit(ctx, 'event.correct', { patch: { gps: exactLocation } });
  const { token } = await ctx.request(ctx.p + '/pairing', { confirm: true });
  const client = new Client({ name: 'everwhere-generation-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../apps/mcp/index.mjs', import.meta.url))],
    env: { EVERWHERE_API: ctx.root, EVERWHERE_PROJECT: ctx.project.id, EVERWHERE_PAIRING_TOKEN: token } });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(item => item.name);
    for (const name of ['get_scene_evidence', 'research_place', 'preview_memory_world', 'confirm_change']) assert.ok(tools.includes(name), name);
    async function voice(name, args = {}, expectsError = false) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, expectsError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    }
    const evidence = (await voice('get_scene_evidence')).data;
    assert.equal(evidence.eventId, ctx.event.id, 'Omitted eventId uses the paired browser selection');
    assert.equal(evidence.recollections[0].text, recollection);
    assertCoarseLocations(evidence);
    assert.equal(JSON.stringify(evidence).includes('45.1234567'), false);
    assert.equal(JSON.stringify(evidence).includes('-73.9876543'), false);
    assert.equal(JSON.stringify(evidence).includes('46.694'), false);
    assert.deepEqual((await ctx.evidence()).gps, exactLocation, 'Private browser evidence retains the original location');
    const expectedRevision = (await ctx.snap()).revision;
    await voice('research_place', { expectedRevision, consent: false }, true);
    assert.equal(ctx.calls.length, 0);
    await voice('research_place', { expectedRevision, consent: true });
    assert.equal(ctx.calls.length, 1);
    const proposal = (await voice('preview_memory_world', {
      eventId: ctx.event.id, expectedRevision: (await ctx.snap()).revision, environment: 'mountain', season: 'snow'
    })).data;
    assert.equal(proposal.plan.provenance, 'imagined');
    assert.equal(Object.hasOwn(proposal.plan, 'evidence'), false, 'The voice preview omits the private evidence packet');
    assert.equal(proposal.plan.evidenceSummary.mediaCount, 1);
    assert.equal(proposal.plan.evidenceSummary.recollectionCount, 1);
    assertCoarseLocations(proposal);
    assert.equal(JSON.stringify(proposal).includes(recollection), false);
    assert.equal(JSON.stringify(proposal).includes('45.1234567'), false);
    assert.equal(JSON.stringify(proposal).includes('46.694'), false);
    assert.equal((await ctx.snap()).worlds.length, 0);
    const confirmation = { requestId: randomUUID(), previewToken: proposal.previewToken, expectedRevision: (await ctx.snap()).revision };
    const job = (await voice('confirm_change', confirmation)).data;
    assert.equal(job.status, 'ready');
    assert.equal((await ctx.snap()).worlds.find(item => item.id === job.id).approved, false);
    assert.deepEqual((await voice('confirm_change', confirmation)).data, job);
    await unavailable(ctx, job.id);
    await ctx.request(ctx.p + '/pairing', undefined, { method: 'DELETE' });
    assert.equal((await voice('get_scene_evidence', {}, true)).code, 'TOKEN_EXPIRED');
  } finally { await client.close(); }
});
