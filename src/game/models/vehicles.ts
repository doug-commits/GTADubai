import * as THREE from 'three';

/**
 * Procedural vehicle geometry.
 *
 * Everything here is built from **lofted cross-sections**, not from stacked
 * boxes. A car is a tube whose section changes along its length: that is the
 * only cheap way to get the three things that actually make a vehicle read as
 * real at a glance —
 *
 *   1. a greenhouse that tapers in plan AND section (tumblehome),
 *   2. wheel arches cut as genuine recesses so the wheels sit *inside* the
 *      body volume,
 *   3. a shoulder line: the flanks bulge at wheel-centre height and pull in
 *      above and below, which is what catches a rim light and reads as metal.
 *
 * None of that is reachable with axis-aligned boxes at any triangle count.
 *
 * CONVENTIONS
 *   - Forward is **−Z**. Width is X, up is Y.
 *   - Origin sits at the centre of the wheelbase, y = 0 is the ground plane,
 *     so wheels touch y = 0 and the mesh needs no offset when placed.
 *   - All numbers are METRES. A lane on Sheikh Zayed Road is 3.65 m; these
 *     sizes are meant to be compared against it directly.
 *
 * SHADING
 *   Hard edges are preserved with a *split-vertex crease* scheme rather than a
 *   bevel: the loft duplicates the vertex ring at any section or rail marked as
 *   a crease, so `computeVertexNormals()` averages within a smooth region and
 *   stops dead at a crease. Roof, flanks and tyre crown come out smooth; the
 *   shoulder line, sill, windscreen base, roof rails and every panel boundary
 *   come out sharp. A car with everything smoothed reads as soap; a car with
 *   everything faceted reads as a paper model.
 */

export type VehicleKind = 'coupe' | 'sedan' | 'suv' | 'taxi' | 'bus' | 'truck';

/** Player hero car — separate parts so each can take a different material. */
export interface CarParts {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  lightsFront: THREE.BufferGeometry;
  lightsRear: THREE.BufferGeometry;
  /** Wheel mount points in car-local space, y = hub height. */
  wheelPositions: THREE.Vector3[];
  /** Overall bounding size in metres (x=width, y=height, z=length). */
  size: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Section profile
// ---------------------------------------------------------------------------

/**
 * One cross-section of a vehicle, described by the handful of numbers a car
 * designer would actually name. Every silhouette in this file is a table of
 * these; nothing is hand-placed vertex by vertex.
 *
 * Reading a section bottom-to-top on the right-hand side:
 *
 *        wTop           ______              roof (yTop)
 *                      /      \             ← plan taper + tumblehome
 *        wBelt        |        |            beltline: glass starts here
 *        wMax        (          )           shoulder: the widest point
 *        wBot         \        /            sill, tucked back in
 *                      ‾‾‾‾‾‾‾‾             underbody (yBot)
 *
 * `yBot` is the load-bearing trick: raising it over an axle turns the underside
 * into a vaulted **wheel arch**, which is what puts the wheel inside the body
 * instead of bolting it to a slab.
 */
type Sec = readonly [
  z: number,
  yBot: number,
  yTop: number,
  wBot: number,
  wMax: number,
  ySh: number,
  wBelt: number,
  yBelt: number,
  wTop: number,
  /** 0..1 — how rounded the roof edge is. 1 = soft coupé, 0 = hard bus lip. */
  topF: number,
  /** 0..1 — how rounded the sill/underbody edge is. */
  botF: number,
];

/** Detail levels: how many points describe half a section. */
type Detail = 0 | 1;
/** Hero car — adds a lower-flank and an upper-flank point. Ring = 18. */
const HI: Detail = 0;
/** Traffic — shoulder runs straight to the beltline. Ring = 14. */
const LO: Detail = 1;

/**
 * Expand one section into a closed ring of 3D points, ordered
 * bottom-centre → up the right flank → top-centre → down the left flank.
 *
 * That order is counter-clockwise in XY viewed from +Z, which combined with
 * sections running front(−Z)→back(+Z) makes the loft's quad winding come out
 * facing outward without any per-face fixups.
 */
function sectionRing(s: Sec, detail: Detail): THREE.Vector3[] {
  const [z, yBot, yTop, wBot, wMax, ySh, wBelt, yBelt, wTop, topF, botF] = s;

  // Fillets are clamped away from zero: a genuinely sharp corner would put two
  // ring points on top of each other and emit degenerate (normal-free) tris.
  const fy = Math.max(0.014, topF * (yTop - yBelt) * 0.45);
  const fx = Math.max(0.014, topF * wTop * 0.34);
  const by = Math.max(0.012, botF * (ySh - yBot) * 0.22);
  const bx = Math.max(0.012, botF * wBot * 0.26);

  const half: [number, number][] = [];
  half.push([0, yBot]); // 0 underbody centre
  half.push([wBot - bx, yBot]); // 1 underbody edge
  half.push([wBot, yBot + by]); // 2 sill  [crease rail]
  if (detail === HI) {
    // Lower flank: pulled 72% of the way out to the shoulder but only 55% of
    // the way up, which is what gives the flank its convex "tuck".
    half.push([wBot + (wMax - wBot) * 0.72, yBot + (ySh - yBot) * 0.55]);
  }
  half.push([wMax, ySh]); // shoulder — widest point  [crease rail]
  if (detail === HI) {
    half.push([wBelt + (wMax - wBelt) * 0.62, ySh + (yBelt - ySh) * 0.58]);
  }
  half.push([wBelt, yBelt]); // beltline  [crease rail]
  half.push([wTop, yTop - fy]); // roof rail  [crease rail]
  half.push([wTop - fx, yTop]); // roof edge
  half.push([0, yTop]); // roof centre

  const ring: THREE.Vector3[] = [];
  for (const [x, y] of half) ring.push(new THREE.Vector3(x, y, z));
  // Mirror everything except the two centreline points.
  for (let i = half.length - 2; i >= 1; i--) {
    ring.push(new THREE.Vector3(-half[i][0], half[i][1], z));
  }
  return ring;
}

/** Ring indices, by detail level. Named so the patch/crease code reads. */
const RAIL_HI = {
  underC: 0,
  under: 1,
  sill: 2,
  lowFlank: 3,
  shoulder: 4,
  upFlank: 5,
  belt: 6,
  rail: 7,
  roofEdge: 8,
  roofC: 9,
  count: 18,
} as const;

const RAIL_LO = {
  underC: 0,
  under: 1,
  sill: 2,
  shoulder: 3,
  belt: 4,
  rail: 5,
  roofEdge: 6,
  roofC: 7,
  count: 14,
} as const;

/** Mirror a right-side rail index onto the left side of the ring. */
function mirrorRail(j: number, count: number): number {
  return (count - j) % count;
}

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

interface LoftOpts {
  /** Section indices carrying a transverse hard edge (windscreen base, tail). */
  creaseSections?: number[];
  /** Ring indices carrying a longitudinal hard edge (shoulder line, sill). */
  creaseRails?: number[];
  capFront?: boolean;
  capBack?: boolean;
  /** Skip a quad — used to cut light apertures straight out of the bodywork. */
  omit?: (section: number, rail: number) => boolean;
}

/**
 * Loft a closed tube through ordered rings.
 *
 * Crease handling: a quad spanning sections i→i+1 references section i through
 * its "trailing" copy and section i+1 through its "leading" copy. Marking i as
 * a crease makes those two copies distinct vertices, so normals cannot average
 * across the boundary. Same trick around the ring for longitudinal creases.
 */
function loft(rings: THREE.Vector3[][], o: LoftOpts = {}): THREE.BufferGeometry {
  const S = rings.length;
  const N = rings[0].length;
  const cs = new Set(o.creaseSections ?? []);
  const cr = new Set(o.creaseRails ?? []);
  const pos: number[] = [];
  const idx: number[] = [];
  const memo = new Map<number, number>();

  const vert = (si: number, sTag: number, ri: number, rTag: number): number => {
    const key = (si * 2 + sTag) * (N * 2) + (ri * 2 + rTag);
    let v = memo.get(key);
    if (v === undefined) {
      const p = rings[si][ri];
      v = pos.length / 3;
      pos.push(p.x, p.y, p.z);
      memo.set(key, v);
    }
    return v;
  };

  for (let i = 0; i < S - 1; i++) {
    const sTagA = cs.has(i) ? 1 : 0; // trailing copy at section i
    for (let j = 0; j < N; j++) {
      if (o.omit?.(i, j)) continue;
      const j2 = (j + 1) % N;
      const rTagA = cr.has(j) ? 1 : 0; // trailing copy at rail j
      const a = vert(i, sTagA, j, rTagA);
      const b = vert(i, sTagA, j2, 0);
      const c = vert(i + 1, 0, j2, 0);
      const d = vert(i + 1, 0, j, rTagA);
      idx.push(a, b, c, a, c, d);
    }
  }

  // Caps get their own vertices, so they are automatically hard against the
  // flanks — exactly what a real front fascia / tail panel boundary looks like.
  const cap = (si: number, front: boolean) => {
    const ring = rings[si];
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
    }
    const c = pos.length / 3;
    pos.push(cx / N, cy / N, ring[0].z);
    const base = pos.length / 3;
    for (const p of ring) pos.push(p.x, p.y, p.z);
    for (let j = 0; j < N; j++) {
      const j2 = (j + 1) % N;
      if (front) idx.push(c, base + j2, base + j);
      else idx.push(c, base + j, base + j2);
    }
  };
  if (o.capFront) cap(0, true);
  if (o.capBack) cap(S - 1, false);

  return finish(pos, idx);
}

/** Outward direction of a ring point, used for offsetting glass/lens patches. */
function outward(ring: THREE.Vector3[], j: number): THREE.Vector3 {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  const p = ring[j];
  const v = new THREE.Vector3(p.x, p.y - (lo + hi) * 0.5, 0);
  return v.lengthSq() < 1e-9 ? new THREE.Vector3(0, 1, 0) : v.normalize();
}

/**
 * Carve a rectangular patch out of the loft grid and offset it along the
 * surface normal. Positive offset floats it proud (glass sitting on the
 * greenhouse); negative sinks it in (a recessed headlight lens).
 *
 * Because the patch reuses the loft's own section rings it is guaranteed to
 * follow the body's curvature and angle — which is the whole point. A lens
 * placed by hand on a curved fender never sits right.
 */
function patch(
  rings: THREE.Vector3[][],
  s0: number,
  s1: number,
  r0: number,
  rCount: number,
  offset: number,
): THREE.BufferGeometry {
  const N = rings[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  const cols = rCount + 1;
  for (let i = s0; i <= s1; i++) {
    for (let k = 0; k <= rCount; k++) {
      const j = (r0 + k) % N;
      const p = rings[i][j];
      const n = outward(rings[i], j);
      pos.push(p.x + n.x * offset, p.y + n.y * offset, p.z + n.z * offset);
    }
  }
  for (let i = 0; i < s1 - s0; i++) {
    for (let k = 0; k < rCount; k++) {
      const a = i * cols + k;
      const b = i * cols + k + 1;
      const c = (i + 1) * cols + k + 1;
      const d = (i + 1) * cols + k;
      idx.push(a, b, c, a, c, d);
    }
  }
  return finish(pos, idx);
}

/**
 * The walls that connect a sunken patch back to the surrounding bodywork.
 * Without these a recessed lens is a floating rectangle with a hole around it;
 * with them it is a socket, and at dusk the socket edge is what tells you the
 * lamp is set into the wing.
 */
function socket(
  rings: THREE.Vector3[][],
  s0: number,
  s1: number,
  r0: number,
  rCount: number,
  depth: number,
): THREE.BufferGeometry {
  const N = rings[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  const push = (i: number, j: number, off: number) => {
    const p = rings[i][j];
    const n = outward(rings[i], j);
    const v = pos.length / 3;
    pos.push(p.x + n.x * off, p.y + n.y * off, p.z + n.z * off);
    return v;
  };
  // Walk the aperture border and raise a wall from the sunken rim to the skin.
  const border: [number, number][] = [];
  for (let k = 0; k < rCount; k++) border.push([s0, (r0 + k) % N]);
  for (let i = s0; i < s1; i++) border.push([i, (r0 + rCount) % N]);
  for (let k = rCount; k > 0; k--) border.push([s1, (r0 + k) % N]);
  for (let i = s1; i > s0; i--) border.push([i, r0 % N]);

  for (let b = 0; b < border.length; b++) {
    const [i0, j0] = border[b];
    const [i1, j1] = border[(b + 1) % border.length];
    const a = push(i0, j0, 0);
    const c = push(i1, j1, 0);
    const d = push(i1, j1, depth);
    const e = push(i0, j0, depth);
    idx.push(a, c, d, a, d, e);
  }
  return finish(pos, idx);
}

/**
 * Cap a section ring with a per-rail inset + pushback, producing a real
 * **recess** rather than a flat face: deep in the middle (the grille mouth),
 * fading to nothing at the top (where the bonnet leading edge should stay
 * crisp). Reused at the rear for the diffuser/tail-panel recess.
 */
function recessCap(
  ring: THREE.Vector3[],
  front: boolean,
  insetFor: (j: number) => number,
  depthFor: (j: number) => number,
): THREE.BufferGeometry {
  const N = ring.length;
  const pos: number[] = [];
  const idx: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const p of ring) {
    cx += p.x;
    cy += p.y;
  }
  cx /= N;
  cy /= N;
  const z = ring[0].z;
  const dir = front ? 1 : -1; // "back into the car" along Z

  const inner: THREE.Vector3[] = ring.map((p, j) => {
    const t = insetFor(j);
    return new THREE.Vector3(
      cx + (p.x - cx) * t,
      cy + (p.y - cy) * t,
      z + dir * depthFor(j),
    );
  });

  const base = 0;
  for (const p of ring) pos.push(p.x, p.y, p.z);
  const innerBase = N;
  for (const p of inner) pos.push(p.x, p.y, p.z);
  for (let j = 0; j < N; j++) {
    const j2 = (j + 1) % N;
    const a = base + j;
    const b = base + j2;
    const c = innerBase + j2;
    const d = innerBase + j;
    if (front) idx.push(a, d, c, a, c, b);
    else idx.push(a, b, c, a, c, d);
  }
  // Floor of the recess.
  let ix = 0;
  let iy = 0;
  let iz = 0;
  for (const p of inner) {
    ix += p.x;
    iy += p.y;
    iz += p.z;
  }
  const centre = pos.length / 3;
  pos.push(ix / N, iy / N, iz / N);
  for (let j = 0; j < N; j++) {
    const j2 = (j + 1) % N;
    if (front) idx.push(centre, innerBase + j2, innerBase + j);
    else idx.push(centre, innerBase + j, innerBase + j2);
  }
  return finish(pos, idx);
}

/** Box with independent top/bottom scaling — mirror housings, roof signs. */
function taperBox(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  topScaleX = 1,
  topScaleZ = 1,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * topScaleX);
      p.setZ(i, p.getZ(i) * topScaleZ);
    }
  }
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) =>
  taperBox(w, h, d, x, y, z);

/**
 * Lathe a profile around the X axis (the wheel's spin axis).
 * `profile` is a list of [x, radius]; radius 0 closes the shape into a fan.
 */
function revolve(
  profile: [number, number][],
  segments: number,
  creaseAt: number[] = [],
): THREE.BufferGeometry {
  const cr = new Set(creaseAt);
  const pos: number[] = [];
  const idx: number[] = [];
  const memo = new Map<number, number>();
  const vert = (pi: number, tag: number, k: number): number => {
    const kk = k % segments;
    const key = (pi * 2 + tag) * segments * 2 + kk;
    let v = memo.get(key);
    if (v === undefined) {
      const [x, r] = profile[pi];
      const a = (kk / segments) * Math.PI * 2;
      v = pos.length / 3;
      pos.push(x, Math.cos(a) * r, Math.sin(a) * r);
      memo.set(key, v);
    }
    return v;
  };
  for (let i = 0; i < profile.length - 1; i++) {
    const tagA = cr.has(i) ? 1 : 0;
    const r0 = profile[i][1];
    const r1 = profile[i + 1][1];
    for (let k = 0; k < segments; k++) {
      const a = vert(i, tagA, k);
      const b = vert(i, tagA, k + 1);
      const c = vert(i + 1, 0, k + 1);
      const d = vert(i + 1, 0, k);
      if (r0 < 1e-5) idx.push(a, c, d);
      else if (r1 < 1e-5) idx.push(a, b, c);
      else idx.push(a, b, c, a, c, d);
    }
  }
  return finish(pos, idx);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function finish(pos: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Concatenate geometries, keeping index ranges disjoint.
 *
 * Because sub-geometries never share indices, running `computeVertexNormals()`
 * once on the result smooths *within* each part and leaves every seam between
 * parts hard. That is the whole crease strategy in one line.
 */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vTotal = 0;
  let iTotal = 0;
  for (const g of parts) {
    vTotal += g.getAttribute('position').count;
    const ix = g.getIndex();
    iTotal += ix ? ix.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vTotal * 3);
  const index = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vOff = 0;
  let iOff = 0;
  for (const g of parts) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    pos.set(p.array as Float32Array, vOff * 3);
    const ix = g.getIndex();
    if (ix) {
      for (let i = 0; i < ix.count; i++) index[iOff + i] = ix.getX(i) + vOff;
    } else {
      for (let i = 0; i < p.count; i++) index[iOff + i] = i + vOff;
    }
    iOff += ix ? ix.count : p.count;
    vOff += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * Overall size in metres. Height is measured from the ground plane, not from
 * the lowest triangle: y = 0 is the road by convention and the wheels (a
 * separate geometry, centred on their own origin) reach down to it, so the
 * bodywork's own bbox floor would under-report the vehicle's height.
 */
function sizeOf(parts: THREE.BufferGeometry[]): THREE.Vector3 {
  const bb = new THREE.Box3();
  for (const g of parts) {
    g.computeBoundingBox();
    if (g.boundingBox) bb.union(g.boundingBox);
  }
  return new THREE.Vector3(bb.max.x - bb.min.x, bb.max.y, bb.max.z - bb.min.z);
}

// ---------------------------------------------------------------------------
// Player hero car — mid-engine fastback coupé
// ---------------------------------------------------------------------------

/**
 * 1.90 m wide × 1.28 m tall × 4.50 m long. Wheelbase 2.66 m, so the axles sit
 * at z = ∓1.33 and the overhangs are 0.86 m front / 0.86 m rear — short, which
 * is what makes a car look fast standing still.
 *
 * The table below IS the car. Read the `z` column as a walk from the nose
 * (−2.19) to the tail (+2.19) and the other columns as what the section is
 * doing there. Three shaping decisions are worth calling out:
 *
 *  • `yBot` rises to 0.470 at z = ∓1.33 and drops back to the sill height
 *    either side. That vaults the underbody into a WHEEL ARCH — a real curved
 *    recess the wheel lives inside, not a flat panel with a disc stuck on it.
 *    `wBot` simultaneously flares to ~0.94 at the crown so the arch has a LIP.
 *
 *  • `wMax` peaks at 0.950 over the rear axle and falls to 0.856 at the tail,
 *    while `wTop` collapses from 0.836 at the cowl to 0.600 over the roof.
 *    Widest at the shoulder, narrow at the sill, narrower still at the roof —
 *    that is tumblehome, and it is what puts a rim light down the flank.
 *
 *  • `yTop` climbs 0.958 → 1.278 between z = −0.50 and z = +0.07: a 0.57 m run
 *    for a 0.32 m rise, i.e. a windscreen raked ~30° off horizontal. It then
 *    holds level to +0.80 and falls continuously to the tail. FASTBACK, not
 *    notchback — committed to, because the chase camera lives behind the car
 *    and an unbroken roof-to-tail line is the shape that reads from there.
 */
//                z,   yBot,   yTop,   wBot,   wMax,    ySh,  wBelt,  yBelt,   wTop,  topF,  botF
const COUPE: Sec[] = [
  [-2.190, 0.300, 0.720, 0.560, 0.700, 0.480, 0.640, 0.610, 0.520, 0.95, 0.90], //  0 nose face
  [-2.100, 0.185, 0.800, 0.730, 0.840, 0.545, 0.790, 0.690, 0.660, 0.90, 0.75], //  1 fascia
  [-1.980, 0.160, 0.856, 0.808, 0.906, 0.600, 0.870, 0.742, 0.752, 0.80, 0.58], //  2 lamp line
  [-1.800, 0.155, 0.884, 0.838, 0.930, 0.650, 0.898, 0.775, 0.800, 0.66, 0.50], //  3 arch opens
  [-1.630, 0.578, 0.900, 0.895, 0.940, 0.700, 0.908, 0.792, 0.818, 0.58, 0.44], //  4
  [-1.480, 0.676, 0.912, 0.925, 0.946, 0.740, 0.914, 0.804, 0.828, 0.52, 0.40], //  5
  [-1.330, 0.705, 0.920, 0.935, 0.948, 0.762, 0.916, 0.812, 0.833, 0.50, 0.38], //  6 FRONT AXLE
  [-1.180, 0.676, 0.928, 0.925, 0.948, 0.740, 0.916, 0.818, 0.836, 0.52, 0.40], //  7
  [-1.030, 0.578, 0.934, 0.895, 0.944, 0.720, 0.912, 0.824, 0.838, 0.58, 0.44], //  8
  [-0.860, 0.156, 0.940, 0.812, 0.938, 0.712, 0.906, 0.830, 0.836, 0.64, 0.52], //  9 arch closes
  [-0.620, 0.155, 0.950, 0.792, 0.932, 0.720, 0.898, 0.840, 0.826, 0.50, 0.48], // 10 cowl
  [-0.500, 0.155, 0.958, 0.790, 0.928, 0.726, 0.892, 0.848, 0.818, 0.40, 0.48], // 11 SCREEN BASE
  [-0.220, 0.155, 1.118, 0.790, 0.926, 0.734, 0.856, 0.908, 0.700, 0.72, 0.48], // 12 screen mid
  [0.070, 0.155, 1.278, 0.790, 0.926, 0.740, 0.826, 0.968, 0.612, 0.88, 0.48], //  13 ROOF FRONT
  [0.440, 0.155, 1.282, 0.792, 0.930, 0.744, 0.820, 0.972, 0.600, 0.92, 0.48], //  14 roof mid
  [0.800, 0.156, 1.270, 0.796, 0.936, 0.748, 0.822, 0.968, 0.596, 0.92, 0.48], //  15 ROOF REAR
  [0.920, 0.504, 1.238, 0.860, 0.940, 0.752, 0.828, 0.962, 0.606, 0.90, 0.46], //  16
  [1.030, 0.608, 1.205, 0.902, 0.943, 0.756, 0.834, 0.956, 0.620, 0.88, 0.44], //  17
  [1.180, 0.683, 1.150, 0.928, 0.947, 0.764, 0.848, 0.944, 0.652, 0.82, 0.42], //  18
  [1.330, 0.705, 1.098, 0.938, 0.950, 0.775, 0.862, 0.930, 0.690, 0.74, 0.40], //  19 REAR AXLE
  [1.480, 0.676, 1.040, 0.930, 0.950, 0.764, 0.876, 0.906, 0.734, 0.62, 0.42], //  20
  [1.630, 0.578, 0.996, 0.898, 0.945, 0.752, 0.888, 0.880, 0.778, 0.54, 0.46], //  21
  [1.800, 0.156, 0.966, 0.812, 0.938, 0.740, 0.892, 0.862, 0.800, 0.48, 0.52], //  22 arch closes
  [1.950, 0.172, 0.952, 0.790, 0.930, 0.730, 0.890, 0.852, 0.806, 0.44, 0.55], //  23 decklid
  [2.080, 0.190, 0.944, 0.782, 0.922, 0.722, 0.884, 0.848, 0.808, 0.42, 0.56], //  24 TAIL
  [2.190, 0.268, 0.898, 0.700, 0.856, 0.660, 0.816, 0.800, 0.744, 0.55, 0.66], //  25 rear face
];

const R = RAIL_HI;
/** Rails that carry a hard line the length of the car. */
const COUPE_CREASE_RAILS = [
  R.sill,
  R.shoulder, // the shoulder line — the single most important crease on a car
  R.belt,
  R.rail,
  mirrorRail(R.sill, R.count),
  mirrorRail(R.shoulder, R.count),
  mirrorRail(R.belt, R.count),
  mirrorRail(R.rail, R.count),
];
/** Sections where a panel actually stops: screen base, roof ends, tail. */
const COUPE_CREASE_SECTIONS = [1, 11, 13, 15, 24];

/** Lamp apertures, as (section span, right-hand rail span) on the loft grid. */
const HEAD_S0 = 1;
const HEAD_S1 = 3;
const TAIL_S0 = 22;
const TAIL_S1 = 24;
const LAMP_R0 = R.upFlank; // upper flank → beltline: where lamps live on a coupé
const LAMP_RC = 2;
const LAMP_R0_L = mirrorRail(LAMP_R0 + LAMP_RC, R.count);

/**
 * 0.66 m tyre diameter — a real 245/35 R20. This number is load-bearing: the
 * wheel-arch crowns in the section table must clear 2·WHEEL_R, or the tyre
 * tops end up buried inside the bodywork.
 */
const WHEEL_R = 0.33;
const WHEEL_HALF = 0.142;

/** One wheel: 16 radial segments, dished rim face, bulged sidewall. */
function buildWheel(): THREE.BufferGeometry {
  // Symmetric about x=0 on purpose — a single geometry is instanced on both
  // sides of the car, so an asymmetric dish would face inwards on one side.
  // Profile: hub cap proud of a dished rim face, a flange that steps back out
  // to the bead, a sidewall bulging past the flange, then the tread crown.
  const profile: [number, number][] = [
    [-0.088, 0.0], // hub centre, proud of the rim face
    [-0.104, 0.103], // rim face, INSET behind the flange — reads as a real wheel
    [-0.126, 0.233], // rim face outer
    [-WHEEL_HALF, 0.279], // sidewall bulge: the widest point of the whole wheel
    [-0.096, WHEEL_R], // tread shoulder
    [0.096, WHEEL_R], // tread crown (smooth across — rubber has no facets here)
    [WHEEL_HALF, 0.279],
    [0.126, 0.233],
    [0.104, 0.103],
    [0.088, 0.0],
  ];
  // Hard rings at every metal/rubber transition; the bulge and crown stay smooth.
  return merge([revolve(profile, 16, [1, 2, 4, 5, 7, 8])]);
}

export function buildPlayerCar(): CarParts {
  const rings = COUPE.map((s) => sectionRing(s, HI));
  const N = R.count;
  const last = COUPE.length - 1;

  const lampHole = (i: number, j: number): boolean => {
    const inHead = i >= HEAD_S0 && i < HEAD_S1;
    const inTail = i >= TAIL_S0 && i < TAIL_S1;
    if (!inHead && !inTail) return false;
    const right = j >= LAMP_R0 && j < LAMP_R0 + LAMP_RC;
    const left = j >= LAMP_R0_L && j < LAMP_R0_L + LAMP_RC;
    return right || left;
  };

  // --- painted shell -------------------------------------------------------
  const shell = loft(rings, {
    creaseSections: COUPE_CREASE_SECTIONS,
    creaseRails: COUPE_CREASE_RAILS,
    omit: lampHole,
  });
  // Front fascia: deep in the middle (the grille mouth), shallow at the bonnet
  // edge so the leading edge stays crisp instead of collapsing into the recess.
  const noseCap = recessCap(
    rings[0],
    true,
    (j) => (j === R.roofC || j === mirrorRail(R.roofEdge, N) || j === R.roofEdge ? 0.94 : 0.62),
    (j) => (j === R.roofC || j === mirrorRail(R.roofEdge, N) || j === R.roofEdge ? 0.02 : 0.135),
  );
  const tailCap = recessCap(
    rings[last],
    false,
    (j) => (j >= R.belt && j <= mirrorRail(R.belt, N) ? 0.9 : 0.7),
    (j) => (j >= R.belt && j <= mirrorRail(R.belt, N) ? 0.03 : 0.1),
  );
  const body = merge([shell, noseCap, tailCap]);

  // --- glass ---------------------------------------------------------------
  // Floated 10 mm proud of the shell so it never z-fights, and taken straight
  // off the loft grid so it inherits the exact rake and curvature of the roof.
  const glassParts = [
    patch(rings, 11, 13, R.rail, 4, 0.01), // windscreen
    patch(rings, 15, 20, R.rail, 4, 0.01), // rear screen, down the fastback
    patch(rings, 11, 15, R.belt, 1, 0.008), // side glass R
    patch(rings, 11, 15, mirrorRail(R.rail, N), 1, 0.008), // side glass L
    patch(rings, 15, 18, R.belt, 1, 0.008), // rear quarter R
    patch(rings, 15, 18, mirrorRail(R.rail, N), 1, 0.008), // rear quarter L
  ];
  const glass = merge(glassParts);

  // --- lamps ---------------------------------------------------------------
  // Sunk 38 mm INTO the wing and inheriting the wing's angle. At dusk this is
  // what separates a headlight from a sticker: the lens normal is tilted with
  // the bodywork, and the socket wall around it catches the emissive spill.
  const lightsFront = merge([
    patch(rings, HEAD_S0, HEAD_S1, LAMP_R0, LAMP_RC, -0.038),
    patch(rings, HEAD_S0, HEAD_S1, LAMP_R0_L, LAMP_RC, -0.038),
    // Lower bar, standing on the floor of the grille recess. It reads as a
    // second light source deep in the mouth, which is the cue that says the
    // grille is a hole rather than a painted rectangle.
    box(0.80, 0.045, 0.030, 0, 0.525, -2.085),
  ]);
  const lightsRear = merge([
    patch(rings, TAIL_S0, TAIL_S1, LAMP_R0, LAMP_RC, -0.034),
    patch(rings, TAIL_S0, TAIL_S1, LAMP_R0_L, LAMP_RC, -0.034),
    box(1.24, 0.040, 0.022, 0, 0.842, 2.152), // full-width tail bar
  ]);

  // --- dark plastics -------------------------------------------------------
  const trimCore = [
    // Underbody + arch liners in one strip: the arch interior must go dark or
    // the recess reads as a dent in the paint instead of a hole.
    patch(rings, 0, last, mirrorRail(R.under, N), 2, 0.005),
    socket(rings, HEAD_S0, HEAD_S1, LAMP_R0, LAMP_RC, -0.038),
    socket(rings, HEAD_S0, HEAD_S1, LAMP_R0_L, LAMP_RC, -0.038),
    socket(rings, TAIL_S0, TAIL_S1, LAMP_R0, LAMP_RC, -0.034),
    socket(rings, TAIL_S0, TAIL_S1, LAMP_R0_L, LAMP_RC, -0.034),
    box(1.50, 0.060, 0.160, 0, 0.152, -2.170), // front splitter, stepped out
    box(0.24, 0.120, 0.090, 0.72, 0.300, -2.140), // corner intake R
    box(0.24, 0.120, 0.090, -0.72, 0.300, -2.140), // corner intake L
    // Skirt blades overlap the sill rail (x ≈ 0.79) and step out to 0.89 so
    // they bite into the body, and they stop short of both arches — a skirt
    // that runs on into the arch opening hangs in mid-air.
    box(0.135, 0.070, 1.52, 0.822, 0.168, -0.02), // side skirt R
    box(0.135, 0.070, 1.52, -0.822, 0.168, -0.02), // side skirt L
    taperBox(1.62, 0.055, 0.13, 0, 0.972, 1.985, 0.94, 0.7), // ducktail lip
    box(1.52, 0.100, 0.160, 0, 0.216, 2.170), // rear valance
    revolve([[-0.05, 0.048], [0.05, 0.048]], 8).translate(0.40, 0.30, 2.20), // exhaust R
    revolve([[-0.05, 0.048], [0.05, 0.048]], 8).translate(-0.40, 0.30, 2.20), // exhaust L
  ];
  // Mirrors last: they are the cheapest silhouette break on the car (~50 tris
  // for the pair) and they are excluded from `size` because gameplay collision
  // should use the body width, not the mirror width.
  // Stalks start at x = 0.87, inside the beltline rail, so they grow out of the
  // door rather than hovering next to it.
  const mirrors = [
    box(0.11, 0.030, 0.030, 0.925, 0.905, -0.345),
    taperBox(0.052, 0.078, 0.165, 1.012, 0.918, -0.352, 0.8, 0.86),
    box(0.11, 0.030, 0.030, -0.925, 0.905, -0.345),
    taperBox(0.052, 0.078, 0.165, -1.012, 0.918, -0.352, 0.8, 0.86),
  ];

  const size = sizeOf([...trimCore, ...glassParts, body, lightsFront, lightsRear]);
  const trim = merge([...trimCore, ...mirrors]);

  return {
    body,
    glass,
    trim,
    wheel: buildWheel(),
    lightsFront,
    lightsRear,
    // Rear track 20 mm wider than the front — standard, and it makes the car
    // look planted from behind, which is the view the player has all game.
    wheelPositions: [
      new THREE.Vector3(0.796, WHEEL_R, -1.33),
      new THREE.Vector3(-0.796, WHEEL_R, -1.33),
      new THREE.Vector3(0.806, WHEEL_R, 1.33),
      new THREE.Vector3(-0.806, WHEEL_R, 1.33),
    ],
    size,
  };
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

/**
 * Traffic is built from the same lofted sections at a coarser ring (14 instead
 * of 18) and merged down to ONE geometry per kind, ready for an InstancedMesh.
 *
 * The brief for these is different from the hero car: they are seen from behind,
 * at distance, at speed. So the money goes into the **rear three-quarters** —
 * section density is deliberately front-light and rear-heavy — and into making
 * each kind's SILHOUETTE unmistakable in one glance:
 *
 *   coupe  low fastback, the player's own shape
 *   sedan  three-box notch: roof, a clear step down, then a flat boot deck
 *   suv    upright, tall level roof, near-vertical tailgate, roof rails
 *   taxi   sedan plus the roof sign that identifies it across four lanes
 *   bus    tall slab, flat front face, hard roof lip, six wheels
 *   truck  cab, a VISIBLE GAP, then a separate box that is taller than the cab
 */
const L = RAIL_LO;
const TRAFFIC_CREASE_RAILS = [
  L.sill,
  L.shoulder,
  L.belt,
  L.rail,
  mirrorRail(L.sill, L.count),
  mirrorRail(L.shoulder, L.count),
  mirrorRail(L.belt, L.count),
  mirrorRail(L.rail, L.count),
];

/**
 * Traffic wheel: an 8-sided drum. Deliberately crude — at 40 m a traffic wheel
 * is four pixels tall, and every triangle spent here is one not spent on the
 * roofline that actually identifies the vehicle.
 */
function trafficWheel(r: number, halfW: number): THREE.BufferGeometry {
  return revolve(
    [
      [-halfW * 0.92, 0],
      [-halfW, r],
      [halfW, r],
      [halfW * 0.92, 0],
    ],
    8,
    [1, 2],
  );
}

/**
 * Notchback saloon, 1.84 × 1.46 × 4.85. Wheel 0.64 m, so the arch crowns go to
 * 0.70 and the shoulder sits above them at 0.76–0.79.
 *
 * Section spacing is deliberately lopsided: three sections carry the front
 * arch, five carry the rear one, and the whole boot/tail gets four. Traffic is
 * overtaken, not met head-on — the rear three-quarters is the only view that
 * gets looked at, so that is where the triangles go.
 */
//              z,  yBot,  yTop,  wBot,  wMax,   ySh, wBelt, yBelt,  wTop,  topF,  botF
const SEDAN: Sec[] = [
  [-2.425, 0.360, 0.860, 0.550, 0.700, 0.620, 0.660, 0.760, 0.540, 0.90, 0.90],
  [-2.260, 0.220, 0.940, 0.720, 0.860, 0.660, 0.820, 0.840, 0.700, 0.80, 0.70],
  [-1.950, 0.190, 1.020, 0.800, 0.900, 0.720, 0.860, 0.900, 0.780, 0.70, 0.60],
  [-1.720, 0.240, 1.050, 0.840, 0.915, 0.750, 0.870, 0.930, 0.810, 0.60, 0.50],
  [-1.400, 0.700, 1.070, 0.905, 0.920, 0.790, 0.875, 0.950, 0.820, 0.55, 0.40], // front axle
  [-1.080, 0.240, 1.090, 0.840, 0.918, 0.770, 0.878, 0.970, 0.830, 0.55, 0.50],
  [-0.720, 0.175, 1.110, 0.810, 0.915, 0.765, 0.875, 0.990, 0.830, 0.40, 0.50], // screen base
  [-0.100, 0.175, 1.455, 0.810, 0.918, 0.762, 0.845, 1.090, 0.665, 0.85, 0.50], // roof front
  [0.600, 0.175, 1.460, 0.815, 0.920, 0.765, 0.845, 1.090, 0.660, 0.85, 0.50], //  roof rear
  [1.050, 0.200, 1.300, 0.822, 0.918, 0.770, 0.852, 1.075, 0.712, 0.70, 0.50], //  rear screen
  [1.230, 0.520, 1.235, 0.868, 0.918, 0.778, 0.858, 1.060, 0.740, 0.60, 0.45],
  [1.400, 0.700, 1.180, 0.905, 0.920, 0.790, 0.868, 1.050, 0.780, 0.45, 0.40], //  rear axle
  [1.570, 0.520, 1.160, 0.868, 0.918, 0.778, 0.872, 1.044, 0.808, 0.35, 0.45],
  [1.750, 0.200, 1.148, 0.822, 0.915, 0.766, 0.875, 1.036, 0.824, 0.32, 0.48],
  [2.000, 0.190, 1.142, 0.810, 0.910, 0.758, 0.876, 1.028, 0.830, 0.30, 0.50], //  boot deck
  [2.200, 0.210, 1.135, 0.780, 0.900, 0.750, 0.870, 1.020, 0.828, 0.28, 0.55], //  tail
  [2.425, 0.300, 1.060, 0.660, 0.800, 0.700, 0.780, 0.960, 0.740, 0.50, 0.65],
];

/**
 * SUV, 1.98 × 1.78 × 4.90. The read is UPRIGHT: a tall level roof carried all
 * the way back to z = +1.95 and then a near-vertical tailgate (only 0.14 m of
 * fall over the last half-metre). Bigger wheels than the saloon, so the arch
 * crowns rise to 0.78 and the shoulder to 0.86.
 */
const SUV: Sec[] = [
  [-2.450, 0.400, 1.000, 0.600, 0.760, 0.640, 0.720, 0.830, 0.600, 0.80, 0.90],
  [-2.280, 0.260, 1.120, 0.780, 0.920, 0.720, 0.880, 0.960, 0.780, 0.70, 0.70],
  [-1.950, 0.230, 1.240, 0.860, 0.965, 0.800, 0.925, 1.070, 0.870, 0.60, 0.60],
  [-1.740, 0.260, 1.305, 0.890, 0.980, 0.845, 0.935, 1.120, 0.900, 0.50, 0.50],
  [-1.425, 0.780, 1.345, 0.975, 0.990, 0.900, 0.940, 1.170, 0.910, 0.45, 0.40], // front axle
  [-1.110, 0.260, 1.385, 0.890, 0.985, 0.860, 0.940, 1.200, 0.920, 0.45, 0.50],
  [-0.800, 0.215, 1.420, 0.870, 0.982, 0.858, 0.938, 1.215, 0.920, 0.35, 0.50], // screen base
  [-0.300, 0.215, 1.775, 0.870, 0.982, 0.856, 0.910, 1.300, 0.790, 0.40, 0.50], // roof front
  [0.500, 0.215, 1.780, 0.875, 0.985, 0.858, 0.910, 1.300, 0.790, 0.35, 0.50],
  [1.110, 0.260, 1.778, 0.890, 0.985, 0.862, 0.912, 1.300, 0.790, 0.35, 0.50],
  [1.270, 0.600, 1.776, 0.940, 0.988, 0.880, 0.914, 1.300, 0.790, 0.35, 0.45],
  [1.425, 0.780, 1.775, 0.975, 0.990, 0.900, 0.915, 1.300, 0.790, 0.35, 0.40], //  rear axle
  [1.580, 0.600, 1.772, 0.940, 0.988, 0.880, 0.915, 1.295, 0.790, 0.35, 0.45],
  [1.740, 0.260, 1.770, 0.890, 0.985, 0.865, 0.915, 1.290, 0.790, 0.35, 0.50],
  [1.950, 0.235, 1.760, 0.860, 0.978, 0.855, 0.912, 1.280, 0.800, 0.30, 0.55], //  D-pillar
  [2.200, 0.250, 1.735, 0.820, 0.960, 0.840, 0.900, 1.260, 0.800, 0.28, 0.60], //  tailgate
  [2.450, 0.340, 1.620, 0.700, 0.845, 0.780, 0.800, 1.180, 0.720, 0.50, 0.70],
];

/**
 * Bus, 2.55 × 3.20 × 12.0. Constant section for eleven metres, `topF` held at
 * 0.15 so the roof edge stays hard, and the front face only marginally smaller
 * than the body — that flat vertical face with no nose and no taper is the
 * entire bus read. 1.02 m wheels put the arch crowns at 1.10.
 */
const BUS: Sec[] = [
  [-6.000, 0.600, 3.100, 1.140, 1.220, 1.600, 1.200, 1.950, 1.140, 0.25, 0.35],
  [-5.800, 0.440, 3.190, 1.240, 1.272, 1.600, 1.258, 1.950, 1.190, 0.18, 0.25],
  [-4.550, 0.420, 3.200, 1.245, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.20],
  [-4.000, 1.100, 3.200, 1.262, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.18], // front axle
  [-3.450, 0.420, 3.200, 1.245, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.20],
  [0.000, 0.420, 3.200, 1.245, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.20],
  [2.650, 0.420, 3.200, 1.245, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.20],
  [3.200, 1.100, 3.200, 1.262, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.18], // rear axle 1
  [3.800, 0.720, 3.200, 1.250, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.20],
  [4.400, 1.100, 3.200, 1.262, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.18], // rear axle 2
  [4.950, 0.420, 3.200, 1.245, 1.275, 1.600, 1.262, 1.950, 1.200, 0.15, 0.20],
  [5.800, 0.440, 3.190, 1.240, 1.272, 1.600, 1.258, 1.950, 1.190, 0.18, 0.25],
  [6.000, 0.600, 3.100, 1.140, 1.220, 1.600, 1.200, 1.950, 1.140, 0.25, 0.35],
];

/** Truck cab, 2.44 wide × 2.85 tall, ending at z = −2.20. */
const TRUCK_CAB: Sec[] = [
  [-4.800, 0.620, 2.600, 1.080, 1.160, 1.300, 1.140, 1.900, 1.060, 0.30, 0.40],
  [-4.620, 0.500, 2.780, 1.180, 1.220, 1.300, 1.205, 1.920, 1.150, 0.20, 0.30],
  [-4.200, 1.000, 2.830, 1.208, 1.220, 1.300, 1.208, 1.940, 1.160, 0.20, 0.30],
  [-3.900, 1.120, 2.850, 1.212, 1.220, 1.300, 1.210, 1.950, 1.160, 0.20, 0.25], // front axle
  [-3.600, 1.000, 2.850, 1.208, 1.220, 1.300, 1.210, 1.950, 1.160, 0.20, 0.30],
  [-2.600, 0.500, 2.850, 1.190, 1.218, 1.300, 1.208, 1.950, 1.150, 0.20, 0.30],
  [-2.200, 0.520, 2.800, 1.160, 1.200, 1.300, 1.190, 1.940, 1.130, 0.25, 0.35],
];

/**
 * Truck box: starts at z = −1.90, i.e. 0.30 m BEHIND the cab, and tops out
 * 0.75 m above it. Cab → visible gap → taller box is the entire truck read;
 * fuse the two volumes and it turns into a van.
 * Its floor sits at 1.10, clear of the 1.04 m tyre tops underneath it.
 */
const TRUCK_BOX: Sec[] = [
  [-1.900, 1.150, 3.520, 1.200, 1.235, 2.000, 1.232, 2.700, 1.210, 0.20, 0.30],
  [-1.600, 1.100, 3.600, 1.235, 1.250, 2.000, 1.248, 2.700, 1.235, 0.12, 0.20],
  [4.500, 1.100, 3.600, 1.235, 1.250, 2.000, 1.248, 2.700, 1.235, 0.12, 0.20],
  [4.800, 1.150, 3.520, 1.190, 1.225, 2.000, 1.222, 2.700, 1.200, 0.20, 0.30],
];

/** Traffic coupé: the hero table, subsampled. Same car, a third of the cost. */
const COUPE_LOD = [0, 1, 3, 6, 9, 11, 13, 15, 17, 19, 22, 24, 25].map((i) => COUPE[i]);

interface TrafficSpec {
  sections: Sec[];
  creaseSections: number[];
  /** [z of the axle, wheel radius]; each is mirrored to both sides. */
  axles: [number, number][];
  halfTrack: number;
  /** Rear lamp clusters as [halfSpacing, y, z]. */
  lamps: [number, number, number] | null;
  extras?: () => THREE.BufferGeometry[];
}

function trafficSpec(kind: VehicleKind): TrafficSpec {
  switch (kind) {
    case 'coupe':
      return {
        sections: COUPE_LOD,
        creaseSections: [1, 5, 6, 7, 11],
        axles: [
          [-1.33, WHEEL_R],
          [1.33, WHEEL_R],
        ],
        halfTrack: 0.8,
        lamps: [0.6, 0.86, 2.16],
        // Bumper and valance, so the traffic coupé measures the same 4.50 m as
        // the hero car it is a LOD of.
        extras: () => [
          box(1.46, 0.06, 0.15, 0, 0.15, -2.175),
          box(1.48, 0.10, 0.15, 0, 0.22, 2.175),
        ],
      };
    case 'sedan':
      return {
        sections: SEDAN,
        creaseSections: [6, 7, 8, 11, 14, 15],
        axles: [
          [-1.4, 0.32],
          [1.4, 0.32],
        ],
        halfTrack: 0.78,
        lamps: [0.6, 1.03, 2.38],
      };
    case 'taxi':
      return {
        sections: SEDAN,
        creaseSections: [6, 7, 8, 11, 14, 15],
        axles: [
          [-1.4, 0.32],
          [1.4, 0.32],
        ],
        halfTrack: 0.78,
        lamps: [0.6, 1.03, 2.38],
        // The roof sign is the whole point of a taxi silhouette: it is the one
        // feature visible over four lanes of dusk traffic.
        extras: () => [
          box(0.30, 0.045, 0.30, 0, 1.478, 0.05),
          taperBox(0.66, 0.20, 0.26, 0, 1.60, 0.05, 0.86, 0.8),
        ],
      };
    case 'suv':
      return {
        sections: SUV,
        creaseSections: [6, 7, 14, 15],
        axles: [
          [-1.425, 0.36],
          [1.425, 0.36],
        ],
        halfTrack: 0.82,
        lamps: [0.68, 1.42, 2.41],
        // Roof rails: two thin blades that break the roof's straight edge and
        // say "utility" instantly, for 24 triangles.
        extras: () => [
          box(0.06, 0.055, 2.10, 0.60, 1.805, 0.10),
          box(0.06, 0.055, 2.10, -0.60, 1.805, 0.10),
        ],
      };
    case 'bus':
      return {
        sections: BUS,
        creaseSections: [0, 1, 11, 12],
        axles: [
          [-4.0, 0.51],
          [3.2, 0.51],
          [4.4, 0.51],
        ],
        halfTrack: 1.06,
        lamps: [1.02, 0.95, 5.96],
        // The roof lip. A bus roof is a tray, not a dome — the raised rim along
        // the edges is most of what distinguishes it from an anonymous slab.
        extras: () => [
          box(0.075, 0.075, 11.5, 1.185, 3.215, 0),
          box(0.075, 0.075, 11.5, -1.185, 3.215, 0),
          box(2.42, 0.075, 0.09, 0, 3.215, -5.83),
          box(2.42, 0.075, 0.09, 0, 3.215, 5.83),
        ],
      };
    case 'truck':
      return {
        sections: TRUCK_CAB,
        creaseSections: [0, 1, 5, 6],
        axles: [
          [-3.9, 0.52],
          [3.2, 0.52],
          [4.3, 0.52],
        ],
        halfTrack: 1.04,
        lamps: [1.0, 1.30, 4.79],
        extras: () => [
          // The box is a SEPARATE loft with a 0.30 m gap behind the cab, and it
          // is 0.75 m taller. Cab-gap-taller-box is the truck read; a single
          // fused volume reads as a van.
          loft(
            TRUCK_BOX.map((s) => sectionRing(s, LO)),
            { creaseSections: [0, 1, 2, 3], creaseRails: TRAFFIC_CREASE_RAILS, capFront: true, capBack: true },
          ),
          box(1.00, 0.16, 6.40, 0, 0.98, 1.30), // chassis rail bridging the gap
        ],
      };
  }
}

const SIZE_CACHE = new Map<VehicleKind, THREE.Vector3>();

/**
 * One merged, indexed geometry per kind — a single InstancedMesh draw call.
 *
 * Returns a FRESH geometry each call on purpose: callers attach per-instance
 * attributes (`aColor` and friends) to the geometry itself, so handing out a
 * shared instance would make one vehicle pool overwrite another's colours.
 */
export function buildTrafficGeometry(kind: VehicleKind): THREE.BufferGeometry {
  const spec = trafficSpec(kind);
  const rings = spec.sections.map((s) => sectionRing(s, LO));
  const parts: THREE.BufferGeometry[] = [
    loft(rings, {
      creaseSections: spec.creaseSections,
      creaseRails: TRAFFIC_CREASE_RAILS,
      capFront: true,
      capBack: true,
    }),
  ];

  for (const [z, r] of spec.axles) {
    const halfW = r * 0.34;
    parts.push(trafficWheel(r, halfW).translate(spec.halfTrack, r, z));
    parts.push(trafficWheel(r, halfW).translate(-spec.halfTrack, r, z));
  }

  if (spec.lamps) {
    // Raised lens blocks rather than sunk pockets: from 40 m behind, a lamp
    // that catches light beats a lamp that is geometrically correct.
    const [dx, y, z] = spec.lamps;
    parts.push(box(0.34, 0.15, 0.05, dx, y, z), box(0.34, 0.15, 0.05, -dx, y, z));
  }
  if (spec.extras) parts.push(...spec.extras());

  return merge(parts);
}

/** Overall bounding size in metres (x=width, y=height, z=length). */
export function trafficSize(kind: VehicleKind): THREE.Vector3 {
  let v = SIZE_CACHE.get(kind);
  if (!v) {
    v = sizeOf([buildTrafficGeometry(kind)]);
    SIZE_CACHE.set(kind, v);
  }
  return v.clone();
}
