# Corridor data — Sheikh Zayed Road

The game is built to run on **real OpenStreetMap geometry**. This directory is where
the raw extract goes; `tools/import-osm.mjs` bakes it into `public/data/corridor.json`,
which the game loads at boot.

## Current state

**No OSM extract is present in this repo.** The build container's egress policy blocks
every OpenStreetMap host (`overpass-api.de`, `overpass.kumi.systems`, `api.openstreetmap.org`,
`download.geofabrik.de`, `tile.openstreetmap.org` — all return HTTP 403 at the proxy),
so the data could not be fetched here.

Until an extract is dropped in, the game falls back to `src/world/corridor-data.ts`, an
**authored approximation** anchored on published landmark coordinates. It is labelled as
such in the in-game credits panel and is never described as OpenStreetMap data.

## How to drop in the real geometry

Run this once on any machine with normal internet access. No code changes are needed.

### 1. Get the extract

Open <https://overpass-turbo.eu>, paste this, hit **Run**, then **Export → download as raw OSM data**:

```overpassql
[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk)$"]["ref"~"E\\s*11"](25.105,55.185,25.235,55.295);
  way["highway"~"^(motorway|trunk)$"]["name"~"Sheikh Zayed",i](25.105,55.185,25.235,55.295);
  way["building"](25.105,55.185,25.235,55.295);
);
out geom;
```

Or from a terminal:

```sh
curl -G https://overpass-api.de/api/interpreter \
  --data-urlencode 'data=[out:json][timeout:180];(way["highway"~"^(motorway|trunk)$"]["ref"~"E\s*11"](25.105,55.185,25.235,55.295);way["highway"~"^(motorway|trunk)$"]["name"~"Sheikh Zayed",i](25.105,55.185,25.235,55.295);way["building"](25.105,55.185,25.235,55.295););out geom;' \
  -o data/szr.overpass.json
```

### 2. Bake it

```sh
npm run bake -- data/szr.overpass.json
```

You should see something like:

```
  Baked public/data/corridor.json
    corridor : 15.4 km, 1927 points
    buildings: 3140
    size     : 218.6 KB raw
```

### 3. Done

Reload the game. It picks up `public/data/corridor.json` automatically, and the credits
panel flips from the placeholder notice to the ODbL attribution.

`tools/import-osm.mjs` also accepts a GeoJSON `FeatureCollection` if you'd rather export
that way.

## Licence and attribution

OpenStreetMap data is © OpenStreetMap contributors, licensed under the
[Open Database Licence (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/).
The baked file carries this attribution and the game displays it in the credits panel,
as ODbL requires.

## Prohibited sources

Google Maps, Google Street View and Google Earth imagery are **never** used in this
project — not for geometry, not for tracing, not for reference. OpenStreetMap and
original art only.
