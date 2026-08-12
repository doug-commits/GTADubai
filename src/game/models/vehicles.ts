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
const enum Detail {
  /** Hero car — adds a lower-flank and an upper-flank point. Ring = 18. */
  Hi = 0,
  /** Traffic — shoulder straight to beltline. Ring = 14. */
  Lo = 1,
}

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
  if (detail === Detail.Hi) {
    // Lower flank: pulled 72% of the way out to the shoulder but only 55% of
    // the way up, which is what gives the flank its convex "tuck".
    half.push([wBot + (wMax - wBot) * 0.72, yBot + (ySh - yBot) * 0.55]);
  }
  half.push([wMax, ySh]); // shoulder — widest point  [crease rail]
  if (detail === Detail.Hi) {
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
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function sizeOf(parts: THREE.BufferGeometry[]): THREE.Vector3 {
  const bb = new THREE.Box3();
  for (const g of parts) {
    g.computeBoundingBox();
    if (g.boundingBox) bb.union(g.boundingBox);
  }
  return bb.getSize(new THREE.Vector3());
}
