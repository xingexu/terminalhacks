import { isIP } from 'node:net';
import { requireCondition as check } from '../runtime/memory.mjs';

const fields = ['title', 'creator', 'sourceUrl', 'license', 'licenseUrl', 'reportedDate', 'dateNote'];

function text(input, key, limit, optional = false) {
  const value = input[key];
  if (optional && (value === undefined || value === null || value === '')) return null;
  const controls = key === 'dateNote' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/ : /[\u0000-\u001f]/;
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !controls.test(value),
    400, 'INVALID_ATTRIBUTION', 'Provide valid public-photo ' + key + ' details.');
  return value.trim();
}

function publicUrl(input, key) {
  const value = text(input, key, 2048);
  let url;
  try { url = new URL(value); } catch { /* validation below */ }
  const host = url?.hostname.toLowerCase();
  check(url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && host.includes('.') &&
    !isIP(host) && !host.startsWith('[') && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host),
    400, 'INVALID_ATTRIBUTION', 'Use a public HTTP or HTTPS source and license URL without credentials.');
  return url.href;
}

// Source-reported dates are separate from EXIF: never invent a capture instant.
export function normalizeAttribution(input) {
  if (input === undefined) return undefined;
  check(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => fields.includes(key)),
    400, 'INVALID_ATTRIBUTION', 'Provide a public-photo attribution object.');
  const reportedDate = text(input, 'reportedDate', 10, true);
  check(reportedDate === null || (/^\d{4}-\d{2}-\d{2}$/.test(reportedDate) &&
    Number.isFinite(Date.parse(reportedDate)) && new Date(reportedDate).toISOString().slice(0, 10) === reportedDate),
    400, 'INVALID_ATTRIBUTION', 'Use a real source-reported calendar date, or leave it unknown.');
  return {
    kind: 'public_reference', title: text(input, 'title', 180, true), creator: text(input, 'creator', 200),
    sourceUrl: publicUrl(input, 'sourceUrl'), license: text(input, 'license', 100), licenseUrl: publicUrl(input, 'licenseUrl'),
    reportedDate, dateNote: text(input, 'dateNote', 1000, true) || 'Exact capture time and timezone are unknown.'
  };
}

export function worldCredits(world, sources) {
  const credited = sources.filter(source => source.attribution);
  return {
    version: 'everwhere-source-credits-1',
    world: { title: world.title, provenance: world.provenance, provider: world.provider },
    distribution: 'Keep this companion credits file with every shared copy of the scene; credits are not embedded in the GLB or SPZ. Preserve creator, source, license and change notices. Photo-derived adaptations under CC BY-SA must follow the applicable ShareAlike terms linked below. No creator endorsement is implied.',
    interpretation: world.provenance === 'imagined' ?
      'An imagined scene using public reference imagery, not a measured reconstruction or a personal trip record. Generated geometry and unseen areas are interpretive.' :
      'A scene labeled reconstructed by its uploader. Public reference imagery is not evidence of a personal trip; reconstruction accuracy has not been independently verified.',
    changes: 'Original uploads are preserved unchanged. The scene may resize, reproject or incorporate the photos into generated geometry; these are adaptations rather than original photographs.',
    verification: 'Credits and source-reported dates were supplied with each photo. An uncertain reported date is not an EXIF capture timestamp. This file does not independently verify rights or license compatibility.',
    sourcesWithoutPublicCredits: sources.length - credited.length,
    sources: credited.map(source => ({ sourceId: source.id, ...source.attribution, title: source.attribution.title || source.caption }))
  };
}
