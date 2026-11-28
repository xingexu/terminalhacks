import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemory, digest, generationDependencies } from '../packages/runtime/memory.mjs';
import {
  capturePreview, commitCommand, getSnapshot, observe, previewCommand, previewFilm, queueFilm,
  revokeCapture, startCapture
} from '../apps/api/service.mjs';

const actor = 'private-reviewer';

function commit(state, type, payload, targetId = 'e-lake') {
  const command = { type, payload, targetId, expectedRevision: state.revision };
  const preview = previewCommand(state, command, actor);
  const input = { ...command, previewToken: preview.previewToken, requestId: randomUUID() };
  return { input, result: commitCommand(state, input, actor) };
}

function capturedText(state, text) {
  const session = startCapture(state, { source: 'voiceos_text', consent: true });
  const { observationId } = observe(state, {
    sessionId: session.id, externalId: randomUUID(), source: 'voiceos_text', kind: 'recollection',
    capturedAt: null, location: null, text
  });
  const preview = capturePreview(state, observationId, { eventId: 'e-lake', expectedRevision: state.revision }, actor);
  commitCommand(state, { ...preview.command, previewToken: preview.previewToken, requestId: randomUUID() }, actor);
  return { session, observation: state.capture.observations.find(item => item.id === observationId) };
}

function queue(state, eventId = 'e-lake') {
  const preview = previewFilm(state, { eventId, expectedRevision: state.revision }, actor);
  const input = { previewToken: preview.previewToken, requestId: randomUUID() };
  const result = queueFilm(state, input, actor);
  return { input, job: state.jobs.find(item => item.id === result.id) };
}

function world(state, sourceIds, recollectionIds = []) {
  const evidenceRefs = { mediaIds: sourceIds, recollectionIds };
  const item = {
    id: randomUUID(), eventId: 'e-lake', sourceIds, evidenceRefs, provider: 'local-procedural-v1',
    provenance: 'imagined', status: 'ready', approved: false, storage: '/private/world.glb',
    inputHash: digest('test plan'), contentHash: digest('test mesh'),
    evidenceHash: digest(generationDependencies(state, 'e-lake', evidenceRefs)),
    plan: { evidence: generationDependencies(state, 'e-lake', evidenceRefs) }
  };
  state.worlds.push(item);
  return item;
}

const revoked = error => error.status === 409 && error.code === 'EVIDENCE_REVOKED';

test('withdrawn text is removed from all persisted film copies and affected cached approvals cannot replay', () => {
  let state = createMemory('Private test', true);
  const unrelated = queue(state, 'e-cabin');
  unrelated.job.status = 'ready';
  const secret = 'A private account that must disappear from every retained film manifest.';
  const capture = capturedText(state, secret);
  const film = queue(state);
  Object.assign(film.job, { status: 'ready', contentHash: digest('film bytes'), output: '/private/film.mp4', captions: '/private/film.srt' });
  const approval = commit(state, 'artifact.approve', { artifactId: film.job.id, dependencyHash: film.job.inputHash });
  // Simulate the store's JSON round-trip: manifests are independent retained copies.
  state = JSON.parse(JSON.stringify(state));
  const removed = revokeCapture(state, capture.session.grantId);
  const stored = state.jobs.find(item => item.id === film.job.id);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(stored.status, 'stale');
  assert.equal(stored.approved, false);
  assert.equal(stored.manifest, undefined);
  assert.equal(stored.output, undefined);
  assert.equal(stored.captions, undefined);
  assert.equal(stored.contentHash, undefined);
  assert.deepEqual(removed.outputs, [{ id: film.job.id, output: '/private/film.mp4', captions: '/private/film.srt' }]);
  assert.throws(() => queueFilm(state, film.input, actor), revoked);
  assert.throws(() => commitCommand(state, approval.input, actor), revoked);
  const { requestId, previewToken, expectedRevision } = approval.input;
  assert.throws(() => commitCommand(state, { requestId, previewToken, expectedRevision }, actor, true), revoked);
  const kept = state.jobs.find(item => item.id === unrelated.job.id);
  assert.equal(kept.status, 'ready');
  assert.ok(kept.manifest);
  assert.equal(queueFilm(state, unrelated.input, actor).id, kept.id);
  assert.doesNotThrow(() => getSnapshot('project', state));
  assert.deepEqual(revokeCapture(state, capture.session.grantId).outputs, []);
});

for (const status of ['queued', 'running', 'stale', 'failed']) {
  test(`revoking text scrubs a ${status} film even without a completed output`, () => {
    let state = createMemory('Private test', true);
    const secret = `Withdraw this account from the ${status} film.`;
    const capture = capturedText(state, secret);
    const film = queue(state);
    film.job.status = status;
    state = JSON.parse(JSON.stringify(state));
    const result = revokeCapture(state, capture.session.grantId);
    assert.equal(result.outputs[0].id, film.job.id);
    assert.equal(JSON.stringify(state).includes(secret), false);
    assert.equal(state.jobs[0].status, 'stale');
    assert.equal(state.jobs[0].manifest, undefined);
    assert.equal(state.requests['film:' + film.input.requestId].unavailable, true);
  });
}

test('revoking a photo removes unsupported anchor titles and tombstones approval results for its world', () => {
  let state = createMemory('Private test', true);
  const session = startCapture(state, { source: 'selected_file', consent: true });
  const photo = { id: 'private-photo', caption: 'Sensitive photo filename.jpg', mime: 'image/jpeg', provenance: 'original', captureGrant: session.grantId };
  state.media.push(photo);
  commit(state, 'event.media.link', { mediaId: photo.id, relation: 'depicts' });
  const generated = world(state, [photo.id]);
  state.anchors.push(
    { id: 'private-stop', eventId: 'e-lake', worldId: generated.id, sourceIds: [photo.id], title: photo.caption, position: [1, 1.6, 1] },
    { id: 'shared-stop', eventId: 'e-lake', worldId: 'trail-e-lake', sourceIds: [photo.id, 'm-lake'], title: 'Shared waypoint', position: [0, 0, 0] }
  );
  state.session.anchorId = 'private-stop';
  commit(state, 'recollection.add', { text: 'Keep this independently entered account.', anchorId: 'private-stop' });
  const approval = commit(state, 'artifact.approve', { artifactId: generated.id, dependencyHash: generated.inputHash });
  assert.equal(commitCommand(state, approval.input, actor).artifactId, generated.id);
  const pendingLink = previewCommand(state, { type: 'event.media.link', targetId: 'e-cabin', expectedRevision: state.revision,
    payload: { mediaId: photo.id, relation: 'depicts' } }, actor);
  state = JSON.parse(JSON.stringify(state));
  const result = revokeCapture(state, session.grantId);
  assert.equal(result.worlds[0].id, generated.id);
  assert.equal(state.worlds[0].revoked, true);
  assert.equal(state.worlds[0].plan, undefined);
  assert.equal(state.session.anchorId, null);
  assert.equal(state.recollections[0].anchorId, undefined);
  assert.equal(state.recollections[0].text, 'Keep this independently entered account.');
  assert.equal(state.anchors.some(item => item.id === 'private-stop'), false);
  assert.deepEqual(state.anchors.find(item => item.id === 'shared-stop').sourceIds, ['m-lake']);
  assert.equal(getSnapshot('project', state).anchors.some(item => item.title === photo.caption), false);
  assert.equal(JSON.stringify(getSnapshot('project', state)).includes(photo.caption), false);
  assert.equal(JSON.stringify(state).includes(photo.caption), false);
  assert.equal(state.media.find(item => item.id === photo.id).caption, 'Withdrawn source');
  assert.equal(state.previews[pendingLink.previewToken], undefined);
  assert.throws(() => commitCommand(state, approval.input, actor), revoked);
  const { requestId, previewToken, expectedRevision } = approval.input;
  assert.throws(() => commitCommand(state, { requestId, previewToken, expectedRevision }, actor, true), revoked);
  assert.equal(state.requests['command:' + requestId].result.contentHash, undefined);
});

test('capture provenance survives undo so revocation removes the old film and world evidence', () => {
  let state = createMemory('Private test', true);
  const secret = 'This account was undone before its capture grant was revoked.';
  const capture = capturedText(state, secret);
  assert.equal(capture.observation.recollectionId, state.recollections[0].id);
  const generated = world(state, ['m-lake'], [capture.observation.recollectionId]);
  const film = queue(state);
  Object.assign(film.job, { status: 'ready', output: '/private/undone-film.mp4', captions: '/private/undone-film.srt' });
  commit(state, 'undo', { revisionToUndo: capture.observation.reviewRevision });
  assert.equal(state.recollections.length, 0);
  assert.equal(state.changes.some(item => item.id === capture.observation.recollectionId), false);
  state = JSON.parse(JSON.stringify(state));
  const result = revokeCapture(state, capture.session.grantId);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(result.worlds[0].id, generated.id);
  assert.equal(state.worlds[0].revoked, true);
  assert.equal(result.outputs[0].id, film.job.id);
});

test('existing captures without a saved recollection ID still revoke through their undo entry', () => {
  let state = createMemory('Private test', true);
  const secret = 'An account captured before stable provenance was recorded.';
  const capture = capturedText(state, secret);
  delete capture.observation.recollectionId;
  queue(state);
  state = JSON.parse(JSON.stringify(state));
  revokeCapture(state, capture.session.grantId);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(state.jobs[0].status, 'stale');
});
