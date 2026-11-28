import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Box3, BoxGeometry, DataTexture, Group, Mesh, Ray, RGBAFormat, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { collisionFromObject, safeCameraPosition, validatedSceneSpawn } from '../apps/web/src/collision.ts';
import { Walker } from '../apps/web/src/walking.ts';
import { generateWorld } from '../packages/providers/world/procedural.mjs';
import { storeMesh } from '../packages/media/mesh.mjs';

const plan = { id: 'memory-world', title: 'A day together', inputHash: 'a'.repeat(64), environment: 'mountain', season: 'green' };
const environments = ['mountain', 'coast', 'forest', 'urban', 'open'];
const seasons = ['green', 'snow', 'autumn'];

async function photos() {
  return Promise.all(Array.from({ length: 6 }, async (_, i) => ({ id: `original-${i}`,
    jpeg: await sharp({ create: { width: i % 2 ? 80 : 120, height: i % 2 ? 120 : 80, channels: 3,
      background: { r: 40 + 30 * i, g: 120, b: 160 - 20 * i } } }).jpeg().toBuffer() })));
}

function inspect(buffer) {
  const length = buffer.readUInt32LE(12);
  return { json: JSON.parse(buffer.toString('utf8', 20, 20 + length)), binary: buffer.subarray(28 + length) };
}

// The real GLTFLoader parses hierarchy, accessors, transforms and materials.
// Only browser image decoding is replaced: sharp decodes the actual embedded JPEG
// into a real Three DataTexture, avoiding DOM/ImageBitmap mocks in Node.
async function load(buffer) {
  const loader = new GLTFLoader();
  loader.register(parser => ({ name: 'TEST_node_jpeg_decoder', async loadTexture(index) {
    const source = parser.json.images[parser.json.textures[index].source];
    assert.equal(source.mimeType, 'image/jpeg');
    const bytes = await parser.getDependency('bufferView', source.bufferView);
    const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const texture = new DataTexture(new Uint8Array(data), info.width, info.height, RGBAFormat);
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  } }));
  const result = await loader.parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '');
  result.scene.updateMatrixWorld(true);
  return result.scene;
}

function dispose(scene) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  scene.traverse(object => {
    if (!object.isMesh) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
  });
  for (const value of [...textures, ...materials, ...geometries]) value.dispose();
}

test('procedural worlds are byte deterministic and embed original photos without external assets', async () => {
  const inputs = await photos();
  const first = await generateWorld(plan, inputs);
  const second = await generateWorld({ ...plan }, inputs.map(photo => ({ ...photo, jpeg: Buffer.from(photo.jpeg) })));
  assert.deepEqual(first, second);
  const otherSeed = await generateWorld({ ...plan, inputHash: 'b'.repeat(64) }, inputs);
  assert.notDeepEqual(first.buffer, otherSeed.buffer);
  const { json, binary } = inspect(first.buffer);
  assert.equal(json.asset.extras.provenance, 'imagined');
  assert.equal(json.asset.extras.coordinateSystem, 'right-handed-y-up');
  assert.equal(json.images.length, inputs.length);
  assert.equal(json.textures.length, inputs.length);
  for (const [i, image] of json.images.entries()) {
    assert.equal(image.mimeType, 'image/jpeg');
    const view = json.bufferViews[image.bufferView];
    assert.deepEqual(binary.subarray(view.byteOffset, view.byteOffset + view.byteLength), inputs[i].jpeg);
    assert.equal(json.nodes.filter(node => node.extras?.sourceId === inputs[i].id).length, 1);
  }
  assert.ok(!JSON.stringify(json).includes('"uri"'));
  assert.deepEqual(first.photoStops.map(stop => stop.sourceId), inputs.map(photo => photo.id));
  for (const view of json.bufferViews) {
    assert.equal(view.byteOffset % 4, 0);
    assert.ok(view.byteOffset + view.byteLength <= binary.length);
  }
});

test('all environment/season variants pass storeMesh and GLTFLoader with usable geometry and photos', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-procedural-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputs = await photos();
  for (const environment of environments) for (const season of seasons) {
    await t.test(`${environment}/${season}`, async () => {
      const result = await generateWorld({ ...plan, environment, season }, inputs);
      const stored = await storeMesh(result.buffer, `${environment}-${season}.glb`, dir);
      assert.ok(stored.triangles > 100 && stored.triangles < 250_000, stored.triangles);
      assert.ok(result.buffer.length < 4 * 1024 ** 2, 'Thumbnail scene should remain small');
      const scene = await load(result.buffer);
      try {
        let triangles = 0, textured = 0;
        scene.traverse(object => {
          if (!object.isMesh) return;
          const position = object.geometry.getAttribute('position');
          triangles += (object.geometry.index?.count ?? position.count) / 3;
          assert.ok(Array.from(position.array).every(Number.isFinite));
          assert.ok(object.scale.toArray().every(value => value > 0));
          if (object.material.map) {
            textured++;
            const uv = object.geometry.getAttribute('uv');
            assert.ok(uv);
            // Real GLTFLoader uses unflipped embedded images: top vertices need v=0.
            for (let i = 0; i < position.count; i++) {
              assert.equal(uv.getY(i), position.getY(i) > 0 ? 0 : 1);
            }
            assert.ok(object.material.map.image.width > 0);
          }
        });
        assert.equal(triangles, stored.triangles);
        assert.equal(textured, inputs.length);
        const bounds = new Box3().setFromObject(scene);
        for (const [actual, expected] of [[bounds.min.toArray(), result.boundsMin], [bounds.max.toArray(), result.boundsMax]]) {
          actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 0.0001));
        }
        assert.deepEqual(result.spawn, [0, 1.6, 14]);
        const collision = collisionFromObject(scene);
        const spawn = validatedSceneSpawn(collision, bounds, result.spawn);
        assert.ok(spawn, 'Generated scene has a safe automatic starting position');
        assert.ok(Math.abs(spawn[1] - 1.608) < 0.01);
        const checkEye = point => {
          assert.ok(bounds.containsPoint(new Vector3(...point)));
          assert.ok(safeCameraPosition(collision, point), `Blocked camera at ${point}`);
          const hit = collision.rayIntersect(new Ray(new Vector3(...point), new Vector3(0, -1, 0)));
          assert.ok(hit && hit.distance >= 1.55 && hit.distance <= 1.61, `No floor at ${point}`);
          assert.ok(hit.triangle.getNormal(new Vector3()).y > 0.99);
        };
        checkEye(result.spawn);
        // Test a continuous corridor from spawn to every stop, not just the endpoints.
        for (const stop of result.photoStops) {
          for (let z = 14; z >= stop.position[2]; z -= 0.25) checkEye([0, 1.6, z]);
          for (let step = 0; step <= 20; step++) checkEye([stop.position[0] * step / 20, 1.6, stop.position[2]]);
        }
      } finally { dispose(scene); }
    });
  }
});

test('snapping a spawn to the floor cannot lower it into a nearby step', () => {
  const scene = new Group();
  const floor = new Mesh(new BoxGeometry(6, 0.1, 6));
  floor.position.y = -0.05;
  const step = new Mesh(new BoxGeometry(0.4, 0.1, 1));
  step.position.set(0.35, 0.05, 0);
  scene.add(floor, step);
  try {
    const collision = collisionFromObject(scene);
    const bounds = new Box3(new Vector3(-3, -1, -3), new Vector3(3, 3, 3));
    assert.ok(safeCameraPosition(collision, [0, 1.69, 0]));
    assert.equal(safeCameraPosition(collision, [0, 1.6, 0]), false);
    assert.equal(validatedSceneSpawn(collision, bounds, [0, 1.69, 0]), null);
  } finally { dispose(scene); }
});

test('the real Walker remains supported while moving through the promenade', async () => {
  const result = await generateWorld({ ...plan, environment: 'forest', season: 'snow' });
  const scene = await load(result.buffer);
  try {
    const collision = collisionFromObject(scene);
    const bounds = new Box3().setFromObject(scene);
    bounds.max.y += 3;
    for (const invalid of [null, [], [0, 1.6], [0, NaN, 14], [0, Infinity, 14], ['0', 1.6, 14],
      [0, 6, 14], [0, -1, 14], [1000, 1.6, 14], [0, 1.6, 1000]]) {
      assert.equal(validatedSceneSpawn(collision, bounds, invalid), null, `Reject invalid spawn ${invalid}`);
    }
    const walker = new Walker(collision, new Vector3(...result.spawn).add(new Vector3(0, -1.6, 0)));
    for (let frame = 0; frame < 360; frame++) walker.update(1 / 60, 0, new Set(['w']));
    assert.ok(walker.grounded);
    assert.ok(walker.eye.z < 0 && walker.eye.z > -5, `Unexpected forward progress: ${walker.eye.z}`);
    assert.ok(Math.abs(walker.eye.y - 1.608) < 0.03);
    assert.equal(result.photoStops.length, 0);
    assert.ok(safeCameraPosition(collision, walker.eye.toArray()));
  } finally { dispose(scene); }
});

test('unsupported plans and malformed or excessive photos fail before producing a world', async () => {
  const inputs = await photos();
  await assert.rejects(generateWorld({ ...plan, environment: 'arbitrary' }), /supported environment/);
  await assert.rejects(generateWorld({ ...plan, season: 'rain' }), /supported environment/);
  await assert.rejects(generateWorld({ ...plan, inputHash: '' }), /stable inputHash/);
  await assert.rejects(generateWorld(plan, [...inputs, { ...inputs[0], id: 'extra' }]), /six/);
  await assert.rejects(generateWorld(plan, [inputs[0], inputs[0]]), /unique source/);
  await assert.rejects(generateWorld(plan, [{ id: 'bad', jpeg: Buffer.from('not-a-jpeg') }]), /Only JPEG/);
  const png = await sharp(inputs[0].jpeg).png().toBuffer();
  await assert.rejects(generateWorld(plan, [{ id: 'png', jpeg: png }]), /Only JPEG/);
});
