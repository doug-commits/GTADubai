import * as THREE from 'three';

/**
 * Dusk sky.
 *
 * Analytic by default so there is nothing to download at boot. The GLSL is
 * exported as a chunk because the road material reuses the exact same function
 * for its wet reflections — sampling the real sky is what makes the reflection
 * sit in the scene instead of looking like a bolted-on gradient.
 *
 * ASSET SLOT: `public/assets/sky/dusk.webp` (equirectangular, 4096x2048).
 * If present it is blended over the analytic sky at boot; see `Sky.tryLoadAsset`.
 */

/**
 * Sun sits low and slightly to the north-east, behind the Trade Centre skyline.
 *
 * Elevation is a shadow-budget decision as much as an art one. At the original
 * 4.9 degrees a shadow runs about twelve times its caster's height, so the
 * towers that should shade the visible road stand more than a kilometre
 * up-sun — outside any shadow frustum we can afford at this resolution, which
 * is why the road came back fully lit. At ~11.5 degrees shadows are roughly
 * five times caster height, which fits a 2048 map over the visible range and
 * still reads as golden hour.
 */
export const SUN_DIR = new THREE.Vector3(0.36, 0.205, -0.93).normalize();

export const SKY_GLSL = /* glsl */ `
  const vec3 SKY_ZENITH  = vec3(0.030, 0.038, 0.078);
  const vec3 SKY_MID     = vec3(0.180, 0.108, 0.132);
  const vec3 SKY_HORIZON = vec3(0.760, 0.290, 0.110);
  const vec3 SKY_EMBER   = vec3(1.320, 0.520, 0.150);
  const vec3 SKY_HAZE    = vec3(0.420, 0.210, 0.180);

  // dir must be normalised. Returns linear HDR radiance.
  vec3 skyRadiance(vec3 dir, vec3 sunDir) {
    float h = clamp(dir.y, -1.0, 1.0);

    // Two-stage vertical ramp: a fast ember falloff near the horizon and a slow
    // fade into the char zenith. A single mix() reads flat and fake here.
    float t1 = pow(clamp(1.0 - h, 0.0, 1.0), 6.0);
    float t2 = pow(clamp(1.0 - h, 0.0, 1.0), 1.7);
    vec3 col = mix(SKY_ZENITH, SKY_MID, t2);
    col = mix(col, SKY_HORIZON, t1);

    // Sun-facing warmth spread wide across the horizon, not just at the disc —
    // this is most of the "golden hour" read.
    float sunAmt = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0);
    col += SKY_EMBER * pow(sunAmt, 3.0) * pow(clamp(1.0 - h, 0.0, 1.0), 3.0) * 0.85;

    // Sun disc + bloom-feeding core.
    float cosSun = dot(dir, sunDir);
    col += SKY_EMBER * 3.2 * pow(max(cosSun, 0.0), 900.0);
    col += SKY_EMBER * 0.55 * pow(max(cosSun, 0.0), 26.0);

    // Ground haze band so the skyline base dissolves rather than cutting off.
    col = mix(col, SKY_HAZE, smoothstep(0.06, -0.10, h) * 0.75);

    // Below the horizon: dark warm ground bounce.
    col = mix(col, vec3(0.045, 0.028, 0.026), smoothstep(-0.02, -0.22, h));
    return col;
  }
`;

const SKY_VERT = /* glsl */ `
  in vec3 position;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  out vec3 vDir;
  void main() {
    vDir = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // pin to the far plane
  }
`;

const SKY_FRAG = /* glsl */ `
  precision highp float;
          precision highp sampler2D;
  in vec3 vDir;
  out vec4 outColor;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform sampler2D tSky;
  uniform float uSkyMix;

  ${SKY_GLSL}

  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  void main() {
    vec3 dir = normalize(vDir);
    vec3 col = skyRadiance(dir, uSunDir);

    // A few stars in the upper band, fading out toward the ember horizon.
    //
    // Parameterised on the sphere, not by dividing xz by y. That planar
    // projection stretched without bound as dir.y approached the cutoff, so
    // each hashed cell became a huge screen-space rectangle — the "floating
    // white diamonds" that were showing up above the skyline. Each star is
    // also drawn as a round point inside its cell rather than filling it.
    if (dir.y > 0.16) {
      vec2 sph = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5,
                      asin(clamp(dir.y, -1.0, 1.0)) / 1.5707963);
      vec2 grid = sph * vec2(460.0, 190.0);
      vec2 cell = floor(grid);
      float s = hash21(cell);
      if (s > 0.9972) {
        vec2 f = fract(grid) - 0.5;
        float point = smoothstep(0.30, 0.02, length(f));
        float tw = 0.55 + 0.45 * sin(uTime * 1.7 + s * 400.0);
        col += vec3(0.86, 0.90, 1.0) * point * tw
             * smoothstep(0.16, 0.52, dir.y) * 0.5;
      }
    }

    // ASSET SLOT blend: supplied equirect skybox takes over when loaded.
    if (uSkyMix > 0.001) {
      vec2 uv = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5, acos(clamp(dir.y, -1.0, 1.0)) / 3.14159265);
      col = mix(col, texture(tSky, uv).rgb, uSkyMix);
    }

    outColor = vec4(col, 1.0);
  }
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.RawShaderMaterial;

  constructor() {
    this.material = new THREE.RawShaderMaterial({
      name: 'sky',
      glslVersion: THREE.GLSL3,
      uniforms: {
        uSunDir: { value: SUN_DIR.clone() },
        uTime: { value: 0 },
        tSky: { value: null },
        uSkyMix: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    // Scale is irrelevant (depth is pinned) but keeps it clear of the near plane.
    this.mesh.scale.setScalar(100);
  }

  update(time: number, cameraPos: THREE.Vector3) {
    this.material.uniforms.uTime.value = time;
    this.mesh.position.copy(cameraPos);
  }

  /** ASSET SLOT loader — silently no-ops when the file is absent. */
  tryLoadAsset(url = 'assets/sky/dusk.webp') {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        this.material.uniforms.tSky.value = tex;
        this.material.uniforms.uSkyMix.value = 1;
      },
      undefined,
      () => {
        /* no asset supplied yet — analytic sky stands in */
      },
    );
  }
}

/** Ambient/key lighting derived from the same dusk palette, for lit materials. */
export function makeLights(): THREE.Object3D[] {
  const key = new THREE.DirectionalLight(0xffb066, 2.6);
  key.position.copy(SUN_DIR).multiplyScalar(300);

  // Cool bounce from the opposite side keeps the shadowed faces from going flat black.
  const fill = new THREE.DirectionalLight(0x4a5c9a, 0.55);
  fill.position.set(-SUN_DIR.x * 200, 120, -SUN_DIR.z * 200);

  const hemi = new THREE.HemisphereLight(0xff8a4a, 0x120a12, 0.75);

  return [key, fill, hemi];
}
