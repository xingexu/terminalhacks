import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Box3, BoxGeometry, BufferGeometry, Float32BufferAttribute, LatheGeometry, PerspectiveCamera, SphereGeometry, Vector2, Vector3 } from 'three';

// An authored photographic stage. Surfaces have real depth and collision, but
// neither dimensions nor unseen surfaces are recovered from the photographs.
export async function generatePhotoSet({ id, title, photos, setting = 'street' }) {
  if (!['street', 'airshow'].includes(setting)) throw new TypeError('Choose street or airshow as the photo-set setting.');
  if (typeof id !== 'string' || !id || id.length > 128 || typeof title !== 'string' || !title || title.length > 180 ||
      !Array.isArray(photos) || photos.length < 1 || photos.length > 3) throw new TypeError('A photo set needs an id, title and one to three JPEGs.');
  const unique = new Set();
  for (const photo of photos) {
    if (!photo || typeof photo.id !== 'string' || !photo.id || unique.has(photo.id) || !Buffer.isBuffer(photo.jpeg) || photo.jpeg.length > 16 * 1024 ** 2)
      throw new TypeError('Each photo needs a unique id and a JPEG buffer up to 16 MB.');
    unique.add(photo.id);
    const info = await sharp(photo.jpeg, { limitInputPixels: 32_000_000 }).metadata();
    if (info.format !== 'jpeg' || !info.width || !info.height || info.width * info.height > 32_000_000 || info.width > 8192 || info.height > 8192)
      throw new TypeError('Use JPEG images up to 32 megapixels and 8192 pixels per side.');
  }
  const inputHash = createHash('sha256').update(id).update(title);
  photos.forEach(photo => inputHash.update(photo.id).update(photo.jpeg));
  const spawn = [0, 1.6, 5.8];
  const scene = {
    asset: { version: '2.0', generator: 'Everwhere bounded photographic 3D set', extras: {
      provider: 'photo-set-v1', method: 'procedural', planId: id, inputHash: inputHash.digest('hex'),
      provenance: 'imagined', units: 'm', coordinateSystem: 'right-handed-y-up', spawn, spawnYaw: 0,
      description: 'Imagined 3D set with projected photographic surfaces. Approximate authored geometry, not photogrammetry. Walking is enclosed by the photographic set surfaces.',
      sourceIds: photos.map(photo => photo.id), walkableArea: 'Short promenade and right-side entrance approach',
      ...(setting === 'airshow' && { setting, placeReference: 'Toronto waterfront — imagined airshow setting', walkableArea: 'Bounded waterfront promenade with approximate geometry', animationDisclosure: 'Illustrative red-and-white aircraft motion, not a flight schedule or a recorded event.' }),
      photoStops: [{ sourceId: photos[0].id, position: spawn }, ...(photos[1] ? [{ sourceId: photos[1].id, position: [3.2, 1.6, 3.5] }] : [])]
    } },
    extensionsUsed: ['KHR_materials_unlit'], extensionsRequired: ['KHR_materials_unlit'],
    scene: 0, scenes: [{ name: title, nodes: [] }], nodes: [], meshes: [], materials: [],
    accessors: [], bufferViews: [], buffers: [], images: [], textures: [],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }]
  };
  const chunks = []; let length = 0; let triangles = 0;
  const bounds = new Box3();
  function bytes(buffer, target) {
    const padding = (4 - length % 4) % 4;
    if (padding) { chunks.push(Buffer.alloc(padding)); length += padding; }
    const index = scene.bufferViews.length;
    scene.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: buffer.length, ...(target && { target }) });
    chunks.push(buffer); length += buffer.length; return index;
  }
  function accessor(array, size, componentType, target, limits = {}) {
    const index = scene.accessors.length;
    scene.accessors.push({ bufferView: bytes(Buffer.from(array.buffer, array.byteOffset, array.byteLength), target), componentType,
      count: array.length / size, type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][size - 1], ...limits });
    return index;
  }
  function material(name, color, texture) {
    const index = scene.materials.length;
    scene.materials.push({ name, extensions: { KHR_materials_unlit: {} }, doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 1,
        ...(texture !== undefined && { baseColorTexture: { index: texture } }) } });
    return index;
  }
  const photoMaterials = photos.map(photo => {
    const image = scene.images.length;
    scene.images.push({ name: photo.id, mimeType: 'image/jpeg', bufferView: bytes(photo.jpeg) });
    scene.textures.push({ source: image, sampler: 0 });
    return material('Photographic interpretation: ' + photo.id, [1, 1, 1], image);
  });
  const stone = material('Entrance plinth — authored stone', [.24, .26, .25]);
  function mesh(name, geometry, materialIndex) {
    geometry.computeBoundingBox(); bounds.union(geometry.boundingBox);
    const positions = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    const attributes = { POSITION: accessor(positions.array, 3, 5126, 34962, { min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray() }) };
    if (uv) attributes.TEXCOORD_0 = accessor(uv.array, 2, 5126, 34962);
    const indices = index ? accessor(index.array, 1, index.array instanceof Uint32Array ? 5125 : 5123, 34963) : undefined;
    triangles += (index?.count ?? positions.count) / 3;
    const nodeIndex = scene.nodes.length;
    scene.scenes[0].nodes.push(nodeIndex);
    scene.nodes.push({ name, mesh: scene.meshes.length });
    scene.meshes.push({ primitives: [{ attributes, ...(indices !== undefined && { indices }), material: materialIndex, mode: 4 }] });
    geometry.dispose(); return nodeIndex;
  }
  const source = new PerspectiveCamera(65, 1920 / 1086, .05, 100);
  source.position.fromArray(spawn); source.updateMatrixWorld(); source.updateProjectionMatrix();
  const projected = point => {
    const p = new Vector3(...point).project(source);
    return [Math.max(0, Math.min(1, (p.x + 1) / 2)), Math.max(0, Math.min(1, (1 - p.y) / 2))];
  };
  function surface(name, origin, horizontal, vertical, materialIndex, uvFor = projected, columns = 64, rows = 32) {
    const positions = [], uv = [], indices = [];
    for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
      const u = col / columns, v = row / rows;
      const point = origin.map((value, axis) => value + horizontal[axis] * u + vertical[axis] * v);
      positions.push(...point); uv.push(...uvFor(point, u, v));
    }
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col, b = a + 1, c = a + columns + 1, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2)); geometry.setIndex(indices);
    mesh(name, geometry, materialIndex);
  }
  function box(name, position, size, materialIndex) {
    const geometry = new BoxGeometry(...size); geometry.translate(...position); return mesh(name, geometry, materialIndex);
  }
  // Vertices wind toward the player. The floor is a single uninterrupted y=0
  // surface: no ramps, no invisible collision plane and no mesh under the spawn.
  surface('Projected snowy promenade', [-6, 0, 9], [12, 0, 0], [0, 0, -27], photoMaterials[0]);
  surface('Left photographic facade', [-4.5, 0, 9], [0, 0, -27], [0, 10, 0], photoMaterials[0]);
  surface('Right photographic facade', [4.5, 0, -18], [0, 0, 27], [0, 10, 0], photoMaterials[0]);
  surface('Distant village and mountain', [-4.5, 0, -18], [9, 0, 0], [0, 10, 0], photoMaterials[0]);
  surface('Sky above the authored set', [-4.5, 10, -18], [9, 0, 0], [0, 0, 27], photoMaterials[0]);
  // Unseen return direction is deliberately authored from the available photo,
  // not represented as captured, inferred or geographically continuous.
  surface('Authored return-facing photographic surface', [4.5, 0, 9], [-9, 0, 0], [0, 5.1, 0], photoMaterials[0], (_p, u, v) => [u, 1 - v]);
  if (photos[1] && setting === 'street') {
    // A shallow entrance approach gives a real right turn. It does not pretend
    // that the closed pictured door is a navigable or reconstructed interior.
    surface('Photographic entrance at right-side approach', [4.35, 0, 2.15], [0, 0, 2.7], [0, 3.45, 0], photoMaterials[1], (_p, u, v) => [.49 + .35 * u, 1 - .86 * v], 40, 40);
    box('Left entrance jamb', [4.31, 1.75, 2.12], [.16, 3.5, .14], stone);
    box('Right entrance jamb', [4.31, 1.75, 4.88], [.16, 3.5, .14], stone);
    box('Entrance lintel', [4.31, 3.5, 3.5], [.16, .14, 2.9], stone);
  }
  function boundary(name, from, to) {
    const span = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const alongX = from[0] !== to[0];
    // A low photographic snow/stone edge keeps the movement boundary legible
    // without putting a flat CG fence across the street. Its steep sides remain
    // collision geometry, including when the player jumps against the edge.
    const geometry = new BoxGeometry(alongX ? span : .46, .9, alongX ? .46 : span);
    const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    for (let i = 0; i < positions.count; i++) {
      if (positions.getY(i) > 0) {
        if (alongX) positions.setZ(i, positions.getZ(i) * .6);
        else positions.setX(i, positions.getX(i) * .6);
      }
      // This references the source photograph's lower-left snow/stone area;
      // the original image bytes are retained, with no synthetic pixel edits.
      uv.setXY(i, .015 + uv.getX(i) * .11, .80 + uv.getY(i) * .13);
    }
    geometry.translate((from[0] + to[0]) / 2, .45, (from[1] + to[1]) / 2);
    mesh(name + ' photographic snowbank', geometry, photoMaterials[0]);
  }
  // The photographic facade, end and return meshes enclose the authored set.
  // Do not add a barrier across the photographed street.
  if (setting === 'airshow') {
    const white = material('Aircraft ivory through blue atmospheric haze', [.47, .54, .57]);
    const red = material('Aircraft muted red through atmospheric haze', [.28, .105, .12]);
    const underside = material('Aircraft shaded underside', [.12, .18, .22]);
    const canopy = material('Aircraft dark blue canopy', [.055, .10, .14]);
    function foil(name, outline, materialIndex, thickness = .012) {
      const vertices = [], indices = [], count = outline.length;
      for (const sign of [-1, 1]) for (const point of outline) vertices.push(point[0], point[1] + sign * thickness / 2, point[2]);
      for (let i = 1; i < count - 1; i++) indices.push(0, i + 1, i, count, count + i, count + i + 1);
      for (let i = 0; i < count; i++) { const next = (i + 1) % count; indices.push(i, next, count + i, next, count + next, count + i); }
      const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices);
      return mesh(name, geometry, materialIndex);
    }
    const times = new Float32Array(Array.from({ length: 41 }, (_, i) => i));
    const timeAccessor = accessor(times, 1, 5126, undefined, { min: [0], max: [40] });
    const animation = { name: 'Imagined waterfront aircraft formation', samplers: [], channels: [] };
    for (let plane = 0; plane < 3; plane++) {
      const fuselage = new LatheGeometry([[0, -.34], [.014, -.30], [.04, -.12], [.044, .055], [.024, .22], [0, .29]].map(point => new Vector2(...point)), 12);
      fuselage.rotateX(Math.PI / 2);
      const glass = new SphereGeometry(.035, 12, 8); glass.scale(.65, .45, 1.7); glass.translate(0, .039, -.095);
      const children = [mesh('Tapered aircraft fuselage', fuselage, white), mesh('Aircraft canopy', glass, canopy),
        foil('Shaded fuselage underside', [[-.022, -.032, -.23], [.022, -.032, -.23], [.028, -.032, .14], [-.028, -.032, .14]], underside)];
      for (const side of [-1, 1]) {
        children.push(foil('Swept tapered wing', [[side * .025, 0, -.12], [side * .31, .005, .045], [side * .28, .005, .085], [side * .03, 0, .045]], white));
        children.push(foil('Muted red wingtip', [[side * .25, .006, .012], [side * .31, .006, .045], [side * .28, .006, .085], [side * .245, .006, .075]], red, .014));
        children.push(foil('Swept tailplane', [[side * .018, .018, .15], [side * .12, .018, .225], [side * .105, .018, .25], [side * .018, .018, .225]], red, .009));
      }
      const fin = new BufferGeometry();
      fin.setAttribute('position', new Float32BufferAttribute([0, .025, .13, 0, .14, .22, 0, .025, .265], 3)); fin.setIndex([0, 1, 2]);
      children.push(mesh('Swept vertical tail', fin, red));
      scene.scenes[0].nodes.splice(-children.length);
      const node = scene.nodes.length;
      const lateral = [-.7, 0, .6][plane], altitude = [0, .12, -.05][plane], depth = [0, .95, 1.9][plane];
      scene.nodes.push({ name: 'Moving aircraft ' + (plane + 1), children, translation: [-2.7 + lateral, 6.4 + altitude, -7 - depth], extras: { decorative: true, imagined: true } });
      scene.scenes[0].nodes.push(node);
      const positions = [], rotations = [];
      for (let i = 0; i <= 40; i++) {
        const angle = Math.PI + i / 40 * Math.PI * 2;
        positions.push(2.7 * Math.cos(angle) + lateral, 6.4 + altitude + Math.sin(angle) * .25, -7 + 3.5 * Math.sin(angle) - depth);
        const yaw = Math.atan2(2.7 * Math.sin(angle), -3.5 * Math.cos(angle));
        const rotation = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
        if (i && rotation.reduce((sum, value, axis) => sum + value * rotations[(i - 1) * 4 + axis], 0) < 0) rotation.forEach((value, axis) => { rotation[axis] = -value; });
        rotations.push(...rotation);
      }
      for (const [path, values, size] of [['translation', positions, 3], ['rotation', rotations, 4]]) {
        const sampler = animation.samplers.length;
        animation.samplers.push({ input: timeAccessor, output: accessor(new Float32Array(values), size, 5126), interpolation: 'LINEAR' });
        animation.channels.push({ sampler, target: { node, path } });
      }
    }
    scene.animations = [animation];
  }
  if (triangles > 250_000) throw new Error('Photo set exceeds the browser triangle budget.');
  scene.buffers.push({ byteLength: length });
  const raw = Buffer.from(JSON.stringify(scene));
  const json = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
  const binary = Buffer.concat([...chunks, Buffer.alloc((4 - length % 4) % 4)]);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(binary.length); binaryHeader.writeUInt32LE(0x004e4942, 4);
  return { buffer: Buffer.concat([header, json, binaryHeader, binary]), triangles, spawn, boundsMin: bounds.min.toArray(), boundsMax: bounds.max.toArray(),
    provider: 'photo-set-v1', planId: id, inputHash: scene.asset.extras.inputHash, sourceIds: photos.map(photo => photo.id) };
}
