import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { requireCondition as check, uid } from '../runtime/memory.mjs';

const MAX_BYTES = 48 * 1024 ** 2;
const MAX_PIXELS = 32_000_000;

function record(value, fields, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key)),
    400, 'INVALID_TOUR', 'Use supported fields for ' + label + '.');
}

function text(value, limit, label, multiline = false) {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/ : /[\u0000-\u001f]/;
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !controls.test(value),
    400, 'INVALID_TOUR', label + ' must contain between 1 and ' + limit + ' characters.');
}

function identifier(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
    400, 'INVALID_TOUR', 'Tour node and source IDs must use 1–128 letters, digits, underscores or hyphens.');
}

function publicUrl(value, streetView = false) {
  text(value, 2048, 'Source URL');
  let url;
  try { url = new URL(value); } catch { /* validated below */ }
  const host = url?.hostname.toLowerCase().replace(/\.$/, '');
  check(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && host.includes('.') &&
    !isIP(host) && !host.startsWith('[') && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host),
    400, 'INVALID_TOUR_URL', 'Use a public HTTP or HTTPS source URL without credentials or local addresses.');
  if (streetView) check(url.protocol === 'https:' && url.hostname === 'www.google.com' &&
    (url.pathname === '/maps' || url.pathname.startsWith('/maps/')),
    400, 'INVALID_TOUR_URL', 'Street View links must use https://www.google.com/maps/.');
  return url;
}

function streetViewEmbed(value) {
  const url = publicUrl(value);
  const keys = [...url.searchParams.keys()];
  check(url.protocol === 'https:' && url.hostname === 'www.google.com' && !url.port &&
    url.pathname === '/maps/embed' && !value.includes('#') && keys.length === 1 && keys[0] === 'pb' &&
    url.searchParams.get('pb').trim().length > 0,
    400, 'INVALID_TOUR_URL', 'Use a public https://www.google.com/maps/embed?pb=... Street View embed without keys, credentials or fragments.');
}

function streetViewLocator(value) {
  record(value, ['lat', 'lng', 'heading', 'pitch', 'panoId'], 'a Street View location');
  for (const [key, min, max, optional] of [['lat', -90, 90], ['lng', -180, 180], ['heading', 0, 360, true], ['pitch', -90, 90, true]]) {
    check((optional && value[key] === undefined) || (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= min && value[key] <= max),
      400, 'INVALID_STREET_VIEW_LOCATION', 'Use finite latitude, longitude and viewing angles within their supported ranges.');
  }
  if (value.panoId !== undefined) text(value.panoId, 256, 'Panorama hint');
}

async function validateImage(value, projection) {
  check(typeof value === 'string' && value.startsWith('data:image/'),
    400, 'TOUR_IMAGE_REQUIRED', 'Embed each JPEG or PNG image as a data URL; remote image URLs are not allowed.');
  const separator = value.indexOf(',');
  const header = value.slice(0, separator);
  const mime = /^data:image\/(jpeg|png);base64$/.exec(header)?.[1];
  const encoded = value.slice(separator + 1);
  check(mime && encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
    400, 'INVALID_TOUR_IMAGE', 'Each tour image must be a base64 JPEG or PNG.');
  const image = Buffer.from(encoded, 'base64');
  check(image.toString('base64') === encoded, 400, 'INVALID_TOUR_IMAGE', 'The embedded image encoding is invalid.');
  let metadata;
  try { metadata = await sharp(image, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata(); }
  catch { check(false, 400, 'INVALID_TOUR_IMAGE', 'An embedded image is unreadable or exceeds the 32-megapixel limit.'); }
  check(metadata.format === mime && metadata.width >= 1 && metadata.height >= 1 && metadata.width <= 8192 && metadata.height <= 8192 &&
    metadata.width * metadata.height <= MAX_PIXELS && (metadata.pages ?? 1) === 1,
    400, 'INVALID_TOUR_IMAGE', 'Use matching JPEG/PNG images up to 8192 pixels per side and 32 megapixels, with one frame each.');
  const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;
  check(projection !== 'equirectangular' || width === height * 2,
    400, 'INVALID_TOUR_PROJECTION', 'Equirectangular panoramas must display at exactly a 2:1 width-to-height ratio.');
  // Metadata alone can accept a truncated image. Decode with bounded pixels before storing it.
  try { await sharp(image, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).resize(1, 1).raw().toBuffer(); }
  catch { check(false, 400, 'INVALID_TOUR_IMAGE', 'An embedded image cannot be decoded completely.'); }
}

export async function storeTour(data, fileName, dir) {
  check(typeof fileName === 'string' && /\.tour\.json$/i.test(fileName),
    400, 'TOUR_REQUIRED', 'Choose a self-contained .tour.json photo walkthrough.');
  check(Buffer.isBuffer(data) && data.length > 0, 400, 'INVALID_TOUR', 'The tour file is empty or unreadable.');
  check(data.length <= MAX_BYTES, 413, 'TOUR_LIMIT', 'Keep the complete tour file at or below 48 MiB.');
  let tour;
  try { tour = JSON.parse(data.toString('utf8')); }
  catch { check(false, 400, 'INVALID_TOUR', 'The tour must be valid JSON.'); }
  record(tour, ['version', 'title', 'startNodeId', 'nodes'], 'the tour');
  check(tour.version === 'everwhere-tour-1', 400, 'INVALID_TOUR', 'Use the everwhere-tour-1 format.');
  text(tour.title, 180, 'Tour title');
  identifier(tour.startNodeId);
  check(Array.isArray(tour.nodes) && tour.nodes.length >= 1 && tour.nodes.length <= 8,
    400, 'TOUR_LIMIT', 'A tour must contain between 1 and 8 viewpoints.');
  const nodes = new Map();
  for (const node of tour.nodes) {
    record(node, ['id', 'title', 'description', 'image', 'projection', 'links', 'facts', 'streetViewUrl', 'streetViewEmbedUrl', 'streetView', 'sourceIds'], 'a viewpoint');
    identifier(node.id);
    check(!nodes.has(node.id), 400, 'INVALID_TOUR_GRAPH', 'Each viewpoint needs a unique ID.');
    nodes.set(node.id, node);
    text(node.title, 180, 'Viewpoint title');
    if (node.description !== undefined) text(node.description, 2048, 'Viewpoint description', true);
    check(['perspective', 'equirectangular', 'streetview'].includes(node.projection), 400, 'INVALID_TOUR_PROJECTION', 'Choose perspective, equirectangular or streetview projection.');
    if (node.projection === 'streetview') {
      check(node.image === undefined, 400, 'INVALID_TOUR_IMAGE', 'A Street View node uses the official embed, not copied image pixels.');
      check((node.streetView !== undefined) !== (node.streetViewEmbedUrl !== undefined),
        400, 'INVALID_TOUR_PROJECTION', 'Choose one live Street View location or one public embed for each Street View node.');
      if (node.streetView !== undefined) streetViewLocator(node.streetView);
      else streetViewEmbed(node.streetViewEmbedUrl);
    } else check(node.streetViewEmbedUrl === undefined && node.streetView === undefined, 400, 'INVALID_TOUR_PROJECTION', 'Only streetview nodes accept a Street View location or embed.');
    check(Array.isArray(node.links) && node.links.length <= 8, 400, 'INVALID_TOUR_GRAPH', 'Each viewpoint supports at most 8 navigation links.');
    for (const link of node.links) {
      record(link, ['to', 'label', 'yaw', 'pitch', 'kind'], 'a navigation link');
      identifier(link.to);
      text(link.label, 120, 'Navigation label');
      check(link.kind === undefined || ['walk', 'door'].includes(link.kind), 400, 'INVALID_TOUR_GRAPH', 'Choose walk or door for the link kind.');
      for (const [key, limit] of [['yaw', 180], ['pitch', 90]]) check(link[key] === undefined ||
        (typeof link[key] === 'number' && Number.isFinite(link[key]) && Math.abs(link[key]) <= limit),
        400, 'INVALID_TOUR_GRAPH', 'Navigation angles must be finite degrees within yaw ±180 and pitch ±90.');
    }
    if (node.sourceIds !== undefined) {
      check(Array.isArray(node.sourceIds) && node.sourceIds.length <= 100 && new Set(node.sourceIds).size === node.sourceIds.length,
        400, 'INVALID_TOUR', 'Choose at most 100 distinct source IDs per viewpoint.');
      node.sourceIds.forEach(identifier);
    }
    if (node.facts !== undefined) {
      check(Array.isArray(node.facts) && node.facts.length <= 8, 400, 'INVALID_TOUR', 'Use at most 8 cited facts per viewpoint.');
      for (const fact of node.facts) {
        record(fact, ['text', 'url'], 'a cited fact');
        text(fact.text, 2048, 'Fact text', true);
        publicUrl(fact.url);
      }
    }
    if (node.streetViewUrl !== undefined) publicUrl(node.streetViewUrl, true);
  }
  check(nodes.has(tour.startNodeId), 400, 'INVALID_TOUR_GRAPH', 'The starting viewpoint must exist.');
  for (const node of nodes.values()) for (const link of node.links) check(nodes.has(link.to),
    400, 'INVALID_TOUR_GRAPH', 'Every navigation link must point to an existing viewpoint.');
  const visited = new Set();
  const pending = [tour.startNodeId];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...nodes.get(id).links.map(link => link.to));
  }
  check(visited.size === nodes.size, 400, 'INVALID_TOUR_GRAPH', 'Every viewpoint must be reachable from the starting viewpoint.');
  for (const node of nodes.values()) if (node.projection !== 'streetview') await validateImage(node.image, node.projection);
  const id = uid();
  const storage = join(dir, id + '.tour.json');
  await mkdir(dir, { recursive: true });
  await writeFile(storage, data);
  return { id, storage, format: 'tour', points: nodes.size, contentHash: createHash('sha256').update(data).digest('hex'), title: tour.title.trim(),
    tour: { startNodeId: tour.startNodeId,
      ...(tour.nodes.every(node => node.projection === 'streetview' && node.streetView !== undefined) && { liveStreetView: true }),
      nodes: tour.nodes.map(({ id, title, sourceIds }) => ({ id, title, ...(sourceIds !== undefined && { sourceIds }) })) } };
}
