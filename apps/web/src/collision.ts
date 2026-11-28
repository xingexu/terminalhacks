import { InstancedMesh, Matrix3, Matrix4, Mesh, Triangle, Vector3, type Object3D } from 'three';
import { Octree } from 'three/addons/math/Octree.js';

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
