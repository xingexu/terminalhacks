import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createMemory, appendChange, uid } from '../packages/runtime/memory.mjs';
import { createEvent, getSnapshot } from '../apps/api/service.mjs';
import { createSceneWorker, queueScene, finishScene } from '../apps/api/scene-jobs.mjs';
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

function queuedWorker() {
  const context = setup();
  const job = queueScene(context.state, context.input);
  Object.assign(job, { status: 'queued', plan: context.plan, providerProjectId: 'provider-project',
    operationId: 'previous-build', operationBaseRevision: 4, retryRequested: true });
  return { ...context, job };
}

async function runWorker(state, respond) {
  const calls = [];
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const store = {
    read: () => state,
    all: () => [{ id: 'project', actor: 'actor', state }],
    update: (_actor, _project, _kind, mutate) => {
      const data = mutate(state);
      if (state.sceneJobs.some(job => ['failed', 'ready', 'stale'].includes(job.status))) finish();
      return { data };
    }
  };
  const provider = { connect: async () => ({
    call: async (name, args) => { calls.push({ name, args }); return respond(name, args); },
    close: async () => {}
  }) };
  const worker = createSceneWorker(store, '/private/scenes', provider);
  worker.kick();
  const timeout = new AbortController();
  try {
    await Promise.race([finished, delay(5000, undefined, { signal: timeout.signal }).then(() => {
      throw new Error('Scene worker did not settle');
    })]);
  } finally { timeout.abort(); }
  await worker.stop();
  return calls;
}

test('scene worker retries terminal failures with fresh guarded operation IDs', async () => {
  const { state, job, plan } = queuedWorker();
  delete job.operationBaseRevision;
  let queryCount = 0;
  const respond = async (name, args) => {
    if (name === 'scene_builder_3d_get_operation') {
      assert.equal(args.operationId, 'previous-build');
      return { operation: { status: 'failed', baseRevision: 4 } };
    }
    if (name === 'scene_builder_3d_get_project') return { project: { activeOperationId: null } };
    if (name === 'scene_builder_3d_query_python') {
      queryCount++;
      return queryCount === 1
        ? { operation: { status: 'failed' } }
        : { operation: { status: 'succeeded', revisionBefore: 4, sceneSequenceAfter: 27 } };
    }
    if (name === 'scene_builder_3d_run_python') {
      assert.equal(job.operationId, args.operationId, 'Persist the fresh mutation ID before submission');
      assert.equal(job.operationBaseRevision, args.revision, 'Persist the revision guard before submission');
      return { operation: { status: 'failed', revisionBefore: 4 } };
    }
    assert.fail('Unexpected Higgsfield operation: ' + name);
  };

  const first = await runWorker(state, respond);
  assert.equal(first.filter(call => call.name === 'scene_builder_3d_run_python').length, 0);
  const firstQueryId = first.find(call => call.name === 'scene_builder_3d_query_python').args.operationId;
  assert.equal(job.operationId, 'previous-build');
  assert.equal(job.status, 'failed');

  job.status = 'queued';
  job.error = undefined;
  job.retryRequested = true;
  const second = await runWorker(state, respond);
  const secondQueryId = second.find(call => call.name === 'scene_builder_3d_query_python').args.operationId;
  const run = second.find(call => call.name === 'scene_builder_3d_run_python');
  assert.notEqual(firstQueryId, secondQueryId);
  assert.notEqual(secondQueryId, job.id + '-inspect');
  assert.notEqual(run.args.operationId, 'previous-build');
  assert.equal(run.args.revision, 4);
  assert.equal(run.args.expectedSceneSequence, 27);
  assert.equal(job.operationId, run.args.operationId);
  assert.equal(job.operationBaseRevision, 4);
  assert.equal(job.retryRequested, false);
  assert.equal(job.providerProjectId, 'provider-project');
  assert.equal(job.plan, plan);
});

test('scene worker refuses to retry a failed mutation after the provider scene changed', async () => {
  const { state, job } = queuedWorker();
  job.operationBaseRevision = 3;
  const calls = await runWorker(state, async name => {
    if (name === 'scene_builder_3d_get_operation') return { operation: { status: 'failed', revisionBefore: 4 } };
    if (name === 'scene_builder_3d_get_project') return { project: { activeOperationId: null } };
    if (name === 'scene_builder_3d_query_python') return { operation: { status: 'succeeded', revisionBefore: 4, sceneSequenceAfter: 28 } };
    assert.fail('Unexpected Higgsfield operation: ' + name);
  });
  assert.equal(calls.some(call => call.name === 'scene_builder_3d_run_python'), false);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /scene changed after the failed generation/i);
  assert.equal(job.operationId, 'previous-build');
});

test('scene worker retains unresolved mutation IDs without replay', async () => {
  for (const missingStatus of [false, true]) {
    const { state, job } = queuedWorker();
    const originalId = job.operationId;
    const calls = await runWorker(state, async name => {
      assert.equal(name, 'scene_builder_3d_get_operation');
      if (missingStatus) return { operation: {} };
      throw new Error('Temporary operation lookup failure');
    });
    assert.equal(calls[0].args.operationId, originalId);
    assert.equal(calls.some(call => call.name === 'scene_builder_3d_run_python'), false);
    assert.equal(calls.some(call => call.name === 'scene_builder_3d_query_python'), false);
    assert.equal(job.operationId, originalId);
    assert.equal(job.status, 'failed');
    if (missingStatus) assert.match(job.error, /invalid operation status/i);
  }
});

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
