#!/usr/bin/env node
/**
 * import-osm.mjs — bake a real OpenStreetMap extract into the game's corridor format.
 *
 *   node tools/import-osm.mjs data/szr.overpass.json
 *
 * Input:  Overpass API JSON (`out geom;`) or a GeoJSON FeatureCollection.
 * Output: public/data/corridor.json  — compact, ~1 fetch, gzip-friendly.
 *
 * OpenStreetMap data is © OpenStreetMap contributors, available under the Open
 * Database Licence (ODbL). The baked output carries that attribution and the
 * game surfaces it in the credits panel. See data/README.md.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Keep in sync with src/world/geo.ts
const ORIGIN = { lat: 25.2253, lon: 55.2873 };
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111132.92 - 559.82 * Math.cos(2 * ORIGIN.lat * DEG);
const M_PER_DEG_LON =
  111412.84 * Math.cos(ORIGIN.lat * DEG) - 93.5 * Math.cos(3 * ORIGIN.lat * DEG);

const project = (lat, lon) => ({
  x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
  z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
});

/** Corridor bounds: Al Barsha (start) -> Trade Centre (finish). */
const BOUNDS = { minLat: 25.105, maxLat: 25.235, minLon: 55.185, maxLon: 55.295 };
const inBounds = (lat, lon) =>
  lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon;

// ---------------------------------------------------------------- parsing ---

function loadElements(raw) {
  const doc = JSON.parse(raw);
  if (Array.isArray(doc.elements)) return { kind: 'overpass', elements: doc.elements };
  if (doc.type === 'FeatureCollection' && Array.isArray(doc.features)) {
    return { kind: 'geojson', elements: doc.features };
  }
  throw new Error('Unrecognised input: expected Overpass JSON (elements[]) or GeoJSON FeatureCollection');
}

function tagsOf(el, kind) {
  return (kind === 'geojson' ? el.properties : el.tags) ?? {};
}

/** Return [[lat, lon], ...] for a way-like element, or null. */
function geomOf(el, kind) {
  if (kind === 'overpass') {
    if (Array.isArray(el.geometry)) return el.geometry.map((g) => [g.lat, g.lon]);
    return null;
  }
  const g = el.geometry;
  if (!g) return null;
  if (g.type === 'LineString') return g.coordinates.map(([lon, lat]) => [lat, lon]);
  if (g.type === 'Polygon') return g.coordinates[0].map(([lon, lat]) => [lat, lon]);
  if (g.type === 'MultiPolygon') return g.coordinates[0][0].map(([lon, lat]) => [lat, lon]);
  return null;
}

const isCorridorRoad = (t) => {
  const hw = t.highway;
  if (hw !== 'motorway' && hw !== 'trunk') return false;
  const name = `${t.name ?? ''} ${t['name:en'] ?? ''}`.toLowerCase();
  const ref = `${t.ref ?? ''}`.toUpperCase().replace(/\s+/g, '');
  return name.includes('sheikh zayed') || ref.includes('E11');
};

// ------------------------------------------------------- centreline build ---

/**
 * Stitch the matching carriageway ways into one continuous centreline.
 *
 * Sheikh Zayed Road is mapped as dual carriageways: two one-way ways running
 * alongside each other, each split at every interchange. We take the direction
 * of travel we care about (north-east bound, toward Trade Centre), order the
 * fragments by projection onto the corridor axis, and stitch.
 */
function buildCenterline(ways) {
  const CORRIDOR_BEARING = Math.atan2(
    ORIGIN.lon - 55.1939,
    ORIGIN.lat - 25.1152,
  );
  const axis = { x: Math.sin(CORRIDOR_BEARING), z: -Math.cos(CORRIDOR_BEARING) };
  const along = (p) => p.x * axis.x + p.z * axis.z;

  const frags = ways
    .map((pts) => pts.map(([lat, lon]) => project(lat, lon)))
    .filter((pts) => pts.length >= 2)
    .map((pts) => {
      // Orient every fragment in the direction of travel (start -> finish).
      if (along(pts[pts.length - 1]) < along(pts[0])) pts.reverse();
      return pts;
    })
    .sort((a, b) => along(a[0]) - along(b[0]));

  if (!frags.length) throw new Error('No Sheikh Zayed Road / E11 ways found in the extract');

  // Greedy stitch: append a fragment when it advances the corridor, and drop
  // the opposite carriageway (it back-tracks or sits > 60 m off the running line).
  const out = [...frags[0]];
  for (let i = 1; i < frags.length; i++) {
    const f = frags[i];
    const tail = out[out.length - 1];
    if (along(f[f.length - 1]) <= along(tail) + 5) continue;
    const gap = Math.hypot(f[0].x - tail.x, f[0].z - tail.z);
    if (gap > 900) continue; // unrelated E11 stretch outside the corridor
    for (const p of f) if (along(p) > along(out[out.length - 1]) + 1) out.push(p);
  }
  return out;
}

// --------------------------------------------------------------- resample ---

function resample(points, spacing = 8, smoothPasses = 2) {
  const out = [{ ...points[0] }];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen < 1e-6) continue;
    let d = spacing - carry;
    while (d <= segLen) {
      const u = d / segLen;
      out.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
      d += spacing;
    }
    carry = (carry + segLen) % spacing;
  }
  for (let pass = 0; pass < smoothPasses; pass++) {
    for (let i = 1; i < out.length - 1; i++) {
      out[i].x = (out[i - 1].x + 2 * out[i].x + out[i + 1].x) * 0.25;
      out[i].z = (out[i - 1].z + 2 * out[i].z + out[i + 1].z) * 0.25;
    }
  }
  return out;
}

// -------------------------------------------------------------- buildings ---

const LEVEL_HEIGHT = 3.2;

function buildingHeight(t) {
  const h = parseFloat(t.height ?? t['building:height'] ?? '');
  if (Number.isFinite(h) && h > 0) return h;
  const lv = parseFloat(t['building:levels'] ?? t.levels ?? '');
  if (Number.isFinite(lv) && lv > 0) return lv * LEVEL_HEIGHT;
  return 0;
}

function extractBuildings(elements, kind, centre) {
  const out = [];
  for (const el of elements) {
    const t = tagsOf(el, kind);
    if (!t.building && !t['building:part']) continue;
    const g = geomOf(el, kind);
    if (!g || g.length < 3) continue;
    if (!g.some(([lat, lon]) => inBounds(lat, lon))) continue;

    const pts = g.map(([lat, lon]) => project(lat, lon));
    // Centroid + oriented extent — the renderer instances boxes, not meshes,
    // so a footprint reduces to centre / half-extents / rotation.
    let cx = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p.x;
      cz += p.z;
    }
    cx /= pts.length;
    cz /= pts.length;

    if (centre.distanceTo(cx, cz) > 900) continue; // keep the corridor slice only

    let maxR = 0;
    for (const p of pts) maxR = Math.max(maxR, Math.hypot(p.x - cx, p.z - cz));
    const h = buildingHeight(t);
    out.push({
      x: Math.round(cx * 10) / 10,
      z: Math.round(cz * 10) / 10,
      r: Math.round(Math.min(maxR, 90) * 10) / 10,
      h: Math.round(h * 10) / 10,
      n: t.name ?? undefined,
    });
  }
  return out;
}

/** Cheap "is this near the running line" test built off a coarse sample. */
function makeCorridorIndex(line) {
  const step = Math.max(1, Math.floor(line.length / 400));
  const coarse = line.filter((_, i) => i % step === 0);
  return {
    distanceTo(x, z) {
      let best = Infinity;
      for (const p of coarse) {
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    },
  };
}

// ------------------------------------------------------------------- main ---

function main() {
  const input = process.argv[2] ?? 'data/szr.overpass.json';
  const outPath = resolve('public/data/corridor.json');

  let raw;
  try {
    raw = readFileSync(resolve(input), 'utf8');
  } catch {
    console.error(`\n  No OSM extract at "${input}".`);
    console.error('  The game will fall back to the authored placeholder corridor.');
    console.error('  See data/README.md for the one Overpass query that produces this file.\n');
    process.exit(1);
  }

  const { kind, elements } = loadElements(raw);

  const roadWays = [];
  for (const el of elements) {
    const t = tagsOf(el, kind);
    if (!isCorridorRoad(t)) continue;
    const g = geomOf(el, kind);
    if (g && g.length >= 2 && g.some(([lat, lon]) => inBounds(lat, lon))) roadWays.push(g);
  }

  const stitched = buildCenterline(roadWays);
  const line = resample(stitched, 8, 2);
  const index = makeCorridorIndex(line);
  const buildings = extractBuildings(elements, kind, index);

  let length = 0;
  for (let i = 1; i < line.length; i++) {
    length += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
  }

  const doc = {
    meta: {
      isRealOSM: true,
      source: 'OpenStreetMap via Overpass API',
      attribution: '© OpenStreetMap contributors, ODbL 1.0',
      attributionUrl: 'https://www.openstreetmap.org/copyright',
      licence: 'ODbL-1.0',
      bakedFrom: input,
      origin: ORIGIN,
      corridorLengthM: Math.round(length),
    },
    // Flat arrays: ~40% smaller than [{x,z}] once gzipped.
    centerline: line.flatMap((p) => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]),
    buildings,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc));

  const kb = (Buffer.byteLength(JSON.stringify(doc)) / 1024).toFixed(1);
  console.log(`\n  Baked ${outPath}`);
  console.log(`    corridor : ${(length / 1000).toFixed(2)} km, ${line.length} points`);
  console.log(`    buildings: ${buildings.length}`);
  console.log(`    size     : ${kb} KB raw\n`);
}

main();
