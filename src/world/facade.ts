import * as THREE from 'three';
import { PBR_GLSL, SKY_IBL_GLSL } from '../render/pbr';
import { SKY_GLSL, SUN_DIR } from '../render/sky';

/**
 * Tower facades.
 *
 * Drop-in replacement for the flat-shaded window-grid shader in `city.ts`. Same
 * instancing contract: ONE InstancedMesh of unit boxes, `instanceMatrix` plus a
 * per-instance `aParams` = vec4(width, height, depth, seed) in metres.
 *
 * The old shader painted an emissive checkerboard onto a flat box, which is
 * exactly why the skyline read as Minecraft: a facade with no depth is a
 * sticker, and the eye reads stickers as toy geometry no matter how good the
 * colours are. Four things fix that here, roughly in order of how much they buy:
 *
 *  1. PARALLAX. A bounded 12-step occlusion march over a procedural relief field
 *     puts the glass behind the frame. Mullions occlude the near edge of the
 *     pane at grazing angles and the window interiors slide against the frame as
 *     the camera passes. This is the single effect that kills the flat read.
 *  2. INTERIORS. Behind the glass plane is a real room, found by an analytic
 *     ray-box intersection (interior mapping) — back wall, ceiling, floor, side
 *     walls, per-room colour temperature, drawn blinds, desk-height silhouettes.
 *     Exact, no iteration, ~15 ALU.
 *  3. ARTICULATION. Podium / shaft / crown bands derived from the instance
 *     height, plus mechanical floors, corner pilasters and parapets, so a tower
 *     is not the same wallpaper from pavement to roof.
 *  4. REAL PBR. Everything shades through `pbr.ts` — glass is a f0 = 0.04
 *     dielectric that mirrors the dusk sky at grazing angles and goes dark
 *     facing away; spandrel and precast are rough dielectrics; mullion caps are
 *     anodised metal. No ad-hoc fresnel anywhere.
 *
 * Metric discipline matters more than it sounds: 3.4-3.8 m floor-to-floor and
 * 1.4-1.6 m glazing modules are what make the eye read "40 storeys" instead of
 * "a striped box". Every dimension below is in real metres.
 *
 * ASSET SLOT: `public/assets/buildings/facade.webp` — blended multiplicatively
 * over the procedural albedo when present. The procedural path stands alone.
 *
 * NOTE FOR ANYONE EDITING THE GLSL: never put a backtick in a shader comment.
 * It silently terminates the template literal. `tools/check-shaders.mjs` guards
 * this and it has already cost this project two rounds.
 */

export const FACADE_VERT = /* glsl */ `
  in vec3 position;
  in vec3 normal;
  in mat4 instanceMatrix;
  in vec4 aParams;   // xyz = box size in metres, w = seed

  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat4 modelMatrix;

  out vec3 vWorld;
  out vec3 vLocal;   // metres, origin at the box centre
  out vec3 vNObj;    // object-space normal: always one of the six box axes
  out vec4 vParams;
  out vec3 vEx;
  out vec3 vEy;
  out vec3 vEz;

  void main() {
    vParams = aParams;
    vLocal  = position * aParams.xyz;
    vNObj   = normal;

    mat4 M = modelMatrix * instanceMatrix;
    vWorld = (M * vec4(position, 1.0)).xyz;

    // Per-instance world basis. The boxes are scaled non-uniformly, so the
    // NORMALISED columns are the world directions of the box's own axes. Because
    // every face normal on a box is axis aligned, those columns double as the
    // exact world face normals (no normal matrix needed) and as the orthonormal
    // tangent frame the parallax march needs. Deriving the frame this way rather
    // than from screen-space derivatives is what keeps the parallax stable when
    // a tower is edge-on to the camera.
    vEx = normalize(M[0].xyz);
    vEy = normalize(M[1].xyz);
    vEz = normalize(M[2].xyz);

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

export const FACADE_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;

  in vec3 vWorld;
  in vec3 vLocal;
  in vec3 vNObj;
  in vec4 vParams;
  in vec3 vEx;
  in vec3 vEy;
  in vec3 vEz;

  out vec4 outColor;

  uniform vec3  uCameraPos;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;   // linear HDR radiance of the dusk sun
  uniform float uTime;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uDetailFar;  // metres: parallax and window detail are gone past this
  uniform float uLitAmount;  // 0..1 global scale on how many rooms are lit
  uniform float uParallax;   // 0..1 master scale on recess depth, for perf dialling
  uniform sampler2D tFacade;
  uniform float uHasFacade;

  ${SKY_GLSL}
  ${PBR_GLSL}
  ${SKY_IBL_GLSL}

  // -------------------------------------------------------------------------
  // hashes
  // -------------------------------------------------------------------------

  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), fpart = fract(p);
    fpart = fpart * fpart * (3.0 - 2.0 * fpart);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), fpart.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), fpart.x), fpart.y);
  }

  // -------------------------------------------------------------------------
  // facade description
  //
  // All lengths in metres. Vertical coordinates are HEIGHT ABOVE GROUND, not
  // box-local: landmark silhouettes are stacks of boxes, and anchoring the floor
  // grid to world Y is what keeps floor lines continuous across a stack instead
  // of restarting at every tier seam.
  // -------------------------------------------------------------------------

  struct Facade {
    float floorH;     // floor to floor
    float bayW;       // glazing module
    float mullionW;   // HALF width of the mullion cap
    float transomH;   // head transom depth
    float spandrelH;  // opaque band above each slab
    float recess;     // glass set back from the wall plane = parallax depth
    float roomD;      // interior depth used by the ray-box
    float roomBays;   // bays per room
    float pierSpan;   // metres between masonry piers, 0 = curtain wall
    float pierW;
    float halfU;      // half extent of THIS face horizontally, for corner pilasters
    float glassRough;
    vec3  glassTint;
    vec3  panelCol;
    float panelRough;
    vec3  stoneCol;
    float warmBias;   // 0 = office (cool light), 1 = residential (warm)
    float litChance;
    float podiumTop;  // solid base up to here
    float shopLo;     // glazed shopfront slot inside the podium
    float shopHi;
    float crownLo;    // louvred crown starts here (huge when the box has no crown)
    float parapetLo;  // solid parapet cap
    float bandSpan;   // mechanical floor every bandSpan metres
    float hasMech;
    float glassFrac;  // area fraction that is glass — the LOD target for the grid
  };

  Facade makeFacade(float seed, float boxH, float baseY, float topY) {
    Facade f;

    float a = hash11(seed * 0.731 + 1.3);
    float b = hash11(seed * 1.117 + 7.7);
    float c = hash11(seed * 0.517 + 13.1);
    float d = hash11(seed * 2.031 + 21.9);
    float e = hash11(seed * 0.911 + 31.7);

    // Real commercial curtain wall. These two numbers carry the sense of scale
    // for the entire skyline; drifting outside them is what made the old grid
    // read as blocks rather than storeys.
    f.floorH    = mix(3.42, 3.78, a);
    f.bayW      = mix(1.40, 1.60, b);
    f.mullionW  = mix(0.055, 0.085, c);
    f.transomH  = mix(0.06, 0.11, d);
    f.spandrelH = mix(0.90, 1.25, e);
    f.roomD     = mix(4.2, 7.6, c);
    f.roomBays  = 2.0 + floor(d * 2.0);
    f.halfU     = 8.0;

    // Three archetypes. Branching on a per-instance value is coherent across
    // every pixel of a tower, so it costs nothing outside the silhouette edge,
    // and it buys far more visible variety than blending one parameter set.
    float arch = hash11(seed * 3.313 + 5.1);
    if (arch < 0.44) {
      // Unitised curtain wall: glass mullion to mullion, shallow reveal.
      f.recess     = mix(0.13, 0.22, a);
      f.pierSpan   = 0.0;
      f.pierW      = 0.0;
      f.glassRough = mix(0.060, 0.105, b);
    } else if (arch < 0.80) {
      // Punched openings in a precast wall. Deep reveals, so this archetype
      // carries most of the parallax read at close range.
      f.recess     = mix(0.34, 0.55, a);
      f.pierSpan   = f.bayW * (3.0 + floor(b * 2.0));
      f.pierW      = mix(0.45, 0.85, c);
      f.glassRough = mix(0.085, 0.150, b);
      f.spandrelH  = mix(1.05, 1.45, e);
    } else {
      // Ribbon glazing: continuous horizontal bands, slim mullions, deep sill.
      f.recess     = mix(0.22, 0.34, a);
      f.pierSpan   = 0.0;
      f.pierW      = 0.0;
      f.mullionW  *= 0.55;
      f.spandrelH  = mix(1.30, 1.70, e);
      f.glassRough = mix(0.060, 0.110, b);
    }
    f.recess *= clamp(uParallax, 0.0, 2.0);

    // Dubai glazing runs blue-green, neutral grey or bronze. Albedo is near
    // black on purpose — glass has almost no diffuse; everything you see in it
    // is reflection or transmitted room light.
    float g = hash11(seed * 5.77 + 41.3);
    vec3 blueGreen = vec3(0.010, 0.019, 0.030);
    vec3 neutral   = vec3(0.017, 0.017, 0.019);
    vec3 bronze    = vec3(0.028, 0.019, 0.011);
    f.glassTint = mix(blueGreen, neutral, smoothstep(0.30, 0.62, g));
    f.glassTint = mix(f.glassTint, bronze, smoothstep(0.72, 0.96, g));

    f.panelCol   = mix(vec3(0.030, 0.031, 0.035), vec3(0.085, 0.078, 0.070), hash11(seed * 7.3 + 3.9));
    f.panelRough = mix(0.16, 0.55, hash11(seed * 11.1 + 9.4));
    f.stoneCol   = mix(vec3(0.100, 0.090, 0.075), vec3(0.170, 0.152, 0.126), hash11(seed * 13.7 + 17.2));

    // Office towers at dusk are mostly still lit and mostly cool-white.
    // Residential is patchier and much warmer.
    f.warmBias  = step(0.55, hash11(seed * 17.3 + 27.5));
    f.litChance = mix(0.47, 0.33, f.warmBias);

    // --- vertical articulation ---------------------------------------------
    // Podium only for boxes that actually stand on the ground. Landmarks are
    // stacked boxes and a podium growing out of every tier would be absurd.
    float onGround = step(baseY, 4.0);
    float storeys  = 2.0 + floor(hash11(seed * 19.7 + 2.2) * 3.0);   // 2..4
    f.podiumTop = mix(-1.0, min(storeys * f.floorH * 1.30, max(boxH, 2.0) * 0.42), onGround);
    // Ground-floor shopfront slot: the one part of a tower the player drives past
    // at eye level, so it gets its own glazing and its own much brighter interior.
    f.shopLo = mix(-1.0, 0.7, onGround);
    f.shopHi = mix(-1.0, 4.3, onGround);

    // Crown only on boxes tall enough to be a whole tower. Stacked landmark
    // tiers come out well under this, so they do not each grow a parapet.
    float hasCrown = step(55.0, boxH);
    float crownH   = clamp(boxH * 0.055, 3.2, 13.0);
    f.crownLo   = mix(1.0e6, topY - crownH, hasCrown);
    f.parapetLo = mix(1.0e6, topY - 0.85, hasCrown);

    // Refuge / plant floors every ~16 storeys. Only supertalls have them, and
    // they are one of the clearest "this is a real tower" cues at distance.
    f.hasMech  = step(90.0, boxH);
    f.bandSpan = f.floorH * 16.0;

    // Analytic mean glass coverage. Used as the LOD target so the window grid
    // dissolves into the correct average instead of into noise.
    f.glassFrac = clamp(1.0 - 2.0 * f.mullionW / f.bayW, 0.0, 1.0)
                * clamp((f.floorH - f.spandrelH - f.transomH) / f.floorH, 0.0, 1.0);
    if (f.pierSpan > 0.0) f.glassFrac *= clamp(1.0 - f.pierW / f.pierSpan, 0.0, 1.0);

    return f;
  }

  // -------------------------------------------------------------------------
  // relief field
  //
  // 1.0 = the outer wall plane (mullion cap, spandrel, pier, podium).
  // 0.0 = the recessed glass plane.
  //
  // Deliberately near-binary: real curtain wall is a flat sheet of glass set
  // behind a flat frame, not a smooth bump map.
  //
  // The soft parameter is the antialias width in metres, driven by the pixel's
  // screen-space footprint, so it doubles as the mip chain — as one pixel grows
  // to cover a bay the whole field flattens to its mean and the grid stops
  // moireing instead of crawling.
  //
  // Kept lean on purpose: this runs once per parallax step.
  // -------------------------------------------------------------------------

  float facadeRelief(vec2 p, Facade f, float soft) {
    float hb = f.bayW * 0.5;

    float du   = abs(fract(p.x / f.bayW) - 0.5) * f.bayW;
    float mull = smoothstep(hb - f.mullionW - soft, hb - f.mullionW + soft, du);

    float vy   = fract(p.y / f.floorH) * f.floorH;
    float span = 1.0 - smoothstep(f.spandrelH - soft, f.spandrelH + soft, vy);
    float head = smoothstep(f.floorH - f.transomH - soft, f.floorH - f.transomH + soft, vy);

    float solid = max(max(mull, span), head);

    // Masonry piers between the punched openings.
    if (f.pierSpan > 0.0) {
      float dp = abs(fract(p.x / f.pierSpan) - 0.5) * f.pierSpan;
      float pe = f.pierSpan * 0.5 - f.pierW * 0.5;
      solid = max(solid, smoothstep(pe - soft, pe + soft, dp));
    }

    // Corner pilaster. Without a solid edge the glazing wraps the box corner and
    // the whole thing snaps back to reading as a decorated cube.
    solid = max(solid, smoothstep(f.halfU - 0.42 - soft, f.halfU - 0.42 + soft, abs(p.x)));

    // Podium: solid, with the shopfront slot punched back out of it.
    float shop = smoothstep(f.shopLo - soft, f.shopLo + soft, p.y)
               * (1.0 - smoothstep(f.shopHi - soft, f.shopHi + soft, p.y));
    float pod  = 1.0 - smoothstep(f.podiumTop - soft, f.podiumTop + soft, p.y);
    solid = mix(solid, mull, shop);        // shopfront keeps mullions, drops the spandrel
    solid = max(solid, pod * (1.0 - shop));

    // Crown and mechanical floors are louvred screens, not glass — a fine
    // horizontal relief that catches the low sun as a stack of bright lines.
    float mfl  = mod(p.y, f.bandSpan);
    float mech = f.hasMech * smoothstep(f.bandSpan - f.floorH - soft, f.bandSpan - f.floorH + soft, mfl);
    float scr  = max(mech, smoothstep(f.crownLo - soft, f.crownLo + soft, p.y));
    float louvre = smoothstep(0.30, 0.55, abs(fract(p.y / 0.40) - 0.5) * 2.0);
    solid = mix(solid, mix(0.45, 1.0, louvre), scr);

    // Parapet cap: fully solid, and the thing the beacon sits on.
    solid = max(solid, smoothstep(f.parapetLo - soft, f.parapetLo + soft, p.y));

    return clamp(solid, 0.0, 1.0);
  }

  /**
   * Material weights at a point: x = mullion cap, y = masonry, z = louvred
   * screen. Whatever is left over is spandrel panel.
   *
   * Duplicates some of facadeRelief's masks on purpose — this is evaluated ONCE,
   * at the parallax hit point, and folding it into the relief function would
   * make the twelve-iteration march carry weight it does not need.
   */
  vec3 facadeMats(vec2 p, Facade f, float soft) {
    float hb   = f.bayW * 0.5;
    float du   = abs(fract(p.x / f.bayW) - 0.5) * f.bayW;
    float mull = smoothstep(hb - f.mullionW - soft, hb - f.mullionW + soft, du);

    float masonry = smoothstep(f.halfU - 0.42 - soft, f.halfU - 0.42 + soft, abs(p.x));
    if (f.pierSpan > 0.0) {
      float dp = abs(fract(p.x / f.pierSpan) - 0.5) * f.pierSpan;
      float pe = f.pierSpan * 0.5 - f.pierW * 0.5;
      masonry = max(masonry, smoothstep(pe - soft, pe + soft, dp));
    }
    float shop = smoothstep(f.shopLo - soft, f.shopLo + soft, p.y)
               * (1.0 - smoothstep(f.shopHi - soft, f.shopHi + soft, p.y));
    masonry = max(masonry, (1.0 - smoothstep(f.podiumTop - soft, f.podiumTop + soft, p.y)) * (1.0 - shop));

    float mfl  = mod(p.y, f.bandSpan);
    float mech = f.hasMech * smoothstep(f.bandSpan - f.floorH - soft, f.bandSpan - f.floorH + soft, mfl);
    float scr  = max(mech, smoothstep(f.crownLo - soft, f.crownLo + soft, p.y));

    return vec3(mull, masonry, scr);
  }

  /** Central-difference gradient of the relief, for the reveal normals. */
  vec2 reliefGrad(vec2 p, Facade f, float soft) {
    float e = max(soft, 0.012);
    float gx = facadeRelief(p + vec2(e, 0.0), f, soft) - facadeRelief(p - vec2(e, 0.0), f, soft);
    float gy = facadeRelief(p + vec2(0.0, e), f, soft) - facadeRelief(p - vec2(0.0, e), f, soft);
    return vec2(gx, gy) / (2.0 * e);
  }

  // -------------------------------------------------------------------------
  // parallax occlusion march
  //
  // Fixed 12 steps, early-out on first intersection, one linear refinement
  // between the last two samples. Fixed count because a phone GPU wants a
  // compile-time loop bound, and 12 because the relief is near-binary: the march
  // only has to find WHICH cell the ray enters, not resolve a smooth height
  // field, so more steps buy essentially nothing.
  //
  // Returns vec3(hit facade coords, hit depth 0..1 of the recess).
  // -------------------------------------------------------------------------

  vec3 marchFacade(vec2 uv0, vec2 duv, Facade f, float soft) {
    const int STEPS = 12;
    float dLayer = 1.0 / float(STEPS);
    vec2  dStep  = duv * dLayer;

    float layer = 0.0;
    vec2  uv    = uv0;
    float dh    = 1.0 - facadeRelief(uv, f, soft);   // depth of the surface below the wall plane

    float prevLayer = 0.0;
    vec2  prevUv    = uv;
    float prevDh    = dh;

    for (int i = 0; i < STEPS; i++) {
      if (layer >= dh) break;
      prevLayer = layer;
      prevUv    = uv;
      prevDh    = dh;
      layer += dLayer;
      uv    += dStep;
      dh     = 1.0 - facadeRelief(uv, f, soft);
    }

    float na = dh - layer;
    float nb = prevDh - prevLayer;
    float w  = clamp(nb / max(nb - na, 1e-4), 0.0, 1.0);
    return vec3(mix(prevUv, uv, w), mix(prevLayer, layer, w));
  }

  // -------------------------------------------------------------------------
  // interior
  //
  // Analytic interior mapping: one ray-box intersection against the room behind
  // the glass plane. No loop, exact parallax, and it hands back which surface
  // was hit so the ceiling can be the bright one and the floor the dark one.
  // That vertical gradient plus the per-room colour temperature is what stops
  // lit windows reading as identical glowing rectangles.
  // -------------------------------------------------------------------------

  vec3 interiorRadiance(vec2 hitUv, vec3 viewT, Facade f, float detail, float retail) {
    float roomW = f.bayW * f.roomBays;
    float ru = floor(hitUv.x / roomW);
    float rv = floor(hitUv.y / f.floorH);
    vec2  rid = vec2(ru, rv);

    float u0 = ru * roomW,   u1 = u0 + roomW;
    float v0 = rv * f.floorH, v1 = v0 + f.floorH;

    // Ray into the room in (across, up, inward) metres. viewT points AT the eye,
    // so the continuation into the material negates x and y and keeps z positive
    // as inward depth.
    vec3 r = vec3(-viewT.x, -viewT.y, max(viewT.z, 1e-3));
    vec3 rs = vec3(abs(r.x) < 1e-3 ? 1e-3 : r.x,
                   abs(r.y) < 1e-3 ? 1e-3 : r.y,
                   r.z);

    float tx = ((rs.x > 0.0 ? u1 : u0) - hitUv.x) / rs.x;
    float ty = ((rs.y > 0.0 ? v1 : v0) - hitUv.y) / rs.y;
    float tz = f.roomD / rs.z;
    float t  = min(min(tx, ty), tz);

    vec3  hp      = vec3(hitUv, 0.0) + rs * t;
    float depth01 = clamp(hp.z / f.roomD, 0.0, 1.0);
    float vf      = clamp((hp.y - v0) / f.floorH, 0.0, 1.0);

    float isBack  = step(tz, min(tx, ty));
    float isSide  = step(tx, min(ty, tz)) * (1.0 - isBack);
    float isY     = (1.0 - isBack) * (1.0 - isSide);
    float isCeil  = isY * step(0.0, rs.y);
    float isFloor = isY * (1.0 - step(0.0, rs.y));

    float lum = 0.30;
    lum = mix(lum, 0.34 + 0.42 * smoothstep(0.10, 0.95, vf), isBack);  // back wall brightens upward
    lum = mix(lum, 0.26, isSide);
    lum = mix(lum, 1.00, isCeil);                                      // recessed luminaire plane
    lum = mix(lum, 0.07, isFloor);                                     // carpet swallows light
    lum *= mix(1.0, 0.42, depth01);                                    // falloff with room depth

    // Desk-height clutter, partitions, the occasional person. Only in the back
    // half of the room and only in the lower half of its height.
    float colId = floor((hp.x - u0) / 0.55);
    float occ = step(0.58, hash21(vec2(colId, ru * 31.0 + rv)));
    occ *= 1.0 - smoothstep(0.18, 0.60, vf);
    occ *= smoothstep(0.08, 0.45, depth01);
    lum *= 1.0 - occ * 0.75 * detail;

    // Roughly a third of rooms have blinds part-drawn. They sit at the glass
    // plane, not in the room, so they occlude the interior from the top down.
    float blind  = step(0.68, hash21(rid * 1.7 + 9.3));
    float drop   = mix(0.30, 0.95, hash21(rid * 2.3 + 4.1));
    float vGlass = clamp((hitUv.y - v0) / f.floorH, 0.0, 1.0);
    float behind = blind * step(1.0 - drop, vGlass) * detail;
    float slat   = 0.86 + 0.14 * sin(hitUv.y * 62.8);
    lum = mix(lum, 0.70 * slat, behind);

    // Colour temperature per room, biased by building type.
    float ch = hash21(rid * 3.1 + 2.7);
    vec3 fluoro  = vec3(0.70, 0.83, 1.00);
    vec3 neutral = vec3(1.00, 0.94, 0.82);
    vec3 tungsten= vec3(1.00, 0.58, 0.24);
    vec3 tint = mix(fluoro, neutral, smoothstep(0.25, 0.55, ch));
    tint = mix(tint, tungsten, smoothstep(0.45, 0.85, ch) * (0.25 + 0.75 * f.warmBias));

    float lh   = hash21(rid * 5.3 + 12.1);
    float on   = step(1.0 - clamp(f.litChance * uLitAmount, 0.0, 1.0), lh);
    float brt  = mix(0.55, 1.45, hash21(rid * 7.9 + 3.3));

    // A handful of failing tubes. Rare enough to read as an accident.
    float flick = step(0.988, hash21(rid * 11.3 + 21.7));
    on *= mix(1.0, 0.45 + 0.55 * step(0.5, fract(uTime * 0.9 + lh * 13.0)), flick);

    // Retail at street level is always on, brighter, and warmer.
    tint = mix(tint, vec3(1.00, 0.86, 0.62), retail);
    on   = mix(on, 1.0, retail);
    brt  = mix(brt, 1.7, retail);

    // LOD: past the point where the grid resolves, every window collapses to the
    // building's MEAN emission. Stepping a hard on/off function per pixel out
    // there is what produces the crawling moire the bloom pass then amplifies.
    on = mix(clamp(f.litChance * uLitAmount, 0.0, 1.0), on, detail);

    // Unlit rooms are not black — dusk sky spills in and bounces off the ceiling.
    vec3 dim = vec3(0.055, 0.062, 0.085) * lum * (1.0 - depth01 * 0.6);
    return tint * lum * brt * on * 2.4 + dim;
  }

  // -------------------------------------------------------------------------

  void main() {
    vec3  size = vParams.xyz;
    float seed = vParams.w;

    // --- face frame --------------------------------------------------------
    // T and B are the world directions in which face.x and face.y increase, so
    // the parallax offset can be computed directly in facade metres.
    vec3  Ng, T, B;
    vec2  face;
    float halfU;
    bool  isRoof   = vNObj.y > 0.5;
    bool  isSoffit = vNObj.y < -0.5;

    if (isRoof || isSoffit) {
      Ng = vEy * sign(vNObj.y);
      T = vEx; B = vEz;
      face = vLocal.xz;
      halfU = size.x * 0.5;
    } else if (abs(vNObj.x) > 0.5) {
      Ng = vEx * sign(vNObj.x);
      T = vEz; B = vEy;
      face = vec2(vLocal.z, vWorld.y);
      halfU = size.z * 0.5;
    } else {
      Ng = vEz * sign(vNObj.z);
      T = vEx; B = vEy;
      face = vec2(vLocal.x, vWorld.y);
      halfU = size.x * 0.5;
    }

    vec3  Vdir = normalize(vWorld - uCameraPos);   // ray direction, away from the eye
    vec3  Vp   = -Vdir;                            // toward the eye: the PBR convention
    float dist = length(vWorld - uCameraPos);

    // --- detail LOD --------------------------------------------------------
    // The facade is a texture we are synthesising, so it needs a mip chain.
    // The foot value below is how many metres of facade one pixel covers, and
    // everything keyed off it fades coherently instead of aliasing. Computed
    // here, ahead of every branch, because derivatives are only defined in
    // uniform control flow.
    float foot = max(max(fwidth(face.x), fwidth(face.y)), 1e-4);

    float baseY = vWorld.y - (vLocal.y + size.y * 0.5);
    float topY  = vWorld.y + (size.y * 0.5 - vLocal.y);
    Facade f = makeFacade(seed, size.y, baseY, topY);
    f.halfU = halfU;

    float soft   = clamp(foot * 0.60, 0.012, f.bayW * 0.35);
    float detail = 1.0 - smoothstep(f.bayW * 0.30, f.bayW * 1.10, foot);
    detail *= 1.0 - smoothstep(uDetailFar * 0.55, uDetailFar, dist);
    detail = clamp(detail, 0.0, 1.0);

    // --- surface -----------------------------------------------------------
    vec3  albedo    = vec3(0.05);
    float metallic  = 0.0;
    float roughness = 0.8;
    float ao        = 1.0;
    vec3  emissive  = vec3(0.0);
    vec3  N         = Ng;

    // Aviation beacon phase, shared by the roof and the parapet point. Short
    // pulse, not a square wave — a real obstruction light is mostly off.
    float bph   = fract(uTime * 0.5 + seed * 0.37);
    float blink = smoothstep(0.0, 0.05, bph) * (1.0 - smoothstep(0.13, 0.24, bph));

    if (isSoffit) {
      // Undersides: raw soffit concrete, only ever seen from directly beneath.
      albedo = f.stoneCol * 0.55;
      roughness = 0.92;
      ao = 0.45;

    } else if (isRoof) {
      // ---- roof: screed, parapet, plant, beacon ---------------------------
      vec2  rp   = face;
      vec2  halfXZ = size.xz * 0.5;
      float edge = min(halfXZ.x - abs(rp.x), halfXZ.y - abs(rp.y));
      float parapet = 1.0 - smoothstep(0.5, 1.1, edge);

      float grain = vnoise(rp * 0.85) * 0.6 + vnoise(rp * 3.1) * 0.4;
      albedo = mix(vec3(0.050, 0.047, 0.044), vec3(0.090, 0.084, 0.077), grain);
      roughness = 0.92;

      // Chillers and AHUs as a hashed block grid. Cheap, and from street level
      // all that matters is that the roofline is not a clean empty plane.
      vec2  pc = floor(rp / 4.2);
      float plant = step(0.62, hash21(pc + seed)) * (1.0 - parapet);
      vec2  pf = abs(fract(rp / 4.2) - 0.5) * 2.0;
      plant *= 1.0 - smoothstep(0.60, 0.74, max(pf.x, pf.y));
      albedo    = mix(albedo, vec3(0.130, 0.128, 0.124), plant);
      roughness = mix(roughness, 0.45, plant);
      metallic  = mix(metallic, 0.55, plant);
      ao        = mix(1.0, 0.75, plant);

      albedo    = mix(albedo, f.stoneCol, parapet);
      roughness = mix(roughness, 0.80, parapet);

      // Beacon: a ~1.4 m point, very hot. Bloom turns that into a small halo;
      // a big soft blob here reads as a rendering bug, not as a light.
      if (size.y > 55.0) {
        emissive += vec3(1.0, 0.06, 0.02) * blink * smoothstep(1.4, 0.0, length(rp)) * 16.0;
      }

    } else {
      // ---- facade ---------------------------------------------------------
      vec3 viewT = vec3(dot(Vp, T), dot(Vp, B), dot(Vp, Ng));

      // Total tangent-plane offset at full recess depth. viewT.z is floored so
      // an edge-on face cannot demand an unbounded offset, and the total length
      // is capped at ~1.5 bays so a 12-step march can never stride clean over a
      // mullion. Both are the standard POM grazing-angle cheats; without them
      // the glazing smears sideways as the car passes a tower.
      vec2  duv = vec2(0.0);
      vec2  hitUv = face;
      float hitDepth = 0.0;

      if (detail > 0.02) {
        duv = -viewT.xy * (f.recess / max(viewT.z, 0.12));
        float dl = length(duv);
        duv *= (f.bayW * 1.5) / max(dl, f.bayW * 1.5);
        vec3 hit = marchFacade(face, duv, f, soft);
        hitUv = hit.xy;
        hitDepth = hit.z;
      }

      float relief   = facadeRelief(hitUv, f, soft);
      float glassAmt = 1.0 - relief;
      vec3  mats     = facadeMats(hitUv, f, soft);

      // LOD: blend every mask toward the building's analytic mean so the grid
      // dissolves into the correct average colour and roughness rather than
      // into a shimmering mess.
      glassAmt = mix(f.glassFrac, glassAmt, detail);
      mats     = mix(vec3(2.0 * f.mullionW / f.bayW, 0.10, 0.0), mats, detail);
      hitDepth *= detail;

      // --- normals ---------------------------------------------------------
      // Reveal shading from the relief gradient: the sides and head of each
      // opening pick up their own light, which is most of what sells "recessed
      // hole" rather than "dark rectangle" under a low sun.
      vec2 g = clamp(reliefGrad(hitUv, f, soft) * f.recess, vec2(-3.0), vec2(3.0)) * detail;

      // Pane bow. Real unitised glass is never dead flat, and pane-to-pane
      // variation in the reflected sky is one of the strongest glass cues there
      // is. It also gives filterRoughness a real normal derivative to work with.
      vec2  paneC = vec2(fract(hitUv.x / f.bayW) - 0.5, fract(hitUv.y / f.floorH) - 0.5);
      float bow   = mix(-1.0, 1.0, hash21(floor(vec2(hitUv.x / f.bayW, hitUv.y / f.floorH))));
      vec2  bend  = paneC * bow * 0.075 * glassAmt * detail;

      vec3 nt = normalize(vec3(-g.x + bend.x, -g.y + bend.y, 1.0));
      N = normalize(nt.x * T + nt.y * B + nt.z * Ng);

      // --- materials -------------------------------------------------------
      // Weathering: vertical streaks running down from each transom. Cheap, and
      // it is the difference between "concrete" and "concrete that has stood in
      // Dubai for fifteen years".
      float streakId = hash21(vec2(floor(hitUv.x * 2.6), floor(hitUv.y / f.floorH)));
      float streak   = 1.0 - 0.28 * step(0.62, streakId)
                     * (1.0 - smoothstep(0.0, 0.55, fract(hitUv.y / f.floorH)));
      // Road grime and exhaust darken the first few storeys.
      float grime = mix(0.62, 1.0, smoothstep(0.0, 22.0, hitUv.y));

      vec3  solidAlb = f.panelCol;
      float solidMet = 0.0;
      float solidRgh = f.panelRough;

      // Anodised aluminium mullion caps. Metal catching the low sun along a
      // vertical line every 1.5 m is a large part of the tower read.
      solidAlb = mix(solidAlb, vec3(0.285, 0.288, 0.300), mats.x);
      solidMet = mix(solidMet, 0.85, mats.x);
      solidRgh = mix(solidRgh, 0.30, mats.x);

      // Precast / stone piers, podium and pilasters.
      solidAlb = mix(solidAlb, f.stoneCol, mats.y);
      solidMet = mix(solidMet, 0.0, mats.y);
      solidRgh = mix(solidRgh, 0.88, mats.y);

      // Louvred plant screens at the crown and the mechanical floors.
      solidAlb = mix(solidAlb, vec3(0.075, 0.074, 0.072), mats.z);
      solidMet = mix(solidMet, 0.60, mats.z);
      solidRgh = mix(solidRgh, 0.42, mats.z);

      solidAlb *= streak * grime;
      solidRgh  = clamp(solidRgh + (1.0 - streak) * 0.5, 0.05, 1.0);

      float glassRough = mix(f.glassRough, 0.20, 1.0 - detail);

      albedo    = mix(solidAlb, f.glassTint, glassAmt);
      metallic  = mix(solidMet, 0.0, glassAmt);
      roughness = mix(solidRgh, glassRough, glassAmt);

      // ASSET SLOT: an atlas multiplies the procedural albedo rather than
      // replacing it, so grime and panel variation land on top of geometry that
      // is already correct instead of fighting it.
      if (uHasFacade > 0.5) {
        vec3 tex = texture(tFacade, vec2(hitUv.x / (f.bayW * 4.0), hitUv.y / (f.floorH * 4.0))).rgb;
        albedo *= mix(vec3(1.0), 0.55 + tex * 1.1, 0.35 * detail);
      }

      // --- interior --------------------------------------------------------
      float retail = smoothstep(f.shopLo, f.shopLo + 0.3, hitUv.y)
                   * (1.0 - smoothstep(f.shopHi - 0.3, f.shopHi, hitUv.y));
      vec3 room = interiorRadiance(hitUv, viewT, f, detail, retail);
      emissive = room * glassAmt;

      // --- occlusion -------------------------------------------------------
      // How much sky a recess loses is set by how deep it is RELATIVE to the
      // opening, not by the normalised march depth. Keying it to the latter
      // darkened a 0.15 m curtain wall reveal as hard as a 0.55 m punched one
      // and cost the shallow archetypes most of their sky mirror.
      float recessAO = clamp(f.recess / f.bayW, 0.0, 0.55);
      ao = 1.0 - recessAO * hitDepth * (0.55 + 0.45 * glassAmt);
      // Street canyon: the bottom of a tower is shadowed by everything opposite
      // it. No shadow map here, and this height ramp is what stops the podium
      // floating in the same light as the crown.
      ao *= mix(0.48, 1.0, smoothstep(0.0, 34.0, vWorld.y));
      ao = clamp(ao, 0.10, 1.0);

      // --- parapet beacon --------------------------------------------------
      // Roof beacons are the ones you never see from a car. The one that reads
      // from street level sits on the parapet edge, so put a point there too.
      if (f.parapetLo < 1.0e5) {
        vec2  bp = vec2(face.x, face.y - (topY - 0.55));
        float bd = length(bp);
        emissive += vec3(1.0, 0.06, 0.02) * blink * smoothstep(1.15, 0.0, bd) * 18.0;
      }
    }

    // --- PBR ---------------------------------------------------------------
    // Widen the specular lobe by the screen-space normal derivative. The pane
    // bow and the reveal normals are high frequency by construction, and without
    // this every distant tower turns into a field of sparkling fireflies the
    // moment the bloom pass touches it.
    roughness = filterRoughness(N, roughness);

    Surface s = makeSurface(albedo, metallic, roughness, N, Vp);
    s.occlusion = ao;

    vec3 R = reflect(Vdir, N);
    // Diffuse irradiance from the GEOMETRIC normal: it is a low-frequency term,
    // and using the perturbed normal there would cost seven more sky taps for
    // no visible gain.
    vec3 irradiance = skyIrradiance(Ng, uSunDir);
    vec3 prefiltered = skyPrefiltered(R, s.roughness, uSunDir);

    vec3 col = shadeIBL(s, irradiance, prefiltered);
    // Clamped: a 0.06-roughness pane whose mirror direction lands exactly on the
    // sun produces a legitimately enormous value, and unclamped it survives the
    // bloom pyramid as a single blown pixel that flickers between frames.
    col += min(shadeDirect(s, uSunDir, uSunColor), vec3(26.0));

    // Transmitted room light. Energy the glass reflects is energy it does not
    // pass, so the interiors fade out exactly as the tower turns into a sky
    // mirror at grazing angles — which is the whole dusk money shot.
    float NoV = clamp(dot(N, Vp), 1e-4, 1.0);
    float Fg = F_SchlickRoughness(NoV, vec3(0.04), s.roughness).x;
    col += emissive * (1.0 - Fg);

    // --- fog ---------------------------------------------------------------
    // Aerial perspective sampled along the real view ray, pulled toward the haze
    // band rather than flattened onto it: a crown 300 m up has to dissolve into
    // the sky at ITS elevation, not into the horizon colour.
    float fog = smoothstep(uFogNear, uFogFar, dist);
    vec3 fogCol = skyRadiance(normalize(vec3(Vdir.x, mix(Vdir.y, 0.035, 0.60), Vdir.z)), uSunDir);
    col = mix(col, fogCol, fog * 0.96);

    outColor = vec4(col, 1.0);
  }
`;

/**
 * Uniform block for the facade material.
 *
 * `uCameraPos`, `uSunDir`, `uTime`, `uFogNear` and `uFogFar` keep their existing
 * names so `City.update()` and any other call site keep working unchanged.
 */
export function facadeUniforms(): Record<string, THREE.IUniform> {
  return {
    uCameraPos: { value: new THREE.Vector3() },
    uSunDir: { value: SUN_DIR.clone() },
    // Direct sun radiance at dusk: heavily reddened by the long air path, and
    // still the brightest thing in the scene by a wide margin.
    uSunColor: { value: new THREE.Color(1.0, 0.44, 0.16).multiplyScalar(3.4) },
    uTime: { value: 0 },
    uFogNear: { value: 420 },
    uFogFar: { value: 2600 },
    // Beyond this the parallax march is skipped entirely and the window grid has
    // faded to the building's average. Sits well inside uFogFar because facade
    // detail stops resolving long before a tower stops being visible.
    uDetailFar: { value: 620 },
    uLitAmount: { value: 1 },
    uParallax: { value: 1 },
    tFacade: { value: null },
    uHasFacade: { value: 0 },
  };
}
