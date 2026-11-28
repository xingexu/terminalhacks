import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { validatePath } from '../web/src/gameplay/path.ts';
import { digest, filmDependencies, now, requireCondition as check, uid } from '../../packages/runtime/memory.mjs';
import { sceneContext } from '../../packages/runtime/scene.mjs';
import { cleanJob, resolvePreview, savePreview } from './service.mjs';

const schema = JSON.parse(readFileSync(new URL('../../packages/contracts/engine-exchange.schema.json', import.meta.url)));
const ajv = new Ajv({ strict: false });
formats(ajv);
ajv.addSchema(schema, 'exchange');
const validateExport = ajv.compile({ type: 'object', additionalProperties: false,
  required: ['version', 'context', 'sceneManifest', 'cameraPath'], properties: {
    version: { const: '3.1-proposal' }, context: { $ref: 'exchange#/$defs/context' },
    sceneManifest: { $ref: 'exchange#/$defs/sceneManifest' }, cameraPath: { $ref: 'exchange#/$defs/cameraPath' }
  } });
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

function currentRecording(state, project, path) {
  check(validateExport(path), 400, 'INVALID_SCENE_PATH', 'Record a valid camera path in this world.');
  const { context, sceneManifest: manifest, cameraPath } = path;
  const world = state.worlds?.find(item => item.id === manifest.assetId && item.eventId === context.eventId);
  check(world?.format === 'glb' && world.approved && world.status === 'ready' && !world.revoked,
    409, 'SCENE_UNAVAILABLE', 'Approve a current walkable world before recording its film.');
  const current = sceneContext(state, project, context.eventId, [], world.id);
  check(digest(current) === digest(context), 409, 'SCENE_CHANGED', 'This memory or its permissions changed. Record a new camera path.');
  check(manifest.id === world.id && manifest.collisionAssetId === world.id && manifest.format === 'glb' &&
    manifest.revision === current.revision && cameraPath.provenance === world.provenance && manifest.provenance === world.provenance &&
    manifest.planId === (world.planId ?? 'import-' + world.id), 400, 'INVALID_SCENE_PATH', 'The camera path must describe this approved world.');
  const bounds = [...manifest.boundsMin, ...manifest.boundsMax];
  check(bounds.every(value => Number.isFinite(value) && Math.abs(value) <= 100000) &&
    manifest.boundsMin.every((value, index) => value < manifest.boundsMax[index]),
    400, 'INVALID_SCENE_PATH', 'The camera path has invalid scene bounds.');
  const durationSeconds = cameraPath.keyframes.at(-1)?.t;
  check(Number.isFinite(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 60,
    400, 'SCENE_FILM_LENGTH', 'Record a camera path between 30 and 60 seconds.');
  // Collision is checked against loaded geometry in the viewer; uploaded pixels are owner-reviewed, not attested.
  try { validatePath(cameraPath, manifest, () => true); }
  catch { check(false, 400, 'INVALID_SCENE_PATH', 'The camera path leaves its bounds or contains invalid movement.'); }
  return { worldId: world.id, worldTitle: world.title, provenance: world.provenance,
    durationSeconds, width: 1920, height: 1080, path: structuredClone(path) };
}

export function previewSceneFilm(state, input, actor, project) {
  check(input?.expectedRevision === state.revision, 409, 'REVISION_CONFLICT', 'Refresh this memory before reviewing the film.');
  const recording = currentRecording(state, project, input.path);
  const eventId = input.path.context.eventId;
  const manifest = filmDependencies(state, eventId, state.session.lens, recording);
  check(manifest?.storyboard.frames.length, 409, 'SCENE_UNAVAILABLE', 'The current world and its source evidence are unavailable.');
  const { path, ...summary } = recording;
  return savePreview(state, { kind: 'scene-film', actor, expectedRevision: state.revision, eventId,
    lens: state.session.lens, recording, inputHash: digest(manifest), diff: {
      label: 'Record this world as a 1080p film', recording: summary, storyboard: manifest.storyboard,
      sources: manifest.storyboard.sourceIds.length, narration: Boolean(manifest.narration),
      containsImagined: recording.provenance === 'imagined', cost: 'Local camera recording and render'
    } });
}

export function sceneFilmRequest(state, input, actor, project, contentHash) {
  check(text(input?.requestId) && text(input?.previewToken), 400, 'INVALID_REQUEST', 'Confirm a current scene-film review.');
  const saved = state.requests['scene-film:' + input.requestId];
  if (saved) {
    check(saved.hash === digest(input), 409, 'REQUEST_ID_REUSED', 'This request ID was used for a different scene-film review.');
    check(!saved.unavailable, 409, 'SCENE_FILM_UNAVAILABLE', 'This scene-film request was cancelled or its evidence was withdrawn.');
    check(!contentHash || contentHash === saved.contentHash, 409, 'REQUEST_ID_REUSED', 'This request ID was used for a different recording.');
    const job = state.jobs.find(item => item.id === saved.result.id);
    check(job, 409, 'SCENE_FILM_UNAVAILABLE', 'This film is unavailable. Review a new recording.');
    return { job: cleanJob(job) };
  }
  const preview = resolvePreview(state, input.previewToken, actor, 'scene-film');
  check(preview.expectedRevision === state.revision && preview.lens === state.session.lens,
    409, 'REVISION_CONFLICT', 'The memory changed during recording. Review a new camera path.');
  currentRecording(state, project, preview.recording.path);
  check(preview.inputHash === digest(filmDependencies(state, preview.eventId, preview.lens, preview.recording)),
    409, 'INPUT_CHANGED', 'The world or sources changed. Review a new scene film.');
  return { preview };
}

export function queueSceneFilm(state, input, asset, actor, project) {
  const checked = sceneFilmRequest(state, input, actor, project, asset.contentHash);
  if (checked.job) return { job: checked.job, retained: false };
  const { preview } = checked;
  check(state.jobs.filter(item => ['queued', 'running'].includes(item.status)).length < 2,
    429, 'RENDER_LIMIT', 'Wait for a film render to finish.');
  const manifest = filmDependencies(state, preview.eventId, preview.lens, preview.recording);
  manifest.sceneRecording.storage = asset.storage;
  const { path, ...recording } = preview.recording;
  const job = { id: uid(), kind: 'scene_recording', recording, eventId: preview.eventId, lens: preview.lens,
    manifest, inputHash: preview.inputHash, revision: state.revision, status: 'queued', approved: false, createdAt: now(), format: 'mp4' };
  state.jobs.unshift(job);
  delete state.previews[input.previewToken];
  state.requests['scene-film:' + input.requestId] = { hash: digest(input), contentHash: asset.contentHash, result: { id: job.id } };
  return { job: cleanJob(job), retained: true };
}

export function cancelSceneFilm(state, input, actor) {
  check(text(input?.requestId) && text(input?.previewToken), 400, 'INVALID_REQUEST', 'Choose a scene-film request to cancel.');
  const key = 'scene-film:' + input.requestId;
  const saved = state.requests[key];
  if (saved) check(saved.hash === digest(input), 409, 'REQUEST_ID_REUSED', 'This request ID was used for a different review.');
  const preview = state.previews[input.previewToken];
  if (preview) check(preview.kind === 'scene-film' && preview.actor === actor, 404, 'PREVIEW_UNAVAILABLE', 'This review is unavailable.');
  delete state.previews[input.previewToken];
  const job = state.jobs.find(item => item.id === saved?.result?.id);
  const files = job ? [job.manifest?.sceneRecording?.storage, job.output, job.captions].filter(Boolean) : [];
  if (job) {
    Object.assign(job, { status: 'stale', approved: false, error: 'Scene-film recording cancelled. Record again to retry.' });
    for (const key of ['manifest', 'output', 'captions', 'contentHash', 'recording']) delete job[key];
  }
  state.requests[key] = { hash: digest(input), unavailable: true, result: { id: job?.id, cancelled: true } };
  return files;
}
