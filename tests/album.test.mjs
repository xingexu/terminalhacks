import assert from 'node:assert/strict';
import test from 'node:test';
import { albumEnd, nearbyPhoto, orderedPhotos, photoStops } from '../apps/web/src/album-layout.ts';
import { sourcesFor } from '../apps/web/src/model.ts';
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { collisionFromObject, worldSurfaceNormal } from '../apps/web/src/collision.ts';
import { Walker } from '../apps/web/src/walking.ts';

const photo = (id, capturedAt = null, provenance = 'original') => ({ id, mime: 'image/jpeg', caption: id, capturedAt, provenance });

test('album selection uses linked, available photos allowed by the current lens and orders capture dates', () => {
  const media = [photo('late', '2024-10-14'), photo('unknown'), photo('early', '2024-10-12'),
    photo('imagined', '2024-10-11', 'imagined'), { ...photo('clip'), mime: 'video/mp4' }, photo('unlinked')];
  const ids = ['late', 'unknown', 'early', 'imagined', 'clip', 'revoked'];
  const state = { media, session: { lens: 'originals' } };
  assert.deepEqual(orderedPhotos(sourcesFor(state, ids)).map(item => item.id), ['early', 'late', 'unknown']);
  assert.deepEqual(media.map(item => item.id), ['late', 'unknown', 'early', 'imagined', 'clip', 'unlinked']);
  state.session.lens = 'all';
  assert.deepEqual(orderedPhotos(sourcesFor(state, ids)).map(item => item.id), ['imagined', 'early', 'late', 'unknown']);
  assert.deepEqual(orderedPhotos([]), []);
});

function collisionRoom() {
  const group = new Group();
  const floor = new Mesh(new BoxGeometry(40, 1, 40));
  floor.position.y = -0.5;
  const wall = new Mesh(new BoxGeometry(30, 4, 0.2));
  wall.position.set(0, 2, -3);
  group.add(floor, wall);
  return new Octree().fromGraphNode(group);
}

test('capsule gravity grounds the player and sprinting collides with walls while allowing sliding', () => {
  const walker = new Walker(collisionRoom(), new Vector3(0, 2, 0));
  for (let i = 0; i < 120; i++) walker.update(1 / 60, 0, new Set());
  assert.ok(walker.grounded);
  assert.ok(Math.abs(walker.eye.y - 1.6) < 0.02);
  for (let i = 0; i < 180; i++) walker.update(1 / 60, 0, new Set(['w', 'shift']));
  assert.ok(walker.eye.z >= -2.61 && walker.eye.z < -2.5, 'capsule must stop in front of the wall');
  for (let i = 0; i < 60; i++) walker.update(1 / 60, 0, new Set(['w', 'd']));
  assert.ok(walker.eye.x > 1 && walker.eye.z >= -2.61, 'diagonal input should slide along the wall');
});

test('grounded walking can jump while pushing into a wall', () => {
  const walker = new Walker(collisionRoom(), new Vector3(0, 0.03, 0));
  for (let i = 0; i < 180; i++) walker.update(1 / 60, 0, new Set(['w']));
  assert.ok(walker.grounded);
  assert.ok(walker.eye.z >= -2.61);
  const baseline = walker.eye.y;
  walker.update(1 / 60, 0, new Set(['w', ' ']));
  assert.ok(walker.eye.y > baseline, 'floor support should allow jumping while the wall blocks forward movement');
});

test('fixed-step walking has consistent speed and jumping returns to the floor', () => {
  const room = collisionRoom();
  const lowRate = new Walker(room, new Vector3(0, 0.03, 10));
  const highRate = new Walker(room, new Vector3(0, 0.03, 10));
  for (let i = 0; i < 60; i++) lowRate.update(1 / 30, 0, new Set(['w']));
  for (let i = 0; i < 240; i++) highRate.update(1 / 120, 0, new Set(['w']));
  assert.ok(Math.abs(lowRate.eye.z - highRate.eye.z) < 0.04);
  const baseline = lowRate.eye.y;
  lowRate.update(1 / 30, 0, new Set([' ']));
  assert.ok(lowRate.eye.y > baseline);
  const risingVelocity = lowRate.velocity.y;
  lowRate.update(1 / 30, 0, new Set([' ']));
  assert.ok(lowRate.velocity.y < risingVelocity, 'jumping in the air must not add an impulse');
  for (let i = 0; i < 120; i++) lowRate.update(1 / 60, 0, new Set());
  assert.ok(lowRate.grounded && Math.abs(lowRate.eye.y - baseline) < 0.02);
});

test('collision triangles include translated mirrored instances with upward floor normals', () => {
  const scene = new Group();
  scene.position.x = 2;
  const floor = new InstancedMesh(new PlaneGeometry(4, 4), new MeshBasicMaterial(), 1);
  floor.rotation.x = -Math.PI / 2;
  floor.setMatrixAt(0, new Matrix4().compose(new Vector3(3, 0, 0), new Quaternion(), new Vector3(-1, 1, 1)));
  scene.add(floor);
  const collision = collisionFromObject(scene);
  assert.ok(worldSurfaceNormal(floor, new Vector3(0, 0, 1), 0).y > 0.99);
  const walker = new Walker(collision, new Vector3(5, 0.03, 0));
  for (let i = 0; i < 120; i++) walker.update(1 / 60, 0, new Set());
  assert.ok(walker.grounded && Math.abs(walker.eye.y - 1.6) < 0.02);
  collision.clear();
});

test('every photo receives a reachable stop and interaction requires proximity', () => {
  const stops = photoStops(Array.from({ length: 25 }, (_, index) => photo(String(index))));
  assert.equal(stops.length, 25);
  assert.equal(new Set(stops.map(stop => stop.x + ',' + stop.z)).size, 25);
  assert.equal(nearbyPhoto({ x: 0, z: 6 }, stops), undefined);
  for (const stop of stops) {
    const approach = { x: stop.x < 0 ? -1.8 : 1.8, z: stop.z };
    assert.equal(nearbyPhoto(approach, stops)?.sourceId, stop.sourceId);
    assert.ok(stop.z >= albumEnd(stops.length) + 2);
  }
});
