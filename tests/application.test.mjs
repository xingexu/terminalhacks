import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../apps/api/server.mjs';
import { integrationManifest } from '../apps/mcp/manifest.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../apps/api/store.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-test-'));
  const app = await createApp({ dataDir: dir, serveWeb: false });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const root = await app.listen({ port: 0, host: '127.0.0.1' });
  async function browser() {
    const boot = await fetch(root + '/v1/bootstrap');
    const cookie = boot.headers.get('set-cookie').split(';')[0];
    const { data: [demo] } = await boot.json();
    return { cookie, demo };
  }
  const first = await browser();
  const p = '/v1/projects/' + first.demo.id;
  async function request(path, body, { cookie = first.cookie, method = body === undefined ? 'GET' : 'POST', status = 200, headers = {} } = {}) {
    const multipart = body instanceof FormData;
    const reply = await fetch(root + path, {
      method, headers: { ...(cookie && { Cookie: cookie }), ...(body !== undefined && !multipart && { 'Content-Type': 'application/json' }), ...headers },
      body: multipart ? body : body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await reply.json();
    assert.equal(reply.status, status, JSON.stringify(json));
    return status >= 400 ? json : json.data;
  }
  return { dir, root, ...first, p, browser, request, snap: () => request(p + '/snapshot') };
}

async function makeImage(color = '#557764') {
  return sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).jpeg().toBuffer();
}

function asUpload(bytes, name, mime = 'application/octet-stream') {
  const result = new FormData();
  result.append('file', new File([bytes], name, { type: mime }));
  return result;
}

async function propose(ctx, type, targetId, payload) {
  const body = { expectedRevision: (await ctx.snap()).revision, type, targetId, payload };
  const result = await ctx.request(ctx.p + '/previews', body);
  return { ...body, previewToken: result.previewToken, requestId: randomUUID() };
}

async function waitForJob(ctx, id) {
  const start = performance.now();
  while (performance.now() - start < 42000) {
    const job = await ctx.request(ctx.p + '/jobs/' + id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(120);
  }
  assert.fail('Film did not reach a final status');
}

test('private capture is reviewed, deduplicated, isolated and revocable with immutable original bytes', async t => {
  const ctx = await setup(t);
  const { p, request, root, cookie, snap } = ctx;
  const other = await ctx.browser();
  await request(p + '/snapshot', undefined, { cookie: other.cookie, status: 404 });
  await request(p + '/capture/inbox', undefined, { cookie: '', status: 401 });
  await request(p + '/capture/sessions', { consent: false, source: 'selected_file' }, { status: 400 });
  const session = await request(p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const path = p + '/capture/sessions/' + session.id + '/files';
  const image = await makeImage();
  const input = () => asUpload(image, 'Harbor morning.jpg', 'image/jpeg');
  const upload = await request(path, input(), { headers: { 'X-Capture-Id': 'repeatable-source' } });
  assert.equal(upload.media.capturedAt, null);
  assert.equal(upload.media.gps, null);
  assert.equal(upload.duplicate, false);
  assert.equal((await request(path, input(), { headers: { 'X-Capture-Id': 'repeatable-source' } })).duplicate, true);
  await request(path, asUpload(await makeImage('#3399ff'), 'different.jpg'), { status: 409, headers: { 'X-Capture-Id': 'repeatable-source' } });
  await request(p + '/capture/sessions/' + session.id + '/stop', {});
  await request(path, input(), { status: 403 });
  const pending = await request(p + '/capture/inbox');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].candidates[0].id, 'e-lake');
  assert.equal((await request(p + '/search?q=harbor')).some(item => item.mediaId === upload.media.id), false);
  assert.equal((await snap()).media.some(item => item.id === upload.media.id), false);
  const unreviewed = await request(p + '/previews', { type: 'event.media.link', targetId: 'e-lake', expectedRevision: 0,
    payload: { mediaId: upload.media.id, relation: 'depicts' } }, { status: 409 });
  assert.equal(unreviewed.code, 'REVIEW_REQUIRED');
  const preview = await request(p + '/capture/observations/' + upload.observationId + '/preview', { eventId: 'e-lake', expectedRevision: 0 });
  assert.equal((await snap()).revision, 0);
  const command = { ...preview.command, requestId: randomUUID(), previewToken: preview.previewToken };
  assert.equal((await request(p + '/commands', command)).revision, 1);
  assert.equal((await request(p + '/commands', command)).revision, 1);
  assert.equal((await request(p + '/capture/inbox')).length, 0);
  assert.ok((await snap()).events[0].sourceIds.includes(upload.media.id));
  const sourcePath = p + '/sources/' + upload.media.id;
  assert.deepEqual(Buffer.from(await (await fetch(root + sourcePath, { headers: { Cookie: cookie } })).arrayBuffer()), image);
  assert.equal((await fetch(root + sourcePath, { headers: { Cookie: other.cookie } })).status, 404);
  const reopened = await createApp({ dataDir: ctx.dir, serveWeb: false });
  try {
    const recovered = await reopened.inject({ url: p + '/snapshot', headers: { Cookie: cookie } });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().data.revision, 1);
    assert.ok(recovered.json().data.events[0].sourceIds.includes(upload.media.id));
  } finally { await reopened.close(); }
  assert.equal((await request(p + '/capture/grants/' + session.grantId + '/revoke', {})).withdrawn, 1);
  await request(path, input(), { status: 403, headers: { 'X-Capture-Id': 'repeatable-source' } });
  assert.equal((await fetch(root + sourcePath, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await snap()).events[0].sourceIds.includes(upload.media.id), false);
  assert.equal((await snap()).undo, null);
});

test('sequential ingest of 40 images and three clips retains all known inputs and clearly groups duplicates', async t => {
  const ctx = await setup(t);
  const { p, request, dir } = ctx;
  const session = await request(p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const path = p + '/capture/sessions/' + session.id + '/files';
  const wall = performance.now();
  let first;
  for (let i = 0; i < 40; i++) {
    const bytes = await makeImage({ r: i * 6, g: 90, b: 38 + i * 3 });
    if (i === 0) first = bytes;
    const result = await request(path, asUpload(bytes, 'Photo ' + i + '.jpg'));
    assert.equal(result.duplicate, false);
    assert.equal(result.media.capturedAt, null);
  }
  for (const [index, color] of ['red', 'green', 'blue'].entries()) {
    const file = join(dir, 'clip-' + index + '.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=64x48:r=12',
      '-t', '0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { timeout: 10000 });
    const result = await request(path, asUpload(await readFile(file), 'Clip ' + index + '.mp4'));
    assert.equal(result.media.mime, 'video/mp4');
    assert.equal(result.media.capturedAt, null);
  }
  assert.equal((await request(path, asUpload(first, 'Duplicate.jpg'))).duplicate, true);
  assert.equal((await request(p + '/capture/inbox')).length, 43);
  t.diagnostic('43 fixture inputs plus one duplicate: ' + Math.round(performance.now() - wall) + ' ms');
});

test('revision conflicts, exact replay, independent story accounts, undo, and durable context', async t => {
  const ctx = await setup(t);
  const { p, request, snap } = ctx;
  const original = (await snap()).media;
  const [left, right] = await Promise.all([
    propose(ctx, 'event.correct', 'e-lake', { patch: { placeLabel: 'A lakeside pier' } }),
    propose(ctx, 'event.correct', 'e-lake', { patch: { placeLabel: 'Another pier' } })
  ]);
  const committed = await request(p + '/commands', left);
  assert.equal(committed.revision, 1);
  assert.deepEqual(await request(p + '/commands', left), committed);
  assert.equal((await request(p + '/commands', { ...left, payload: right.payload }, { status: 409 })).code, 'REQUEST_ID_REUSED');
  assert.equal((await request(p + '/commands', right, { status: 409 })).code, 'REVISION_CONFLICT');
  await request(p + '/commands', await propose(ctx, 'recollection.add', 'e-lake', { text: 'It was sunny.', anchorId: 'a-lake' }));
  await request(p + '/commands', await propose(ctx, 'recollection.add', 'e-lake', { text: 'I remember clouds.', anchorId: 'a-lake' }));
  assert.deepEqual((await snap()).recollections.map(item => item.text), ['It was sunny.', 'I remember clouds.']);
  for (const view of ['explore', 'watch', 'create', 'remember', 'archive']) {
    await request(p + '/session', { view, eventId: 'e-lake' });
    const fresh = await snap();
    assert.equal(fresh.session.eventId, 'e-lake');
    assert.equal(fresh.session.view, view);
    assert.equal(fresh.events[0].placeLabel, 'A lakeside pier');
  }
  assert.deepEqual((await snap()).media, original);
  await request(p + '/commands', await propose(ctx, 'undo', 'e-lake', { revisionToUndo: 3 }));
  assert.equal((await snap()).recollections.length, 1);
  assert.equal((await snap()).revision, 4);
});

test('MCP stdio uses the real API, applies a correction and recollection, and pushes an SSE update', async t => {
  const ctx = await setup(t);
  const { p, request, root, cookie, demo, snap } = ctx;
  const { token } = await request(p + '/pairing', { confirm: true });
  assert.deepEqual(await request(p + '/pairing'), { active: true, expires: (await request(p + '/pairing')).expires, lastSeen: null });
  const stranger = await ctx.browser();
  await request(p + '/pairing', undefined, { cookie: stranger.cookie, status: 404 });
  const manifestResponse = await fetch(root + p + '/pairing/manifest?origin=' + encodeURIComponent(root), { headers: { Cookie: cookie } });
  assert.match(manifestResponse.headers.get('content-disposition'), /attachment/);
  const manifest = await manifestResponse.json();
  assert.deepEqual(manifest, integrationManifest(root));
  assert.equal(JSON.stringify(manifest).includes(token), false);
  await request(p + '/pairing/manifest?origin=http://untrusted.example', undefined, { status: 400 });
  const defaultManifest = JSON.parse(await readFile(new URL('../voiceos.integration.json', import.meta.url)));
  assert.deepEqual(defaultManifest, integrationManifest());
  assert.deepEqual(defaultManifest.permissions[0].domains, ['127.0.0.1', 'localhost', '[::1]']);
  assert.deepEqual(integrationManifest('https://api.example.com').permissions[0].domains, ['api.example.com']);
  const client = new Client({ name: 'everwhere-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../apps/mcp/index.mjs', import.meta.url))],
    env: { EVERWHERE_API: root, EVERWHERE_PROJECT: demo.id, EVERWHERE_PAIRING_TOKEN: token } });
  const stream = new AbortController();
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 16);
    assert.deepEqual(manifest.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      tools.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    async function voice(name, args = {}, expectsError = false) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, expectsError);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data._voiceos_glance.blocks.length, 2);
      return data;
    }
    assert.equal((await voice('get_context')).data.event, 'Lago di Braies');
    assert.ok(tools.tools.find(tool => tool.name === 'switch_view').inputSchema.properties.view.enum.includes('universe'));
    await voice('switch_view', { view: 'universe' });
    assert.equal((await snap()).session.view, 'universe');
    assert.equal((await voice('get_context')).data.view, 'universe');
    await voice('navigate_anchor', { anchorId: 'a-boats' });
    const navigation = (await snap()).session;
    assert.equal(navigation.view, 'explore');
    assert.equal(navigation.anchorId, 'a-boats');
    assert.ok(navigation.anchorNavigationId);
    await voice('navigate_anchor', { anchorId: 'a-boats' });
    const repeatedNavigationId = (await snap()).session.anchorNavigationId;
    assert.notEqual(repeatedNavigationId, navigation.anchorNavigationId);
    await voice('select_event', { query: 'Lago di Braies' });
    assert.equal((await snap()).session.anchorNavigationId, repeatedNavigationId);
    await voice('switch_view', { view: 'explore' });
    assert.equal((await snap()).session.view, 'explore');
    assert.equal((await snap()).session.anchorNavigationId, repeatedNavigationId);
    await voice('switch_view', { view: 'universe' });
    assert.equal((await snap()).session.anchorNavigationId, null);
    await voice('switch_view', { view: 'explore' });
    assert.ok((await request(p + '/pairing')).lastSeen > 0);
    const sse = await fetch(root + p + '/events', { headers: { Cookie: cookie }, signal: stream.signal });
    assert.equal(sse.status, 200);
    const reader = sse.body.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /resync.required/);
    const edit = (await voice('preview_correction', { eventId: 'e-lake', patch: { placeLabel: 'New harbor context' }, expectedRevision: 0 })).data;
    const timing = performance.now();
    await voice('confirm_change', { requestId: randomUUID(), previewToken: edit.previewToken, expectedRevision: 0 });
    const signal = new TextDecoder().decode((await reader.read()).value);
    assert.match(signal, /revision.committed/);
    const account = (await voice('preview_recollection', { eventId: 'e-lake', anchorId: 'a-lake', text: 'I remember wind over the water.', expectedRevision: 1 })).data;
    await voice('confirm_change', { requestId: randomUUID(), previewToken: account.previewToken, expectedRevision: 1 });
    await voice('set_lens', { mode: 'original' });
    assert.equal((await snap()).session.lens, 'originals');
    assert.equal((await snap()).recollections.length, 1);
    assert.equal((await snap()).events[0].placeLabel, 'New harbor context');
    t.diagnostic('First local MCP confirmation, SSE and follow-on assertions: ' + Math.round(performance.now() - timing) + ' ms');
    await request(p + '/pairing', undefined, { method: 'DELETE' });
    assert.deepEqual(await request(p + '/pairing'), { active: false, expires: null, lastSeen: null });
    assert.equal((await voice('get_context', {}, true)).code, 'TOKEN_EXPIRED');
  } finally { stream.abort(); await client.close(); }
});

test('pairing status migrates an existing database and resets when the token is replaced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-pairing-migration-'));
  const legacy = new DatabaseSync(join(dir, 'everwhere.sqlite'));
  legacy.exec('CREATE TABLE pairings (token TEXT PRIMARY KEY, actor TEXT NOT NULL, project TEXT NOT NULL, expires INTEGER NOT NULL)');
  legacy.close();
  const store = createStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const { actor } = store.newBrowser();
  const { id } = store.create(actor, 'Pairing test');
  const first = store.pair(actor, id);
  store.touchPair(first.token);
  assert.ok(store.pairingStatus(actor, id).lastSeen > 0);
  store.pair(actor, id);
  assert.equal(store.pairing(first.token), null);
  assert.equal(store.pairingStatus(actor, id).lastSeen, null);
  const connection = new DatabaseSync(join(dir, 'everwhere.sqlite'));
  connection.prepare('UPDATE pairings SET expires = ?').run(Date.now() - 1);
  connection.close();
  assert.equal(store.pairingStatus(actor, id).active, false);
});

test('real 1080p MP4 plays over range requests and dependency staleness blocks delivery', async t => {
  const ctx = await setup(t);
  const { root, p, request, cookie, snap, dir } = ctx;
  await request(p + '/session', { lens: 'originals' });
  await request(p + '/film-preview', { eventId: 'e-lake', expectedRevision: 0 }, { status: 400 });
  await request(p + '/session', { lens: 'all' });
  const audioFile = join(dir, 'voice-note.webm');
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'libopus', audioFile], { timeout: 10000 });
  const session = await request(p + '/capture/sessions', { source: 'browser_audio', consent: true });
  const audio = await request(p + '/capture/sessions/' + session.id + '/files', asUpload(await readFile(audioFile), 'Voice note.webm', 'audio/webm'));
  assert.equal(audio.media.mime, 'audio/webm');
  const review = await request(p + '/capture/observations/' + audio.observationId + '/preview', {
    eventId: 'e-lake', anchorId: 'a-lake', expectedRevision: 0, text: 'My account of the lakeshore.'
  });
  assert.equal(review.command.type, 'recollection.add');
  await request(p + '/commands', { ...review.command, previewToken: review.previewToken, requestId: randomUUID() });
  const jobPreview = await request(p + '/film-preview', { eventId: 'e-lake', expectedRevision: 1 });
  assert.equal(jobPreview.diff.containsImagined, true);
  assert.equal(jobPreview.diff.narration, true);
  const job = await request(p + '/jobs', { requestId: randomUUID(), previewToken: jobPreview.previewToken });
  const artifact = p + '/artifacts/' + job.id;
  await request(artifact + '/access', undefined, { status: 404 });
  await request(p + '/commands', await propose(ctx, 'event.correct', 'e-cabin', { patch: { title: 'Unaffected by the lake film' } }));
  const ready = await waitForJob(ctx, job.id);
  assert.equal(ready.status, 'ready', ready.error);
  await request(artifact + '/access', undefined, { status: 404 });
  await request(p + '/commands', await propose(ctx, 'artifact.approve', 'e-lake', { artifactId: job.id, dependencyHash: job.inputHash }));
  const approved = await request(artifact + '/access');
  const ranged = await fetch(root + approved.url, { headers: { Cookie: cookie, Range: 'bytes=0-63' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 64);
  const download = await fetch(root + approved.url, { headers: { Cookie: cookie } });
  const file = join(dir, 'downloaded.mp4');
  await writeFile(file, Buffer.from(await download.arrayBuffer()));
  const media = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', file]));
  assert.deepEqual(media.streams[0], { codec_name: 'h264', width: 1920, height: 1080 });
  assert.equal(media.streams[1].codec_name, 'aac');
  assert.equal(media.streams[2].codec_name, 'mov_text');
  assert.ok(Number(media.format.duration) >= 30 && Number(media.format.duration) <= 60);
  const audioTrack = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-t', '1', '-f', 's16le', '-']);
  assert.ok(audioTrack.some(byte => byte !== 0), 'The approved voice note is audible');
  const captions = await fetch(root + artifact + '/captions', { headers: { Cookie: cookie } });
  assert.match(await captions.text(), /Imagined demo imagery/);
  t.diagnostic('FFprobe: 1920×1080 H.264 + AAC + captions, ' + media.format.duration + ' seconds');
  await request(p + '/capture/grants/' + session.grantId + '/revoke', {});
  assert.equal((await snap()).recollections.length, 0);
  assert.equal((await request(p + '/jobs/' + job.id)).status, 'stale');
  await request(artifact + '/access', undefined, { status: 404 });
  const nextPreview = await request(p + '/film-preview', { eventId: 'e-lake', expectedRevision: (await snap()).revision });
  const next = await request(p + '/jobs', { requestId: randomUUID(), previewToken: nextPreview.previewToken });
  await request(p + '/commands', await propose(ctx, 'event.correct', 'e-lake', { patch: { title: 'Latest lake memory' } }));
  assert.equal((await waitForJob(ctx, next.id)).status, 'stale');
  await request(p + '/artifacts/' + next.id + '/access', undefined, { status: 404 });
});

test('imported SPZ delivery requires its approval, current lens, and linked original source', async t => {
  const ctx = await setup(t);
  const { root, p, request, snap, cookie } = ctx;
  const session = await request(p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const upload = await request(p + '/capture/sessions/' + session.id + '/files', asUpload(await makeImage(), 'Test image.jpg'));
  const preview = await request(p + '/capture/observations/' + upload.observationId + '/preview', { eventId: 'e-lake', expectedRevision: 0 });
  await request(p + '/commands', { ...preview.command, requestId: randomUUID(), previewToken: preview.previewToken });
  const plain = Buffer.alloc(16 + 2 * 20);
  plain.write('NGSP', 0);
  plain.writeUInt32LE(3, 4);
  plain.writeUInt32LE(2, 8);
  plain[13] = 12;
  const bytes = gzipSync(plain);
  const endpoint = p + '/memories/e-lake/worlds?consent=1&expectedRevision=1&sourceId=' + upload.media.id;
  await request(endpoint, asUpload(gzipSync(plain.subarray(0, -1)), 'Truncated test.spz'), { status: 400 });
  const saved = await request(endpoint, asUpload(bytes, 'Synthetic test.spz'));
  const sizes = [18, 2, 6, 6, 8];
  const header = Buffer.alloc(32 + sizes.length * 16);
  plain.copy(header, 0, 0, 16);
  header.writeUInt32LE(4, 4);
  header[15] = sizes.length;
  header.writeUInt32LE(32, 16);
  const streams = sizes.map((size, index) => {
    const frame = zstdCompressSync(Buffer.alloc(size));
    header.writeBigUInt64LE(BigInt(frame.length), 32 + index * 16);
    header.writeBigUInt64LE(BigInt(size), 40 + index * 16);
    return frame;
  });
  const packed = Buffer.concat([header, ...streams]);
  await request(endpoint.replace('expectedRevision=1', 'expectedRevision=2'), asUpload(packed.subarray(0, -1), 'Truncated v4.spz'), { status: 400 });
  await request(endpoint.replace('expectedRevision=1', 'expectedRevision=2'), asUpload(packed, 'Synthetic v4.spz'));
  const world = (await snap()).worlds.find(item => item.id === saved.id);
  assert.equal(world.id, saved.id);
  assert.equal(world.approved, false);
  const asset = p + '/worlds/' + world.id + '/scene.spz';
  const headers = { Cookie: cookie };
  assert.equal((await fetch(root + asset, { headers })).status, 404);
  await request(p + '/commands', await propose(ctx, 'artifact.approve', 'e-lake', { artifactId: world.id, dependencyHash: world.inputHash }));
  assert.deepEqual(Buffer.from(await (await fetch(root + asset, { headers })).arrayBuffer()), bytes);
  await request(p + '/session', { lens: 'originals' });
  assert.equal((await fetch(root + asset, { headers })).status, 404);
  await request(p + '/session', { lens: 'all' });
  await request(p + '/capture/grants/' + session.grantId + '/revoke', {});
  assert.equal((await fetch(root + asset, { headers })).status, 404);
  assert.equal((await snap()).worlds.length, 0);
});

test('GLB scans keep private source approval and revocation gates and reject external assets', async t => {
  const ctx = await setup(t);
  const { root, p, request, snap, cookie } = ctx;
  const session = await request(p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const upload = await request(p + '/capture/sessions/' + session.id + '/files', asUpload(await makeImage(), 'Scan source.jpg'));
  const preview = await request(p + '/capture/observations/' + upload.observationId + '/preview', { eventId: 'e-lake', expectedRevision: 0 });
  await request(p + '/commands', { ...preview.command, requestId: randomUUID(), previewToken: preview.previewToken });
  function glb(external = false) {
    const positions = Buffer.from(new Float32Array([-5, 0, -5, 0, 0, 5, 5, 0, -5]).buffer);
    const description = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: positions.length, ...(external ? { uri: 'https://example.com/private-scan.bin' } : {}) }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-5, 0, -5], max: [5, 0, 5] }] };
    const json = Buffer.from(JSON.stringify(description));
    const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
    json.copy(padded);
    const header = Buffer.alloc(20);
    header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + positions.length, 8);
    header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
    const binaryHeader = Buffer.alloc(8);
    binaryHeader.writeUInt32LE(positions.length); binaryHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, padded, binaryHeader, positions]);
  }
  const endpoint = p + '/memories/e-lake/worlds?consent=1&expectedRevision=1&sourceId=' + upload.media.id;
  await request(endpoint, asUpload(glb(true), 'External.glb'), { status: 400 });
  await request(endpoint, asUpload(glb().subarray(0, -1), 'Truncated.glb'), { status: 400 });
  const saved = await request(endpoint, asUpload(glb(), 'Room.glb'));
  const world = (await snap()).worlds.find(item => item.id === saved.id);
  assert.equal(world.format, 'glb');
  const asset = p + '/worlds/' + world.id + '/scene.glb';
  const headers = { Cookie: cookie };
  assert.equal((await fetch(root + asset, { headers })).status, 404);
  await request(p + '/commands', await propose(ctx, 'artifact.approve', 'e-lake', { artifactId: world.id, dependencyHash: world.inputHash }));
  const response = await fetch(root + asset, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /model\/gltf-binary/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), glb());
  assert.equal((await fetch(root + asset.replace('scene.glb', 'scene.spz'), { headers })).status, 404);
  assert.equal((await fetch(root + asset)).status, 401);
  await request(p + '/session', { lens: 'originals' });
  assert.equal((await fetch(root + asset, { headers })).status, 404);
  await request(p + '/session', { lens: 'all' });
  await request(p + '/capture/grants/' + session.grantId + '/revoke', {});
  assert.equal((await fetch(root + asset, { headers })).status, 404);
  assert.equal((await snap()).worlds.length, 0);
});
