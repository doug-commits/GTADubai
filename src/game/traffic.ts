import * as THREE from 'three';
import { VEHICLE_BODY_GLSL, FOG_GLSL, vehicleUniforms, makeGlowMaterial } from './vehicle-shader';
import { LANE_WIDTH } from '../world/corridor';
import type { CenterlinePath } from '../world/path';

/**
 * Rush-hour traffic.
 *
 * A fixed pool of vehicles recycled around the player: anything that falls far
 * enough behind is re-spawned ahead, so density stays constant for the whole
 * 15 km at a bounded cost. Bodies, cabins, taillights and wet-road light smears
 * are four instanced meshes — four draw calls for the entire traffic system.
 *
 * Lane discipline mirrors Sheikh Zayed Road: fast lanes on the left (negative
 * t), heavy vehicles held to the right, and everyone slower than the player.
 */

const POOL = 84;
const LANES = 5;
/** Lane centre offsets, left (fast) to right (slow). */
const LANE_T = Array.from({ length: LANES }, (_, i) => (i - (LANES - 1) / 2) * LANE_WIDTH);

type Kind = 0 | 1 | 2 | 3 | 4; // sedan | SUV | taxi | bus | truck

interface Vehicle {
  active: boolean;
  s: number;
  t: number;
  lane: number;
  targetLane: number;
  speed: number;
  kind: Kind;
  colour: THREE.Color;
  /** Guards against one pass being counted as several near misses. */
  scored: boolean;
  /** Seconds until this vehicle may consider changing lane again. */
  laneCooldown: number;
  w: number;
  h: number;
  d: number;
}

const KIND_SPEC: Record<
  Kind,
  { w: number; h: number; d: number; cabin: number; speed: [number, number]; lanes: number[] }
> = {
  0: { w: 1.85, h: 0.72, d: 4.5, cabin: 0.55, speed: [26, 38], lanes: [0, 1, 2, 3, 4] },
  1: { w: 2.02, h: 1.05, d: 4.9, cabin: 0.8, speed: [24, 34], lanes: [0, 1, 2, 3, 4] },
  2: { w: 1.82, h: 0.75, d: 4.6, cabin: 0.58, speed: [25, 36], lanes: [1, 2, 3, 4] },
  3: { w: 2.5, h: 2.5, d: 11.5, cabin: 0.2, speed: [18, 24], lanes: [3, 4] },
  4: { w: 2.45, h: 2.2, d: 9.5, cabin: 0.3, speed: [16, 23], lanes: [3, 4] },
};

const PALETTE = [
  0x101216, 0x0d0d10, 0x2b2f36, 0x6e737a, 0xb9bcc0, 0xe8e6e1, 0x1e2a3a, 0x3a1418, 0x14231c,
];

function rnd(a: number, b: number) {
  return a + Math.random() * (b - a);
}

export interface TrafficEvents {
  nearMiss: number;
  crash: boolean;
  crashSeverity: number;
}

export class Traffic {
  readonly group = new THREE.Group();
  private v: Vehicle[] = [];
  private bodies: THREE.InstancedMesh;
  private cabins: THREE.InstancedMesh;
  private tails: THREE.InstancedMesh;
  private smears: THREE.InstancedMesh;
  private bodyMat: THREE.RawShaderMaterial;
  private tailTint: THREE.InstancedBufferAttribute;
  private smearTint: THREE.InstancedBufferAttribute;

  /** How far ahead vehicles are kept populated. */
  private readonly aheadRange = 620;
  private readonly behindRange = 90;

  constructor(private path: CenterlinePath) {
    this.bodyMat = new THREE.RawShaderMaterial({
      name: 'traffic-body',
      glslVersion: THREE.GLSL3,
      uniforms: { ...vehicleUniforms() },
      vertexShader: /* glsl */ `
        in vec3 position; in vec3 normal; in mat4 instanceMatrix; in vec3 aColor;
        uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
        out vec3 vN; out vec3 vW; out vec3 vC;
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = normalize(mat3(instanceMatrix) * normal);
          vC = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec3 vN; in vec3 vW; in vec3 vC;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir;
        uniform float uFogNear, uFogFar;
        ${VEHICLE_BODY_GLSL}
        ${FOG_GLSL}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          vec3 col = carPaint(N, V, vC, uSunDir, 0.80, 0.55);
          col = applyFog(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.bodies = new THREE.InstancedMesh(box, this.bodyMat, POOL);
    this.cabins = new THREE.InstancedMesh(box.clone(), this.bodyMat, POOL);
    const colors = new Float32Array(POOL * 3);
    this.bodies.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));
    this.cabins.geometry.setAttribute(
      'aColor',
      new THREE.InstancedBufferAttribute(new Float32Array(colors), 3),
    );
    this.bodies.frustumCulled = false;
    this.cabins.frustumCulled = false;

    const quad = new THREE.PlaneGeometry(1, 1);
    this.tails = new THREE.InstancedMesh(
      quad,
      makeGlowMaterial(new THREE.Color(1.0, 0.10, 0.05), 2.3, 2.4),
      POOL * 2,
    );
    this.tailTint = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 2 * 4), 4);
    this.tails.geometry.setAttribute('aTint', this.tailTint);
    this.tails.frustumCulled = false;
    this.tails.renderOrder = 10;

    // Wet-road smears: a stretched additive quad lying flat under each vehicle.
    // This is the cheat that sells "wet road" more than any reflection maths —
    // a long red column of light dragged down the tarmac behind every car.
    this.smears = new THREE.InstancedMesh(
      quad.clone(),
      makeGlowMaterial(new THREE.Color(1.0, 0.13, 0.06), 1.5, 0.55, true),
      POOL,
    );
    this.smearTint = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 4), 4);
    this.smears.geometry.setAttribute('aTint', this.smearTint);
    this.smears.frustumCulled = false;
    this.smears.renderOrder = 7;

    this.group.add(this.bodies, this.cabins, this.tails, this.smears);

    for (let i = 0; i < POOL; i++) {
      this.v.push({
        active: false,
        s: 0,
        t: 0,
        lane: 2,
        targetLane: 2,
        speed: 30,
        kind: 0,
        colour: new THREE.Color(),
        scored: false,
        laneCooldown: 0,
        w: 1.9,
        h: 0.8,
        d: 4.5,
      });
    }
  }

  reset(playerS: number) {
    for (const v of this.v) v.active = false;
    // Seed the road ahead so the very first seconds already feel like rush hour.
    for (let i = 0; i < POOL; i++) {
      this.spawn(this.v[i], playerS + rnd(45, this.aheadRange));
    }
  }

  private spawn(v: Vehicle, s: number) {
    const roll = Math.random();
    const kind: Kind = roll < 0.46 ? 0 : roll < 0.68 ? 1 : roll < 0.84 ? 2 : roll < 0.93 ? 3 : 4;
    const spec = KIND_SPEC[kind];
    const lane = spec.lanes[(Math.random() * spec.lanes.length) | 0];

    v.active = true;
    v.s = s;
    v.lane = lane;
    v.targetLane = lane;
    v.t = LANE_T[lane];
    v.kind = kind;
    v.w = spec.w;
    v.h = spec.h;
    v.d = spec.d;
    v.scored = false;
    v.laneCooldown = rnd(2, 9);
    // Left lanes run faster, exactly as they do on the real road.
    const laneBias = 1.22 - lane * 0.08;
    v.speed = rnd(spec.speed[0], spec.speed[1]) * laneBias;

    if (kind === 2) v.colour.setHex(0xd8cfae); // Dubai taxi cream
    else if (kind === 3) v.colour.setHex(0xc8443a);
    else v.colour.setHex(PALETTE[(Math.random() * PALETTE.length) | 0]);
  }

  /**
   * Advance traffic and test it against the player.
   * Returns the events the game layer needs this frame.
   */
  update(dt: number, playerS: number, playerT: number, out: TrafficEvents): TrafficEvents {
    out.nearMiss = 0;
    out.crash = false;
    out.crashSeverity = 1;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const bodyCol = this.bodies.geometry.getAttribute('aColor') as THREE.InstancedBufferAttribute;
    const cabinCol = this.cabins.geometry.getAttribute('aColor') as THREE.InstancedBufferAttribute;

    let n = 0;
    let tailN = 0;

    for (const v of this.v) {
      if (!v.active) continue;

      v.s += v.speed * dt;

      // Recycle: dropped too far behind, or drifted beyond the streaming window.
      if (v.s < playerS - this.behindRange || v.s > playerS + this.aheadRange + 260) {
        this.spawn(v, playerS + rnd(this.aheadRange * 0.55, this.aheadRange));
      }

      // --- lane changes ----------------------------------------------------
      v.laneCooldown -= dt;
      if (v.laneCooldown <= 0) {
        v.laneCooldown = rnd(3, 11);
        const spec = KIND_SPEC[v.kind];
        const dir = Math.random() < 0.5 ? -1 : 1;
        const cand = v.lane + dir;
        if (spec.lanes.includes(cand) && Math.random() < 0.55) v.targetLane = cand;
      }
      const targetT = LANE_T[v.targetLane];
      if (Math.abs(v.t - targetT) > 0.05) {
        v.t += Math.sign(targetT - v.t) * Math.min(Math.abs(targetT - v.t), 2.2 * dt);
      } else {
        v.lane = v.targetLane;
      }

      // --- player interaction ---------------------------------------------
      const ds = v.s - playerS;
      const dtLat = v.t - playerT;
      const halfLen = v.d * 0.5 + 2.3;
      const halfWide = v.w * 0.5 + 0.95;

      if (Math.abs(ds) < halfLen) {
        if (Math.abs(dtLat) < halfWide) {
          if (!v.scored) {
            out.crash = true;
            // Heavier vehicles hurt more.
            out.crashSeverity = v.kind >= 3 ? 1.5 : 1;
            v.scored = true;
          }
        } else if (Math.abs(dtLat) < halfWide + 1.7 && !v.scored) {
          out.nearMiss++;
          v.scored = true;
        }
      } else if (ds < -halfLen - 6) {
        v.scored = false;
      }

      // --- render ----------------------------------------------------------
      const p = this.path.sample(v.s);
      const x = p.x + p.nx * v.t;
      const z = p.z + p.nz * v.t;
      q.setFromAxisAngle(up, p.heading);

      pos.set(x, v.h * 0.5 + 0.32, z);
      scl.set(v.w, v.h, v.d);
      m.compose(pos, q, scl);
      this.bodies.setMatrixAt(n, m);

      const cabinFrac = KIND_SPEC[v.kind].cabin;
      pos.set(x, v.h + 0.32 + v.h * cabinFrac * 0.5, z);
      scl.set(v.w * 0.86, v.h * cabinFrac, v.d * (v.kind >= 3 ? 0.9 : 0.52));
      m.compose(pos, q, scl);
      this.cabins.setMatrixAt(n, m);

      bodyCol.setXYZ(n, v.colour.r, v.colour.g, v.colour.b);
      // Taxi roofs are the giveaway silhouette in Dubai traffic.
      if (v.kind === 2) cabinCol.setXYZ(n, 0.72, 0.10, 0.08);
      else cabinCol.setXYZ(n, v.colour.r * 0.6, v.colour.g * 0.6, v.colour.b * 0.6);

      // Taillights, brighter when we are closing on them.
      const closing = THREE.MathUtils.clamp(1 - Math.abs(ds) / 200, 0.25, 1);
      for (const sx of [-1, 1]) {
        pos.set(
          x + p.nx * (v.w * 0.34 * sx) + p.tx * (v.d * 0.5),
          v.h * 0.75 + 0.32,
          z + p.nz * (v.w * 0.34 * sx) + p.tz * (v.d * 0.5),
        );
        scl.setScalar(1.15);
        m.compose(pos, q, scl);
        this.tails.setMatrixAt(tailN, m);
        this.tailTint.setXYZW(tailN, 1, 1, 1, closing);
        tailN++;
      }

      // Wet-road smear, stretched behind the vehicle along the road.
      pos.set(x + p.tx * (v.d * 0.5 + 5), 0.05, z + p.tz * (v.d * 0.5 + 5));
      m.compose(
        pos,
        new THREE.Quaternion().multiplyQuaternions(
          q,
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
        ),
        new THREE.Vector3(v.w * 1.5, 16, 1),
      );
      this.smears.setMatrixAt(n, m);
      this.smearTint.setXYZW(n, 1, 1, 1, closing * 0.8);

      n++;
    }

    this.bodies.count = n;
    this.cabins.count = n;
    this.smears.count = n;
    this.tails.count = tailN;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.cabins.instanceMatrix.needsUpdate = true;
    this.tails.instanceMatrix.needsUpdate = true;
    this.smears.instanceMatrix.needsUpdate = true;
    bodyCol.needsUpdate = true;
    cabinCol.needsUpdate = true;
    this.tailTint.needsUpdate = true;
    this.smearTint.needsUpdate = true;

    return out;
  }

  setCameraUniforms(cameraPos: THREE.Vector3, time: number) {
    (this.bodyMat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
    this.bodyMat.uniforms.uTime.value = time;
  }
}
