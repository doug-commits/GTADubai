# Mukbang Dash — Asset Slot Manifest

**"Ember & Char" art drop guide for Love Mukbang.**
Everything the game will accept from the client's art team, with the exact filename, size and
format for each slot.

---

## Read this first

> ### 1. Every slot below currently renders a procedural placeholder generated in-engine.
> The game is complete and shippable with **zero** art files. Skies, asphalt, glazing, signage,
> the car's paint — all of it is generated in shader code at runtime.
> **Dropping a correctly-named file into `public/assets/...` replaces the placeholder with no
> code change, no rebuild step, and no configuration.** Remove the file and the procedural
> version comes straight back. Slots are independent: ship one file or all of them.

> ### 2. Original or client-owned art only.
> **No Google Maps, Street View, Earth, or any Google-derived imagery. Ever.** No scraped
> photography, no stock without a paid commercial licence, no competitor branding, no
> AI-generated output that reproduces a real logo or a real person. Every file dropped into
> `public/assets/` must be art Love Mukbang owns or has a written commercial licence for,
> because it ships inside a public advergame. If in doubt about a file, leave the slot empty —
> the procedural placeholder is always a safe fallback.

> ### 3. Halal food rule, no exceptions.
> Any art showing food — the storefront, the interior BBQ table, billboard creatives, the win
> screen — is **beef and chicken only**. **No pork. No samgyeopsal.** No pork belly, no bacon,
> no ham, no pork-fat garnish, and nothing that reads as pork on a grill. Beef short rib
> (galbi), bulgogi, beef brisket, marinated chicken and seafood are the safe subjects. Alcohol
> must not appear either: soju bottles, beer glasses and wine are out.

---

## How the slots work

Files live under `public/` and are served at the site root, so a file saved as
`public/assets/road/albedo.webp` is fetched by the game as `assets/road/albedo.webp`.

```
public/
  assets/
    sky/          dusk skybox
    road/         asphalt surface maps
    buildings/    facade / window atlas
    billboards/   roadside advertising creatives
    storefront/   win-screen photography
    brand/        logo & wordmark
    car/          player car livery
```

Each loader is wired to fail silently: if the file is missing, malformed, or blocked, the
`onError` path is a no-op and the procedural version keeps rendering. Nothing crashes, nothing
logs a scary error to the player, and boot time is unaffected.

**Wiring status** is listed per slot:

| Status | Meaning |
| --- | --- |
| **Live** | Loader is in the shipped engine today. Drop the file in, hard-refresh, done. |
| **Reserved** | Path and spec are agreed and locked. The loader lands with the screen that uses it; art delivered to this exact path will be picked up without a spec conversation. |

---

## Global conventions

| Topic | Rule |
| --- | --- |
| **Naming** | Exact lowercase filenames as written below. No spaces, no `final_v3`, no capitals. The loader looks for one literal string. |
| **Format** | `.webp` for everything raster (quality 82–90, lossy). It is 25–40% smaller than JPEG at the same quality and is supported on every browser this game targets. PNG only where alpha must be lossless. SVG for the wordmark. |
| **Dimensions** | Exact pixel sizes below. Tiling maps must be power-of-two (1024²) or the GPU cannot mipmap them and the road will shimmer at distance. |
| **Colour space** | Anything the eye reads as *colour* (albedo, sky, facade, billboards, storefront, livery) is authored and exported in **sRGB**. Anything the eye reads as *data* (roughness, normal) must be exported as **linear / non-colour** — no sRGB profile, no "convert to sRGB" on export. Getting this backwards makes the road look plastic. |
| **Weight budget** | This is a phone-first advergame opened from a QR code on a table. Keep the **total** of all delivered assets under **6 MB**, and no single file over 2 MB. The skybox is the one that will blow the budget if it is exported carelessly. |
| **Colour direction** | "Ember & Char": dark charcoal/plum shadows, hot ember orange, warm gold highlights. Reference palette below. |
| **Mood** | Dubai, blue hour bleeding into dusk, wet asphalt, sodium streetlights, warm window glow. Never daylight, never neon-cyan cyberpunk. |
| **Delivery** | Drop the files into `public/assets/<folder>/`, keeping the folder names exactly as written. No renaming, no nesting. |

### Reference palette — "Ember & Char"

These are the exact values the engine renders today, converted to sRGB hex. Art that matches
these will sit in the scene instead of on top of it.

| Role | Hex | Where it comes from |
| --- | --- | --- |
| Char (zenith / deepest shadow) | `#30374F` | Sky zenith |
| Smoke (mid sky, cool shadow) | `#765C66` | Sky mid-band |
| Ember (horizon, primary accent) | `#E2935D` | Sky horizon |
| Ember flare (highlight, glows hotter than white) | `#FFBF6C` | Sun/ember band |
| Haze (atmospheric wash) | `#AD7E76` | Distance haze |
| Ember red (hero car, brand red) | `#CE4227` | Player car paint |
| Sodium gold (street lighting, warm gold) | `#FFC47C` | Streetlamp glow |
| Warm white (headlights, key highlight) | `#FFEFD4` | Headlights |
| Signal red (taillights, alerts) | `#FF553F` | Taillights |

---

# The slots

## 1. Dusk skybox

The single highest-impact asset. It sets the entire mood and it is also reflected in the wet
road surface, so a good sky improves the asphalt for free.

**Choose ONE of the two options — do not deliver both.**

### Option A — Equirectangular (preferred, simplest)

| | |
| --- | --- |
| **Path** | `public/assets/sky/dusk.webp` |
| **Dimensions** | **4096 × 2048** (2:1 ratio, mandatory) |
| **Format** | WebP, quality 88. HDR source is welcome, but deliver the tone-mapped WebP — the runtime samples it as an sRGB texture. |
| **Colour space** | sRGB |
| **Wiring status** | **Live** |
| **Budget** | ≤ 1.5 MB |
| **Used for** | The whole sky dome, plus the sky reflection sampled by the wet-asphalt shader. |

Notes:
- The horizon must sit exactly on the vertical centre line of the image (v = 0.5). If the
  horizon drifts, the road's reflection will not line up with the sky.
- The sun sits **low and slightly north-east** — roughly 20° above the horizon. Keep the hottest
  part of the sky in that quadrant so the in-engine lighting agrees with the image.
- Mipmaps are disabled for this texture, so avoid fine high-frequency detail (dense star fields,
  sharp cloud speckle) that will alias when the camera turns.
- Bake in the Dubai skyline silhouette if desired, but keep it soft and low-contrast — the real
  skyline is built as geometry in front of it and a hard painted skyline will double up.

### Option B — Cubemap (6 faces)

| | |
| --- | --- |
| **Paths** | `public/assets/sky/px.webp`, `nx.webp`, `py.webp`, `ny.webp`, `pz.webp`, `nz.webp` |
| **Dimensions** | **1024 × 1024** each (six files, square, identical size) |
| **Format** | WebP, quality 88 |
| **Colour space** | sRGB |
| **Wiring status** | **Reserved** — deliver Option A unless there is a reason to prefer faces. |
| **Budget** | ≤ 250 KB per face, ≤ 1.5 MB total |
| **Used for** | Same as Option A. |

Notes:
- Naming follows the standard axis convention: `px` = +X (east), `nx` = −X (west),
  `py` = +Y (up), `ny` = −Y (down), `pz` = +Z (south), `nz` = −Z (north).
- Faces must be seamless at the edges. Any visible seam will run down the middle of the sky.
- `ny` (down) is never visible — deliver a flat dark charcoal fill and spend no time on it.

---

## 2. Road surface

Tiling maps for the asphalt ribbon. Lane markings, puddles and the sun streak are drawn
mathematically in the shader and are **not** part of these textures — supply clean asphalt only,
with **no painted lines**, or the game will draw lanes on top of your lanes.

**Tiling scale: 4 metres per tile.** A 1024² texture therefore covers a 4 m × 4 m patch of road,
about 256 px per metre. Author to that scale: chip and aggregate detail should read correctly at
that density, and all three maps must tile seamlessly in both directions.

| Slot | Path | Dimensions | Format | Colour space | Status | Used for |
| --- | --- | --- | --- | --- | --- | --- |
| **Albedo** | `public/assets/road/albedo.webp` | 1024 × 1024 | WebP q85 | **sRGB** | **Live** | Base asphalt colour, blended over the procedural surface. Dark neutral charcoal, subtle aggregate, tar-seam variation, faint oil staining. No lane paint. |
| **Roughness** | `public/assets/road/roughness.webp` | 1024 × 1024 | WebP q85, greyscale | **Linear / non-colour** | **Live** | Wet-vs-dry breakup. White = rough/dry, black = smooth/wet-glossy. This is what makes puddles read as puddles under the streetlights. |
| **Normal** | `public/assets/road/normal.webp` | 1024 × 1024 | WebP q90 | **Linear / non-colour** | **Reserved** | Surface relief — aggregate, cracks, tar seams. **OpenGL convention (+Y up / green up).** Keep it gentle; strong normals at 200 km/h read as noise. |

Notes:
- All three maps must be the same 4 m footprint and pixel-aligned with each other.
- Budget: ≤ 400 KB each.
- The verge and shoulder use the same maps, so avoid detail that only makes sense mid-lane.

---

## 3. Building facade atlas

| | |
| --- | --- |
| **Path** | `public/assets/buildings/facade.webp` |
| **Dimensions** | **1024 × 1024** |
| **Format** | WebP q85 |
| **Colour space** | sRGB |
| **Wiring status** | **Live** |
| **Budget** | ≤ 500 KB |
| **Used for** | Overlaid at 30% onto the procedurally-lit tower glazing across the whole skyline. |

**Grid: 4 bays wide × 4 floors tall in the 1024² image.**
The engine's window bay is **2.9 m wide × 3.6 m per floor**, and one texture tile spans four of
each — so the image covers **11.6 m × 14.4 m** of building face, i.e. **256 × 256 px per window
cell**. Lay the grid out on those cell boundaries or the windows will not line up with the
engine's lighting.

Notes:
- **Emissive window grid**: bright cells = lit offices, dark cells = unlit. Vary them —
  a perfectly regular checkerboard reads as fake instantly.
- Warm interior gold (`#FFC47C` → `#FFEFD4`) for lit cells; near-black plum/charcoal for
  mullions, spandrel panels and unlit glass.
- Must tile seamlessly horizontally **and** vertically — it wraps around towers and repeats up
  them.
- It multiplies over engine lighting, so keep the overall image mid-dark. A bright atlas washes
  the skyline out to grey.
- Generic Dubai-style curtain-wall glazing only. Do not reproduce an identifiable real building's
  facade, and do not include any real company's signage.

---

## 4. Billboard creatives

Roadside advertising along the corridor. Three independent slots, shown on the large hoardings
the player passes at speed — this is prime Love Mukbang brand real estate.

| Slot | Path | Dimensions | Format | Colour space | Status |
| --- | --- | --- | --- | --- | --- |
| Billboard 1 | `public/assets/billboards/01.webp` | 1024 × 512 | WebP q88 | sRGB | **Reserved** |
| Billboard 2 | `public/assets/billboards/02.webp` | 1024 × 512 | WebP q88 | sRGB | **Reserved** |
| Billboard 3 | `public/assets/billboards/03.webp` | 1024 × 512 | WebP q88 | sRGB | **Reserved** |

**Used for**: 2:1 landscape hoardings, rendered slightly emissive so they glow at dusk like real
backlit signage.

Notes:
- Budget: ≤ 300 KB each.
- **Read-at-speed rule**: the player sees each board for well under a second at 200 km/h. One
  idea per board. Huge type. A logo, five words maximum, one hero image. Phone numbers, QR codes,
  addresses and paragraphs are wasted here.
- Keep critical content inside a **10% safe margin** — edges are clipped by the hoarding frame.
- Assume the boards are lit from the front by warm light. Very dark creatives disappear at dusk;
  aim for mid-to-bright with strong contrast.
- Suggested set: (1) the wordmark alone, (2) a hero beef-galbi shot with an AYCE line,
  (3) a branch call-out ("DWTC · JBR · Deira · Muroor · Electra").
- Halal rule applies in full: beef and chicken only, no alcohol.

---

## 5. Storefront & interior (win screen)

Shown when the player arrives at the branch — the emotional payoff and the shot that sells the
restaurant. This is the most important *photographic* asset in the game.

| Slot | Path | Dimensions | Format | Colour space | Status |
| --- | --- | --- | --- | --- | --- |
| **Storefront exterior** | `public/assets/storefront/exterior.webp` | **1600 × 900** (16:9) | WebP q88 | sRGB | **Reserved** |
| **Interior BBQ table** | `public/assets/storefront/interior.webp` | **1600 × 900** (16:9) | WebP q88 | sRGB | **Reserved** |

**Used for**: the win screen hero image and the panel behind the voucher card.

Notes:
- Budget: ≤ 600 KB each.
- **Exterior**: the real Love Mukbang shopfront at dusk/blue hour with the interior lights on and
  the sign lit. Shoot or grade it warm — it should feel like the ember palette continues into the
  photograph. A slightly wet pavement reflecting the sign is exactly the right note.
- **Interior**: a full BBQ table mid-service — grill lit, **beef short rib / bulgogi / marinated
  chicken** on the grate, banchan spread, steam, warm overhead light. Hands and diners are welcome
  if they are staff or models with a signed release.
- **Halal, restated because this is the slot that gets it wrong**: **beef and chicken only. No
  pork. No samgyeopsal. No pork belly.** No soju, beer or wine bottles anywhere in frame.
- Compose with the centre clear: the voucher card and the "Claim your discount" button sit over
  the middle of the image. Keep the hero food off-centre (rule of thirds) and leave the middle
  third relatively calm.
- Both images may be darkened and gradient-masked by the UI, so avoid images that are already
  very dark or very low-contrast.

---

## 6. Logo / wordmark

| Slot | Path | Dimensions | Format | Colour space | Status |
| --- | --- | --- | --- | --- | --- |
| **Wordmark (preferred)** | `public/assets/brand/wordmark.svg` | Vector, any artboard — design at ~640 × 160 | **SVG** | — | **Reserved** |
| **Wordmark raster fallback** | `public/assets/brand/wordmark.webp` | 1024 × 256, transparent | WebP q90 with alpha | sRGB | **Reserved** |
| **Logo mark (square)** | `public/assets/brand/logo.svg` | Vector, square artboard | **SVG** | — | **Reserved** |

**Used for**: the title screen, the win screen header, and the voucher card.

Notes:
- **SVG strongly preferred** — it stays crisp on every phone at every DPI and costs a few KB.
- Outline all text to paths. Do not rely on a font being present.
- No embedded raster images inside the SVG, no external references, no scripts. A clean
  path-only SVG under 40 KB.
- Deliver in the **light-on-dark** version: the game's UI is dark charcoal, so a dark-ink logo
  will vanish. If the brand's primary is dark, supply the approved reversed/knockout variant.
- Include a transparent margin of about 8% of the artboard so the UI can place it without
  clipping the ascenders.
- The mark may be tinted by the UI at low opacity for watermarks; a single-colour or
  limited-palette mark handles that best.

---

## 7. Player car livery

| | |
| --- | --- |
| **Path** | `public/assets/car/livery.webp` |
| **Dimensions** | **512 × 512** |
| **Format** | WebP q88 (PNG if crisp alpha edges are needed) |
| **Colour space** | sRGB |
| **Wiring status** | **Reserved** |
| **Budget** | ≤ 200 KB |
| **Used for** | Wrapped over the hero car's body panels, on top of the procedural ember-red car paint. |

Notes:
- The car currently renders in procedural **ember red `#CE4227`** with a physically-based dusk
  gloss. The livery is a **decal layer over that paint**, not a full repaint — think delivery-car
  branding: wordmark on the doors, a stripe, a flash of gold.
- Leave large areas transparent or neutral. A fully-covered 512² map fights the paint shader and
  the car loses its reflective sheen, which is most of what makes it look good at dusk.
- Design for **motion**: the player sees the car from behind, small, at speed. Small text on the
  doors will never be read. Big shapes, high contrast, brand colours.
- Keep it bilaterally sensible — the same map is used on both sides, so avoid text that only
  reads correctly on one flank.
- Nothing that resembles a real taxi, police, ambulance or government livery (UAE regulator
  sensitivity), and no real third-party sponsor logos.

---

## Delivery checklist

- [ ] Filenames match this document **exactly** (lowercase, no version suffixes).
- [ ] Files are in `public/assets/<folder>/` with the folder names unchanged.
- [ ] Tiling maps (road, facade) are 1024² and verified seamless.
- [ ] Roughness and normal maps exported as **linear / non-colour**, everything else **sRGB**.
- [ ] Total delivery under 6 MB; no single file over 2 MB.
- [ ] Every file is original or client-owned. **No Google Maps / Street View / Earth imagery.**
- [ ] All food art is **beef and chicken only** — no pork, no samgyeopsal — and no alcohol.
- [ ] Release forms on file for any identifiable person appearing in the storefront photography.

Anything not delivered simply keeps its procedural placeholder. There is no broken state.
