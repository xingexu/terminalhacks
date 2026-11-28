import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  Box3, BoxGeometry, Color, ConeGeometry, CylinderGeometry, Euler,
  IcosahedronGeometry, Matrix4, PlaneGeometry, Quaternion, Vector3
} from 'three';

const ENVIRONMENTS = ['mountain', 'coast', 'forest', 'urban', 'open'];
const SEASONS = ['green', 'snow', 'autumn'];

function randomFor(seed) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A deliberately small GLB writer: uncompressed indexed triangles, PBR materials,
// TRS nodes and embedded JPEGs. No exporter DOM shims or external resources.
function builder(plan) {
  const chunks = [];
  let byteLength = 0;
  const document = {
    asset: { version: '2.0', generator: 'Everwhere procedural memory garden', extras: {
      provenance: 'imagined', method: 'procedural', description: 'Imagined scenery with supplied original photographs. Not photogrammetry.',
      units: 'm', coordinateSystem: 'right-handed-y-up', planId: plan.id, inputHash: plan.inputHash,
      environment: plan.environment, season: plan.season
    } },
    scene: 0, scenes: [{ name: plan.title, nodes: [] }], nodes: [], meshes: [],
    materials: [], accessors: [], bufferViews: [], buffers: [], images: [], textures: [],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }]
  };
  const bounds = new Box3();
  const geometryCache = new Map();
  const meshCache = new Map();
  const geometries = new Set();
  const rgba = hex => [...new Color(hex).toArray(), 1];

  function bytes(data, target) {
    const padding = (4 - byteLength % 4) % 4;
    if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
    const index = document.bufferViews.length;
    document.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, ...(target && { target }) });
    chunks.push(data); byteLength += data.length;
    return index;
  }
  function accessor(array, itemSize, componentType, target, limits) {
    const index = document.accessors.length;
    document.accessors.push({ bufferView: bytes(Buffer.from(array.buffer, array.byteOffset, array.byteLength), target),
      componentType, count: array.length / itemSize, type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][itemSize - 1], ...limits });
    return index;
  }
  function material(name, hex, options = {}) {
    const index = document.materials.length;
    document.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: rgba(hex), metallicFactor: 0, roughnessFactor: 0.86,
      ...(options.texture !== undefined && { baseColorTexture: { index: options.texture } }) },
      ...(options.emissive && { emissiveFactor: new Color(options.emissive).toArray() }),
      ...(options.doubleSided && { doubleSided: true }) });
    return index;
  }
  function geometryData(geometry) {
    if (geometryCache.has(geometry)) return geometryCache.get(geometry);
    geometries.add(geometry);
    geometry.computeBoundingBox();
    const attributes = {};
    for (const [attribute, semantic] of [['position', 'POSITION'], ['normal', 'NORMAL'], ['uv', 'TEXCOORD_0']]) {
      const data = geometry.getAttribute(attribute);
      if (data) attributes[semantic] = accessor(data.array, data.itemSize, 5126, 34962,
        attribute === 'position' ? { min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray() } : {});
    }
    const index = geometry.getIndex();
    const indices = index ? accessor(index.array, 1, index.array instanceof Uint32Array ? 5125 : 5123, 34963) : undefined;
    const result = { attributes, ...(indices !== undefined && { indices }), mode: 4 };
    geometryCache.set(geometry, result);
    return result;
  }
  function mesh(name, geometry, materialIndex, position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0], extras) {
    const primitive = geometryData(geometry);
    const key = `${primitive.attributes.POSITION}:${materialIndex}`;
    if (!meshCache.has(key)) {
      meshCache.set(key, document.meshes.length);
      document.meshes.push({ primitives: [{ ...primitive, material: materialIndex }] });
    }
    const quaternion = new Quaternion().setFromEuler(new Euler(...rotation));
    const matrix = new Matrix4().compose(new Vector3(...position), quaternion, new Vector3(...scale));
    bounds.union(geometry.boundingBox.clone().applyMatrix4(matrix));
    document.scenes[0].nodes.push(document.nodes.length);
    document.nodes.push({ name, mesh: meshCache.get(key), translation: position, rotation: quaternion.toArray(), scale,
      ...(extras && { extras }) });
  }
  function photo(photo) {
    const image = document.images.length;
    document.images.push({ name: photo.id, mimeType: 'image/jpeg', bufferView: bytes(photo.jpeg) });
    const texture = document.textures.length;
    document.textures.push({ source: image, sampler: 0 });
    return material(`Original photograph: ${photo.id}`, '#ffffff', { texture });
  }
  function finish(spawn, photoStops) {
    document.asset.extras.spawn = spawn;
    document.asset.extras.photoStops = photoStops;
    document.buffers.push({ byteLength });
    const binary = Buffer.concat([...chunks, Buffer.alloc((4 - byteLength % 4) % 4)]);
    const raw = Buffer.from(JSON.stringify(document));
    const json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 0x20)]);
    const header = Buffer.alloc(20);
    header.write('glTF'); header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + json.length + binary.length, 8);
    header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
    const binaryHeader = Buffer.alloc(8);
    binaryHeader.writeUInt32LE(binary.length); binaryHeader.writeUInt32LE(0x004e4942, 4);
    for (const geometry of geometries) geometry.dispose();
    return { buffer: Buffer.concat([header, json, binaryHeader, binary]),
      boundsMin: bounds.min.toArray(), boundsMax: bounds.max.toArray(), spawn, photoStops };
  }
  return { material, mesh, photo, finish };
}

/**
 * Build an imagined, metre-scale garden around up to six authorized thumbnails.
 * Caller owns source permission checks. Photographs stay byte-for-byte original;
 * scenery and approximate photo placement do not assert historical geometry.
 */
export async function generateWorld(plan, photos = []) {
  if (!plan || !ENVIRONMENTS.includes(plan.environment) || !SEASONS.includes(plan.season) ||
      typeof plan.inputHash !== 'string' || !plan.inputHash || typeof plan.id !== 'string' ||
      !plan.id || typeof plan.title !== 'string' || plan.title.length > 500 || plan.id.length > 500 || plan.inputHash.length > 512) {
    throw new TypeError('A world requires an id, title, stable inputHash, supported environment and season.');
  }
  if (!Array.isArray(photos) || photos.length > 6) throw new TypeError('Use at most six authorized JPEG thumbnails.');
  const seen = new Set();
  const validated = [];
  for (const photo of photos) {
    if (!photo || typeof photo.id !== 'string' || !photo.id || photo.id.length > 500 || seen.has(photo.id) ||
        !Buffer.isBuffer(photo.jpeg) || photo.jpeg.length < 4 || photo.jpeg.length > 4 * 1024 ** 2) {
      throw new TypeError('Each photo needs a unique source id and a JPEG thumbnail up to 4 MB.');
    }
    const info = await sharp(photo.jpeg, { limitInputPixels: 16_777_216 }).metadata().catch(() => null);
    if (info?.format !== 'jpeg' || !info.width || !info.height || info.width > 4096 || info.height > 4096) {
      throw new TypeError('Only JPEG thumbnails up to 4096 pixels per side are supported.');
    }
    seen.add(photo.id);
    validated.push({ ...photo, aspect: info.width / info.height });
  }

  const random = randomFor(`${plan.inputHash}:${plan.environment}:${plan.season}`);
  const b = builder(plan);
  const snow = plan.season === 'snow';
  const autumn = plan.season === 'autumn';
  const ground = b.material('Meadow / snow', snow ? '#e3eaeb' : autumn ? '#b4a16f' : '#77937d');
  const path = b.material('Promenade', plan.environment === 'coast' ? '#bba280' : '#d1c5ad');
  const wood = b.material('Warm timber', '#71574a');
  const frame = b.material('Gallery frames', '#303f3e');
  const metal = b.material('Brass details', '#a28653');
  const foliage = [b.material('Foliage light', snow ? '#c3d8d3' : autumn ? '#b97940' : '#557d65'),
    b.material('Foliage dark', snow ? '#4e6a64' : autumn ? '#8e643b' : '#365e4e')];
  const rock = b.material('Stone', '#8d9291');
  const rockLight = b.material('Stone highlights', snow ? '#f0f2ec' : '#b2b6b0');
  const glow = b.material('Warm lights', '#fff2cd', { emissive: '#8e7142' });
  const box = new BoxGeometry(1, 1, 1);
  const plane = new PlaneGeometry(1, 1);
  // glTF image coordinates start at the upper-left (GLTFLoader uses flipY=false).
  // Three's plane has v=1 along its upper edge, so invert it for embedded photos.
  const uv = plane.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const cone = new ConeGeometry(1, 1, 7, 1);
  const trunk = new CylinderGeometry(0.7, 1, 1, 7);
  const round = new IcosahedronGeometry(1, 1);

  // Solid floor top is exactly y=0. The raised path surface is only 8 mm high.
  b.mesh('Walkable ground', box, ground, [0, -0.25, 0], [48, 0.5, 48]);
  b.mesh('Central promenade', box, path, [0, 0.004, 0], [3.4, 0.008, 34]);
  for (const z of [8, 0, -8]) b.mesh('Photo bay path', box, path, [0, 0.004, z], [11.2, 0.008, 2.5]);

  function tree(x, z, height = 4, pine = false) {
    b.mesh('Tree trunk', trunk, wood, [x, height * 0.24, z], [0.21, height * 0.48, 0.21]);
    if (pine) {
      for (let layer = 0; layer < 3; layer++) {
        b.mesh('Fir crown', cone, snow && layer === 2 ? rockLight : foliage[layer % 2],
          [x, height * (0.42 + layer * 0.18), z], [height * (0.28 - layer * 0.055), height * 0.5, height * (0.28 - layer * 0.055)]);
      }
    } else {
      b.mesh('Faceted tree crown', round, foliage[Math.floor(random() * 2)], [x, height * 0.78, z],
        [height * 0.34, height * 0.38, height * 0.3], [0, random() * Math.PI, 0]);
    }
  }
  function stone(x, z, size = 1) {
    b.mesh('Weathered boulder', round, random() > 0.5 ? rock : rockLight, [x, size * 0.35, z],
      [size, size * 0.6, size * 0.8], [0, random() * Math.PI, 0]);
  }

  // Every scenery footprint remains outside the reserved |x| < 8 gallery corridor.
  if (plan.environment === 'mountain') {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const h = 6 + random() * 7;
        const x = side * (16 + random() * 3), z = -17 + i * 8;
        b.mesh('Distant mountain', cone, rock, [x, h / 2, z], [4.5, h, 4.5], [0, random(), 0]);
        b.mesh('Mountain summit', cone, rockLight, [x, h * 0.84, z], [1.5, h * 0.32, 1.5]);
        tree(side * (10 + random()), z + 2, 3.5 + random(), true);
      }
    }
  } else if (plan.environment === 'coast') {
    const water = b.material('Stylized shallow water', snow ? '#a2c2cf' : '#6fa8aa');
    b.mesh('Imagined lagoon', plane, water, [16, 0.012, 0], [16, 43, 1], [-Math.PI / 2, 0, 0]);
    const sand = b.material('Dune sand', snow ? '#e5e1d8' : '#cbbb98');
    for (let i = 0; i < 8; i++) {
      const z = -18 + i * 5;
      b.mesh('Coastal dune', round, sand, [-15 - random() * 3, 0.3, z], [4, 1.4, 3.6]);
      stone(10 + random() * 2, z, 0.7 + random());
    }
    for (const z of [-12, 4, 15]) tree(-10, z, 3.8, false);
  } else if (plan.environment === 'urban') {
    const walls = ['#bcb6a9', '#9caeab', '#b5a28f'].map((color, i) => b.material(`Facade ${i}`, color));
    const glass = b.material('Window glass', '#638a98');
    for (const side of [-1, 1]) {
      for (let row = 0; row < 4; row++) {
        const height = 4 + random() * 5, z = -15 + row * 9, x = side * 15;
        b.mesh('City pavilion', box, walls[row % walls.length], [x, height / 2, z], [6, height, 6]);
        b.mesh('Building cornice', box, frame, [x, height + 0.15, z], [6.3, 0.3, 6.3]);
        for (let level = 1; level < height - 0.5; level += 1.7) {
          for (const offset of [-1.8, 0, 1.8]) b.mesh('Inward window', box, glass,
            [x - side * 3.01, level, z + offset], [0.035, 0.9, 0.9]);
        }
        tree(side * 9.5, z + 3.6, 3, false);
      }
    }
  } else {
    const count = plan.environment === 'forest' ? 18 : 8;
    for (const side of [-1, 1]) for (let i = 0; i < count; i++) {
      const z = -20 + (i / count) * 40 + random(), x = side * (11 + random() * 9);
      tree(x, z, 3.5 + random() * 3, plan.environment === 'forest' && i % 3 !== 0);
      if (i % 3 === 0) stone(side * 9.7, z, 0.6 + random() * 0.5);
    }
  }

  // A readable destination, without enclosing walls or a collision sky dome.
  for (const x of [-3.6, 3.6]) {
    b.mesh('Pergola post', box, wood, [x, 1.75, -17], [0.22, 3.5, 0.22]);
    b.mesh('Pergola post', box, wood, [x, 1.75, -20], [0.22, 3.5, 0.22]);
    b.mesh('Garden bench seat', box, wood, [x, 0.48, -13], [2.2, 0.16, 0.7]);
    for (const dx of [-0.8, 0.8]) b.mesh('Bench foot', box, frame, [x + dx, 0.2, -13], [0.15, 0.4, 0.5]);
  }
  for (let z = -20; z <= -17; z += 0.5) b.mesh('Pergola slat', box, wood, [0, 3.55, z], [7.8, 0.15, 0.14]);
  for (const side of [-1, 1]) for (const z of [12, 4, -4, -12]) {
    b.mesh('Path light bollard', box, frame, [side * 2.5, 0.45, z], [0.16, 0.9, 0.16]);
    b.mesh('Path light', box, glow, [side * 2.5, 0.94, z], [0.25, 0.12, 0.25]);
  }

  const photoStops = [];
  for (const [i, photo] of validated.entries()) {
    const side = i % 2 ? 1 : -1;
    const x = side * 6.1, z = 8 - Math.floor(i / 2) * 8;
    const yaw = -side * Math.PI / 2;
    const width = Math.min(3, 2 * photo.aspect), height = width / photo.aspect;
    const local = (u, y, v) => [x + u * Math.cos(yaw) + v * Math.sin(yaw), y, z - u * Math.sin(yaw) + v * Math.cos(yaw)];
    b.mesh('Photo frame', box, frame, local(0, 1.8, 0), [width + 0.18, height + 0.18, 0.14], [0, yaw, 0]);
    b.mesh('Original photo panel', plane, b.photo(photo), local(0, 1.8, 0.075), [width, height, 1], [0, yaw, 0],
      { sourceId: photo.id, provenance: 'original', placement: 'imagined' });
    for (const u of [-width * 0.3, width * 0.3]) b.mesh('Gallery support', box, metal,
      local(u, (1.8 - height / 2) / 2, 0), [0.09, 1.8 - height / 2, 0.09], [0, yaw, 0]);
    photoStops.push({ sourceId: photo.id, position: [side * 3.8, 1.6, z] });
  }
  return b.finish([0, 1.6, 14], photoStops);
}
