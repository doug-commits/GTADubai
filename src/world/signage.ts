import * as THREE from 'three';

/**
 * UAE motorway road furniture — the pieces that make a corridor read as
 * Sheikh Zayed Road rather than "a highway".
 *
 * Everything here is procedural: original geometry authored from general
 * knowledge of Gulf motorway practice, and original canvas artwork. No model
 * files, no image downloads, no webfonts, no third-party marks. Government and
 * authority logos are deliberately NOT reproduced — the cues we lean on are
 * functional standards (sign colour conventions, bilingual line order, portal
 * gantry proportions, mast geometry), which is what the eye actually reads at
 * 200 km/h anyway.
 *
 * Conventions shared by every builder in this file:
 *   - metres, +Y up, origin at ground level
 *   - runs are built straight along +Z; the caller bends them onto the corridor
 *   - the driver travels in +Z, so anything that faces oncoming traffic faces -Z
 *   - normals are supplied explicitly (flat for concrete/steel creases, smooth
 *     around swept tubes), so no caller-side computeVertexNormals() is needed
 *   - a `color` attribute is written on every geometry, so
 *     `new THREE.MeshStandardMaterial({ vertexColors: true })` already looks
 *     roughly right before the caller does anything clever
 *
 * Triangle budgets (verified by tools, see the header of each builder):
 *   gantry <= 600 | light mast <= 250 | palm <= 400 | planter <= 200 per 100 m
 */

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

type V3 = [number, number, number];
type V2 = [number, number];

/** Deterministic PRNG so a given `seed` always yields the same palm. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * sRGB hex -> renderer working (linear) space, matching what three does for
 * material colours. Vertex colours are consumed raw, so they must be converted
 * here or every prop comes out washed out.
 */
const _colCache = new Map<number, V3>();
function rgb(hex: number): V3 {
  const hit = _colCache.get(hex);
  if (hit) return hit;
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const out: V3 = [c.r, c.g, c.b];
  _colCache.set(hex, out);
  return out;
}

// ---------------------------------------------------------------------------
// geometry accumulator
// ---------------------------------------------------------------------------

const DEFAULT_UV: V2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * Minimal triangle accumulator. Deliberately hand-rolled rather than pulling in
 * BufferGeometryUtils: every prop here is a hand-counted triangle budget, and a
 * merge utility makes it far too easy to lose track of where the triangles went.
 */
class Mesher {
  private p: number[] = [];
  private n: number[] = [];
  private t: number[] = [];
  private c: number[] = [];
  private idx: number[] = [];
  private v = 0;
  /** Running triangle count — every builder asserts against its budget. */
  tris = 0;

  /** Flat-shaded quad, wound a->b->c->d counter-clockwise seen from the front. */
  quad(a: V3, b: V3, c: V3, d: V3, col: V3, uv: V2[] = DEFAULT_UV): void {
    const nrm = norm(cross(sub(b, a), sub(d, a)));
    this.quadN(a, b, c, d, nrm, nrm, nrm, nrm, col, uv);
  }

  /** Quad with supplied per-vertex normals (used for swept tubes). */
  quadN(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    na: V3,
    nb: V3,
    nc: V3,
    nd: V3,
    col: V3,
    uv: V2[] = DEFAULT_UV,
  ): void {
    const verts = [a, b, c, d];
    const nrms = [na, nb, nc, nd];
    for (let k = 0; k < 4; k++) {
      const p = verts[k]!;
      const nn = nrms[k]!;
      const t = uv[k] ?? DEFAULT_UV[k]!;
      this.p.push(p[0], p[1], p[2]);
      this.n.push(nn[0], nn[1], nn[2]);
      this.t.push(t[0], t[1]);
      this.c.push(col[0], col[1], col[2]);
    }
    const o = this.v;
    this.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    this.v += 4;
    this.tris += 2;
  }

  /** Flat triangle. */
  tri(a: V3, b: V3, c: V3, col: V3, nrm?: V3): void {
    const nn = nrm ?? norm(cross(sub(b, a), sub(c, a)));
    const verts = [a, b, c];
    const uvs: V2[] = [
      [0, 0],
      [1, 0],
      [0.5, 1],
    ];
    for (let k = 0; k < 3; k++) {
      const p = verts[k]!;
      const t = uvs[k]!;
      this.p.push(p[0], p[1], p[2]);
      this.n.push(nn[0], nn[1], nn[2]);
      this.t.push(t[0], t[1]);
      this.c.push(col[0], col[1], col[2]);
    }
    const o = this.v;
    this.idx.push(o, o + 1, o + 2);
    this.v += 3;
    this.tris += 1;
  }

  /** Axis-aligned box by centre + size. 12 tris. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: V3): void {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    // -Z (front, toward oncoming traffic) then round the sides.
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col);
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], col);
    this.quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], col);
  }

  /**
   * Oriented rectangular member from A to B, cross-section w x h, optionally
   * tapered. 4 side faces = 8 tris; ends are left open because in a welded
   * truss they are always buried in a chord or a gusset.
   */
  strut(
    A: V3,
    B: V3,
    w0: number,
    h0: number,
    col: V3,
    w1 = w0,
    h1 = h0,
    upHint?: V3,
  ): void {
    const T = norm(sub(B, A));
    const up = upHint ?? (Math.abs(T[1]) > 0.9 ? ([0, 0, 1] as V3) : ([0, 1, 0] as V3));
    const R = norm(cross(T, up));
    const U = norm(cross(R, T));
    const len = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    const sgn: V2[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const cornerA: V3[] = sgn.map(
      ([sr, su]) => add(A, add(mul(R, (sr * w0) / 2), mul(U, (su * h0) / 2))) as V3,
    );
    const cornerB: V3[] = sgn.map(
      ([sr, su]) => add(B, add(mul(R, (sr * w1) / 2), mul(U, (su * h1) / 2))) as V3,
    );
    const uLen = Math.max(0.05, len * 0.5);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      // Winding A_k -> B_k -> B_k+1 -> A_k+1 gives an outward normal.
      this.quad(cornerA[k]!, cornerB[k]!, cornerB[k2]!, cornerA[k2]!, col, [
        [0, 0],
        [uLen, 0],
        [uLen, 1],
        [0, 1],
      ]);
    }
  }

  /**
   * Swept tube along a polyline with per-ring radii, using parallel transport so
   * it survives a vertical->horizontal bend (a naive up-vector frame flips
   * exactly where a lighting mast's outreach arm turns over).
   */
  sweep(pts: V3[], radii: number[], sides: number, col: V3, capEnd = false): void {
    const nPts = pts.length;
    const tangents: V3[] = [];
    for (let i = 0; i < nPts; i++) {
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(nPts - 1, i + 1)]!;
      tangents.push(norm(sub(b, a)));
    }
    // Seed the frame with any vector perpendicular to the first tangent.
    const t0 = tangents[0]!;
    let n0: V3 = Math.abs(t0[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    n0 = norm(sub(n0, mul(t0, dot(n0, t0))));

    const rings: V3[][] = [];
    const ringN: V3[][] = [];
    let nCur = n0;
    for (let i = 0; i < nPts; i++) {
      const T = tangents[i]!;
      if (i > 0) {
        const prev = tangents[i - 1]!;
        const ax = cross(prev, T);
        const s = Math.hypot(ax[0], ax[1], ax[2]);
        if (s > 1e-6) {
          // Rodrigues rotation of the reference normal onto the new tangent.
          const k = mul(ax, 1 / s);
          const ang = Math.atan2(s, dot(prev, T));
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          nCur = add(
            add(mul(nCur, ca), mul(cross(k, nCur), sa)),
            mul(k, dot(k, nCur) * (1 - ca)),
          );
        }
      }
      nCur = norm(sub(nCur, mul(T, dot(nCur, T))));
      const B = cross(T, nCur);
      const ring: V3[] = [];
      const rn: V3[] = [];
      const r = radii[i]!;
      for (let j = 0; j < sides; j++) {
        const th = (j / sides) * Math.PI * 2;
        const dir: V3 = [
          nCur[0] * Math.cos(th) + B[0] * Math.sin(th),
          nCur[1] * Math.cos(th) + B[1] * Math.sin(th),
          nCur[2] * Math.cos(th) + B[2] * Math.sin(th),
        ];
        ring.push(add(pts[i]!, mul(dir, r)));
        rn.push(dir);
      }
      rings.push(ring);
      ringN.push(rn);
    }

    for (let i = 0; i < nPts - 1; i++) {
      const r0 = rings[i]!;
      const r1 = rings[i + 1]!;
      const m0 = ringN[i]!;
      const m1 = ringN[i + 1]!;
      for (let j = 0; j < sides; j++) {
        const j2 = (j + 1) % sides;
        const u0 = j / sides;
        const u1 = (j + 1) / sides;
        this.quadN(
          r0[j]!,
          r0[j2]!,
          r1[j2]!,
          r1[j]!,
          m0[j]!,
          m0[j2]!,
          m1[j2]!,
          m1[j]!,
          col,
          [
            [u0, i],
            [u1, i],
            [u1, i + 1],
            [u0, i + 1],
          ],
        );
      }
    }

    if (capEnd) {
      const last = rings[nPts - 1]!;
      const nrm = tangents[nPts - 1]!;
      for (let j = 1; j < sides - 1; j++) {
        this.tri(last[0]!, last[j]!, last[j + 1]!, col, nrm);
      }
    }
  }

  toGeometry(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(
      this.v > 65535
        ? new THREE.Uint32BufferAttribute(this.idx, 1)
        : new THREE.Uint16BufferAttribute(this.idx, 1),
    );
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// palette — dusk-appropriate base colours, all sRGB authored
// ---------------------------------------------------------------------------

const C_STEEL = rgb(0x8d9196); // galvanised gantry steel, dulled by sun
const C_STEEL_DK = rgb(0x6a6e73); // shadowed truss webs
const C_CONCRETE = rgb(0xb2ada2); // Gulf concrete: warm, sand-dusted, never white
const C_CONCRETE_DK = rgb(0x8f8a80);
const C_SOIL = rgb(0x4a3427); // irrigated median soil, dark because it is watered
const C_SIGN_BACK = rgb(0x9aa0a4); // plain aluminium sign rear
const C_MAST = rgb(0x9ba0a3); // hot-dip galvanised lighting column
const C_LANTERN = rgb(0x4c5155);
const C_TRUNK_LO = rgb(0x5b4632); // date palm trunk, darker in the scar recesses
const C_TRUNK_HI = rgb(0x8a7154); // sun-bleached boss faces
const C_FROND_IN = rgb(0x3d5226); // frond base, deep green
const C_FROND_TIP = rgb(0x7d8b46); // tip, dustier and yellower

// ===========================================================================
// PUBLIC TYPES
// ===========================================================================

export interface GantrySign {
  structure: THREE.BufferGeometry; // portal frame: uprights + truss span
  panel: THREE.BufferGeometry; // sign face(s), UV 0..1 per panel
  /** Canvas texture drawn for the sign face. */
  makePanelTexture(spec: SignSpec): THREE.CanvasTexture;
}

export interface SignSpec {
  /** English destination, e.g. "Dubai World Trade Centre". */
  en: string;
  /** Arabic destination. */
  ar: string;
  /** Exit number label, e.g. "Exit 45" / null. */
  exit?: string | null;
  /** 'green' motorway direction sign | 'blue' service | 'brown' tourist. */
  colour?: 'green' | 'blue' | 'brown';
  lanes?: number;
}

// ===========================================================================
// GANTRY
// ===========================================================================

/**
 * Portal sign gantry, the single strongest "this is a Gulf motorway" cue.
 *
 * What is being reproduced, and why each bit is there:
 *  - Full-width portal, not a cantilever. UAE arterials carry signs right
 *    across every lane, so the frame passes directly over the camera — which is
 *    also the best "something just went past" motion cue we get.
 *  - Chunky square-section uprights standing outside the shoulder on concrete
 *    pedestals. Gulf gantries are visibly heavy; slim European tube legs read
 *    as the wrong country immediately.
 *  - Box truss span with a Warren (zig-zag) web on both vertical faces plus
 *    lacing on the bottom plane. The bottom lacing is the face you actually see
 *    as you drive under it, so it gets the detail.
 *  - Knee haunches where the truss meets each upright.
 *  - The sign board hangs *below* the truss with ~6 m of clearance, backed by a
 *    plain aluminium plate (so the rear reads correctly after you pass) and lit
 *    by two small floodlights slung under the lower chord.
 *
 * @param spanM  distance between upright centres, metres (portal width).
 * Budget: 430 tris at the widest bay count. Limit 600.
 */
export function buildGantry(spanM: number): GantrySign {
  const span = clamp(spanM, 10, 60);
  const half = span / 2;

  // Vertical stack-up. Headroom under the panel is the number that has to be
  // right: UAE practice is ~5.5 m minimum, and getting it wrong makes the whole
  // portal look toy-sized.
  const PANEL_BOTTOM = 6.1;
  const PANEL_H = 3.4;
  const PANEL_W = clamp(span * 0.28, 5.4, 8.2);
  const PANEL_TOP = PANEL_BOTTOM + PANEL_H; // 9.5
  const CHORD_LO = 9.9;
  const CHORD_HI = 11.5;
  const TRUSS_HALF_Z = 0.75; // truss is 1.5 m deep front-to-back
  const PANEL_Z = -(TRUSS_HALF_Z + 0.13); // hangs just proud of the front face

  const m = new Mesher();

  // --- uprights + pedestals ------------------------------------------------
  for (const sx of [-1, 1]) {
    const x = sx * half;
    m.strut([x, 0.42, 0], [x, CHORD_HI + 0.25, 0], 0.58, 0.58, C_STEEL, 0.44, 0.44);
    // Cast pedestal: every Gulf gantry leg sits on one, and it is the thing
    // that keeps the base from looking like it was dropped on the sand.
    m.box(x, 0.24, 0, 1.34, 0.48, 1.34, C_CONCRETE);
  }

  // --- chords --------------------------------------------------------------
  // Bay count is adaptive so the lattice keeps a constant ~4 m rhythm across
  // any span, but clamped so the triangle budget holds for a 60 m portal too.
  const bays = clamp(Math.round(span / 4.2), 5, 8);
  const xAt = (i: number) => -half + (span * i) / bays;

  for (const z of [-TRUSS_HALF_Z, TRUSS_HALF_Z]) {
    for (const y of [CHORD_LO, CHORD_HI]) {
      m.strut([-half, y, z], [half, y, z], 0.24, 0.24, C_STEEL);
    }
  }

  // --- webs ----------------------------------------------------------------
  for (const z of [-TRUSS_HALF_Z, TRUSS_HALF_Z]) {
    for (let i = 0; i < bays; i++) {
      const up = i % 2 === 0;
      m.strut(
        [xAt(i), up ? CHORD_LO : CHORD_HI, z],
        [xAt(i + 1), up ? CHORD_HI : CHORD_LO, z],
        0.14,
        0.14,
        C_STEEL_DK,
      );
    }
    // Verticals every other node — full posting would double the web count for
    // detail nobody resolves at speed.
    for (let i = 0; i <= bays; i += 2) {
      m.strut([xAt(i), CHORD_LO, z], [xAt(i), CHORD_HI, z], 0.14, 0.14, C_STEEL_DK);
    }
  }
  // Bottom-plane lacing: the face the player drives under.
  for (let i = 0; i < bays; i++) {
    const f = i % 2 === 0 ? 1 : -1;
    m.strut(
      [xAt(i), CHORD_LO, -TRUSS_HALF_Z * f],
      [xAt(i + 1), CHORD_LO, TRUSS_HALF_Z * f],
      0.13,
      0.13,
      C_STEEL_DK,
    );
  }

  // --- knee haunches -------------------------------------------------------
  for (const sx of [-1, 1]) {
    m.strut(
      [sx * half, CHORD_LO - 1.6, 0],
      [sx * (half - 1.7), CHORD_LO, 0],
      0.2,
      0.2,
      C_STEEL,
    );
  }

  // --- sign board backing + hangers ---------------------------------------
  // The rear of a real sign is plain grey aluminium with a stiffener frame; the
  // artwork is a one-sided sheet on the front. Modelling the back as its own
  // slab means the panel geometry can stay a single 2-triangle quad.
  m.box(0, (PANEL_TOP + PANEL_BOTTOM) / 2, PANEL_Z + 0.07, PANEL_W, PANEL_H, 0.14, C_SIGN_BACK);
  for (const sx of [-1, 1]) {
    for (const dz of [0, 1]) {
      const hx = sx * PANEL_W * 0.34;
      m.strut(
        [hx, PANEL_TOP - 0.05, PANEL_Z + 0.07],
        [hx, CHORD_LO, dz === 0 ? -TRUSS_HALF_Z : TRUSS_HALF_Z],
        0.11,
        0.11,
        C_STEEL_DK,
      );
    }
  }
  // Sign floodlights slung under the lower chord — the reason these boards read
  // as lit rather than self-luminous at dusk.
  for (const sx of [-1, 1]) {
    m.box(sx * PANEL_W * 0.28, CHORD_LO - 0.45, PANEL_Z - 0.55, 0.62, 0.2, 0.26, C_LANTERN);
  }

  // --- panel face ----------------------------------------------------------
  // One quad, UV 0..1, normal facing -Z (i.e. at the oncoming driver).
  const pm = new Mesher();
  pm.quad(
    [PANEL_W / 2, PANEL_BOTTOM, PANEL_Z],
    [-PANEL_W / 2, PANEL_BOTTOM, PANEL_Z],
    [-PANEL_W / 2, PANEL_TOP, PANEL_Z],
    [PANEL_W / 2, PANEL_TOP, PANEL_Z],
    [1, 1, 1],
  );

  return {
    structure: m.toGeometry('uae-gantry-structure'),
    panel: pm.toGeometry('uae-gantry-panel'),
    makePanelTexture,
  };
}

// ===========================================================================
// SIGN FACE ARTWORK
// ===========================================================================

const PANEL_TEX_W = 1024;
const PANEL_TEX_H = 512;

/**
 * Field colours. UAE motorway direction signs are green with white legend and a
 * white border; blue is used for services/urban routes and brown for tourist
 * and heritage destinations. These are functional colour conventions, not
 * anyone's artwork.
 */
const FIELDS: Record<'green' | 'blue' | 'brown', { field: string; deep: string }> = {
  green: { field: '#00693c', deep: '#004f2d' },
  blue: { field: '#0b4ea2', deep: '#083a79' },
  brown: { field: '#59372a', deep: '#42281e' },
};

/**
 * Latin stack only names families that ship with desktop and mobile OSes — the
 * legend face on UAE signs is a Transport-like humanist sans, and Helvetica /
 * Arial / Roboto are the closest thing available with zero network cost.
 */
const EN_STACK = '"Helvetica Neue",Helvetica,Arial,Roboto,"Liberation Sans","DejaVu Sans",sans-serif';
/**
 * Arabic stack, again system-only. If none of these resolve we do NOT fall back
 * to a Latin family (that produces tofu); see `drawArabicApprox`.
 */
const AR_STACK =
  '"Noto Naskh Arabic","Noto Sans Arabic","Geeza Pro","Al Bayan","Baghdad","Damascus","Arabic Typesetting","Traditional Arabic","Segoe UI","Tahoma",sans-serif';

/** Eastern Arabic-Indic digits, as used on the Arabic line of Gulf signs. */
const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
function toArabicDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)] ?? d);
}

// --- Arabic capability probe ------------------------------------------------

type ArabicMode = 'native' | 'approximate';
let arabicMode: ArabicMode | null = null;

/**
 * Decide once whether this device can actually shape Arabic.
 *
 * Canvas gives us no direct "is this glyph present" query, so we use the fact
 * that every missing glyph renders as the *same* .notdef box: real Arabic
 * letters have wildly different advance widths (alef is a hairline, seen is
 * wide), whereas tofu boxes are all identical. If the widths cluster, or match
 * the width of a guaranteed-absent codepoint, we assume no Arabic font.
 */
function detectArabic(ctx: CanvasRenderingContext2D): ArabicMode {
  ctx.save();
  ctx.font = `100px ${AR_STACK}`;
  const probes = ['ا', 'م', 'س', 'ط', 'و', 'ج'];
  const widths = probes.map((c) => ctx.measureText(c).width);
  const tofu = ctx.measureText('￿').width; // noncharacter -> always .notdef
  ctx.restore();

  if (widths.some((w) => !(w > 0))) return 'approximate';
  const spread = Math.max(...widths) - Math.min(...widths);
  if (spread < 1.0) return 'approximate'; // all one width => all the same box
  if (tofu > 0 && widths.every((w) => Math.abs(w - tofu) < 0.5)) return 'approximate';
  return 'native';
}

/**
 * Geometric Arabic stand-in.
 *
 * THIS IS NOT READABLE ARABIC and is never used when a real Arabic font is
 * present. It exists because tofu boxes on a hero sign are worse than anything,
 * and because we are not allowed to download a webfont (2 s load budget).
 *
 * It draws the *skeleton* of naskh from first principles: a strong horizontal
 * baseline (the kashida) that letters hang off, ascenders, bowls that dip below
 * the line, teeth, and i'jam dot clusters above and below. Seeded from the real
 * Arabic string, so the same destination always renders identically and the
 * word count / rough length track the actual text. At the distance and speed
 * these signs are read in-game it reads as Arabic; up close it reads as
 * lettering-shaped ornament, which is the honest failure mode.
 */
function drawArabicApprox(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  baselineY: number,
  size: number,
  maxW: number,
  colour: string,
): void {
  const words = text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6);
  if (words.length === 0) return;

  const rnd = mulberry32(hashString(text));
  const unit = size * 0.42; // nominal advance of one letterform
  const gap = size * 0.34;

  type Letter = { kind: number; dots: number; below: boolean };
  const plan: Letter[][] = words.map((w) => {
    const n = clamp(Math.round(w.length * 0.85), 2, 7);
    const out: Letter[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        kind: Math.floor(rnd() * 4),
        dots: rnd() < 0.42 ? 1 + Math.floor(rnd() * 3) : 0,
        below: rnd() < 0.35,
      });
    }
    return out;
  });

  const rawW =
    plan.reduce((s, w) => s + w.length * unit, 0) + gap * Math.max(0, plan.length - 1);
  const scale = Math.min(1, maxW / Math.max(1, rawW));
  const u = unit * scale;
  const g = gap * scale;
  const s = size * scale;
  const total = plan.reduce((a, w) => a + w.length * u, 0) + g * Math.max(0, plan.length - 1);

  ctx.save();
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Arabic sets right to left, so lay words out from the right edge inward.
  let x = cx + total / 2;
  const stem = Math.max(2, s * 0.115);

  for (const word of plan) {
    const wWidth = word.length * u;
    const right = x;
    const left = x - wWidth;
    // kashida: the connecting baseline the whole word hangs from
    ctx.fillRect(left, baselineY - stem * 0.5, wWidth, stem);

    for (let i = 0; i < word.length; i++) {
      const L = word[i]!;
      const lx = right - (i + 0.5) * u;
      ctx.lineWidth = stem;
      switch (L.kind) {
        case 0: // alef / lam family: tall vertical
          ctx.fillRect(lx - stem * 0.5, baselineY - s * 0.82, stem, s * 0.82);
          break;
        case 1: // meem / fa family: small closed head on the line
          ctx.beginPath();
          ctx.arc(lx, baselineY - s * 0.17, s * 0.165, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 2: // nun / ya family: bowl swinging below the line
          ctx.beginPath();
          ctx.arc(lx, baselineY - s * 0.02, s * 0.26, 0.12 * Math.PI, 0.88 * Math.PI);
          ctx.stroke();
          break;
        default: // ba / sin family: short tooth
          ctx.fillRect(lx - stem * 0.5, baselineY - s * 0.3, stem, s * 0.3);
          break;
      }
      // i'jam — the dots that make Arabic unmistakably Arabic at a glance.
      if (L.dots > 0) {
        const dy = L.below ? baselineY + s * 0.3 : baselineY - s * 0.52;
        const dr = Math.max(1.5, s * 0.055);
        for (let d = 0; d < L.dots; d++) {
          const dx = lx + (d - (L.dots - 1) / 2) * dr * 3.1;
          ctx.beginPath();
          ctx.arc(dx, dy, dr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    x = left - g;
  }
  ctx.restore();
}

// --- canvas utilities -------------------------------------------------------

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Shrink until it fits, then squeeze, then truncate. Same order a signwriter uses. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  family: string,
  startPx: number,
  minPx: number,
  maxW: number,
): { size: number; squeeze: number; text: string } {
  let size = startPx;
  while (size > minPx) {
    ctx.font = `700 ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxW) return { size, squeeze: 1, text };
    size -= 2;
  }
  ctx.font = `700 ${minPx}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w <= maxW / 0.78) return { size: minPx, squeeze: Math.max(0.78, maxW / w), text };
  let cut = text;
  while (cut.length > 4 && ctx.measureText(`${cut}…`).width > maxW / 0.78) {
    cut = cut.slice(0, -1);
  }
  return { size: minPx, squeeze: 0.78, text: `${cut}…` };
}

function drawFitted(
  ctx: CanvasRenderingContext2D,
  text: string,
  family: string,
  startPx: number,
  minPx: number,
  maxW: number,
  cx: number,
  cy: number,
  colour: string,
): void {
  const f = fitText(ctx, text, family, startPx, minPx, maxW);
  ctx.save();
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${f.size}px ${family}`;
  ctx.translate(cx, cy);
  ctx.scale(f.squeeze, 1);
  ctx.fillText(f.text, 0, 0);
  ctx.restore();
}

/** White chevron arrow. UAE uses an up arrow for "ahead", down for lane assignment. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  down: boolean,
  colour: string,
): void {
  const s = size;
  const dir = down ? 1 : -1;
  const headH = s * 0.5;
  const headW = s * 0.62;
  const shaftW = s * 0.22;
  ctx.save();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(cx, cy + dir * s * 0.5); // tip
  ctx.lineTo(cx - headW / 2, cy + dir * (s * 0.5 - headH));
  ctx.lineTo(cx - shaftW / 2, cy + dir * (s * 0.5 - headH));
  ctx.lineTo(cx - shaftW / 2, cy - dir * s * 0.5);
  ctx.lineTo(cx + shaftW / 2, cy - dir * s * 0.5);
  ctx.lineTo(cx + shaftW / 2, cy + dir * (s * 0.5 - headH));
  ctx.lineTo(cx + headW / 2, cy + dir * (s * 0.5 - headH));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// --- the texture itself -----------------------------------------------------

const panelCache = new Map<string, THREE.CanvasTexture>();
/**
 * Cap the cache. A corridor only ever needs a handful of destinations; if a
 * caller starts generating per-instance specs we would rather churn than leak
 * VRAM, and the warning tells them their key is too fine-grained.
 */
const PANEL_CACHE_MAX = 32;

function specKey(spec: SignSpec): string {
  return [
    spec.colour ?? 'green',
    spec.exit ?? '',
    Math.max(0, Math.floor(spec.lanes ?? 0)),
    spec.ar,
    spec.en,
  ].join('\u001f');
}

/**
 * Draw one UAE-standard overhead direction sign face.
 *
 * Layout being reproduced (all functional convention, no protected artwork):
 *   - coloured field with a white rounded border set in from the edge
 *   - Arabic on the TOP line, set larger, right-to-left
 *   - English on the line BENEATH it
 *   - exit number in a tab at the top corner, bilingual, Eastern Arabic digits
 *   - an upward arrow for "straight ahead", or one downward arrow per lane when
 *     `lanes` is given (a lane-assignment gantry)
 *
 * Cached by spec: repeated destinations along the corridor share one texture
 * and one canvas.
 */
export function makePanelTexture(spec: SignSpec): THREE.CanvasTexture {
  const key = specKey(spec);
  const hit = panelCache.get(key);
  if (hit) return hit;

  if (typeof document === 'undefined') {
    throw new Error('makePanelTexture needs a DOM canvas; call it from the browser.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = PANEL_TEX_W;
  canvas.height = PANEL_TEX_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');

  if (arabicMode === null) arabicMode = detectArabic(ctx);

  const W = PANEL_TEX_W;
  const H = PANEL_TEX_H;
  const pal = FIELDS[spec.colour ?? 'green'];
  const WHITE = '#f4f6f3';
  const lanes = Math.max(0, Math.floor(spec.lanes ?? 0));

  // --- field -------------------------------------------------------------
  ctx.fillStyle = pal.field;
  ctx.fillRect(0, 0, W, H);
  // Retroreflective sheeting is never a dead flat fill — there is always a
  // slight vertical falloff and a fine grain from the beading. Without this the
  // sign looks like a UI element pasted into the scene.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.02)');
  grad.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const INSET = 16;
  const BORDER = 10;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = BORDER;
  roundRectPath(ctx, INSET + BORDER / 2, INSET + BORDER / 2, W - 2 * INSET - BORDER, H - 2 * INSET - BORDER, 30);
  ctx.stroke();

  // --- exit tab ----------------------------------------------------------
  // Gulf practice puts the exit number in its own bordered patch in the upper
  // corner on the side the exit leaves from (right-hand exits here).
  let textRight = W - INSET - BORDER - 26;
  const exit = spec.exit ?? null;
  if (exit) {
    const tabW = 232;
    const tabH = 128;
    const tx = W - INSET - BORDER - tabW - 14;
    const ty = INSET + BORDER + 14;
    ctx.save();
    ctx.fillStyle = pal.deep;
    roundRectPath(ctx, tx, ty, tabW, tabH, 18);
    ctx.fill();
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 6;
    roundRectPath(ctx, tx + 3, ty + 3, tabW - 6, tabH - 6, 16);
    ctx.stroke();

    const numMatch = exit.match(/\d+/);
    const num = numMatch ? numMatch[0] : '';
    const arExit = num ? `مخرج ${toArabicDigits(num)}` : 'مخرج';
    if (arabicMode === 'native') {
      ctx.direction = 'rtl';
      drawFitted(ctx, arExit, AR_STACK, 46, 24, tabW - 28, tx + tabW / 2, ty + 40, WHITE);
      ctx.direction = 'ltr';
    } else {
      drawArabicApprox(ctx, arExit, tx + tabW / 2, ty + 52, 40, tabW - 34, WHITE);
    }
    drawFitted(ctx, exit.toUpperCase(), EN_STACK, 44, 22, tabW - 28, tx + tabW / 2, ty + 94, WHITE);
    ctx.restore();
    textRight = tx - 18;
  }

  // --- destination block --------------------------------------------------
  const textLeft = INSET + BORDER + 26;
  let arrowBand = 0;
  let blockRight = textRight;
  if (lanes >= 1) {
    arrowBand = 132; // reserved strip along the bottom for the lane arrows
  } else {
    blockRight = textRight - 150; // reserve a column on the right for the arrow
  }
  const blockW = Math.max(180, blockRight - textLeft);
  const blockCx = (textLeft + blockRight) / 2;
  const blockTop = INSET + BORDER + (exit ? 26 : 18);
  const blockBot = H - INSET - BORDER - 18 - arrowBand;
  const arY = lerp(blockTop, blockBot, 0.32);
  const enY = lerp(blockTop, blockBot, 0.74);

  // Arabic first and larger — that line order is one of the strongest
  // single tells that this is a Gulf sign rather than a European one.
  if (arabicMode === 'native') {
    ctx.direction = 'rtl';
    drawFitted(ctx, toArabicDigits(spec.ar), AR_STACK, 118, 40, blockW, blockCx, arY, WHITE);
    ctx.direction = 'ltr';
  } else {
    drawArabicApprox(ctx, spec.ar, blockCx, arY + 34, 96, blockW, WHITE);
  }
  drawFitted(ctx, spec.en, EN_STACK, 86, 30, blockW, blockCx, enY, WHITE);

  // --- arrows -------------------------------------------------------------
  if (lanes >= 1) {
    const n = Math.min(lanes, 5);
    ctx.strokeStyle = 'rgba(244,246,243,0.85)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(textLeft, blockBot + 10);
    ctx.lineTo(textRight, blockBot + 10);
    ctx.stroke();
    const bandCy = blockBot + 10 + arrowBand / 2;
    const usable = textRight - textLeft;
    for (let i = 0; i < n; i++) {
      const cx = textLeft + (usable * (i + 0.5)) / n;
      drawArrow(ctx, cx, bandCy, Math.min(96, (usable / n) * 0.7), true, WHITE);
    }
  } else {
    drawArrow(ctx, (blockRight + textRight) / 2 + 10, H * 0.5, 170, false, WHITE);
  }

  // --- sheeting grain ------------------------------------------------------
  // Very light, and applied last so it sits over the legend too. Costs one
  // pass over the canvas at build time and kills the "vector graphic" flatness.
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const grainRnd = mulberry32(hashString(key));
  for (let i = 0; i < d.length; i += 4) {
    const n = (grainRnd() - 0.5) * 11;
    d[i] = clamp((d[i] ?? 0) + n, 0, 255);
    d[i + 1] = clamp((d[i + 1] ?? 0) + n, 0, 255);
    d[i + 2] = clamp((d[i + 2] ?? 0) + n, 0, 255);
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `sign:${spec.en}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // Mipmaps are not optional here: these boards are first seen ~400 m out, at
  // which point an unmipped 1024 px legend shimmers violently.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8; // clamped down by the renderer if unsupported
  tex.needsUpdate = true;

  if (panelCache.size >= PANEL_CACHE_MAX) {
    const oldest = panelCache.keys().next();
    if (!oldest.done) {
      panelCache.get(oldest.value)?.dispose();
      panelCache.delete(oldest.value);
    }
    console.warn('[signage] panel texture cache full — check that specs are being reused');
  }
  panelCache.set(key, tex);
  return tex;
}

/** True when the sign faces are being drawn with the geometric Arabic stand-in. */
export function arabicIsApproximated(): boolean {
  return arabicMode === 'approximate';
}

// ===========================================================================
// LIGHT MAST
// ===========================================================================

/**
 * Tall UAE-style motorway lighting: tapered mast + single curved outreach arm.
 *
 * The mast and its arm are ONE swept tube, because that is what they are in
 * reality — a continuous tapered steel column whose top is bent over the
 * carriageway. Modelling the arm as a separate straight stick is exactly the
 * "could be anywhere" look we are removing. Height 12-15 m, base ~0.19 m
 * diameter, ~2.6 m outreach, flat rectangular LED lantern.
 *
 * Local frame: column at the origin, arm reaching toward +X. Place the mast on
 * the verge and mirror in X for the other carriageway.
 *
 * Budget: 172 tris. Limit 250.
 */
export function buildLightMast(heightM = 14): { structure: THREE.BufferGeometry; lampPosition: THREE.Vector3 } {
  const H = clamp(heightM, 8, 20);
  const REACH = clamp(H * 0.185, 1.8, 3.0);
  const m = new Mesher();

  // Concrete foundation + galvanised base flange. Real columns are bolted to a
  // pad that stands proud of the verge; without it the pole looks stuck in sand.
  m.box(0, 0.16, 0, 0.98, 0.32, 0.98, C_CONCRETE_DK);
  m.sweep(
    [
      [0, 0.3, 0],
      [0, 0.52, 0],
      [0, 0.66, 0],
    ],
    [0.3, 0.29, 0.17],
    6,
    C_MAST,
  );

  // Column: straight tapered section, then a quadratic bend into the outreach.
  const bendStart = H * 0.8;
  const pts: V3[] = [
    [0, 0.6, 0],
    [0, H * 0.32, 0],
    [0, bendStart, 0],
  ];
  const radii = [0.155, 0.115, 0.083];
  const P0: V3 = [0, bendStart, 0];
  const P1: V3 = [0, H * 1.0, 0]; // control: pulls the bend up before it turns over
  const P2: V3 = [REACH, H * 0.995, 0];
  const BEND_STEPS = 9;
  for (let i = 1; i <= BEND_STEPS; i++) {
    const t = i / BEND_STEPS;
    const it = 1 - t;
    pts.push([
      it * it * P0[0] + 2 * it * t * P1[0] + t * t * P2[0],
      it * it * P0[1] + 2 * it * t * P1[1] + t * t * P2[1],
      it * it * P0[2] + 2 * it * t * P1[2] + t * t * P2[2],
    ]);
    radii.push(lerp(0.083, 0.062, t));
  }
  m.sweep(pts, radii, 6, C_MAST, true);

  // Lantern: modern SZR lighting is a flat rectangular LED unit, not a cobra
  // head. Shallow, wide, and tilted a few degrees down-road.
  const tip = pts[pts.length - 1]!;
  const lanternCx = tip[0] + 0.34;
  const lanternCy = tip[1] - 0.03;
  m.box(lanternCx, lanternCy, 0, 0.78, 0.13, 0.36, C_LANTERN);

  return {
    structure: m.toGeometry('uae-light-mast'),
    // Lens centre, on the underside — where the caller should sit the glow
    // billboard and any light source.
    lampPosition: new THREE.Vector3(lanternCx, lanternCy - 0.07, 0),
  };
}

// ===========================================================================
// DATE PALM
// ===========================================================================

/**
 * Date palm — the median planting that defines every Dubai arterial.
 *
 * Two pieces so they can take different materials: `trunk` is opaque, `fronds`
 * wants an alpha-tested leaflet texture (see `makeFrondTexture`) and
 * `THREE.DoubleSide` is unnecessary because the strips are built genuinely
 * two-sided — you drive *under* these, so the underside has to be lit properly.
 *
 * The trunk is a tapered lathe whose rings are phase-offset by half a segment
 * and whose vertices alternate in and out, so the faceting itself forms the
 * diamond lattice of cut frond bases that a date palm trunk actually has. Flat
 * normals, deliberately, so those diamonds catch the dusk light. UVs are also
 * laid out for that lattice (see `makePalmBarkTexture`).
 *
 * Budget: 372 tris at the highest frond count. Limit 400.
 */
export function buildPalm(seed: number): {
  trunk: THREE.BufferGeometry;
  fronds: THREE.BufferGeometry;
  height: number;
} {
  const rnd = mulberry32((seed | 0) >>> 0 || 1);

  // Mature SZR median palms run roughly 7-13 m to the crown. Identical palms in
  // a row is the single most obvious "instanced asset" tell, so height, lean,
  // trunk thickness, crown twist and frond count all move with the seed.
  const trunkH = lerp(6.5, 12.5, rnd());
  const leanA = rnd() * Math.PI * 2;
  const leanMag = lerp(0.0, 0.055, rnd() * rnd()); // mostly upright, occasionally not
  const baseR = lerp(0.30, 0.40, rnd());
  const topR = baseR * lerp(0.62, 0.74, rnd());
  const crownTwist = rnd() * Math.PI * 2;

  const SIDES = 7;
  const RINGS = 9; // 8 bands
  const tm = new Mesher();

  const ringPts: V3[][] = [];
  for (let i = 0; i < RINGS; i++) {
    const t = i / (RINGS - 1);
    const y = t * trunkH;
    // Lean grows with the square of height so the base stays planted.
    const lx = Math.cos(leanA) * leanMag * trunkH * t * t;
    const lz = Math.sin(leanA) * leanMag * trunkH * t * t;
    // Slight basal flare, then a steady taper, then a small swell under the
    // crown where the newest frond bases are still attached.
    const flare = 1 + 0.26 * Math.exp(-t * 9);
    const swell = 1 + 0.1 * Math.exp(-Math.pow((t - 0.94) * 14, 2));
    const r = lerp(baseR, topR, t) * flare * swell;
    const phase = (i % 2) * (Math.PI / SIDES); // half-segment offset per ring
    const ring: V3[] = [];
    for (let j = 0; j < SIDES; j++) {
      const th = phase + (j / SIDES) * Math.PI * 2;
      // Alternating boss/recess: this is what turns plain faceting into the
      // rhomboid scar pattern.
      const boss = (i + j) % 2 === 0 ? 1.075 : 0.945;
      ring.push([lx + Math.cos(th) * r * boss, y, lz + Math.sin(th) * r * boss]);
    }
    ringPts.push(ring);
  }

  for (let i = 0; i < RINGS - 1; i++) {
    const a = ringPts[i]!;
    const b = ringPts[i + 1]!;
    for (let j = 0; j < SIDES; j++) {
      const j2 = (j + 1) % SIDES;
      const t0 = i / (RINGS - 1);
      const t1 = (i + 1) / (RINGS - 1);
      // Recessed quads get the darker colour, so the pattern reads even on a
      // flat untextured material.
      const lit = (i + j) % 2 === 0;
      const col: V3 = [
        lerp(C_TRUNK_LO[0], C_TRUNK_HI[0], lit ? 0.85 : 0.15),
        lerp(C_TRUNK_LO[1], C_TRUNK_HI[1], lit ? 0.85 : 0.15),
        lerp(C_TRUNK_LO[2], C_TRUNK_HI[2], lit ? 0.85 : 0.15),
      ];
      // uv.x wraps once around, uv.y counts scar courses so a diamond bark
      // texture tiles onto the same lattice the geometry already describes.
      tm.quad(a[j]!, a[j2]!, b[j2]!, b[j]!, col, [
        [j / SIDES, t0 * (RINGS - 1) * 0.5],
        [(j + 1) / SIDES, t0 * (RINGS - 1) * 0.5],
        [(j + 1) / SIDES, t1 * (RINGS - 1) * 0.5],
        [j / SIDES, t1 * (RINGS - 1) * 0.5],
      ]);
    }
  }

  // --- crown --------------------------------------------------------------
  const FRONDS = 11 + Math.floor(rnd() * 3); // 11..13
  const SEGS = 5;
  const fm = new Mesher();
  const crownY = trunkH;
  const crownX = Math.cos(leanA) * leanMag * trunkH;
  const crownZ = Math.sin(leanA) * leanMag * trunkH;

  for (let f = 0; f < FRONDS; f++) {
    // Two whorls: an inner set standing up, an outer set arching out and down.
    const outer = f % 2 === 1;
    const az = crownTwist + (f / FRONDS) * Math.PI * 2 + (rnd() - 0.5) * 0.28;
    const L = lerp(3.0, 4.4, rnd()) * (outer ? 1.05 : 0.9);
    const W = lerp(0.42, 0.6, rnd());

    // Rachis as a quadratic Bezier in the (radial, up) plane: leaves the crown
    // steeply, arches over, tip hangs below the crown. That arch is the whole
    // silhouette of a date palm.
    const upFactor = outer ? lerp(0.18, 0.42, rnd()) : lerp(0.55, 0.85, rnd());
    const tipDrop = outer ? lerp(-0.85, -0.35, rnd()) : lerp(-0.2, 0.15, rnd());
    const R0: V2 = [0, 0];
    const R1: V2 = [L * 0.34, L * upFactor];
    const R2: V2 = [L * 0.93, L * tipDrop * 0.55];
    const ca = Math.cos(az);
    const sa = Math.sin(az);
    const yaw = (rnd() - 0.5) * 0.5; // fronds are never perfectly radial

    const centre: V3[] = [];
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      const it = 1 - t;
      const rr = it * it * R0[0] + 2 * it * t * R1[0] + t * t * R2[0];
      const yy = it * it * R0[1] + 2 * it * t * R1[1] + t * t * R2[1];
      const a2 = az + yaw * t * t;
      centre.push([crownX + Math.cos(a2) * rr, crownY + yy, crownZ + Math.sin(a2) * rr]);
    }

    const widthAt = (t: number) =>
      W * (0.2 + 0.8 * Math.pow(Math.sin(Math.PI * Math.min(0.999, t)), 0.6)) * (1 - t * 0.25);

    for (let i = 0; i < SEGS; i++) {
      const t0 = i / SEGS;
      const t1 = (i + 1) / SEGS;
      const p0 = centre[i]!;
      const p1 = centre[i + 1]!;
      const T = norm(sub(p1, p0));
      // Blade sits roughly horizontal, rolled progressively along the rachis so
      // it twists the way a real frond does under its own weight.
      let side = norm(cross(T, [0, 1, 0]));
      if (!isFinite(side[0])) side = [ca, 0, sa];
      const rollA = (t0 + t1) * 0.5 * 0.55 + (outer ? 0.18 : 0.0);
      const upv = norm(cross(side, T));
      const S: V3 = norm([
        side[0] * Math.cos(rollA) + upv[0] * Math.sin(rollA),
        side[1] * Math.cos(rollA) + upv[1] * Math.sin(rollA),
        side[2] * Math.cos(rollA) + upv[2] * Math.sin(rollA),
      ]);
      const w0 = widthAt(t0) / 2;
      const w1 = widthAt(t1) / 2;
      const a0 = sub(p0, mul(S, w0));
      const b0 = add(p0, mul(S, w0));
      const a1 = sub(p1, mul(S, w1));
      const b1 = add(p1, mul(S, w1));

      const mixT = (t0 + t1) * 0.5;
      const col: V3 = [
        lerp(C_FROND_IN[0], C_FROND_TIP[0], mixT),
        lerp(C_FROND_IN[1], C_FROND_TIP[1], mixT),
        lerp(C_FROND_IN[2], C_FROND_TIP[2], mixT),
      ];
      const uvA: V2[] = [
        [0, t0],
        [1, t0],
        [1, t1],
        [0, t1],
      ];
      const uvB: V2[] = [
        [1, t0],
        [0, t0],
        [0, t1],
        [1, t1],
      ];
      fm.quad(a0, b0, b1, a1, col, uvA);
      fm.quad(b0, a0, a1, b1, col, uvB); // reversed copy: genuinely two-sided
    }
  }

  return {
    trunk: tm.toGeometry('date-palm-trunk'),
    fronds: fm.toGeometry('date-palm-fronds'),
    height: trunkH,
  };
}

// ===========================================================================
// MEDIAN PLANTER
// ===========================================================================

/**
 * Concrete median planter / jersey barrier profile run.
 *
 * This is the standard section between the two carriageways of a Dubai
 * arterial: a safety-shape (jersey) face on each side so an errant car is
 * redirected rather than stopped, a flat coping on top, and a raised soil bed
 * between the walls carrying the palms and the drip irrigation. The soil sits
 * ABOVE the road, which is why the palms in the middle of SZR look like they
 * are standing on a plinth.
 *
 * Built straight along +Z from z = 0 to z = lengthM, centred on x = 0. Vertex
 * colours separate concrete from soil, and uv.x carries the normalised lateral
 * position (0..1) so a shader can find the bed without a second attribute.
 *
 * Budget: 192 tris per 100 m. Limit 200.
 */
export function buildMedianPlanter(lengthM: number): THREE.BufferGeometry {
  const L = Math.max(1, lengthM);
  // 12 m is the shortest segment the budget allows: the section is 12 faces =
  // 24 tris per segment, and 200 tris per 100 m caps us at 8.33 segments per
  // 100 m. Flooring (rather than rounding) guarantees the rate holds for every
  // length >= 12 m; segments land between 12 and 24 m. A caller that needs
  // tighter curvature should build the run as several shorter tiles rather
  // than one long one.
  const segs = Math.max(1, Math.floor(L / 12));

  // 13-point half-open section, left kerb -> soil crown -> right kerb.
  const PROFILE: V2[] = [
    [-1.5, 0.0],
    [-1.45, 0.15], // vertical toe
    [-1.18, 0.56], // jersey safety-shape slope
    [-1.08, 0.92], // upper face
    [-0.86, 0.93], // coping, falling slightly inward
    [-0.82, 0.7], // inner wall down to the bed
    [0.0, 0.76], // soil, crowned so it drains
    [0.82, 0.7],
    [0.86, 0.93],
    [1.08, 0.92],
    [1.18, 0.56],
    [1.45, 0.15],
    [1.5, 0.0],
  ];
  // Faces 5 and 6 bound the soil bed; everything else is concrete.
  const SOIL_FACES = new Set([5, 6]);

  const m = new Mesher();
  const xMin = PROFILE[0]![0];
  const xSpan = PROFILE[PROFILE.length - 1]![0] - xMin;

  for (let s = 0; s < segs; s++) {
    const z0 = (L * s) / segs;
    const z1 = (L * (s + 1)) / segs;
    for (let i = 0; i < PROFILE.length - 1; i++) {
      const a = PROFILE[i]!;
      const b = PROFILE[i + 1]!;
      const soil = SOIL_FACES.has(i);
      const col = soil ? C_SOIL : i % 3 === 1 ? C_CONCRETE_DK : C_CONCRETE;
      const ua = (a[0] - xMin) / xSpan;
      const ub = (b[0] - xMin) / xSpan;
      // Wound so the outward normal points away from the planter core.
      m.quad(
        [a[0], a[1], z0],
        [b[0], b[1], z0],
        [b[0], b[1], z1],
        [a[0], a[1], z1],
        col,
        [
          [ua, z0 * 0.25],
          [ub, z0 * 0.25],
          [ub, z1 * 0.25],
          [ua, z1 * 0.25],
        ],
      );
    }
  }

  return m.toGeometry('median-planter');
}

// ===========================================================================
// SUPPORTING TEXTURES (optional helpers — the geometry works without them)
// ===========================================================================

let frondTex: THREE.CanvasTexture | null = null;
/**
 * Alpha-tested leaflet sheet for the frond strips.
 *
 * A date palm frond is pinnate: a stiff rachis with a hundred-odd narrow
 * leaflets angled off it, splayed in a shallow V. At 11-13 strips per palm the
 * only way the crown reads as a palm rather than as banana leaves is to punch
 * the leaflets out in alpha. Maps to the frond UV (u across, v along).
 */
export function makeFrondTexture(): THREE.CanvasTexture {
  if (frondTex) return frondTex;
  if (typeof document === 'undefined') throw new Error('makeFrondTexture needs a DOM canvas.');
  const W = 128;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.clearRect(0, 0, W, H);

  const rnd = mulberry32(0x9a71);
  // rachis
  ctx.strokeStyle = '#6a7a3a';
  ctx.lineWidth = W * 0.075;
  ctx.beginPath();
  ctx.moveTo(W / 2, H);
  ctx.lineTo(W / 2, H * 0.02);
  ctx.stroke();

  const LEAFLETS = 78;
  for (let i = 0; i < LEAFLETS; i++) {
    const t = i / (LEAFLETS - 1); // 0 = base of the frond (v=0), 1 = tip
    const y = H * (1 - t);
    const len = W * 0.5 * (0.28 + 0.72 * Math.pow(Math.sin(Math.PI * Math.min(0.999, t)), 0.5));
    const sweep = H * (0.055 + 0.03 * t);
    const shade = Math.floor(lerp(58, 118, t * 0.7 + rnd() * 0.3));
    ctx.strokeStyle = `rgb(${Math.floor(shade * 0.72)},${shade + 24},${Math.floor(shade * 0.44)})`;
    ctx.lineWidth = Math.max(1.4, W * 0.026 * (1 - t * 0.35));
    ctx.lineCap = 'round';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(W / 2, y);
      ctx.quadraticCurveTo(
        W / 2 + dir * len * 0.6,
        y - sweep * 0.35,
        W / 2 + dir * len * (0.9 + rnd() * 0.2),
        y - sweep * (0.8 + rnd() * 0.4),
      );
      ctx.stroke();
    }
  }

  frondTex = new THREE.CanvasTexture(canvas);
  frondTex.name = 'palm-frond';
  frondTex.colorSpace = THREE.SRGBColorSpace;
  frondTex.wrapS = THREE.ClampToEdgeWrapping;
  frondTex.wrapT = THREE.ClampToEdgeWrapping;
  frondTex.generateMipmaps = true;
  frondTex.minFilter = THREE.LinearMipmapLinearFilter;
  frondTex.magFilter = THREE.LinearFilter;
  frondTex.anisotropy = 4;
  frondTex.needsUpdate = true;
  return frondTex;
}

let barkTex: THREE.CanvasTexture | null = null;
/**
 * Date palm bark: the rhomboid lattice of cut frond bases. Tiles horizontally,
 * and its diamond pitch matches the trunk UV laid down in `buildPalm`, so the
 * painted scars land on the geometric bosses rather than fighting them.
 */
export function makePalmBarkTexture(): THREE.CanvasTexture {
  if (barkTex) return barkTex;
  if (typeof document === 'undefined') throw new Error('makePalmBarkTexture needs a DOM canvas.');
  const W = 256;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');

  ctx.fillStyle = '#5c4632';
  ctx.fillRect(0, 0, W, H);

  const COLS = 7; // matches the trunk's 7 radial segments
  const ROWS = 4; // 2 scar courses per uv.y unit
  const cw = W / COLS;
  const ch = H / ROWS;
  const rnd = mulberry32(0x2f19);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = c * cw + ((r % 2) * cw) / 2 + cw / 2;
      const cy = r * ch + ch / 2;
      const tone = Math.floor(lerp(96, 148, rnd()));
      // Raised boss face, lit from above-left.
      ctx.fillStyle = `rgb(${tone},${Math.floor(tone * 0.82)},${Math.floor(tone * 0.58)})`;
      ctx.beginPath();
      ctx.moveTo(cx, cy - ch * 0.42);
      ctx.lineTo(cx + cw * 0.44, cy);
      ctx.lineTo(cx, cy + ch * 0.42);
      ctx.lineTo(cx - cw * 0.44, cy);
      ctx.closePath();
      ctx.fill();
      // Recessed shadow along the lower-right of each scar.
      ctx.strokeStyle = 'rgba(30,20,12,0.55)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx + cw * 0.44, cy);
      ctx.lineTo(cx, cy + ch * 0.42);
      ctx.lineTo(cx - cw * 0.44, cy);
      ctx.stroke();
      // Fibrous vertical strands between the scars.
      ctx.strokeStyle = `rgba(${tone - 40},${tone - 55},${tone - 70},0.4)`;
      ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) {
        const sx = cx + (rnd() - 0.5) * cw * 0.7;
        ctx.beginPath();
        ctx.moveTo(sx, cy - ch * 0.4);
        ctx.lineTo(sx + (rnd() - 0.5) * 4, cy + ch * 0.4);
        ctx.stroke();
      }
    }
  }

  barkTex = new THREE.CanvasTexture(canvas);
  barkTex.name = 'palm-bark';
  barkTex.colorSpace = THREE.SRGBColorSpace;
  barkTex.wrapS = THREE.RepeatWrapping;
  barkTex.wrapT = THREE.RepeatWrapping;
  barkTex.generateMipmaps = true;
  barkTex.minFilter = THREE.LinearMipmapLinearFilter;
  barkTex.magFilter = THREE.LinearFilter;
  barkTex.anisotropy = 4;
  barkTex.needsUpdate = true;
  return barkTex;
}

/** Drop every cached canvas texture. Call on teardown / hot reload. */
export function disposeSignageTextures(): void {
  for (const t of panelCache.values()) t.dispose();
  panelCache.clear();
  frondTex?.dispose();
  frondTex = null;
  barkTex?.dispose();
  barkTex = null;
  arabicMode = null;
}
