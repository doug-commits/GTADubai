import * as THREE from 'three';
import type { CameraMode } from '../contracts';
import type { Car } from './car';
import type { CenterlinePath, PathSample } from '../world/path';
import { MAX_SPEED } from './car';
import { DRIVER_X, EYE_Y, EYE_Z } from './cockpit';

/**
 * The camera rigs.
 *
 * All of them drive the same perspective camera and the same world; only the
 * framing differs. FPV is what ships — see `FpvRig` — with the chase rig kept
 * as the selectable alternative and the top-down rig kept for reference.
 */

export interface CameraRig {
  readonly mode: CameraMode;
  reset(car: Car, path: CenterlinePath): void;
  update(dt: number, car: Car, path: CenterlinePath, sample: PathSample, camera: THREE.PerspectiveCamera): void;
  /** Screen-space point the radial motion blur radiates from, in 0..1 UV. */
  readonly focal: THREE.Vector2;
  /** True when the camera sits inside the car, so the interior must be drawn. */
  readonly interior?: boolean;
}

const _look = new THREE.Vector3();
const _want = new THREE.Vector3();

/**
 * ===========================================================================
 *  FPV — the driver's eye
 * ===========================================================================
 *
 *  The shipping camera. Sitting in the seat solves three separate problems at
 *  once, which is why it is the default:
 *
 *  1. The chase rig spent the bottom third of a portrait phone on empty road
 *     directly behind the car, because the framing needed the car in shot and
 *     the car sits above the ground. From the seat, that same third of the
 *     screen is the bonnet, the dash and the wheel — the parts that say "car".
 *  2. Speed at 250 km/h is a function of how close the nearest thing to the
 *     lens is. Nothing is closer than your own dashboard.
 *  3. Gaps in traffic are judged from the driver's line, not from twelve
 *     metres back and four up. Threading a lane is a different, better read
 *     when the eye is where the decision is actually made.
 *
 *  The rig reproduces the car's own transform (see `Car.syncTransform`) rather
 *  than reading `car.group`, because the rig updates before the car's matrix
 *  does and a frame of lag on a head-mounted camera is immediately visible as
 *  swim.
 */
export class FpvRig implements CameraRig {
  readonly mode = 'fpv' as const;
  readonly focal = new THREE.Vector2(0.5, 0.5);
  readonly interior = true;

  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private quat = new THREE.Quaternion();
  private offset = new THREE.Quaternion();
  private eye = new THREE.Vector3();
  /** Smoothed look-into-the-corner yaw, radians. */
  private leadYaw = 0;
  /** Smoothed head lean under lateral load, radians of roll. */
  private lean = 0;
  private bob = 0;
  private seed = Math.random() * 100;

  reset(car: Car, path: CenterlinePath) {
    this.leadYaw = 0;
    this.lean = 0;
    this.bob = 0;
    const p = path.sample(car.s);
    this.eye.set(p.x, EYE_Y, p.z);
  }

  update(
    dt: number,
    car: Car,
    path: CenterlinePath,
    sample: PathSample,
    camera: THREE.PerspectiveCamera,
  ) {
    const speed01 = THREE.MathUtils.clamp(car.speed / MAX_SPEED, 0, 1.3);

    // --- eye position -------------------------------------------------------
    // Same transform the car body gets, evaluated here so the head is locked to
    // the shell to the millimetre.
    this.euler.set(car.pitch, sample.heading + car.yaw, car.roll);
    this.quat.setFromEuler(this.euler);

    // Head bob: a shallow vertical oscillation whose rate follows road speed.
    // It is the difference between "a camera moving forward" and "a person in
    // a seat", and it costs one sine.
    this.bob += dt * (2.6 + speed01 * 7.0);
    const bobY = Math.sin(this.bob) * (0.006 + speed01 * 0.010);

    this.eye.set(DRIVER_X, EYE_Y + bobY, EYE_Z).applyQuaternion(this.quat);
    this.eye.x += sample.x + sample.nx * car.t;
    this.eye.z += sample.z + sample.nz * car.t;
    camera.position.copy(this.eye);

    // --- where the driver is looking ---------------------------------------
    // Eyes go where the car is going, not where the nose is pointing. Take the
    // heading of the corridor a few seconds ahead and rotate part of the way
    // toward it; on a straight this is zero and on a bend it is what keeps the
    // road in frame instead of sliding off the edge.
    const leadDist = 70 + speed01 * 130;
    const ahead = path.sample(Math.min(path.length, car.s + leadDist));
    let dh = ahead.heading - sample.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    // Counter the car's own slide as well: in a drift the nose is not pointing
    // down the road, and the driver's head is still looking down the road.
    const want = dh * 0.62 - car.yaw * 0.55;
    this.leadYaw += (want - this.leadYaw) * (1 - Math.exp(-dt * 5.0));

    // Lateral load pushes the head over. Small, and against the turn.
    const wantLean = THREE.MathUtils.clamp(car.vt * 0.010, -0.09, 0.09);
    this.lean += (wantLean - this.lean) * (1 - Math.exp(-dt * 6.0));

    // Pitch. Slightly nose-up, which sounds wrong for a driving game and is
    // not: the dash and the bonnet occupy fixed elevations below the horizon,
    // so every degree of downward pitch is a degree of interior added to the
    // bottom of a portrait frame. Lifting the lens is how the car keeps its
    // share of the screen to the ~28 % that reads as "in a car" rather than
    // "behind a dashboard". It settles back toward level with speed, which
    // drops the horizon and puts the road under the player at 300 km/h.
    const pitch = 0.050 - speed01 * 0.020 - car.pitch * 0.5;

    // --- vibration ----------------------------------------------------------
    // High-frequency, low-amplitude, and scaled by speed and slip. This is the
    // single strongest cue that the seat is attached to an engine.
    const t = performance.now() * 0.001 + this.seed;
    const amp = 0.0016 + speed01 * 0.0042 + car.slip * 0.010;
    const vibX = Math.sin(t * 51.7) * amp + Math.sin(t * 23.1) * amp * 0.5;
    const vibY = Math.sin(t * 43.3) * amp * 0.8;
    const vibZ = Math.sin(t * 37.9) * amp * 1.3;

    this.euler.set(pitch + vibX, this.leadYaw + vibY, this.lean + vibZ - car.roll * 0.30);
    this.offset.setFromEuler(this.euler);
    camera.quaternion.copy(this.quat).multiply(this.offset);

    // --- lens ---------------------------------------------------------------
    // FOV is speed-scaled, and it is also what decides how much of the screen
    // the car itself owns — which is not obvious and is worth spelling out.
    //
    // The bonnet and the dash sit at fixed elevations below the eye. Screen
    // position goes as tan(elevation) / tan(halfFov), so widening the lens does
    // not merely add periphery: it drags every one of those fixed elevations
    // toward the centre of the frame. At the 96 degrees this started on, a
    // portrait phone was giving 40 % of its screen to bodywork. Pulled back to
    // 58, the same car sits in the bottom quarter with nothing else moved.
    camera.fov = 58 + speed01 * 22;
    // The near plane has to clear the wheel rim, which is ~0.25 m from the eye.
    camera.near = 0.12;
    // Matched to the other rigs. Pushing it out to 5.2 km bought nothing — the
    // dust band has everything past about 2.5 km fully dissolved into the sky —
    // and cost draw calls, because the metro viaduct and the signage stream in
    // frustum-culled chunks and a longer frustum simply admits more of them.
    camera.far = 4200;
    camera.updateProjectionMatrix();

    // The vanishing point is wherever the driver is looking.
    this.focal.set(0.5 - this.leadYaw * 0.30, 0.50);
  }
}

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
    // Forward for heading θ is (-sin θ, -cos θ), so backwards is (sin θ, cos θ).
    const back = 20 + speed01 * 10;
    camera.position.x += Math.sin(this.heading) * back;
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
  if (mode === 'chase') return new ChaseRig();
  if (mode === 'topdown') return new TopDownRig();
  return new FpvRig();
}
