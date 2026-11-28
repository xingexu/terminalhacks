import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../packages/runtime/memory.mjs';
import { revokeCapture, startCapture, updateSession } from '../apps/api/service.mjs';
import { createStore } from '../apps/api/store.mjs';

const position = [0, 1.60801, 10.723478168268377];
const unavailable = error => error.status === 404 && error.code === 'ANCHOR_NOT_FOUND';

function fixture(provider = 'local-procedural-v1') {
  const state = createMemory('Waypoint regression', true);
  state.session.anchorId = null;
  state.worlds.push({ id: 'world', eventId: 'e-lake', format: 'glb', status: 'ready', approved: true,
    provider, provenance: provider ? 'imagined' : 'reconstructed', sourceIds: ['m-lake'] });
  state.anchors.push({ id: 'manual', eventId: 'e-lake', worldId: 'world', sourceIds: [], position, title: 'Saved place' });
  return state;
}

for (const [kind, provider] of [['generated', 'local-procedural-v1'], ['imported', null]]) {
  test(`a ${kind} world waypoint without a photo association is selectable and survives reload`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'everwhere-waypoints-'));
    let store = createStore(dir);
    try {
      const actor = 'owner';
      const project = store.create(actor, 'Waypoint test');
      store.update(actor, project.id, null, state => Object.assign(state, fixture(provider)));
      store.update(actor, project.id, 'session.changed', state => updateSession(state, { anchorId: 'manual' }));
      store.close();
      store = createStore(dir);
      const restored = store.read(actor, project.id);
      assert.equal(restored.session.anchorId, 'manual');
      assert.equal(restored.session.eventId, 'e-lake');
      assert.deepEqual(restored.anchors.find(anchor => anchor.id === 'manual').position, position);
      assert.deepEqual(restored.anchors.find(anchor => anchor.id === 'manual').sourceIds, []);
      assert.throws(() => store.read('another-owner', project.id), error => error.code === 'PROJECT_NOT_FOUND');
      const otherProject = store.create(actor, 'Other project');
      assert.throws(() => store.update(actor, otherProject.id, 'session.changed', state => updateSession(state, { anchorId: 'manual' })), unavailable);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('source-free world navigation still requires active approved context and all available world evidence', () => {
  const changes = [
    state => { state.session.lens = 'originals'; },
    state => { state.worlds[0].approved = false; },
    state => { state.worlds[0].revoked = true; },
    state => { state.worlds[0].status = 'stale'; },
    state => { state.worlds[0].status = 'failed'; },
    state => { state.worlds = []; },
    state => { state.worlds[0].eventId = 'e-cabin'; },
    state => { state.worlds[0].sourceIds = []; },
    state => { state.worlds[0].sourceIds = ['missing']; },
    state => { state.worlds[0].sourceIds = ['m-cabin']; },
    state => { state.media.find(source => source.id === 'm-lake').pending = true; },
    state => { state.media.find(source => source.id === 'm-lake').revoked = true; },
    state => { state.anchors.find(anchor => anchor.id === 'manual').sourceIds = ['missing']; }
  ];
  for (const change of changes) {
    const state = fixture();
    change(state);
    assert.throws(() => updateSession(state, { anchorId: 'manual' }), unavailable);
    assert.equal(state.session.anchorId, null);
  }
});

test('photo-album waypoints still require their own available photo association', () => {
  const state = fixture();
  const anchor = state.anchors.find(item => item.id === 'manual');
  anchor.worldId = 'trail-e-lake';
  assert.throws(() => updateSession(state, { anchorId: anchor.id }), unavailable);
  anchor.sourceIds = ['m-lake'];
  updateSession(state, { anchorId: anchor.id });
  assert.equal(state.session.anchorId, anchor.id);
});

test('unrelated revocation preserves manual world places, but revoking their world removes them', () => {
  const state = fixture();
  const unrelated = startCapture(state, { source: 'selected_file', consent: true });
  state.media.push({ id: 'unrelated', caption: 'Other photo', provenance: 'original', captureGrant: unrelated.grantId });
  state.session.anchorId = 'manual';
  revokeCapture(state, unrelated.grantId);
  assert.ok(state.anchors.some(anchor => anchor.id === 'manual'));
  assert.equal(state.session.anchorId, 'manual');
  const sourceCapture = startCapture(state, { source: 'selected_file', consent: true });
  state.media.find(source => source.id === 'm-lake').captureGrant = sourceCapture.grantId;
  state.recollections.push({ id: 'account', eventId: 'e-lake', anchorId: 'manual', text: 'Independent account.' });
  revokeCapture(state, sourceCapture.grantId);
  assert.equal(state.anchors.some(anchor => anchor.id === 'manual'), false);
  assert.equal(state.session.anchorId, null);
  assert.equal(state.recollections.find(item => item.id === 'account').anchorId, undefined);
});
