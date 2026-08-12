import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * ============================================================================
 *  DUBAI METRO — Red Line viaduct along Sheikh Zayed Road
 * ============================================================================
 *
 *  >>> SOURCING <<<
 *  Original procedural geometry, dimensioned from published facts about the
 *  system (elevated viaduct down the SZR median, ~30 m pier spacing, box-girder
 *  deck, gold-clad shell stations straddling the carriageway) and general
 *  civil-engineering knowledge of precast segmental viaducts. Nothing traced,
 *  sampled or derived from Google Maps / Street View / Earth or any imagery.
 *
 *  ---------------------------------------------------------------------------
 *  WHY THIS MATTERS MORE THAN ANY SINGLE BUILDING
 *  ---------------------------------------------------------------------------
 *  Skylines are ambiguous at speed; the thing directly beside the car is not.
 *  The Red Line runs elevated straight down the median of Sheikh Zayed Road for
 *  the whole length of this corridor, so it is on screen continuously: a
 *  concrete ribbon overhead, single tapered piers strobing past at ~30 m, and
 *  every kilometre or so a bulging gold shell station straddling the road.
 *  Miami does not have that. After the Burj it is the strongest "this is Dubai"
 *  signal available, and it is the only one that provides continuous parallax.
 *
 *  ---------------------------------------------------------------------------
 *  CONVENTIONS
 *  ---------------------------------------------------------------------------
 *  • Metres. +Y up. Road surface at y = 0. Median centreline at x = 0.
 *  • The run is built DEAD STRAIGHT along +Z from the origin so the caller can
 *    bend it onto the corridor centreline (per-vertex, or by placing segments).
 *    The deck is subdivided every half-bay for exactly that reason — that
 *    spacing is the bend resolution, not a structural feature.
 *  • Piers sit at half-bay offsets (spacing/2, 3·spacing/2, …) so runs whose
 *    length is a whole number of bays tile end to end without doubling a pier.
 *  • The station is built about its own origin (centred on x = 0, z = 0, road
 *    at y = 0) so the caller only needs a translate + heading to drop it on a
 *    chainage.
 *  • Geometry is non-indexed with position / normal / uv and merged so each
 *    output is a single draw call. UVs: u across the section in metres,
 *    v = distance along the run in metres — a shader can lay concrete segment
 *    joints or LED runs on that directly at real-world pitch.
 * ============================================================================
 */

export interface MetroOptions {
  lengthM: number;
  pierSpacing?: number;
}

export interface MetroBuild {
  /** Viaduct deck + piers as one merged geometry, built along +Z from origin. */
  structure: THREE.BufferGeometry;
  /** Station shell geometry, placed by the caller. */
  station: THREE.BufferGeometry;
  /** Emissive strips (station glazing, deck underlighting). */
  emissive: THREE.BufferGeometry;
  /**
   * Station glazing, in the SAME local frame as `station`.
   *
   * Split out of `emissive` on purpose: `emissive` is aligned to the +Z run and
   * gets the run's transform, but stations are placed independently, so their
   * glow cannot live in the same buffer and still land in the right place.
   * Apply the station's transform to this one.
   */
  stationEmissive: THREE.BufferGeometry;
}

// ===========================================================================
// Geometry kit (local to this module so it stays self-contained)
// ===========================================================================

/** A point on a cross-section, in that section's own 2D plane. */
interface P2 { x: number; y: number }
interface V3 { x: number; y: number; z: number }
type Ring = V3[];

const TAU = Math.PI * 2;

/**
 * Loft a stack of closed sections.
 *
 * Winding rule: (A_j, B_j, B_j+1) faces outward when the sections run
 * anticlockwise about their own centre as seen looking BACK along the loft
 * direction. Sections swept along +Z are therefore authored anticlockwise in
 * XY and reversed on the way in (see `ringZ`).
 */
function loft(rings: Ring[], capFirst?: V3, capLast?: V3): THREE.BufferGeometry {
  const R = rings.length;
  const N = rings[0].length;
  const pos: number[] = [];
  const uv: number[] = [];

  // u = metres around the section, v = metres along the loft.
  const us: number[][] = [];
  const vs: number[] = [];
  let vAcc = 0;
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
    us.push(row);
    if (i > 0) {
      const p = rings[i - 1][0];
      const q = ring[0];
      vAcc += Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    }
    vs.push(vAcc);
  }

  const push = (i: number, j: number): void => {
    const p = rings[i][j % N];
    pos.push(p.x, p.y, p.z);
    uv.push(us[i][j], vs[i]);
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

  const parts: THREE.BufferGeometry[] = [g];
  if (capFirst) parts.push(cap(rings[0], capFirst));
  if (capLast) parts.push(cap(rings[R - 1], capLast));
  return parts.length === 1 ? g : mergeAll(parts);
}

/**
 * Fan cap. The fan is built blind and then flipped if its normal disagrees with
 * the outward direction the caller asked for, so callers never have to reason
 * about ring order.
 */
function cap(ring: Ring, outward: V3): THREE.BufferGeometry {
  const N = ring.length;
  const c: V3 = { x: 0, y: 0, z: 0 };
  for (const p of ring) { c.x += p.x / N; c.y += p.y / N; c.z += p.z / N; }

  const a = ring[0];
  const b = ring[1];
  const e1 = { x: a.x - c.x, y: a.y - c.y, z: a.z - c.z };
  const e2 = { x: b.x - c.x, y: b.y - c.y, z: b.z - c.z };
  const n = {
    x: e1.y * e2.z - e1.z * e2.y,
    y: e1.z * e2.x - e1.x * e2.z,
    z: e1.x * e2.y - e1.y * e2.x,
  };
  const flip = n.x * outward.x + n.y * outward.y + n.z * outward.z < 0;

  const pos: number[] = [];
  const uv: number[] = [];
  const put = (p: V3): void => { pos.push(p.x, p.y, p.z); uv.push(p.x, p.y); };
  for (let j = 0; j < N; j++) {
    const p = ring[j];
    const q = ring[(j + 1) % N];
    put(c);
    if (flip) { put(q); put(p); } else { put(p); put(q); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Place a section in the XY plane at z. Reversed — see the winding rule. */
function ringZ(section: P2[], z: number, scale = 1, dy = 0): Ring {
  return section
    .map((p) => ({ x: p.x * scale, y: p.y * scale + dy, z }))
    .reverse();
}

/** Place a horizontal section (XZ) at height y, for the piers. */
function ringY(section: P2[], y: number): Ring {
  return section.map((p) => ({ x: p.x, y, z: p.y }));
}

function ellipse(n: number, rx: number, ry: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
  }
  return out;
}

/** Superellipse — a fuller, less pinched oval than a true ellipse. */
function superellipse(n: number, rx: number, ry: number, expo: number): P2[] {
  const out: P2[] = [];
  const k = 2 / expo;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.push({
      x: rx * Math.sign(c) * Math.pow(Math.abs(c), k),
      y: ry * Math.sign(s) * Math.pow(Math.abs(s), k),
    });
  }
  return out;
}

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
  return parts.length === 1 ? prep(parts[0]) : mergeGeometries(parts.map(prep), false);
}

/**
 * Flat ribbon of quads through a polyline of edge pairs — the light strips.
 * Single-sided, so the winding is checked against `outward` and flipped if
 * needed: a strip facing the wrong way is invisible under backface culling,
 * and the two fascias of a viaduct necessarily face opposite directions.
 */
function ribbon(edges: Array<[V3, V3]>, outward: V3): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];

  const [f0, f1] = edges[0];
  const [g0] = edges[1];
  const e1 = { x: g0.x - f0.x, y: g0.y - f0.y, z: g0.z - f0.z };
  const e2 = { x: f1.x - f0.x, y: f1.y - f0.y, z: f1.z - f0.z };
  const n = {
    x: e1.y * e2.z - e1.z * e2.y,
    y: e1.z * e2.x - e1.x * e2.z,
    z: e1.x * e2.y - e1.y * e2.x,
  };
  const flip = n.x * outward.x + n.y * outward.y + n.z * outward.z < 0;

  for (let i = 0; i < edges.length - 1; i++) {
    const [a0, a1] = edges[i];
    const [b0, b1] = edges[i + 1];
    const u0 = i;
    const u1 = i + 1;
    const put = (p: V3, u: number, v: number): void => { pos.push(p.x, p.y, p.z); uv.push(u, v); };
    if (flip) {
      put(a0, u0, 0); put(b1, u1, 1); put(b0, u1, 0);
      put(a0, u0, 0); put(a1, u0, 1); put(b1, u1, 1);
    } else {
      put(a0, u0, 0); put(b0, u1, 0); put(b1, u1, 1);
      put(a0, u0, 0); put(b1, u1, 1); put(a1, u0, 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// ===========================================================================
// Dimensions
// ===========================================================================

/** Underside of the deck above the road — trucks and gantries pass beneath. */
const SOFFIT = 8.6;
/** Structural depth of the box girder. */
const DEPTH = 2.2;
const DECK_TOP = SOFFIT + DEPTH;
/** Deck width — two tracks plus walkways. */
const W_TOP = 9.0;
/** Soffit slab; narrower than the top, giving the girder its sloped webs. */
const W_SOF = 5.4;
const PARAPET = 1.0;
const PARAPET_T = 0.35;

/**
 * Box-girder cross-section, anticlockwise in XY: soffit slab, sloped webs out
 * to the deck edges, then the two parapet upstands with the track trough
 * between them. This is the shape that reads as "concrete viaduct" in
 * silhouette from a car alongside it.
 */
const DECK_SECTION: P2[] = [
  { x: -W_SOF / 2, y: SOFFIT },
  { x: W_SOF / 2, y: SOFFIT },
  { x: W_TOP / 2, y: DECK_TOP - 0.3 },
  { x: W_TOP / 2, y: DECK_TOP + PARAPET },
  { x: W_TOP / 2 - PARAPET_T, y: DECK_TOP + PARAPET },
  { x: W_TOP / 2 - PARAPET_T, y: DECK_TOP },
  { x: -W_TOP / 2 + PARAPET_T, y: DECK_TOP },
  { x: -W_TOP / 2 + PARAPET_T, y: DECK_TOP + PARAPET },
  { x: -W_TOP / 2, y: DECK_TOP + PARAPET },
  { x: -W_TOP / 2, y: DECK_TOP - 0.3 },
];

// ===========================================================================
// Pier
// ===========================================================================
/**
 * One tapered column per bay, standing in the median — no portal frames, no
 * twin columns. The shaft is an elongated oval in plan (long axis across the
 * road) that thins as it rises, then flares out into a pier head wide enough to
 * take the girder soffit. The flare is the recognisable bit: it reads as a
 * capital from the road.
 */
function buildPier(z: number): THREE.BufferGeometry {
  const S = 10; // facets around the shaft
  const rings: Ring[] = [
    ringY(ellipse(S, 1.95, 1.55), 0),
    ringY(ellipse(S, 1.62, 1.3), 5.0),
    ringY(ellipse(S, 1.5, 1.22), 7.1), // top of the shaft
    ringY(ellipse(S, 2.5, 1.55), 7.85), // flare
    ringY(ellipse(S, 3.05, 1.9), SOFFIT), // pier head under the girder
  ];
  const g = loft(rings, undefined, { x: 0, y: 1, z: 0 });
  g.translate(0, 0, z);
  return g;
}

// ===========================================================================
// Station
// ===========================================================================
/**
 * The signature Dubai Metro shell: a rounded, bulging enclosure clad in gold
 * that swells up and out from the guideway, straddles the carriageway on its
 * own legs, and tapers back down to hug the track at each end where the trains
 * enter. Glazed flanks run the length of the belly.
 *
 * It is built as a sweep whose section both SCALES and RISES along the length —
 * pinched onto the guideway at the portals, fattest and highest in the middle.
 * That single move is what makes the form read as an organic shell rather than
 * as a shed.
 */
const STATION_LEN = 128;
const STATION_RINGS = 15;
const STATION_SEC = 16;

/** Scale and centre-height of the shell section at t along its length. */
function stationProfile(t: number): { s: number; cy: number } {
  const bell = Math.sin(Math.PI * t);
  return {
    s: 0.44 + 0.56 * Math.pow(bell, 0.62),
    cy: 10.4 + 3.4 * Math.pow(bell, 0.8),
  };
}

function stationSection(): P2[] {
  // Fuller than an ellipse, with a slightly flattened belly where the glazing
  // and the platform floor are.
  return superellipse(STATION_SEC, 13, 8.6, 2.6).map((p) => ({
    x: p.x,
    y: p.y < 0 ? p.y * 0.82 : p.y,
  }));
}

function buildStation(): { solid: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const sec = stationSection();
  const rings: Ring[] = [];
  for (let i = 0; i < STATION_RINGS; i++) {
    const t = i / (STATION_RINGS - 1);
    const { s, cy } = stationProfile(t);
    rings.push(ringZ(sec, -STATION_LEN / 2 + STATION_LEN * t, s, cy));
  }
  const shell = loft(rings, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 });

  // Four splayed legs carrying the shell down past the carriageway to the
  // verges — the station straddles the road rather than sitting on the viaduct.
  const legs: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const z = sz * 34;
      const t = (z + STATION_LEN / 2) / STATION_LEN;
      const { s, cy } = stationProfile(t);
      const topX = sx * 13 * s * 0.8;
      const topY = cy - 8.6 * 0.82 * s * 0.72;
      const baseX = sx * 15.5;
      const foot = ellipse(6, 1.5, 1.5);
      const mid = ellipse(6, 1.1, 1.1);
      const head = ellipse(6, 0.85, 0.85);
      const legRings: Ring[] = [
        ringY(foot, 0).map((p) => ({ x: p.x + baseX, y: p.y, z: p.z + z })),
        ringY(mid, topY * 0.55).map((p) => ({
          x: p.x + baseX + (topX - baseX) * 0.55, y: p.y, z: p.z + z,
        })),
        ringY(head, topY).map((p) => ({ x: p.x + topX, y: p.y, z: p.z + z })),
      ];
      legs.push(loft(legRings, undefined, { x: 0, y: 1, z: 0 }));
    }
  }

  // Glazed flanks: a band around the widest line of the shell, both sides,
  // following the swell so the glazing curves with the form.
  const glow: THREE.BufferGeometry[] = [];
  for (const side of [0, STATION_SEC / 2]) {
    const jA = (side + STATION_SEC - 1) % STATION_SEC;
    const jB = (side + 1) % STATION_SEC;
    const edges: Array<[V3, V3]> = [];
    for (let i = 0; i < STATION_RINGS; i++) {
      const t = i / (STATION_RINGS - 1);
      const { s, cy } = stationProfile(t);
      const z = -STATION_LEN / 2 + STATION_LEN * t;
      const out = 1.03;
      const a = sec[jA];
      const b = sec[jB];
      edges.push([
        { x: a.x * s * out, y: a.y * s + cy, z },
        { x: b.x * s * out, y: b.y * s + cy, z },
      ]);
    }
    glow.push(ribbon(edges, { x: side === 0 ? 1 : -1, y: 0, z: 0 }));
  }

  return { solid: mergeAll([shell, ...legs]), glow: mergeAll(glow) };
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Build a straight run of Red Line viaduct along +Z from the origin, plus one
 * station shell and the run's lighting.
 *
 * Cost scales with length: roughly 1.3k triangles of deck and 2.4k of piers per
 * kilometre at the default 30 m spacing. Ask for the length you can actually
 * see — the corridor fog does the rest.
 */
export function buildMetro(opts: MetroOptions): MetroBuild {
  const length = Math.max(opts.pierSpacing ?? 30, opts.lengthM);
  const spacing = Math.max(8, opts.pierSpacing ?? 30);

  // Half-bay subdivision: this is the resolution at which the caller can bend
  // the run onto the corridor centreline, not a structural division.
  const step = spacing / 2;
  const steps = Math.max(2, Math.round(length / step));

  const deckRings: Ring[] = [];
  for (let i = 0; i <= steps; i++) deckRings.push(ringZ(DECK_SECTION, (length * i) / steps));
  const deck = loft(deckRings, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 });

  const piers: THREE.BufferGeometry[] = [];
  // Half-bay offset so consecutive runs tile without doubling a pier.
  for (let z = spacing / 2; z <= length - spacing / 4; z += spacing) piers.push(buildPier(z));

  // Deck underlighting: a continuous line down each fascia. At dusk this is the
  // element that sells the speed — two unbroken light rails overhead.
  const strips: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const edges: Array<[V3, V3]> = [];
    for (let i = 0; i <= steps; i++) {
      const z = (length * i) / steps;
      const x = sx * (W_TOP / 2 + 0.06);
      edges.push([
        { x, y: DECK_TOP - 0.2, z },
        { x, y: DECK_TOP - 0.75, z },
      ]);
    }
    strips.push(ribbon(edges, { x: sx, y: 0, z: 0 }));
  }

  const st = buildStation();

  return {
    structure: mergeAll([deck, ...piers]),
    station: st.solid,
    emissive: mergeAll(strips),
    stationEmissive: st.glow,
  };
}
