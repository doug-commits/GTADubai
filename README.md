# Mukbang Dash

An arcade dash down Sheikh Zayed Road at dusk to the **Love Mukbang** branch at Dubai World
Trade Centre. Weave rush-hour traffic, beat the clock, screech up to the storefront before it
hits zero — and walk away with a table booking and a discount code.

It is a game. It is also an ad.

**You drive it from the driver's seat.** FPV is the default and the whole scene is framed for
it; a behind-the-car chase view is on the title screen for anyone who prefers it.

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
    desert.ts         The sand the city stands on — one plane, one draw call
    city.ts           Whole skyline as one InstancedMesh
    storefront.ts     The Love Mukbang branch at the finish
  render/
    pipeline.ts       Bright pass -> dual-filter bloom -> composite
    sky.ts            Analytic dusk sky (shared with the road's reflections)
  game/
    game.ts           Phase machine, fixed-timestep sim, scoring
    car.ts            Arcade handling
    cockpit.ts        The driver's-eye interior, for FPV
    traffic.ts        Pooled rush-hour traffic in formations, 5 draw calls
    cameras.ts        FPV (default), chase, and the retained top-down rig
  audio/engine.ts     Synthesised engine, wind, skid, impacts
  net/                Voucher endpoint + per-branch leaderboard
  ui/                 Title, HUD, arrival, voucher, leaderboard
```

**Everything moving is addressed as `(s, t)`** — metres along the corridor centreline, and
metres laterally from it. Traffic AI, lane logic, collision, checkpoints and every camera all
reason in that straight 1-D corridor and only touch world space to render. It is the single
decision that keeps the rest of the code small.

## How the run plays

Traffic is issued in **formations**, not scattered. A wall with one gap, a diagonal stagger, a
pair, a single — then clear road, then the next one. That rhythm is the game: read the shape,
pick a line, take the reward on the way out.

Two rules make it fair and make it worth doing:

- **One lane is always open.** A through-line is reserved in every formation and drifts by at
  most one lane per gap — and only across gaps long enough for the car to physically make the
  move. Without it, two independently-placed packs can land close enough to merge into a solid
  five-lane wall, which is not difficulty, it is an unavoidable crash.
- **Near misses pay in seconds.** The clock is the only thing that can end a run, so the
  reward for shaving a car is time on it, scaled by the combo. Risk buys time buys distance
  buys more formations to risk. A good player is fast because they are brave.

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
node tools/critic/shoot.mjs --mode=fpv --label=r1
node tools/critic/shoot.mjs --mode=chase --label=r1-chase
```

Traffic is the one system a screenshot cannot judge — any single frame is either inside a
formation or inside a gap, and both are correct. `traffic-probe.mjs` reads the live layout
ahead of the player instead, and prints the clustering:

```sh
node tools/critic/traffic-probe.mjs
#  sample 0: 18 ahead · 7 packs · size 1-7 · gaps 23-124m
#            189m[...##] 228m[.#...] 346m[..##.] 442m[..#..] 566m[#....] 611m[#.###]
```

Each `[.....]` is the five lanes at that distance. It is how the merged-wall bug — two packs
landing close enough to fill every lane at once — was found and how the through-line guarantee
is verified.

A separate critic reviews only those pixels — never a description of the work — names the
single largest gap against the quality bar, and that one gap is what gets fixed next round.

> CI renders under SwiftShader (software GL), so absolute frame times there are a floor, not a
> phone number. Draw calls, triangle counts and round-over-round deltas are the signals that
> transfer; the look is judged from the pixels.
