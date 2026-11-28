import { Box3, InstancedMesh, Matrix3, Matrix4, Mesh, Ray, Triangle, Vector3, type Object3D } from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';

export function safeCameraPosition(world: Octree, point: [number, number, number]) {
  const eye = new Vector3().fromArray(point);
  const capsule = new Capsule(eye.clone().add(new Vector3(0, -1.3, 0)), eye.clone().add(new Vector3(0, -0.15, 0)), 0.3);
  const overlap = world.capsuleIntersect(capsule);
  return !overlap || overlap.depth < 0.025;
}

export function validatedSceneSpawn(world: Octree, bounds: Box3, value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return null;
  const point: [number, number, number] = [value[0], value[1], value[2]];
  const eye = new Vector3(...point);
  if (!bounds.containsPoint(eye) || !safeCameraPosition(world, point)) return null;
  const floor = world.rayIntersect(new Ray(eye, new Vector3(0, -1, 0)));
  if (!floor || Math.abs(floor.distance - 1.6) > 0.1 || floor.triangle.getNormal(new Vector3()).y < 0.55) return null;
  const spawn: [number, number, number] = [point[0], floor.position.y + 1.6, point[2]];
  return safeCameraPosition(world, spawn) ? spawn : null;
}

export function worldSurfaceNormal(object: Object3D, localNormal: Vector3, instanceId?: number) {
  object.updateWorldMatrix(true, false);
  const transform = object.matrixWorld.clone();
  if (object instanceof InstancedMesh && instanceId !== undefined) {
    const instance = new Matrix4();
    object.getMatrixAt(instanceId, instance);
    transform.multiply(instance);
  }
  return localNormal.clone().applyNormalMatrix(new Matrix3().getNormalMatrix(transform));
}

export function collisionFromObject(root: Object3D) {
  root.updateWorldMatrix(true, true);
  const collision = new Octree();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const instance = new Matrix4();
  const transform = new Matrix4();

  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry;
    const positions = geometry.getAttribute('position');
    if (!positions) return;
    const index = geometry.index;
    const count = index?.count ?? positions.count;
    const start = geometry.drawRange.start;
    const end = Math.min(count, start + geometry.drawRange.count);
    const instances = object instanceof InstancedMesh ? object.count : 1;

    for (let instanceId = 0; instanceId < instances; instanceId++) {
      transform.copy(object.matrixWorld);
      if (object instanceof InstancedMesh) {
        object.getMatrixAt(instanceId, instance);
        transform.multiply(instance);
      }
      const reverse = transform.determinant() < 0;
      for (let offset = start; offset + 2 < end; offset += 3) {
        object.getVertexPosition(index?.getX(offset) ?? offset, a).applyMatrix4(transform);
        object.getVertexPosition(index?.getX(offset + 1) ?? offset + 1, b).applyMatrix4(transform);
        object.getVertexPosition(index?.getX(offset + 2) ?? offset + 2, c).applyMatrix4(transform);
        collision.addTriangle(reverse
          ? new Triangle(a.clone(), c.clone(), b.clone())
          : new Triangle(a.clone(), b.clone(), c.clone()));
      }
    }
  });

  if (collision.bounds.isEmpty() === false) collision.build();
  return collision;
}
