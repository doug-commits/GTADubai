import * as THREE from 'three';
import { VEHICLE_BODY_GLSL, FOG_GLSL, vehicleUniforms, makeGlowMaterial } from './vehicle-shader';
import { ROAD_HALF_WIDTH } from '../world/corridor';
import type { CenterlinePath, PathSample } from '../world/path';

/**
 * Player car.
 *
 * The simulation lives entirely in path space — `s` metres along the corridor,
 * `t` metres to the right of the centreline — and is converted to world
 * transform only for rendering. Handling is deliberately arcade: high grip,
 * generous slip, no stalling and no reverse. The player should be able to steer
 * competently within one second of first touching the screen.
 */

export const MAX_SPEED = 76; // m/s ≈ 274 km/h
export const BOOST_SPEED = 98; // m/s ≈ 353 km/h
const LIMIT = ROAD_HALF_WIDTH + 1.4;

export interface CarInput {
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** Brake / lift, 0..1. */
  brake: number;
  boost: boolean;
}

export class Car {
  /** Arc length along the corridor, metres. */
  s = 0;
  /** Lateral offset from the centreline, metres (+ = right). */
  t = 0;
  /** Forward speed, m/s. */
  speed = 0;
  /** Lateral velocity, m/s. */
  vt = 0;
  /** Yaw relative to the path tangent, radians. */
  yaw = 0;
  /** Visual body roll and pitch. */
  roll = 0;
  pitch = 0;
  /** 0..1 how sideways the car is — drives skid audio and tyre smoke. */
  slip = 0;
  /** Engine revs 0..1, resets on each simulated gear change. */
  rpm = 0;
  gear = 1;
  /** Seconds of crash lockout remaining. */
  stun = 0;

  readonly group = new THREE.Group();
  private bodyMat: THREE.RawShaderMaterial;
  private wheels: THREE.Object3D[] = [];
  private headGlow: THREE.Group;
  private brakeGlow: THREE.Mesh[] = [];
  private beam: THREE.Mesh;

  constructor() {
    this.bodyMat = new THREE.RawShaderMaterial({
      name: 'car-body',
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...vehicleUniforms(),
        uColor: { value: new THREE.Color(0.62, 0.055, 0.02) }, // ember red
        uGloss: { value: 0.92 },
      },
      vertexShader: /* glsl */ `
        in vec3 position;
        in vec3 normal;
        uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
        uniform mat3 normalMatrix;
        out vec3 vN; out vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec3 vN; in vec3 vW;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir, uColor;
        uniform float uGloss, uFogNear, uFogFar;
        ${VEHICLE_BODY_GLSL}
        ${FOG_GLSL}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          vec3 col = carPaint(N, V, uColor, uSunDir, uGloss, 0.7);
          col = applyFog(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });

    this.buildMesh();
    this.headGlow = new THREE.Group();
    this.group.add(this.headGlow);
    this.beam = this.buildBeams();
    this.group.add(this.beam);
  }

  /**
   * Low-poly performance coupé assembled from scaled boxes. Silhouette does the
   * work — long nose, low cabin set back, wide haunches, visible wheels.
   */
  private buildMesh() {
    const add = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      mat: THREE.Material = this.bodyMat,
      taperTop = 1,
    ) => {
      const g = new THREE.BoxGeometry(w, h, d);
      if (taperTop !== 1) {
        // Pull the top face in to fake a tapered greenhouse / wedge nose.
        const pos = g.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          if (pos.getY(i) > 0) {
            pos.setX(i, pos.getX(i) * taperTop);
            pos.setZ(i, pos.getZ(i) * taperTop);
          }
        }
        pos.needsUpdate = true;
        g.computeVertexNormals();
      }
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, y, z);
      this.group.add(m);
      return m;
    };

    const glass = new THREE.RawShaderMaterial({
      name: 'car-glass',
      glslVersion: THREE.GLSL3,
      uniforms: { ...vehicleUniforms() },
      vertexShader: /* glsl */ `
        in vec3 position; in vec3 normal;
        uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
        out vec3 vN; out vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec3 vN; in vec3 vW;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir;
        uniform float uFogNear, uFogFar;
        ${VEHICLE_BODY_GLSL}
        ${FOG_GLSL}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          vec3 R = reflect(V, N);
          float fres = pow(1.0 - max(dot(-V, N), 0.0), 3.0);
          vec3 col = mix(vec3(0.008, 0.010, 0.016), skyRadiance(normalize(R), uSunDir), 0.30 + fres * 0.66);
          col = applyFog(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });
    const rubber = new THREE.MeshBasicMaterial({ color: 0x08070a });
    const rim = new THREE.MeshBasicMaterial({ color: 0x5a5350 });

    // Body: nose, main tub, haunches, cabin.
    add(1.86, 0.30, 1.5, 0, 0.50, -1.62, this.bodyMat, 0.86); // nose
    add(1.94, 0.52, 2.5, 0, 0.56, -0.15); // main tub
    add(2.02, 0.44, 1.6, 0, 0.52, 1.28); // rear haunches
    add(1.58, 0.44, 1.72, 0, 0.92, 0.18, glass, 0.72); // greenhouse
    add(1.90, 0.14, 0.42, 0, 1.02, 1.86, this.bodyMat); // ducktail spoiler
    add(1.96, 0.20, 0.30, 0, 0.40, 2.02, this.bodyMat); // rear diffuser
    // Side skirts read as the car's waistline at speed.
    add(0.14, 0.18, 3.0, 0.98, 0.30, 0.1, this.bodyMat);
    add(0.14, 0.18, 3.0, -0.98, 0.30, 0.1, this.bodyMat);

    for (const [x, z] of [
      [0.92, -1.28],
      [-0.92, -1.28],
      [0.96, 1.42],
      [-0.96, 1.42],
    ]) {
      const wheel = new THREE.Group();
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 14), rubber);
      tyre.rotation.z = Math.PI / 2;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.28, 10), rim);
      hub.rotation.z = Math.PI / 2;
      wheel.add(tyre, hub);
      wheel.position.set(x, 0.36, z);
      this.group.add(wheel);
      this.wheels.push(wheel);
    }
  }

  /** Headlight cones + taillight bars, all additive. */
  private buildBeams(): THREE.Mesh {
    const headMat = makeGlowMaterial(new THREE.Color(1.0, 0.86, 0.66), 2.2, 3.0);
    const tailMat = makeGlowMaterial(new THREE.Color(1.0, 0.09, 0.05), 2.4, 2.6);
    const quad = new THREE.PlaneGeometry(1, 1);

    const mk = (mat: THREE.RawShaderMaterial, x: number, y: number, z: number, sc: number) => {
      // Clone the geometry per light: `aTint` is a per-geometry attribute, so a
      // shared BufferGeometry would make the brake lights drive the headlights.
      const im = new THREE.InstancedMesh(quad.clone(), mat, 1);
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(0, 0, 0), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc));
      im.setMatrixAt(0, m);
      im.instanceMatrix.needsUpdate = true;
      im.geometry.setAttribute(
        'aTint',
        new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1, 1]), 4),
      );
      im.position.set(x, y, z);
      im.frustumCulled = false;
      im.renderOrder = 10;
      this.group.add(im);
      return im;
    };

    mk(headMat, 0.66, 0.52, -2.3, 1.5);
    mk(headMat, -0.66, 0.52, -2.3, 1.5);
    const b1 = mk(tailMat, 0.62, 0.62, 2.2, 1.2);
    const b2 = mk(tailMat, -0.62, 0.62, 2.2, 1.2);
    this.brakeGlow.push(b1, b2);

    // Forward light pool cast onto the road, flat on the ground plane.
    // Soft and dim: against a correctly dark road this reads as a headlight
    // wash, whereas the previous gain painted a hard white rectangle on the
    // tarmac ahead of the car.
    const poolMat = makeGlowMaterial(new THREE.Color(1.0, 0.82, 0.60), 3.2, 0.34, true);
    const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), poolMat, 1);
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
      new THREE.Vector3(9, 26, 1),
    );
    pool.setMatrixAt(0, m);
    pool.instanceMatrix.needsUpdate = true;
    pool.geometry.setAttribute(
      'aTint',
      new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1, 1]), 4),
    );
    pool.position.set(0, 0.06, -13);
    pool.frustumCulled = false;
    pool.renderOrder = 6;
    this.group.add(pool);
    return pool;
  }

  reset() {
    this.s = 0;
    this.t = 0;
    this.speed = 26;
    this.vt = 0;
    this.yaw = 0;
    this.roll = 0;
    this.pitch = 0;
    this.slip = 0;
    this.rpm = 0.3;
    this.gear = 1;
    this.stun = 0;
  }

  /** Head-on impact: kill most of the speed and lock control briefly. */
  crash(severity = 1) {
    this.speed *= 0.30 / severity;
    this.vt *= -0.35;
    this.stun = Math.min(0.85, 0.42 * severity);
  }

  /** Glancing contact with a barrier — scrub speed, push back onto the road. */
  graze(dir: number) {
    this.speed *= 0.965;
    this.vt = -dir * Math.abs(this.vt) * 0.4 - dir * 3.2;
    this.slip = Math.min(1, this.slip + 0.35);
  }

  update(dt: number, input: CarInput, path: CenterlinePath, sample: PathSample) {
    const stunned = this.stun > 0;
    if (stunned) this.stun -= dt;

    const steer = stunned ? 0 : THREE.MathUtils.clamp(input.steer, -1, 1);
    const boosting = input.boost && !stunned;
    const target = boosting ? BOOST_SPEED : MAX_SPEED;

    // --- longitudinal ------------------------------------------------------
    // Torque falls off with speed so acceleration feels strong off the line and
    // asymptotic near the top — you never quite reach the number on the dial.
    const headroom = Math.max(0, 1 - this.speed / target);
    const drive = stunned ? 0 : (18 + 26 * headroom) * (boosting ? 1.5 : 1);
    const drag = 0.0026 * this.speed * this.speed;
    const braking = input.brake * 34;
    this.speed += (drive - drag - braking) * dt;
    // Cornering scrub: hard steering at speed bleeds momentum.
    this.speed -= Math.abs(steer) * this.speed * 0.10 * dt;
    this.speed = THREE.MathUtils.clamp(this.speed, 0, BOOST_SPEED * 1.05);

    // --- lateral -----------------------------------------------------------
    const speed01 = this.speed / MAX_SPEED;
    // Steering authority tapers with speed — otherwise the car twitches at 300 km/h.
    const authority = 26 * (1 - 0.42 * Math.min(1, speed01));
    this.vt += steer * authority * dt;

    // Centrifugal push through the corridor's real curves.
    this.vt += sample.curvature * this.speed * this.speed * 0.055 * dt;

    // Grip: lateral velocity decays fast when going straight, slower when the
    // player is holding a steering input — that gap is what feels like a slide.
    const grip = 5.0 - Math.abs(steer) * 2.1;
    this.vt -= this.vt * grip * dt;
    this.t += this.vt * dt;

    // --- barriers ----------------------------------------------------------
    if (this.t > LIMIT) {
      this.t = LIMIT;
      this.graze(1);
    } else if (this.t < -LIMIT) {
      this.t = -LIMIT;
      this.graze(-1);
    }

    this.s += this.speed * dt;

    // --- feel --------------------------------------------------------------
    this.slip = THREE.MathUtils.damp(this.slip, Math.min(1, Math.abs(this.vt) / 13), 7, dt);
    const targetYaw = Math.atan2(this.vt, Math.max(this.speed, 8)) * 1.45;
    this.yaw = THREE.MathUtils.damp(this.yaw, targetYaw, 12, dt);
    this.roll = THREE.MathUtils.damp(this.roll, -steer * 0.085 - this.vt * 0.006, 8, dt);
    this.pitch = THREE.MathUtils.damp(this.pitch, -input.brake * 0.05 + (boosting ? 0.028 : 0), 6, dt);

    // Simulated 6-speed: rpm sweeps within each gear and drops on the shift.
    const gears = [0.16, 0.3, 0.46, 0.63, 0.82, 1.0];
    let g = 0;
    while (g < gears.length - 1 && this.speed / BOOST_SPEED > gears[g]) g++;
    this.gear = g + 1;
    const lo = g === 0 ? 0 : gears[g - 1];
    const hi = gears[g];
    this.rpm = THREE.MathUtils.clamp((this.speed / BOOST_SPEED - lo) / Math.max(hi - lo, 1e-3), 0.08, 1);
  }

  /** Push the simulated state onto the scene graph. */
  syncTransform(path: CenterlinePath, sample: PathSample, time: number) {
    this.group.position.set(sample.x + sample.nx * this.t, 0, sample.z + sample.nz * this.t);
    this.group.rotation.set(this.pitch, sample.heading + this.yaw, this.roll, 'YXZ');

    const spin = time * this.speed * 0.6;
    for (const w of this.wheels) w.rotation.x = spin;

    for (const b of this.brakeGlow) {
      const tint = b as unknown as THREE.InstancedMesh;
      const attr = tint.geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;
      attr.setW(0, 0.45);
      attr.needsUpdate = true;
    }
  }

  setCameraUniforms(cameraPos: THREE.Vector3, time: number) {
    (this.bodyMat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
    this.bodyMat.uniforms.uTime.value = time;
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.RawShaderMaterial | undefined;
      if (m?.uniforms?.uCameraPos) (m.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
      if (m?.uniforms?.uTime) m.uniforms.uTime.value = time;
    });
  }
}
