import * as THREE from 'three';

/**
 * Synthesised surface detail.
 *
 * The client's verdict was that every surface is clean procedural maths, and
 * they were right: a shader that computes its albedo from two octaves of fbm
 * has no grain, no dirt, no cracks, no patches, no tyre marks. GTA-calibre
 * realism is mostly texture detail catching light — specifically, a real height
 * field catching a low sun, which at dusk is the single biggest win available.
 *
 * Nothing here is downloaded. Everything is generated into typed arrays at boot
 * and wrapped in DataTextures, because the game has to be playable in under two
 * seconds on a phone and a megabyte of PNG is not affordable. A few hundred
 * milliseconds of one-time maths is.
 *
 * WHAT COMES OUT (all seamlessly tiling, all deterministic):
 *
 *   roadAlbedo      RGB = sRGB asphalt, A = cavity occlusion
 *   roadRoughness   R = roughness, G = cavity occlusion, B = water retention
 *   roadNormal      RGB = tangent-space normal (+Y up), A = height
 *   concrete        RGB = sRGB concrete, A = roughness
 *   concreteNormal  RGB = tangent-space normal (+Y up), A = height
 *   roadDecals      RGBA atlas, straight alpha, colour dilated into the gutters
 *
 * These feed the ASSET SLOT uniforms that already exist — road.ts `tAlbedo` /
 * `tRough`, facade.ts `tFacade` — so the client's real art can still override
 * them later by dropping files into public/assets and letting the loaders win.
 *
 * COORDINATE CONVENTIONS. These matter; get them wrong and the wheel tracks run
 * across the road instead of along it.
 *
 *   road      X = LATERAL metres (across the carriageway)
 *             Y = ALONG metres (direction of travel)
 *             tile = ROAD_TILE_METRES square, which is what road.ts's
 *             texture(tAlbedo, vec2(lat, along) * 0.25) already assumes.
 *   concrete  X = horizontal metres, Y = vertical metres, up.
 *             Rain streaks run DOWN, i.e. toward -Y, from a ledge at v = 1.
 *             tile = CONCRETE_TILE_METRES square.
 *   decals    quadrants in UV space:
 *               (0.0-0.5, 0.0-0.5)  tyre skid mark, runs along +V
 *               (0.5-1.0, 0.0-0.5)  oil stain
 *               (0.0-0.5, 0.5-1.0)  rectangular patch repair
 *               (0.5-1.0, 0.5-1.0)  manhole cover
 *             The three round/square decals are square in world space at about
 *             DECAL_QUADRANT_METRES. The skid is meant to be STRETCHED — map it
 *             onto roughly 0.6 m across by 5-8 m along, which is what a locked
 *             wheel actually lays down.
 *             Every quadrant has a zero-alpha gutter, and its colour is dilated
 *             into that gutter, so no mip level can either bleed one decal into
 *             its neighbour or darken a decal's rim toward black.
 *
 * SEAMLESSNESS is structural, not cosmetic. Every noise function here is
 * periodic by construction — the lattice index is wrapped with a modulo, not
 * mirrored or cross-faded — and every splat, stamp and walker wraps its writes.
 * The construction joint and the concrete panel reveal are placed deliberately
 * ON the tile edge: a hard feature straddling the wrap is permanent proof that
 * the wrap works. A visible seam sweeping past at 250 km/h is worse than no
 * texture at all.
 *
 * COLOUR SPACE. Albedo is authored directly in sRGB (display-referred), which
 * is both what a photographed albedo map actually is and what lets the dark end
 * of the asphalt range survive 8-bit quantisation — encoding from linear at
 * 8 bits would band the darks, which is the whole tonal range of tarmac.
 * Roughness, normals and heights are linear data and are written raw.
 *
 * PERFORMANCE. The budget is a few hundred milliseconds ONCE, so the code is
 * written for it: noise octaves are built by interpolating small periodic
 * lattices rather than hashing per pixel, low-frequency stacks are built at
 * quarter resolution and added in during a single upsample, features that only
 * occupy a band of the image (the joint, the patch seam) are computed in a
 * window rather than over the whole plane, and the passes that must be
 * full-frame are fused so the image is walked as few times as possible.
 */

// ---------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------

export interface DetailTextures {
  roadAlbedo: THREE.DataTexture; // tiling asphalt: aggregate, patches, stains
  roadRoughness: THREE.DataTexture; // wear polish in wheel tracks, puddle gloss
  roadNormal: THREE.DataTexture; // micro-relief: aggregate bumps, cracks, joints
  concrete: THREE.DataTexture; // barriers, viaduct, podiums
  concreteNormal: THREE.DataTexture;
  /** Decal atlas: tyre skid marks, oil stains, patch repairs, manhole covers. */
  roadDecals: THREE.DataTexture;
}

/** World size of one road tile, metres. Matches road.ts's UV scale of 0.25. */
export const ROAD_TILE_METRES = 4;
/** World size of one concrete tile, metres. */
export const CONCRETE_TILE_METRES = 2;
/** Suggested world size of a square decal quadrant, metres. */
export const DECAL_QUADRANT_METRES = 2.4;

const DEFAULT_SIZE = 512;

/** Fixed so the same road appears on every device and every run. */
const SEED_ROAD = 0x5eed1a7;
const SEED_CONCRETE = 0x5eedc07;
const SEED_DECALS = 0x5eeddec;

let cache: DetailTextures | null = null;
let cacheSize = 0;
let lastMs = 0;

/**
 * Generate (or return the cached) detail set.
 *
 * Idempotent: calling it a second time with the same size hands back the same
 * textures rather than re-uploading six megabytes to the GPU. `size` is rounded
 * to a power of two and clamped to 64..2048.
 */
export function generateDetailTextures(size: number = DEFAULT_SIZE): DetailTextures {
  const s = Math.max(64, Math.min(2048, 1 << Math.round(Math.log2(size))));
  if (cache && cacheSize === s) return cache;
  if (cache) disposeDetailTextures();

  const t0 = now();

  const road = buildRoad(s, SEED_ROAD);
  const conc = buildConcrete(s, SEED_CONCRETE);
  const decals = buildDecals(s, SEED_DECALS);

  cache = {
    roadAlbedo: makeTexture(road.albedo, s, true),
    roadRoughness: makeTexture(road.rough, s, false),
    roadNormal: makeTexture(road.normal, s, false),
    concrete: makeTexture(conc.albedo, s, true),
    concreteNormal: makeTexture(conc.normal, s, false),
    roadDecals: makeTexture(decals, s, true),
  };
  cacheSize = s;
  lastMs = now() - t0;
  return cache;
}

/** Free the GPU handles and drop the cache. Safe to call when nothing exists. */
export function disposeDetailTextures(): void {
  if (!cache) return;
  for (const tex of Object.values(cache) as THREE.DataTexture[]) tex.dispose();
  cache = null;
  cacheSize = 0;
}

/** Wall-clock milliseconds the last generation took. For the boot budget log. */
export function detailGenerationMs(): number {
  return lastMs;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Wrap a byte buffer as a tiling, mipmapped, anisotropic DataTexture.
 *
 * Mipmaps are not optional. A 512-pixel asphalt tile viewed at a grazing angle
 * down a kilometre of road undersamples by two orders of magnitude; without a
 * mip chain the aggregate turns into a boiling moire field that the bloom pass
 * then amplifies into flashing. Anisotropy is what stops it also going to mush
 * in the along-road direction, which is the direction the player is looking.
 */
function makeTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // three clamps this to the device maximum at upload, so asking for 8 on
  // hardware that only manages 4 is harmless.
  tex.anisotropy = 8;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// scalar helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Smoothstep of an already-normalised 0..1 parameter. Hot-loop form. */
function ss01(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

function to8(v: number): number {
  const n = (v * 255 + 0.5) | 0;
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * mulberry32. Small, fast, and structureless enough that no pattern shows up in
 * the aggregate scatter. Seeded, so the road is bit-identical on every run —
 * "why does the texture look different on my phone" is a bug report nobody can
 * reproduce.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// periodic noise
//
// Every octave is built by generating a small lattice of random values (or
// gradients) and interpolating it up to full resolution. Because the lattice
// index is taken modulo the cell count, the result is EXACTLY periodic over the
// tile with no seam-hiding tricks. It is also far faster than evaluating a hash
// per pixel: the per-axis cell indices and interpolation weights are computed
// once into small tables, so the inner loop is four loads and three lerps.
// ---------------------------------------------------------------------------

interface Axis {
  /** Lattice index of the cell this pixel falls in. */
  i0: Int32Array;
  /** Wrapped index of the next cell. */
  i1: Int32Array;
  /** Smoothstepped fraction, for interpolation. */
  s: Float32Array;
  /** Raw fraction, for gradient-noise dot products. */
  f: Float32Array;
}

function axisTable(size: number, cells: number, offset = 0): Axis {
  const i0 = new Int32Array(size);
  const i1 = new Int32Array(size);
  const s = new Float32Array(size);
  const f = new Float32Array(size);
  const k = cells / size;
  for (let x = 0; x < size; x++) {
    const p = (x + 0.5) * k + offset;
    const c = Math.floor(p);
    const fr = p - c;
    const w = ((c % cells) + cells) % cells;
    i0[x] = w;
    i1[x] = (w + 1) % cells;
    f[x] = fr;
    s[x] = fr * fr * (3 - 2 * fr);
  }
  return { i0, i1, s, f };
}

/**
 * Periodic value noise, accumulated into `dst`.
 *
 * cellsX and cellsY are separate on purpose. Setting them wildly apart is how a
 * surface gets DIRECTIONAL character — screed drag marks and tyre polish smear
 * along the road, rain streaks run down a wall — and one anisotropic octave
 * buys more realism than three more isotropic ones.
 */
function addValueNoise(
  dst: Float32Array,
  size: number,
  cellsX: number,
  cellsY: number,
  amp: number,
  rnd: () => number,
): void {
  const lat = new Float32Array(cellsX * cellsY);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd() * amp;
  const ax = axisTable(size, cellsX);
  const ay = axisTable(size, cellsY);
  const ax0 = ax.i0;
  const ax1 = ax.i1;
  const axs = ax.s;
  for (let y = 0; y < size; y++) {
    const r0 = ay.i0[y] * cellsX;
    const r1 = ay.i1[y] * cellsX;
    const wy = ay.s[y];
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a0 = ax0[x];
      const a1 = ax1[x];
      const wx = axs[x];
      const p0 = lat[r0 + a0];
      const p1 = lat[r1 + a0];
      const v0 = p0 + (lat[r0 + a1] - p0) * wx;
      const v1 = p1 + (lat[r1 + a1] - p1) * wx;
      dst[row + x] += v0 + (v1 - v0) * wy;
    }
  }
}

/**
 * Periodic gradient (Perlin) noise, accumulated into `dst`, remapped to 0..1
 * before scaling by `amp`.
 *
 * Different character from value noise: zero-crossing ridges rather than blobby
 * cells. Mixing the two is what stops a surface reading as one fbm smeared over
 * everything, which is the specific failure being fixed here.
 */
function addGradientNoise(
  dst: Float32Array,
  size: number,
  cellsX: number,
  cellsY: number,
  amp: number,
  rnd: () => number,
): void {
  const count = cellsX * cellsY;
  const gx = new Float32Array(count);
  const gy = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const ax = axisTable(size, cellsX);
  const ay = axisTable(size, cellsY);
  const k = amp * 0.7071;
  const bias = amp * 0.5;
  for (let y = 0; y < size; y++) {
    const r0 = ay.i0[y] * cellsX;
    const r1 = ay.i1[y] * cellsX;
    const fy = ay.f[y];
    const fy1 = fy - 1;
    const wy = ay.s[y];
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a0 = ax.i0[x];
      const a1 = ax.i1[x];
      const fx = ax.f[x];
      const fx1 = fx - 1;
      const wx = ax.s[x];
      const p00 = r0 + a0;
      const p10 = r0 + a1;
      const p01 = r1 + a0;
      const p11 = r1 + a1;
      const n00 = gx[p00] * fx + gy[p00] * fy;
      const n10 = gx[p10] * fx1 + gy[p10] * fy;
      const n01 = gx[p01] * fx + gy[p01] * fy1;
      const n11 = gx[p11] * fx1 + gy[p11] * fy1;
      const v0 = n00 + (n10 - n00) * wx;
      const v1 = n01 + (n11 - n01) * wx;
      dst[row + x] += (v0 + (v1 - v0) * wy) * k + bias;
    }
  }
}

/**
 * Periodic Worley F2-F1, 0..1.
 *
 * F2-F1 rather than F1 on purpose: F1 gives round blobs on a jittered grid,
 * which the eye reads instantly as polka dots. F2-F1 gives cell WALLS — a
 * crazed, irregular network with no dominant spot frequency, which is what
 * ravelling and blotchy weathering actually look like.
 */
function worleyField(res: number, cells: number, rnd: () => number): Float32Array {
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = cy * cells + cx;
      px[i] = (cx + rnd()) / cells;
      py[i] = (cy + rnd()) / cells;
    }
  }
  const out = new Float32Array(res * res);
  const inv = 1 / res;
  for (let y = 0; y < res; y++) {
    const fy = (y + 0.5) * inv;
    const cy = Math.floor(fy * cells);
    for (let x = 0; x < res; x++) {
      const fx = (x + 0.5) * inv;
      const cx = Math.floor(fx * cells);
      let b1 = 1e9;
      let b2 = 1e9;
      for (let oy = -1; oy <= 1; oy++) {
        const jy = (((cy + oy) % cells) + cells) % cells;
        for (let ox = -1; ox <= 1; ox++) {
          const jx = (((cx + ox) % cells) + cells) % cells;
          const i = jy * cells + jx;
          let dx = px[i] - fx;
          let dy = py[i] - fy;
          if (dx > 0.5) dx -= 1;
          else if (dx < -0.5) dx += 1;
          if (dy > 0.5) dy -= 1;
          else if (dy < -0.5) dy += 1;
          const d = dx * dx + dy * dy;
          if (d < b1) {
            b2 = b1;
            b1 = d;
          } else if (d < b2) {
            b2 = d;
          }
        }
      }
      out[y * res + x] = clamp01((Math.sqrt(b2) - Math.sqrt(b1)) * cells * 1.35);
    }
  }
  return out;
}

/** Periodic bilinear upsample of a square field, ADDED into `dst` with a gain. */
function upsampleAdd(
  dst: Float32Array,
  src: Float32Array,
  res: number,
  size: number,
  gain: number,
): void {
  if (res === size) {
    for (let i = 0; i < dst.length; i++) dst[i] += src[i] * gain;
    return;
  }
  const ax = axisTable(size, res, -0.5);
  const ay = axisTable(size, res, -0.5);
  for (let y = 0; y < size; y++) {
    const r0 = ay.i0[y] * res;
    const r1 = ay.i1[y] * res;
    const wy = ay.s[y];
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a0 = ax.i0[x];
      const a1 = ax.i1[x];
      const wx = ax.s[x];
      const p0 = src[r0 + a0];
      const p1 = src[r1 + a0];
      const v0 = p0 + (src[r0 + a1] - p0) * wx;
      const v1 = p1 + (src[r1 + a1] - p1) * wx;
      dst[row + x] += (v0 + (v1 - v0) * wy) * gain;
    }
  }
}

/**
 * Separable box blur with wrap-around, O(n) per pass. Caller supplies both
 * buffers so the hot path allocates nothing.
 */
function blurWrap(
  src: Float32Array,
  dst: Float32Array,
  tmp: Float32Array,
  size: number,
  radius: number,
): void {
  const invW = 1 / (radius * 2 + 1);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[row + (((k % size) + size) % size)];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = sum * invW;
      sum += src[row + ((x + radius + 1) % size)] - src[row + ((x - radius + size) % size)];
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[(((k % size) + size) % size) * size + x];
    for (let y = 0; y < size; y++) {
      dst[y * size + x] = sum * invW;
      sum += tmp[((y + radius + 1) % size) * size + x] - tmp[((y - radius + size) % size) * size + x];
    }
  }
}

// ---------------------------------------------------------------------------
// structured features
// ---------------------------------------------------------------------------

interface StoneOpts {
  /** Stone radius as a fraction of the cell. */
  rMin: number;
  rMax: number;
  /** Stone height above the binder film. */
  hMin: number;
  hMax: number;
}

/**
 * Scatter aggregate.
 *
 * One stone per jittered cell, drawn as a rotated ellipse with a HARD rim and a
 * domed top, max-composited so stones occlude each other instead of summing
 * into a lumpy average. The hard rim is the point: aggregate in asphalt is
 * crushed rock with fractured faces, and a smooth bump field reads as gravel
 * pudding rather than as a wearing course.
 *
 * `tone` carries a per-stone random so the albedo pass can give each chip its
 * own rock colour — pale limestone scattered through a near-black matrix is
 * most of what the eye reads as "tarmac" at a glance.
 *
 * Writes wrap. The bounding box is the true rotated-ellipse AABB rather than a
 * square of the major radius, which is worth roughly a third of the cost at
 * these aspect ratios.
 */
function splatStones(
  height: Float32Array,
  tone: Float32Array,
  size: number,
  cells: number,
  rnd: () => number,
  opts: StoneOpts,
): void {
  const cell = size / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const jx = (cx + rnd()) * cell;
      const jy = (cy + rnd()) * cell;
      const r = cell * mix(opts.rMin, opts.rMax, rnd());
      const asp = 0.62 + rnd() * 0.76;
      const ang = rnd() * Math.PI;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const rx = r * asp;
      const ry = r / asp;
      const irx = 1 / rx;
      const iry = 1 / ry;
      const h = mix(opts.hMin, opts.hMax, rnd());
      const t = rnd();
      // Rim softness of about one pixel, in the normalised radius the ellipse
      // test works in.
      const edge = clamp01(1.1 / Math.max(rx, ry, 0.5));
      const inner = 1 - edge;
      const iEdge = 1 / Math.max(edge, 1e-3);
      const hx = Math.sqrt(rx * rx * ca * ca + ry * ry * sa * sa) + 1;
      const hy = Math.sqrt(rx * rx * sa * sa + ry * ry * ca * ca) + 1;
      const y0 = Math.floor(jy - hy);
      const y1 = Math.ceil(jy + hy);
      const x0 = Math.floor(jx - hx);
      const x1 = Math.ceil(jx + hx);
      for (let py = y0; py <= y1; py++) {
        let wy = py % size;
        if (wy < 0) wy += size;
        const row = wy * size;
        const dy0 = py + 0.5 - jy;
        const ax = dy0 * sa * irx;
        const ay = dy0 * ca * iry;
        for (let px = x0; px <= x1; px++) {
          const dx0 = px + 0.5 - jx;
          const u = dx0 * ca * irx + ax;
          const v = -dx0 * sa * iry + ay;
          const d2 = u * u + v * v;
          if (d2 >= 1) continue;
          const d = Math.sqrt(d2);
          const rim = d < inner ? 1 : 1 - ss01((d - inner) * iEdge);
          const hh = h * (0.42 + 0.58 * Math.sqrt(1 - d2)) * rim;
          let wx = px % size;
          if (wx < 0) wx += size;
          const i = row + wx;
          if (hh > height[i]) {
            height[i] = hh;
            tone[i] = t;
          }
        }
      }
    }
  }
}

/** Stamp a soft-edged circular groove into a positive-depth field. */
function stampGroove(depth: Float32Array, size: number, cx: number, cy: number, r: number, d0: number): void {
  const rad = Math.ceil(r + 1);
  const x0 = Math.floor(cx) - rad;
  const y0 = Math.floor(cy) - rad;
  const inv = 1 / Math.max(r, 0.35);
  for (let py = y0; py <= y0 + rad * 2; py++) {
    let wy = py % size;
    if (wy < 0) wy += size;
    const row = wy * size;
    const dy = py + 0.5 - cy;
    for (let px = x0; px <= x0 + rad * 2; px++) {
      const dx = px + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy * dy) * inv;
      if (d >= 1) continue;
      const p = (1 - ss01((d - 0.3) / 0.7)) * d0;
      let wx = px % size;
      if (wx < 0) wx += size;
      const i = row + wx;
      if (p > depth[i]) depth[i] = p;
    }
  }
}

interface CrackOpts {
  count: number;
  /** Steps before a walker dies. */
  life: number;
  step: number;
  width: number;
  depth: number;
  /** Radians of angular acceleration per step. Small — cracks run STRAIGHT. */
  wander: number;
  /** Per-step probability of throwing a branch. */
  branch: number;
}

/**
 * Carve a branching crack network into a positive-depth field.
 *
 * Cracks are the feature procedural noise cannot fake, because a crack is not a
 * field — it is a PROCESS. A fatigue crack propagates along a stress line,
 * wanders slightly, and throws branches at shallow angles; that topology is
 * what the eye recognises as damage. Thresholded fbm gives closed blobby loops
 * instead, which is why so many procedural roads look like they have veins.
 *
 * The wander term is deliberately small and strongly damped. Letting a walker
 * turn freely produces curling scribbles that read as handwriting, which is a
 * mistake this file made once already.
 */
function carveCracks(depth: Float32Array, size: number, rnd: () => number, opts: CrackOpts): void {
  interface Walker {
    x: number;
    y: number;
    a: number;
    life: number;
    w: number;
    depth: number;
  }
  const stack: Walker[] = [];
  for (let i = 0; i < opts.count; i++) {
    stack.push({
      x: rnd() * size,
      y: rnd() * size,
      a: rnd() * Math.PI * 2,
      life: opts.life * (0.55 + rnd() * 0.9),
      w: opts.width * (0.75 + rnd() * 0.5),
      depth: opts.depth,
    });
  }
  let guard = 0;
  while (stack.length > 0 && guard++ < 400) {
    const c = stack.pop();
    if (!c) break;
    let x = c.x;
    let y = c.y;
    let a = c.a;
    let av = 0;
    const life = Math.max(4, Math.round(c.life));
    for (let s = 0; s < life; s++) {
      av = av * 0.90 + (rnd() - 0.5) * opts.wander;
      a += av;
      x += Math.cos(a) * opts.step;
      y += Math.sin(a) * opts.step;
      const t = s / life;
      const w = c.w * (1 - t * 0.7);
      const d = c.depth * (1 - t * 0.55);
      stampGroove(depth, size, x, y, w, d);
      if (rnd() < opts.branch && life - s > 10 && stack.length < 64) {
        stack.push({
          x,
          y,
          // Branches leave at a shallow angle. A right-angle branch reads as a
          // road marking, not as a fracture.
          a: a + (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.45),
          life: (life - s) * 0.55,
          w: w * 0.7,
          depth: d * 0.8,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// normal encoding
// ---------------------------------------------------------------------------

/**
 * Derive a tangent-space normal map from a real height field, wrapping at the
 * tile edge.
 *
 * This is the most important function in the file. At dusk, with the sun a few
 * degrees above the horizon, almost everything that makes tarmac look
 * photographed is raking light across aggregate relief — the lit face of each
 * chip and the shadow behind it. Faking that with noise in the normal channels
 * gives high-frequency sparkle with no coherent light direction, which reads as
 * video compression rather than as stone.
 *
 * Sobel rather than a plain central difference: it is a smoothed derivative, so
 * it does the anti-staircase job a pre-blur would do without costing two extra
 * full-frame passes and without smearing away the chip rims that carry the
 * whole effect.
 *
 * Height goes into alpha so a parallax or POM pass can use the same texture.
 */
function encodeNormal(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const k = strength * 0.25;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const rowU = ((y + 1) % size) * size;
    const rowD = ((y - 1 + size) % size) * size;
    for (let x = 0; x < size; x++) {
      const xp = (x + 1) % size;
      const xm = (x - 1 + size) % size;
      const dx =
        (height[rowD + xp] + 2 * height[row + xp] + height[rowU + xp] -
          height[rowD + xm] - 2 * height[row + xm] - height[rowU + xm]) * k;
      const dy =
        (height[rowU + xm] + 2 * height[rowU + x] + height[rowU + xp] -
          height[rowD + xm] - 2 * height[rowD + x] - height[rowD + xp]) * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (row + x) * 4;
      out[i] = to8(-dx * inv * 0.5 + 0.5);
      out[i + 1] = to8(-dy * inv * 0.5 + 0.5);
      out[i + 2] = to8(inv * 0.5 + 0.5);
      out[i + 3] = to8(height[row + x]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// road
// ---------------------------------------------------------------------------

interface RoadMaps {
  albedo: Uint8Array;
  rough: Uint8Array;
  normal: Uint8Array;
}

function buildRoad(size: number, seed: number): RoadMaps {
  const n = size * size;
  const rnd = mulberry32(seed);
  const px = ROAD_TILE_METRES / size; // metres per pixel
  const lowRes = Math.max(32, size >> 2);

  // --- binder --------------------------------------------------------------
  // Six octaves with genuinely different characters. One fbm of one function is
  // what reads as plastic; a laying swell, a Perlin ridge field, a screed-drag
  // anisotropy and two grades of sand do not. The low three are built at
  // quarter resolution and folded in during a single upsample — they have no
  // detail above that scale by definition, so evaluating them per texel would
  // be three full passes bought for nothing.
  const binder = new Float32Array(n);
  {
    const low = new Float32Array(lowRes * lowRes);
    addValueNoise(low, lowRes, 3, 3, 0.42, rnd); // 1.3 m rolling swells
    addGradientNoise(low, lowRes, 9, 9, 0.30, rnd); // 45 cm undulation
    addValueNoise(low, lowRes, 26, 26, 0.16, rnd); // 15 cm mastic clumping
    upsampleAdd(binder, low, lowRes, size, 1);
  }
  addValueNoise(binder, size, 88, 11, 0.12, rnd); // screed drag, ALONG the road
  addValueNoise(binder, size, 210, 210, 0.10, rnd); // sand in the matrix

  // --- ravelling -----------------------------------------------------------
  // Where the bitumen film has worn thin the aggregate stands proud and pale;
  // where it is still fat the surface is smooth and near-black. That contrast at
  // half-metre to two-metre scale is what stops a road being one flat value.
  const expose = new Float32Array(n);
  {
    const w1 = worleyField(lowRes, 5, rnd);
    const w2 = worleyField(lowRes, 13, rnd);
    for (let i = 0; i < w1.length; i++) w1[i] = w1[i] * 0.62 + w2[i] * 0.38;
    upsampleAdd(expose, w1, lowRes, size, 1);
  }
  for (let i = 0; i < n; i++) {
    // Bias high: most of a worn carriageway shows its aggregate. The value is
    // reused later for roughness, so it stays a field rather than a local.
    expose[i] = clamp01(0.38 + expose[i] * 1.15 + (binder[i] - 0.5) * 0.35);
  }

  // --- aggregate -----------------------------------------------------------
  const stoneH = new Float32Array(n);
  const stoneTone = new Float32Array(n);
  // Coarse chips at roughly 30-55 mm, which is about twice true scale. At 4 m
  // per tile a real 14 mm chip is under two pixels across and simply cannot be
  // drawn; the readable size is the honest art call, and mipping pulls it back
  // toward the correct average at the distances where the exaggeration would
  // show. Anything smaller degenerates into salt-and-pepper noise, which is
  // exactly the "clean procedural maths" look being fixed.
  splatStones(stoneH, stoneTone, size, Math.max(8, Math.round(size / 6.0)), rnd, {
    rMin: 0.34,
    rMax: 0.62,
    hMin: 0.62,
    hMax: 1.0,
  });
  // Second grade filling between them, still large enough to survive a mip.
  splatStones(stoneH, stoneTone, size, Math.max(8, Math.round(size / 3.2)), rnd, {
    rMin: 0.38,
    rMax: 0.66,
    hMin: 0.26,
    hMax: 0.56,
  });

  // --- longitudinal construction joint -------------------------------------
  // A paving machine lays about one lane at a time, so there is a cold joint
  // every 3.5-4 m running along the carriageway, usually sealed with bitumen.
  // Placed AT the tile edge on purpose: a hard feature straddling the wrap is
  // the cheapest permanent proof that the periodic noise is really periodic.
  //
  // Only the band around the joint is touched — computing two smoothsteps for
  // all 262144 texels to describe a feature 20 texels wide is pure waste.
  const jointMask = new Float32Array(n);
  const jointSeal = new Float32Array(n);
  {
    const wob = new Float32Array(size * 4);
    addValueNoise(wob, 2, 1, 9, 1, rnd); // periodic in Y, one column of use
    const wobble = new Float32Array(size);
    {
      const t = new Float32Array(size * size);
      addValueNoise(t, size, 1, 11, 1, rnd);
      for (let y = 0; y < size; y++) wobble[y] = t[y * size];
    }
    const grooveHalf = 0.011 / px; // 11 mm groove
    const sealHalf = 0.055 / px; // 55 mm sealant band
    const win = Math.ceil(sealHalf + 6);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      const off = (wobble[y] - 0.5) * (0.05 / px);
      for (let o = -win; o <= win; o++) {
        let wx = o % size;
        if (wx < 0) wx += size;
        const d = Math.abs(o + 0.5 - off);
        const i = row + wx;
        jointMask[i] = 1 - ss01((d - grooveHalf * 0.5) / (grooveHalf * 1.1));
        jointSeal[i] = 1 - ss01((d - sealHalf * 0.55) / (sealHalf * 0.45));
      }
    }
  }

  // --- crack network -------------------------------------------------------
  const crack = new Float32Array(n);
  carveCracks(crack, size, rnd, {
    count: 4,
    life: size * 1.6,
    step: 1.7,
    width: 0.017 / px,
    depth: 1,
    wander: 0.13,
    branch: 0.010,
  });
  carveCracks(crack, size, rnd, {
    count: 7,
    life: size * 0.3,
    step: 1.4,
    width: 0.009 / px,
    depth: 0.62,
    wander: 0.22,
    branch: 0.022,
  });

  // --- patch repair --------------------------------------------------------
  // Deliberately SMALL and low contrast. A tiling texture repeats its patch
  // every 4 m, and a big loud one reads as wallpaper within twenty metres of
  // driving. The loud, sparse patch lives in the decal atlas instead, where the
  // client can scatter it at a believable spacing.
  const patch = new Float32Array(n);
  const patchSeam = new Float32Array(n);
  {
    const ragged = new Float32Array(n);
    addValueNoise(ragged, size, 34, 34, 1, rnd);
    const pw = size * 0.30;
    const ph = size * 0.34;
    const pcx = size * 0.70;
    const pcy = size * 0.03; // straddles the along-road wrap, again on purpose
    const half = size * 0.5;
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let dy = y + 0.5 - pcy;
      if (dy > half) dy -= size;
      else if (dy < -half) dy += size;
      const ady = Math.abs(dy) - ph * 0.5;
      if (ady > 8) continue; // whole row is well outside the patch
      for (let x = 0; x < size; x++) {
        let dx = x + 0.5 - pcx;
        if (dx > half) dx -= size;
        else if (dx < -half) dx += size;
        const e = Math.max(Math.abs(dx) - pw * 0.5, ady) + (ragged[row + x] - 0.5) * 5;
        if (e > 6) continue;
        // Chebyshev field: a rectangle, but with a ragged saw-cut edge.
        patch[row + x] = 1 - ss01((e + 1.5) / 3);
        const ae = Math.abs(e);
        patchSeam[row + x] = (1 - ss01((ae - 1.6) / 1.8)) * (1 - ss01((ae - 3.4) / 1.6));
      }
    }
  }

  // --- wear and polish -----------------------------------------------------
  // Two broad longitudinal bands where tyres have burnished the surface. Their
  // lateral period is the tile's 4 m, NOT the 3.65 m lane, so they are kept low
  // contrast and generic; the lane-locked wheel-track term stays analytic in
  // road.ts where it can actually be registered to lane geometry. What this map
  // contributes instead is the directional STREAKING of that wear, which is
  // real, tiles perfectly, and is most of what the eye reads anyway.
  //
  // The band profile is a WRAPPED gaussian. An unwrapped one leaves a step at
  // the tile edge, which is a seam in every map at once.
  const band = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size;
    let a = u - 0.24;
    if (a > 0.5) a -= 1;
    else if (a < -0.5) a += 1;
    let b = u - 0.74;
    if (b > 0.5) b -= 1;
    else if (b < -0.5) b += 1;
    band[x] = Math.min(1, Math.exp(-(a * 4.6) ** 2) + Math.exp(-(b * 4.6) ** 2));
  }
  const wear = new Float32Array(n);
  addValueNoise(wear, size, 56, 7, 0.6, rnd);
  addValueNoise(wear, size, 150, 17, 0.4, rnd);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      wear[row + x] = clamp01(band[x] * (0.3 + 0.75 * wear[row + x]));
    }
  }

  // --- oil, sand -----------------------------------------------------------
  // Drips accumulate where vehicles stand and creep: narrow, very dark, running
  // along the direction of travel, plus a few genuinely irregular soaked
  // patches. Sparse — a road uniformly covered in oil is a car park.
  const oil = new Float32Array(n);
  addValueNoise(oil, size, 20, 3, 0.55, rnd);
  addValueNoise(oil, size, 58, 9, 0.45, rnd);
  const dust = new Float32Array(n);
  {
    const low = new Float32Array(lowRes * lowRes);
    addValueNoise(low, lowRes, 5, 5, 0.6, rnd);
    addGradientNoise(low, lowRes, 19, 19, 0.4, rnd);
    upsampleAdd(dust, low, lowRes, size, 1);
  }
  const blotch = new Float32Array(n);
  {
    const low = new Float32Array(lowRes * lowRes);
    addValueNoise(low, lowRes, 4, 4, 0.6, rnd);
    addValueNoise(low, lowRes, 11, 11, 0.4, rnd);
    upsampleAdd(blotch, low, lowRes, size, 1);
  }
  for (let i = 0; i < n; i++) {
    // Threshold high so only a few streaks and stains survive, and let the
    // mid-frequency field chew the edges so nothing has a clean boundary.
    const streak = ss01((oil[i] - 0.74) / 0.2);
    const soak = ss01((blotch[i] - 0.70) / 0.16) * ss01((oil[i] - 0.35) / 0.4);
    oil[i] = clamp01(streak * 0.85 + soak * 0.9);
  }

  // --- composite height ----------------------------------------------------
  // Aggregate DOMINATES. The low-frequency swell is a tenth of the amplitude
  // because it is the chip relief that catches the sun, and the previous
  // balance produced a normal map so flat it may as well not have shipped.
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const e = expose[i];
    let h = 0.20 * binder[i] + 0.66 * stoneH[i] * e;
    // Patched asphalt is finer graded and sits slightly proud, with a lipped seam.
    const p = patch[i];
    if (p > 0) h = mix(h, h * 0.5 + 0.20, p * 0.85) - patchSeam[i] * 0.22;
    // Polished tracks: lower AND flatter. Flattening the relief is what makes a
    // wheel track read as worn rather than merely darkened.
    const w = wear[i];
    if (w > 0) h = mix(h, h * 0.55 + 0.07, w * 0.5);
    // Joint groove, then the sealant that partly fills it back up.
    const jm = jointMask[i];
    if (jm > 0) h -= jm * 0.55;
    h += jointSeal[i] * (1 - jm) * 0.05;
    h -= crack[i] * 0.55;
    height[i] = clamp01(h);
  }

  // --- cavity --------------------------------------------------------------
  // Cheap ambient occlusion: how far below the local average a texel sits. Two
  // radii, because a chip shadows its immediate neighbours differently from the
  // way a hollow shadows a whole patch.
  const near = new Float32Array(n);
  const far = new Float32Array(n);
  const tmp = new Float32Array(n);
  blurWrap(height, near, tmp, size, Math.max(1, Math.round(size / 170)));
  blurWrap(height, far, tmp, size, Math.max(2, Math.round(size / 26)));

  // --- grit ----------------------------------------------------------------
  const grit = new Float32Array(n);
  addValueNoise(grit, size, 190, 190, 0.62, rnd);
  addValueNoise(grit, size, 61, 61, 0.38, rnd);

  // --- albedo + roughness --------------------------------------------------
  //
  // Albedo is authored straight in sRGB. Real dry asphalt photographs around
  // 0.16-0.40 with pale chips reaching 0.55; road.ts then scales what it samples
  // by 0.35 to land back at the correct 0.02-0.05 linear reflectance, so this
  // map has to look like a photograph, not like a linear albedo.
  //
  // Roughness variation matters as much as albedo. A constant value reads as
  // one plastic material no matter how good the colour is, and at dusk on a wet
  // road it is the difference between a long mirror streak down the lane and a
  // matte grey slab. road.ts consumes .r as (1 - rough * 0.5) applied to
  // wetness, so smooth areas correctly stay wet and glossy while coarse ones
  // dry out first.
  //
  // One fused pass: eleven separate loops over a quarter of a million texels is
  // eleven cache walks, and everything here is available at once.
  const albedo = new Uint8Array(n * 4);
  const rough = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = stoneTone[i];
    const e = expose[i];
    const bd = binder[i];
    const hv = height[i];

    // Cavity occlusion.
    const cav = clamp01(
      1 - clamp01((near[i] - hv) * 3.0) * 0.8 - clamp01((far[i] - hv) * 1.6) * 0.35,
    );

    // Bitumen matrix: near-black, warmer where dusty, cooler where fresh.
    const matrix = 0.135 + 0.115 * bd;
    const du = dust[i];
    let r = matrix * (1 + 0.09 * du);
    let g = matrix * 0.985;
    let b = matrix * (1.03 - 0.11 * du);

    // Aggregate. Four rock types, because a single stone colour is instantly
    // legible as a repeated stamp: dark basalt, mid granite, pale limestone,
    // and the occasional reddish chip.
    let sr: number;
    let sg: number;
    let sb: number;
    if (t < 0.32) {
      sr = 0.215;
      sg = 0.212;
      sb = 0.222;
    } else if (t < 0.70) {
      sr = 0.375;
      sg = 0.368;
      sb = 0.358;
    } else if (t < 0.93) {
      sr = 0.545;
      sg = 0.530;
      sb = 0.492;
    } else {
      sr = 0.430;
      sg = 0.335;
      sb = 0.278;
    }
    // Per-chip value jitter so even same-type chips differ, and a polish term
    // so the exposed crown of a chip is paler than its flanks.
    const jit = 0.82 + 0.34 * ((t * 37.1) % 1) + 0.22 * stoneH[i];
    const cover = clamp01(stoneH[i] * 2.4) * e;
    r = mix(r, sr * jit, cover);
    g = mix(g, sg * jit, cover);
    b = mix(b, sb * jit, cover);

    // Base roughness: open-graded, aggregate-exposed surface is very rough.
    let rg = 0.70 + 0.26 * e + (grit[i] - 0.5) * 0.10;

    // Fresh patch: blacker, finer, not yet dusted.
    const p = patch[i];
    if (p > 0) {
      const pf = p * 0.7;
      const fill = 0.105 + 0.06 * bd;
      r = mix(r, fill, pf);
      g = mix(g, fill * 0.985, pf);
      b = mix(b, fill * 1.03, pf);
      rg = mix(rg, 0.66, p * 0.6);
      // The saw-cut seam is a dark line with a bead of tar on it.
      const sm = patchSeam[i] * 0.85;
      r = mix(r, 0.068, sm);
      g = mix(g, 0.065, sm);
      b = mix(b, 0.070, sm);
      rg = mix(rg, 0.34, patchSeam[i] * 0.7);
    }

    // Sealed construction joint: a glossy bitumen band with a groove down it.
    const sl = jointSeal[i];
    if (sl > 0) {
      const s8 = sl * 0.8;
      r = mix(r, 0.098, s8);
      g = mix(g, 0.094, s8);
      b = mix(b, 0.096, s8);
      rg = mix(rg, 0.28, sl * 0.85);
      const jm = jointMask[i];
      if (jm > 0) {
        r = mix(r, 0.050, jm);
        g = mix(g, 0.048, jm);
        b = mix(b, 0.051, jm);
        rg = mix(rg, 0.97, jm * 0.8);
      }
    }

    // Polished tracks: darker, and the chips lose contrast because they have
    // been worn flat and burnished by rubber.
    const w = wear[i];
    if (w > 0) {
      r = mix(r, r * 0.70 + 0.011, w);
      g = mix(g, g * 0.70 + 0.010, w);
      b = mix(b, b * 0.70 + 0.012, w);
      // The big one: burnished tarmac at 0.36 next to coarse shoulder at 0.95
      // is what puts a long specular streak down the lane the player is in.
      rg = mix(rg, 0.36, w * 0.85);
    }

    // Cracks are voids full of shadow and grit.
    const c = crack[i];
    if (c > 0) {
      const c9 = clamp01(c) * 0.9;
      r = mix(r, 0.042, c9);
      g = mix(g, 0.040, c9);
      b = mix(b, 0.042, c9);
      rg = mix(rg, 0.99, c9 * 0.9);
    }

    // Oil: near-black, slightly brown, stains rather than covers, and slick.
    const o = oil[i];
    if (o > 0) {
      const o8 = o * 0.82;
      r = mix(r, 0.048, o8);
      g = mix(g, 0.041, o8);
      b = mix(b, 0.037, o8);
      rg = mix(rg, 0.24, o * 0.72);
    }

    // Windblown sand caught in the surface. This is Dubai; it is everywhere.
    const dm = ss01((du - 0.62) / 0.3) * (1 - w * 0.7) * (1 - p);
    if (dm > 0) {
      const d4 = dm * 0.42;
      r = mix(r, 0.455, d4);
      g = mix(g, 0.405, d4);
      b = mix(b, 0.330, d4);
      rg = mix(rg, 0.97, dm * 0.4);
    }

    // Standing water sits in the low ground and in the ruts. Handed to the
    // shader separately so puddles can be driven by weather rather than baked
    // into roughness where they could never dry out.
    const water = clamp01(clamp01((far[i] - hv) * 3.2 + (0.42 - hv) * 0.9) * 0.85 + w * 0.4);

    // A little contact shadow baked into the albedo keeps the surface reading
    // as relief when the light goes flat; the real occlusion still ships
    // separately in alpha and in the roughness map's green channel.
    const ao = 1 - (1 - cav) * 0.55;
    const j = i * 4;
    albedo[j] = to8(r * ao);
    albedo[j + 1] = to8(g * ao);
    albedo[j + 2] = to8(b * ao);
    albedo[j + 3] = to8(cav);
    rough[j] = to8(rg);
    rough[j + 1] = to8(cav);
    rough[j + 2] = to8(water);
    rough[j + 3] = 255;
  }

  return { albedo, rough, normal: encodeNormal(height, size, 3.4) };
}

// ---------------------------------------------------------------------------
// concrete
// ---------------------------------------------------------------------------

interface ConcreteMaps {
  albedo: Uint8Array;
  normal: Uint8Array;
}

function buildConcrete(size: number, seed: number): ConcreteMaps {
  const n = size * size;
  const rnd = mulberry32(seed);
  const px = CONCRETE_TILE_METRES / size;
  const lowRes = Math.max(32, size >> 2);

  // --- body ----------------------------------------------------------------
  const body = new Float32Array(n);
  {
    const low = new Float32Array(lowRes * lowRes);
    addValueNoise(low, lowRes, 3, 3, 0.40, rnd); // pour-to-pour colour drift
    addGradientNoise(low, lowRes, 11, 11, 0.26, rnd);
    addValueNoise(low, lowRes, 29, 29, 0.16, rnd);
    upsampleAdd(body, low, lowRes, size, 1);
  }
  addValueNoise(body, size, 96, 96, 0.10, rnd); // form-face grain
  addValueNoise(body, size, 240, 240, 0.08, rnd); // cement fines

  // Ghosting: aggregate showing faintly through the skin, plus blotchy damp.
  const mottle = new Float32Array(n);
  {
    const w1 = worleyField(lowRes, 6, rnd);
    const w2 = worleyField(Math.max(64, size >> 1), 22, rnd);
    upsampleAdd(mottle, w1, lowRes, size, 0.6);
    upsampleAdd(mottle, w2, Math.max(64, size >> 1), size, 0.4);
  }

  const height = new Float32Array(n);
  // The form face is nominally flat, so ALL of the concrete relief has to come
  // from the fine grain and the cast features. Giving it too little amplitude
  // is what produced a normal map of pure lavender last time round.
  for (let i = 0; i < n; i++) height[i] = 0.45 + body[i] * 0.30 + mottle[i] * 0.05;

  // --- shutter boards ------------------------------------------------------
  // Concrete cast against timber shuttering keeps the record of the boards: a
  // step and a grout line every board width, and each board leaves its own
  // slightly different surface. Six boards to a 2 m tile is 333 mm stock.
  const BOARDS = 6;
  const boardH = size / BOARDS;
  const boardTone = new Float32Array(BOARDS);
  const boardStep = new Float32Array(BOARDS);
  const boardRough = new Float32Array(BOARDS);
  for (let i = 0; i < BOARDS; i++) {
    boardTone[i] = rnd();
    boardStep[i] = (rnd() - 0.5) * 0.075;
    boardRough[i] = rnd();
  }
  const boardId = new Int32Array(size);
  const boardV = new Float32Array(size);
  for (let y = 0; y < size; y++) {
    const bi = Math.floor(y / boardH);
    boardId[y] = bi % BOARDS;
    boardV[y] = (y - bi * boardH) / boardH;
  }

  // --- panel reveals -------------------------------------------------------
  // A 2 m panel grid with the joints on the tile edges, so they cross the wrap
  // and prove it. Windowed for the same reason the road joint is.
  const reveal = new Float32Array(n);
  {
    const half = 0.014 / px;
    const win = Math.ceil(half * 2 + 4);
    for (let o = -win; o <= win; o++) {
      let w = o % size;
      if (w < 0) w += size;
      const v = 1 - ss01((Math.abs(o + 0.5) - half * 0.6) / (half * 1.2));
      for (let k = 0; k < size; k++) {
        const a = w * size + k; // horizontal reveal at v = 0
        const b = k * size + w; // vertical reveal at u = 0
        if (v > reveal[a]) reveal[a] = v;
        if (v > reveal[b]) reveal[b] = v;
      }
    }
  }

  // --- form-tie holes ------------------------------------------------------
  // Regular 3 x 3 grid over the tile: 667 mm spacing, which is real formwork
  // practice. A grid of identical holes is one of the few places where perfect
  // regularity is CORRECT — it is manufactured, not weathered — and it is a
  // powerful scale cue, because the eye knows how big a tie hole is.
  const TIES = 3;
  const tieRing = new Float32Array(n);
  const tiePlug = new Float32Array(n);
  const tieRust: { x: number; y: number; strength: number }[] = [];
  {
    const spacing = size / TIES;
    const r = 0.016 / px; // 32 mm cone
    for (let ty = 0; ty < TIES; ty++) {
      for (let tx = 0; tx < TIES; tx++) {
        const cx = (tx + 0.5) * spacing + (rnd() - 0.5) * 2.5;
        const cy = (ty + 0.5) * spacing + (rnd() - 0.5) * 2.5;
        const plugged = rnd() < 0.7;
        if (rnd() < 0.5) tieRust.push({ x: cx, y: cy, strength: 0.45 + rnd() * 0.55 });
        const rad = Math.ceil(r * 1.5 + 2);
        for (let py = Math.floor(cy) - rad; py <= Math.floor(cy) + rad; py++) {
          let wy = py % size;
          if (wy < 0) wy += size;
          const row = wy * size;
          const dy = py + 0.5 - cy;
          for (let pxi = Math.floor(cx) - rad; pxi <= Math.floor(cx) + rad; pxi++) {
            const dx = pxi + 0.5 - cx;
            const d = Math.sqrt(dx * dx + dy * dy) / r;
            if (d > 1.35) continue;
            let wx = pxi % size;
            if (wx < 0) wx += size;
            const i = row + wx;
            // Recessed cone with a distinct seating ring at its lip.
            const cone = 1 - ss01((d - 0.2) / 0.9);
            if (cone > tieRing[i]) tieRing[i] = cone;
            if (plugged) {
              const p = 1 - ss01((d - 0.5) / 0.28);
              if (p > tiePlug[i]) tiePlug[i] = p;
            }
          }
        }
      }
    }
  }

  // --- blowholes -----------------------------------------------------------
  // Trapped air against the form face. Small, hard-edged, irregular, and the
  // detail that most reliably says "this was cast" rather than "this is a box".
  const blow = new Float32Array(n);
  {
    const count = Math.round(n * 0.0012);
    for (let i = 0; i < count; i++) {
      const cx = rnd() * size;
      const cy = rnd() * size;
      const r = (0.0015 + rnd() * rnd() * 0.008) / px;
      const rad = Math.ceil(r + 1.5);
      for (let py = Math.floor(cy) - rad; py <= Math.floor(cy) + rad; py++) {
        let wy = py % size;
        if (wy < 0) wy += size;
        const row = wy * size;
        const dy = py + 0.5 - cy;
        for (let pxi = Math.floor(cx) - rad; pxi <= Math.floor(cx) + rad; pxi++) {
          const dx = pxi + 0.5 - cx;
          const d = Math.sqrt(dx * dx + dy * dy) / Math.max(r, 0.4);
          if (d >= 1.1) continue;
          let wx = pxi % size;
          if (wx < 0) wx += size;
          const j = row + wx;
          const v = 1 - ss01((d - 0.55) / 0.5);
          if (v > blow[j]) blow[j] = v;
        }
      }
    }
  }

  // --- chipped arrises -----------------------------------------------------
  // Spalls along the reveals, where a corner has been knocked off and the
  // aggregate shows through pale.
  const spall = new Float32Array(n);
  {
    const count = Math.max(6, Math.round(size / 12));
    for (let i = 0; i < count; i++) {
      const onVertical = rnd() < 0.5;
      const along = rnd() * size;
      const cx = onVertical ? (rnd() - 0.5) * 4 : along;
      const cy = onVertical ? along : (rnd() - 0.5) * 4;
      const r = (0.012 + rnd() * 0.055) / px;
      const sx = 0.5 + rnd() * 0.8;
      const rx = onVertical ? r : r * sx;
      const ry = onVertical ? r * sx : r;
      const radX = Math.ceil(rx + 2);
      const radY = Math.ceil(ry + 2);
      for (let py = Math.floor(cy) - radY; py <= Math.floor(cy) + radY; py++) {
        let wy = py % size;
        if (wy < 0) wy += size;
        const row = wy * size;
        const dy = (py + 0.5 - cy) / ry;
        for (let pxi = Math.floor(cx) - radX; pxi <= Math.floor(cx) + radX; pxi++) {
          const dx = (pxi + 0.5 - cx) / rx;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= 1) continue;
          let wx = pxi % size;
          if (wx < 0) wx += size;
          const j = row + wx;
          const v = 1 - ss01((d - 0.4) / 0.6);
          if (v > spall[j]) spall[j] = v;
        }
      }
    }
  }

  // --- rain streaking ------------------------------------------------------
  // Water sheds off the ledge at the top of the tile and runs down, carrying
  // dirt with it. The streaks are narrow, vertical, of wildly varying length,
  // and they are what makes a concrete barrier look like it has stood outdoors
  // in Dubai for fifteen years rather than been extruded this morning.
  const streak = new Float32Array(n);
  {
    const seedF = new Float32Array(n);
    addValueNoise(seedF, size, 80, 2, 0.58, rnd);
    addValueNoise(seedF, size, 210, 5, 0.42, rnd);
    const lenCol = new Float32Array(size);
    {
      const t = new Float32Array(n);
      addValueNoise(t, size, 44, 1, 1, rnd);
      for (let x = 0; x < size; x++) lenCol[x] = 0.1 + t[x] * 0.75;
    }
    for (let y = 0; y < size; y++) {
      const row = y * size;
      // Distance BELOW the ledge at v = 1, so 0 at the ledge itself.
      const drop = (size - 1 - y) / size;
      const start = ss01(drop / 0.02);
      for (let x = 0; x < size; x++) {
        const len = lenCol[x];
        const fall = (1 - ss01((drop - len * 0.3) / (len * 0.7))) * start;
        if (fall <= 0) continue;
        streak[row + x] = clamp01(ss01((seedF[row + x] - 0.55) / 0.33) * fall);
      }
    }

    // --- efflorescence ----------------------------------------------------
    // Lime leached out by that same water and left as a white bloom,
    // concentrated where it gets in: the joints and the tie holes.
    const b = new Float32Array(n);
    {
      const low = new Float32Array(lowRes * lowRes);
      addValueNoise(low, lowRes, 7, 7, 0.6, rnd);
      addGradientNoise(low, lowRes, 21, 21, 0.4, rnd);
      upsampleAdd(b, low, lowRes, size, 1);
    }
    // Reuse seedF as the bloom output; it has done its job.
    for (let i = 0; i < n; i++) {
      const near = clamp01(reveal[i] * 1.8 + tieRing[i] * 1.3);
      seedF[i] = clamp01(ss01((b[i] - 0.5) / 0.34) * (0.28 + near * 1.1));
    }
    // Hand it on via the closure-scoped alias below.
    bloomOut = seedF;
  }
  const bloom = bloomOut;

  // --- rust weep -----------------------------------------------------------
  const rust = new Float32Array(n);
  for (const t of tieRust) {
    const w = 0.022 / px;
    const len = (0.12 + rnd() * 0.34) / px;
    for (let d = 0; d < len; d++) {
      let wy = Math.floor(t.y - d) % size;
      if (wy < 0) wy += size;
      const row = wy * size;
      const fade = (1 - d / len) * t.strength;
      const rad = Math.ceil(w * (1 + d / len));
      for (let o = -rad; o <= rad; o++) {
        let wx = Math.floor(t.x + o) % size;
        if (wx < 0) wx += size;
        const j = row + wx;
        const v = fade * (1 - ss01(Math.abs(o) / (rad + 0.5))) * (0.45 + 0.55 * streak[j] * 3);
        if (v > rust[j]) rust[j] = v;
      }
    }
  }

  // --- composite height ----------------------------------------------------
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const bi = boardId[y];
    const v = boardV[y];
    // A board leaves a step at its edge and a shallow sag across its face.
    const joint = 1 - ss01(Math.min(v, 1 - v) / 0.03);
    const sag = Math.sin(v * Math.PI) * 0.02;
    const step = boardStep[bi];
    for (let x = 0; x < size; x++) {
      const i = row + x;
      let h = height[i] + step + sag - joint * 0.16;
      h -= reveal[i] * 0.40;
      h -= tieRing[i] * 0.34;
      h += tiePlug[i] * 0.20;
      h -= blow[i] * 0.42;
      h -= spall[i] * 0.26;
      h += bloom[i] * 0.05;
      height[i] = clamp01(h);
    }
  }

  const near = new Float32Array(n);
  const far = new Float32Array(n);
  const tmp = new Float32Array(n);
  blurWrap(height, near, tmp, size, Math.max(1, Math.round(size / 190)));
  blurWrap(height, far, tmp, size, Math.max(2, Math.round(size / 32)));

  // --- albedo + roughness --------------------------------------------------
  const albedo = new Uint8Array(n * 4);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const bi = boardId[y];
    const bt = boardTone[bi];
    const br = boardRough[bi];
    for (let x = 0; x < size; x++) {
      const i = row + x;
      const hv = height[i];
      const cav = clamp01(
        1 - clamp01((near[i] - hv) * 3.6) * 0.85 - clamp01((far[i] - hv) * 1.9) * 0.3,
      );

      // Weathered concrete photographs around 0.42-0.66 sRGB, warm grey, with
      // pour-to-pour variation that never quite matches board to board.
      const base = mix(0.40, 0.66, body[i] * 0.72 + mottle[i] * 0.28);
      const board = base * mix(0.93, 1.06, bt);
      let r = board * 1.02;
      let g = board;
      let b = board * 0.958;
      let rg = 0.72 + br * 0.1 + (body[i] - 0.5) * 0.12;

      // Cement laitance is paler and smoother; exposed aggregate under a spall
      // is paler still and much rougher.
      const sp = spall[i];
      if (sp > 0) {
        const s6 = sp * 0.65;
        r = mix(r, 0.70, s6);
        g = mix(g, 0.685, s6);
        b = mix(b, 0.638, s6);
        rg = mix(rg, 0.95, sp * 0.8);
      }

      // Blowholes and the unfilled part of each tie cone are shadow.
      const pit = clamp01(blow[i] * 0.95 + tieRing[i] * (1 - tiePlug[i] * 0.9) * 0.95);
      if (pit > 0) {
        r = mix(r, 0.135, pit);
        g = mix(g, 0.130, pit);
        b = mix(b, 0.126, pit);
        rg = mix(rg, 0.99, pit * 0.75);
      }
      // A mortar plug in the tie hole never matches the parent concrete.
      const pl = tiePlug[i];
      if (pl > 0) {
        const p8 = pl * 0.88;
        r = mix(r, 0.615, p8);
        g = mix(g, 0.600, p8);
        b = mix(b, 0.560, p8);
        rg = mix(rg, 0.60, pl * 0.6);
      }

      // Panel reveal: a dark line with dirt collected in it.
      const rv = reveal[i];
      if (rv > 0) {
        const r8 = rv * 0.88;
        r = mix(r, 0.165, r8);
        g = mix(g, 0.160, r8);
        b = mix(b, 0.155, r8);
      }

      // Rain streaks: grey-brown dirt washed down the face.
      const s = streak[i];
      if (s > 0) {
        const s7 = s * 0.75;
        r = mix(r, 0.225, s7);
        g = mix(g, 0.212, s7);
        b = mix(b, 0.196, s7);
        rg = mix(rg, 0.92, s * 0.65);
      }

      // Efflorescence: chalky, near white, faintly blue.
      const e = bloom[i];
      if (e > 0) {
        const e8 = e * 0.8;
        r = mix(r, 0.86, e8);
        g = mix(g, 0.865, e8);
        b = mix(b, 0.870, e8);
        rg = mix(rg, 0.97, e * 0.85);
      }

      // Rust weeping out of the ties.
      const ru = rust[i];
      if (ru > 0) {
        const r8 = clamp01(ru) * 0.85;
        r = mix(r, 0.44, r8);
        g = mix(g, 0.235, r8);
        b = mix(b, 0.135, r8);
        rg = mix(rg, 0.88, clamp01(ru) * 0.5);
      }

      // Traffic film: the bottom of a barrier is filthy. Baked as a broad
      // vertical ramp so the client does not have to author one per surface.
      const low = 1 - ss01(y / (size * 0.42));
      const grime = low * (0.45 + 0.55 * mottle[i]);
      r = mix(r, 0.175, grime * 0.5);
      g = mix(g, 0.168, grime * 0.5);
      b = mix(b, 0.158, grime * 0.5);
      rg = mix(rg, 0.9, grime * 0.4);

      // Roughness rides in alpha: alpha is never sRGB-decoded, so linear data
      // is safe there even in an sRGB texture.
      const ao = 1 - (1 - cav) * 0.62;
      const j = i * 4;
      albedo[j] = to8(r * ao);
      albedo[j + 1] = to8(g * ao);
      albedo[j + 2] = to8(b * ao);
      albedo[j + 3] = to8(clamp01(rg));
    }
  }

  return { albedo, normal: encodeNormal(height, size, 2.6) };
}

/** Scratch handoff for the concrete bloom field, which is built inside a block. */
let bloomOut: Float32Array = new Float32Array(0);

// ---------------------------------------------------------------------------
// decal atlas
//
// Four quadrants of straight-alpha albedo, to be laid over the road as separate
// quads. Sparse features belong here rather than in the tiling maps: a skid
// mark that repeats every four metres is a fence, not a skid mark.
// ---------------------------------------------------------------------------

function buildDecals(size: number, seed: number): Uint8Array {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(size * size * 4);
  const h = size >> 1;
  const n = h * h;
  // Zero-alpha gutter so no mip level can smear one decal into its neighbour.
  const gutter = Math.max(3, size / 96);
  const iGutter = 1 / gutter;

  // Shared noise, built once at quadrant resolution.
  const fine = new Float32Array(n); // longitudinal grain
  addValueNoise(fine, h, 96, 13, 0.55, rnd);
  addValueNoise(fine, h, 26, 6, 0.45, rnd);

  const broad = new Float32Array(n); // blobby low frequency
  addValueNoise(broad, h, 5, 5, 0.55, rnd);
  addGradientNoise(broad, h, 17, 17, 0.45, rnd);

  const speck = new Float32Array(n); // isotropic grain
  addValueNoise(speck, h, 120, 120, 0.6, rnd);
  addValueNoise(speck, h, 36, 36, 0.4, rnd);

  // Real aggregate for the patch decal, so it reads as asphalt rather than as a
  // dark rectangle with noise on it.
  const chipH = new Float32Array(n);
  const chipT = new Float32Array(n);
  splatStones(chipH, chipT, h, Math.max(8, Math.round(h / 4.5)), rnd, {
    rMin: 0.34,
    rMax: 0.6,
    hMin: 0.5,
    hMax: 1,
  });

  /** Write one quadrant. `f` returns sRGB rgb plus coverage for a local pixel. */
  const quad = (
    ox: number,
    oy: number,
    f: (lx: number, ly: number, i: number) => [number, number, number, number],
  ): void => {
    for (let y = 0; y < h; y++) {
      const ey = ss01(y * iGutter) * ss01((h - 1 - y) * iGutter);
      for (let x = 0; x < h; x++) {
        const i = y * h + x;
        const edge = ey * ss01(x * iGutter) * ss01((h - 1 - x) * iGutter);
        const c = f(x, y, i);
        const j = ((oy + y) * size + (ox + x)) * 4;
        // Colour is written regardless of coverage — a dilated colour field
        // stops mip levels from pulling a decal's rim toward black.
        out[j] = to8(c[0]);
        out[j + 1] = to8(c[1]);
        out[j + 2] = to8(c[2]);
        out[j + 3] = to8(c[3] * edge);
      }
    }
  };

  // --- tyre skid mark, runs along +V ---------------------------------------
  // A locked wheel lays rubber in the pattern of its tread: parallel ribs with
  // gaps, laid heavily where the wheel first locks and breaking into
  // intermittent chatter blocks as the car slows and the tyre starts to skip.
  // The ribs and the chatter are the tell; a plain dark smear reads as a
  // shadow, which is what the first attempt at this looked like.
  {
    const RIBS = 6;
    const drift = new Float32Array(h);
    {
      const t = new Float32Array(n);
      addValueNoise(t, h, 1, 5, 1, rnd);
      for (let y = 0; y < h; y++) drift[y] = (t[y * h] - 0.5) * h * 0.03;
    }
    const chatter = new Float32Array(h);
    {
      const t = new Float32Array(n);
      addValueNoise(t, h, 1, 26, 1, rnd);
      for (let y = 0; y < h; y++) chatter[y] = t[y * h];
    }
    const half = h * 0.17;
    quad(0, 0, (x, y, i) => {
      const v = y / (h - 1);
      const d = (x - (h * 0.5 + drift[y])) / half;
      const ad = d < 0 ? -d : d;
      if (ad > 1.2) return [0.05, 0.047, 0.045, 0];
      // Tread ribs across the contact patch.
      const rp = (d * 0.5 + 0.5) * RIBS;
      const rib = Math.abs((rp - Math.floor(rp)) - 0.5) * 2;
      const ribMask = 0.32 + 0.68 * ss01((rib - 0.1) / 0.32);
      // The shoulders of the tyre bite harder than the centre.
      const across = (1 - ss01((ad - 0.72) / 0.4)) * (0.72 + 0.28 * ad);
      // Heavy where the wheel locks, breaking into blocks as it fades.
      const along = (1 - ss01((v - 0.12) / 0.85)) * ss01(v / 0.05);
      const skip = mix(1, ss01((chatter[y] - 0.3) / 0.35), ss01((v - 0.25) / 0.5));
      const grain = 0.32 + 0.68 * fine[i];
      const a = clamp01(across * ribMask * along * skip * grain * 1.45);
      // Deposited rubber is not black — it is a warm dark grey that goes
      // browner as it oxidises and picks up dust.
      const t = 0.35 + 0.65 * speck[i];
      return [0.078 * t + 0.022, 0.072 * t + 0.020, 0.068 * t + 0.019, a];
    });
  }

  // --- oil stain -----------------------------------------------------------
  // Soaked into the tarmac, not sitting on it: a dark saturated core, a broad
  // halo where it has wicked outward, and a few satellite drips. Boundary
  // irregularity comes from a LOW frequency field, because a high frequency one
  // gives the fibrous ink-blot look rather than a stain.
  {
    quad(h, 0, (x, y, i) => {
      const dx = (x - h * 0.5) / (h * 0.3);
      const dy = (y - h * 0.52) / (h * 0.34);
      const rr = Math.sqrt(dx * dx + dy * dy) * (0.82 + 0.36 * broad[i]);
      const core = 1 - ss01((rr - 0.42) / 0.5);
      const halo = (1 - ss01((rr - 0.7) / 0.7)) * (0.25 + 0.4 * speck[i]);
      // Satellite drips: rare, small, and only just outside the main body.
      const sat = ss01((broad[i] - 0.76) / 0.13) * (1 - ss01((rr - 1.0) / 0.7)) * ss01((rr - 0.6) / 0.3);
      const a = clamp01(core * 0.95 + halo * 0.55 + sat * 0.8);
      // Thick oil is very dark and warm; the wicked edge is a thin brown film.
      const thin = 1 - core;
      const r = mix(0.030, 0.088, thin);
      const g = mix(0.026, 0.080, thin);
      const b = mix(0.026, 0.062, thin);
      return [r, g, b, a];
    });
  }

  // --- rectangular patch repair --------------------------------------------
  // The loud version: a saw-cut trench filled with fresh, blacker, finer
  // asphalt standing slightly proud, with an irregular tar bead sealing the
  // perimeter and overspilling onto the old surface.
  {
    const bw = h * 0.33;
    const bh = h * 0.38;
    quad(0, h, (x, y, i) => {
      const e =
        Math.max(Math.abs(x - h * 0.5) - bw, Math.abs(y - h * 0.5) - bh) +
        (speck[i] - 0.5) * 5 +
        (broad[i] - 0.5) * 7;
      const inside = 1 - ss01((e + 1) / 2.5);
      // The bead straddles the cut and is deliberately lumpy along its length.
      const beadW = 3 + broad[i] * 5;
      const bead = 1 - ss01((Math.abs(e + 1) - beadW * 0.4) / (beadW * 0.7));

      // Fresh asphalt: fine graded, so its chips are smaller and darker.
      const chip = clamp01(chipH[i] * 2.2);
      const t = chipT[i];
      const stone = t < 0.55 ? 0.185 : t < 0.88 ? 0.245 : 0.33;
      let r = mix(0.088 + 0.05 * speck[i], stone * (0.85 + 0.3 * t), chip * 0.55);
      let g = r * 0.99;
      let b = r * 1.03;
      // Tar bead: glossy black.
      r = mix(r, 0.055, bead * 0.92);
      g = mix(g, 0.052, bead * 0.92);
      b = mix(b, 0.058, bead * 0.92);
      const a = clamp01(inside + bead * 0.9);
      return [r, g, b, a];
    });
  }

  // --- manhole cover -------------------------------------------------------
  // Cast iron in a concrete haunch: a frame ring, a diamond tread pattern, two
  // pick holes, and the surrounding surface sunk slightly around it.
  {
    const R = h * 0.44;
    quad(h, h, (x, y, i) => {
      const dx = x - h * 0.5;
      const dy = y - h * 0.5;
      const rr = Math.sqrt(dx * dx + dy * dy) / R;
      if (rr > 1.04) return [0.30, 0.29, 0.275, 0];

      const wob = (speck[i] - 0.5) * 0.025;
      const haunch = 1 - ss01((rr + wob - 0.94) / 0.1); // concrete collar
      const frame = 1 - ss01((rr - 0.855) / 0.035); // iron frame
      const lid = 1 - ss01((rr - 0.775) / 0.02); // the cover itself

      // Diamond tread: two rotated square waves. Hard edged, because cast iron
      // is cast, and cast edges stay sharp until traffic polishes their tops.
      const s = 0.115 * h;
      const u = (dx + dy) / s;
      const v = (dx - dy) / s;
      const du = Math.abs(u - Math.floor(u) - 0.5) * 2;
      const dv = Math.abs(v - Math.floor(v) - 0.5) * 2;
      const tread = ss01((Math.min(du, dv) - 0.3) / 0.16) * lid;
      // A plain ring inboard of the rim, as most cast covers have.
      const ring = ss01((rr - 0.64) / 0.02) * (1 - ss01((rr - 0.72) / 0.02)) * lid;

      // Pick holes.
      const pa = Math.sqrt((dx - h * 0.19) ** 2 + dy * dy) / R;
      const pb = Math.sqrt((dx + h * 0.19) ** 2 + dy * dy) / R;
      const pick = clamp01((1 - ss01((pa - 0.045) / 0.03)) + (1 - ss01((pb - 0.045) / 0.03)));

      // Weathered iron: dark and warm, polished bright on the tread crowns
      // where tyres have been passing over it for twenty years.
      const polish = clamp01(0.45 + 0.55 * speck[i]);
      let base = mix(0.10, 0.165, broad[i]);
      base = mix(base, 0.35, tread * polish * 0.85);
      base = mix(base, 0.125, ring * 0.7);
      let r = base * 1.07;
      let g = base * 0.985;
      let b = base * 0.92;
      // Rust in the recesses only, which is where water actually sits.
      const rustAmt = (1 - tread) * lid * ss01((broad[i] - 0.58) / 0.3) * 0.55;
      r = mix(r, 0.34, rustAmt);
      g = mix(g, 0.19, rustAmt);
      b = mix(b, 0.115, rustAmt);
      // Frame gap: a hard black line between lid and frame.
      const gap = clamp01(frame - lid);
      r = mix(r, 0.025, gap);
      g = mix(g, 0.025, gap);
      b = mix(b, 0.027, gap);
      // Concrete haunch around the frame.
      const collar = clamp01(haunch - frame);
      const cc = mix(0.24, 0.40, speck[i]) * (0.8 + 0.2 * broad[i]);
      r = mix(r, cc, collar);
      g = mix(g, cc * 0.98, collar);
      b = mix(b, cc * 0.945, collar);

      r = mix(r, 0.032, pick * 0.92);
      g = mix(g, 0.032, pick * 0.92);
      b = mix(b, 0.034, pick * 0.92);

      return [r, g, b, clamp01(haunch)];
    });
  }

  return out;
}
