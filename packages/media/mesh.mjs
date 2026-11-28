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
  check(scene?.asset?.version === '2.0' && Array.isArray(scene.meshes) && scene.meshes.length && Array.isArray(scene.accessors),
    400, 'INVALID_GLB', 'Export a GLB 2.0 scene containing a triangle mesh.');
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
  check((scene.buffers || []).every(buffer => Number.isSafeInteger(buffer.byteLength) && buffer.byteLength >= 0 &&
    (buffer.uri || buffer.byteLength <= binaryLength)), 400, 'INVALID_GLB', 'The embedded geometry is incomplete.');
  let triangles = 0;
  let points = 0;
  for (const item of scene.meshes) {
    check(Array.isArray(item.primitives), 400, 'INVALID_GLB', 'The scene mesh could not be read.');
    for (const primitive of item.primitives) {
      const position = scene.accessors[primitive.attributes?.POSITION];
      const count = primitive.indices === undefined ? position?.count : scene.accessors[primitive.indices]?.count;
      check((primitive.mode === undefined || primitive.mode === 4) && position?.type === 'VEC3' &&
        Number.isSafeInteger(position.count) && position.count > 0 && Number.isSafeInteger(count) && count >= 3 && count % 3 === 0,
        400, 'GLB_TRIANGLES_REQUIRED', 'Export a scene with triangle geometry.');
      points += position.count;
      triangles += count / 3;
    }
  }
  check(triangles > 0 && triangles <= 250_000, 400, 'GLB_LIMIT', 'Simplify this scene to at most 250,000 triangles for browser collision detection.');
  const id = uid();
  const storage = join(dir, id + '.glb');
  await mkdir(dir, { recursive: true });
  await writeFile(storage, data);
  return { id, storage, points, format: 'glb', triangles, contentHash: createHash('sha256').update(data).digest('hex'),
    title: basename(fileName).replace(/\.glb$/i, '').slice(0, 120) };
}
