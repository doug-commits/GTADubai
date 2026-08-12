# Mukbang Dash

An arcade dash down Sheikh Zayed Road at dusk to the **Love Mukbang** branch at Dubai World
Trade Centre. Weave rush-hour traffic, beat the clock, screech up to the storefront before it
hits zero — and walk away with a table booking and a discount code.

It is a game. It is also an ad.

```sh
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # production bundle -> dist/
npm run preview    # serve the production build on :4173
```

## What it is built on

| Concern | Choice | Why |
| --- | --- | --- |
| Renderer | Three.js (WebGL2) + a hand-written HDR post chain | Full control of the look; the post stack is the product |
| Language | TypeScript, strict | |
| Bundler | Vite | Small output, fast dev |
| World geometry | OpenStreetMap (ODbL) via `tools/import-osm.mjs` | Real corridor, real skyline positions |
| Audio | Web Audio, fully synthesised | Zero audio downloads — protects the 2s load budget |
| Art | Original / client-owned only | See `assets/SLOTS.md` |

No Google Maps, Street View or Earth imagery is used anywhere, for anything.

## Architecture

```
src/
  contracts.ts        Shared interfaces between engine and bolt-on modules
  main.ts             Boot
  core/input.ts       Drag-steering touch, keyboard
  world/
    geo.ts            WGS84 -> local ENU metres
    path.ts           Arc-length centreline; everything is addressed as (s, t)
    corridor.ts       Loads the OSM bake, falls back to the authored placeholder
    road.ts           Road ribbon + wet-asphalt shader
    city.ts           Whole skyline as one InstancedMesh
    storefront.ts     The Love Mukbang branch at the finish
  render/
    pipeline.ts       Bright pass -> dual-filter bloom -> composite
    sky.ts            Analytic dusk sky (shared with the road's reflections)
  game/
    game.ts           Phase machine, fixed-timestep sim, scoring
    car.ts            Arcade handling
    traffic.ts        Pooled rush-hour traffic, 4 draw calls
    cameras.ts        Both camera rigs under evaluation
  audio/engine.ts     Synthesised engine, wind, skid, impacts
  net/                Voucher endpoint + per-branch leaderboard
  ui/                 Title, HUD, arrival, voucher, leaderboard
```

**Everything moving is addressed as `(s, t)`** — metres along the corridor centreline, and
metres laterally from it. Traffic AI, lane logic, collision, checkpoints and both cameras all
reason in that straight 1-D corridor and only touch world space to render. It is the single
decision that keeps the rest of the code small.

## Performance

Mobile-first, budgeted for a mid-range phone:

- **One draw call for the entire skyline** (instanced boxes, per-instance window grids in-shader).
- **Four draw calls for all traffic** — bodies, cabins, taillights, wet-road smears.
- Bloom runs at half resolution and below; only the scene render and one composite pass touch
  native resolution.
- Device pixel ratio capped at 2.
- No MSAA — the post chain resolves edges; MSAA on an HDR target is a phone killer.
- No webfonts, no audio files, no texture downloads on the critical path. Every art asset is a
  slot with a procedural placeholder behind it (`assets/SLOTS.md`).

## Map data

The corridor is designed to run on real OpenStreetMap geometry.

**This checkout currently ships the authored placeholder**, because the build environment's
egress policy blocks every OpenStreetMap host. `data/README.md` has the one Overpass query and
the single command that swaps in the real thing — no code changes needed. The credits panel
reports honestly which of the two is live.

When real data is baked, map data is © OpenStreetMap contributors, licensed
[ODbL 1.0](https://www.openstreetmap.org/copyright).

## The voucher

On finishing a run the game calls a server endpoint for a one-time 10%-off code and renders it
onto a print-styled voucher.

**The game never generates the code.** There is no client-side fallback, by design — on any
failure the UI shows an error and a retry. Configure the endpoint with:

```sh
VITE_VOUCHER_ENDPOINT=https://…  npm run build
```

Until it is set, the endpoint is the literal placeholder `[VOUCHER_ENDPOINT_URL]` and the
voucher call rejects with "not configured" without making a request.

## Content rules

- The arrival scene is **halal: beef and chicken only**. No pork, no samgyeopsal. This is
  enforced in the art brief and noted in the code that renders the scene.
- All artwork is original or client-owned. Asset slots are listed in `assets/SLOTS.md`; each
  currently renders a procedural placeholder and is replaced by dropping a file in.

## The critic gauntlet

Quality is not self-assessed. `tools/critic/shoot.mjs` drives the built game in a real
Chromium at a 390×844 phone viewport, plays it with touch input, and captures real frames plus
frame-time and draw-call data:

```sh
npm run build && npm run preview &
node tools/critic/shoot.mjs --mode=chase --label=r1
node tools/critic/shoot.mjs --mode=topdown --label=r1-td
```

A separate critic reviews only those pixels — never a description of the work — names the
single largest gap against the quality bar, and that one gap is what gets fixed next round.

> CI renders under SwiftShader (software GL), so absolute frame times there are a floor, not a
> phone number. Draw calls, triangle counts and round-over-round deltas are the signals that
> transfer; the look is judged from the pixels.
