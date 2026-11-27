import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { requireCondition as check, uid } from '../runtime/memory.mjs';

const inflate = promisify(gunzip);
const coefficients = [0, 9, 24, 45];

function hasPackedStreams(content, points, degree) {
  if (content.length < 32) return false;
  const offset = content.readUInt32LE(16);
  const sizes = [9, 1, 3, 3, 4];
  if (degree) sizes.push(coefficients[degree]);
  if (content[15] !== sizes.length || offset < 32 || offset + sizes.length * 16 > content.length) return false;
  let cursor = offset + sizes.length * 16;
  for (const [index, size] of sizes.entries()) {
    const entry = offset + index * 16;
    const compressed = content.readBigUInt64LE(entry);
    if (compressed < 4n || compressed > BigInt(content.length - cursor) ||
        content.readBigUInt64LE(entry + 8) !== BigInt(size * points) ||
        content.readUInt32LE(cursor) !== 0xfd2fb528) return false;
    cursor += Number(compressed);
  }
  return cursor === content.length;
}

export async function storeSplat(data, fileName, dir) {
  check(/\.spz$/i.test(fileName), 400, 'SPZ_REQUIRED', 'Choose an SPZ Gaussian splat file.');
  const gzip = data[0] === 0x1f && data[1] === 0x8b;
  const content = gzip ? await inflate(data, { maxOutputLength: 128 * 1024 ** 2 }).catch(() => Buffer.alloc(0)) : data;
  const length = content.length;
  check(length >= 16 && content.subarray(0, 4).toString('ascii') === 'NGSP', 400, 'INVALID_SPZ', 'The SPZ file could not be read.');
  const version = content.readUInt32LE(4);
  const points = content.readUInt32LE(8);
  const degree = content[12];
  check(points > 0 && points <= 2_000_000 && degree < coefficients.length && (gzip ? version >= 1 && version <= 3 : version === 4),
    400, 'SPZ_LIMIT', 'Use a supported SPZ scene with up to two million splats.');
  const complete = gzip ? length >= 16 + points * ([16, 19, 20][version - 1] + coefficients[degree]) :
    hasPackedStreams(content, points, degree);
  check(complete, 400, 'INVALID_SPZ', 'The SPZ data is incomplete.');
  const id = uid();
  const storage = join(dir, id + '.spz');
  await mkdir(dir, { recursive: true });
  await writeFile(storage, data);
  return {
    id, storage, points, contentHash: createHash('sha256').update(data).digest('hex'),
    title: basename(fileName).replace(/\.spz$/i, '').slice(0, 120)
  };
}
