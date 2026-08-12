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

/**
 * DUBAI DUSK, not generic dusk.
 *
 * The single thing that makes a Gulf sky unmistakable is DUST. There is always
 * a suspended sand load in the air over the city, and at low sun it does three
 * things no ordinary sunset does:
 *
 *  - The horizon band goes pale and MILKY rather than deepening. Distant towers
 *    do not silhouette black against a bright sky; they wash out toward the
 *    haze colour and disappear into it. That wash is the whole read.
 *  - The band is deep. It reaches well above the skyline, so a 300 m tower is
 *    half dissolved while its podium is gone entirely.
 *  - The zenith stays a dusty blue-violet. It never gets to the near-black
 *    navy of a clear-air sunset, because the dust is scattering light back down
 *    across the whole dome.
 *
 * The previous palette had a black zenith, a maroon mid-band and a thin brown
 * haze — a clear, cold, high-latitude sunset. Correct for a lot of cities, and
 * the reason this corridor could have been anywhere.
 */
export const SKY_GLSL = /* glsl */ `
  const vec3 SKY_ZENITH  = vec3(0.052, 0.076, 0.146);  // dusty blue-violet, never black
  const vec3 SKY_MID     = vec3(0.330, 0.238, 0.288);  // mauve, where dust meets sky
  const vec3 SKY_HORIZON = vec3(1.020, 0.560, 0.268);  // apricot
  const vec3 SKY_EMBER   = vec3(1.640, 0.840, 0.360);  // the sun itself
  const vec3 SKY_HAZE    = vec3(0.780, 0.545, 0.395);  // suspended sand — the signature

  // dir must be normalised. Returns linear HDR radiance.
  vec3 skyRadiance(vec3 dir, vec3 sunDir) {
    float h = clamp(dir.y, -1.0, 1.0);

    // Two-stage vertical ramp: a fast falloff near the horizon and a slow fade
    // into the zenith. A single mix() reads flat and fake here.
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

    // Dust band. Deep — it reaches to about 14 degrees of elevation, which at
    // this corridor's sightlines is roughly the top of a 300 m tower a kilometre
    // out. It also brightens toward the sun, because that is where the forward
    // scatter through the dust is strongest, and that asymmetry is what stops it
    // reading as a flat grey wash laid over the bottom of the frame.
    float dust = smoothstep(0.25, -0.06, h);
    vec3  dustCol = SKY_HAZE * (0.80 + 0.85 * pow(sunAmt, 2.2));
    col = mix(col, dustCol, dust * 0.80);

    // Below the horizon: sand bounce. Warm and far from black — this is desert
    // under a low sun, and it is what fills the gaps between the towers.
    col = mix(col, vec3(0.230, 0.150, 0.098), smoothstep(-0.02, -0.24, h));
    return col;
  }

  // Aerial perspective. Distance does not just fade a surface toward a flat
  // fog colour — it also washes the colour out of it and lifts its floor,
  // because the air between camera and subject is itself scattering light.
  // Applying all three is what separates real depth from a fog slider.
  vec3 aerial(vec3 col, vec3 worldPos, vec3 camPos, vec3 sunDir, float near, float far) {
    vec3 V = normalize(worldPos - camPos);
    float dist = length(worldPos - camPos);
    float t = clamp((dist - near) / max(far - near, 1.0), 0.0, 1.0);
    // Dust extinction is roughly exponential, not linear.
    float ext = 1.0 - exp(-t * 2.6);
    vec3 hazeCol = skyRadiance(normalize(vec3(V.x, max(V.y, 0.012), V.z)), sunDir);
    // Desaturate before mixing: distant things lose chroma faster than luminance.
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(l), ext * 0.55);
    return mix(col, hazeCol, ext);
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
