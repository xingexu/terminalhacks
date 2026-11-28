import { Vector3 } from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { Octree } from 'three/addons/math/Octree.js';

// World units are meters. Fixed substeps keep sprinting from tunneling through walls.
export class Walker {
  readonly capsule = new Capsule(new Vector3(), new Vector3(), 0.3);
  readonly velocity = new Vector3();
  readonly eye = new Vector3();
  grounded = false;
  private accumulator = 0;
  private spawn = new Vector3();
  private offset = new Vector3();
  private direction = new Vector3();
  private world: Octree;

  constructor(world: Octree, position: Vector3) { this.world = world; this.place(position); }

  place(position: Vector3) {
    this.spawn.copy(position);
    this.capsule.start.copy(position).add(new Vector3(0, 0.3, 0));
    this.capsule.end.copy(position).add(new Vector3(0, 1.45, 0));
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.accumulator = 0;
    this.eye.copy(this.capsule.end).add(new Vector3(0, 0.15, 0));
  }

  update(delta: number, yaw: number, keys: Set<string>) {
    const forward = Number(keys.has('w') || keys.has('arrowup')) - Number(keys.has('s') || keys.has('arrowdown'));
    const strafe = Number(keys.has('d')) - Number(keys.has('a'));
    this.direction.set(-Math.sin(yaw) * forward + Math.cos(yaw) * strafe, 0,
      -Math.cos(yaw) * forward - Math.sin(yaw) * strafe).normalize().multiplyScalar(keys.has('shift') ? 5.5 : 2.8);
    if (keys.has(' ') && this.grounded) this.velocity.y = 5;
    keys.delete(' ');
    this.accumulator += Math.min(delta, 0.15);
    const step = 1 / 120;
    while (this.accumulator >= step) {
      this.accumulator -= step;
      const acceleration = 1 - Math.exp(-(this.grounded ? 18 : 4) * step);
      this.velocity.x += (this.direction.x - this.velocity.x) * acceleration;
      this.velocity.z += (this.direction.z - this.velocity.z) * acceleration;
      this.velocity.y -= 20 * step;
      this.capsule.translate(this.offset.copy(this.velocity).multiplyScalar(step));
      this.grounded = false;
      for (let iteration = 0; iteration < 3; iteration++) {
        const hit = this.world.capsuleIntersect(this.capsule);
        if (!hit) break;
        this.grounded ||= hit.normal.y > 0.55;
        const intoSurface = this.velocity.dot(hit.normal);
        if (intoSurface < 0) this.velocity.addScaledVector(hit.normal, -intoSurface);
        this.capsule.translate(hit.normal.multiplyScalar(hit.depth + 0.00001));
      }
    }
    if (this.capsule.end.y < this.spawn.y - 15) this.place(this.spawn);
    this.eye.copy(this.capsule.end).add(this.offset.set(0, 0.15, 0));
    return this.eye;
  }
}
