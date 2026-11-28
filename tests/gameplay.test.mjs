import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { PerspectiveCamera } from 'three';
import { PathRecorder, samplePath, simplifyPath, validatePath } from '../apps/web/src/gameplay/path.ts';
import { FrameMetrics } from '../apps/web/src/gameplay/performance.ts';
import { sceneContext } from '../packages/runtime/scene.mjs';
import { updateSession } from '../apps/api/service.mjs';

const manifest = () => ({ id: 'scene', planId: 'plan', revision: 2, format: 'glb', assetId: 'mesh', collisionAssetId: 'mesh',
  units: 'm', coordinateSystem: 'right-handed-y-up', scaleConfidence: null, boundsMin: [-10, 0, -10], boundsMax: [10, 10, 10],
  spawn: [0, 1.6, 0], anchors: [], capability: 'free_roam', provenance: 'reconstructed' });
const context = { projectId: 'project', eventId: 'event', revision: 2, policyVersion: 1, sourceIds: ['source'], inputHash: 'a'.repeat(64) };
const frame = (t, x) => ({ t, position: [x, 1.6, 0], quaternion: [0, 0, 0, 1], fov: 65 });

test('camera recording exports V3.1 definitions and replays deterministic normalized poses', () => {
  const camera = new PerspectiveCamera(65);
  camera.position.set(0, 1.6, 0);
  const recorder = new PathRecorder(camera, manifest(), () => true);
  recorder.start(context);
  for (let i = 1; i <= 200; i++) { camera.position.x = i / 100; recorder.update(0.05); }
  recorder.stop();
  assert.ok(recorder.path, recorder.message);
  const exported = recorder.export(context);
  const ajv = new Ajv({ strict: false }); formats(ajv);
  const schema = JSON.parse(readFileSync(new URL('../packages/contracts/engine-exchange.schema.json', import.meta.url)));
  ajv.addSchema(schema, 'exchange');
  for (const key of ['context', 'sceneManifest', 'cameraPath']) {
    const validate = ajv.compile({ $ref: 'exchange#/$defs/' + key });
    assert.ok(validate(exported[key]), JSON.stringify(validate.errors));
  }
  assert.equal(exported.cameraPath.keyframes.length, 2);
  const sample = samplePath(exported.cameraPath.keyframes, 5);
  assert.ok(Math.abs(sample.position[0] - 1) < 1e-8);
  recorder.replay(); recorder.advanceReplay(5);
  assert.ok(Math.abs(camera.position.x - 1) < 1e-8);
  assert.throws(() => recorder.export({ ...context, revision: 3 }), /changed/);
  assert.throws(() => recorder.export({ ...context, policyVersion: 2 }), /changed/);
});

test('path validation checks interpolated collision, bounds, time and quaternion', () => {
  const path = { id: 'path', sceneId: 'scene', revision: 2, provenance: 'reconstructed', keyframes: [frame(0, -1), frame(1, 1)] };
  assert.throws(() => validatePath(path, manifest(), p => Math.abs(p[0]) > 0.1), /collision/);
  assert.throws(() => validatePath({ ...path, keyframes: [frame(0, 0), frame(1, 30)] }, manifest(), () => true), /geometry/);
  assert.throws(() => validatePath({ ...path, keyframes: [frame(0, 0), frame(0, 1)] }, manifest(), () => true), /timestamps/);
  assert.throws(() => validatePath({ ...path, keyframes: [frame(0, 0), { ...frame(1, 1), quaternion: [0, 0, 0, 0] }] }, manifest(), () => true), /geometry/);
  const corner = [frame(0, 0), { ...frame(1, 1), position: [1, 1.6, 1] }, frame(2, 2)];
  assert.equal(simplifyPath(corner).length, 3);
});

test('automatic path stop caps an overshooting frame at the 60-second scene-film limit', () => {
  const camera = new PerspectiveCamera(65);
  camera.position.set(0, 1.6, 0);
  const recorder = new PathRecorder(camera, manifest(), () => true);
  recorder.start(context);
  recorder.update(59.98);
  camera.position.x = 0.01;
  recorder.update(0.15);
  assert.equal(recorder.recording, false);
  assert.ok(recorder.path, recorder.message);
  const exported = recorder.export(context);
  assert.equal(exported.cameraPath.keyframes.at(-1).t, 60);
  assert.deepEqual(exported.cameraPath.keyframes.at(-1).position, [0.01, 1.6, 0]);
  validatePath(exported.cameraPath, exported.sceneManifest, () => true);
});

test('frame metrics use nearest-rank median and p95 measured frame intervals', () => {
  const metrics = new FrameMetrics();
  for (let i = 0; i < 95; i++) metrics.record(20);
  for (let i = 0; i < 5; i++) metrics.record(100);
  assert.deepEqual(metrics.read(), { frames: 100, elapsedSeconds: 2.4, medianFps: 50, p95FrameMs: 20 });
  metrics.reset(); assert.equal(metrics.read().frames, 0);
});

test('scene context and navigation reject missing sources, revoked worlds and restricted lenses', () => {
  const state = { revision: 2, session: { lens: 'all' }, events: [{ id: 'event', sourceIds: ['source'] }],
    media: [{ id: 'source', provenance: 'original', hash: 'source-hash' }],
    worlds: [{ id: 'world', eventId: 'event', approved: true, sourceIds: ['source'] }],
    anchors: [{ id: 'anchor', eventId: 'event', worldId: 'world', sourceIds: ['source'] }] };
  assert.deepEqual(sceneContext(state, 'project', 'event', [], 'world').sourceIds, ['source']);
  updateSession(state, { anchorId: 'anchor' });
  state.session.lens = 'originals';
  assert.throws(() => sceneContext(state, 'project', 'event', [], 'world'));
  assert.throws(() => updateSession(state, { anchorId: 'anchor' }));
  state.session.lens = 'all'; state.worlds[0].revoked = true;
  assert.throws(() => sceneContext(state, 'project', 'event', [], 'world'));
  state.worlds[0].revoked = false; state.media[0].revoked = true;
  assert.throws(() => sceneContext(state, 'project', 'event', ['source']));
  assert.throws(() => updateSession(state, { anchorId: 'anchor' }));
});
