import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { createReadStream, existsSync } from 'node:fs';
import { stat, rm, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import formats from 'ajv-formats';
import { createStore } from './store.mjs';
import { integrationManifest } from '../mcp/manifest.mjs';
import {
  assertCapture, capturePreview, cleanMedia, commitCommand, createEvent, createFilmWorker, gapQuestion, getSnapshot,
  inbox, observe, previewCommand, previewFilm, queueFilm, resolveEvent, revokeCapture, startCapture, updateSession
} from './service.mjs';
import { ingest, removeMedia } from '../../packages/media/local.mjs';
import { storeSplat } from '../../packages/media/splat.mjs';
import { storeMesh } from '../../packages/media/mesh.mjs';
import { sceneContext } from '../../packages/runtime/scene.mjs';
import { evidenceFor, handoffPlan, lookupPlace, previewWorld, voiceEvidence } from '../../packages/intelligence/scene-plan.mjs';
import { generateWorld } from '../../packages/providers/world/procedural.mjs';
import { appendChange, digest, eventById, generationDependencies, mediaById, rank, requireCondition as check, uid } from '../../packages/runtime/memory.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const demoDir = join(root, 'apps/web/public/media');
const buildDir = join(root, 'apps/web/dist');
const landingDir = join(buildDir, 'landing');
const projectPath = '/v1/projects/:p';
const ajv = new Ajv({ strict: false });
formats(ajv);
const toolDefinitions = JSON.parse(readFileSync(join(root, 'packages/contracts/mcp-tools.json'))).tools;
const toolValidation = new Map(toolDefinitions.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));

function cookie(request, name) {
  return (request.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1);
}

async function streamFile(request, reply, path, mime) {
  const { size } = await stat(path);
  reply.type(mime).header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, no-store');
  const range = request.headers.range;
  if (!range) return reply.header('Content-Length', size).send(createReadStream(path));
  const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start, end;
  if (parts && parts[1]) {
    start = Number(parts[1]);
    end = parts[2] ? Math.min(Number(parts[2]), size - 1) : size - 1;
  } else if (parts && parts[2]) {
    start = Math.max(0, size - Number(parts[2]));
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return reply.code(416).header('Content-Range', 'bytes */' + size).send();
  }
  return reply.code(206).header('Content-Range', 'bytes ' + start + '-' + end + '/' + size)
    .header('Content-Length', end - start + 1).send(createReadStream(path, { start, end }));
}

export async function createApp({ dataDir = resolve(process.env.EVERWHERE_DATA || join(root, '.data')), serveWeb = true, contextFetch = fetch } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const store = createStore(dataDir);
  const film = createFilmWorker(store, dataDir, demoDir);
  await app.register(multipart, { limits: { fileSize: 48 * 1024 ** 2, files: 1, fields: 0, parts: 1 } });
  app.addHook('onClose', async () => { await film.stop(); store.close(); });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'SAMEORIGIN');
    if (!req.url.startsWith('/v1/')) return;
    reply.header('Cache-Control', 'private, no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return;
    const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
    let host;
    try { host = new URL(req.headers.origin).host; } catch { /* handled by origin check */ }
    check(allowed.includes(host) && req.headers['sec-fetch-site'] !== 'cross-site', 403, 'ORIGIN_DENIED', 'This request must come from Everwhere.');
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error.status || error.statusCode || 500;
    const safe = error.status ? error.message : status === 413 ? 'Select a file smaller than 48 MB.' : status < 500 ? 'The request could not be read.' : 'Something went wrong. Try again.';
    reply.code(status).send({ ok: false, code: error.status ? error.code : status === 413 ? 'FILE_TOO_LARGE' : 'REQUEST_FAILED', message: safe, ...error.details });
  });
  app.get('/health', async () => ({ ok: true }));

  function auth(req, projectId) {
    let identity;
    if (req.headers.authorization) {
      identity = store.pairing(/^Bearer (\S+)$/i.exec(req.headers.authorization)?.[1]);
      check(identity, 401, 'TOKEN_EXPIRED', 'Pair VoiceOS again to continue.');
      check(identity.project === projectId, 404, 'PROJECT_NOT_FOUND', 'That private project is unavailable.');
    } else {
      identity = store.browser(cookie(req, 'ew_session'));
      check(identity, 401, 'SESSION_REQUIRED', 'Open Everwhere to start a private workspace.');
    }
    return identity;
  }
  const scope = req => ({ actor: auth(req, req.params.p).actor, project: req.params.p });
  const read = (req, fn) => {
    const { actor, project } = scope(req);
    const state = store.read(actor, project);
    return { ok: true, revision: state.revision, data: fn(state, actor, project) };
  };
  const update = (req, kind, fn) => {
    const { actor, project } = scope(req);
    const { state, data } = store.update(actor, project, kind, state => fn(state, actor, project));
    return { ok: true, revision: state.revision, data };
  };

  async function researchPlace(req, eventId, input) {
    check(input?.consent === true, 400, 'CONSENT_REQUIRED', 'Confirm sharing this place and approximate coordinates with Wikipedia. Photos and conversation stay private.');
    const { actor, project } = scope(req);
    const before = store.read(actor, project);
    check(before.revision === input.expectedRevision, 409, 'REVISION_CONFLICT', 'The memory changed. Review its location first.');
    const evidence = evidenceFor(before, eventId);
    if (evidence.research && Date.now() - Date.parse(evidence.research.fetchedAt) < 15 * 60_000) {
      return { ok: true, revision: before.revision, data: evidence.research };
    }
    const result = await lookupPlace(evidence, contextFetch);
    return update(req, 'context.changed', state => {
      check(state.revision === before.revision && digest(generationDependencies(state, eventId)) === evidence.inputHash,
        409, 'REVISION_CONFLICT', 'The memory changed during research. Review it and try again.');
      (state.locationResearch ??= {})[eventId] = result;
      return result;
    });
  }

  function worldReplay(state, input) {
    const request = state.requests['world:' + input.requestId];
    if (!request) return null;
    check(request.hash === digest(input), 409, 'REQUEST_ID_REUSED', 'This request ID was already used for another generation.');
    const world = state.worlds.find(item => item.id === request.result.id);
    check(world && !world.revoked && world.status === 'ready', 409, 'WORLD_UNAVAILABLE', 'This generated scene is no longer current. Review a new plan.');
    return request.result;
  }

  async function confirmWorld(req, input) {
    check(input && typeof input.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 128 &&
      typeof input.previewToken === 'string' && input.previewToken.length <= 128 && Number.isInteger(input.expectedRevision),
      400, 'INVALID_COMMAND', 'A request ID, preview and current revision are required.');
    const { actor, project } = scope(req);
    const before = store.read(actor, project);
    const replay = worldReplay(before, input);
    if (replay) return { ok: true, revision: before.revision, data: replay };
    const preview = before.previews[input.previewToken];
    check(preview?.kind === 'world' && preview.actor === actor && preview.expires > Date.now(),
      409, 'PREVIEW_EXPIRED', 'This scene preview expired. Review a new plan.');
    const { plan } = preview;
    check(before.revision === input.expectedRevision && plan.revision === before.revision &&
      plan.inputHash === digest(generationDependencies(before, plan.eventId)),
      409, 'REVISION_CONFLICT', 'The memory changed. Review a new scene plan.');
    const photos = await Promise.all(plan.sourceIds.map(async id => {
      const source = mediaById(before, id);
      check(source && !source.pending && source.provenance === 'original' && eventById(before, plan.eventId)?.sourceIds.includes(id),
        409, 'SOURCE_UNAVAILABLE', 'A scene source is no longer available.');
      return { id, jpeg: await readFile(source.thumb) };
    }));
    const generated = await generateWorld(plan, photos);
    const asset = await storeMesh(generated.buffer, 'Imagined memory.glb', join(dataDir, 'projects', project));
    let retained = false;
    try {
      const result = update(req, 'revision.committed', state => {
        const replay = worldReplay(state, input);
        if (replay) return replay;
        check(state.revision === before.revision && state.previews[input.previewToken]?.actor === actor &&
          state.previews[input.previewToken].expires > Date.now() && plan.inputHash === digest(generationDependencies(state, plan.eventId)),
          409, 'REVISION_CONFLICT', 'The memory changed during generation. Review a new plan.');
        const anchors = generated.photoStops.map(stop => ({ id: uid(), worldId: asset.id, eventId: plan.eventId,
          title: mediaById(state, stop.sourceId).caption, sourceIds: [stop.sourceId], position: stop.position }));
        const manifest = { id: asset.id, planId: plan.id, revision: state.revision + 1, format: 'glb', assetId: asset.id,
          collisionAssetId: asset.id, units: 'm', coordinateSystem: 'right-handed-y-up', scaleConfidence: null,
          boundsMin: generated.boundsMin, boundsMax: generated.boundsMax, spawn: generated.spawn,
          anchors: anchors.map(({ id, position, sourceIds }) => ({ id, position, sourceIds })), capability: 'free_roam', provenance: 'imagined' };
        state.worlds.push({ ...asset, eventId: plan.eventId, title: plan.title + ' · imagined world', status: 'ready', planId: plan.id,
          approval: 'pending', approved: false, provenance: 'imagined', sourceIds: plan.sourceIds, provider: plan.provider,
          evidenceRefs: { mediaIds: plan.evidence.media.map(item => item.id), recollectionIds: plan.evidence.recollections.map(item => item.id) },
          evidenceHash: plan.inputHash, inputHash: digest(plan), plan, sceneManifest: manifest });
        state.anchors.push(...anchors);
        delete state.previews[input.previewToken];
        appendChange(state, 'Generated an imagined memory world', plan.eventId);
        const data = { id: asset.id, status: 'ready', approved: false };
        state.requests['world:' + input.requestId] = { hash: digest(input), result: data };
        return data;
      });
      retained = result.data.id === asset.id;
      return result;
    } finally {
      if (!retained) await rm(asset.storage, { force: true });
    }
  }

  app.get('/v1/bootstrap', async (req, reply) => {
    let identity = store.browser(cookie(req, 'ew_session'));
    if (!identity) {
      identity = store.newBrowser();
      const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
      reply.header('Set-Cookie', 'ew_session=' + identity.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + (secure ? '; Secure' : ''));
      store.create(identity.actor, 'The Dolomites', true);
    }
    return { ok: true, data: store.list(identity.actor) };
  });

  app.post('/v1/projects', async (req, reply) => {
    const { actor } = auth(req);
    const title = req.body?.title;
    check(typeof title === 'string' && title.trim().length > 0 && title.length <= 120, 400, 'INVALID_TITLE', 'Give your project a name.');
    const result = store.create(actor, title.trim());
    return reply.code(201).send({ ok: true, revision: 0, data: result });
  });
  app.delete(projectPath, async req => {
    const { actor, project } = scope(req);
    check(req.body?.confirm === true && !req.headers.authorization, 400, 'CONFIRM_DELETE', 'Confirm deletion from the project settings.');
    store.delete(actor, project);
    await rm(join(dataDir, 'projects', project), { recursive: true, force: true });
    return { ok: true, data: { deleted: true } };
  });
  app.get(projectPath + '/snapshot', async req => read(req, (state, actor, id) => getSnapshot(id, state)));
  app.post(projectPath + '/memories', async req => update(req, 'revision.committed', state => {
    check(req.body?.expectedRevision === state.revision, 409, 'REVISION_CONFLICT', 'Refresh the project before adding a memory.', { revision: state.revision });
    return createEvent(state, req.body);
  }));
  app.get(projectPath + '/memories/:id/evidence', async req => read(req, state => evidenceFor(state, req.params.id)));
  app.post(projectPath + '/memories/:id/place-context', async req => researchPlace(req, req.params.id, req.body));
  app.post(projectPath + '/world-preview', async req => update(req, null, (state, actor) => previewWorld(state, req.body ?? {}, actor)));
  app.post(projectPath + '/world-jobs', async req => confirmWorld(req, req.body));
  app.post(projectPath + '/session', async req => update(req, 'session.changed', state => updateSession(state, req.body ?? {})));
  app.get(projectPath + '/search', async req => read(req, state => rank(state, String(req.query.q || '').slice(0, 4000), req.query.eventId)));
  app.get(projectPath + '/gaps', async req => read(req, state => gapQuestion(state, req.query.eventId || state.session.eventId)));
  app.post(projectPath + '/previews', async req => update(req, null, (state, actor) => previewCommand(state, req.body ?? {}, actor)));
  app.post(projectPath + '/commands', async req => update(req, 'revision.committed', (state, actor) => commitCommand(state, req.body ?? {}, actor)));
  app.post(projectPath + '/film-preview', async req => update(req, null, (state, actor) => previewFilm(state, req.body ?? {}, actor)));
  app.post(projectPath + '/jobs', async req => {
    const result = update(req, 'job.changed', (state, actor) => queueFilm(state, req.body ?? {}, actor));
    film.start();
    return result;
  });
  app.get(projectPath + '/jobs/:id', async req => read(req, (state, actor, id) => {
    const job = getSnapshot(id, state).jobs.find(item => item.id === req.params.id);
    check(job, 404, 'JOB_NOT_FOUND', 'This render is unavailable.');
    return job;
  }));

  app.get(projectPath + '/events', async (req, reply) => {
    const { actor, project } = scope(req);
    const state = store.read(actor, project);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    const send = event => res.write((event.seq !== undefined ? 'id: ' + event.seq + '\n' : '') + 'data: ' + JSON.stringify(event) + '\n\n');
    send({ seq: state.seq, kind: 'resync.required', projectId: project, revision: state.revision });
    const unsubscribe = store.subscribe(project, event => {
      try {
        auth(req, project);
        send(event);
        if (event.kind === 'project.deleted') res.end();
      } catch { res.end(); }
    });
    const timer = setInterval(() => {
      try { auth(req, project); res.write(': heartbeat\n\n'); } catch { res.end(); }
    }, 14000);
    res.on('close', () => { clearInterval(timer); unsubscribe(); });
  });

  app.post(projectPath + '/pairing', async req => {
    check(!req.headers.authorization && req.body?.confirm === true, 403, 'PAIRING_REQUIRES_BROWSER', 'Create a pairing token from the browser.');
    const { actor, project } = scope(req);
    return { ok: true, data: store.pair(actor, project) };
  });
  app.get(projectPath + '/pairing', async req => {
    check(!req.headers.authorization, 403, 'PAIRING_REQUIRES_BROWSER', 'Check pairing status from the browser.');
    const { actor, project } = scope(req);
    return { ok: true, data: store.pairingStatus(actor, project) };
  });
  app.get(projectPath + '/pairing/manifest', async (req, reply) => {
    check(!req.headers.authorization, 403, 'PAIRING_REQUIRES_BROWSER', 'Download the manifest from the browser.');
    scope(req);
    let manifest;
    try { manifest = integrationManifest(req.query.origin); }
    catch { check(false, 400, 'INVALID_API_ORIGIN', 'Use an HTTPS API origin or loopback HTTP.'); }
    return reply.header('Content-Disposition', 'attachment; filename="voiceos.integration.json"').send(manifest);
  });
  app.delete(projectPath + '/pairing', async req => {
    check(!req.headers.authorization, 403, 'PAIRING_REQUIRES_BROWSER', 'Revoke a pairing token from the browser.');
    const { actor, project } = scope(req);
    store.revokePair(actor, project);
    return { ok: true, data: { revoked: true } };
  });

  app.post(projectPath + '/capture/sessions', async req => update(req, 'capture.changed', state => startCapture(state, req.body ?? {})));
  app.post(projectPath + '/capture/sessions/:s/stop', async req => update(req, 'capture.changed', state => {
    const session = state.capture.sessions.find(item => item.id === req.params.s);
    check(session, 404, 'CAPTURE_UNAVAILABLE', 'This capture is unavailable.');
    if (session.status === 'active') session.status = 'stopped';
    return session;
  }));
  app.post(projectPath + '/capture/observations', async req => update(req, 'capture.changed', state => observe(state, req.body ?? {})));
  app.get(projectPath + '/capture/inbox', async req => read(req, inbox));
  app.post(projectPath + '/capture/observations/:o/preview', async req => update(req, null, (state, actor) =>
    capturePreview(state, req.params.o, req.body ?? {}, actor)));
  const removeCapture = async (req, id, discard) => {
    const result = update(req, 'capture.changed', state => revokeCapture(state, id, discard));
    await Promise.all(result.data.files.map(removeMedia));
    await Promise.all([...result.data.outputs.flatMap(job => [job.output, job.captions]), ...result.data.worlds.map(world => world.storage)]
      .filter(Boolean).map(file => rm(file, { force: true })));
    return { ok: true, revision: result.revision, data: { withdrawn: result.data.files.length } };
  };
  app.post(projectPath + '/capture/grants/:g/revoke', async req => removeCapture(req, req.params.g, false));
  app.post(projectPath + '/capture/observations/:o/discard', async req => removeCapture(req, req.params.o, true));
  app.post(projectPath + '/capture/sessions/:s/files', async req => {
    const { actor, project } = scope(req);
    const session = assertCapture(store.read(actor, project), req.params.s);
    check(session.source !== 'voiceos_text', 400, 'CAPTURE_SOURCE', 'This capture session expects text.');
    const file = await req.file();
    check(file, 400, 'FILE_REQUIRED', 'Select one media file.');
    const externalId = String(req.headers['x-capture-id'] || uid());
    check(externalId.length <= 128, 400, 'CAPTURE_ID', 'Invalid capture ID.');
    const item = await ingest(await file.toBuffer(), { name: file.filename, audio: session.source === 'browser_audio',
      keepLocation: session.locationMode === 'precise', dir: join(dataDir, 'projects', project) });
    let retained = false;
    try {
      return update(req, 'capture.changed', state => {
        assertCapture(state, session.id);
        const prior = state.capture.observations.find(entry => entry.sessionId === session.id && entry.externalId === externalId);
        const existing = prior ? mediaById(state, prior.mediaId) : state.media.find(media => !media.revoked && media.hash === item.hash);
        if (prior) check(existing?.hash === item.hash, 409, 'CAPTURE_CONFLICT', 'This capture ID refers to different content.');
        if (existing) return { media: cleanMedia(existing), observationId: prior?.id ?? null, duplicate: true };
        Object.assign(item, { pending: true, captureGrant: session.grantId });
        state.media.push(item);
        const result = observe(state, { sessionId: session.id, externalId, source: session.source, kind: 'media', capturedAt: item.capturedAt,
          location: null, mediaId: item.id });
        retained = true;
        return { ...result, media: cleanMedia(item) };
      });
    } finally {
      if (!retained) await removeMedia(item);
    }
  });

  app.get(projectPath + '/sources/:id', async (req, reply) => {
    const { actor, project } = scope(req);
    const state = store.read(actor, project);
    const source = mediaById(state, req.params.id);
    check(source, 404, 'SOURCE_NOT_FOUND', 'This source is unavailable.');
    if (source.demoFile) return streamFile(req, reply, join(demoDir, source.demoFile), source.mime);
    if (req.query.variant === 'thumb' && source.thumb) return streamFile(req, reply, source.thumb, 'image/jpeg');
    if (source.playback && req.query.variant !== 'original') return streamFile(req, reply, source.playback, 'audio/mp4');
    if (req.query.download === '1') reply.header('Content-Disposition', 'attachment');
    return streamFile(req, reply, source.storage, source.mime);
  });
  app.post(projectPath + '/memories/:eventId/worlds', async req => {
    check(req.query.consent === '1', 400, 'CONSENT_REQUIRED', 'Confirm you have permission to use this scene and all its sources.');
    const { actor, project } = scope(req);
    let sourceIds;
    try { sourceIds = req.query.sourceIds === undefined ? [req.query.sourceId] : JSON.parse(req.query.sourceIds); }
    catch { check(false, 400, 'INVALID_SOURCES', 'Choose the original images used to create this scene.'); }
    check(Array.isArray(sourceIds) && sourceIds.length > 0 && sourceIds.length <= 100 &&
      sourceIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128) && new Set(sourceIds).size === sourceIds.length,
      400, 'INVALID_SOURCES', 'Choose between 1 and 100 distinct original images used to create this scene.');
    sourceIds.sort();
    const provenance = req.query.provenance ?? 'imagined';
    check(['imagined', 'reconstructed'].includes(provenance), 400, 'INVALID_PROVENANCE', 'Identify the scene as a generated interpretation or a reconstructed scan.');
    for (const value of [req.query.provider, req.query.title]) {
      check(value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.length <= 120),
        400, 'INVALID_WORLD_DETAILS', 'Scene title and provider must be between 1 and 120 characters.');
    }
    const provider = req.query.provider?.trim() || 'Imported scene';
    const state = store.read(actor, project);
    const event = eventById(state, req.params.eventId);
    const sources = sourceIds.map(id => mediaById(state, id));
    check(sources.every(source => event?.sourceIds.includes(source?.id) && source?.provenance === 'original' && !source.pending && source.mime.startsWith('image/')),
      400, 'ORIGINAL_REQUIRED', 'Every scene source must be an available original image linked to this memory.');
    check(Number(req.query.expectedRevision) === state.revision, 409, 'REVISION_CONFLICT', 'Review the current memory before adding a world.');
    const file = await req.file();
    check(file, 400, 'FILE_REQUIRED', 'Choose an SPZ splat or GLB mesh.');
    const save = /\.glb$/i.test(file.filename) ? storeMesh : storeSplat;
    const asset = await save(await file.toBuffer(), file.filename, join(dataDir, 'projects', project));
    const title = req.query.title?.trim() || asset.title;
    const inputHash = digest({ eventId: event.id, sources: sources.map(source => [source.id, source.hash]),
      contentHash: asset.contentHash, provenance, provider, title });
    let retained = false;
    try {
      const result = update(req, 'revision.committed', current => {
        check(current.revision === state.revision, 409, 'REVISION_CONFLICT', 'The memory changed during upload. Review and try again.');
        check(sourceIds.every(id => {
          const source = mediaById(current, id);
          return eventById(current, event.id)?.sourceIds.includes(id) && source?.provenance === 'original' && !source.pending;
        }), 409, 'SOURCE_UNAVAILABLE', 'A scene source is no longer available.');
        const worlds = current.worlds ??= [];
        const existing = worlds.find(item => !item.revoked && item.status === 'ready' && item.inputHash === inputHash && item.eventId === event.id);
        if (existing) return { id: existing.id, duplicate: true };
        const world = { ...asset, title, eventId: event.id, status: 'ready', approval: 'pending', approved: false,
          sourceIds, provenance, provider, inputHash };
        worlds.push(world);
        appendChange(current, provenance === 'imagined' ? 'Imported a generated interpretation' : 'Imported a reconstructed scan', event.id);
        return { id: asset.id, duplicate: false };
      });
      retained = !result.data.duplicate;
      return result;
    } finally {
      if (!retained) await rm(asset.storage, { force: true });
    }
  });
  app.get(projectPath + '/memories/:id/scene-context', async req => read(req, (state, actor, project) => {
    const ids = typeof req.query.sources === 'string' ? req.query.sources.split(',') : [];
    return sceneContext(state, project, req.params.id, ids, req.query.world);
  }));
  app.get(projectPath + '/worlds/:id/:asset', async (req, reply) => {
    const { actor, project } = scope(req);
    const state = store.read(actor, project);
    const world = state.worlds?.find(item => item.id === req.params.id);
    check(world?.approved && !world.revoked && world.status === 'ready' && state.session.lens === 'all' &&
      world.sourceIds.every(id => mediaById(state, id) && eventById(state, world.eventId)?.sourceIds.includes(id)),
      404, 'WORLD_UNAVAILABLE', 'This scene is unavailable.');
    if (req.params.asset === 'plan.json') {
      check(world.plan && world.sceneManifest, 404, 'PLAN_UNAVAILABLE', 'This scene does not have a generation plan.');
      return reply.header('Content-Disposition', 'attachment; filename="everwhere-scene-plan.json"').send({
        version: 'everwhere-generation-1', contract: 'context and sceneManifest follow V3.1 definitions; this is not the full V3.1 exchange document',
        context: sceneContext(state, project, world.eventId, world.sourceIds, world.id),
        sceneManifest: { ...world.sceneManifest, revision: state.revision }, plan: handoffPlan(world.plan),
        unrealHandoff: 'GLB is metres/right-handed Y-up. Convert units and axes on import to Unreal centimetres/left-handed Z-up. Validate materials, collision, spawn and scale in Unreal; native Unreal import is not verified.'
      });
    }
    check(req.params.asset === (world.format === 'glb' ? 'scene.glb' : 'scene.spz'), 404, 'WORLD_UNAVAILABLE', 'This scene asset is unavailable.');
    if (req.query.download === '1') reply.header('Content-Disposition', 'attachment; filename="everwhere-memory.' + (world.format === 'glb' ? 'glb' : 'spz') + '"');
    return streamFile(req, reply, world.storage, world.format === 'glb' ? 'model/gltf-binary' : 'application/octet-stream');
  });
  app.get(projectPath + '/artifacts/:id/access', async req => read(req, (state, actor, project) => {
    const job = state.jobs.find(item => item.id === req.params.id);
    check(job?.status === 'ready' && job.approved, 404, 'ARTIFACT_UNAVAILABLE', 'Approve a current film before accessing it.');
    return { url: '/v1/projects/' + project + '/artifacts/' + job.id + '/file' };
  }));
  app.get(projectPath + '/artifacts/:id/:file', async (req, reply) => {
    const { actor, project } = scope(req);
    const job = store.read(actor, project).jobs.find(item => item.id === req.params.id);
    const captions = req.params.file === 'captions';
    check(job?.status === 'ready' && job.approved && ['file', 'captions'].includes(req.params.file), 404,
      'ARTIFACT_UNAVAILABLE', 'This export is unavailable or awaiting approval.');
    if (req.query.download === '1') reply.header('Content-Disposition', 'attachment; filename="everwhere-film.mp4"');
    return streamFile(req, reply, captions ? job.captions : job.output, captions ? 'text/vtt; charset=utf-8' : 'video/mp4');
  });

  app.post(projectPath + '/voice/:tool', async req => {
    check(req.headers.authorization, 401, 'VOICEOS_PAIRING_REQUIRED', 'Pair VoiceOS with this project first.');
    const input = req.body ?? {};
    const tool = req.params.tool;
    check(toolValidation.get(tool)?.(input), 400, 'INVALID_TOOL_INPUT', 'This voice action requires valid input.');
    scope(req);
    store.touchPair(/^Bearer (\S+)$/i.exec(req.headers.authorization)[1]);
    const active = state => input.eventId || state.session.eventId;
    const prepare = (type, payload) => update(req, null, (state, actor) => previewCommand(state, {
      type, targetId: active(state), payload: payload(state), expectedRevision: input.expectedRevision
    }, actor));
    switch (tool) {
      case 'get_context': return read(req, state => ({
        title: state.title, event: eventById(state, state.session.eventId)?.title ?? null, revision: state.revision, ...state.session,
        anchors: state.anchors.filter(item => item.eventId === state.session.eventId).map(({ id, title }) => ({ id, title })),
        jobs: state.jobs.slice(0, 5).map(({ id, status }) => ({ id, status }))
      }));
      case 'retrieve_media': return read(req, state => rank(state, input.query, input.eventId));
      case 'select_event': return update(req, 'session.changed', state => updateSession(state, { eventId: resolveEvent(state, input.query).id }));
      case 'navigate_anchor': return update(req, 'session.changed', state => updateSession(state, { anchorId: input.anchorId, view: 'explore' }));
      case 'switch_view': return update(req, 'session.changed', state => updateSession(state, { view: input.view }));
      case 'set_lens': {
        check(input.mode !== 'dream', 400, 'LENS_UNAVAILABLE', 'Dream mode is unavailable.');
        return update(req, 'session.changed', state => updateSession(state, { lens: input.mode === 'original' ? 'originals' : 'all' }));
      }
      case 'get_gap_question': return read(req, state => gapQuestion(state, active(state)));
      case 'get_scene_evidence': return read(req, state => voiceEvidence(evidenceFor(state, active(state))));
      case 'research_place': return researchPlace(req, read(req, active).data, input);
      case 'preview_memory_world': return update(req, null, (state, actor) => {
        const preview = previewWorld(state, { ...input, eventId: active(state) }, actor);
        return { ...preview, plan: handoffPlan(preview.plan) };
      });
      case 'preview_recollection': return prepare('recollection.add', () => ({ text: input.text, ...(input.anchorId && { anchorId: input.anchorId }) }));
      case 'preview_correction': return prepare('event.correct', () => ({ patch: input.patch }));
      case 'preview_style': return prepare('profile.set', () => ({ preset: input.preset }));
      case 'preview_undo': return update(req, null, (state, actor) => previewCommand(state, {
        type: 'undo', targetId: state.changes[0]?.targetId, expectedRevision: input.expectedRevision,
        payload: { revisionToUndo: state.changes[0]?.revision }
      }, actor));
      case 'preview_compile': return update(req, null, (state, actor) => {
        check(input.formats.length === 1 && input.formats[0] === 'film', 400, 'FORMAT_UNAVAILABLE', 'Voice compilation currently supports film.');
        return previewFilm(state, { eventId: state.session.eventId, expectedRevision: input.expectedRevision }, actor);
      });
      case 'confirm_change': {
        const previewKind = read(req, state => state.previews[input.previewToken]?.kind || (state.requests['film:' + input.requestId] ? 'film' : state.requests['world:' + input.requestId] ? 'world' : null)).data;
        if (previewKind === 'world') return confirmWorld(req, input);
        if (previewKind === 'film') {
          const result = update(req, 'job.changed', (state, actor) => {
            check(state.revision === input.expectedRevision || state.requests['film:' + input.requestId], 409, 'REVISION_CONFLICT', 'Review the current revision first.');
            return queueFilm(state, input, actor);
          });
          film.start();
          return result;
        }
        return update(req, 'revision.committed', (state, actor) => commitCommand(state, input, actor, true));
      }
      case 'get_job': return read(req, (state, actor, id) => {
        const job = getSnapshot(id, state).jobs.find(item => item.id === input.jobId);
        check(job, 404, 'JOB_NOT_FOUND', 'This render is unavailable.');
        return job;
      });
      case 'get_capture_inbox': return read(req, inbox);
      case 'preview_capture_link': return update(req, null, (state, actor) =>
        capturePreview(state, input.observationId, { ...input, expectedRevision: state.revision }, actor));
      default: check(false, 404, 'TOOL_UNAVAILABLE', 'This voice action is unavailable.');
    }
  });

  if (serveWeb && existsSync(buildDir)) {
    await app.register(staticFiles, { root: buildDir, wildcard: false, serve: false });
    app.get('/assets/*', (req, reply) => reply.sendFile('assets/' + req.params['*']));
    app.get('/environment/*', (req, reply) => reply.sendFile('environment/' + req.params['*']));
    app.get('/', (req, reply) => reply.sendFile('index.html', landingDir));
    app.get('/landing/*', (req, reply) => reply.sendFile(req.params['*'], landingDir));
    app.get('/app', (req, reply) => reply.sendFile('index.html'));
    app.get('/p/:id/:view', (req, reply) => reply.sendFile('index.html'));
  }
  return app;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const app = await createApp();
  const port = Number(process.env.PORT || 4173);
  await app.listen({ port, host: '0.0.0.0' });
  console.log('Everwhere listening on port ' + port);
}
