import Ajv from 'ajv';
import sharp from 'sharp';
import { requireCondition as check } from '../../packages/runtime/memory.mjs';

export const visionModel = 'qwen3-vl:4b';
const vector = { type: 'array', items: { type: 'number', minimum: -50, maximum: 50 }, minItems: 3, maxItems: 3 };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
export const planSchema = {
  type: 'object', additionalProperties: false,
  required: ['observed', 'inferred', 'floorSize', 'floorColor', 'height', 'indoors', 'spawn', 'lookAt', 'parts'],
  properties: {
    observed: { type: 'string', maxLength: 2000 }, inferred: { type: 'string', maxLength: 2000 },
    floorSize: { type: 'array', items: { type: 'number', minimum: 3, maximum: 40 }, minItems: 2, maxItems: 2 },
    floorColor: color, height: { type: 'number', minimum: 2.3, maximum: 12 }, indoors: { type: 'boolean' },
    spawn: vector, lookAt: vector,
    parts: { type: 'array', minItems: 3, maxItems: 120, items: {
      type: 'object', additionalProperties: false, required: ['name', 'shape', 'position', 'size', 'yaw', 'color', 'metallic'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        shape: { enum: ['box', 'sphere', 'cylinder', 'cone'] }, position: vector,
        size: { type: 'array', items: { type: 'number', minimum: 0.02, maximum: 40 }, minItems: 3, maxItems: 3 },
        yaw: { type: 'number', minimum: -3.142, maximum: 3.142 }, color, metallic: { type: 'number', minimum: 0, maximum: 1 }
      }
    } }
  }
};
const validate = new Ajv().compile(planSchema);

export function validatePlan(plan) {
  check(validate(plan), 502, 'SCENE_PLAN_INVALID', 'The photo interpretation did not produce a usable layout. Try a clearer photo.');
  check(Math.abs(plan.spawn[0]) < plan.floorSize[0] / 2 - 0.4 && Math.abs(plan.spawn[2]) < plan.floorSize[1] / 2 - 0.4 &&
    plan.spawn[1] >= 0 && plan.spawn[1] < 0.15, 502, 'SCENE_PLAN_INVALID', 'The layout needs a clear floor position. Try a wider view of the room.');
  return plan;
}

export async function visionReady() {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    const result = await response.json();
    return result.models?.some(item => item.name === visionModel) ?? false;
  } catch { return false; }
}

export async function interpretPhoto(sourcePath, description, signal) {
  const image = await sharp(sourcePath).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  const instructions = `Reconstruct the photographed place as a navigable, recognizable 3D scene using the JSON schema below.
Use the photo as evidence for architecture, object placement, silhouettes, colors, openings, and lighting. Incorporate the user's remembered details as additions. Separate observed details from inferred hidden areas in the two text fields.
Coordinates are right-handed Y-up, in estimated meters. The floor is centered at (0,0,0). The source camera stands near the positive-Z edge looking toward negative Z. X increases to the viewer's right. spawn is the user's FEET on the floor, with Y=0.03, and lookAt is an eye-level target inside the scene. Leave a clear standing area and connected walking space around the spawn. Infer sensible scale from furniture. Keep the source camera perspective and visible spatial relationships.
The renderer adds a solid floor using floorSize [width,depth] and floorColor. It adds a ceiling at height if indoors. Include the walls and all furniture as parts. Build doorways and windows from separate wall segments with real openings. Give chairs and tables legs, seats, backs and tops, rather than solid obstruction blocks. Use named groups of colored primitive parts for recognizable furniture, lamps, plants, railings, and other important details. The primitive size is its full [width,height,depth], position is its center, and yaw is rotation about Y in radians. Cylinders and cones point upward. Keep objects above the floor and within its extent. A sphere can be stretched for cushions or foliage.
Use at most 120 parts. Prioritize the source's distinctive layout and the user's remembered details. Preserve clear passages. Hidden geometry is an inferred continuation of the place. Return only schema-valid JSON.
Schema: ${JSON.stringify(planSchema)}`;
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ model: visionModel, stream: false, think: false, format: planSchema, keep_alive: '5m',
      options: { temperature: 0, num_ctx: 16384, num_predict: 10000 },
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: 'Remembered details\n' + (description || 'Use the visible photo and infer ordinary surroundings.'), images: [image.toString('base64')] }] })
  });
  check(response.ok, 503, 'VISION_UNAVAILABLE', 'Photo interpretation is unavailable. Check Ollama and try again.');
  const result = await response.json();
  let plan;
  try { plan = JSON.parse(result.message.content); } catch { check(false, 502, 'SCENE_PLAN_INVALID', 'The photo interpretation was incomplete. Try a simpler description.'); }
  return validatePlan(plan);
}

export function scenePython(plan) {
  validatePlan(plan);
  // Data is decoded as JSON. Model output is never executed as Python.
  const encoded = Buffer.from(JSON.stringify(plan)).toString('base64');
  return `import bpy, json, base64, math
from mathutils import Vector
plan = json.loads(base64.b64decode('${encoded}').decode('utf-8'))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0
materials = {}
def material(color, metallic=0):
    key = (color, metallic)
    if key not in materials:
        value = bpy.data.materials.new('Everwhere_' + color)
        value.use_nodes = True
        shader = value.node_tree.nodes.get('Principled BSDF')
        rgb = [int(color[i:i+2], 16) / 255.0 for i in (1,3,5)]
        rgb = [((c + 0.055)/1.055)**2.4 if c > 0.04045 else c/12.92 for c in rgb]
        shader.inputs['Base Color'].default_value = (*rgb, 1)
        shader.inputs['Roughness'].default_value = 0.58
        shader.inputs['Metallic'].default_value = metallic
        materials[key] = value
    return materials[key]
def make(name, shape, position, size, yaw, color, metallic=0):
    x,y,z = position
    location = (x,-z,y)
    if shape == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.5, location=location)
    elif shape == 'cylinder': bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.5, depth=1, location=location)
    elif shape == 'cone': bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.5, radius2=0, depth=1, location=location)
    else: bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size[0],size[2],size[1])
    obj.rotation_euler.z = yaw
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material(color, metallic))
    if shape == 'box':
        bevel = obj.modifiers.new('Soft edges', 'BEVEL')
        bevel.width = min(0.025, min(size) * 0.12)
        bevel.segments = 2
        bpy.ops.object.modifier_apply(modifier=bevel.name)
    triangulate = obj.modifiers.new('Portable triangles', 'TRIANGULATE')
    bpy.ops.object.modifier_apply(modifier=triangulate.name)
    return obj
width, depth = plan['floorSize']
make('Floor', 'box', [0,-0.1,0], [width,0.2,depth], 0, plan['floorColor'])
if plan['indoors']: make('Inferred ceiling', 'box', [0,plan['height']+0.1,0], [width,0.2,depth], 0, '#e8e5df')
for i, part in enumerate(plan['parts']):
    make(str(i) + '_' + part['name'], part['shape'], part['position'], part['size'], part['yaw'], part['color'], part['metallic'])
bpy.ops.object.camera_add()
camera = bpy.context.object
camera.name = 'Source view'
x,y,z = plan['spawn']
camera.location = (x,-z,y+1.6)
x,y,z = plan['lookAt']
direction = Vector((x,-z,y)) - camera.location
camera.rotation_euler = direction.to_track_quat('-Z','Y').to_euler()
camera.data.lens = 28
scene.camera = camera
bpy.ops.object.light_add(type='AREA', location=(0,0,plan['height']-0.25))
light = bpy.context.object
light.name = 'Room light'
light.data.energy = 500
light.data.shape = 'DISK'
light.data.size = max(width,depth)*0.6
if not scene.world: scene.world = bpy.data.worlds.new('Everwhere daylight')
scene.world.color = (0.25,0.25,0.25)
result = {'objects': len(plan['parts']), 'spawn': plan['spawn'], 'lookAt': plan['lookAt'], 'units': 'meters'}
`;
}
