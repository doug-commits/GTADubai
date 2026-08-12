import * as THREE from 'three';
import type { CameraMode } from '../contracts';
import type { Car } from './car';
import type { CenterlinePath, PathSample } from '../world/path';
import { MAX_SPEED } from './car';

/**
 * The two camera rigs under evaluation.
 *
 * Both drive the same perspective camera and the same world; only the framing
 * differs, so a side-by-side judgement is genuinely about which one looks and
 * plays better rather than which one got more engineering attention.
 */

export interface CameraRig {
  readonly mode: CameraMode;
  reset(car: Car, path: CenterlinePath): void;
  update(dt: number, car: Car, path: CenterlinePath, sample: PathSample, camera: THREE.PerspectiveCamera): void;
  /** Screen-space point the radial motion blur radiates from, in 0..1 UV. */
  readonly focal: THREE.Vector2;
}

const _look = new THREE.Vector3();
const _want = new THREE.Vector3();

/**
 * Behind-the-car chase rig.
 *
 * Sits low and close. The whole feel comes from three things: the camera lags
 * the car so hard cornering swings it wide, the FOV opens with speed, and the
 * look-at target is pushed a long way down the road so the corridor rushes at
 * the viewer rather than sliding past.
 */
export class ChaseRig implements CameraRig {
  readonly mode = 'chase' as const;
  readonly focal = new THREE.Vector2(0.5, 0.56);
  private pos = new THREE.Vector3();
  private target = new THREE.Vector3();
  private shakeSeed = Math.random() * 100;

  reset(car: Car, path: CenterlinePath) {
    const p = path.sample(car.s);
    this.pos.set(p.x - p.tx * 12, 4.2, p.z - p.tz * 12);
    this.target.set(p.x, 1.6, p.z);
  }

  update(
    dt: number,
    car: Car,
    path: CenterlinePath,
    sample: PathSample,
    camera: THREE.PerspectiveCamera,
  ) {
    const speed01 = THREE.MathUtils.clamp(car.speed / MAX_SPEED, 0, 1.3);

    // Pull back and drop lower as speed rises — the ground gets closer to the
    // lens, which is most of the perceived velocity.
    const dist = 9.2 + speed01 * 3.6;
    const height = 3.55 - speed01 * 0.55;

    // Anchor behind the car in path space so the rig follows the corridor's
    // curves instead of swinging through the barriers on a bend.
    const behind = path.sample(Math.max(0, car.s - dist));
    _want.set(
      behind.x + behind.nx * (car.t * 0.72),
      height,
      behind.z + behind.nz * (car.t * 0.72),
    );

    // Yaw lag: the camera is slow to follow the car's slide, so drifting
    // actually shows the flank of the car.
    const lag = 1 - Math.exp(-dt * (6.5 - speed01 * 1.6));
    this.pos.lerp(_want, lag);

    // Look well ahead — further at speed.
    const ahead = path.sample(Math.min(path.length, car.s + 34 + speed01 * 46));
    _look.set(ahead.x + ahead.nx * car.t * 0.35, 1.35, ahead.z + ahead.nz * car.t * 0.35);
    this.target.lerp(_look, 1 - Math.exp(-dt * 7.5));

    camera.position.copy(this.pos);
    camera.lookAt(this.target);

    // Engine vibration: tiny, speed-scaled, high frequency. Removing this makes
    // the whole shot feel like a flythrough instead of a car.
    const t = performance.now() * 0.001 + this.shakeSeed;
    const amp = 0.012 + speed01 * 0.030 + car.slip * 0.05;
    camera.rotation.x += Math.sin(t * 47.3) * amp * 0.4;
    camera.rotation.z += Math.sin(t * 39.1) * amp * 0.5 - car.roll * 0.35;
    camera.rotation.y += Math.sin(t * 53.7) * amp * 0.25;

    camera.fov = 62 + speed01 * 22;
    camera.near = 0.4;
    camera.far = 4200;
    camera.updateProjectionMatrix();

    // Vanishing point tracks the road ahead so the blur radiates from where the
    // player is actually looking.
    this.focal.set(0.5 - car.yaw * 0.22, 0.55);
  }
}

/**
 * Stylised top-down rig — the old GTA 1/2 angle.
 *
 * Not a true orthographic plan view: a narrow FOV from high up, tilted a few
 * degrees off vertical, which is what gave those games their readable-but-solid
 * look. The camera rotates with the car so the road always runs up the screen.
 */
export class TopDownRig implements CameraRig {
  readonly mode = 'topdown' as const;
  readonly focal = new THREE.Vector2(0.5, 0.5);
  private pos = new THREE.Vector3();
  private heading = 0;
  private height = 58;

  reset(car: Car, path: CenterlinePath) {
    const p = path.sample(car.s);
    this.pos.set(p.x, this.height, p.z);
    this.heading = p.heading;
  }

  update(
    dt: number,
    car: Car,
    path: CenterlinePath,
    sample: PathSample,
    camera: THREE.PerspectiveCamera,
  ) {
    const speed01 = THREE.MathUtils.clamp(car.speed / MAX_SPEED, 0, 1.3);

    // Climb with speed so the player always sees the same distance of road
    // ahead in *time* rather than in metres — that is what keeps it playable.
    const wantHeight = 46 + speed01 * 34;
    this.height = THREE.MathUtils.damp(this.height, wantHeight, 3.2, dt);

    // Offset the focus ahead of the car so most of the screen is the road to come.
    const leadS = Math.min(path.length, car.s + 34 + speed01 * 52);
    const lead = path.sample(leadS);
    _want.set(lead.x + lead.nx * car.t * 0.5, this.height, lead.z + lead.nz * car.t * 0.5);
    this.pos.lerp(_want, 1 - Math.exp(-dt * 7));

    // Smoothly rotate the world so the corridor runs up-screen. Shortest-arc
    // interpolation, otherwise the view spins the long way round at the bends.
    let dh = sample.heading - this.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.heading += dh * (1 - Math.exp(-dt * 5.5));

    camera.position.copy(this.pos);
    // Pull back along the heading rather than sitting straight overhead. The
    // resulting few degrees of tilt keeps the sides of buildings visible, which
    // is what stops the view reading as a flat map — GTA 1/2 did the same.
    const back = 20 + speed01 * 10;
    camera.position.x -= Math.sin(this.heading) * back;
    camera.position.z += Math.cos(this.heading) * back;

    // Looking at the ground point under the focus puts the road running up the
    // screen, with the car's heading baked into the view geometry.
    _look.set(this.pos.x, 0, this.pos.z);
    camera.lookAt(_look);

    const t = performance.now() * 0.001;
    const amp = 0.004 + speed01 * 0.010;
    camera.rotation.x += Math.sin(t * 44.0) * amp;
    camera.rotation.y += Math.sin(t * 51.0) * amp;

    camera.fov = 40 + speed01 * 9;
    camera.near = 1;
    camera.far = 4200;
    camera.updateProjectionMatrix();

    this.focal.set(0.5, 0.5);
  }
}

export function makeRig(mode: CameraMode): CameraRig {
  return mode === 'chase' ? new ChaseRig() : new TopDownRig();
}
