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

    // ---------------------------------------------------------------- asphalt
    // Two noise octaves at very different scales: fine aggregate plus broad
    // patching. Uniform asphalt is the single biggest "this is a game" tell.
    float grain = fbm(vec2(lat, along) * 3.1);
    float patch = fbm(vec2(lat * 0.06, along * 0.012));
    vec3 asphalt = mix(vec3(0.020, 0.019, 0.022), vec3(0.052, 0.048, 0.050), grain * 0.75 + patch * 0.45);

    // Darker polished wheel tracks where traffic has worn the surface.
    float laneLocal = mod(lat + uHalfWidth, uLaneWidth) / uLaneWidth;
    float wear = exp(-pow((laneLocal - 0.28) * 6.0, 2.0)) + exp(-pow((laneLocal - 0.72) * 6.0, 2.0));
    asphalt *= 1.0 - wear * 0.22;

    if (uHasAlbedo > 0.5) {
      asphalt = mix(asphalt, texture(tAlbedo, vec2(lat, along) * 0.25).rgb * 0.35, 0.75);
    }

    // Sandy verge either side of the shoulder.
    vec3 verge = mix(vec3(0.072, 0.055, 0.043), vec3(0.105, 0.080, 0.060), fbm(vec2(lat, along) * 0.35));
    vec3 base = mix(asphalt, verge, vEdge);

    // ---------------------------------------------------------------- markings
    float md = 1e9;
    // Interior lane dashes: 3 m painted, 9 m gap.
    for (int i = 1; i < 5; i++) {
      float x = -uHalfWidth + float(i) * uLaneWidth;
      float dash = step(mod(along, 12.0), 3.0);
      md = min(md, mix(1e9, abs(lat - x), dash));
    }
    float lanePaint = 1.0 - smoothstep(0.055, 0.115, md);
    // Solid edge lines.
    float edgePaint = (1.0 - smoothstep(0.07, 0.14, abs(absLat - uHalfWidth + 0.25)));
    float paint = clamp(lanePaint + edgePaint, 0.0, 1.0) * (1.0 - vEdge);
    // Paint is worn, not pristine white.
    float paintWear = 0.55 + 0.45 * fbm(vec2(lat * 2.0, along * 0.6));
    base = mix(base, vec3(0.62, 0.60, 0.55) * paintWear, paint * 0.9);

    // Rumble strip on the hard shoulder.
    float rumble = step(uHalfWidth + 0.4, absLat) * step(absLat, uHalfWidth + 1.4) * step(mod(along, 1.2), 0.6);
    base = mix(base, base * 0.5, rumble * (1.0 - vEdge));

    // ---------------------------------------------------------------- wetness
    // Puddles pool in the wheel-track depressions and along the shoulder.
    float puddle = smoothstep(0.42, 0.78, fbm(vec2(lat * 0.22, along * 0.035)));
    puddle = clamp(puddle + wear * 0.30, 0.0, 1.0) * (1.0 - vEdge);
    float wet = clamp(uWetness * (0.42 + puddle * 0.68), 0.0, 1.0);
    if (uHasRough > 0.5) {
      wet *= 1.0 - texture(tRough, vec2(lat, along) * 0.25).r * 0.5;
    }

    // Wet asphalt is darker and much glossier than dry.
    base *= 1.0 - wet * 0.42;

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
    float reflAmt = wet * (0.10 + fres * 0.92);
    vec3 col = mix(base, refl, clamp(reflAmt, 0.0, 0.88));

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
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        indices[ii++] = a;
        indices[ii++] = d;
        indices[ii++] = b;
        indices[ii++] = b;
        indices[ii++] = d;
        indices[ii++] = e;
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
