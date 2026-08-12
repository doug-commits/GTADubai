import * as THREE from 'three';
import { SKY_GLSL, SUN_DIR } from '../render/sky';
import { FACADE_VERT, FACADE_FRAG, facadeUniforms } from './facade';
import { buildLandmark } from './landmarks';
import { buildTowerSet } from './towers';
import { PBR_GLSL, SKY_IBL_GLSL } from '../render/pbr';
import type { Corridor } from './corridor';
import { ROAD_HALF_WIDTH } from './corridor';

/**
 * Skyline.
 *
 * Every building in the corridor — generic infill and named landmarks alike —
 * is a box in ONE InstancedMesh, so the whole of Sheikh Zayed Road costs a
 * single draw call. Landmark silhouettes (the Burj's setbacks, the twin towers,
 * the DIFC slab) are built by stacking several boxes per landmark, which is
 * both cheaper and closer to how those buildings actually step than any mesh we
 * could afford to ship.
 *
 * Detail comes from the fragment shader: a per-instance window grid with lit
 * and unlit cells, warm interior light, dusk fresnel, and rooftop beacons.
 *
 * ASSET SLOT: `public/assets/buildings/facade.webp` — a facade/window atlas.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BoxInstance {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rot: number;
  seed: number;
  /** 0 = generic infill, 1 = landmark. Landmarks get denser, warmer glazing. */
  kind: number;
}

const BUILDING_VERT = /* glsl */ `
  in vec3 position;
  in vec3 normal;
  in mat4 instanceMatrix;
  in vec4 aParams; // x,y,z = box size in metres, w = seed

  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat4 modelMatrix;
  uniform mat3 normalMatrix;

  out vec3 vNormal;
  out vec3 vWorld;
  out vec3 vLocal;   // metres, origin at box centre
  out vec3 vSize;
  out float vSeed;

  void main() {
    vSize = aParams.xyz;
    vSeed = aParams.w;
    vLocal = position * aParams.xyz;
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormal = normalize(mat3(instanceMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const BUILDING_FRAG = /* glsl */ `
  precision highp float;
          precision highp sampler2D;
  in vec3 vNormal;
  in vec3 vWorld;
  in vec3 vLocal;
  in vec3 vSize;
  in float vSeed;
  out vec4 outColor;

  uniform vec3 uCameraPos;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform sampler2D tFacade;
  uniform float uHasFacade;

  ${SKY_GLSL}

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vWorld - uCameraPos);

    // --- glazing grid ------------------------------------------------------
    // Pick the two axes that lie in the face so the grid wraps the box without
    // stretching on any side.
    vec2 face;
    if (abs(N.y) > 0.7)      face = vLocal.xz;
    else if (abs(N.x) > 0.7) face = vLocal.zy;
    else                     face = vLocal.xy;

    const float FLOOR_H = 3.6;
    const float BAY_W   = 2.9;
    vec2 cell = vec2(floor(face.x / BAY_W), floor(face.y / FLOOR_H));
    vec2 inCell = fract(vec2(face.x / BAY_W, face.y / FLOOR_H));

    // Mullion mask: the dark frame between panes.
    float frame = smoothstep(0.0, 0.10, inCell.x) * smoothstep(1.0, 0.90, inCell.x)
                * smoothstep(0.0, 0.16, inCell.y) * smoothstep(1.0, 0.84, inCell.y);

    float r = hash31(vec3(cell, vSeed));
    // Occupancy: landmarks are lit up more than infill blocks.
    float litChance = 0.34 + vSeed * 0.0 + 0.16;
    float lit = step(1.0 - litChance, r);
    // A handful of offices flicker / are being cleaned.
    float flick = step(0.985, hash31(vec3(cell.yx, vSeed + 7.0)));
    lit *= mix(1.0, 0.35 + 0.65 * step(0.5, fract(uTime * 0.7 + r * 10.0)), flick);

    // Warm tungsten interiors, a few cool fluorescents.
    vec3 warm = vec3(1.00, 0.62, 0.26);
    vec3 cool = vec3(0.72, 0.82, 1.00);
    vec3 interior = mix(warm, cool, step(0.86, hash31(vec3(cell + 3.0, vSeed))));
    float bright = 0.55 + 0.85 * hash31(vec3(cell - 5.0, vSeed));

    // --- surfaces ----------------------------------------------------------
    // Dark char concrete/mullion, near-black glass that mostly mirrors the sky.
    vec3 structure = mix(vec3(0.030, 0.026, 0.028), vec3(0.058, 0.050, 0.048), hash31(vec3(cell * 0.3, vSeed)));

    vec3 R = reflect(V, N);
    vec3 skyRefl = skyRadiance(normalize(R), uSunDir);
    float fres = pow(1.0 - max(dot(-V, N), 0.0), 3.5);

    vec3 glass = mix(vec3(0.012, 0.014, 0.020), skyRefl, clamp(0.22 + fres * 0.75, 0.0, 0.95));
    glass += interior * lit * bright * frame * 1.35;

    vec3 col = mix(structure, glass, frame);

    if (uHasFacade > 0.5) {
      col = mix(col, texture(tFacade, vec2(face.x / BAY_W, face.y / FLOOR_H) * 0.25).rgb, 0.30);
    }

    // --- lighting ----------------------------------------------------------
    float ndl = max(dot(N, uSunDir), 0.0);
    // Sun rakes across the west faces; everything else falls to sky ambient.
    col += vec3(1.0, 0.52, 0.22) * ndl * 0.55;
    col += skyRadiance(N, uSunDir) * 0.14;
    // Rim light along the sun-facing silhouette edge — this is what separates
    // one tower from the next against a bloomed sky.
    col += vec3(1.0, 0.60, 0.30) * fres * max(dot(reflect(V, N), uSunDir), 0.0) * 0.9;

    // --- rooftop aviation beacon ------------------------------------------
    if (N.y > 0.7 && vSize.y > 70.0) {
      float blink = step(0.55, fract(uTime * 0.55 + vSeed * 0.37));
      float d = length(face) / max(vSize.x, vSize.z);
      col += vec3(1.0, 0.10, 0.06) * blink * smoothstep(0.32, 0.0, d) * 3.5;
    }

    // --- fog ---------------------------------------------------------------
    float dist = length(vWorld - uCameraPos);
    float fog = smoothstep(uFogNear, uFogFar, dist);
    vec3 fogCol = skyRadiance(normalize(vec3(V.x, 0.05, V.z)), uSunDir);
    col = mix(col, fogCol, fog * 0.94);

    outColor = vec4(col, 1.0);
  }
`;

/** Expand a landmark archetype into stacked boxes. */
function landmarkBoxes(
  l: Corridor['landmarks'][number],
  rnd: () => number,
  out: BoxInstance[],
) {
  const seed = rnd() * 1000;
  const rot = rnd() * Math.PI;
  const push = (y: number, w: number, h: number, d: number, dx = 0, dz = 0) =>
    out.push({ x: l.x + dx, y, z: l.z + dz, w, h, d, rot, seed, kind: 1 });

  const R = l.radius;
  switch (l.shape) {
    case 'spire': {
      // Setback stack: each tier steps in, which is what reads as "Burj".
      const tiers = 7;
      let y = 0;
      let w = R * 2;
      const tierH = (l.height * 0.82) / tiers;
      for (let i = 0; i < tiers; i++) {
        push(y + tierH / 2, w, tierH, w * 0.92);
        y += tierH;
        w *= 0.78;
      }
      push(y + l.height * 0.09, R * 0.18, l.height * 0.18, R * 0.18); // needle
      break;
    }
    case 'twin': {
      const w = R * 1.25;
      push(l.height * 0.5, w, l.height, w * 0.85, -R * 0.75, 0);
      push(l.height * 0.42, w * 0.9, l.height * 0.84, w * 0.8, R * 0.75, R * 0.4);
      push(l.height * 1.02, w * 0.35, l.height * 0.08, w * 0.35, -R * 0.75, 0);
      break;
    }
    case 'slab': {
      push(l.height * 0.5, R * 2.4, l.height, R * 1.1);
      push(l.height * 1.02, R * 2.0, l.height * 0.06, R * 0.9);
      break;
    }
    case 'sail': {
      const tiers = 4;
      let y = 0;
      let w = R * 2;
      const tierH = l.height / tiers;
      for (let i = 0; i < tiers; i++) {
        push(y + tierH / 2, w, tierH, w * 0.55, 0, i * R * 0.18);
        y += tierH;
        w *= 0.84;
      }
      break;
    }
    case 'dome': {
      push(l.height * 0.42, R * 2, l.height * 0.85, R * 2);
      push(l.height * 0.92, R * 1.3, l.height * 0.22, R * 1.3);
      break;
    }
    default: {
      push(l.height * 0.5, R * 1.8, l.height, R * 1.6);
      push(l.height * 1.03, R * 0.9, l.height * 0.07, R * 0.8);
    }
  }
}

/**
 * Height profile along the corridor. Peaks at Downtown and Trade Centre, dips
 * through the Al Quoz industrial stretch — the real corridor's density curve.
 *
 * The tail matters more than the mean. Sheikh Zayed Road is not an even wall of
 * mid-rise; it is a line of individually tall, individually slender towers with
 * long low gaps between them, and the gaps are as much of the read as the
 * towers. A heavier tail and a lower base is what produces that.
 */
function heightAt(u: number, rnd: () => number): number {
  const downtown = Math.exp(-Math.pow((u - 0.82) * 4.4, 2));
  const tradeCentre = Math.exp(-Math.pow((u - 0.97) * 9.0, 2));
  const barsha = Math.exp(-Math.pow((u - 0.05) * 8.0, 2));
  const density = 0.14 + downtown * 0.95 + tradeCentre * 0.7 + barsha * 0.35;
  const base = 10 + density * 62;
  const spike = Math.pow(rnd(), 3.4) * density * 340;
  return base + spike + rnd() * 14;
}

export class City {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.RawShaderMaterial;

  constructor(corridor: Corridor) {
    const rnd = mulberry32(0xd0ba1);
    const boxes: BoxInstance[] = [];

    // Landmarks are no longer part of the instanced box field — they get real
    // silhouettes from landmarks.ts, built as their own meshes. See `Landmarks`.

    // --- real OSM footprints, when we have them ---------------------------
    if (corridor.buildings.length) {
      for (const b of corridor.buildings) {
        const h = b.h > 1 ? b.h : 12 + rnd() * 40;
        const w = Math.max(8, b.r * 1.5);
        boxes.push({
          x: b.x,
          y: h / 2,
          z: b.z,
          w,
          h,
          d: Math.max(8, b.r * 1.2),
          rot: rnd() * Math.PI,
          seed: rnd() * 1000,
          kind: 0,
        });
      }
    } else {
      // --- procedural infill ---------------------------------------------
      // Only used with the placeholder corridor; the OSM bake replaces this.
      //
      // Three bands per side, because that is how this road is actually built
      // and because a single band of boxes at a single setback is what made the
      // old skyline a canyon:
      //
      //   0  service-road frontage — low, wide, close in. Showrooms, mosques,
      //      petrol stations, two-storey retail. Keeps the near ground occupied
      //      so the eye is not looking straight from the barrier to a tower.
      //   1  the tower line — tall, SLENDER, and well set back behind the
      //      service road, with real gaps of sky between the plots.
      //   2  the second rank behind, shorter and hazier.
      //
      // The gap rate on band 1 is high on purpose. Sky between the towers is
      // not an absence of city; on this road it is the city.
      const path = corridor.path;
      const STEP = 44;
      const BANDS = [
        { off: 34, spread: 10, gap: 0.30, hScale: 0.10, wMin: 22, wVar: 30, dMin: 16, dVar: 20 },
        { off: 76, spread: 34, gap: 0.42, hScale: 1.00, wMin: 13, wVar: 20, dMin: 13, dVar: 18 },
        { off: 168, spread: 66, gap: 0.34, hScale: 0.58, wMin: 15, wVar: 26, dMin: 15, dVar: 22 },
      ];
      for (let s = 0; s < path.length; s += STEP) {
        const u = s / path.length;
        for (const side of [-1, 1]) {
          for (const band of BANDS) {
            if (rnd() < band.gap) continue;
            const off = (band.off + rnd() * band.spread) * side;
            const p = path.sample(s + (rnd() - 0.5) * STEP * 1.4);
            const h = Math.max(7, heightAt(u, rnd) * band.hScale);
            const w = band.wMin + rnd() * band.wVar;
            // Slender: a tall Dubai tower is a point block or a thin slab, so
            // depth tracks width instead of being drawn independently. Boxes as
            // deep as they are wide read as office blocks, not as towers.
            const d = band.dMin + rnd() * band.dVar;
            boxes.push({
              x: p.x + p.nx * off,
              y: h / 2,
              z: p.z + p.nz * off,
              w,
              h,
              d,
              rot: p.heading + (rnd() - 0.5) * 0.22,
              seed: rnd() * 1000,
              kind: 0,
            });
          }
        }
      }
    }

    // --- build the instanced meshes ---------------------------------------
    //
    // One InstancedMesh PER TOWER VARIANT rather than one shared box.
    //
    // A box with a good glazing shader on it is still a box, and a corridor of
    // two hundred identical boxes was the main reason this skyline read as any
    // downtown. towers.ts lofts a set of distinct silhouettes — setbacks,
    // tapers, curved and twisted plans, chamfered corners, real crowns and
    // podiums — and each placement takes the variant nearest its target height,
    // then scales to fit. Variety of SILHOUETTE is what a skyline is read by.
    this.material = new THREE.RawShaderMaterial({
      name: 'buildings',
      glslVersion: THREE.GLSL3,
      uniforms: facadeUniforms(),
      vertexShader: FACADE_VERT,
      fragmentShader: FACADE_FRAG,
      side: THREE.FrontSide,
    });

    const VARIANTS = 18;
    const towerSet = buildTowerSet(VARIANTS, { minHeight: 30, maxHeight: 320 });

    // Bucket every placement onto the variant whose natural height is closest,
    // so the scale we then apply stays near 1 and the proportions survive.
    const buckets: BoxInstance[][] = towerSet.map(() => []);
    for (const b of boxes) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < towerSet.length; i++) {
        const d = Math.abs(towerSet[i].height - b.h);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      buckets[best].push(b);
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const meshes: THREE.InstancedMesh[] = [];

    towerSet.forEach((tower, vi) => {
      const list = buckets[vi];
      if (!list.length) return;
      const geo = tower.geometry.clone();
      const im = new THREE.InstancedMesh(geo, this.material, list.length);
      const params = new Float32Array(list.length * 4);
      list.forEach((b, i) => {
        // Towers are modelled standing on y=0, so place the base, not the centre.
        pos.set(b.x, 0, b.z);
        q.setFromAxisAngle(up, b.rot);
        scl.set(
          b.w / Math.max(tower.footprint.x, 0.001),
          b.h / Math.max(tower.height, 0.001),
          b.d / Math.max(tower.footprint.y, 0.001),
        );
        m.compose(pos, q, scl);
        im.setMatrixAt(i, m);
        params[i * 4 + 0] = b.w;
        params[i * 4 + 1] = b.h;
        params[i * 4 + 2] = b.d;
        params[i * 4 + 3] = b.seed;
      });
      im.instanceMatrix.needsUpdate = true;
      geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
      im.frustumCulled = false;
      meshes.push(im);
      this.group.add(im);
    });

    const mesh = meshes[0] ?? new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.material, 1);
    this.mesh = mesh;
    this.loadAssetSlot();
  }

  private loadAssetSlot() {
    new THREE.TextureLoader().load(
      'assets/buildings/facade.webp',
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.material.uniforms.tFacade.value = tex;
        this.material.uniforms.uHasFacade.value = 1;
      },
      undefined,
      () => {
        /* procedural glazing stands in */
      },
    );
  }

  update(time: number, cameraPos: THREE.Vector3) {
    this.material.uniforms.uTime.value = time;
    (this.material.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
  }
}

/** Streetlights and overhead gantries down the corridor, as one instanced mesh. */
export class Furniture {
  readonly group = new THREE.Group();
  private glowMat: THREE.RawShaderMaterial;

  constructor(corridor: Corridor) {
    const path = corridor.path;
    const rnd = mulberry32(0x5ee7);

    // --- poles ------------------------------------------------------------
    const poleGeo = new THREE.BoxGeometry(0.34, 1, 0.34);
    const poleMat = new THREE.MeshBasicMaterial({ color: 0x0a0809 });
    const SPACING = 44;
    const count = Math.floor(path.length / SPACING) * 2;
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, count);
    const lamps: THREE.Vector3[] = [];

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let i = 0;
    for (let s = 0; s < path.length && i < count; s += SPACING) {
      const p = path.sample(s);
      for (const side of [-1, 1]) {
        if (i >= count) break;
        const off = (ROAD_HALF_WIDTH + 3.4) * side;
        const h = 11 + rnd() * 1.2;
        q.setFromAxisAngle(up, p.heading);
        m.compose(
          new THREE.Vector3(p.x + p.nx * off, h / 2, p.z + p.nz * off),
          q,
          new THREE.Vector3(1, h, 1),
        );
        poles.setMatrixAt(i++, m);
        // Lamp head hangs in over the carriageway.
        lamps.push(new THREE.Vector3(p.x + p.nx * (off - side * 2.6), h, p.z + p.nz * (off - side * 2.6)));
      }
    }
    poles.count = i;
    poles.instanceMatrix.needsUpdate = true;
    poles.frustumCulled = false;
    this.group.add(poles);

    // --- overhead sign gantries -------------------------------------------
    // Sheikh Zayed Road is gantry after gantry. They are cheap, and because
    // they pass directly over the camera they give the strongest single
    // "something just went by" cue in the scene.
    const GANTRY_SPACING = 190;
    const gantryCount = Math.floor(path.length / GANTRY_SPACING);
    const gantrySpans = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x0d0a0b }),
      gantryCount * 3,
    );
    let gi = 0;
    for (let s = GANTRY_SPACING; s < path.length && gi < gantryCount * 3; s += GANTRY_SPACING) {
      const p = path.sample(s);
      q.setFromAxisAngle(up, p.heading);
      const width = (ROAD_HALF_WIDTH + 3.6) * 2;
      // Span.
      m.compose(
        new THREE.Vector3(p.x, 8.6, p.z),
        q,
        new THREE.Vector3(width, 1.35, 0.85),
      );
      gantrySpans.setMatrixAt(gi++, m);
      // Legs.
      for (const side of [-1, 1]) {
        if (gi >= gantryCount * 3) break;
        const off = (ROAD_HALF_WIDTH + 3.4) * side;
        m.compose(
          new THREE.Vector3(p.x + p.nx * off, 4.3, p.z + p.nz * off),
          q,
          new THREE.Vector3(0.72, 8.6, 0.72),
        );
        gantrySpans.setMatrixAt(gi++, m);
      }
    }
    gantrySpans.count = gi;
    gantrySpans.instanceMatrix.needsUpdate = true;
    gantrySpans.frustumCulled = false;
    this.group.add(gantrySpans);

    // --- lamp glows -------------------------------------------------------
    // Additive billboards; with the bloom pass these become the sodium haze
    // that lines the corridor into the distance.
    this.glowMat = new THREE.RawShaderMaterial({
      name: 'lamp-glow',
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(1.0, 0.55, 0.2) } },
      vertexShader: /* glsl */ `
        in vec3 position;
        in vec2 uv;
        in mat4 instanceMatrix;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        out vec2 vUv;
        void main() {
          vUv = uv;
          // Billboard: strip rotation from the model-view so the quad always faces us.
          vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float sx = length(instanceMatrix[0].xyz);
          float sy = length(instanceMatrix[1].xyz);
          centre.xy += position.xy * vec2(sx, sy);
          gl_Position = projectionMatrix * centre;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
          precision highp sampler2D;
        in vec2 vUv;
        out vec4 outColor;
        uniform vec3 uColor;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float a = pow(clamp(1.0 - d, 0.0, 1.0), 2.6);
          outColor = vec4(uColor * a * 2.4, a);
        }
      `,
    });

    const glowGeo = new THREE.PlaneGeometry(1, 1);
    const glows = new THREE.InstancedMesh(glowGeo, this.glowMat, lamps.length);
    lamps.forEach((p, idx) => {
      m.compose(p, new THREE.Quaternion(), new THREE.Vector3(7, 7, 7));
      glows.setMatrixAt(idx, m);
    });
    glows.instanceMatrix.needsUpdate = true;
    glows.frustumCulled = false;
    glows.renderOrder = 5;
    this.group.add(glows);
  }
}

/**
 * Named Dubai landmarks.
 *
 * These get real silhouettes from `landmarks.ts` rather than a place in the
 * instanced box field — the Burj's spiralling Y-plan, the Museum of the
 * Future's torus, Emirates Towers' chamfered crowns. They are what make the
 * corridor read as Dubai rather than as any city with tall buildings, so they
 * are worth the extra draw calls.
 *
 * Shaded through the shared PBR contract with the analytic sky as the
 * environment, so nothing is downloaded for the lighting.
 */
export class Landmarks {
  readonly group = new THREE.Group();
  private materials: THREE.RawShaderMaterial[] = [];

  constructor(corridor: Corridor) {
    for (const l of corridor.landmarks) {
      const built = buildLandmark(l.id, Math.abs(Math.round(l.x * 7 + l.z * 13)));

      const mat = this.makeMaterial();
      const mesh = new THREE.Mesh(built.geometry, mat);

      // No rescaling. landmarks.ts already builds each silhouette at its real
      // published height, so dividing the spec height by the model height was
      // introducing error rather than correcting it — it was stretching some
      // towers by 5-8x where the two figures disagreed.
      mesh.position.set(l.x, 0, l.z);
      // Face the corridor, with a little variation so the row is not uniform.
      const p = corridor.path.sample(l.s);
      mesh.rotation.y = p.heading + (l.side > 0 ? Math.PI : 0);
      mesh.frustumCulled = true;
      this.group.add(mesh);

      if (built.emissive) {
        const em = new THREE.Mesh(built.emissive, this.makeEmissiveMaterial());
        em.position.copy(mesh.position);
        em.rotation.copy(mesh.rotation);
        em.frustumCulled = true;
        em.renderOrder = 8;
        this.group.add(em);
      }
    }
  }

  private makeMaterial(): THREE.RawShaderMaterial {
    const m = new THREE.RawShaderMaterial({
      name: 'landmark',
      glslVersion: THREE.GLSL3,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: SUN_DIR.clone() },
        uSunColor: { value: new THREE.Color(1.0, 0.44, 0.16).multiplyScalar(3.4) },
        uTime: { value: 0 },
        uFogNear: { value: 600 },
        uFogFar: { value: 4200 },
      },
      vertexShader: /* glsl */ `
        in vec3 position; in vec3 normal; in vec2 uv;
        uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
        out vec3 vN; out vec3 vW; out vec3 vLocal; out vec2 vUv;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vLocal = position;
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp int;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW; in vec3 vLocal; in vec2 vUv;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir, uSunColor;
        uniform float uTime, uFogNear, uFogFar;
        ${SKY_GLSL}
        ${PBR_GLSL}
        ${SKY_IBL_GLSL}

        float h21(vec2 p) {
          p = fract(p * vec2(233.34, 851.73));
          p += dot(p, p + 23.45);
          return fract(p.x * p.y);
        }

        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          float dist = length(vW - uCameraPos);

          // Curtain wall: floor bands every 3.6 m, glazing modules across.
          float floorH = 3.6;
          float band = fract(vLocal.y / floorH);
          float spandrel = smoothstep(0.0, 0.12, band) * smoothstep(1.0, 0.86, band);

          // Horizontal module index taken from whichever pair of axes lies in
          // the face, so the grid wraps curved and faceted forms alike.
          vec2 face = abs(N.y) > 0.7 ? vLocal.xz : (abs(N.x) > 0.7 ? vLocal.zy : vLocal.xy);
          float bay = floor(face.x / 2.9);
          float row = floor(vLocal.y / floorH);
          float r = h21(vec2(bay, row));

          // Detail fades out with distance so a 828 m tower does not alias.
          float detail = 1.0 - smoothstep(300.0, 1400.0, dist);

          vec3 glassAlbedo = vec3(0.020, 0.024, 0.032);
          vec3 frameAlbedo = vec3(0.055, 0.050, 0.048);
          float glassMask = spandrel * detail;

          vec3 albedo = mix(frameAlbedo, glassAlbedo, glassMask);
          float rough = mix(0.62, 0.10, glassMask);
          rough = filterRoughness(N, rough);

          Surface s = makeSurface(albedo, 0.0, rough, N, V);

          vec3 R = reflect(V, N);
          vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
          col += shadeDirect(s, uSunDir, uSunColor);

          // Lit rooms behind the glass.
          float lit = step(0.52, r) * glassMask;
          vec3 warm = vec3(1.00, 0.60, 0.26);
          vec3 cool = vec3(0.70, 0.80, 1.00);
          vec3 interior = mix(warm, cool, step(0.86, h21(vec2(row, bay))));
          col += interior * lit * (0.35 + 0.75 * h21(vec2(bay + 5.0, row - 3.0))) * 1.5;

          float fog = smoothstep(uFogNear, uFogFar, dist);
          col = aerial(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
      side: THREE.DoubleSide,
    });
    this.materials.push(m);
    return m;
  }

  private makeEmissiveMaterial(): THREE.RawShaderMaterial {
    const m = new THREE.RawShaderMaterial({
      name: 'landmark-emissive',
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uCameraPos: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        in vec3 position; in vec2 uv;
        uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
        out vec2 vUv; out vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz; vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler2D;
        in vec2 vUv; in vec3 vW;
        out vec4 outColor;
        uniform float uTime;
        uniform vec3 uCameraPos;
        void main() {
          // Crown and signage bands: warm gold, gently pulsing.
          float pulse = 0.82 + 0.18 * sin(uTime * 0.8 + vW.y * 0.05);
          vec3 c = vec3(1.0, 0.72, 0.30) * pulse * 2.2;
          outColor = vec4(c, 0.85);
        }
      `,
    });
    this.materials.push(m);
    return m;
  }

  update(time: number, cameraPos: THREE.Vector3) {
    for (const m of this.materials) {
      if (m.uniforms.uTime) m.uniforms.uTime.value = time;
      if (m.uniforms.uCameraPos) (m.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
    }
  }
}
