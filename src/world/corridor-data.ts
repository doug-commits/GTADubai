/**
 * ============================================================================
 *  CORRIDOR SOURCE DATA — Sheikh Zayed Road (E11), Barsha -> Dubai World Trade Centre
 * ============================================================================
 *
 *  >>> DATA PROVENANCE — READ THIS <<<
 *
 *  The shipping build is designed to run on REAL OpenStreetMap geometry, baked
 *  by `tools/import-osm.mjs` into `public/data/corridor.json`. When that file is
 *  present the loader uses it and everything in this module is ignored.
 *
 *  This module is the FALLBACK used when no OSM bake is present. Its centreline
 *  is an AUTHORED APPROXIMATION anchored on the published coordinates of
 *  landmarks along the corridor — it is NOT OpenStreetMap data and must never be
 *  described as such. `CORRIDOR_FALLBACK.meta.isRealOSM` is `false` and the boot
 *  path surfaces that in the credits panel.
 *
 *  To replace it with real geometry, see `data/README.md`.
 *
 *  Landmark coordinates and heights below are published public facts about the
 *  buildings themselves (not traced from any proprietary imagery source).
 *  NO Google Maps / Street View / Earth imagery is used anywhere in this project.
 * ============================================================================
 */

import type { LandmarkId } from './landmarks';

export interface LandmarkSpec {
  name: string;
  lat: number;
  lon: number;
  /** Structural height in metres. */
  height: number;
  /** Rough footprint radius in metres. */
  radius: number;
  /** Silhouette archetype used by the city builder. */
  shape: 'spire' | 'tower' | 'twin' | 'slab' | 'dome' | 'sail';
  /**
   * Which purpose-built silhouette to use from `landmarks.ts`. Anything left
   * as 'generic-tower' gets a seeded commercial tower rather than a portrait.
   */
  id: LandmarkId;
}

/**
 * Centreline control points, north-east (finish, DWTC) to south-west (start).
 * Authored approximation — see provenance note above.
 */
export const SZR_CONTROL_POINTS: Array<[lat: number, lon: number]> = [
  [25.2318, 55.2902], // Za'abeel / Trade Centre R/A approach (past the finish, run-off)
  [25.2286, 55.2874],
  [25.2258, 55.2851], // Dubai World Trade Centre — FINISH
  [25.2229, 55.2833],
  [25.2199, 55.2814],
  [25.2170, 55.2799], // Emirates Towers
  [25.2141, 55.2786],
  [25.2113, 55.2772], // DIFC / Financial Centre
  [25.2081, 55.2755],
  [25.2048, 55.2735],
  [25.2013, 55.2712], // Interchange 1 — Downtown / Burj Khalifa
  [25.1979, 55.2688],
  [25.1946, 55.2661],
  [25.1912, 55.2632], // Business Bay
  [25.1877, 55.2601],
  [25.1841, 55.2568],
  [25.1802, 55.2531],
  [25.1760, 55.2489],
  [25.1716, 55.2447], // Interchange 2 — Al Safa
  [25.1669, 55.2401],
  [25.1620, 55.2354],
  [25.1569, 55.2306], // Al Quoz
  [25.1515, 55.2257],
  [25.1459, 55.2206],
  [25.1401, 55.2154],
  [25.1341, 55.2101], // Interchange 3 — Mall of the Emirates approach
  [25.1279, 55.2047],
  [25.1216, 55.1993],
  [25.1152, 55.1939], // Al Barsha — START
];

/**
 * Landmarks that define the recognisable Sheikh Zayed Road skyline.
 * Positions are the buildings' own published coordinates.
 */
export const LANDMARKS: LandmarkSpec[] = [
  { name: 'Burj Khalifa', lat: 25.1972, lon: 55.2744, height: 828, radius: 42, shape: 'spire', id: 'burj-khalifa' },
  // Sits directly beside Sheikh Zayed Road and is one of the most recognisable
  // objects on the whole corridor — the torus with the elliptical void.
  { name: 'Museum of the Future', lat: 25.2195, lon: 55.2825, height: 77, radius: 33, shape: 'dome', id: 'museum-of-the-future' },
  { name: 'Emirates Towers', lat: 25.2170, lon: 55.2833, height: 355, radius: 30, shape: 'twin', id: 'emirates-towers' },
  { name: 'Rose Rayhaan', lat: 25.2245, lon: 55.2823, height: 333, radius: 18, shape: 'tower', id: 'rose-rayhaan' },
  { name: 'Chelsea Tower', lat: 25.2216, lon: 55.2806, height: 250, radius: 16, shape: 'spire', id: 'generic-tower' },
  { name: 'The Index', lat: 25.2109, lon: 55.2792, height: 328, radius: 22, shape: 'slab', id: 'generic-tower' },
  { name: 'Almas Tower', lat: 25.0742, lon: 55.1400, height: 360, radius: 24, shape: 'tower', id: 'almas-tower' },
  { name: 'The Gate, DIFC', lat: 25.2118, lon: 55.2812, height: 80, radius: 40, shape: 'slab', id: 'difc-gate' },
  { name: 'Dubai World Trade Centre', lat: 25.2253, lon: 55.2873, height: 149, radius: 22, shape: 'slab', id: 'generic-tower' },
  { name: 'Address Sky View', lat: 25.1938, lon: 55.2742, height: 260, radius: 20, shape: 'twin', id: 'address-tower' },
  { name: 'The Opus', lat: 25.1856, lon: 55.2668, height: 93, radius: 30, shape: 'slab', id: 'generic-tower' },
  { name: 'Ubora Towers', lat: 25.1852, lon: 55.2718, height: 261, radius: 20, shape: 'tower', id: 'generic-tower' },
  { name: 'Park Towers', lat: 25.2093, lon: 55.2786, height: 180, radius: 18, shape: 'twin', id: 'generic-tower' },
  { name: 'Al Yaqoub Tower', lat: 25.2050, lon: 55.2726, height: 328, radius: 20, shape: 'spire', id: 'al-yaqoub' },
  { name: 'Al Kazim Towers', lat: 25.1157, lon: 55.2005, height: 265, radius: 20, shape: 'twin', id: 'al-kazim-towers' },
  { name: 'Sheraton Grand', lat: 25.2205, lon: 55.2795, height: 256, radius: 18, shape: 'tower', id: 'generic-tower' },
  { name: 'Burj Al Salam', lat: 25.2231, lon: 55.2841, height: 296, radius: 19, shape: 'tower', id: 'generic-tower' },
  { name: 'Conrad Dubai', lat: 25.2288, lon: 55.2862, height: 233, radius: 20, shape: 'slab', id: 'generic-tower' },
  // Off-corridor, on the horizon toward the coast — the sail silhouette is
  // visible from the Barsha end of the run and is pure Dubai shorthand.
  { name: 'Burj Al Arab', lat: 25.1412, lon: 55.1853, height: 321, radius: 40, shape: 'sail', id: 'burj-al-arab' },
];

/** Interchange positions along the corridor, used for checkpoints and gantries. */
export const INTERCHANGES: Array<{ name: string; lat: number; lon: number }> = [
  { name: 'Interchange 4 — Al Barsha', lat: 25.1181, lon: 55.1968 },
  { name: 'Interchange 3 — Al Quoz', lat: 25.1341, lon: 55.2101 },
  { name: 'Interchange 2 — Al Safa', lat: 25.1716, lon: 55.2447 },
  { name: 'Interchange 1 — Downtown', lat: 25.2013, lon: 55.2712 },
  { name: 'Financial Centre', lat: 25.2113, lon: 55.2772 },
  { name: 'Trade Centre', lat: 25.2258, lon: 55.2851 },
];

export const CORRIDOR_FALLBACK_META = {
  isRealOSM: false,
  label: 'Authored approximation — awaiting OpenStreetMap bake',
  attribution: 'Corridor geometry: authored placeholder. Not OpenStreetMap data.',
} as const;
