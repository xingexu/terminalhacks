import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeMesh } from '../packages/media/mesh.mjs';

function glb({ triangles = 1, nodes = [{ mesh: 0 }], roots = nodes.map((_, index) => index), scenes = [{ nodes: roots }], scene = 0 } = {}) {
  const positions = Buffer.from(new Float32Array([-1, 0, -1, 0, 0, 1, 1, 0, -1]).buffer);
  const indexData = new Uint16Array(triangles * 3);
  for (let i = 0; i < indexData.length; i++) indexData[i] = i % 3;
  const chunks = [positions, Buffer.from(indexData.buffer)];
  const bufferViews = [
    { buffer: 0, byteOffset: 0, byteLength: positions.length },
    { buffer: 0, byteOffset: positions.length, byteLength: indexData.byteLength }
  ];
  const accessors = [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, -1], max: [1, 0, 1] },
    { bufferView: 1, componentType: 5123, count: indexData.length, type: 'SCALAR' }
  ];
  const descriptions = nodes.map(({ instanceCounts, ...node }) => {
    if (instanceCounts === undefined) return node;
    const attributes = {};
    const semantics = ['TRANSLATION', 'ROTATION', 'SCALE'];
    for (const [index, count] of instanceCounts.entries()) {
      const semantic = semantics[index];
      const components = semantic === 'ROTATION' ? 4 : 3;
      const data = Buffer.alloc(count * components * 4);
      const alignedOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);
      const padding = (4 - alignedOffset % 4) % 4;
      if (padding) chunks.push(Buffer.alloc(padding));
      const offset = chunks.reduce((total, chunk) => total + chunk.length, 0);
      chunks.push(data);
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
      attributes[semantic] = accessors.length;
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count, type: semantic === 'ROTATION' ? 'VEC4' : 'VEC3' });
    }
    return { ...node, extensions: { EXT_mesh_gpu_instancing: { attributes } } };
  });
  const binaryLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const binaryPadding = (4 - binaryLength % 4) % 4;
  if (binaryPadding) chunks.push(Buffer.alloc(binaryPadding));
  const binary = Buffer.concat(chunks);
  const document = {
    asset: { version: '2.0' }, scene, scenes, nodes: descriptions,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors, bufferViews, buffers: [{ byteLength: binary.length }],
    extensionsUsed: nodes.some(node => node.instanceCounts !== undefined) ? ['EXT_mesh_gpu_instancing'] : undefined
  };
  const json = Buffer.from(JSON.stringify(document));
  const jsonPadding = (4 - json.length % 4) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binaryHeader, binary]);
}

async function testDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'everwhere-mesh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('GLB triangle metadata counts reachable node references and GPU instances in the selected scene', async t => {
  const dir = await testDirectory(t);
  const bytes = glb({
    nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 0, instanceCounts: [2] }],
    scenes: [{ nodes: [0] }, { nodes: [0, 1, 2] }],
    scene: 1
  });
  const saved = await storeMesh(bytes, 'Repeated.glb', dir);
  assert.equal(saved.triangles, 4);
  assert.equal(saved.points, 12);
});

test('GLB validation enforces the collision budget across repeated mesh nodes', async t => {
  const dir = await testDirectory(t);
  const bytes = [
    glb({ triangles: 50_000, nodes: Array.from({ length: 6 }, () => ({ mesh: 0 })) }),
    glb({ triangles: 50_000, nodes: [{ mesh: 0, instanceCounts: [6] }] })
  ];
  for (const data of bytes) {
    await assert.rejects(storeMesh(data, 'Over-budget.glb', dir), error => error.code === 'GLB_LIMIT');
  }
});

test('GLB validation rejects invalid active scene graphs and inconsistent GPU instance counts', async t => {
  const dir = await testDirectory(t);
  const invalid = [
    glb({ nodes: [{ children: [2] }, { children: [2] }, {}], roots: [0, 1] }),
    glb({ nodes: [{ children: [1] }, { children: [0] }], roots: [0] }),
    glb({ nodes: [{ children: [9] }], roots: [0] }),
    glb({ nodes: [{ mesh: 0 }], roots: [] }),
    glb({ nodes: [{ mesh: 0, instanceCounts: [0] }] }),
    glb({ nodes: [{ mesh: 0, instanceCounts: [3, 2] }] })
  ];
  for (const bytes of invalid) {
    await assert.rejects(storeMesh(bytes, 'Invalid.glb', dir), error => error.code === 'INVALID_GLB_GRAPH');
  }
});
