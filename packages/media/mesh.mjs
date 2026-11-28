import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { requireCondition as check, uid } from '../runtime/memory.mjs';

export async function storeMesh(data, fileName, dir) {
  check(/\.glb$/i.test(fileName), 400, 'GLB_REQUIRED', 'Choose a self-contained GLB scene.');
  check(data.length >= 28 && data.toString('ascii', 0, 4) === 'glTF' && data.readUInt32LE(4) === 2 && data.readUInt32LE(8) === data.length,
    400, 'INVALID_GLB', 'The GLB file is incomplete or unsupported.');
  const jsonLength = data.readUInt32LE(12);
  check(data.readUInt32LE(16) === 0x4e4f534a && jsonLength % 4 === 0 && 20 + jsonLength <= data.length,
    400, 'INVALID_GLB', 'The scene description could not be read.');
  let scene;
  try { scene = JSON.parse(data.toString('utf8', 20, 20 + jsonLength)); }
  catch { check(false, 400, 'INVALID_GLB', 'The scene description could not be read.'); }
  check(scene?.asset?.version === '2.0' && Array.isArray(scene.meshes) && scene.meshes.length &&
    Array.isArray(scene.accessors) && Array.isArray(scene.nodes) && scene.nodes.length &&
    Array.isArray(scene.scenes) && scene.scenes.length,
    400, 'INVALID_GLB', 'Export a GLB 2.0 scene with a usable triangle mesh hierarchy.');
  check(scene.extensionsRequired === undefined || Array.isArray(scene.extensionsRequired),
    400, 'INVALID_GLB', 'The scene requirements could not be read.');
  check(!(scene.extensionsRequired || []).some(name => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(name)),
    400, 'GLB_COMPRESSION', 'Export an uncompressed GLB with embedded PNG or JPEG textures.');
  const pending = [scene];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri') check(typeof child === 'string' && /^data:(image\/(png|jpeg|webp)|application\/(octet-stream|gltf-buffer));base64,/.test(child),
        400, 'EXTERNAL_GLB_ASSET', 'Embed all textures and buffers in the GLB. External asset links are unsupported.');
      else if (child && typeof child === 'object') pending.push(child);
    }
  }
  let cursor = 20 + jsonLength;
  let binaryLength = 0;
  while (cursor < data.length) {
    check(cursor + 8 <= data.length, 400, 'INVALID_GLB', 'The scene data is incomplete.');
    const size = data.readUInt32LE(cursor);
    check(size % 4 === 0 && cursor + 8 + size <= data.length, 400, 'INVALID_GLB', 'The scene data is incomplete.');
    if (data.readUInt32LE(cursor + 4) === 0x004e4942) binaryLength += size;
    cursor += 8 + size;
  }
  check(scene.buffers === undefined || Array.isArray(scene.buffers), 400, 'INVALID_GLB', 'The scene buffers could not be read.');
  check((scene.buffers || []).every(buffer => buffer && typeof buffer === 'object' &&
    Number.isSafeInteger(buffer.byteLength) && buffer.byteLength >= 0 &&
    (buffer.uri || buffer.byteLength <= binaryLength)), 400, 'INVALID_GLB', 'The embedded geometry is incomplete.');

  const meshMetrics = scene.meshes.map(item => {
    check(Array.isArray(item?.primitives) && item.primitives.length, 400, 'INVALID_GLB', 'The scene mesh could not be read.');
    let triangles = 0;
    let points = 0;
    for (const primitive of item.primitives) {
      check(primitive && typeof primitive === 'object' && !Array.isArray(primitive),
        400, 'INVALID_GLB', 'The scene primitive could not be read.');
      const positionIndex = primitive.attributes?.POSITION;
      const position = Number.isSafeInteger(positionIndex) ? scene.accessors[positionIndex] : undefined;
      const indexIndex = primitive.indices;
      const indexAccessor = indexIndex === undefined ? undefined :
        Number.isSafeInteger(indexIndex) ? scene.accessors[indexIndex] : undefined;
      const count = indexIndex === undefined ? position?.count : indexAccessor?.count;
      check((primitive.mode === undefined || primitive.mode === 4) && position?.type === 'VEC3' &&
        Number.isSafeInteger(position.count) && position.count > 0 &&
        (indexIndex === undefined || (indexAccessor?.type === 'SCALAR' && [5121, 5123, 5125].includes(indexAccessor.componentType))) &&
        Number.isSafeInteger(count) && count >= 3 && count % 3 === 0,
        400, 'GLB_TRIANGLES_REQUIRED', 'Export a scene with triangle geometry.');
      points += position.count;
      triangles += count / 3;
    }
    return { triangles, points };
  });

  const defaultSceneIndex = scene.scene ?? 0;
  const defaultScene = scene.scenes[defaultSceneIndex];
  check(Number.isSafeInteger(defaultSceneIndex) && defaultSceneIndex >= 0 &&
    defaultScene && Array.isArray(defaultScene.nodes) && defaultScene.nodes.length,
    400, 'INVALID_GLB_GRAPH', 'The default scene must contain a valid node hierarchy.');
  const states = new Uint8Array(scene.nodes.length);
  const pendingNodes = defaultScene.nodes.map(index => ({ index, exit: false }));
  let triangles = 0;
  let points = 0;
  while (pendingNodes.length) {
    const entry = pendingNodes.pop();
    if (entry.exit) {
      states[entry.index] = 2;
      continue;
    }
    const index = entry.index;
    check(Number.isSafeInteger(index) && index >= 0 && index < scene.nodes.length,
      400, 'INVALID_GLB_GRAPH', 'The default scene references an invalid node.');
    check(states[index] !== 1, 400, 'INVALID_GLB_GRAPH', 'The default scene contains a node cycle.');
    check(states[index] === 0, 400, 'INVALID_GLB_GRAPH', 'The default scene contains a node with repeated parentage.');
    const node = scene.nodes[index];
    check(node && typeof node === 'object' && !Array.isArray(node) &&
      (node.children === undefined || Array.isArray(node.children)),
      400, 'INVALID_GLB_GRAPH', 'The default scene contains an invalid node.');
    states[index] = 1;
    pendingNodes.push({ index, exit: true });
    for (let childIndex = (node.children?.length || 0) - 1; childIndex >= 0; childIndex--) {
      pendingNodes.push({ index: node.children[childIndex], exit: false });
    }

    const gpuInstancing = node.extensions?.EXT_mesh_gpu_instancing;
    if (node.mesh === undefined) {
      check(gpuInstancing === undefined, 400, 'INVALID_GLB_GRAPH', 'GPU instancing requires a mesh node.');
      continue;
    }
    check(Number.isSafeInteger(node.mesh) && node.mesh >= 0 && node.mesh < meshMetrics.length,
      400, 'INVALID_GLB_GRAPH', 'The default scene references an invalid mesh.');
    let instances = 1;
    if (gpuInstancing !== undefined) {
      const attributes = gpuInstancing?.attributes;
      check(attributes && typeof attributes === 'object' && !Array.isArray(attributes) && Object.keys(attributes).length > 0,
        400, 'INVALID_GLB_GRAPH', 'The GPU instance attributes are invalid.');
      const counts = Object.values(attributes).map(accessorIndex =>
        Number.isSafeInteger(accessorIndex) && accessorIndex >= 0 ? scene.accessors[accessorIndex]?.count : undefined);
      check(counts.every(count => Number.isSafeInteger(count) && count > 0) && counts.every(count => count === counts[0]),
        400, 'INVALID_GLB_GRAPH', 'GPU instance attributes must have the same positive count.');
      instances = counts[0];
    }
    const mesh = meshMetrics[node.mesh];
    const addedTriangles = mesh.triangles * instances;
    const addedPoints = mesh.points * instances;
    check(Number.isSafeInteger(addedTriangles) && addedTriangles <= 250_000 - triangles,
      400, 'GLB_LIMIT', 'Simplify this scene to at most 250,000 triangles for browser collision detection.');
    check(Number.isSafeInteger(addedPoints) && Number.isSafeInteger(points + addedPoints),
      400, 'INVALID_GLB', 'The scene point count is invalid.');
    triangles += addedTriangles;
    points += addedPoints;
  }
  check(triangles > 0, 400, 'INVALID_GLB_GRAPH', 'The default scene contains no usable triangle meshes.');

  const id = uid();
  const storage = join(dir, id + '.glb');
  await mkdir(dir, { recursive: true });
  await writeFile(storage, data);
  return { id, storage, points, format: 'glb', triangles, contentHash: createHash('sha256').update(data).digest('hex'),
    title: basename(fileName).replace(/\.glb$/i, '').slice(0, 120) };
}
