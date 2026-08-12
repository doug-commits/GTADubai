import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * ============================================================================
 *  LANDMARKS — the silhouettes that make the corridor read as Dubai
 * ============================================================================
 *
 *  >>> SOURCING — READ THIS <<<
 *
 *  Every shape in this file is ORIGINAL low-poly geometry, lofted in code from
 *  published dimensions (heights, floor counts, plan types) and general
 *  architectural knowledge of these buildings. Nothing here is traced, sampled
 *  or derived from Google Maps, Street View, Earth, or any other imagery — no
 *  imagery of any kind was consulted. The numbers in the comments are public
 *  facts about the buildings themselves; the massing is our interpretation of
 *  them.
 *
 *  ---------------------------------------------------------------------------
 *  WHY THESE SHAPES
 *  ---------------------------------------------------------------------------
 *  A generic box skyline could be any city. Dubai is legible from three or four
 *  silhouettes: the Burj's spiralling Y, the Museum's ring, the sliced
 *  triangular crowns of Emirates Towers, and the art-deco twins at Media City.
 *  Each builder below reproduces the ONE feature that makes its building
 *  identifiable at 200 km/h, and spends its triangles on nothing else.
 *
 *  ---------------------------------------------------------------------------
 *  CONVENTIONS
 *  ---------------------------------------------------------------------------
 *  • Metres throughout. +Y up. Origin at ground centre of the landmark.
 *  • Geometry is non-indexed with position / normal / uv, merged to ONE
 *    BufferGeometry per landmark so each is a single draw call.
 *  • Normals come from `computeVertexNormals()`. It runs per sub-part before
 *    merging: faceted parts compute it non-indexed so tower corners stay crisp,
 *    curved parts (Museum ring, sail, domes) compute it on an indexed
 *    intermediate so curvature reads as curvature rather than as facets.
 *  • UVs, default ("metres") mode: u = distance around the facade in metres,
 *    v = height above ground in metres. A window-grid shader can use them
 *    directly at a constant real-world pitch. Curved skins that want a wrapped
 *    pattern (Museum) use unit mode instead and say so at the call site.
 *
 *  ---------------------------------------------------------------------------
 *  TRIANGLE BUDGET (opaque geometry; `emissive` is reported separately)
 *  ---------------------------------------------------------------------------
 *  Burj Khalifa <= 3000 · Museum of the Future <= 1500 · other named <= 900 ·
 *  generic-tower <= 350. The whole scene targets ~86k triangles on a phone.
 * ============================================================================
 */

export type LandmarkId =
  | 'burj-khalifa' | 'museum-of-the-future' | 'emirates-towers'
  | 'al-kazim-towers' | 'almas-tower' | 'burj-al-arab'
  | 'difc-gate' | 'address-tower' | 'al-yaqoub' | 'rose-rayhaan' | 'generic-tower';

export interface LandmarkMesh {
  /** Merged opaque geometry, origin at ground centre, +Y up. */
  geometry: THREE.BufferGeometry;
  /** Optional separate emissive geometry (crown lights, signage bands). */
  emissive?: THREE.BufferGeometry;
  /** Overall height in metres. */
  height: number;
}

// ===========================================================================
// Geometry kit — profile curves in, lofted surfaces out.
// ===========================================================================

/** A point on a horizontal plan section (metres, in the XZ plane). */
interface P2 { x: number; z: number }
/** A point in space. */
interface V3 { x: number; y: number; z: number }
/**
 * One closed cross-section placed in space. Vertices must be ordered by
 * increasing angle about the section's own centre — every section builder here
 * does that, which keeps the loft winding outward-facing and lets caps fan from
 * the centroid.
 */
type Ring = V3[];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

// --- plan sections ---------------------------------------------------------

function ellipseSection(segments: number, rx: number, rz: number, rot = 0): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * TAU;
    const x = Math.cos(a) * rx;
    const z = Math.sin(a) * rz;
    out.push({ x: x * Math.cos(rot) - z * Math.sin(rot), z: x * Math.sin(rot) + z * Math.cos(rot) });
  }
  return out;
}

/**
 * Rounded rectangle. `cornerSegs = 1` gives a chamfered box, which is what most
 * Dubai commercial towers actually are in plan; higher values give the softer
 * rounded-corner plates used by the hotel towers.
 */
function roundedRectSection(halfW: number, halfD: number, r: number, cornerSegs: number): P2[] {
  const rr = Math.min(r, halfW * 0.98, halfD * 0.98);
  const cx = halfW - rr;
  const cz = halfD - rr;
  const centres: P2[] = [{ x: cx, z: cz }, { x: -cx, z: cz }, { x: -cx, z: -cz }, { x: cx, z: -cz }];
  const out: P2[] = [];
  for (let c = 0; c < 4; c++) {
    const centre = centres[c];
    const a0 = c * (Math.PI / 2);
    for (let i = 0; i <= cornerSegs; i++) {
      const a = a0 + (i / cornerSegs) * (Math.PI / 2);
      out.push({ x: centre.x + Math.cos(a) * rr, z: centre.z + Math.sin(a) * rr });
    }
  }
  return out;
}

/**
 * Equilateral triangle with rounded corners — the Emirates Towers floor plate.
 * Built as the Minkowski sum of a triangle and a disc, so the flanks stay
 * straight and only the corners curve, which is the real profile.
 */
function roundedTriSection(centreR: number, cornerR: number, cornerSegs: number, rot: number): P2[] {
  const out: P2[] = [];
  for (let c = 0; c < 3; c++) {
    const ca = rot + (c / 3) * TAU;
    const cx = Math.cos(ca) * centreR;
    const cz = Math.sin(ca) * centreR;
    for (let i = 0; i <= cornerSegs; i++) {
      const a = ca - Math.PI / 3 + (i / cornerSegs) * ((2 * Math.PI) / 3);
      out.push({ x: cx + Math.cos(a) * cornerR, z: cz + Math.sin(a) * cornerR });
    }
  }
  return out;
}

/**
 * Marquise/lens plan — two circular arcs meeting at points. Almas Tower is
 * named for a diamond and is cut like one in plan; this is that shape.
 */
function lensSection(halfLen: number, halfWid: number, arcSegs: number, rot: number): P2[] {
  // Circle through (+-halfLen, 0) and (0, +-halfWid).
  const R = (halfLen * halfLen + halfWid * halfWid) / (2 * halfWid);
  const d = R - halfWid; // arc centre offset from the origin
  const phi = Math.atan2(d, halfLen); // angle at which the arc reaches the tip
  const out: P2[] = [];
  for (let s = 0; s < 2; s++) {
    const sign = s === 0 ? 1 : -1;
    for (let i = 0; i <= arcSegs; i++) {
      const a = phi + (i / arcSegs) * (Math.PI - 2 * phi);
      const x = Math.cos(a) * R * sign;
      const z = (Math.sin(a) * R - d) * sign;
      out.push({ x: x * Math.cos(rot) - z * Math.sin(rot), z: x * Math.sin(rot) + z * Math.cos(rot) });
    }
  }
  return out;
}

// --- section transforms ----------------------------------------------------

function scaleSection(s: P2[], sx: number, sz = sx): P2[] {
  return s.map((p) => ({ x: p.x * sx, z: p.z * sz }));
}

function rotateSection(s: P2[], ang: number): P2[] {
  const c = Math.cos(ang);
  const n = Math.sin(ang);
  return s.map((p) => ({ x: p.x * c - p.z * n, z: p.x * n + p.z * c }));
}

/** Push every vertex radially outward — used for proud emissive bands. */
function expandSection(s: P2[], d: number): P2[] {
  return s.map((p) => {
    const len = Math.hypot(p.x, p.z) || 1;
    return { x: p.x * (1 + d / len), z: p.z * (1 + d / len) };
  });
}

function ringAt(s: P2[], y: number): Ring {
  return s.map((p) => ({ x: p.x, y, z: p.z }));
}

/**
 * A section sliced by a tilted plane: vertex height varies linearly with the
 * dot product against a horizontal direction. This is how the Emirates Towers
 * crowns are cut — a clean diagonal slice through a triangular prism.
 */
function slicedRing(s: P2[], yMid: number, slope: number, dirX: number, dirZ: number): Ring {
  return s.map((p) => ({ x: p.x, y: yMid + slope * (p.x * dirX + p.z * dirZ), z: p.z }));
}

// --- lofting ---------------------------------------------------------------

interface LoftOpts {
  capTop?: boolean;
  capBottom?: boolean;
  /** Close the loft back onto ring 0 — used by the Museum's torus. */
  closed?: boolean;
  /** Smooth normals across the surface instead of hard facets. */
  smooth?: boolean;
  /** UVs normalised 0..1 over the whole surface instead of metres. */
  unitUV?: boolean;
  /** Swap u and v (so a wrapped pattern runs along the loft, not the section). */
  swapUV?: boolean;
}

/**
 * Loft a stack of cross-sections into a surface.
 *
 * Winding: sections are ordered by increasing angle and the loft advances along
 * the ring array, so (A_j, B_j, B_j+1) / (A_j, B_j+1, A_j+1) faces outward.
 * Two rings at the same height with different radii produce a flat annulus —
 * that is how every setback ledge in this file is made.
 */
function loft(ringsIn: Ring[], o: LoftOpts = {}): THREE.BufferGeometry {
  const rings = o.closed ? [...ringsIn, ringsIn[0]] : ringsIn;
  const R = rings.length;
  const N = rings[0].length;

  // u along the section: metres around the perimeter, or 0..1.
  const us: number[][] = [];
  for (let i = 0; i < R; i++) {
    const ring = rings[i];
    const row: number[] = [0];
    let acc = 0;
    for (let j = 1; j <= N; j++) {
      const a = ring[j - 1];
      const b = ring[j % N];
      acc += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      row.push(acc);
    }
    us.push(o.unitUV ? row.map((_, j) => j / N) : row);
  }
  const vOf = (i: number, p: V3): number => (o.unitUV ? i / (R - 1) : p.y);

  const parts: THREE.BufferGeometry[] = [];

  if (o.smooth) {
    // Indexed grid with a duplicated seam column: computeVertexNormals then
    // averages across shared edges, giving a genuinely curved surface.
    const pos: number[] = [];
    const uv: number[] = [];
    for (let i = 0; i < R; i++) {
      for (let j = 0; j <= N; j++) {
        const p = rings[i][j % N];
        pos.push(p.x, p.y, p.z);
        const u = us[i][j];
        const v = vOf(i, p);
        uv.push(o.swapUV ? v : u, o.swapUV ? u : v);
      }
    }
    const idx: number[] = [];
    const stride = N + 1;
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < N; j++) {
        const a = i * stride + j;
        const b = (i + 1) * stride + j;
        idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
  } else {
    const pos: number[] = [];
    const uv: number[] = [];
    const push = (i: number, j: number): void => {
      const p = rings[i][j % N];
      pos.push(p.x, p.y, p.z);
      const u = us[i][j];
      const v = vOf(i, p);
      uv.push(o.swapUV ? v : u, o.swapUV ? u : v);
    };
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < N; j++) {
        push(i, j); push(i + 1, j); push(i + 1, j + 1);
        push(i, j); push(i + 1, j + 1); push(i, j + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    parts.push(g);
  }

  if (o.capTop) parts.push(capRing(rings[R - 1], true, o.unitUV === true));
  if (o.capBottom) parts.push(capRing(rings[0], false, o.unitUV === true));
  return parts.length === 1 ? parts[0] : mergeAll(parts);
}

/** Centroid fan cap. Valid for every section here — all are star-shaped. */
function capRing(ring: Ring, up: boolean, unitUV: boolean): THREE.BufferGeometry {
  const N = ring.length;
  const c: V3 = { x: 0, y: 0, z: 0 };
  for (const p of ring) { c.x += p.x / N; c.y += p.y / N; c.z += p.z / N; }
  const pos: number[] = [];
  const uv: number[] = [];
  const ext = Math.max(...ring.map((p) => Math.hypot(p.x, p.z))) * 2 || 1;
  const push = (p: V3): void => {
    pos.push(p.x, p.y, p.z);
    uv.push(unitUV ? p.x / ext + 0.5 : p.x, unitUV ? p.z / ext + 0.5 : p.z);
  };
  for (let j = 0; j < N; j++) {
    const a = ring[j];
    const b = ring[(j + 1) % N];
    push(c);
    if (up) { push(b); push(a); } else { push(a); push(b); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Normalise a geometry so it can be merged: non-indexed, position/normal/uv. */
function prep(gIn: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = gIn.index ? gIn.toNonIndexed() : gIn;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) {
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  return g;
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts.map(prep), false);
}

function place(g: THREE.BufferGeometry, dx: number, dy: number, dz: number, rotY = 0): THREE.BufferGeometry {
  if (rotY !== 0) g.rotateY(rotY);
  g.translate(dx, dy, dz);
  return g;
}

/** A thin proud band around a section — crown lights and signage. */
function bandAt(s: P2[], y: number, h: number, out: number): THREE.BufferGeometry {
  const e = expandSection(s, out);
  return loft([ringAt(e, y), ringAt(e, y + h)]);
}

/** Simple box, centred on x/z, sitting with its base at `y`. */
function boxAt(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  return place(g, x, y + h / 2, z, rotY);
}

/** Solid of revolution from a [radius, height] profile. */
function latheProfile(profile: Array<[number, number]>, segments: number, sx = 1, sz = 1): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y));
  const g = new THREE.LatheGeometry(pts, segments);
  g.scale(sx, 1, sz);
  return g;
}

/** Slender tapered needle — aerials, masts, spires. */
function needle(yBase: number, height: number, rBase: number, rTop: number, segs: number, sides = 6): THREE.BufferGeometry {
  const rings: Ring[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Concave taper: spires thin out fast at the bottom and hold a fine point.
    const r = rBase + (rTop - rBase) * Math.pow(t, 0.72);
    rings.push(ringAt(ellipseSection(sides, r, r), yBase + height * t));
  }
  return loft(rings, { capTop: true });
}

// ===========================================================================
// 1. BURJ KHALIFA — 828 m
// ===========================================================================
/**
 * The identifier. Everything about this silhouette comes from two facts:
 *
 *  • The plan is a Y — a "buttressed core": a hexagonal central core with three
 *    wings off it at 120°, each wing a corridor with a rounded end. It is NOT a
 *    square setback stack, and a square stack is the single fastest way to make
 *    a Dubai skyline look fake.
 *  • It has 27 setbacks, and each one steps back ONE wing at a time. Because
 *    the wings take their turns in sequence, the tower appears to spiral as it
 *    rises and the mass sheds into the core. That spiral is the silhouette.
 *
 * Above ~632 m the wings are gone and only the spire continues, so the top
 * ~196 m of the 828 m is needle alone.
 */
function buildBurjKhalifa(): LandmarkMesh {
  const H = 828;
  const BODY_TOP = 632;
  const SETBACKS = 27;
  const NOSE_SEGS = 4; // facets across each wing's rounded end

  // Base dimensions chosen to land on the published footprint: wings reaching
  // ~80 m from the centre give a ~139 m span across two wing tips and roughly
  // 7.5k m2 of plate, which is the tower as built.
  const coreAt = (y: number): number => 23 - 9 * (y / BODY_TOP); // hex core, mild taper
  const wingHalfAt = (y: number): number => 15 - 6.5 * (y / BODY_TOP);

  /** One Y-plan section: three wings with rounded noses off a hexagonal core. */
  const section = (reach: number[], y: number): P2[] => {
    const core = coreAt(y);
    const hw = wingHalfAt(y);
    const pts: P2[] = [];
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 2 + (i * TAU) / 3;
      const ux = Math.cos(a);
      const uz = Math.sin(a);
      const vx = -Math.sin(a);
      const vz = Math.cos(a);
      const r = Math.max(reach[i], core * 0.8 + hw);
      const noseC = r - hw;
      const base = core * 0.55;
      const push = (u: number, v: number): void => {
        pts.push({ x: ux * u + vx * v, z: uz * u + vz * v });
      };
      push(base, -hw); // flank root
      for (let k = 0; k <= NOSE_SEGS; k++) {
        const phi = -Math.PI / 2 + (Math.PI * k) / NOSE_SEGS;
        push(noseC + hw * Math.cos(phi), hw * Math.sin(phi)); // rounded wing end
      }
      push(base, hw);
      // Concave notch where two wings meet — the flat of the hexagonal core.
      const an = a + Math.PI / 3;
      pts.push({ x: Math.cos(an) * core * 0.72, z: Math.sin(an) * core * 0.72 });
    }
    return pts;
  };

  const reach = [80, 80, 80]; // wing tip radius at grade
  const rings: Ring[] = [ringAt(section(reach, 0), 0)];

  for (let k = 0; k < SETBACKS; k++) {
    // Setbacks crowd together toward the top, as they do on the real tower.
    const y = 78 + (BODY_TOP - 104) * Math.pow(k / (SETBACKS - 1), 0.95);
    rings.push(ringAt(section(reach, y), y));
    // ONE wing steps in — nine turns each, so the mass sheds in a spiral and
    // the wings have all but merged into the core by the time the spire starts.
    reach[k % 3] *= 0.86;
    rings.push(ringAt(section(reach, y + 0.6), y + 0.6)); // ledge + shaft above
  }
  rings.push(ringAt(section(reach, BODY_TOP), BODY_TOP));

  const body = loft(rings, { capTop: true });
  // Spire: a single slender pinnacle continuing the core, no wings.
  const spire = needle(BODY_TOP - 2, H - BODY_TOP + 2, 9, 0.4, 4, 6);

  // Emissive: the vertical LED spine on the spire plus the topmost setback
  // bands, which is what actually reads from the road at dusk.
  const em: THREE.BufferGeometry[] = [
    bandAt(section(reach, 560), 560, 5, 0.4),
    bandAt(section(reach, 600), 600, 4, 0.4),
    place(new THREE.OctahedronGeometry(3.2), 0, H - 6, 0),
  ];

  return { geometry: mergeAll([body, spire]), emissive: mergeAll(em), height: H };
}

// ===========================================================================
// 2. MUSEUM OF THE FUTURE — 77 m
// ===========================================================================
/**
 * Sits right on the edge of Sheikh Zayed Road, so the player passes within
 * metres of it. Three things make it: it is a torus — an oblong ring standing
 * on its edge; there is a hollow elliptical VOID straight through the middle;
 * and it stands on a landscaped green mound rather than on a plaza.
 *
 * The steel skin is covered in Arabic calligraphy cut through as windows. That
 * is a shader job, so the ring is lofted with clean unit UVs: after the swap,
 * u runs once around the ring (0..1, wrapping) and v runs across the section
 * with v = 0 at the outer face and v = 0.5 at the void face. A calligraphy
 * pattern can be laid straight into that.
 */
function buildMuseumOfTheFuture(): LandmarkMesh {
  const H = 77;
  const MOUND_H = 8;
  const MAJOR = 36; // facets around the ring
  const TUBE = 12; // facets across the section

  // Ring: outer envelope ~78 m wide x 69 m tall, void ~30 m x 21 m, 30 m deep.
  const Rx = 27;
  const Ry = 22.5;
  const tIn = 12; // section half-thickness in the plane of the ring
  const tDepth = 15; // half-depth, i.e. the building is ~30 m thick
  const centreY = H - (Ry + tIn); // ring's underside lands on the mound top
  const TILT = THREE.MathUtils.degToRad(6); // the real ring is not level

  const rings: Ring[] = [];
  for (let i = 0; i < MAJOR; i++) {
    const u = (i / MAJOR) * TAU;
    // Point on the oblong major path, in the XY plane (void axis = Z).
    const px = Math.cos(u) * Rx;
    const py = Math.sin(u) * Ry;
    // True outward normal of an ellipse, so the section stays perpendicular.
    let nx = Math.cos(u) * Ry;
    let ny = Math.sin(u) * Rx;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const ring: Ring = [];
    for (let j = 0; j < TUBE; j++) {
      const v = (j / TUBE) * TAU; // v = 0 -> outer face, v = PI -> the void
      const ro = Math.cos(v) * tIn;
      const zo = Math.sin(v) * tDepth;
      const x = px + nx * ro;
      const y = py + ny * ro;
      ring.push({
        x: x * Math.cos(TILT) - y * Math.sin(TILT),
        y: centreY + x * Math.sin(TILT) + y * Math.cos(TILT),
        z: zo,
      });
    }
    rings.push(ring);
  }
  const ringGeo = loft(rings, { closed: true, smooth: true, unitUV: true, swapUV: true });

  // Green mound: 112 x 80 m, 8 m high. The building famously grows out of it.
  const mound = latheProfile([[56, 0], [50, 3.0], [34, 6.2], [0, MOUND_H]], 18, 1, 0.72);

  // Emissive: the lip of the void is lit from within, which is what makes the
  // hole read as a hole at dusk rather than as a dark patch.
  const lip: Ring[] = [];
  for (const d of [-0.16, 0.16]) {
    const r: Ring = [];
    for (let i = 0; i < MAJOR; i++) {
      const u = (i / MAJOR) * TAU;
      const px = Math.cos(u) * Rx;
      const py = Math.sin(u) * Ry;
      let nx = Math.cos(u) * Ry;
      let ny = Math.sin(u) * Rx;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      const v = Math.PI + d;
      const ro = Math.cos(v) * (tIn - 0.5);
      const zo = Math.sin(v) * tDepth;
      const x = px + nx * ro;
      const y = py + ny * ro;
      r.push({
        x: x * Math.cos(TILT) - y * Math.sin(TILT),
        y: centreY + x * Math.sin(TILT) + y * Math.cos(TILT),
        z: zo,
      });
    }
    lip.push(r);
  }

  return {
    geometry: mergeAll([ringGeo, mound]),
    emissive: loft(lip, { closed: false, unitUV: true }),
    height: H,
  };
}

// ===========================================================================
// 3. EMIRATES TOWERS — 354.6 m office / 309 m hotel
// ===========================================================================
/**
 * Two things identify these: the floor plates are TRIANGLES with rounded
 * corners, and the crowns are cut off by a steep diagonal slice so each tower
 * ends in a blade rather than a flat roof. The slices mirror each other, which
 * is what makes the pair read as a gateway. They share a low podium (the
 * Boulevard retail level) at their feet.
 */
function buildEmiratesTowers(): LandmarkMesh {
  const build = (H: number, reach: number, sliceDir: number): THREE.BufferGeometry => {
    const CORNER = reach * 0.3;
    // Rotate the plate so one corner faces the way the crown is sliced: the
    // blade then rises over a corner, which is what the real crowns do.
    const rot = sliceDir > 0 ? 0 : Math.PI;
    const sec = (s: number): P2[] => roundedTriSection((reach - CORNER) * s, CORNER * s, 4, rot);

    const TOP_S = 0.86; // the shaft tapers slightly on the way up
    const rTop = reach * TOP_S;
    const slope = 1.15; // steep — the crowns are dramatic, not chamfers
    const yMid = H - slope * rTop; // slice plane on the tower axis
    const bodyTop = H - 2 * slope * rTop; // where the slice starts

    const rings: Ring[] = [
      ringAt(sec(1), 0),
      ringAt(sec(1), 14), ringAt(sec(0.99), 14), // podium-level setback
      ringAt(sec(0.96), 120),
      ringAt(sec(0.91), 220),
      ringAt(sec(TOP_S), bodyTop),
    ];
    const body = loft(rings, {});
    const crownRing = slicedRing(sec(TOP_S), yMid, slope, sliceDir, 0);
    const crown = loft([rings[rings.length - 1], crownRing], { capTop: true });
    return mergeAll([body, crown]);
  };

  const office = place(build(354.6, 30, 1), -52, 0, 0);
  const hotel = place(build(309, 26, -1), 52, 0, 8);
  // Shared podium — the towers sit on one continuous base, not on bare ground.
  const podium = boxAt(190, 13, 74, 0, 0, 4);

  // Beacons sit on the blade tips, which is where the aircraft warning lights
  // go and where the eye lands on the pair at dusk.
  const em = mergeAll([
    place(new THREE.OctahedronGeometry(2.6), -52 + 30 * 0.86, 353, 0),
    place(new THREE.OctahedronGeometry(2.4), 52 - 26 * 0.86, 307.5, 8),
    boxAt(178, 1.6, 2, 0, 11.6, -33), // podium retail band
  ]);

  return { geometry: mergeAll([office, hotel, podium]), emissive: em, height: 354.6 };
}

// ===========================================================================
// 4. AL KAZIM TOWERS — twin 265 m
// ===========================================================================
/**
 * The Media City twins. Their whole identity is the crown: a stepped art-deco
 * tiered cap in the Chrysler Building idiom, tier over tier over tier with a
 * needle on top, lit gold at night. Everything below it is a plain shaft, so
 * the tiers get all the triangles.
 */
function buildAlKazimTowers(): LandmarkMesh {
  const H = 265;
  const CROWN_H = 62;
  const bodyTop = H - CROWN_H - 18;

  const build = (): { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry } => {
    const plan = (s: number): P2[] => roundedRectSection(17 * s, 15 * s, 5 * s, 2);
    const rings: Ring[] = [
      ringAt(plan(1), 0),
      ringAt(plan(1), 96), ringAt(plan(0.94), 96), // setback
      ringAt(plan(0.94), 168), ringAt(plan(0.88), 168), // setback
      ringAt(plan(0.88), bodyTop),
    ];
    const body = loft(rings, {});

    // Crown: six tiers whose radii follow a quarter circle, each a vertical
    // face plus a flat ledge. That step-and-ledge rhythm is the art-deco tell.
    const TIERS = 6;
    const crownPlan = (s: number): P2[] => roundedRectSection(15.5 * s, 13.5 * s, 4.4 * s, 1);
    const crown: Ring[] = [];
    const bands: THREE.BufferGeometry[] = [];
    for (let k = 0; k < TIERS; k++) {
      const r0 = Math.cos((k / TIERS) * (Math.PI / 2)) * 0.95 + 0.05;
      const y0 = bodyTop + (k / TIERS) * CROWN_H;
      const y1 = bodyTop + ((k + 1) / TIERS) * CROWN_H;
      crown.push(ringAt(crownPlan(r0), y0));
      crown.push(ringAt(crownPlan(r0), y1));
      bands.push(bandAt(crownPlan(r0), y0 + 1.5, (y1 - y0) * 0.5, 0.35));
    }
    const cap = loft(crown, { capTop: true });
    const spire = needle(bodyTop + CROWN_H - 1, 19, 2.4, 0.3, 3, 6);
    return { solid: mergeAll([body, cap, spire]), glow: mergeAll(bands) };
  };

  const a = build();
  const b = build();
  const podium = boxAt(150, 11, 60, 0, 0, 0);

  return {
    geometry: mergeAll([place(a.solid, -46, 0, 0), place(b.solid, 46, 0, 0), podium]),
    emissive: mergeAll([place(a.glow, -46, 0, 0), place(b.glow, 46, 0, 0)]),
    height: H,
  };
}

// ===========================================================================
// 5. BURJ AL ARAB — 321 m
// ===========================================================================
/**
 * Not on Sheikh Zayed Road, but visible far off on the coast, and it costs
 * almost nothing to put a correct sail on the horizon.
 *
 * The massing is a dhow sail: the plan is a V — two wings meeting at a spine —
 * and the open side of the V is closed by a billowing membrane that bulges
 * outward. So one closed section does the whole building: an apex at the mast,
 * two straight legs, then a convex arc across the front. The bulge peaks around
 * mid-height and the section shrinks and slides back toward the mast as it
 * rises, which produces the leaning, curving sail silhouette.
 */
function buildBurjAlArab(): LandmarkMesh {
  const H = 321;
  const ARC = 7; // facets across the membrane
  const RINGS = 11;

  const section = (t: number): P2[] => {
    const s = Math.pow(1 - t, 0.55) * 0.86 + 0.14; // plan shrinks with height
    const apexZ = -58 * s;
    const tipZ = 34 * s;
    const halfW = 45 * s;
    // Membrane billow: none at the base, fullest around mid-height.
    const bulge = 26 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * s + 4 * s;
    const pts: P2[] = [{ x: 0, z: apexZ }];
    pts.push({ x: halfW * 0.55, z: apexZ * 0.1 }); // leg, mast side to tip
    pts.push({ x: halfW, z: tipZ });
    for (let i = 1; i < ARC; i++) {
      const a = i / ARC;
      pts.push({ x: halfW * (1 - 2 * a), z: tipZ + Math.sin(Math.PI * a) * bulge });
    }
    pts.push({ x: -halfW, z: tipZ });
    pts.push({ x: -halfW * 0.55, z: apexZ * 0.1 });
    return pts;
  };

  const rings: Ring[] = [];
  for (let i = 0; i < RINGS; i++) {
    const t = i / (RINGS - 1);
    // The whole tower leans back over the mast as it climbs.
    const lean = -10 * Math.pow(t, 1.6);
    rings.push(ringAt(section(t).map((p) => ({ x: p.x, z: p.z + lean })), H * t));
  }
  const hull = loft(rings, { smooth: true, capTop: true });

  // Exoskeleton mast: the curved spine up the back of the sail.
  const mastRings: Ring[] = [];
  for (let i = 0; i < RINGS; i++) {
    const t = i / (RINGS - 1);
    const s = section(t);
    const apex = s[0];
    const lean = -10 * Math.pow(t, 1.6);
    const r = 5.5 * (1 - t * 0.6);
    mastRings.push(ringAt(ellipseSection(5, r, r).map((p) => ({ x: p.x, z: p.z + apex.z + lean - r * 0.4 })), H * t));
  }
  const mast = loft(mastRings, { smooth: true, capTop: true });

  // Emissive: the membrane is floodlit after dark and is the whole reason the
  // building reads from 10 km away. A thin proud copy of the sail face.
  const face: Ring[] = rings.map((r) =>
    r.slice(2, 3 + ARC).map((p) => ({ x: p.x * 1.01, y: p.y, z: p.z + 1.2 })),
  );

  return {
    geometry: mergeAll([hull, mast]),
    emissive: loft(face, { smooth: true, unitUV: true }),
    height: H,
  };
}

// ===========================================================================
// 6. THE GATE, DIFC — ~80 m
// ===========================================================================
/**
 * An inhabited triumphal arch: two thick legs carrying a deep occupied bridge,
 * with a large portal punched through the middle and an axial plaza running
 * under it. Squat and wide where everything around it is slender, which is
 * exactly why it reads.
 *
 * Built as an extruded profile with a hole — the one landmark here whose
 * elevation IS its profile curve.
 */
function buildDifcGate(): LandmarkMesh {
  const H = 80;
  const PLINTH = 1.6; // the arch stands on a raised plaza, not on the road
  const A = H - PLINTH; // height of the arch itself
  const W = 92;
  const D = 34;
  const OPEN_W = 44;
  const OPEN_H = 34;

  // Elevation profile: splayed feet, battered legs, a corbelled cornice near
  // the top and clipped upper corners. Squat and heavy — the opposite of every
  // slender tower around it, which is why it reads at all.
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2 - 3, 0);
  shape.lineTo(W / 2 + 3, 0);
  shape.lineTo(W / 2, 7);
  shape.lineTo(W / 2, A - 13);
  shape.lineTo(W / 2 + 2.5, A - 13);
  shape.lineTo(W / 2 + 2.5, A - 6);
  shape.lineTo(W / 2 - 4, A);
  shape.lineTo(-W / 2 + 4, A);
  shape.lineTo(-W / 2 - 2.5, A - 6);
  shape.lineTo(-W / 2 - 2.5, A - 13);
  shape.lineTo(-W / 2, A - 13);
  shape.lineTo(-W / 2, 7);
  shape.closePath();

  const hole = new THREE.Path();
  const r = 5;
  hole.moveTo(-OPEN_W / 2, 0);
  hole.lineTo(-OPEN_W / 2, OPEN_H - r);
  hole.quadraticCurveTo(-OPEN_W / 2, OPEN_H, -OPEN_W / 2 + r, OPEN_H);
  hole.lineTo(OPEN_W / 2 - r, OPEN_H);
  hole.quadraticCurveTo(OPEN_W / 2, OPEN_H, OPEN_W / 2, OPEN_H - r);
  hole.lineTo(OPEN_W / 2, 0);
  hole.closePath();
  shape.holes.push(hole);

  const arch = new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: false, curveSegments: 3, steps: 1 });
  arch.translate(0, PLINTH, -D / 2);

  // Raised plaza at the head of the DIFC axis — the arch sits on top of it.
  const plinth = boxAt(W + 30, PLINTH, D + 34, 0, 0, 0);

  const em = mergeAll([
    boxAt(OPEN_W - 2, 1.2, D * 0.9, 0, PLINTH + OPEN_H - 1.6, 0), // lit arch soffit
    boxAt(W - 12, 2.2, 1.0, 0, H - 13, D / 2 + 0.3), // cornice band, road side
    boxAt(W - 12, 2.2, 1.0, 0, H - 13, -D / 2 - 0.3),
  ]);

  return { geometry: mergeAll([arch, plinth]), emissive: em, height: H };
}

// ===========================================================================
// 7. AL YAQOUB TOWER — 328 m
// ===========================================================================
/**
 * On Sheikh Zayed Road and unmistakable because it is openly modelled on the
 * Elizabeth Tower: a slender shaft, a clock stage with a face on all four
 * sides, then a steep tapered roof and a finial. The clock faces glow at dusk,
 * which is the whole trick — they go in the emissive buffer.
 */
function buildAlYaqoub(): LandmarkMesh {
  const H = 328;
  const CLOCK_Y = 258;
  const plan = (s: number): P2[] => roundedRectSection(15 * s, 13 * s, 3 * s, 1);

  const body = loft([
    ringAt(plan(1.06), 0),
    ringAt(plan(1.0), 26), ringAt(plan(0.98), 26),
    ringAt(plan(0.9), 170), ringAt(plan(0.86), 170),
    ringAt(plan(0.82), CLOCK_Y),
  ], {});

  // Clock stage: steps back OUT, the way a belfry does.
  const stage = loft([
    ringAt(plan(0.82), CLOCK_Y), ringAt(plan(0.95), CLOCK_Y),
    ringAt(plan(0.95), CLOCK_Y + 26), ringAt(plan(0.8), CLOCK_Y + 26),
  ], {});

  // Steep pyramidal roof + finial, in the Gothic-revival manner it copies.
  const roof = loft([
    ringAt(plan(0.8), CLOCK_Y + 26),
    ringAt(plan(0.52), CLOCK_Y + 38),
    ringAt(plan(0.16), H - 16),
  ], { capTop: true });
  const finial = needle(H - 17, 17, 1.8, 0.25, 3, 6);

  // Four glowing clock faces, one per elevation.
  const faces: THREE.BufferGeometry[] = [];
  const fy = CLOCK_Y + 13;
  const face = (): THREE.BufferGeometry => new THREE.CircleGeometry(5.4, 14);
  faces.push(place(face(), 0, fy, 12.7));
  faces.push(place(face(), 0, fy, -12.7, Math.PI));
  faces.push(place(face(), 14.5, fy, 0, Math.PI / 2));
  faces.push(place(face(), -14.5, fy, 0, -Math.PI / 2));

  return {
    geometry: mergeAll([body, stage, roof, finial]),
    emissive: mergeAll([...faces, bandAt(plan(0.95), CLOCK_Y + 24, 1.6, 0.3)]),
    height: H,
  };
}

// ===========================================================================
// 8. ALMAS TOWER — 360 m
// ===========================================================================
/**
 * "Almas" is Arabic for diamond and the tower is cut like one: an elongated
 * lens plan that tapers as it rises, with the two halves rotating slightly
 * against each other, finished with a tall spire. The lens plan is the tell —
 * nothing else on the skyline is pointed at both ends.
 */
function buildAlmasTower(): LandmarkMesh {
  const H = 360;
  const ROOF = 306;
  const RINGS = 7;
  const rings: Ring[] = [];
  for (let i = 0; i < RINGS; i++) {
    const t = i / (RINGS - 1);
    const s = 1 - 0.42 * Math.pow(t, 1.15);
    rings.push(ringAt(lensSection(34 * s, 19 * s, 5, t * THREE.MathUtils.degToRad(11)), ROOF * t));
  }
  const body = loft(rings, { smooth: true, capTop: true });
  const podium = loft([
    ringAt(lensSection(46, 28, 4, 0), 0),
    ringAt(lensSection(46, 28, 4, 0), 15),
    ringAt(lensSection(38, 23, 4, 0), 15),
  ], { capTop: true });
  const spire = needle(ROOF - 3, H - ROOF + 3, 4.2, 0.3, 4, 6);

  return {
    geometry: mergeAll([body, podium, spire]),
    emissive: mergeAll([
      bandAt(lensSection(34 * 0.58, 19 * 0.58, 5, THREE.MathUtils.degToRad(11)), ROOF - 12, 8, 0.3),
      place(new THREE.OctahedronGeometry(2.4), 0, H - 4, 0),
    ]),
    height: H,
  };
}

// ===========================================================================
// 9 / 10. ADDRESS-STYLE TOWER (306 m) and ROSE RAYHAAN (333 m)
// ===========================================================================
/**
 * Dubai's slender hotel towers share a family look: a narrow shaft with a
 * curved crown that sweeps rather than stops. `curvedCrown` produces that
 * swoop — the section shrinks along a cosine while the roofline rises, and an
 * optional lateral shift makes it lean the way the Address towers do.
 */
function curvedCrown(plan: (s: number) => P2[], s0: number, yStart: number, height: number, segs: number, shift: number): Ring[] {
  const out: Ring[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const s = s0 * Math.cos((t * Math.PI) / 2.15); // quarter-cosine profile
    const sec = plan(Math.max(s, 0.04)).map((p) => ({ x: p.x + shift * t * t, z: p.z }));
    out.push(ringAt(sec, yStart + height * Math.sin((t * Math.PI) / 2)));
  }
  return out;
}

function buildAddressTower(): LandmarkMesh {
  const H = 306;
  const CROWN = 54;
  const plan = (s: number): P2[] => roundedRectSection(19 * s, 15 * s, 6 * s, 2);
  const shaftTop = H - CROWN;

  const body = loft([
    ringAt(plan(1.1), 0), ringAt(plan(1.1), 22), ringAt(plan(1.0), 22),
    ringAt(plan(0.95), 140),
    ringAt(plan(0.86), shaftTop),
  ], {});
  const crown = loft(curvedCrown(plan, 0.86, shaftTop, CROWN, 4, 6), { capTop: true });
  const podium = boxAt(74, 18, 58, 0, 0, 0);

  return {
    geometry: mergeAll([body, crown, podium]),
    emissive: mergeAll([
      bandAt(plan(0.86), shaftTop - 4, 3, 0.3),
      bandAt(plan(1.0), 24, 2, 0.3),
    ]),
    height: H,
  };
}

function buildRoseRayhaan(): LandmarkMesh {
  const H = 333;
  const ROOF = 300;
  const CROWN = 46;
  // Famously slim — a 72-storey tower on a small plate right beside the road.
  const plan = (s: number): P2[] => roundedRectSection(13 * s, 12 * s, 4.5 * s, 2);
  const shaftTop = ROOF - CROWN;

  const body = loft([
    ringAt(plan(1.2), 0), ringAt(plan(1.2), 30), ringAt(plan(1.0), 30),
    ringAt(plan(0.94), 190),
    ringAt(plan(0.88), shaftTop),
  ], {});
  const crown = loft(curvedCrown(plan, 0.88, shaftTop, CROWN, 4, 0), { capTop: true });
  const mast = needle(ROOF - 4, H - ROOF + 4, 2.6, 0.3, 3, 6);

  return {
    geometry: mergeAll([body, crown, mast]),
    emissive: mergeAll([
      bandAt(plan(0.9), shaftTop - 6, 4, 0.3),
      place(new THREE.OctahedronGeometry(1.9), 0, H - 3, 0),
    ]),
    height: H,
  };
}

// ===========================================================================
// 11. GENERIC TOWER — seeded infill
// ===========================================================================
/**
 * The corridor is mostly NOT landmarks: it is a wall of 1990s-2010s commercial
 * towers. What makes that wall look like Dubai rather than like anywhere is
 * variety within a family — chamfered and rounded plates, a couple of
 * setbacks, retail podiums, and a crown that is always SOMETHING (parapet,
 * slice, steps, dome, mast) rather than a flat cut.
 *
 * Everything is drawn from `seed`, so the same seed always gives the same
 * building and neighbouring buildings never twin.
 */
function buildGenericTower(seed: number): LandmarkMesh {
  const rnd = mulberry32(seed >>> 0 || 1);
  const rr = (a: number, b: number): number => a + rnd() * (b - a);

  // Heavy tail: most of the corridor is mid-rise with a few spikes.
  const H = 42 + Math.pow(rnd(), 2.6) * 210;
  const planKind = Math.floor(rnd() * 3);
  const w = rr(11, 24);
  const d = w * rr(0.62, 1.0);
  const twist = (rnd() < 0.25 ? 1 : 0) * rr(-0.14, 0.14);

  const plan = (s: number): P2[] => {
    if (planKind === 0) return roundedRectSection(w * s, d * s, Math.min(w, d) * 0.22 * s, 1); // chamfered
    if (planKind === 1) return roundedRectSection(w * s, d * s, Math.min(w, d) * 0.5 * s, 2); // rounded
    return ellipseSection(12, w * s, d * s); // lens/oval plate
  };

  const setbacks = Math.floor(rnd() * 3);
  const crownH = H * rr(0.05, 0.13);
  const shaftTop = H - crownH;

  const rings: Ring[] = [ringAt(plan(1), 0)];
  let s = 1;
  for (let i = 0; i < setbacks; i++) {
    const y = (shaftTop * (i + 1)) / (setbacks + 1.35);
    rings.push(ringAt(rotateSection(plan(s), twist * (y / H)), y));
    s *= rr(0.82, 0.93);
    rings.push(ringAt(rotateSection(plan(s), twist * (y / H)), y + 0.5));
  }
  rings.push(ringAt(rotateSection(plan(s * rr(0.93, 1.0)), twist), shaftTop));
  const body = loft(rings, {});

  const parts: THREE.BufferGeometry[] = [body];
  const em: THREE.BufferGeometry[] = [];
  const crownKind = Math.floor(rnd() * 5);
  const top = rings[rings.length - 1];
  const topS = s * 0.96;

  if (crownKind === 0) {
    // Parapet: a thin upstand ring around a flat roof.
    parts.push(loft([top, ringAt(expandSection(plan(topS), 0.8), shaftTop + crownH * 0.35)], { capTop: true }));
  } else if (crownKind === 1) {
    // Diagonal slice.
    const dir = rnd() < 0.5 ? 1 : -1;
    const slope = crownH / (w * 2);
    parts.push(loft([top, slicedRing(plan(topS), shaftTop + crownH * 0.5, slope, dir, 0)], { capTop: true }));
  } else if (crownKind === 2) {
    // Stepped cap.
    const st: Ring[] = [top];
    for (let k = 1; k <= 3; k++) {
      const y = shaftTop + (crownH * k) / 3;
      st.push(ringAt(plan(topS * (1 - k * 0.16)), y - crownH / 3));
      st.push(ringAt(plan(topS * (1 - k * 0.16)), y));
    }
    parts.push(loft(st, { capTop: true }));
  } else if (crownKind === 3) {
    // Curved dome cap — the hotel-tower idiom.
    parts.push(loft(curvedCrown(plan, topS, shaftTop, crownH, 3, 0), { capTop: true }));
  } else {
    parts.push(loft([top, ringAt(plan(topS), shaftTop + crownH * 0.5)], { capTop: true }));
    parts.push(needle(shaftTop + crownH * 0.5, crownH * 1.6, 1.2, 0.2, 2, 5));
  }

  if (rnd() < 0.55) parts.push(boxAt(w * rr(2.2, 3.4), rr(7, 16), d * rr(2.2, 3.4), 0, 0, 0));
  em.push(bandAt(plan(topS), shaftTop - crownH * 0.25, crownH * 0.2, 0.25));
  if (rnd() < 0.4) em.push(bandAt(plan(1), H * 0.16, 2.4, 0.25)); // signage band

  return { geometry: mergeAll(parts), emissive: mergeAll(em), height: H };
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Build one landmark. Named landmarks are deterministic and ignore `seed`;
 * `generic-tower` uses it to pick its whole shape. Geometry is freshly built
 * each call — cache or instance it on the caller's side if you need many.
 */
export function buildLandmark(id: LandmarkId, seed?: number): LandmarkMesh {
  switch (id) {
    case 'burj-khalifa': return buildBurjKhalifa();
    case 'museum-of-the-future': return buildMuseumOfTheFuture();
    case 'emirates-towers': return buildEmiratesTowers();
    case 'al-kazim-towers': return buildAlKazimTowers();
    case 'almas-tower': return buildAlmasTower();
    case 'burj-al-arab': return buildBurjAlArab();
    case 'difc-gate': return buildDifcGate();
    case 'address-tower': return buildAddressTower();
    case 'al-yaqoub': return buildAlYaqoub();
    case 'rose-rayhaan': return buildRoseRayhaan();
    case 'generic-tower': return buildGenericTower(seed ?? 1);
    default: return buildGenericTower(seed ?? 1);
  }
}
