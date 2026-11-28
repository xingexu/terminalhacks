import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

// Public, CC0 environment assets only. Private project media never enters this request.
const root = new URL('../apps/web/public/environment/', import.meta.url);
const headers = { 'User-Agent': 'Everwhere/0.1 (https://github.com/xingexu/terminalhacks)' };
const assets = [
  ['kloofendal_48d_partly_cloudy_puresky', [['hdri', 'hdr', 'sky.hdr']]],
  ['concrete_floor_01', [['Diffuse', 'jpg', 'concrete-color.jpg'], ['nor_gl', 'jpg', 'concrete-normal.jpg'], ['Rough', 'jpg', 'concrete-roughness.jpg']]]
];
await mkdir(root, { recursive: true });
const provenance = [];
for (const [id, maps] of assets) {
  const response = await fetch('https://api.polyhaven.com/files/' + id, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Poly Haven metadata unavailable: ' + id);
  const files = await response.json();
  for (const [map, format, filename] of maps) {
    const file = files[map]?.['1k']?.[format];
    if (!file || file.size > 8 * 1024 ** 2 || new URL(file.url).hostname !== 'dl.polyhaven.org') throw new Error('Unexpected Poly Haven file');
    const download = await fetch(file.url, { headers, signal: AbortSignal.timeout(60000) });
    if (!download.ok) throw new Error('Poly Haven download failed');
    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.length !== file.size || createHash('md5').update(bytes).digest('hex') !== file.md5) throw new Error('Asset checksum mismatch');
    await writeFile(new URL(filename, root), bytes);
    provenance.push({ filename, asset: id, page: 'https://polyhaven.com/a/' + id, license: 'CC0-1.0', ...file,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
await writeFile(new URL('provenance.json', root), JSON.stringify(provenance, null, 2) + '\n');
console.log('Downloaded and verified ' + provenance.length + ' Poly Haven assets.');
