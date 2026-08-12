/**
 * Corridor loader.
 *
 * Prefers a real OpenStreetMap bake at `data/corridor.json` (produced by
 * `tools/import-osm.mjs`). Falls back to the authored placeholder in
 * `corridor-data.ts` when no bake is present. Either way the rest of the game
 * only ever sees a `Corridor`.
 */

import { project, type Vec2 } from './geo';
import { CenterlinePath, resample } from './path';
import {
  SZR_CONTROL_POINTS,
  LANDMARKS,
  INTERCHANGES,
  CORRIDOR_FALLBACK_META,
  type LandmarkSpec,
} from './corridor-data';

export interface BuildingRec {
  x: number;
  z: number;
  /** Footprint radius, metres. */
  r: number;
  /** Height, metres. 0 = unknown, the city builder will guess from context. */
  h: number;
  /** Name, when OSM had one. */
  n?: string;
}

export interface CorridorMeta {
  isRealOSM: boolean;
  attribution: string;
  attributionUrl?: string;
  label?: string;
  corridorLengthM: number;
}

export interface Checkpoint {
  name: string;
  /** Arc length along the path, metres. */
  s: number;
}

export interface Corridor {
  path: CenterlinePath;
  buildings: BuildingRec[];
  landmarks: Array<LandmarkSpec & { x: number; z: number; s: number; side: number }>;
  checkpoints: Checkpoint[];
  meta: CorridorMeta;
  /** Total drivable length, metres. */
  length: number;
  /** Arc length of the finish line (the storefront). */
  finishS: number;
}

const LANES = 5;
export const LANE_WIDTH = 3.65;
export const ROAD_HALF_WIDTH = (LANES * LANE_WIDTH) / 2;

/** Project an arbitrary world point onto the path, returning arc length + side. */
function projectToPath(path: CenterlinePath, x: number, z: number) {
  // Coarse scan then local refine — the corridor is near-monotonic so this is safe.
  let bestS = 0;
  let bestD = Infinity;
  const coarse = Math.max(8, path.length / 600);
  for (let s = 0; s <= path.length; s += coarse) {
    const p = path.sample(s);
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      bestS = s;
    }
  }
  for (let step = coarse * 0.5; step > 0.5; step *= 0.5) {
    for (const cand of [bestS - step, bestS + step]) {
      if (cand < 0 || cand > path.length) continue;
      const p = path.sample(cand);
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestS = cand;
      }
    }
  }
  const p = path.sample(bestS);
  const side = (x - p.x) * p.nx + (z - p.z) * p.nz;
  return { s: bestS, side, dist: Math.sqrt(bestD) };
}

/**
 * The run finishes at the storefront, a little short of the corridor end so the
 * car has somewhere to screech to a halt.
 */
const RUN_OFF_M = 120;

function assemble(
  linePts: Vec2[],
  buildings: BuildingRec[],
  meta: Omit<CorridorMeta, 'corridorLengthM'>,
): Corridor {
  const path = new CenterlinePath(linePts);

  const landmarks = LANDMARKS.map((l) => {
    const p = project(l.lat, l.lon);
    const pr = projectToPath(path, p.x, p.z);
    return { ...l, x: p.x, z: p.z, s: pr.s, side: pr.side };
  })
    // Drop anything that is nowhere near this corridor (e.g. the Marina towers).
    .filter((l) => Math.abs(l.side) < 1400);

  const checkpoints: Checkpoint[] = INTERCHANGES.map((ic) => {
    const p = project(ic.lat, ic.lon);
    return { name: ic.name, s: projectToPath(path, p.x, p.z).s };
  })
    .sort((a, b) => a.s - b.s)
    .filter((c) => c.s > 200 && c.s < path.length - RUN_OFF_M);

  return {
    path,
    buildings,
    landmarks,
    checkpoints,
    meta: { ...meta, corridorLengthM: Math.round(path.length) },
    length: path.length,
    finishS: path.length - RUN_OFF_M,
  };
}

/** Build the fallback corridor from authored control points. */
function buildFallback(): Corridor {
  // Control points run finish -> start; the race runs start -> finish, so reverse.
  const pts = SZR_CONTROL_POINTS.map(([lat, lon]) => project(lat, lon)).reverse();
  const line = resample(pts, 8, 3);
  return assemble(line, [], {
    isRealOSM: false,
    attribution: CORRIDOR_FALLBACK_META.attribution,
    label: CORRIDOR_FALLBACK_META.label,
  });
}

/** Build a corridor from a baked OSM document. */
function buildFromBake(doc: any): Corridor {
  const flat: number[] = doc.centerline;
  const pts: Vec2[] = [];
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i], z: flat[i + 1] });
  const line = resample(pts, 8, 1);
  return assemble(line, (doc.buildings as BuildingRec[]) ?? [], {
    isRealOSM: true,
    attribution: doc.meta?.attribution ?? '© OpenStreetMap contributors, ODbL 1.0',
    attributionUrl: doc.meta?.attributionUrl ?? 'https://www.openstreetmap.org/copyright',
  });
}

let cached: Corridor | null = null;

export async function loadCorridor(): Promise<Corridor> {
  if (cached) return cached;
  try {
    const res = await fetch(new URL('./data/corridor.json', document.baseURI).href, {
      cache: 'force-cache',
    });
    if (res.ok) {
      const doc = await res.json();
      if (doc?.centerline?.length >= 4) {
        cached = buildFromBake(doc);
        return cached;
      }
    }
  } catch {
    /* fall through to the authored placeholder */
  }
  cached = buildFallback();
  return cached;
}
