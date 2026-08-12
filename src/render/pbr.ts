/**
 * Physically-based shading.
 *
 * This is the shared contract every surface in the game shades against —
 * road, vehicles, buildings, barriers. Replacing the previous ad-hoc
 * "fresnel + a bit of sky" with a real microfacet BRDF is what stops
 * materials reading as flat toy plastic: metal goes dark and mirror-like at
 * grazing angles, paint gets a proper clearcoat lobe, wet asphalt goes glossy
 * without going white.
 *
 * Cook-Torrance GGX, Smith height-correlated visibility, Schlick fresnel, and
 * a split-sum IBL approximation whose specular source is the analytic dusk sky
 * (so there is nothing to download — the environment IS the sky shader).
 *
 * Everything is linear HDR. Tonemapping happens once, in the composite pass.
 */

export const PBR_GLSL = /* glsl */ `
  #ifndef PI
  #define PI 3.14159265359
  #endif

  // --- microfacet terms ----------------------------------------------------

  // GGX / Trowbridge-Reitz normal distribution.
  float D_GGX(float NoH, float rough) {
    float a = NoH * rough;
    float k = rough / (1.0 - NoH * NoH + a * a);
    return k * k * (1.0 / PI);
  }

  // Height-correlated Smith visibility. Cheaper and more correct than the
  // separable form; the correlation matters at the grazing angles that
  // dominate a low camera on a wet road.
  float V_SmithGGXCorrelated(float NoV, float NoL, float rough) {
    float a2 = rough * rough;
    float lv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
    float ll = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
    return 0.5 / max(lv + ll, 1e-5);
  }

  vec3 F_Schlick(float u, vec3 f0) {
    float f = pow(1.0 - u, 5.0);
    return f0 + (vec3(1.0) - f0) * f;
  }

  // Roughness-aware fresnel for IBL: without this, rough metals get a bright
  // white rim that reads as a rendering error.
  vec3 F_SchlickRoughness(float u, vec3 f0, float rough) {
    vec3 fr = max(vec3(1.0 - rough), f0);
    return f0 + (fr - f0) * pow(1.0 - u, 5.0);
  }

  float Fd_Lambert() { return 1.0 / PI; }

  // Burley diffuse — keeps rough dielectrics (concrete, tarmac) from looking
  // uniformly matte under a low sun.
  float Fd_Burley(float NoV, float NoL, float LoH, float rough) {
    float f90 = 0.5 + 2.0 * rough * LoH * LoH;
    float lightScatter = 1.0 + (f90 - 1.0) * pow(1.0 - NoL, 5.0);
    float viewScatter  = 1.0 + (f90 - 1.0) * pow(1.0 - NoV, 5.0);
    return lightScatter * viewScatter * (1.0 / PI);
  }

  // --- split-sum IBL -------------------------------------------------------

  // Analytic fit to the DFG lookup table (Karis, mobile approximation). Saves
  // shipping a BRDF LUT texture, which matters for the load budget.
  vec2 envDFG(float NoV, float rough) {
    const vec4 c0 = vec4(-1.0, -0.0275, -0.572,  0.022);
    const vec4 c1 = vec4( 1.0,  0.0425,  1.040, -0.040);
    vec4 r = rough * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
    return vec2(-1.04, 1.04) * a004 + r.zw;
  }

  struct Surface {
    vec3  albedo;
    float metallic;
    float roughness;
    vec3  N;
    vec3  V;
    float occlusion;
    /** Extra clearcoat lobe strength, 0 = none. Car paint uses this. */
    float clearcoat;
    float clearcoatRoughness;
  };

  Surface makeSurface(vec3 albedo, float metallic, float roughness, vec3 N, vec3 V) {
    Surface s;
    s.albedo = albedo;
    s.metallic = metallic;
    // Clamp: perfectly smooth surfaces produce a singular specular lobe that
    // aliases into fireflies once bloom gets hold of it.
    s.roughness = clamp(roughness, 0.045, 1.0);
    s.N = N;
    s.V = V;
    s.occlusion = 1.0;
    s.clearcoat = 0.0;
    s.clearcoatRoughness = 0.1;
    return s;
  }

  /** Direct contribution from one analytic light. */
  vec3 shadeDirect(Surface s, vec3 L, vec3 radiance) {
    vec3 H = normalize(s.V + L);
    float NoV = clamp(dot(s.N, s.V), 1e-4, 1.0);
    float NoL = clamp(dot(s.N, L), 0.0, 1.0);
    float NoH = clamp(dot(s.N, H), 0.0, 1.0);
    float LoH = clamp(dot(L, H), 0.0, 1.0);

    vec3 f0 = mix(vec3(0.04), s.albedo, s.metallic);
    vec3 diffuseColor = s.albedo * (1.0 - s.metallic);

    float D = D_GGX(NoH, s.roughness);
    float Vis = V_SmithGGXCorrelated(NoV, NoL, s.roughness);
    vec3  F = F_Schlick(LoH, f0);

    vec3 Fr = (D * Vis) * F;
    vec3 Fd = diffuseColor * Fd_Burley(NoV, NoL, LoH, s.roughness);

    vec3 col = (Fd + Fr) * radiance * NoL;

    if (s.clearcoat > 0.0) {
      float ccRough = clamp(s.clearcoatRoughness, 0.045, 1.0);
      float Dc = D_GGX(NoH, ccRough);
      float Vc = V_SmithGGXCorrelated(NoV, NoL, ccRough);
      float Fc = F_Schlick(LoH, vec3(0.04)).x * s.clearcoat;
      // Energy taken by the coat is removed from the layer beneath it.
      col *= (1.0 - Fc);
      col += Dc * Vc * Fc * radiance * NoL;
    }
    return col;
  }

  /**
   * Image-based lighting.
   *
   * irradiance  = cosine-convolved sky in the normal direction (diffuse)
   * prefiltered = sky along the reflection vector, blurred by roughness
   *
   * Callers supply both by sampling the analytic sky, so no environment
   * texture is ever downloaded.
   */
  vec3 shadeIBL(Surface s, vec3 irradiance, vec3 prefiltered) {
    float NoV = clamp(dot(s.N, s.V), 1e-4, 1.0);
    vec3 f0 = mix(vec3(0.04), s.albedo, s.metallic);
    vec3 diffuseColor = s.albedo * (1.0 - s.metallic);

    vec2 dfg = envDFG(NoV, s.roughness);
    vec3 specularColor = f0 * dfg.x + dfg.y;

    // Cheap multi-scatter compensation: without it rough metals lose a
    // visible amount of energy and read as dirty rather than rough.
    vec3 energyComp = 1.0 + f0 * (1.0 / max(dfg.y, 1e-3) - 1.0) * 0.25;

    vec3 Fd = diffuseColor * irradiance;
    vec3 Fr = prefiltered * specularColor * energyComp;

    vec3 col = (Fd + Fr) * s.occlusion;

    if (s.clearcoat > 0.0) {
      vec3 Fc = F_SchlickRoughness(NoV, vec3(0.04), s.clearcoatRoughness) * s.clearcoat;
      col *= (1.0 - Fc);
      col += prefiltered * Fc;
    }
    return col;
  }

  /**
   * Specular anti-aliasing. High-frequency normals on a glossy surface — every
   * kerb edge, every car panel at distance — sparkle violently once bloom is
   * applied. Widening the lobe by the screen-space normal derivative is the
   * standard fix and costs two derivatives.
   */
  float filterRoughness(vec3 N, float rough) {
    vec3 dndu = dFdx(N);
    vec3 dndv = dFdy(N);
    float variance = 0.25 * (dot(dndu, dndu) + dot(dndv, dndv));
    float kernelRough = min(2.0 * variance, 0.18);
    return clamp(sqrt(rough * rough + kernelRough), 0.045, 1.0);
  }
`;

/**
 * Sky-derived IBL helpers.
 *
 * Both are analytic: `skyIrradiance` approximates a cosine convolution by
 * sampling the sky in a few directions around the normal, and
 * `skyPrefiltered` widens toward the horizon haze as roughness rises. Requires
 * SKY_GLSL to be included first.
 */
export const SKY_IBL_GLSL = /* glsl */ `
  // Cosine-weighted approximation: the normal plus a ring of offsets. Six taps
  // is enough because the dusk sky is a smooth low-frequency gradient.
  vec3 skyIrradiance(vec3 N, vec3 sunDir) {
    vec3 up = abs(N.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 t = normalize(cross(up, N));
    vec3 b = cross(N, t);
    vec3 sum = skyRadiance(N, sunDir) * 2.0;
    const float SP = 0.62;
    sum += skyRadiance(normalize(N + t * SP), sunDir);
    sum += skyRadiance(normalize(N - t * SP), sunDir);
    sum += skyRadiance(normalize(N + b * SP), sunDir);
    sum += skyRadiance(normalize(N - b * SP), sunDir);
    sum += skyRadiance(normalize(N + vec3(0.0, 0.55, 0.0)), sunDir);
    // Ground bounce: warm, dark, and the reason undersides are not black.
    sum += vec3(0.055, 0.032, 0.026) * 1.5;
    return sum / 8.0;
  }

  // Roughness-blurred reflection. Rough surfaces pull toward the horizon band,
  // which is where a dusk sky's energy actually is.
  vec3 skyPrefiltered(vec3 R, float rough, vec3 sunDir) {
    vec3 Rb = normalize(mix(R, normalize(vec3(R.x, mix(R.y, 0.10, 0.7), R.z)), rough));
    vec3 c = skyRadiance(Rb, sunDir);
    if (rough > 0.25) {
      vec3 up = abs(Rb.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 t = normalize(cross(up, Rb));
      vec3 b = cross(Rb, t);
      float w = rough * 0.55;
      c += skyRadiance(normalize(Rb + t * w), sunDir);
      c += skyRadiance(normalize(Rb - t * w), sunDir);
      c += skyRadiance(normalize(Rb + b * w), sunDir);
      c += skyRadiance(normalize(Rb - b * w), sunDir);
      c /= 5.0;
    }
    return c;
  }
`;
