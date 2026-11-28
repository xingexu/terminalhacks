import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AnimationMixer, Box3, DataTexture, RGBAFormat, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { generatePhotoSet } from '../packages/providers/world/photo-set.mjs';
import { storeMesh } from '../packages/media/mesh.mjs';
import { collisionFromObject, safeCameraPosition, validatedSceneSpawn } from '../apps/web/src/collision.ts';
import { Walker } from '../apps/web/src/walking.ts';

async function fixture() {
  return { id: 'photo-set-test-v1', title: 'An imagined photographic street', photos: await Promise.all(['street', 'door'].map(async (id, i) => ({
    id, jpeg: await sharp({ create: { width: 96, height: 54, channels: 3, background: i ? '#99441f' : '#b7c5d4' } }).jpeg().toBuffer()
  }))) };
}
function inspect(buffer) {
  const length = buffer.readUInt32LE(12);
  return { json: JSON.parse(buffer.toString('utf8', 20, 20 + length)), binary: buffer.subarray(28 + length) };
}
async function load(buffer) {
  const loader = new GLTFLoader();
  loader.register(parser => ({ name: 'PHOTO_SET_TEST_jpeg', async loadTexture(index) {
    const image = parser.json.images[parser.json.textures[index].source];
    const bytes = await parser.getDependency('bufferView', image.bufferView);
    const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const texture = new DataTexture(new Uint8Array(data), info.width, info.height, RGBAFormat);
    texture.flipY = false; texture.needsUpdate = true; return texture;
  } }));
  const result = await loader.parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '');
  result.scene.animations = result.animations;
  result.scene.updateMatrixWorld(true); return result.scene;
}
function dispose(scene) {
  const materials = new Set(), textures = new Set();
  scene.traverse(object => { if (!object.isMesh) return; object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) { materials.add(material); if (material.map) textures.add(material.map); }
  });
  [...materials, ...textures].forEach(item => item.dispose());
}
function move(walker, seconds, yaw, keys = new Set(['w'])) {
  for (let frame = 0; frame < Math.round(seconds * 120); frame++) walker.update(1 / 120, yaw, keys);
}

test('photo set embeds the exact photographic bytes and discloses authored geometry', async () => {
  const input = await fixture();
  const result = await generatePhotoSet(input);
  assert.deepEqual(result.buffer, (await generatePhotoSet(input)).buffer);
  const { json, binary } = inspect(result.buffer);
  assert.equal(json.asset.extras.provenance, 'imagined');
  assert.match(json.asset.extras.description, /not photogrammetry/);
  assert.equal(json.asset.extras.provider, 'photo-set-v1');
  assert.equal(json.asset.extras.planId, input.id);
  assert.ok(json.materials.every(material => material.extensions.KHR_materials_unlit));
  assert.ok(!JSON.stringify(json).includes('"uri"'));
  for (const [i, image] of json.images.entries()) {
    const view = json.bufferViews[image.bufferView];
    assert.deepEqual(binary.subarray(view.byteOffset, view.byteOffset + view.byteLength), input.photos[i].jpeg);
  }
});

test('real loader and importer accept bounded photographic geometry within demo budgets', async t => {
  const result = await generatePhotoSet(await fixture());
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-photo-set-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stored = await storeMesh(result.buffer, 'photo-set.glb', dir);
  assert.equal(stored.triangles, result.triangles);
  assert.ok(stored.triangles < 50_000);
  const scene = await load(result.buffer);
  try {
    const bounds = new Box3().setFromObject(scene);
    const collision = collisionFromObject(scene);
    assert.ok(validatedSceneSpawn(collision, bounds, result.spawn));
    scene.traverse(object => {
      if (!object.isMesh) return;
      assert.equal(object.material.isMeshBasicMaterial, true, 'Baked photographic color must remain unlit');
      assert.ok(Array.from(object.geometry.attributes.position.array).every(Number.isFinite));
      if (object.material.map) assert.ok(Array.from(object.geometry.attributes.uv.array).every(value => value >= 0 && value <= 1));
    });
  } finally { dispose(scene); }
});

test('actual Walker continuously advances then turns right into the entrance approach without falling or crossing walls', async () => {
  const result = await generatePhotoSet(await fixture());
  const scene = await load(result.buffer);
  try {
    const collision = collisionFromObject(scene);
    const walker = new Walker(collision, new Vector3(...result.spawn).add(new Vector3(0, -1.6, 0)));
    move(walker, .85, 0);
    assert.ok(walker.eye.z < 3.8 && walker.eye.z > 3.3, 'Forward movement must translate the camera through geometry');
    const beforeTurn = walker.eye.clone();
    move(walker, 1.7, -Math.PI / 2);
    assert.ok(walker.eye.x > 3.5 && walker.eye.x < 4.08, 'Right turn walks into a real alcove and stops at the door surface');
    assert.ok(Math.abs(walker.eye.z - beforeTurn.z) < .25);
    assert.ok(Math.abs(walker.eye.y - 1.6) < .03);
    assert.ok(safeCameraPosition(collision, walker.eye.toArray()));
    move(walker, 2, -Math.PI / 2);
    assert.ok(walker.eye.x < 4.08, 'Holding forward cannot cross the door');
  } finally { dispose(scene); }
});

test('photographic end and facade geometry bounds walking in every direction including a jump', async () => {
  const result = await generatePhotoSet(await fixture());
  const scene = await load(result.buffer);
  try {
    const collision = collisionFromObject(scene);
    for (const [yaw, axis, min, max] of [[0, 'z', -17.8, -17.5], [Math.PI, 'z', 8.5, 8.8], [Math.PI / 2, 'x', -4.3, -4.05]]) {
      const walker = new Walker(collision, new Vector3(...result.spawn).add(new Vector3(0, -1.6, 0)));
      move(walker, .1, yaw, new Set());
      move(walker, 10, yaw, new Set(['w', ' ']));
      assert.ok(walker.eye[axis] >= min && walker.eye[axis] <= max, `${axis} boundary escaped: ${walker.eye.toArray()}`);
      assert.ok(Math.abs(walker.eye.y - 1.6) < .03);
    }
  } finally { dispose(scene); }
});

test('photo set rejects duplicate sources and non-JPEG inputs', async () => {
  const input = await fixture();
  await assert.rejects(generatePhotoSet({ ...input, photos: [input.photos[0], input.photos[0]] }), /unique/);
  await assert.rejects(generatePhotoSet({ ...input, photos: [{ id: 'bad', jpeg: Buffer.from('not an image') }] }));
  await assert.rejects(generatePhotoSet({ ...input, setting: 'unknown' }), /setting/);
});

test('airshow exports real looping aircraft transforms that remain above the collision walking area', async () => {
  const input = await fixture();
  const result = await generatePhotoSet({ ...input, setting: 'airshow', photos: [input.photos[0]] });
  const scene = await load(result.buffer);
  const mixer = new AnimationMixer(scene);
  try {
    assert.equal(scene.animations.length, 1);
    assert.equal(scene.animations[0].duration, 40);
    const planes = scene.children.filter(node => node.name.startsWith('Moving_aircraft_'));
    assert.equal(planes.length, 3);
    const collision = collisionFromObject(scene);
    assert.ok(validatedSceneSpawn(collision, new Box3().setFromObject(scene), result.spawn));
    mixer.clipAction(scene.animations[0]).play(); mixer.update(0);
    const initial = planes.map(node => node.position.clone());
    mixer.update(5);
    planes.forEach((node, i) => { assert.ok(node.position.distanceTo(initial[i]) > 1); assert.ok(node.position.y > 6); });
    for (let i = 0; i < 35; i++) {
      mixer.update(1);
      planes.forEach(node => { assert.ok(node.position.y > 6); assert.ok(Math.abs(node.position.x) < 4); });
    }
    planes.forEach((node, i) => assert.ok(node.position.distanceTo(initial[i]) < .001, 'Loop returns continuously to its initial pose'));
  } finally { mixer.stopAllAction(); mixer.uncacheRoot(scene); dispose(scene); }
});
