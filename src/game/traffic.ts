import * as THREE from 'three';
import { vehicleUniforms, makeGlowMaterial } from './vehicle-shader';
import { buildTrafficGeometry, trafficSize, type VehicleKind as ModelKind } from './models/vehicles';
import { SKY_GLSL } from '../render/sky';
import { PBR_GLSL, SKY_IBL_GLSL } from '../render/pbr';
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

// Pool size and streaming range together set the average traffic density, and
// with formation spawning they also set how much CLEAR ROAD there is between
// packs. 84 vehicles inside a 710 m window left a car every 42 m per lane —
// dense enough that the gaps between packs closed up and the rhythm the
// formations exist to create never appeared. Fewer cars over more road.
const POOL = 50;
const LANES = 6;
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
  /** Roof colour for two-tone vehicles, and the local y the split happens at. */
  roof: THREE.Color;
  roofY: number;
  /** Guards against one pass being counted as several near misses. */
  scored: boolean;
  /** Seconds until this vehicle may consider changing lane again. */
  laneCooldown: number;
  w: number;
  h: number;
  d: number;
  /** Per-instance scale jitter, so repeats of one model differ. */
  jw: number;
  jh: number;
  jd: number;
}

const KIND_SPEC: Record<
  Kind,
  { w: number; h: number; d: number; cabin: number; speed: [number, number]; lanes: number[] }
> = {
  0: { w: 1.85, h: 0.72, d: 4.5, cabin: 0.55, speed: [26, 38], lanes: [0, 1, 2, 3, 4, 5] },
  1: { w: 2.02, h: 1.05, d: 4.9, cabin: 0.8, speed: [24, 34], lanes: [0, 1, 2, 3, 4, 5] },
  2: { w: 1.82, h: 0.75, d: 4.6, cabin: 0.58, speed: [25, 36], lanes: [1, 2, 3, 4, 5] },
  3: { w: 2.5, h: 2.5, d: 11.5, cabin: 0.2, speed: [18, 24], lanes: [3, 4, 5] },
  4: { w: 2.45, h: 2.2, d: 9.5, cabin: 0.3, speed: [16, 23], lanes: [3, 4, 5] },
};

/**
 * Dubai's rolling stock, by frequency.
 *
 * This road is overwhelmingly WHITE, and for a reason that has nothing to do
 * with taste: a white car in Gulf summer is measurably cooler inside, so the
 * fleet skews white and silver to a degree that looks like an error anywhere
 * else. The old palette was five greys, a black and a bottle green — a northern
 * European car park, and one more reason the corridor read as somewhere else.
 * Weighted by repeats rather than by a parallel weights array.
 */
/**
 * Body colours.
 *
 * Dubai traffic really is dominated by white, and an earlier pass weighted the
 * palette 77% white/silver on those grounds. It was accurate and it was wrong:
 * seen at distance through the dust haze, every car resolved to the same pale
 * blob and the road read as one repeated vehicle. Truth about the fleet is not
 * the same as legibility at 250 km/h.
 *
 * White still leads — it would look wrong otherwise — but there is now enough
 * chroma in the mix that consecutive cars are tellable apart.
 */
const PALETTE = [
  0xe9e7e2, 0xe9e7e2, 0xf2f1ee,   // white, still the most common
  0xc8c9c6, 0xb0b3b5,             // silver
  0xd9cfba, 0xc9b99c,             // champagne / desert beige
  0x2b2f36, 0x101216,             // graphite / near-black
  0x1e2a3a, 0x27435e,             // navy, steel blue
  0x6d1f22, 0x8c3a1e,             // maroon, burnt orange
  0x1f4034, 0x545b62,             // racing green, gunmetal
  0xa8a29a, 0x7a2f38,             // stone, deep red
];

/** Roof colour, when a vehicle is two-tone. Dubai taxis are cream + red roof. */
const TAXI_ROOF = 0xb8332b;

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
  private kindMeshes: THREE.InstancedMesh[] = [];
  private kindSize: Array<{ w: number; h: number; d: number }> = [];
  private tails: THREE.InstancedMesh;
  private smears: THREE.InstancedMesh;
  private bodyMat: THREE.RawShaderMaterial;
  private tailTint: THREE.InstancedBufferAttribute;
  private smearTint: THREE.InstancedBufferAttribute;

  /** How far ahead vehicles are kept populated. */
  private readonly aheadRange = 1000;
  private readonly behindRange = 90;

  constructor(private path: CenterlinePath) {
    this.bodyMat = new THREE.RawShaderMaterial({
      name: 'traffic-body',
      glslVersion: THREE.GLSL3,
      uniforms: { ...vehicleUniforms() },
      vertexShader: /* glsl */ `
        in vec3 position; in vec3 normal; in mat4 instanceMatrix;
        in vec3 aColor; in vec4 aRoof;   // rgb = roof colour, a = local y it starts at
        uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
        out vec3 vN; out vec3 vW; out vec3 vC;
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vN = normalize(mat3(instanceMatrix) * normal);
          // Two-tone by local height. Resolved in the vertex stage because the
          // split lands on a body crease anyway, so interpolating it across the
          // face costs nothing and saves a varying.
          vC = mix(aColor, aRoof.rgb, step(aRoof.a, position.y) * step(0.0, aRoof.a));
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp int;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW; in vec3 vC;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir;
        uniform float uFogNear, uFogFar;
        ${SKY_GLSL}
        ${PBR_GLSL}
        ${SKY_IBL_GLSL}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          // Same clearcoat treatment as the hero car, a touch rougher — these
          // are everyday cars at the end of a dusty day, not showroom stock.
          Surface s = makeSurface(vC, 0.55, filterRoughness(N, 0.34), N, V);
          s.clearcoat = 0.75;
          s.clearcoatRoughness = 0.09;
          vec3 R = reflect(V, N);
          vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
          col += shadeDirect(s, uSunDir, vec3(3.4, 1.5, 0.55));
          float fog = smoothstep(uFogNear, uFogFar, length(vW - uCameraPos));
          col = aerial(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });

    // One InstancedMesh per vehicle kind: each kind now has its own real
    // silhouette, so they cannot share a single box geometry any more. Five
    // draw calls instead of two, in exchange for traffic that reads as cars.
    const KIND_MODEL: ModelKind[] = ['sedan', 'suv', 'taxi', 'bus', 'truck'];
    KIND_MODEL.forEach((mk, i) => {
      const geo = buildTrafficGeometry(mk);
      const mesh = new THREE.InstancedMesh(geo, this.bodyMat, POOL);
      mesh.geometry.setAttribute(
        'aColor',
        new THREE.InstancedBufferAttribute(new Float32Array(POOL * 3), 3),
      );
      mesh.geometry.setAttribute(
        'aRoof',
        new THREE.InstancedBufferAttribute(new Float32Array(POOL * 4), 4),
      );
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.kindMeshes[i] = mesh;
      this.group.add(mesh);
      const sz = trafficSize(mk);
      this.kindSize[i] = { w: sz.x, h: sz.y, d: sz.z };
    });

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

    this.group.add(this.tails, this.smears);

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
        roof: new THREE.Color(),
        roofY: -1,
        scored: false,
        laneCooldown: 0,
        w: 1.9,
        h: 0.8,
        d: 4.5,
        jw: 1,
        jh: 1,
        jd: 1,
      });
    }
  }

  reset(playerS: number) {
    for (const v of this.v) v.active = false;
    this.packS = playerS + 150;
    this.packSlots.length = 0;
    this.openLane = 2;
    // Seed the road ahead so the very first seconds already feel like rush hour.
    for (let i = 0; i < POOL; i++) this.spawn(this.v[i], playerS);
  }

  /**
   * ==========================================================================
   *  PACKS — where the game actually lives
   * ==========================================================================
   *
   *  Traffic used to be placed by drawing a random arc length and a random lane
   *  for every car independently. That produces a statistically correct road and
   *  a boring one: at any moment the cars are evenly smeared across five lanes,
   *  so there is always a way through without planning and never a moment that
   *  demands anything. Nothing to read, so nothing to be good at.
   *
   *  Vehicles are now issued in FORMATIONS separated by clear road. The unit of
   *  play is the pack: a shape you see coming, read, and pick a line through,
   *  then a stretch of open road to take the reward and set up the next one.
   *  Tension, release, tension. That rhythm is the whole game.
   *
   *  Gap distances are drawn from a deliberately lumpy distribution rather than
   *  a uniform one — mostly short, sometimes long — because evenly spaced packs
   *  become their own kind of metronome and stop being read at all.
   */
  private packS = 0;
  /** Lane + longitudinal offset for each vehicle still owed to the current pack. */
  private packSlots: Array<{ lane: number; sOff: number }> = [];
  /**
   * THE THROUGH-LINE.
   *
   * One lane is kept clear in every formation, and it drifts rather than jumps.
   * This is a hard guarantee, not a tendency, and it exists because the first
   * version did not have it: packs are placed independently, so two of them
   * landing 26 m apart with their gaps in different lanes merged into a solid
   * five-lane wall. A wall with no gap is not difficulty — it is an unavoidable
   * crash that the player will read, correctly, as the game cheating.
   *
   * With a guaranteed line the skill moves to where it belongs: finding it,
   * getting across to it in the distance available, and deciding how close to
   * shave the cars either side of it on the way through.
   */
  private openLane = 2;

  private startPack(playerS: number) {
    const r = Math.random();
    const gap = r < 0.56 ? rnd(34, 52) : r < 0.88 ? rnd(92, 122) : rnd(155, 200);
    this.packS += gap;

    // Keep the spawn front inside the streaming window. Without the upper clamp
    // the front runs away from the player — every vehicle placed beyond the
    // recycle horizon is recycled on the very next frame, which walks the front
    // forward forever and empties the road.
    const minS = playerS + 130;
    const maxS = playerS + this.aheadRange;
    if (this.packS < minS) this.packS = minS;
    if (this.packS > maxS) this.packS = maxS;

    // How far the through-line may move is a function of how much road there is
    // to move in. The car's lateral authority tops out near 3 m/s, so a lane
    // change costs about 1.2 s — roughly 85 m at racing speed. Shifting the line
    // across a gap shorter than that would be asking for a move the car cannot
    // physically make, which is the same unfair-crash failure by another route.
    const drift = gap > 160 ? 2 : gap > 88 ? 1 : 0;
    if (drift > 0) {
      const step = 1 + ((Math.random() * drift) | 0);
      const dir = Math.random() < 0.5 ? -1 : 1;
      let want = this.openLane + dir * step;
      if (want < 0 || want > LANES - 1) want = this.openLane - dir * step;
      this.openLane = Math.max(0, Math.min(LANES - 1, want));
    }

    const slots = this.packSlots;
    slots.length = 0;
    const open = this.openLane;
    const form = Math.random();

    if (form < 0.34) {
      // WALL. Every lane but the through-line. The set piece.
      for (let l = 0; l < LANES; l++) {
        if (l !== open) slots.push({ lane: l, sOff: rnd(-6, 6) });
      }
    } else if (form < 0.64) {
      // STAGGER. A diagonal — passable in more than one way, but every line
      // through it except the through-line costs lateral distance.
      const dir = Math.random() < 0.5 ? 1 : -1;
      const start = dir > 0 ? ((Math.random() * 3) | 0) : 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < 3; i++) {
        const lane = start + dir * i;
        if (lane >= 0 && lane < LANES && lane !== open) {
          slots.push({ lane, sOff: i * rnd(9, 16) });
        }
      }
    } else if (form < 0.92) {
      // PAIR. Two adjacent lanes — the everyday case, and what keeps the road
      // feeling occupied between the set pieces.
      const l = (Math.random() * (LANES - 1)) | 0;
      for (const lane of [l, l + 1]) {
        if (lane !== open) slots.push({ lane, sOff: rnd(-4, 4) });
      }
    } else {
      // SINGLE. Breathing room, and a clean target to shave.
      const lane = (Math.random() * LANES) | 0;
      if (lane !== open) slots.push({ lane, sOff: 0 });
    }

    // A formation that lost every slot to the through-line would leave the pack
    // scheduler with nothing to hand out and spin startPack until the recursion
    // limit. Give it one car in an adjacent lane instead.
    if (slots.length === 0) {
      slots.push({ lane: open === 0 ? 1 : open - 1, sOff: 0 });
    }
  }

  /** Next (lane, s) the formation scheduler wants filled. */
  private nextSlot(playerS: number): { lane: number; s: number } {
    if (this.packSlots.length === 0) this.startPack(playerS);
    const slot = this.packSlots.pop()!;
    return { lane: slot.lane, s: this.packS + slot.sOff };
  }

  private spawn(v: Vehicle, playerS: number) {
    const { lane, s } = this.nextSlot(playerS);

    // Kind is chosen to fit the lane rather than the other way round: buses and
    // trucks are held to the two right-hand lanes, exactly as they are on the
    // real road, so a formation slot in lane 0 can never ask for an artic.
    const heavyOk = lane >= 3;
    const roll = Math.random();
    let kind: Kind;
    if (heavyOk && roll < 0.26) kind = roll < 0.16 ? 3 : 4;
    else if (roll < 0.52) kind = 0;
    else if (roll < 0.74) kind = 1;
    else kind = 2;

    const spec = KIND_SPEC[kind];

    v.active = true;
    v.s = s;
    v.lane = lane;
    v.targetLane = lane;
    v.t = LANE_T[lane];
    v.kind = kind;
    // Collision extents come from the actual model bounds so the hitbox
    // matches what the player can see.
    const size = this.kindSize[kind] ?? spec;
    v.w = size.w;
    v.h = size.h;
    v.d = size.d;
    v.jw = rnd(0.95, 1.06);
    v.jh = rnd(0.94, 1.08);
    v.jd = rnd(0.94, 1.09);
    v.scored = false;
    v.laneCooldown = rnd(2, 9);
    // Left lanes run faster, exactly as they do on the real road.
    const laneBias = 1.22 - lane * 0.08;
    v.speed = rnd(spec.speed[0], spec.speed[1]) * laneBias;

    if (kind === 2) {
      v.colour.setHex(0xd8cfae); // Dubai taxi cream
      v.roof.setHex(TAXI_ROOF);
      // Split at the beltline, so the whole greenhouse takes the roof colour.
      v.roofY = size.h * 0.62;
    } else {
      v.colour.setHex(kind === 3 ? 0xc8443a : PALETTE[(Math.random() * PALETTE.length) | 0]);
      v.roofY = -1; // single tone
    }
  }

  /** Diagnostic: every live vehicle ahead of the player, nearest first. */
  debugLayout(playerS: number) {
    return this.v
      .filter((v) => v.active && v.s > playerS - 30)
      .map((v) => ({ ahead: Math.round(v.s - playerS), lane: v.lane, kind: v.kind }))
      .sort((a, b) => a.ahead - b.ahead);
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
    const _jit = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const kindCount = [0, 0, 0, 0, 0];
    let n = 0;
    let tailN = 0;

    for (const v of this.v) {
      if (!v.active) continue;

      v.s += v.speed * dt;

      // Recycle: dropped too far behind, or drifted beyond the streaming window.
      if (v.s < playerS - this.behindRange || v.s > playerS + this.aheadRange + 260) {
        this.spawn(v, playerS);
      }

      // --- lane changes ----------------------------------------------------
      // Rarer and slower than they were. A formation the player has read and
      // committed to a line through must still be there when they arrive; AI
      // that reshuffles itself in the last hundred metres turns a skill test
      // into a coin toss, and the player cannot tell the two apart.
      v.laneCooldown -= dt;
      if (v.laneCooldown <= 0) {
        v.laneCooldown = rnd(6, 18);
        const spec = KIND_SPEC[v.kind];
        const dir = Math.random() < 0.5 ? -1 : 1;
        const cand = v.lane + dir;
        // Only well ahead of the player, never inside the reading distance.
        const farAhead = v.s - playerS > 220;
        if (farAhead && spec.lanes.includes(cand) && Math.random() < 0.45) v.targetLane = cand;
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
        } else if (Math.abs(dtLat) < halfWide + 2.15 && !v.scored) {
          // The band has to be wide enough that a player taking the racing line
          // through a formation collects near misses without aiming for them.
          // At 1.7 m it sat just inside a lane width, so a clean adjacent-lane
          // pass scored nothing and the reward loop was invisible until someone
          // deliberately went hunting for it — which nobody does before they
          // have seen it pay once.
          out.nearMiss++;
          v.scored = true;
        }
      } else if (ds < -halfLen - 6) {
        v.jw = rnd(0.95, 1.06);
    v.jh = rnd(0.94, 1.08);
    v.jd = rnd(0.94, 1.09);
    v.scored = false;
      }

      // --- render ----------------------------------------------------------
      const p = this.path.sample(v.s);
      const x = p.x + p.nx * v.t;
      const z = p.z + p.nz * v.t;
      q.setFromAxisAngle(up, p.heading);

      // Geometry is built at real size, but a per-vehicle jitter stops two
      // instances of the same kind from being visibly the same object. A few
      // percent is enough — it is silhouette variation, not a funhouse.
      const km = this.kindMeshes[v.kind];
      const ki = kindCount[v.kind]++;
      pos.set(x, 0, z);
      _jit.set(v.jw, v.jh, v.jd);
      m.compose(pos, q, _jit);
      km.setMatrixAt(ki, m);
      (km.geometry.getAttribute('aColor') as THREE.InstancedBufferAttribute)
        .setXYZ(ki, v.colour.r, v.colour.g, v.colour.b);
      (km.geometry.getAttribute('aRoof') as THREE.InstancedBufferAttribute)
        .setXYZW(ki, v.roof.r, v.roof.g, v.roof.b, v.roofY);

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

    for (let k = 0; k < this.kindMeshes.length; k++) {
      const km = this.kindMeshes[k];
      km.count = kindCount[k];
      km.instanceMatrix.needsUpdate = true;
      (km.geometry.getAttribute('aColor') as THREE.InstancedBufferAttribute).needsUpdate = true;
      (km.geometry.getAttribute('aRoof') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
    this.smears.count = n;
    this.tails.count = tailN;
    this.tails.instanceMatrix.needsUpdate = true;
    this.smears.instanceMatrix.needsUpdate = true;
    this.tailTint.needsUpdate = true;
    this.smearTint.needsUpdate = true;

    return out;
  }

  setCameraUniforms(cameraPos: THREE.Vector3, time: number) {
    (this.bodyMat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
    this.bodyMat.uniforms.uTime.value = time;
  }
}
