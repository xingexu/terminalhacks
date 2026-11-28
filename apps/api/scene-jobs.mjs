import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { appendChange, digest, eventById, sceneDependencies, mediaById, requireCondition as check, uid } from '../../packages/runtime/memory.mjs';
import { storeMesh } from '../../packages/media/mesh.mjs';
import { interpretPhoto, scenePython, visionModel } from './scene-plan.mjs';

const active = ['queued', 'interpreting', 'building'];
export const sceneInputHash = (state, eventId, sourceId) => digest(sceneDependencies(state, eventId, sourceId));

export function queueScene(state, input) {
  const { eventId, sourceId, description = '', expectedRevision, requestId, consent } = input;
  check(typeof requestId === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(requestId), 400, 'REQUEST_ID', 'A generation request ID is required.');
  const requestHash = digest(input);
  const jobs = state.sceneJobs ??= [];
  const replay = jobs.find(job => job.requestId === requestId);
  if (replay) {
    check(replay.requestHash === requestHash, 409, 'REQUEST_ID_REUSED', 'This request ID has different scene instructions.');
    return replay;
  }
  check(expectedRevision === state.revision, 409, 'REVISION_CONFLICT', 'The memory changed. Review it before generating.');
  check(consent === true, 400, 'CONSENT_REQUIRED', 'Confirm permission to send the scene instructions to Higgsfield.');
  check(typeof description === 'string' && description.length <= 4000, 400, 'DESCRIPTION_REQUIRED', 'Use a memory description of up to 4,000 characters.');
  const event = eventById(state, eventId);
  const source = mediaById(state, sourceId);
  check(event?.sourceIds.includes(sourceId) && source && !source.pending && source.provenance === 'original' && source.mime.startsWith('image/'),
    400, 'ORIGINAL_REQUIRED', 'Choose a confirmed original photo linked to this memory.');
  check(!jobs.some(job => active.includes(job.status)), 409, 'SCENE_BUSY', 'Wait for this project’s current scene generation to finish.');
  const job = { id: uid(), requestId, requestHash, eventId, sourceId, description: description.trim(), revision: state.revision,
    inputHash: sceneInputHash(state, eventId, sourceId), status: 'queued', createdAt: new Date().toISOString() };
  jobs.unshift(job);
  return job;
}

function currentInput(state, job) {
  return job && active.includes(job.status) && job.inputHash === sceneInputHash(state, job.eventId, job.sourceId) &&
    eventById(state, job.eventId)?.sourceIds.includes(job.sourceId) && mediaById(state, job.sourceId);
}

export function finishScene(state, jobId, asset, plan, providerProjectId) {
  const job = state.sceneJobs?.find(item => item.id === jobId);
  check(job && currentInput(state, job), 409, 'SCENE_STALE', 'The source memory changed during generation. Create a scene from its current version.');
  const world = { ...asset, title: eventById(state, job.eventId).title, eventId: job.eventId,
    status: 'ready', approval: 'pending', approved: false, sourceIds: [job.sourceId], provenance: 'reconstructed',
    inputHash: digest([job.inputHash, job.description, asset.contentHash]),
    generation: { provider: 'higgsfield', providerProjectId, model: visionModel, description: job.description,
      observed: plan.observed, inferred: plan.inferred, spawn: plan.spawn, lookAt: plan.lookAt, dependenciesHash: job.inputHash } };
  (state.worlds ??= []).push(world);
  Object.assign(job, { status: 'ready', worldId: world.id, plan: undefined, error: undefined });
  appendChange(state, 'Generated a scene from a photo and memory', job.eventId);
  return world;
}

async function downloadScene(result, signal) {
  const url = new URL(result.download?.url);
  const hosts = ['higgsfield.ai', 'cloudfront.net', 'amazonaws.com', 'r2.cloudflarestorage.com'];
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)),
    502, 'SCENE_DOWNLOAD', 'Higgsfield returned an unsupported scene download location.');
  const response = await fetch(url, { signal, redirect: 'error', headers: result.download.headers });
  check(response.ok && response.body, 502, 'SCENE_DOWNLOAD', 'The generated scene could not be downloaded.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= 48 * 1024 ** 2, 413, 'SCENE_SIZE', 'This generated scene exceeds the 48 MB limit. Try a simpler description.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createSceneWorker(store, dataDir, provider) {
  let running;
  let stopped = false;
  const abort = new AbortController();
  const patch = (actor, project, id, values) => store.update(actor, project, 'scene.changed', state => {
    const job = state.sceneJobs.find(item => item.id === id);
    check(job && currentInput(state, job), 409, 'SCENE_STALE', 'The memory changed during generation.');
    Object.assign(job, values);
    return job;
  }).data;
  const assertCurrent = (actor, project, id) => {
    const state = store.read(actor, project);
    const job = state.sceneJobs.find(item => item.id === id);
    check(job && currentInput(state, job), 409, 'SCENE_STALE', 'The memory changed during generation.');
    return job;
  };
  async function settle(client, projectId, operationId, first, signal) {
    let result = first;
    while (!['succeeded', 'failed', 'timed_out', 'expired'].includes(result.operation?.status)) {
      signal.throwIfAborted();
      await delay(1000, undefined, { signal });
      result = await client.call('scene_builder_3d_get_operation', { projectId, operationId, waitSeconds: 30 });
    }
    check(result.operation.status === 'succeeded', 502, 'SCENE_BUILD', 'Higgsfield could not finish the scene build. Review the scene in Higgsfield before retrying.');
    return result.operation;
  }
  async function build(actor, project, original) {
    let client;
    let asset;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20 * 60_000)]);
    try {
      let job = assertCurrent(actor, project, original.id);
      if (!job.plan) {
        patch(actor, project, job.id, { status: 'interpreting', error: undefined });
        const source = mediaById(store.read(actor, project), job.sourceId);
        const plan = await interpretPhoto(source.storage, job.description, signal);
        job = patch(actor, project, job.id, { plan, status: 'building' });
      }
      client = await provider.connect(actor);
      job = assertCurrent(actor, project, job.id);
      if (!job.providerProjectId) {
        const name = 'Everwhere ' + job.id;
        if (job.createAttempted) {
          let cursor;
          do {
            const list = await client.call('scene_builder_3d_list_projects', { limit: 50, ...(cursor && { cursor }) });
            const found = list.projects.find(item => item.name === name);
            if (found) { job = patch(actor, project, job.id, { providerProjectId: found.id }); break; }
            cursor = list.nextCursor;
          } while (cursor);
          check(job.providerProjectId, 502, 'SCENE_UNCONFIRMED', 'The Higgsfield project submission could not be confirmed. Check the account before starting another generation.');
        } else {
          patch(actor, project, job.id, { createAttempted: true });
          const created = await client.call('scene_builder_3d_create_project', { name });
          const id = created.projectId ?? created.project?.id;
          check(typeof id === 'string', 502, 'SCENE_UNCONFIRMED', 'The Higgsfield project submission could not be confirmed.');
          job = patch(actor, project, job.id, { providerProjectId: id });
        }
      }
      const projectId = job.providerProjectId;
      let operation;
      if (job.operationId) {
        operation = await settle(client, projectId, job.operationId,
          await client.call('scene_builder_3d_get_operation', { projectId, operationId: job.operationId, waitSeconds: 30 }), signal);
      } else {
        const details = await client.call('scene_builder_3d_get_project', { projectId });
        check(!details.project?.activeOperationId, 409, 'SCENE_BUSY', 'Another edit is running in the Higgsfield scene. Let it finish before retrying.');
        const queryId = job.id + '-inspect';
        const query = await settle(client, projectId, queryId, await client.call('scene_builder_3d_query_python', {
          projectId, operationId: queryId, code: "result = {'objects': len(bpy.context.scene.objects), 'units': bpy.context.scene.unit_settings.system}", waitSeconds: 8
        }), signal);
        check(Number.isInteger(query.revisionBefore) && Number.isInteger(query.sceneSequenceAfter), 502, 'SCENE_RESPONSE', 'The scene version could not be verified.');
        const code = scenePython(job.plan);
        const operationId = job.id + '-build';
        job = patch(actor, project, job.id, { operationId });
        operation = await settle(client, projectId, operationId, await client.call('scene_builder_3d_run_python', {
          projectId, operationId, code, revision: query.revisionBefore, expectedSceneSequence: query.sceneSequenceAfter, waitSeconds: 8
        }), signal);
      }
      assertCurrent(actor, project, job.id);
      check(Number.isInteger(operation.revisionAfter), 502, 'SCENE_RESPONSE', 'The generated scene revision could not be verified.');
      const download = await client.call('scene_builder_3d_get_glb', { projectId, revision: operation.revisionAfter });
      const bytes = await downloadScene(download, signal);
      asset = await storeMesh(bytes, 'Memory scene.glb', join(dataDir, 'projects', project));
      store.update(actor, project, 'revision.committed', state => finishScene(state, job.id, asset, job.plan, projectId));
      asset = undefined;
    } catch (error) {
      if (!stopped && store.read(actor, project, false)) store.update(actor, project, 'scene.changed', state => {
        const job = state.sceneJobs.find(item => item.id === original.id);
        const stale = !currentInput(state, job);
        Object.assign(job, { status: stale ? 'stale' : 'failed', error: stale ? 'The source memory changed. Generate again from the current version.' :
          error.status ? error.message : 'Scene generation was interrupted. Check Higgsfield and the local vision runtime before trying again.' });
      });
    } finally {
      if (asset) await rm(asset.storage, { force: true });
      await client?.close().catch(() => {});
    }
  }
  async function loop() {
    while (!stopped) {
      const entry = store.all().flatMap(({ id, actor, state }) => (state.sceneJobs ?? []).filter(job => active.includes(job.status)).map(job => ({ project: id, actor, job })))[0];
      if (!entry) break;
      await build(entry.actor, entry.project, entry.job);
    }
  }
  function kick() {
    if (!running && !stopped) running = loop().finally(() => { running = undefined; });
  }
  return { kick, async stop() { stopped = true; abort.abort(); await running; } };
}
