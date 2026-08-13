import * as THREE from 'three';
import { SKY_GLSL, SUN_DIR } from '../render/sky';
import { PBR_GLSL, SKY_IBL_GLSL } from '../render/pbr';
import type { Corridor } from './corridor';
import { ROAD_HALF_WIDTH } from './corridor';

/**
 * Grade-separated interchanges.
 *
 * Sheikh Zayed Road does not have junctions, it has interchanges: a crossing
 * road carried over the corridor on a flyover, with sweeping loop ramps
 * peeling off and curving down to ground level. In reference photography of
 * this road the interchange is frequently the dominant object in frame —
 * bigger than any single building — and its absence is why the corridor read
 * as a straight canyon with nothing happening in it.
 *
 * The player never drives these. They exist to be driven UNDER, which is what
 * makes them cheap: no drivable surface, no collision, no lane logic. A deck
 * sweeping overhead at 13 m and a ramp curving away into the haze are pure
 * silhouette and pure parallax, and both are strongest exactly where the
 * corridor is otherwise emptiest.
 */

/** Deck half-section, metres: (lateral offset, height above deck datum). */
const DECK_SECTION: Array<[number, number]> = [
  [-5.6, 0.0],
  [-5.6, 0.95],
  [-5.1, 1.05],
  [-5.1, 0.35],
  [5.1, 0.35],
  [5.1, 1.05],
  [5.6, 0.95],
  [5.6, 0.0],
  [-3.4, -1.55],
  [3.4, -1.55],
];

/**
 * Loft a box-girder deck along a 3-D centreline.
 *
 * Frames are built from the tangent with a fixed world up rather than a
 * parallel-transport frame: these ramps bank very little and never invert, so
 * the cheap frame is stable and avoids the twist a naive Frenet frame produces
 * where a curve flattens out.
 */
function loftDeck(points: THREE.Vector3[], width = 1): THREE.BufferGeometry {
  const rings: THREE.Vector3[][] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tan = new THREE.Vector3();
  const side = new THREE.Vector3();

  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    tan.subVectors(b, a).normalize();
    side.crossVectors(tan, up).normalize();
    const ring: THREE.Vector3[] = [];
    // Top surface + parapets, then the girder soffit below it.
    for (const [lat, h] of DECK_SECTION) {
      ring.push(
        new THREE.Vector3(
          points[i].x + side.x * lat * width,
          points[i].y + h,
          points[i].z + side.z * lat * width,
        ),
      );
    }
    rings.push(ring);
  }

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const cols = DECK_SECTION.length;

  rings.forEach((ring, r) => {
    ring.forEach((p, c) => {
      pos.push(p.x, p.y, p.z);
      uv.push(c / (cols - 1), r * 4);
    });
  });
  for (let r = 0; r < rings.length - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Vertical profile of a flyover: flat approach, parabolic hump, flat again. */
function humpAt(u: number, peak: number): number {
  const t = THREE.MathUtils.clamp(u, 0, 1);
  // Smootherstep in and out so the deck has no visible kink at the abutments.
  const s = t * t * t * (t * (t * 6 - 15) + 10);
  const s2 = s < 0.5 ? s * 2 : (1 - s) * 2;
  return peak * (s2 * s2 * (3 - 2 * s2));
}

function concreteMaterial(): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    name: 'interchange',
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    uniforms: {
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.52, 0.22).multiplyScalar(3.2) },
      uFogNear: { value: 200 },
      uFogFar: { value: 2200 },
    },
    vertexShader: /* glsl */ `
      in vec3 position; in vec3 normal; in vec2 uv;
      uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
      out vec3 vN; out vec3 vW; out vec2 vUv;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp int;
      precision highp sampler2D;
      in vec3 vN; in vec3 vW; in vec2 vUv;
      out vec4 outColor;
      uniform vec3 uCameraPos, uSunDir, uSunColor;
      uniform float uFogNear, uFogFar;
      ${SKY_GLSL}
      ${PBR_GLSL}
      ${SKY_IBL_GLSL}

      float h21(vec2 p) {
        p = fract(p * vec2(233.34, 851.73));
        p += dot(p, p + 23.45);
        return fract(p.x * p.y);
      }

      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(vW - uCameraPos);

        // Pale precast, matching the cladding palette of the corridor rather
        // than the dark concrete of a northern viaduct.
        float grime = h21(floor(vec2(vUv.x * 6.0, vUv.y * 0.35)));
        vec3 albedo = mix(vec3(0.320, 0.305, 0.280), vec3(0.470, 0.450, 0.415), grime);
        // Segment joints every 4 m of run.
        float joint = smoothstep(0.05, 0.12, abs(fract(vUv.y / 4.0) - 0.5) * 2.0 - 0.82);
        albedo *= 1.0 - joint * 0.30;
        // The soffit is always in shade and always dirtier than the parapet.
        albedo *= mix(1.0, 0.62, smoothstep(0.0, -0.4, N.y));

        Surface s = makeSurface(albedo, 0.0, filterRoughness(N, 0.76), N, V);
        vec3 R = reflect(V, N);
        vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
        col += shadeDirect(s, uSunDir, uSunColor);
        // Warm bounce up off the carriageway onto the underside.
        col += vec3(1.0, 0.44, 0.18) * max(-N.y, 0.0) * 0.09;

        col = aerial(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
        outColor = vec4(col, 1.0);
      }
    `,
  });
}

export interface InterchangeRange {
  fromS: number;
  toS: number;
}

export class Interchanges {
  readonly group = new THREE.Group();
  private mat = concreteMaterial();

  constructor(corridor: Corridor, range?: InterchangeRange) {
    const path = corridor.path;
    const from = Math.max(0, range?.fromS ?? 0);
    const to = Math.min(path.length, range?.toS ?? path.length);

    const parts: THREE.BufferGeometry[] = [];

    for (const cp of corridor.checkpoints) {
      if (cp.s < from || cp.s > to) continue;
      parts.push(...this.buildOne(corridor, cp.s));
    }

    // One mesh per interchange would be fine, but merging keeps the draw count
    // flat as more of the corridor gets built out.
    for (const g of parts) {
      const mesh = new THREE.Mesh(g, this.mat);
      mesh.frustumCulled = true;
      mesh.geometry.computeBoundingSphere();
      this.group.add(mesh);
    }
  }

  /** One grade-separated crossing: flyover deck, piers, and two loop ramps. */
  private buildOne(corridor: Corridor, s: number): THREE.BufferGeometry[] {
    const path = corridor.path;
    const p = path.sample(s);
    const out: THREE.BufferGeometry[] = [];

    const DECK_H = 13.2;
    const SPAN = 190;
    // The crossing road meets the corridor at a shallow angle, not square on —
    // real interchanges here are skewed, and a square crossing reads as a toy.
    const skew = 0.36;
    const cross = new THREE.Vector3(
      p.nx * Math.cos(skew) + p.tx * Math.sin(skew),
      0,
      p.nz * Math.cos(skew) + p.tz * Math.sin(skew),
    ).normalize();

    // --- the flyover itself ------------------------------------------------
    const deckPts: THREE.Vector3[] = [];
    const STEPS = 40;
    for (let i = 0; i <= STEPS; i++) {
      const u = i / STEPS;
      const d = (u - 0.5) * SPAN;
      deckPts.push(
        new THREE.Vector3(
          p.x + cross.x * d,
          humpAt(u, DECK_H),
          p.z + cross.z * d,
        ),
      );
    }
    out.push(loftDeck(deckPts));

    // --- piers -------------------------------------------------------------
    // Placed clear of the carriageway on both sides. Nothing may land on the
    // road: the same mistake the Metro made on its first pass.
    const pierGeo: THREE.BufferGeometry[] = [];
    for (const d of [-72, -34, 34, 72]) {
      const u = d / SPAN + 0.5;
      const y = humpAt(u, DECK_H);
      if (Math.abs(d) < ROAD_HALF_WIDTH + 6) continue;
      const h = y - 1.55;
      if (h < 2) continue;
      const col = new THREE.CylinderGeometry(1.5, 2.0, h, 10);
      col.translate(p.x + cross.x * d, h / 2, p.z + cross.z * d);
      pierGeo.push(col);
      // Pier head spreading under the deck.
      const head = new THREE.BoxGeometry(3.2, 1.1, 11.5);
      head.translate(p.x + cross.x * d, h + 0.55, p.z + cross.z * d);
      pierGeo.push(head);
    }
    out.push(...pierGeo);

    // --- loop ramps --------------------------------------------------------
    // Two opposing quarter-loops peeling off the flyover and spiralling down to
    // grade. These are the sweeping curves that make an interchange read as an
    // interchange rather than as a bridge.
    for (const sideSign of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      const R = 62;
      const centreX = p.x + cross.x * (46 * sideSign) + p.tx * (52 * sideSign);
      const centreZ = p.z + cross.z * (46 * sideSign) + p.tz * (52 * sideSign);
      const LOOP_STEPS = 34;
      for (let i = 0; i <= LOOP_STEPS; i++) {
        const u = i / LOOP_STEPS;
        // Three-quarter turn, descending the whole way.
        const ang = (u * Math.PI * 1.5 + (sideSign > 0 ? 0 : Math.PI)) * sideSign;
        const y = THREE.MathUtils.lerp(DECK_H * 0.86, 0.9, u * u * (3 - 2 * u));
        pts.push(
          new THREE.Vector3(centreX + Math.cos(ang) * R, y, centreZ + Math.sin(ang) * R),
        );
      }
      out.push(loftDeck(pts, 0.62));

      // Slender single columns under the loop, spaced along it.
      for (let i = 4; i < LOOP_STEPS; i += 7) {
        const a = pts[i];
        const h = a.y - 1.4;
        if (h < 2.5) continue;
        const col = new THREE.CylinderGeometry(1.05, 1.35, h, 9);
        col.translate(a.x, h / 2, a.z);
        out.push(col);
      }
    }

    return out;
  }

  update(cameraPos: THREE.Vector3) {
    (this.mat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
  }
}
