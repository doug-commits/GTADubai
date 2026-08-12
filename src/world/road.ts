import * as THREE from 'three';
import { SKY_GLSL, SUN_DIR } from '../render/sky';
import type { Corridor } from './corridor';
import { LANE_WIDTH, ROAD_HALF_WIDTH } from './corridor';

/**
 * The road ribbon.
 *
 * Built once from the corridor centreline as a single strip. Everything that
 * makes it read as wet dusk asphalt happens in the fragment shader from the
 * (lateral metres, along metres) UV — lane markings, puddle mask, sky
 * reflection, sun streak — so there are no texture downloads in the critical
 * path and lane geometry stays mathematically exact.
 *
 * ASSET SLOTS (all optional, blended in when present):
 *   public/assets/road/albedo.webp     tiling, 1024², 4 m per tile
 *   public/assets/road/roughness.webp  tiling, 1024²
 */

const SHOULDER = 2.6;
const VERGE = 14.0;
/** Lateral sample positions, metres from centre. */
function lateralDivisions(): number[] {
  const hw = ROAD_HALF_WIDTH;
  return [
    -hw - SHOULDER - VERGE,
    -hw - SHOULDER,
    -hw,
    -hw * 0.5,
    0,
    hw * 0.5,
    hw,
    hw + SHOULDER,
    hw + SHOULDER + VERGE,
  ];
}

const ROAD_VERT = /* glsl */ `
  in vec3 position;
  in vec2 uv;
  in float aEdge;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat4 modelMatrix;
  out vec2 vUv;
  out float vEdge;
  out vec3 vWorld;
  void main() {
    vUv = uv;
    vEdge = aEdge;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ROAD_FRAG = /* glsl */ `
  precision highp float;
          precision highp sampler2D;
  in vec2 vUv;      // x = lateral metres, y = along metres
  in float vEdge;   // 0 on the carriageway, 1 out on the verge
  in vec3 vWorld;
  out vec4 outColor;

  uniform vec3  uCameraPos;
  uniform vec3  uSunDir;
  uniform float uTime;
  uniform float uLaneWidth;
  uniform float uHalfWidth;
  uniform float uWetness;
  uniform sampler2D tAlbedo;
  uniform sampler2D tRough;
  uniform float uHasAlbedo;
  uniform float uHasRough;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uDebug;

  ${SKY_GLSL}

  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    float lat = vUv.x;
    float along = vUv.y;
    float absLat = abs(lat);

    // Diagnostic (?debugroad=1): flat checker straight from the UVs, no
    // lighting, no fog, no reflection. Answers "is this surface being drawn
    // here at all, and is the along-coordinate advancing" in one frame.
    if (uDebug > 0.5) {
      float ca = step(0.5, fract(along / 12.0));
      float cb = step(0.5, fract(lat / uLaneWidth));
      vec3 dbg = mix(vec3(0.9, 0.0, 0.9), vec3(0.0, 0.9, 0.4), abs(ca - cb));
      dbg = mix(dbg, vec3(1.0, 1.0, 0.0), vEdge);
      outColor = vec4(dbg, 1.0);
      return;
    }

    // ---------------------------------------------------------------- asphalt
    // Two noise octaves at very different scales: fine aggregate plus broad
    // patching. Uniform asphalt is the single biggest "this is a game" tell.
    float grain = fbm(vec2(lat, along) * 3.1);
    float patchwork = fbm(vec2(lat * 0.06, along * 0.012));
    // Real asphalt reflectance is about 0.04-0.12 dry and lower wet. Keeping it
    // genuinely dark is what lets the lane paint, the streetlights and the
    // reflected sunset be the bright things on the ground — a pale road has
    // nothing to smear against.
    vec3 asphalt = mix(vec3(0.016, 0.015, 0.017), vec3(0.040, 0.037, 0.035), grain * 0.75 + patchwork * 0.45);

    // Darker polished wheel tracks where traffic has worn the surface.
    float laneLocal = mod(lat + uHalfWidth, uLaneWidth) / uLaneWidth;
    float wear = exp(-pow((laneLocal - 0.28) * 6.0, 2.0)) + exp(-pow((laneLocal - 0.72) * 6.0, 2.0));
    asphalt *= 1.0 - wear * 0.22;

    if (uHasAlbedo > 0.5) {
      asphalt = mix(asphalt, texture(tAlbedo, vec2(lat, along) * 0.25).rgb * 0.35, 0.75);
    }

    // Sandy verge either side of the shoulder.
    // Irrigated turf. Sheikh Zayed Road is planted and watered its whole
    // length — mown grass, low hedging and palm beds run right up to the hard
    // shoulder. Sand-coloured verges read as desert highway, not as this road.
    vec3 verge = mix(vec3(0.048, 0.092, 0.038), vec3(0.086, 0.148, 0.058), fbm(vec2(lat, along) * 0.35));
    verge = mix(verge, vec3(0.135, 0.118, 0.082), smoothstep(0.55, 0.95, fbm(vec2(lat * 0.4, along * 0.06))));
    vec3 base = mix(asphalt, verge, vEdge);

    // ---------------------------------------------------------------- wetness
    // Computed before the markings are laid down: wet tarmac is much darker
    // than dry, but the paint on top of it is not, and applying one darkening
    // pass over both was washing the lane lines out to nothing.
    float puddle = smoothstep(0.42, 0.78, fbm(vec2(lat * 0.22, along * 0.035)));
    puddle = clamp(puddle + wear * 0.30, 0.0, 1.0) * (1.0 - vEdge);
    float wet = clamp(uWetness * (0.42 + puddle * 0.68), 0.0, 1.0);
    if (uHasRough > 0.5) {
      wet *= 1.0 - texture(tRough, vec2(lat, along) * 0.25).r * 0.5;
    }
    base *= 1.0 - wet * 0.34;

    // ---------------------------------------------------------------- markings
    //
    // Both axes need band-limiting or the markings alias violently. A pixel
    // near the horizon spans tens of metres of along-distance, so sampling a 12 m
    // dash cycle point-wise produces wide moire bands that read as transverse
    // stripes across the carriageway — a zebra crossing repeating to infinity.
    // Fade each pattern toward its own average once a pixel is wider than the
    // feature it is trying to resolve.
    float alongW = fwidth(along);
    float latW = fwidth(lat);

    // Duty cycle of the dash: 3 m painted in every 12 m.
    const float DASH_DUTY = 0.25;
    float dashFade = 1.0 - smoothstep(0.6, 3.0, alongW);
    float dashCycle = step(mod(along, 12.0), 3.0);
    float dash = mix(DASH_DUTY, dashCycle, dashFade);

    // Lateral coverage of a 0.11 m stripe within a 3.65 m lane.
    float stripeFade = 1.0 - smoothstep(0.05, 0.35, latW);

    float md = 1e9;
    for (int i = 1; i < 5; i++) {
      float x = -uHalfWidth + float(i) * uLaneWidth;
      md = min(md, abs(lat - x));
    }
    // Widen the analytic edge with the pixel footprint: a sub-pixel line must
    // get dimmer, not thinner, or it shimmers.
    float lanePaint = (1.0 - smoothstep(0.055, 0.115 + latW, md)) * dash;
    lanePaint = mix(lanePaint * 0.30, lanePaint, stripeFade);

    float edgePaint = 1.0 - smoothstep(0.07, 0.14 + latW, abs(absLat - uHalfWidth + 0.25));
    edgePaint = mix(edgePaint * 0.45, edgePaint, stripeFade);

    float paint = clamp(lanePaint + edgePaint, 0.0, 1.0) * (1.0 - vEdge);
    // Paint is worn, not pristine white — but it is the brightest thing on the
    // carriageway by a wide margin, and the dashes streaking toward the camera
    // are the main thing selling speed on the ground plane.
    float paintWear = 0.68 + 0.32 * fbm(vec2(lat * 2.0, along * 0.6));
    // Real road-marking reflectance is around 0.35-0.55, not 1.0. Driving it to
    // white made every dash blow out into a solid slab once the road behind it
    // was correctly dark — brightest-on-the-ground does not mean clipping.
    // Only lightly wet-darkened: standing water dulls paint far less than tarmac.
    vec3 paintCol = vec3(0.44, 0.41, 0.35) * paintWear * (1.0 - wet * 0.12);
    base = mix(base, paintCol, paint * 0.95);

    // Rumble strip on the hard shoulder.
    float rumbleFade = 1.0 - smoothstep(0.15, 0.6, alongW);
    float rumble = step(uHalfWidth + 0.4, absLat) * step(absLat, uHalfWidth + 1.4)
                 * step(mod(along, 1.2), 0.6) * rumbleFade;
    base = mix(base, base * 0.5, rumble * (1.0 - vEdge));

    // ------------------------------------------------------------- reflection
    vec3 V = normalize(vWorld - uCameraPos);
    vec3 N = vec3(0.0, 1.0, 0.0);
    // Perturb the normal so reflections shimmer along the surface rather than
    // mirroring perfectly — a perfect mirror reads as ice, not wet tarmac.
    float rip = fbm(vec2(lat * 1.4, along * 0.5 - uTime * 0.35));
    N = normalize(N + vec3((rip - 0.5) * 0.10 * wet, 0.0, (fbm(vec2(along * 0.4, lat * 1.1)) - 0.5) * 0.10 * wet));
    vec3 R = reflect(V, N);
    R.y = abs(R.y) * 0.55 + 0.02; // keep the reflected ray in the sky hemisphere

    vec3 refl = skyRadiance(normalize(R), uSunDir);

    // Grazing angles reflect far more — this is what stretches the ember horizon
    // into a long streak down the road ahead.
    float fres = pow(1.0 - max(dot(-V, vec3(0.0, 1.0, 0.0)), 0.0), 4.0);
    // Cap the mirror term well below 1. A physically "correct" grazing-angle
    // blend of ~0.9 turns the middle distance into one flat pale sheet, which
    // reads as fog rather than as tarmac; holding some albedo through keeps
    // the surface legible and lets the lane paint stay the brightest thing.
    // Break it up with the puddle mask so the sheen pools rather than covering.
    float reflAmt = wet * (0.08 + fres * 0.62) * (0.55 + puddle * 0.65);
    vec3 col = mix(base, refl, clamp(reflAmt, 0.0, 0.66));

    // Sun glint stretched along the road, plus sparkle on the wet grain.
    float sunSpec = pow(max(dot(R, uSunDir), 0.0), 48.0);
    col += vec3(1.0, 0.55, 0.22) * sunSpec * wet * 2.4;
    float sparkle = step(0.982, hash21(floor(vec2(lat, along) * 28.0)));
    col += vec3(1.0, 0.72, 0.45) * sparkle * wet * fres * 0.7;

    // ------------------------------------------------------------------- fog
    float dist = length(vWorld - uCameraPos);
    float fog = smoothstep(uFogNear, uFogFar, dist);
    vec3 fogCol = skyRadiance(normalize(vec3(V.x, 0.015, V.z)), uSunDir) * 0.9;
    col = mix(col, fogCol, fog);

    outColor = vec4(col, 1.0);
  }
`;

export interface RoadOptions {
  /** 0 = bone dry, 1 = soaked. Dusk-after-rain sits around 0.75. */
  wetness?: number;
  fogNear?: number;
  fogFar?: number;
}

export class Road {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.RawShaderMaterial;

  constructor(corridor: Corridor, opts: RoadOptions = {}) {
    const lat = lateralDivisions();
    const path = corridor.path;
    const step = 8;
    const rows = Math.floor(path.length / step) + 1;
    const cols = lat.length;

    const positions = new Float32Array(rows * cols * 3);
    const uvs = new Float32Array(rows * cols * 2);
    const edges = new Float32Array(rows * cols);
    const indices = new Uint32Array((rows - 1) * (cols - 1) * 6);

    let vi = 0;
    let ui = 0;
    let ei = 0;
    const sample = path.sample(0);
    for (let r = 0; r < rows; r++) {
      const s = Math.min(r * step, path.length);
      path.sample(s, sample);
      for (let c = 0; c < cols; c++) {
        const t = lat[c];
        positions[vi++] = sample.x + sample.nx * t;
        // Crown the carriageway ~1.5% and drop the verge away, so the surface
        // catches light differently across the width.
        const onRoad = Math.abs(t) <= ROAD_HALF_WIDTH + SHOULDER;
        positions[vi++] = onRoad ? -Math.abs(t) * 0.015 : -ROAD_HALF_WIDTH * 0.015 - 0.55;
        positions[vi++] = sample.z + sample.nz * t;
        uvs[ui++] = t;
        uvs[ui++] = s;
        edges[ei++] = Math.abs(t) > ROAD_HALF_WIDTH + SHOULDER ? 1 : 0;
      }
    }

    let ii = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1; // one step laterally (driver's right)
        const d = a + cols; // one step along the corridor
        const e = d + 1;
        // Wind counter-clockwise as seen from ABOVE. Getting this backwards
        // makes every road triangle face the ground, and FrontSide culling then
        // discards the entire carriageway while still costing a draw call —
        // which is exactly what it did, silently, for several rounds.
        indices[ii++] = a;
        indices[ii++] = b;
        indices[ii++] = d;
        indices[ii++] = b;
        indices[ii++] = e;
        indices[ii++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(edges, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    this.material = new THREE.RawShaderMaterial({
      name: 'road',
      glslVersion: THREE.GLSL3,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: SUN_DIR.clone() },
        uTime: { value: 0 },
        uLaneWidth: { value: LANE_WIDTH },
        uHalfWidth: { value: ROAD_HALF_WIDTH },
        uWetness: { value: opts.wetness ?? 0.78 },
        tAlbedo: { value: null },
        tRough: { value: null },
        uHasAlbedo: { value: 0 },
        uHasRough: { value: 0 },
        uFogNear: { value: opts.fogNear ?? 260 },
        uFogFar: { value: opts.fogFar ?? 1150 },
        uDebug: {
          value:
            typeof location !== 'undefined' &&
            new URLSearchParams(location.search).has('debugroad')
              ? 1
              : 0,
        },
      },
      vertexShader: ROAD_VERT,
      fragmentShader: ROAD_FRAG,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;

    this.loadAssetSlots();
  }

  private loadAssetSlots() {
    const loader = new THREE.TextureLoader();
    const bind = (url: string, uni: string, flag: string, srgb: boolean) => {
      loader.load(
        url,
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
          this.material.uniforms[uni].value = tex;
          this.material.uniforms[flag].value = 1;
        },
        undefined,
        () => {
          /* procedural surface stands in */
        },
      );
    };
    bind('assets/road/albedo.webp', 'tAlbedo', 'uHasAlbedo', true);
    bind('assets/road/roughness.webp', 'tRough', 'uHasRough', false);
  }

  update(time: number, cameraPos: THREE.Vector3) {
    this.material.uniforms.uTime.value = time;
    (this.material.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
  }
}

/**
 * Concrete barriers down both shoulders.
 *
 * These exist for motion, not for collision — the car is already clamped in
 * path space. A continuous wall a couple of metres off the wheels is the
 * strongest parallax cue available at speed: it is the closest geometry to the
 * camera, so it sweeps past faster than anything else on screen, and it is what
 * stops the periphery reading as empty ground.
 */
export class Barriers {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.RawShaderMaterial;

  constructor(corridor: Corridor) {
    const path = corridor.path;
    const step = 6;
    const rows = Math.floor(path.length / step) + 1;
    const t0 = ROAD_HALF_WIDTH + SHOULDER;

    // Per side, 3 profile points: base, top-inner, top-outer.
    const profile = [
      { t: 0.0, y: 0.0 },
      { t: -0.26, y: 0.92 },
      { t: 0.16, y: 0.98 },
    ];
    const cols = profile.length;
    const sides = 2;

    const positions = new Float32Array(rows * cols * sides * 3);
    const normals = new Float32Array(rows * cols * sides * 3);
    const uvs = new Float32Array(rows * cols * sides * 2);
    const indices: number[] = [];

    let vi = 0;
    let ni = 0;
    let ui = 0;
    const sample = path.sample(0);

    for (let sIdx = 0; sIdx < sides; sIdx++) {
      const side = sIdx === 0 ? -1 : 1;
      const base = sIdx * rows * cols;
      for (let r = 0; r < rows; r++) {
        const s = Math.min(r * step, path.length);
        path.sample(s, sample);
        for (let c = 0; c < cols; c++) {
          const t = (t0 + profile[c].t) * side;
          positions[vi++] = sample.x + sample.nx * t;
          positions[vi++] = profile[c].y;
          positions[vi++] = sample.z + sample.nz * t;
          // Face normal points back toward the road on the inner face.
          const inward = c === 2 ? 0.2 : -1;
          normals[ni++] = sample.nx * inward * side;
          normals[ni++] = c === 2 ? 1 : 0.35;
          normals[ni++] = sample.nz * inward * side;
          uvs[ui++] = profile[c].y;
          uvs[ui++] = s;
        }
      }
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = base + r * cols + c;
          const b = a + 1;
          const d = a + cols;
          const e = d + 1;
          // Wind each side so the road-facing surface is front-facing.
          if (side > 0) indices.push(a, d, b, b, d, e);
          else indices.push(a, b, d, b, e, d);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    this.material = new THREE.RawShaderMaterial({
      name: 'barriers',
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: SUN_DIR.clone() },
        uFogNear: { value: 180 },
        uFogFar: { value: 900 },
      },
      vertexShader: /* glsl */ `
        in vec3 position; in vec3 normal; in vec2 uv;
        uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
        out vec3 vN; out vec3 vW; out vec2 vUv;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW; in vec2 vUv;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir;
        uniform float uFogNear, uFogFar;
        ${SKY_GLSL}

        float hash21(vec2 p) {
          p = fract(p * vec2(233.34, 851.73));
          p += dot(p, p + 23.45);
          return fract(p.x * p.y);
        }

        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);

          // Precast concrete, cast in segments with a visible joint every 4 m.
          float seg = smoothstep(0.06, 0.14, abs(fract(vUv.y / 4.0) - 0.5) * 2.0 - 0.86);
          float grime = hash21(floor(vec2(vUv.x * 8.0, vUv.y * 2.0)));
          vec3 col = mix(vec3(0.085, 0.078, 0.074), vec3(0.135, 0.126, 0.118), grime);
          col *= 1.0 - seg * 0.45;
          // Road grime darkens the bottom of the wall.
          col *= 0.55 + 0.45 * smoothstep(0.0, 0.5, vUv.x);

          float ndl = max(dot(N, uSunDir), 0.0);
          col += vec3(1.0, 0.52, 0.22) * ndl * 0.5;
          col += skyRadiance(N, uSunDir) * 0.16;

          // Warm reflected bounce from the road surface onto the lower face.
          col += vec3(1.0, 0.45, 0.18) * (1.0 - smoothstep(0.0, 0.6, vUv.x)) * 0.10;

          float dist = length(vW - uCameraPos);
          float fog = smoothstep(uFogNear, uFogFar, dist);
          col = aerial(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  update(cameraPos: THREE.Vector3) {
    (this.material.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
  }
}
