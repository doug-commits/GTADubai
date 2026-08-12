import * as THREE from 'three';

/**
 * ============================================================================
 *  TOWERS — the ~200 infill buildings of the Sheikh Zayed Road corridor
 * ============================================================================
 *
 *  >>> SOURCING — READ THIS <<<
 *
 *  Every shape in this file is ORIGINAL procedural geometry, lofted in code from
 *  general architectural knowledge of Gulf commercial towers — floor-to-floor
 *  heights, slenderness ratios, podium storey counts, the standard crown
 *  vocabulary. Nothing here is traced, sampled or derived from Google Maps,
 *  Street View, Earth, photographs or any other imagery. No imagery of any kind
 *  was consulted. None of these are named buildings; they are the anonymous
 *  wall of 1990s-2020s commercial towers that the named landmarks sit inside.
 *
 *  ---------------------------------------------------------------------------
 *  WHY THIS FILE EXISTS
 *  ---------------------------------------------------------------------------
 *  The infill was one InstancedMesh of extruded boxes. A wall of boxes with a
 *  very good window shader is still a wall of boxes, because what identifies a
 *  skyline is SILHOUETTE, and a box has one silhouette however it is lit.
 *
 *  Sheikh Zayed Road is not a wall. It is a row of individually distinctive
 *  towers, and five cheap things account for nearly all of that read:
 *
 *   1. THE ROOFLINE. Almost nothing in Dubai ends in a flat cut. Stepped caps,
 *      sloped roofs, blade fins, lantern crowns, mast spires, curved shoulders.
 *      The crown is where a skyline reads, so every archetype here gets one and
 *      the crown gets a disproportionate share of the triangles.
 *   2. THE PODIUM. A 2-5 storey base wider than the shaft, with a ledge. This
 *      single move is what stops a tower looking like a stick pushed into sand.
 *   3. SETBACK AND TAPER. Real towers shed floor area as they rise.
 *   4. CHAMFERED CORNERS. Four extra plan vertices and a rectangle stops
 *      reading as a box. The cheapest win in the file.
 *   5. CURVE AND TWIST. A bowed flank, or a floor plate rotated a fraction of a
 *      degree per storey. Same loft, one extra term in the ring transform.
 *
 *  ---------------------------------------------------------------------------
 *  CONVENTIONS  (shared with landmarks.ts)
 *  ---------------------------------------------------------------------------
 *  • Metres throughout. +Y up. Origin at GROUND LEVEL, centred in x/z.
 *  • One non-indexed BufferGeometry per tower carrying position / normal / uv,
 *    ready to be an InstancedMesh's shared geometry.
 *  • UVs: u = distance around the facade in metres, v = height above ground in
 *    metres. A window grid therefore lands at real-world pitch with no scaling.
 *  • Normals: computeVertexNormals() over a topology that is WELDED where the
 *    surface is smooth and SPLIT where it creases. See `loftStack`. A fully
 *    smoothed tower looks like melted wax; a fully faceted curved flank looks
 *    like a barrel of staves. Both are wrong and both are one flag apart.
 *  • Bottom caps are omitted everywhere. They sit on the ground, are never in
 *    frame, and cost N triangles each across 200 placements.
 *
 *  ---------------------------------------------------------------------------
 *  TRIANGLE BUDGET
 *  ---------------------------------------------------------------------------
 *  250-900 opaque triangles per tower, set mean under 500. `emissive` is a
 *  separate, much smaller buffer and is reported separately. These meshes are
 *  instanced across ~200 placements, so ~20 distinct builds at ~420 triangles
 *  is ~8.4k triangles of unique geometry for the whole corridor.
 *
 *  ---------------------------------------------------------------------------
 *  WIRING INTO city.ts  (notes for the integrator — nothing here touches it)
 *  ---------------------------------------------------------------------------
 *  `facade.ts` expects vec4 aParams = (width, height, depth, seed) in metres.
 *  Feed it `(footprint.x, height, footprint.y, seed)`; the shader uses those for
 *  podium / crown / mechanical-floor articulation and for the corner pilaster
 *  half-extent, and all three land correctly on these builds.
 *
 *  One caveat, because it is easy to lose an afternoon to. FACADE_VERT computes
 *
 *      vLocal = position * aParams.xyz;
 *
 *  which is correct for a UNIT box scaled by the instance matrix, and wrong for
 *  geometry already in metres — it would square the size. These builds are in
 *  metres with the origin at ground level, so the equivalent line is
 *
 *      vLocal = position - vec3(0.0, aParams.y * 0.5, 0.0);
 *
 *  i.e. take the position as-is and re-centre it vertically, since the shader's
 *  vLocal is box-CENTRE relative. Everything downstream of that line in
 *  facade.ts — the face-axis pick, baseY/topY, halfU — then works unchanged.
 *
 *  Second note, on the shader's face-axis pick: it selects the horizontal facade
 *  coordinate from whichever of local x / z the normal is most aligned with, so
 *  the window grid switches parameterisation as a normal crosses 45 degrees.
 *  That is invisible on a box (it happens at the corner) but would show as a
 *  seam mid-flank on a full cylinder. Curved plans here are therefore BOWED
 *  rather than round — flank normals stay inside about +-15 degrees of a face
 *  axis — which is both shader-safe and closer to how these towers are actually
 *  massed. Only the small lantern drums use a full ellipse plan.
 * ============================================================================
 */

export type TowerArchetype =
  | 'slab' | 'setback' | 'tapered' | 'curved' | 'twisted'
  | 'chamfered' | 'crowned' | 'podium-tower' | 'stepped-cap' | 'blade';

export interface TowerBuild {
  /** Merged opaque geometry, origin at ground centre, +Y up, metres. */
  geometry: THREE.BufferGeometry;
  /** Crown bands, lantern glow, spire beacons. Additive material, separate mesh. */
  emissive?: THREE.BufferGeometry;
  /** Overall height in metres, spire included. */
  height: number;
  /** Full x/z extent in metres, podium included — use this for placement. */
  footprint: THREE.Vector2;
  /** Which archetype was built (useful when the caller wants to bias placement). */
  archetype: TowerArchetype;
  /** Opaque triangle count, for budgeting. */
  triangles: number;
}

/** Every archetype, in a stable order. `buildTowerSet` cycles through this. */
export const TOWER_ARCHETYPES: readonly TowerArchetype[] = [
  'slab', 'setback', 'tapered', 'curved', 'twisted',
  'chamfered', 'crowned', 'podium-tower', 'stepped-cap', 'blade',
];

/** Commercial floor-to-floor. Podium storey counts are derived from it. */
const FLOOR_H = 3.7;
const TAU = Math.PI * 2;

// ===========================================================================
// Deterministic PRNG (same generator as city.ts, so seeds are interchangeable)
// ===========================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// Geometry kit — plan sections in, lofted surfaces out
// ===========================================================================

/** A point on a horizontal plan section (metres, in the XZ plane). */
interface P2 { x: number; z: number }
/** A point in space. */
interface V3 { x: number; y: number; z: number }

/**
 * One closed horizontal plan.
 *
 * `p` must be ordered by increasing angle about the section's own centre; every
 * builder below does that, which keeps the loft winding outward-facing and lets
 * caps fan from the centroid.
 *
 * `hard[j]` is the crease flag for vertex j: true splits the normal there so
 * the two flanks meeting at that vertex shade as separate planes. Chamfers and
 * true corners are hard; the interior of a bowed flank or an ellipse is not.
 * This flag is the entire difference between a crisp tower and a candle.
 */
interface Section { p: P2[]; hard: boolean[] }

/**
 * A section placed at a height.
 *
 * `hard` here is the horizontal crease: true means the surface below this ring
 * and the surface above it shade separately, which is what makes a setback
 * ledge, a cornice or a podium cap read as an edge rather than a smudge. A
 * continuous taper or a twist wants false.
 */
interface Ring { p: V3[]; hard: boolean }

/** Plan as a function of (radial scale, height fraction). */
type PlanFn = (s: number, t: number) => Section;

// --- plan sections ---------------------------------------------------------

/** Plain rectangle. Included mostly so slabs can be genuinely rectilinear. */
function secRect(hw: number, hd: number): Section {
  return {
    p: [{ x: hw, z: hd }, { x: -hw, z: hd }, { x: -hw, z: -hd }, { x: hw, z: -hd }],
    hard: [true, true, true, true],
  };
}

/**
 * Rectangular plate whose corners are replaced by an arc of `segs` facets.
 *
 * This one builder covers the whole rectilinear family, because the only thing
 * that separates its members is how many facets the corner gets and whether
 * they are creased:
 *
 *   segs = 1, faceted  -> a plain 45 deg chamfer (8 vertices)
 *   segs = 2-3, faceted -> a returned / stepped corner: several small planes
 *                          turning the corner, each with its own hard edge.
 *                          Extremely common on Gulf commercial towers and the
 *                          cheapest way to buy silhouette per vertex there is.
 *   segs = 2-3, smooth  -> a genuinely rounded corner.
 *
 * On the smooth variant the TANGENT points are still marked hard. Geometrically
 * the join is continuous, but a flat curtain-wall flank running into a curved
 * corner IS a visible break on a real building — different panel planes — and
 * welding it bends the last metre of every flank, which is exactly the soft,
 * waxy look this file exists to avoid.
 */
function cornerPlate(hw: number, hd: number, r: number, segs: number, faceted: boolean): Section {
  const rr = Math.min(r, hw * 0.96, hd * 0.96);
  const cx = hw - rr;
  const cz = hd - rr;
  const centres: P2[] = [{ x: cx, z: cz }, { x: -cx, z: cz }, { x: -cx, z: -cz }, { x: cx, z: -cz }];
  const p: P2[] = [];
  const hard: boolean[] = [];
  for (let c = 0; c < 4; c++) {
    const centre = centres[c];
    const a0 = c * (Math.PI / 2);
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (i / segs) * (Math.PI / 2);
      p.push({ x: centre.x + Math.cos(a) * rr, z: centre.z + Math.sin(a) * rr });
      hard.push(faceted || segs <= 1 || i === 0 || i === segs);
    }
  }
  return { p, hard };
}

/** Rectangle with faceted (creased) corner cuts. */
function secChamfer(hw: number, hd: number, c: number, segs = 1): Section {
  return cornerPlate(hw, hd, c, segs, true);
}

/** Rectangle with smooth rounded corners and flat flanks. */
function secRounded(hw: number, hd: number, r: number, cornerSegs: number): Section {
  return cornerPlate(hw, hd, r, cornerSegs, false);
}

/**
 * Barrel plate: a rectangle whose two long flanks bow outward.
 *
 * This is the curved-front commercial tower, and it is deliberately NOT a
 * cylinder. Keeping the bow shallow holds every flank normal within ~15 deg of
 * a face axis, which keeps the facade shader on one parameterisation across the
 * whole flank, and it is what these buildings actually are: a flat plate with a
 * bowed curtain wall, not a drum.
 */
function secBarrel(hw: number, hd: number, bow: number, segs: number): Section {
  const p: P2[] = [];
  const hard: boolean[] = [];
  for (let s = 0; s < 2; s++) {
    const sgn = s === 0 ? 1 : -1;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      p.push({
        x: hw * (1 - 2 * t) * sgn,
        z: sgn * (hd + bow * Math.sin(Math.PI * t)),
      });
      hard.push(k === 0 || k === segs); // the four real corners; flank stays smooth
    }
  }
  return { p, hard };
}

/** Fully round plate. Used for lantern drums and masts, not for shafts. */
function secEllipse(segments: number, rx: number, rz: number): Section {
  const p: P2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * TAU;
    p.push({ x: Math.cos(a) * rx, z: Math.sin(a) * rz });
  }
  return { p, hard: p.map(() => false) };
}

// --- section transforms ----------------------------------------------------

function scaleSec(s: Section, sx: number, sz = sx): Section {
  return { p: s.p.map((q) => ({ x: q.x * sx, z: q.z * sz })), hard: s.hard };
}

function rotateSec(s: Section, ang: number): Section {
  const c = Math.cos(ang);
  const n = Math.sin(ang);
  return { p: s.p.map((q) => ({ x: q.x * c - q.z * n, z: q.x * n + q.z * c })), hard: s.hard };
}

/** Push every vertex radially outward — proud emissive bands and parapets. */
function expandSec(s: Section, d: number): Section {
  return {
    p: s.p.map((q) => {
      const len = Math.hypot(q.x, q.z) || 1;
      return { x: q.x * (1 + d / len), z: q.z * (1 + d / len) };
    }),
    hard: s.hard,
  };
}

function shiftSec(s: Section, dx: number, dz: number): Section {
  return { p: s.p.map((q) => ({ x: q.x + dx, z: q.z + dz })), hard: s.hard };
}

function ringOf(s: Section, y: number, hard: boolean): Ring {
  return { p: s.p.map((q) => ({ x: q.x, y, z: q.z })), hard };
}

/**
 * A section cut by a tilted plane: vertex height varies linearly with the dot
 * product against a horizontal direction. One ring, and a flat-topped tower
 * becomes a bladed one.
 */
function slicedRingOf(s: Section, yMid: number, slope: number, dx: number, dz: number, hard: boolean): Ring {
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l;
  const uz = dz / l;
  return { p: s.p.map((q) => ({ x: q.x, y: yMid + slope * (q.x * ux + q.z * uz), z: q.z })), hard };
}

/** Largest radius of a section — used to size slices and roof plant. */
function secRadius(s: Section): number {
  let m = 0;
  for (const q of s.p) m = Math.max(m, Math.hypot(q.x, q.z));
  return m;
}

// --- lofting ---------------------------------------------------------------

/**
 * Loft a stack of rings into a surface, with per-edge crease control.
 *
 * The whole point of this function is the weld map. Vertices are keyed by
 * (ring, which side of the ring, column, which side of the column); a ring or
 * column marked hard hands out two different keys for its two sides, so the
 * quads above and below a setback — or either side of a chamfer — get their own
 * vertices and their own normals, while everything else shares. Then
 * `computeVertexNormals()` runs on that welded topology, which means:
 *
 *   • bowed flanks come out genuinely smooth, INCLUDING across the wrap seam
 *     (the usual duplicate-the-seam-column trick leaves a visible crease there);
 *   • floor ledges, chamfers, cornices and parapets come out perfectly crisp.
 *
 * The final buffer is emitted non-indexed rather than via `toNonIndexed()`, so
 * that the u coordinate can keep running past the wrap seam (welded vertices
 * can only carry one uv, and a discontinuity at the seam would show up in any
 * future atlas). Positions and normals still come from the welded vertex, so
 * the shading is unaffected.
 *
 * Winding: rings are ordered by increasing angle and the loft advances along
 * the ring array, so (A_j, B_j, B_j+1) / (A_j, B_j+1, A_j+1) faces outward.
 * Two rings at the same height with different radii produce a flat annulus —
 * that is how every setback ledge in this file is made.
 */
function loftStack(rings: Ring[], colHard: boolean[], capTop = true): THREE.BufferGeometry {
  const R = rings.length;
  const N = colHard.length;
  const KN = 2 * N;

  // Every ring in a stack must come from the same PlanFn at the same facet
  // count. Getting this wrong is easy — one stray rnd() inside a plan closure
  // does it — and the failure is a silently mangled tower, so trap it here.
  for (let i = 0; i < R; i++) {
    if (rings[i].p.length !== N) {
      throw new Error(`loftStack: ring ${i} has ${rings[i].p.length} vertices, expected ${N}`);
    }
  }

  const rowUp = (i: number): number => (rings[i].hard ? 2 * i + 1 : 2 * i);
  const rowDn = (i: number): number => 2 * i;
  const colNx = (j: number): number => (colHard[j] ? 2 * j + 1 : 2 * j);
  const colPv = (j: number): number => 2 * j;

  const slotOf = new Int32Array(2 * R * KN).fill(-1);
  const wPos: number[] = [];
  const vert = (i: number, j: number, rk: number, ck: number): number => {
    const key = rk * KN + ck;
    let s = slotOf[key];
    if (s < 0) {
      s = wPos.length / 3;
      const q = rings[i].p[j];
      wPos.push(q.x, q.y, q.z);
      slotOf[key] = s;
    }
    return s;
  };

  const idx: number[] = [];
  const quads: number[][] = [];
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      const a = vert(i, j, rowUp(i), colNx(j));
      const b = vert(i + 1, j, rowDn(i + 1), colNx(j));
      const c = vert(i + 1, j1, rowDn(i + 1), colPv(j1));
      const d = vert(i, j1, rowUp(i), colPv(j1));
      idx.push(a, b, c, a, c, d);
      quads.push([a, b, c, d, i, j]);
    }
  }

  const welded = new THREE.BufferGeometry();
  welded.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  welded.setIndex(idx);
  welded.computeVertexNormals();
  const nrm = welded.getAttribute('normal');

  // u accumulates real metres around each ring; index N is the full perimeter,
  // so the seam quad reads 0 -> perimeter instead of perimeter -> 0.
  const us: Float64Array[] = rings.map((r) => {
    const acc = new Float64Array(N + 1);
    for (let j = 1; j <= N; j++) {
      const p0 = r.p[j - 1];
      const p1 = r.p[j % N];
      acc[j] = acc[j - 1] + Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    }
    return acc;
  });

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const emit = (slot: number, i: number, ju: number): void => {
    pos.push(wPos[slot * 3], wPos[slot * 3 + 1], wPos[slot * 3 + 2]);
    nor.push(nrm.getX(slot), nrm.getY(slot), nrm.getZ(slot));
    uv.push(us[i][ju], wPos[slot * 3 + 1]);
  };
  for (const q of quads) {
    const a = q[0]; const b = q[1]; const c = q[2]; const d = q[3];
    const i = q[4]; const j = q[5];
    emit(a, i, j); emit(b, i + 1, j); emit(c, i + 1, j + 1);
    emit(a, i, j); emit(c, i + 1, j + 1); emit(d, i, j + 1);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  welded.dispose();

  return capTop ? mergeParts([g, capRing(rings[R - 1])]) : g;
}

/**
 * Centroid fan cap, flat-shaded. Valid for every section here — all are
 * star-shaped about their centroid, including the sliced crown rings.
 */
function capRing(ring: Ring): THREE.BufferGeometry {
  const N = ring.p.length;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const q of ring.p) { cx += q.x / N; cy += q.y / N; cz += q.z / N; }
  const pos: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j < N; j++) {
    const a = ring.p[j];
    const b = ring.p[(j + 1) % N];
    pos.push(cx, cy, cz, b.x, b.y, b.z, a.x, a.y, a.z);
    uv.push(cx, cz, b.x, b.z, a.x, a.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals(); // non-indexed: one normal per face, i.e. flat
  return g;
}

/** Concatenate non-indexed position/normal/uv geometries into one buffer. */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let n = 0;
  for (const p of flat) n += p.getAttribute('position').count;

  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let o = 0;
  for (const p of flat) {
    const pa = p.getAttribute('position');
    const na = p.getAttribute('normal');
    const ua = p.getAttribute('uv');
    for (let i = 0; i < pa.count; i++) {
      pos[(o + i) * 3] = pa.getX(i);
      pos[(o + i) * 3 + 1] = pa.getY(i);
      pos[(o + i) * 3 + 2] = pa.getZ(i);
      nor[(o + i) * 3] = na ? na.getX(i) : 0;
      nor[(o + i) * 3 + 1] = na ? na.getY(i) : 1;
      nor[(o + i) * 3 + 2] = na ? na.getZ(i) : 0;
      uv[(o + i) * 2] = ua ? ua.getX(i) : 0;
      uv[(o + i) * 2 + 1] = ua ? ua.getY(i) : 0;
    }
    o += pa.count;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// --- small solids ----------------------------------------------------------

/** Box with its base at `y`, centred on x/z. 12 triangles (no bottom cap: 8+4). */
function boxAt(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  const s = rotateSec(secRect(w / 2, d / 2), rotY);
  const g = loftStack([ringOf(s, y, true), ringOf(s, y + h, true)], s.hard, true);
  g.translate(x, 0, z);
  return g;
}

/**
 * Slender tapered needle — aerial masts, spires, finials. Concave taper, so it
 * thins fast at the bottom and holds a fine point, which is what a real mast
 * silhouette does against a bright sky.
 */
function needle(yBase: number, height: number, rBase: number, rTop: number, segs: number, sides = 5): THREE.BufferGeometry {
  const base = secEllipse(sides, 1, 1);
  const rings: Ring[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const r = rBase + (rTop - rBase) * Math.pow(t, 0.72);
    rings.push(ringOf(scaleSec(base, r), yBase + height * t, false));
  }
  return loftStack(rings, base.hard, true);
}

/** Satellite dish silhouette: a shallow tilted cone on a stub post. */
function dish(r: number, x: number, y: number, z: number, tilt: number, rotY: number): THREE.BufferGeometry {
  const sec = secEllipse(8, 1, 1);
  const face = loftStack([
    ringOf(scaleSec(sec, r * 0.22), 0, true),
    ringOf(scaleSec(sec, r), r * 0.42, false),
  ], sec.hard, true);
  face.rotateX(tilt);
  face.translate(0, r * 0.9, 0);
  const post = boxAt(r * 0.34, r * 0.9, r * 0.34, 0, 0, 0);
  const g = mergeParts([face, post]);
  g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

/** A thin proud band around a section — crown lights and signage. */
function bandOf(sec: Section, y: number, h: number, out: number): THREE.BufferGeometry {
  const e = expandSec(sec, out);
  return loftStack([ringOf(e, y, true), ringOf(e, y + h, true)], e.hard, false);
}

// ===========================================================================
// Crowns
//
// Every crown function is called with the ring stack ALREADY ending at
// (scale `s`, height `y`), and appends from there. They return the height they
// finished at, and whether they left a usable flat roof plate for plant.
// ===========================================================================

interface CrownOut { top: number; flat: boolean; scale: number }

/**
 * Parapet: the roof slab steps proud of the facade and turns up. The most
 * ordinary crown there is, and still not a flat cut.
 */
function crownParapet(stack: Ring[], plan: PlanFn, s: number, y: number, h: number): CrownOut {
  const up = expandSec(plan(s, 1), 0.5);
  stack.push(ringOf(up, y, true));
  stack.push(ringOf(up, y + h, true));
  return { top: y + h, flat: true, scale: s };
}

/**
 * One clean diagonal cut, optionally over a projecting cornice.
 *
 * The cheapest strong silhouette in the file. The cornice matters more than it
 * looks: a slice straight off the shaft reads as a mistake, a slice off a
 * cornice reads as a designed blade.
 */
function crownSlice(stack: Ring[], plan: PlanFn, s: number, y: number, h: number, dx: number, dz: number, cornice: boolean): CrownOut {
  let sec = plan(s * 0.99, 1);
  let y0 = y;
  if (cornice) {
    sec = expandSec(sec, 0.55);
    stack.push(ringOf(sec, y, true));
    stack.push(ringOf(sec, y + h * 0.2, true));
    y0 = y + h * 0.2;
  }
  const rise = y + h - y0;
  const slope = rise / (2 * Math.max(secRadius(sec), 0.5));
  stack.push(slicedRingOf(sec, y0 + rise * 0.5, slope, dx, dz, true));
  return { top: y + h, flat: false, scale: s };
}

/**
 * Stepped cap: riser, ledge, riser, ledge. The radii follow a quarter circle so
 * the steps crowd together at the top — that acceleration is the art-deco tell,
 * and an evenly stepped cap reads as a staircase instead.
 */
function crownStepped(stack: Ring[], plan: PlanFn, s: number, y: number, h: number, steps: number): CrownOut {
  let sk = s;
  const dy = h / steps;
  for (let k = 1; k <= steps; k++) {
    const f = Math.cos((k / steps) * (Math.PI / 2)) * 0.88 + 0.12;
    stack.push(ringOf(plan(sk, 1), y + dy * k, true));      // riser to the ledge
    stack.push(ringOf(plan(s * f, 1), y + dy * k, true));   // ledge steps in
    sk = s * f;
  }
  return { top: y + h, flat: false, scale: sk };
}

/**
 * Curved shoulder: the section shrinks along a quarter cosine while the
 * roofline rises along a quarter sine, so the tower does not stop, it sweeps.
 * `shift` leans the sweep to one side. Marked smooth throughout — this is the
 * one place a welded, curved normal is exactly right.
 */
function crownSwoop(stack: Ring[], plan: PlanFn, s: number, y: number, h: number, segs: number, shift: number): CrownOut {
  stack[stack.length - 1].hard = false; // flow out of the shaft, do not crease
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const sc = Math.max(s * Math.cos((t * Math.PI) / 2.15), 0.05);
    stack.push(ringOf(shiftSec(plan(sc, 1), shift * t * t, 0), y + h * Math.sin((t * Math.PI) / 2), false));
  }
  return { top: y + h, flat: false, scale: s * 0.2 };
}

/**
 * Lantern: step in, a glazed drum, a projecting cornice, then a shallow cap.
 * The cornice is the part that reads — it throws a hard shadow line right where
 * the eye lands on a distant tower.
 */
function crownLantern(stack: Ring[], plan: PlanFn, s: number, y: number, h: number): CrownOut {
  const sIn = s * 0.7;
  stack.push(ringOf(plan(sIn, 1), y, true));                     // setback into the lantern
  stack.push(ringOf(plan(sIn, 1), y + h * 0.58, true));
  stack.push(ringOf(plan(sIn * 1.16, 1), y + h * 0.58, true));   // cornice throws out
  stack.push(ringOf(plan(sIn * 1.16, 1), y + h * 0.68, true));
  stack.push(ringOf(plan(sIn * 0.26, 1), y + h, true));          // shallow pyramid cap
  return { top: y + h, flat: false, scale: sIn };
}

/** Sloped roof to a small top plate — the hipped cap on mid-rise commercial. */
function crownPyramid(stack: Ring[], plan: PlanFn, s: number, y: number, h: number): CrownOut {
  stack.push(ringOf(expandSec(plan(s, 1), 0.4), y, true));       // eaves overhang
  stack.push(ringOf(plan(s * 0.58, 1), y + h * 0.66, true));
  stack.push(ringOf(plan(s * 0.2, 1), y + h, true));
  return { top: y + h, flat: false, scale: s * 0.2 };
}

// ===========================================================================
// Rooftop plant
//
// Chillers, an aerial mast, a dish. Perhaps 60 triangles, and at 400 m it is
// the difference between a roofline and a cut edge. Nothing on a real tower
// roof is empty.
// ===========================================================================

function rooftopPlant(sec: Section, y: number, rnd: () => number, parts: THREE.BufferGeometry[]): void {
  let ex = 0;
  let ez = 0;
  for (const q of sec.p) { ex = Math.max(ex, Math.abs(q.x)); ez = Math.max(ez, Math.abs(q.z)); }
  const rx = ex * 0.52;
  const rz = ez * 0.52;

  // Lift overrun and stair core. Always present on a real roof, always the
  // tallest thing up there apart from the mast, and the one piece of plant that
  // actually breaks the roofline from street level.
  parts.push(boxAt(
    Math.max(2.6, ex * 0.34), 3.4 + rnd() * 2.6, Math.max(2.6, ez * 0.34),
    (rnd() * 2 - 1) * rx * 0.5, y, (rnd() * 2 - 1) * rz * 0.5,
  ));

  const units = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < units; i++) {
    const w = Math.max(1.8, ex * (0.20 + rnd() * 0.28));
    const d = Math.max(1.8, ez * (0.20 + rnd() * 0.28));
    const h = 1.8 + rnd() * 3.4;
    parts.push(boxAt(w, h, d, (rnd() * 2 - 1) * rx, y, (rnd() * 2 - 1) * rz));
  }
  if (rnd() < 0.72) {
    const mh = 6 + rnd() * 16;
    parts.push(needle(y, mh, 0.5, 0.14, 2, 4));
  }
  if (rnd() < 0.42) {
    parts.push(dish(1.5 + rnd() * 1.6, (rnd() * 2 - 1) * rx, y, (rnd() * 2 - 1) * rz, -0.7, rnd() * TAU));
  }
}

// ===========================================================================
// The tower
// ===========================================================================

/**
 * Build one infill tower.
 *
 * Deterministic: the same seed always yields byte-identical buffers. The
 * archetype and the height fraction are always drawn from the stream even when
 * `opts` overrides them, so `buildTower(s)` and `buildTower(s, { archetype })`
 * produce the same proportions with a different silhouette rather than two
 * unrelated buildings.
 */
export function buildTower(seed: number, opts: {
  minHeight?: number; maxHeight?: number; archetype?: TowerArchetype;
} = {}): TowerBuild {
  const rnd = mulberry32((seed >>> 0) || 1);
  const rr = (a: number, b: number): number => a + rnd() * (b - a);

  const minH = opts.minHeight ?? 30;
  const maxH = opts.maxHeight ?? 250;

  const archPick = TOWER_ARCHETYPES[Math.floor(rnd() * TOWER_ARCHETYPES.length)];
  const arch: TowerArchetype = opts.archetype ?? archPick;

  // Heavy tail: most of the corridor is mid-rise, a few blocks spike. A flat
  // distribution of heights is one of the loudest "procedural city" tells.
  const hT = Math.pow(rnd(), 1.9);
  let H = minH + (maxH - minH) * hT;
  // Archetypes carry their own scale habits. Slabs and blades are broad and
  // lower; lantern crowns and stepped caps are put on the tall ones.
  if (arch === 'slab' || arch === 'blade') H *= 0.78;
  if (arch === 'crowned' || arch === 'stepped-cap' || arch === 'twisted') H *= 1.22;
  if (arch === 'podium-tower') H *= 1.05;
  H = Math.min(Math.max(H, minH), maxH);

  // --- plate ---------------------------------------------------------------
  // Slenderness. Real commercial towers sit between about 4.5 and 10; go past
  // that and the corridor reads as a bundle of pencils.
  const slender = rr(4.6, 9.6);
  let hw = Math.min(Math.max(H / slender, 12), 46) * 0.5;
  let hd = hw * rr(0.66, 1.0);
  if (arch === 'slab') { hw = Math.min(hw * rr(1.7, 2.3), 39); hd = hw * rr(0.20, 0.30); }
  if (arch === 'blade') { hw = Math.min(hw * rr(1.5, 1.9), 34); hd = hw * rr(0.17, 0.26); }
  if (arch === 'curved') { hw *= rr(1.05, 1.35); hd = hw * rr(0.42, 0.62); }
  hd = Math.max(hd, 5.5);

  // --- plan family ---------------------------------------------------------
  // Facet count is the main triangle dial in the file, so it is chosen against
  // how many rings the archetype is about to want: a twisted stack needs a lot
  // of rings and can afford few facets; a plain shaft is the other way round.
  const planRoll = rnd();
  let plan: PlanFn;
  if (arch === 'curved') {
    // Bow varies with height as well as radius, so the flank bellies out around
    // mid-shaft. That vertical curvature is most of what "curved tower" means.
    const bow = hd * rr(0.55, 0.95);
    const segs = 5 + Math.floor(rnd() * 3); // 12-16 plan vertices
    plan = (s, t) => secBarrel(hw * s, hd * s, bow * s * (0.45 + 0.75 * Math.sin(Math.PI * Math.min(Math.max(t, 0), 1))), segs);
  } else if (arch === 'twisted') {
    // Few facets, many plates: the corners tracing helices are the whole read.
    const c = Math.min(hw, hd) * rr(0.16, 0.30);
    const segs = 1 + (rnd() < 0.4 ? 1 : 0);
    plan = (s) => secChamfer(hw * s, hd * s, c * s, segs);
  } else if (arch === 'chamfered') {
    // A deep, multi-faceted returned corner — this archetype IS its corner.
    const c = Math.min(hw, hd) * rr(0.34, 0.5);
    const segs = 2 + Math.floor(rnd() * 2);
    plan = (s) => secChamfer(hw * s, hd * s, c * s, segs);
  } else if (arch === 'blade' || arch === 'slab' || arch === 'setback' || arch === 'stepped-cap') {
    const c = Math.min(hw, hd) * rr(0.20, 0.40);
    const segs = 2 + (rnd() < 0.5 ? 1 : 0);
    plan = (s) => secChamfer(hw * s, hd * s, c * s, segs);
  } else if (planRoll < 0.42) {
    const r = Math.min(hw, hd) * rr(0.26, 0.46);
    const segs = 2 + (rnd() < 0.5 ? 1 : 0);
    plan = (s) => secRounded(hw * s, hd * s, r * s, segs);
  } else if (planRoll < 0.8) {
    const c = Math.min(hw, hd) * rr(0.18, 0.36);
    const segs = 2 + (rnd() < 0.45 ? 1 : 0);
    plan = (s) => secChamfer(hw * s, hd * s, c * s, segs);
  } else {
    const bow = hd * rr(0.25, 0.5);
    const segs = 5 + Math.floor(rnd() * 2);
    plan = (s) => secBarrel(hw * s, hd * s, bow * s, segs);
  }

  const colHard = plan(1, 0).hard;
  const nPlan = colHard.length;
  const stack: Ring[] = [];
  const parts: THREE.BufferGeometry[] = [];
  const em: THREE.BufferGeometry[] = [];

  // --- podium --------------------------------------------------------------
  // 2-5 storeys of retail/parking, wider than the shaft, with a ledge on top.
  // A handful of plots on the real road do rise straight off the pavement, so
  // a few here do too.
  const bigPodium = arch === 'podium-tower';
  const hasPodium = bigPodium || rnd() < 0.86;
  const podStoreys = bigPodium ? 4 + Math.floor(rnd() * 3) : 2 + Math.floor(rnd() * 3);
  const podH = Math.max(5.4, Math.min(podStoreys * FLOOR_H + rr(0, 1.8), H * 0.42));
  // Podiums are plot-sized, not tower-sized: a whole-plot retail base tops out
  // around 60-65 m across on this road, however big the tower above it is.
  const podS = Math.max(1.06, Math.min(
    bigPodium ? rr(1.9, 2.7) : rr(1.18, 1.55),
    34 / Math.max(hw, 1),
    30 / Math.max(hd, 1),
  ));

  let y = 0;
  let s = 1;

  /**
   * Expressed slab edge at the top of a podium: the deck projects half a metre
   * proud and turns up. Every podium on this road has one — it is the canopy
   * line over the retail — and it is the crease that separates base from shaft.
   * Without it a podium is just a wider box and reads as a modelling accident.
   */
  const cornice = (sec: Section, top: number, out: number, depth: number): void => {
    const c = expandSec(sec, out);
    stack.push(ringOf(sec, top - depth, true));
    stack.push(ringOf(c, top - depth, true));
    stack.push(ringOf(c, top, true));
  };

  if (hasPodium) {
    stack.push(ringOf(plan(podS, 0), 0, true));
    if (bigPodium) {
      // Two-tier podium: a broad retail box, then a car-park deck stepping in.
      const midS = podS * rr(0.72, 0.84);
      stack.push(ringOf(plan(podS, 0), podH * 0.56, true));
      stack.push(ringOf(plan(midS, 0), podH * 0.56, true));
      cornice(plan(midS, 0), podH, 0.6, 1.3);
      em.push(bandOf(plan(podS, 0), podH * 0.56 - 2.6, 1.5, 0.35));
    } else {
      cornice(plan(podS, 0), podH, 0.6, 1.3);
    }
    stack.push(ringOf(plan(1, 0), podH, true));
    y = podH;
    if (rnd() < 0.45 && podH > 7) em.push(bandOf(plan(podS, 0), podH - 5.0, 1.6, 0.35));
  } else {
    // No podium: a plinth and an entrance canopy, which is the least a tower
    // can do where it meets the pavement.
    stack.push(ringOf(plan(1.05, 0), 0, true));
    cornice(plan(1.05, 0), 6.4, 0.7, 1.2);
    stack.push(ringOf(plan(1, 0), 6.4, true));
    y = 6.4;
  }

  // --- shaft ---------------------------------------------------------------
  const crownH = Math.min(Math.max(H * rr(0.06, 0.14), 5), 34);
  const shaftTop = Math.max(H - crownH, y + 8);
  const tOf = (yy: number): number => (yy - y) / Math.max(shaftTop - y, 1);
  let twist = 0;

  switch (arch) {
    case 'setback': {
      // Ziggurat. Setbacks crowd toward the top, one wing of area shed each time.
      const steps = 3 + Math.floor(rnd() * 2);
      for (let k = 1; k <= steps; k++) {
        const yk = y + (shaftTop - y) * Math.pow(k / (steps + 1), 0.9);
        stack.push(ringOf(plan(s, tOf(yk)), yk, true));
        s *= rr(0.84, 0.93);
        stack.push(ringOf(plan(s, tOf(yk)), yk + 0.7, true));
      }
      stack.push(ringOf(plan(s * rr(0.95, 1), 1), shaftTop, true));
      break;
    }
    case 'tapered': {
      // Continuous taper with one hard break where the taper rate changes —
      // that break is what stops a taper reading as a badly scaled box.
      const segs = 5 + Math.floor(rnd() * 3);
      const brk = 1 + Math.floor(rnd() * (segs - 1));
      const end = rr(0.56, 0.74);
      for (let k = 1; k <= segs; k++) {
        const t = k / segs;
        const yk = y + (shaftTop - y) * t;
        s = 1 - (1 - end) * Math.pow(t, k <= brk ? 1.35 : 0.85);
        if (k === brk) {
          // The taper changes rate here. Marking the ring hard is not enough —
          // the two slopes differ by a couple of degrees, so the crease would
          // buy a duplicated vertex and no visible line. Real towers put an
          // actual ledge at that break, so put one here: a 3% step is ~0.3 m of
          // shadow on a 20 m plate, which reads from the road.
          stack.push(ringOf(plan(s, t), yk, true));
          s *= 0.97;
          stack.push(ringOf(plan(s, t), yk, true));
        } else {
          stack.push(ringOf(plan(s, t), yk, false));
        }
      }
      break;
    }
    case 'twisted': {
      // Each floor plate rotated a fraction of a degree. The corners trace
      // helices, which is the whole effect, so the corners must stay hard and
      // the horizontal seams must not: this is a ruled surface, not a stack.
      // Plate count is traded against facet count to hold the triangle budget.
      const plates = Math.max(9, Math.min(18, Math.round(340 / nPlan)));
      twist = rr(0.5, 1.15) * (rnd() < 0.5 ? -1 : 1); // 29-66 degrees over the shaft
      const end = rr(0.72, 0.9);
      for (let k = 1; k <= plates; k++) {
        const t = k / plates;
        const yk = y + (shaftTop - y) * t;
        const sc = 1 - (1 - end) * t;
        stack.push(ringOf(rotateSec(plan(sc, t), twist * t), yk, false));
      }
      s = end;
      break;
    }
    case 'curved': {
      // The plan's bow already varies with t; the shaft only has to sample it.
      // One hard ring at the belly, where the bow peaks, gives the flank a
      // shadow line so the curvature reads as curvature and not as a gradient.
      const segs = 6 + Math.floor(rnd() * 3);
      const belly = Math.round(segs * 0.5);
      const end = rr(0.78, 0.94);
      for (let k = 1; k <= segs; k++) {
        const t = k / segs;
        const yk = y + (shaftTop - y) * t;
        s = 1 - (1 - end) * t;
        stack.push(ringOf(plan(s, t), yk, k === belly && rnd() < 0.5));
      }
      break;
    }
    case 'blade':
    case 'slab': {
      // Long low plates. The mass is broad, so it needs to shed something on
      // the way up or it is just a wall: a shallow setback plus a taper break.
      const yk = y + (shaftTop - y) * rr(0.35, 0.55);
      stack.push(ringOf(plan(s, tOf(yk)), yk, true));
      s *= rr(0.88, 0.95);
      stack.push(ringOf(plan(s, tOf(yk)), yk + 0.7, true));
      if (rnd() < 0.55) {
        const y2 = y + (shaftTop - y) * rr(0.65, 0.82);
        stack.push(ringOf(plan(s, tOf(y2)), y2, true));
        s *= rr(0.9, 0.97);
        stack.push(ringOf(plan(s, tOf(y2)), y2 + 0.6, true));
      }
      stack.push(ringOf(plan(s * rr(0.96, 1), 0.9), y + (shaftTop - y) * 0.92, false));
      stack.push(ringOf(plan(s * rr(0.94, 1), 1), shaftTop, true));
      break;
    }
    default: {
      // chamfered / crowned / podium-tower / stepped-cap: an articulated shaft
      // with one or two setbacks and a mild taper. The character is in the
      // crown, but a dead-straight shaft under it still reads as an extrusion.
      const setbacks = 1 + (rnd() < 0.6 ? 1 : 0);
      for (let k = 1; k <= setbacks; k++) {
        const yk = y + (shaftTop - y) * (k / (setbacks + 1)) * rr(0.85, 1.1);
        stack.push(ringOf(plan(s, tOf(yk)), yk, true));
        s *= rr(0.87, 0.95);
        stack.push(ringOf(plan(s, tOf(yk)), yk + 0.6, true));
      }
      stack.push(ringOf(plan(s * rr(0.96, 1.0), 0.7), y + (shaftTop - y) * 0.74, false));
      s *= rr(0.9, 0.97);
      stack.push(ringOf(plan(s, 1), shaftTop, true));
      break;
    }
  }

  // --- crown ---------------------------------------------------------------
  const dirX = rnd() < 0.5 ? 1 : -1;
  let crown: CrownOut;
  switch (arch) {
    case 'stepped-cap':
      crown = crownStepped(stack, plan, s, shaftTop, crownH, 3 + Math.floor(rnd() * 2));
      parts.push(needle(crown.top - 1, crownH * rr(0.5, 0.9), Math.max(hw * 0.1, 1.0), 0.24, 3, 5));
      break;
    case 'crowned':
      crown = crownLantern(stack, plan, s, shaftTop, crownH);
      parts.push(needle(crown.top - 1, crownH * rr(0.7, 1.2), Math.max(hw * 0.08, 0.9), 0.22, 3, 5));
      em.push(bandOf(plan(s * 0.7, 1), shaftTop + crownH * 0.16, crownH * 0.3, 0.45));
      break;
    case 'curved':
    case 'tapered':
      crown = rnd() < 0.62
        ? crownSwoop(stack, plan, s, shaftTop, crownH, 4 + Math.floor(rnd() * 2), hw * rr(-0.3, 0.3))
        : crownSlice(stack, plan, s, shaftTop, crownH, dirX, rr(-0.4, 0.4), true);
      break;
    case 'chamfered':
      crown = crownSlice(stack, plan, s, shaftTop, crownH, dirX, rr(-0.5, 0.5), true);
      break;
    case 'blade': {
      crown = crownSlice(stack, plan, s, shaftTop, crownH, dirX, 0, true);
      // Fins running past the roofline. Two or three thin blades projecting
      // above a sliced top is a whole silhouette for 24-36 triangles.
      const fins = 2 + Math.floor(rnd() * 2);
      const fh = crownH * rr(1.1, 2.0);
      for (let i = 0; i < fins; i++) {
        const fx = (i / Math.max(fins - 1, 1) - 0.5) * hw * s * 1.5;
        parts.push(boxAt(0.9, fh, hd * s * 2.1, fx, shaftTop + crownH * 0.15, 0));
      }
      break;
    }
    case 'setback':
      crown = rnd() < 0.5
        ? crownStepped(stack, plan, s, shaftTop, crownH, 3)
        : crownParapet(stack, plan, s, shaftTop, crownH * 0.45);
      break;
    case 'slab':
      crown = crownParapet(stack, plan, s, shaftTop, crownH * rr(0.3, 0.55));
      break;
    case 'twisted':
      crown = rnd() < 0.5
        ? crownParapet(stack, plan, s, shaftTop, crownH * 0.4)
        : crownPyramid(stack, plan, s, shaftTop, crownH);
      break;
    default:
      crown = rnd() < 0.45
        ? crownPyramid(stack, plan, s, shaftTop, crownH)
        : crownParapet(stack, plan, s, shaftTop, crownH * rr(0.3, 0.6));
      break;
  }

  parts.unshift(loftStack(stack, colHard, true));

  // --- roof plant ----------------------------------------------------------
  if (crown.flat) {
    rooftopPlant(rotateSec(plan(crown.scale, 1), twist), crown.top, rnd, parts);
  } else if (rnd() < 0.4) {
    // Even a sloped or stepped cap usually carries a mast.
    parts.push(needle(crown.top - 0.5, 5 + rnd() * 12, 0.45, 0.13, 2, 4));
  }

  // --- emissive ------------------------------------------------------------
  // A lit crown band and, on anything tall enough to matter, an obstruction
  // beacon. These read from the road long after the window grid has dissolved.
  const bandSec = rotateSec(plan(s, 1), twist);
  em.push(bandOf(bandSec, shaftTop - crownH * 0.3, Math.max(crownH * 0.18, 1.4), 0.45));
  if (H > 90) {
    const br = Math.max(hw * 0.05, 0.55);
    em.push(boxAt(br * 2, br * 2.6, br * 2, 0, crown.top + 0.2, 0));
  }

  // --- assemble ------------------------------------------------------------
  const geometry = mergeParts(parts);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox ?? new THREE.Box3();

  return {
    geometry,
    emissive: em.length ? mergeParts(em) : undefined,
    height: bb.max.y,
    footprint: new THREE.Vector2(bb.max.x - bb.min.x, bb.max.z - bb.min.z),
    archetype: arch,
    triangles: geometry.getAttribute('position').count / 3,
  };
}

/**
 * Pre-build a set of distinct towers for instancing.
 *
 * Silhouette variety is the whole job: twenty distinct meshes instanced ten
 * times each reads vastly better than one mesh instanced two hundred times, and
 * costs the same per frame. The set cycles the archetypes so every silhouette
 * is present, and walks the height band so the set spans low-rise to supertall
 * instead of clustering wherever the PRNG happened to land.
 */
export function buildTowerSet(count: number, opts: { minHeight?: number; maxHeight?: number } = {}): TowerBuild[] {
  const n = Math.max(1, Math.floor(count));
  const minH = opts.minHeight ?? 30;
  const maxH = opts.maxHeight ?? 250;
  const out: TowerBuild[] = [];
  for (let i = 0; i < n; i++) {
    const arch = TOWER_ARCHETYPES[i % TOWER_ARCHETYPES.length];
    // Sweep the band across the set, so the corridor gets its full range of
    // heights however many meshes are asked for.
    const lo = minH + (maxH - minH) * (i / n) * 0.55;
    const hi = minH + (maxH - minH) * (0.42 + 0.58 * ((i + 1) / n));
    out.push(buildTower(0x5ea1 + i * 0x9e37, { minHeight: lo, maxHeight: Math.max(hi, lo + 12), archetype: arch }));
  }
  return out;
}
