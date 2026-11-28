import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { createApp } from '../apps/api/server.mjs';

let videoBytes;
async function video() {
  if (!videoBytes) {
    const dir = await mkdtemp(join(tmpdir(), 'everwhere-scene-video-'));
    try {
      const file = join(dir, 'moving-scene.mp4');
      execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=6:duration=30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-threads', '2', file], { timeout: 30000 });
      videoBytes = await readFile(file);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return videoBytes;
}

function upload(bytes, name = 'Synthetic scene.mp4', mime = 'video/mp4') {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: mime }));
  return form;
}

async function setup(t, configure) {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-scene-film-'));
  let app, root;
  async function open() {
    app = await createApp({ dataDir: dir, serveWeb: false });
    configure?.(app);
    root = await app.listen({ port: 0, host: '127.0.0.1' });
  }
  async function close() {
    app.server.closeAllConnections();
    await app.close();
  }
  await open();
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function browser() {
    const response = await fetch(root + '/v1/bootstrap');
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    return response.headers.get('set-cookie').split(';')[0];
  }
  const cookie = await browser();
  async function request(path, body, options = {}) {
    const multipart = body instanceof FormData;
    const response = await fetch(root + path, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Cookie: options.cookie ?? cookie, ...(body !== undefined && !multipart && { 'Content-Type': 'application/json' }), ...options.headers },
      body: multipart ? body : body === undefined ? undefined : JSON.stringify(body), signal: options.signal
    });
    const json = await response.json();
    if (options.rejected) assert.ok(response.status >= 400 && response.status < 500, `${path}: ${JSON.stringify(json)}`);
    else assert.equal(response.status, options.status ?? 200, `${path}: ${JSON.stringify(json)}`);
    return response.status >= 400 ? json : json.data;
  }
  const project = await request('/v1/projects', { title: 'Synthetic scene film test' }, { status: 201 });
  const p = '/v1/projects/' + project.id;
  const event = await request(p + '/memories', { title: 'Scene film fixture', placeLabel: 'Synthetic location', expectedRevision: 0 });
  await request(p + '/session', { lens: 'all' });
  return { dir, cookie, project, p, event, request, browser, snap: () => request(p + '/snapshot'),
    fetch: (path, headers = {}) => fetch(root + path, { headers: { Cookie: cookie, ...headers } }),
    restart: async () => { await close(); await open(); } };
}

async function commit(ctx, type, payload) {
  const command = { type, targetId: ctx.event.id, payload, expectedRevision: (await ctx.snap()).revision };
  const preview = await ctx.request(ctx.p + '/previews', command);
  return ctx.request(ctx.p + '/commands', { ...command, previewToken: preview.previewToken, requestId: randomUUID() });
}

async function makeWorld(ctx, approved = true) {
  const capture = await ctx.request(ctx.p + '/capture/sessions', { consent: true, source: 'selected_file' });
  const bytes = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#447766' } }).jpeg().toBuffer();
  const source = await ctx.request(ctx.p + '/capture/sessions/' + capture.id + '/files', upload(bytes, 'Original fixture.jpg', 'image/jpeg'));
  const sourcePreview = await ctx.request(ctx.p + '/capture/observations/' + source.observationId + '/preview', {
    eventId: ctx.event.id, expectedRevision: (await ctx.snap()).revision
  });
  await ctx.request(ctx.p + '/commands', { ...sourcePreview.command, previewToken: sourcePreview.previewToken, requestId: randomUUID() });
  const expectedRevision = (await ctx.snap()).revision;
  const preview = await ctx.request(ctx.p + '/world-preview', { eventId: ctx.event.id, expectedRevision, environment: 'forest', season: 'green' });
  const result = await ctx.request(ctx.p + '/world-jobs', { expectedRevision, previewToken: preview.previewToken, requestId: randomUUID() });
  let world = (await ctx.snap()).worlds.find(item => item.id === result.id);
  if (approved) {
    await commit(ctx, 'artifact.approve', { artifactId: world.id, dependencyHash: world.inputHash });
    world = (await ctx.snap()).worlds.find(item => item.id === result.id);
  }
  return { world, capture, source };
}

async function pathFor(ctx, world, seconds = 30) {
  const context = await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/scene-context?world=' + world.id);
  const sceneManifest = { ...structuredClone(world.sceneManifest), revision: context.revision };
  sceneManifest.boundsMax[1] += 3;
  const position = sceneManifest.spawn;
  const cameraPath = { id: randomUUID(), sceneId: world.id, revision: context.revision, provenance: world.provenance,
    keyframes: [{ t: 0, position, quaternion: [0, 0, 0, 1], fov: 65 },
      { t: seconds, position, quaternion: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)], fov: 65 }] };
  return { version: '3.1-proposal', context, sceneManifest, cameraPath };
}

async function preview(ctx, path, options) {
  return ctx.request(ctx.p + '/scene-film-preview', { expectedRevision: (await ctx.snap()).revision, path }, options);
}

async function queue(ctx, proposal, requestId = randomUUID(), options = {}) {
  return ctx.request(ctx.p + '/scene-films/' + proposal.previewToken, upload(await video()),
    { ...options, headers: { 'X-Request-Id': requestId, ...options.headers } });
}

async function waitForJob(ctx, id) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const job = await ctx.request(ctx.p + '/jobs/' + id);
    if (!['queued', 'running'].includes(job.status)) return job;
    await delay(80);
  }
  assert.fail('Scene film did not reach a terminal state');
}

async function reached(promise) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('The expected upload stage was not reached')), 15000);
    })]);
  } finally { clearTimeout(timeout); }
}

function storedState(ctx) {
  const db = new DatabaseSync(join(ctx.dir, 'everwhere.sqlite'), { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT state FROM projects WHERE id = ?').get(ctx.project.id).state); }
  finally { db.close(); }
}

test('scene-film review is private, current, and requires an approved usable world', async t => {
  const ctx = await setup(t);
  const { world, capture } = await makeWorld(ctx, false);
  const otherCookie = await ctx.browser();
  await ctx.request(ctx.p + '/scene-film-preview', {}, { cookie: otherCookie, status: 404 });
  await ctx.request(ctx.p + '/memories/' + ctx.event.id + '/scene-context?world=' + world.id, undefined, { rejected: true });
  await commit(ctx, 'artifact.approve', { artifactId: world.id, dependencyHash: world.inputHash });
  const path = await pathFor(ctx, world);
  const proposed = await preview(ctx, path);
  assert.equal(proposed.diff.storyboard.kind, 'scene_recording');
  assert.equal(proposed.diff.storyboard.worldId, world.id);
  assert.equal(proposed.diff.storyboard.durationSeconds, 30);
  assert.equal(proposed.diff.recording.worldId, world.id);
  assert.equal(proposed.diff.recording.provenance, 'imagined');
  assert.equal(proposed.diff.recording.width, 1920);
  assert.equal(proposed.diff.recording.height, 1080);
  assert.equal(proposed.diff.recording.path, undefined, 'The preview summary must not project private path/context copies');
  assert.equal(JSON.stringify(proposed).includes(ctx.dir), false, 'Review projection cannot disclose storage paths');
  assert.equal((await ctx.snap()).jobs.length, 0, 'Preview alone cannot create an output');
  await ctx.request(ctx.p + '/session', { lens: 'originals' });
  await preview(ctx, path, { rejected: true });
  await ctx.request(ctx.p + '/session', { lens: 'all' });
  await commit(ctx, 'recollection.add', { text: 'A newly confirmed memory invalidates the recorded context.' });
  await preview(ctx, path, { rejected: true });
  await queue(ctx, proposed, randomUUID(), { rejected: true });
  await ctx.request(ctx.p + '/capture/grants/' + capture.grantId + '/revoke', {});
  await preview(ctx, path, { rejected: true });
});

test('scene-film paths reject malformed geometry, time, forged context and excessive size', async t => {
  const ctx = await setup(t);
  const { world } = await makeWorld(ctx);
  const path = await pathFor(ctx, world);
  const changes = [
    item => { item.cameraPath.keyframes = []; },
    item => { item.cameraPath.keyframes[0].t = 1; },
    item => { item.cameraPath.keyframes[1].t = 0; },
    item => { item.cameraPath.keyframes[1].t = 29; },
    item => { item.cameraPath.keyframes[1].t = 61; },
    item => { item.cameraPath.keyframes[1].quaternion = [0, 0, 0, 0]; },
    item => { item.cameraPath.keyframes[1].position[0] = item.sceneManifest.boundsMax[0] + 1; },
    item => { item.cameraPath.keyframes[1].fov = 179; },
    item => { item.cameraPath.keyframes[1].position = [0, 0]; },
    item => { item.cameraPath.keyframes = Array.from({ length: 1803 }, (_, i) => ({ ...item.cameraPath.keyframes[0], t: i / 1802 * 30 })); },
    item => { item.context.sourceIds = []; },
    item => { item.context.projectId = randomUUID(); },
    item => { item.context.inputHash = '0'.repeat(64); },
    item => { item.sceneManifest.id = randomUUID(); },
    item => { item.sceneManifest.assetId = randomUUID(); },
    item => { item.sceneManifest.provenance = 'reconstructed'; },
    item => { item.cameraPath.provenance = 'reconstructed'; }
  ];
  for (const change of changes) {
    const invalid = structuredClone(path);
    change(invalid);
    await preview(ctx, invalid, { rejected: true });
  }
  await ctx.request(ctx.p + '/scene-film-preview', { expectedRevision: (await ctx.snap()).revision, path, padding: 'x'.repeat(513 * 1024) }, { status: 413 });
  assert.equal((await ctx.snap()).jobs.length, 0);
  assert.equal((await preview(ctx, path)).diff.recording.durationSeconds, 30, 'Rejected paths do not poison a valid retry');
});

test('actual scene footage renders, requires approval, supports replay/ranges, survives restart and withdraws with its source', async t => {
  const ctx = await setup(t);
  const { world, source, capture } = await makeWorld(ctx);
  const path = await pathFor(ctx, world);
  const proposal = await preview(ctx, path);
  const requestId = randomUUID();
  const otherCookie = await ctx.browser();
  await ctx.request(ctx.p + '/scene-films/' + proposal.previewToken + '/cancel', { requestId }, { cookie: otherCookie, status: 404 });
  await queue(ctx, proposal, requestId, { cookie: otherCookie, status: 404 });
  const before = await readdir(join(ctx.dir, 'projects', ctx.project.id));
  await ctx.request(ctx.p + '/scene-films/' + proposal.previewToken, upload(Buffer.from('not a scene recording')),
    { rejected: true, headers: { 'X-Request-Id': requestId } });
  assert.deepEqual((await readdir(join(ctx.dir, 'projects', ctx.project.id))).sort(), before.sort(), 'Malformed input leaves no file and permits a valid retry');
  const job = await queue(ctx, proposal, requestId);
  assert.equal(job.storyboard.kind, 'scene_recording');
  assert.deepEqual(job.storyboard, proposal.diff.storyboard);
  assert.equal(JSON.stringify(job).includes(ctx.dir), false);
  assert.equal(job.manifest, undefined);
  assert.equal(job.recording.path, undefined);
  const replay = await queue(ctx, proposal, requestId);
  assert.equal(replay.id, job.id);
  assert.equal((await ctx.snap()).jobs.length, 1);
  await ctx.request(ctx.p + '/scene-films/' + proposal.previewToken, upload(Buffer.concat([await video(), Buffer.from([0])])),
    { status: 409, headers: { 'X-Request-Id': requestId } });
  await ctx.request(ctx.p + '/artifacts/' + job.id + '/access', undefined, { status: 404 });
  const anotherPreview = await preview(ctx, path);
  await queue(ctx, anotherPreview, requestId, { status: 409 });
  const ready = await waitForJob(ctx, job.id);
  assert.equal(ready.status, 'ready', ready.error);
  assert.equal(ready.approved, false);
  assert.deepEqual((await ctx.snap()).events[0].sourceIds, [source.media.id], 'Derived footage must not become an original source');
  await ctx.request(ctx.p + '/artifacts/' + job.id + '/access', undefined, { status: 404 });
  await commit(ctx, 'artifact.approve', { artifactId: job.id, dependencyHash: job.inputHash });
  const approved = await ctx.request(ctx.p + '/artifacts/' + job.id + '/access');
  await ctx.request(ctx.p + '/session', { lens: 'originals' });
  for (const route of ['access', 'file', 'captions']) {
    await ctx.request(ctx.p + '/artifacts/' + job.id + '/' + route, undefined, { status: 404 });
  }
  await ctx.request(ctx.p + '/session', { lens: 'all' });
  assert.deepEqual(await ctx.request(ctx.p + '/artifacts/' + job.id + '/access'), approved, 'Changing the lens must hide the scene film without losing its approval');
  const ranged = await ctx.fetch(approved.url, { Range: 'bytes=0-63' });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 64);
  const output = await ctx.fetch(approved.url);
  const file = join(ctx.dir, 'downloaded-scene.mp4');
  await writeFile(file, Buffer.from(await output.arrayBuffer()));
  const media = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', file]));
  assert.deepEqual(media.streams[0], { codec_name: 'h264', width: 1920, height: 1080 });
  assert.equal(media.streams[1].codec_name, 'aac');
  assert.ok(Math.abs(Number(media.format.duration) - 30) < 0.15);
  const captions = await ctx.fetch(ctx.p + '/artifacts/' + job.id + '/captions');
  assert.match(await captions.text(), /imagined|virtual camera/i);
  await ctx.restart();
  assert.equal((await ctx.request(ctx.p + '/jobs/' + job.id)).approved, true);
  assert.equal((await ctx.fetch(approved.url)).status, 200);
  const other = await ctx.browser();
  await ctx.request(ctx.p + '/jobs/' + job.id, undefined, { cookie: other, status: 404 });
  await ctx.request(ctx.p + '/capture/grants/' + capture.grantId + '/revoke', {});
  const stale = await ctx.request(ctx.p + '/jobs/' + job.id);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.storyboard, undefined);
  assert.equal(stale.recording, undefined);
  assert.equal((await ctx.fetch(approved.url)).status, 404);
  await queue(ctx, proposal, requestId, { rejected: true });
  const saved = storedState(ctx).jobs.find(item => item.id === job.id);
  assert.equal(saved.manifest, undefined, 'Withdrawal must remove the private camera path and raw-input manifest');
  assert.equal((await readdir(join(ctx.dir, 'projects', ctx.project.id))).some(name => name.startsWith(job.id)), false);
});

test('cancelling an accepted scene-film upload prevents late worker output and allows a fresh retry', async t => {
  const accepted = Promise.withResolvers();
  const release = Promise.withResolvers();
  let hold = true;
  const ctx = await setup(t, app => app.addHook('onSend', async (req, reply, payload) => {
    if (hold && reply.statusCode === 200 && /\/scene-films\/[^/]+$/.test(req.url)) {
      hold = false;
      accepted.resolve(JSON.parse(payload).data);
      await release.promise;
    }
    return payload;
  }));
  const { world } = await makeWorld(ctx);
  const path = await pathFor(ctx, world);
  const proposal = await preview(ctx, path);
  const requestId = randomUUID();
  const baseline = await readdir(join(ctx.dir, 'projects', ctx.project.id));
  const pending = queue(ctx, proposal, requestId);
  void pending.catch(accepted.reject);
  let job;
  try {
    job = await reached(accepted.promise);
    await ctx.request(ctx.p + '/scene-films/' + proposal.previewToken + '/cancel', { requestId });
  } finally { release.resolve(); }
  await pending;
  const cancelled = await ctx.request(ctx.p + '/jobs/' + job.id);
  assert.equal(cancelled.status, 'stale');
  assert.equal(cancelled.approved, false);
  assert.equal(cancelled.storyboard, undefined);
  await ctx.request(ctx.p + '/artifacts/' + job.id + '/access', undefined, { status: 404 });
  await queue(ctx, proposal, requestId, { rejected: true });
  await ctx.restart();
  assert.deepEqual((await readdir(join(ctx.dir, 'projects', ctx.project.id))).sort(), baseline.sort(), 'Late render completion must not restore cancelled files');
  const next = await preview(ctx, path);
  assert.notEqual(next.previewToken, proposal.previewToken);
  assert.equal(next.diff.storyboard.kind, 'scene_recording');
});

test('cancelling a scene-film review rejects an upload already waiting for its file', async t => {
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const ctx = await setup(t, app => app.addHook('preHandler', async req => {
    if (!/\/scene-films\/[^/]+$/.test(req.url)) return;
    const file = req.file.bind(req);
    req.file = async (...args) => { started.resolve(); await resume.promise; return file(...args); };
  }));
  const { world } = await makeWorld(ctx);
  const proposal = await preview(ctx, await pathFor(ctx, world));
  const requestId = randomUUID();
  const baseline = await readdir(join(ctx.dir, 'projects', ctx.project.id));
  const pending = queue(ctx, proposal, requestId, { rejected: true });
  void pending.catch(started.reject);
  try {
    await reached(started.promise);
    await ctx.request(ctx.p + '/scene-films/' + proposal.previewToken + '/cancel', { requestId });
  } finally { resume.resolve(); }
  await pending;
  assert.equal((await ctx.snap()).jobs.length, 0);
  assert.deepEqual((await readdir(join(ctx.dir, 'projects', ctx.project.id))).sort(), baseline.sort(), 'Cancelled late upload leaves no raw or partial file');
  await queue(ctx, proposal, requestId, { rejected: true });
});

test('disconnecting after the complete multipart body arrives cannot queue a scene film or retain raw input', async t => {
  const received = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const release = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const ctx = await setup(t, app => {
    app.addHook('preHandler', async (req, reply) => {
      if (!/\/scene-films\/[^/]+$/.test(req.url)) return;
      reply.raw.once('close', disconnected.resolve);
      const file = req.file.bind(req);
      req.file = async (...args) => {
        const part = await file(...args);
        const toBuffer = part.toBuffer.bind(part);
        part.toBuffer = async () => {
          const bytes = await toBuffer();
          if (!req.raw.complete) await new Promise(resolve => req.raw.once('end', resolve));
          received.resolve(req);
          await release.promise;
          return bytes;
        };
        return part;
      };
    });
    app.addHook('onSend', async (req, reply, payload) => {
      if (/\/scene-films\/[^/]+$/.test(req.url)) finished.resolve(reply.statusCode);
      return payload;
    });
  });
  const { world } = await makeWorld(ctx);
  const proposal = await preview(ctx, await pathFor(ctx, world));
  const baseline = await readdir(join(ctx.dir, 'projects', ctx.project.id));
  const controller = new AbortController();
  const pending = queue(ctx, proposal, randomUUID(), { signal: controller.signal });
  const aborted = assert.rejects(pending, { name: 'AbortError' });
  try {
    const req = await reached(received.promise);
    assert.equal(req.raw.complete, true, 'The regression must disconnect after the entire HTTP body arrived');
    controller.abort();
    await aborted;
    await reached(disconnected.promise);
    assert.equal(req.raw.aborted, false, 'A completed request body does not set IncomingMessage.aborted on this disconnect');
  } finally { controller.abort(); release.resolve(); }
  await aborted;
  await reached(finished.promise);
  assert.equal((await ctx.snap()).jobs.length, 0, 'A disconnected upload must not become a queued or rendered scene film');
  assert.deepEqual((await readdir(join(ctx.dir, 'projects', ctx.project.id))).sort(), baseline.sort(), 'Rejected disconnected input must leave no stored recording or render');
});

test('source revocation during a scene-film upload rejects late bytes and scrubs the pending plan', async t => {
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const ctx = await setup(t, app => app.addHook('preHandler', async req => {
    if (!/\/scene-films\/[^/]+$/.test(req.url)) return;
    const file = req.file.bind(req);
    req.file = async (...args) => { started.resolve(); await resume.promise; return file(...args); };
  }));
  const { world, capture } = await makeWorld(ctx);
  const proposal = await preview(ctx, await pathFor(ctx, world));
  const pending = queue(ctx, proposal, randomUUID(), { rejected: true });
  void pending.catch(started.reject);
  try {
    await reached(started.promise);
    await ctx.request(ctx.p + '/capture/grants/' + capture.grantId + '/revoke', {});
  } finally { resume.resolve(); }
  await pending;
  assert.equal((await ctx.snap()).jobs.length, 0);
  assert.equal(storedState(ctx).previews[proposal.previewToken], undefined);
  assert.deepEqual(await readdir(join(ctx.dir, 'projects', ctx.project.id)), []);
});
