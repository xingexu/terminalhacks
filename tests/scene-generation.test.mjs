import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemory, appendChange, uid } from '../packages/runtime/memory.mjs';
import { createEvent, getSnapshot } from '../apps/api/service.mjs';
import { queueScene, finishScene } from '../apps/api/scene-jobs.mjs';
import { scenePython, validatePlan } from '../apps/api/scene-plan.mjs';

function setup() {
  const state = createMemory('Scene test');
  const event = createEvent(state, { title: 'Living room' });
  state.media.push({ id: 'photo', hash: 'original-photo-hash', provenance: 'original', mime: 'image/jpeg', caption: 'Living room' });
  event.sourceIds.push('photo');
  const input = { requestId: uid(), eventId: event.id, sourceId: 'photo', description: 'A red mug on the table', consent: true, expectedRevision: state.revision };
  const plan = { observed: 'A living room', inferred: 'The wall behind the camera', floorSize: [6, 6], floorColor: '#887766', height: 3, indoors: true,
    spawn: [0, 0.03, 2], lookAt: [0, 1.6, -2], parts: [0, 1, 2].map(index => ({ name: 'wall-' + index, shape: 'box', position: [index - 1, 1.5, -2.9], size: [1, 3, 0.2], yaw: 0, color: '#eeeeee', metallic: 0 })) };
  const asset = { id: uid(), storage: '/private/scene.glb', contentHash: 'generated-content-hash', format: 'glb', points: 24 };
  return { state, event, input, plan, asset };
}

test('scene requests are idempotent, source-linked, and require explicit permission', () => {
  const { state, input } = setup();
  assert.throws(() => queueScene(state, { ...input, consent: false }), { code: 'CONSENT_REQUIRED' });
  const job = queueScene(state, input);
  assert.equal(queueScene(state, input).id, job.id);
  assert.equal(state.sceneJobs.length, 1);
  assert.throws(() => queueScene(state, { ...input, description: 'Different details' }), { code: 'REQUEST_ID_REUSED' });
  assert.throws(() => queueScene(state, { ...input, requestId: uid() }), { code: 'SCENE_BUSY' });
  job.plan = { private: 'internal layout' };
  job.providerProjectId = 'provider-internal-id';
  const visible = getSnapshot('project', state).sceneJobs[0];
  assert.equal(visible.plan, undefined);
  assert.equal(visible.providerProjectId, undefined);
});

test('source revocation rejects late scene completion and invalidates published geometry', () => {
  const first = setup();
  const pending = queueScene(first.state, first.input);
  first.state.media[0].revoked = true;
  appendChange(first.state, 'Withdraw photo', first.event.id);
  assert.equal(pending.status, 'stale');
  assert.throws(() => finishScene(first.state, pending.id, first.asset, first.plan, 'provider-project'), { code: 'SCENE_STALE' });
  assert.equal(first.state.worlds.length, 0);

  const next = setup();
  const job = queueScene(next.state, next.input);
  const world = finishScene(next.state, job.id, next.asset, next.plan, 'provider-project');
  assert.equal(world.approved, false);
  assert.deepEqual(world.sourceIds, ['photo']);
  assert.equal(world.generation.description, next.input.description);
  world.approved = true;
  next.state.anchors.push({ id: uid(), eventId: next.event.id, worldId: world.id, sourceIds: ['photo'], position: [0, 1.6, 0] });
  appendChange(next.state, 'Saved waypoint', next.event.id);
  assert.equal(world.approved, true, 'Navigation changes preserve generated geometry');
  next.event.sourceIds = [];
  appendChange(next.state, 'Unlinked photo', next.event.id);
  assert.equal(world.approved, false);
  assert.equal(world.status, 'stale');
});

test('scene plans validate scale and spawn and keep model content out of executable code', () => {
  const { plan } = setup();
  assert.equal(validatePlan(plan), plan);
  assert.throws(() => validatePlan({ ...plan, spawn: [50, 0, 0] }), { code: 'SCENE_PLAN_INVALID' });
  assert.throws(() => validatePlan({ ...plan, height: NaN }), { code: 'SCENE_PLAN_INVALID' });
  plan.parts[0].name = "'); import os; print('unexpected')";
  const code = scenePython(plan);
  assert.ok(code.includes("base64.b64decode("));
  assert.ok(!code.includes('import os'));
  assert.ok(code.includes("'Floor'"));
  assert.ok(code.includes("'TRIANGULATE'"));
});
