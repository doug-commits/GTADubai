/**
 * Local ENU (East/North/Up) tangent-plane projection.
 *
 * The whole game lives in metres on a plane tangent to the WGS84 ellipsoid at
 * ORIGIN. Over a ~16 km corridor the distortion is far below the width of a
 * lane marking, so a full map projection would be wasted bytes.
 *
 * World axes (three.js convention):
 *   +x = East, +y = Up, -z = North
 */

/** Tangent point: Dubai World Trade Centre — the finish line. */
export const ORIGIN = { lat: 25.2253, lon: 55.2873 } as const;

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111132.92 - 559.82 * Math.cos(2 * ORIGIN.lat * DEG);
const M_PER_DEG_LON = 111412.84 * Math.cos(ORIGIN.lat * DEG) - 93.5 * Math.cos(3 * ORIGIN.lat * DEG);

export interface Vec2 {
  x: number;
  z: number;
}

/** WGS84 lat/lon -> local metres. */
export function project(lat: number, lon: number): Vec2 {
  return {
    x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
    z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

/** Local metres -> WGS84 lat/lon (used by the baker for round-trip checks). */
export function unproject(x: number, z: number): { lat: number; lon: number } {
  return {
    lat: ORIGIN.lat - z / M_PER_DEG_LAT,
    lon: ORIGIN.lon + x / M_PER_DEG_LON,
  };
}

export const metresPerDegree = { lat: M_PER_DEG_LAT, lon: M_PER_DEG_LON };
