import * as THREE from 'three';
import { FullScreenPass, makeTarget } from './fsq';
import { createSsaoPass, type SsaoPass } from './ssao';
import { SHADOW_GLSL, shadowUniforms, syncShadowUniforms, type ShadowSystem } from './shadows';

/**
 * HDR post chain.
 *
 *   scene(HDR + depth) -> SSAO (half res, bilateral) ------------.
 *                      -> bright extract -> dual-filter bloom ---+-> composite
 *
 * The composite pass does the deferred sun shadow and ambient occlusion,
 * radial motion blur, bloom add, filmic tonemap, the "Ember & Char" dusk
 * grade, chromatic aberration, vignette and grain in ONE fullscreen pass.
 * Everything else runs at half resolution or lower, so the only
 * native-resolution work is the scene render plus that single pass — which is
 * what keeps this inside a phone's fill-rate budget.
 *
 * Shadow and AO are applied HERE rather than inside each surface shader
 * because every material in the game is a bespoke RawShaderMaterial with its
 * own lighting: there is no shared shading function to hook. The scene target
 * therefore carries a real depth TEXTURE, world position is reconstructed from
 * it, and the linear HDR colour is modulated before anything tonemaps it.
 * `SHADOW_GLSL` is the same chunk a surface shader would include, so moving
 * the shadow term forward into the materials later is a drop-in.
 */

const BLOOM_LEVELS = 5;

// RawShaderMaterial injects nothing, so every precision qualifier has to be
// declared here. `sampler2D` matters more than it looks: GLSL ES 3.0 defaults
// samplers to lowp, which would clamp our half-float HDR reads to roughly
// [-2, 2] and silently destroy the bloom pyramid.
const COMMON = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
`;

const BRIGHT_FRAG = /* glsl */ `${COMMON}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tScene;
  uniform vec3 uThreshold; // x = knee lower, y = knee range, z = threshold

  void main() {
    vec3 c = texture(tScene, vUv).rgb;
    // Perceptual luminance, so warm gold signage blooms before cool grey concrete.
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Soft knee: fades bloom in around the threshold instead of popping.
    float soft = clamp(lum - uThreshold.x, 0.0, uThreshold.y);
    soft = soft * soft / (4.0 * uThreshold.y + 1e-4);
    float contrib = max(soft, lum - uThreshold.z) / max(lum, 1e-4);
    outColor = vec4(c * contrib, 1.0);
  }
`;

const DOWN_FRAG = /* glsl */ `${COMMON}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tSrc;
  uniform vec2 uHalfPixel;

  void main() {
    // Kawase dual-filter downsample: 5 taps, wide kernel, no ringing.
    vec3 sum = texture(tSrc, vUv).rgb * 4.0;
    sum += texture(tSrc, vUv - uHalfPixel).rgb;
    sum += texture(tSrc, vUv + uHalfPixel).rgb;
    sum += texture(tSrc, vUv + vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
    sum += texture(tSrc, vUv - vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
    outColor = vec4(sum * 0.125, 1.0);
  }
`;

const UP_FRAG = /* glsl */ `${COMMON}
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D tSrc;
  uniform sampler2D tPrev;
  uniform vec2 uHalfPixel;

  void main() {
    vec3 s = texture(tSrc, vUv + vec2(-uHalfPixel.x * 2.0, 0.0)).rgb;
    s += texture(tSrc, vUv + vec2(-uHalfPixel.x, uHalfPixel.y)).rgb * 2.0;
    s += texture(tSrc, vUv + vec2(0.0, uHalfPixel.y * 2.0)).rgb;
    s += texture(tSrc, vUv + vec2(uHalfPixel.x, uHalfPixel.y)).rgb * 2.0;
    s += texture(tSrc, vUv + vec2(uHalfPixel.x * 2.0, 0.0)).rgb;
    s += texture(tSrc, vUv + vec2(uHalfPixel.x, -uHalfPixel.y)).rgb * 2.0;
    s += texture(tSrc, vUv + vec2(0.0, -uHalfPixel.y * 2.0)).rgb;
    s += texture(tSrc, vUv + vec2(-uHalfPixel.x, -uHalfPixel.y)).rgb * 2.0;
    outColor = vec4(s / 12.0 + texture(tPrev, vUv).rgb, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `${COMMON}
  in vec2 vUv;
  out vec4 outColor;

  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tDepth;    // scene depth, for shadow + AO reconstruction
  uniform sampler2D tAO;       // half-res, blurred ambient occlusion
  uniform vec2  uResolution;
  uniform float uTime;
  uniform float uSpeed01;      // 0..1 normalised speed, drives every velocity cue
  uniform float uBloom;
  uniform float uExposure;
  uniform vec2  uFocal;        // screen-space vanishing point the blur radiates from
  uniform float uShake;        // 0..1 crash impulse
  uniform float uFlash;        // 0..1 white/ember hit
  uniform float uVignette;
  uniform float uGrain;
  uniform float uFade;         // 1 = fully faded to black (phase transitions)
  uniform mat4  uInvProj;      // clip -> view
  uniform mat4  uInvViewProj;  // clip -> world
  uniform mat3  uCamRot;       // view -> world rotation, for the reconstructed normal
  uniform float uAo;           // 0..1 AO strength
  uniform float uDebugView;    // 0 = normal, 1 = AO only, 2 = shadow only

  ${SHADOW_GLSL}

  // What a surface keeps when the sun is blocked: no warm key, only the cool
  // skylight that the grade then pushes further toward char. Losing 100 % of
  // the light reads as a hole cut in the image, not as a shadow.
  const vec3 SUN_LOSS = vec3(0.30, 0.335, 0.44);

  // --- "Ember & Char" grade ------------------------------------------------
  // CHAR is cool, not brown. Real dusk is a blue-to-orange split: skylight is
  // the cold fill, the low sun and artificial light are the warm key. Tinting
  // shadows warm as well as highlights collapsed the whole frame onto a single
  // amber axis, which is the signature of a stylised look rather than a
  // photographic one. Shadows now carry the cool skylight; gold stays gold.
  const vec3 SHADOW_TINT    = vec3(0.098, 0.122, 0.196); // cool char / skylight
  const vec3 HIGHLIGHT_TINT = vec3(0.957, 0.718, 0.251); // #F4B740 warm gold

  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  // AgX-flavoured filmic curve: holds saturation in the highlights far better
  // than Reinhard, which is what keeps the sun and the signage from going white.
  vec3 tonemap(vec3 x) {
    x = max(x, vec3(0.0));
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    vec3 t = (x * (a * x + b)) / (x * (c * x + d) + e);
    return clamp(t, 0.0, 1.0);
  }

  // Contrast about a 0.5 pivot using symmetric power curves that meet at the
  // pivot. Monotonic on [0,1] and mathematically incapable of clipping.
  //
  // This replaces a naive (c - 0.5) * k + 0.5 stretch, which drove every
  // tonemapped value below 0.045 to pure black. Wet dusk asphalt sits at
  // 0.02-0.05, so that one line was erasing the entire road surface.
  vec3 contrastS(vec3 c, float k) {
    vec3 lo = 0.5 * pow(clamp(c * 2.0, 0.0, 1.0), vec3(k));
    vec3 hi = 1.0 - 0.5 * pow(clamp((1.0 - c) * 2.0, 0.0, 1.0), vec3(k));
    return mix(lo, hi, step(vec3(0.5), c));
  }

  vec3 grade(vec3 c) {
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));

    // Split tone: char in the shadows, gold in the highlights.
    float sw = pow(1.0 - clamp(lum, 0.0, 1.0), 2.2);
    float hw = pow(clamp(lum, 0.0, 1.6), 1.6);

    // CHAR. Shadows are driven hard down and warm-neutral. There is
    // deliberately no shadow lift here: an earlier version added one to rescue
    // a road that was being culled rather than under-lit, and once the road
    // actually rendered that lift was what flattened the whole frame to a
    // single cream value with no black in it.
    // Multiply toward cool char, then add a small skylight lift. Deep shadows
    // that are merely dark read as underexposure; deep shadows that are dark
    // AND cool read as dusk.
    c = mix(c, c * SHADOW_TINT * 3.4, sw * 0.50);
    c += SHADOW_TINT * sw * 0.030;
    c = mix(c, c * HIGHLIGHT_TINT * 1.22, hw * 0.34);

    // Film toe. A real black point is the difference between "dark" and
    // "char", and it is what the window emissives and wet-road speculars need
    // to read against.
    c = max(vec3(0.0), (c - 0.012) / 0.988);

    c = contrastS(clamp(c, 0.0, 1.0), 1.32);

    // Pull saturation up in the mids only — deep shadows staying desaturated is
    // what reads as "dusk" rather than "orange filter".
    float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float midMask = 1.0 - abs(l2 - 0.42) * 1.9;
    c = mix(vec3(l2), c, 1.0 + clamp(midMask, 0.0, 1.0) * 0.34);
    return clamp(c, 0.0, 1.0);
  }

  void main() {
    vec2 uv = vUv;

    // Crash shake, applied in screen space so it survives any camera rig.
    if (uShake > 0.001) {
      float t = uTime * 63.0;
      uv += vec2(sin(t * 1.7), cos(t * 2.3)) * uShake * 0.016;
    }

    vec2 toCenter = uv - uFocal;
    float rad = length(toCenter);

    // --- radial motion blur ------------------------------------------------
    // Strength ramps with speed AND with distance from the vanishing point, so
    // the road ahead stays readable while the periphery tears past. This is the
    // primary velocity cue in the whole image — the ground plane streaking is
    // what makes 280 km/h feel like 280 km/h, so it is deliberately strong.
    float blurAmt = uSpeed01 * uSpeed01 * 0.19 * smoothstep(0.0, 0.55, rad);
    vec3 col = vec3(0.0);
    float wsum = 0.0;
    const int TAPS = 10;
    // Dither the tap offset per-pixel to trade banding for a little noise.
    float jitter = hash21(gl_FragCoord.xy + uTime) * 0.7;
    for (int i = 0; i < TAPS; i++) {
      float f = (float(i) + jitter) / float(TAPS);
      float w = 1.0 - f * 0.55;
      vec2 suv = uv - toCenter * f * blurAmt;
      // Chromatic aberration fringes the smear like a real lens. Kept subtle:
      // at phone size, visible cyan/magenta edging reads as a rendering fault
      // rather than as a lens, so this is a fraction of the blur, not a peer.
      float ca = f * blurAmt * 0.10 + rad * 0.0011 * (0.3 + uSpeed01);
      vec3 s;
      s.r = texture(tScene, suv + toCenter * ca).r;
      s.g = texture(tScene, suv).g;
      s.b = texture(tScene, suv - toCenter * ca).b;
      col += s * w;
      wsum += w;
    }
    col /= wsum;

    // --- deferred sun shadow + ambient occlusion ---------------------------
    // Reconstruct the fragment from depth once, and use it for both terms.
    // Derivatives are taken here, in uniform control flow, because sampleShadow
    // builds a receiver-plane bias out of them.
    float sceneDepth = textureLod(tDepth, uv, 0.0).r;
    vec4 clip = vec4(uv * 2.0 - 1.0, sceneDepth * 2.0 - 1.0, 1.0);
    vec4 vp = uInvProj * clip;
    vec3 viewPos = vp.xyz / vp.w;
    vec4 wp = uInvViewProj * clip;
    vec3 worldPos = wp.xyz / wp.w;
    // Geometric normal from the depth buffer. Only the bias and the
    // facing-away gate use it, so screen-space accuracy is plenty.
    vec3 N = normalize(uCamRot * normalize(cross(dFdx(viewPos), dFdy(viewPos))));

    float visRaw = sampleShadow(worldPos, N);
    float aoRaw = textureLod(tAO, uv, 0.0).r;

    // The sky never writes depth, so it sits at the clear value and is exempt
    // from both terms — a darkened sky is the classic giveaway of AO applied
    // as a blanket multiply.
    float isSky = step(0.999999, sceneDepth);
    float vis = mix(visRaw, 1.0, isSky);
    float ao = mix(aoRaw, 1.0, isSky);

    // Emitters are not lit by the sun and must not be shadowed by it: window
    // interiors, headlights, signage and the lane paint under a streetlight are
    // all well above 1.0 in linear HDR. Fade both terms out as the pixel
    // brightens, or the city switches off wherever a shadow crosses it.
    float srcLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float guard = 1.0 - smoothstep(0.85, 2.40, srcLum);
    vis = mix(1.0, vis, guard);
    ao = mix(1.0, ao, guard);

    col *= mix(SUN_LOSS, vec3(1.0), vis);
    col *= mix(1.0, ao, uAo);

    // --- bloom -------------------------------------------------------------
    vec3 bloom = texture(tBloom, uv).rgb;
    col += bloom * uBloom;

    // Ember flash on impact / arrival.
    col += vec3(1.0, 0.42, 0.16) * uFlash * 1.4;

    // --- tonemap + grade ---------------------------------------------------
    col = tonemap(col * uExposure);
    col = grade(col);

    // --- vignette ----------------------------------------------------------
    // Tightens with speed — a cheap, very effective tunnel-vision cue.
    // Softer and shallower: a quarter of a phone screen was going to solid
    // black, which is dead space on the part of the road closest to the camera.
    float vig = 1.0 - uVignette * (0.34 + uSpeed01 * 0.42) * pow(rad * 1.18, 2.0);
    col *= clamp(vig, 0.0, 1.0);

    // --- grain -------------------------------------------------------------
    // Weighted toward the mids. Grain sitting on top of near-black asphalt is
    // the most visible artefact on a phone panel and reads as noise, not film.
    float gl = dot(col, vec3(0.3333));
    float grainMask = smoothstep(0.02, 0.16, gl) * (1.0 - gl * 0.45);
    float g = hash21(gl_FragCoord.xy + fract(uTime) * 431.7) - 0.5;
    col += g * uGrain * grainMask;

    col *= (1.0 - uFade);

    // Ordered-dither the 8-bit write; without it the dark ember gradients band badly.
    float d = hash21(gl_FragCoord.xy * 1.37) - 0.5;
    col += d / 255.0;

    // Manual sRGB encode — the target is written as raw bytes.
    col = clamp(col, 0.0, 1.0);
    vec3 srgb = mix(col * 12.92, 1.055 * pow(max(col, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));

    // Isolation views for the critic harness: ?viewao=1 / ?viewshadow=1.
    if (uDebugView > 0.5) {
      srgb = vec3(uDebugView < 1.5 ? aoRaw : visRaw);
      if (uDebugView > 2.5) {
        vec4 dsc = uShadowMatrix * vec4(worldPos, 1.0);
        if (uDebugView < 3.5) srgb = vec3(fract(sceneDepth * 64.0), sceneDepth, 0.0);
        else if (uDebugView < 4.5) srgb = vec3(dsc.xy, 0.0);
        else if (uDebugView < 5.5) srgb = vec3(fract(dsc.z * 8.0), dsc.z, 0.0);
        else if (uDebugView < 6.5) srgb = vec3(textureLod(tShadowMap, clamp(dsc.xy, 0.0, 1.0), 0.0).r);
        else srgb = abs(N);
      }
    }
    outColor = vec4(srgb, 1.0);
  }
`;

export interface PostSettings {
  bloom: number;
  exposure: number;
  vignette: number;
  grain: number;
  /** Ambient occlusion strength, 0..1. Subtle by design — see the shader. */
  ao: number;
}

export class PostPipeline {
  sceneTarget: THREE.WebGLRenderTarget;
  readonly sceneDepth: THREE.DepthTexture;
  readonly ssao: SsaoPass;
  /** Set by the game once the shadow system exists. Null disables shadowing. */
  shadows: ShadowSystem | null = null;
  /** 0 = normal, 1 = AO isolated, 2 = shadow isolated. */
  debugView = 0;
  private bright: THREE.WebGLRenderTarget[] = [];
  private brightPass: FullScreenPass;
  private downPass: FullScreenPass;
  private upPass: FullScreenPass;
  private compositePass: FullScreenPass;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  /**
   * Draw calls and triangles for the SCENE pass alone, snapshotted before the
   * post chain runs. `renderer.info` resets on every render() call, so reading
   * it after the composite pass reports "1 draw call, 1 triangle" — the
   * fullscreen triangle — and hides the cost that actually matters.
   */
  readonly sceneStats = { drawCalls: 0, triangles: 0 };

  /** Number of levels in the bloom pyramid, for cost reporting. */
  get bloomLevels() {
    return this.bright.length;
  }

  /**
   * Fullscreen-equivalent passes after the scene render: bright extract,
   * down/up bloom pyramid, composite, plus the three quarter-area SSAO passes.
   */
  get passCount() {
    return 2 + (this.bright.length - 1) * 2 + 3;
  }

  /** Live, tweakable per frame. */
  speed01 = 0;
  shake = 0;
  flash = 0;
  fade = 0;
  focal = new THREE.Vector2(0.5, 0.55);
  settings: PostSettings = {
    bloom: 1.15,
    exposure: 0.78,
    vignette: 0.62,
    grain: 0.026,
    ao: 0.62,
  };

  constructor(private renderer: THREE.WebGLRenderer) {
    // A depth TEXTURE, not just a depth buffer: SSAO and the deferred shadow
    // both read it. NEAREST is not a choice — a WebGL2 depth texture with
    // TEXTURE_COMPARE_MODE off is not filterable, and LINEAR returns garbage.
    this.sceneDepth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.sceneDepth.format = THREE.DepthFormat;
    this.sceneDepth.minFilter = THREE.NearestFilter;
    this.sceneDepth.magFilter = THREE.NearestFilter;
    this.sceneDepth.compareFunction = null;

    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture: this.sceneDepth,
    });
    this.sceneTarget.texture.colorSpace = THREE.NoColorSpace;
    this.ssao = createSsaoPass();

    this.brightPass = new FullScreenPass(
      BRIGHT_FRAG,
      {
        tScene: { value: null },
        // (knee start, knee width, hard threshold). Raised well above 1.0 so
        // only genuine emitters — window interiors, signage, headlights, the
        // sun — reach the bloom pyramid. At the previous 1.0 threshold most of
        // the lit scene qualified, which turns bloom into a global haze and
        // means nothing glows because everything glows.
        uThreshold: { value: new THREE.Vector3(1.35, 1.1, 2.05) },
      },
      'bright',
    );
    this.downPass = new FullScreenPass(
      DOWN_FRAG,
      { tSrc: { value: null }, uHalfPixel: { value: new THREE.Vector2() } },
      'bloom-down',
    );
    this.upPass = new FullScreenPass(
      UP_FRAG,
      {
        tSrc: { value: null },
        tPrev: { value: null },
        uHalfPixel: { value: new THREE.Vector2() },
      },
      'bloom-up',
    );
    this.compositePass = new FullScreenPass(
      COMPOSITE_FRAG,
      {
        tScene: { value: null },
        tBloom: { value: null },
        tDepth: { value: null },
        tAO: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uSpeed01: { value: 0 },
        uBloom: { value: 0.9 },
        uExposure: { value: 1.0 },
        uFocal: { value: new THREE.Vector2(0.5, 0.55) },
        uShake: { value: 0 },
        uFlash: { value: 0 },
        uVignette: { value: 0.9 },
        uGrain: { value: 0.035 },
        uFade: { value: 0 },
        uInvProj: { value: new THREE.Matrix4() },
        uInvViewProj: { value: new THREE.Matrix4() },
        uCamRot: { value: new THREE.Matrix3() },
        uAo: { value: 0.6 },
        uDebugView: { value: 0 },
        ...shadowUniforms(),
      },
      'composite',
    );
  }

  setSize(width: number, height: number, pixelRatio: number) {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.sceneTarget.setSize(w, h);
    this.ssao.setSize(width, height, pixelRatio);

    for (const t of this.bright) t.dispose();
    this.bright = [];
    let bw = Math.max(1, w >> 1);
    let bh = Math.max(1, h >> 1);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.bright.push(makeTarget(bw, bh));
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    (this.compositePass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  /** Render `scene` through the full chain to the default framebuffer. */
  render(scene: THREE.Scene, camera: THREE.Camera, time: number) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();

    r.setRenderTarget(this.sceneTarget);
    r.clear(true, true, true);
    r.render(scene, camera);
    this.sceneStats.drawCalls = r.info.render.calls;
    this.sceneStats.triangles = r.info.render.triangles;

    // AO from depth, half res, before anything touches the colour.
    const persp = camera as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera) {
      this.ssao.render(r, this.sceneDepth, persp);
    }

    // Bright extract into level 0.
    this.brightPass.material.uniforms.tScene.value = this.sceneTarget.texture;
    this.brightPass.render(r, this.bright[0]);

    // Downsample pyramid.
    for (let i = 1; i < this.bright.length; i++) {
      const src = this.bright[i - 1];
      this.downPass.material.uniforms.tSrc.value = src.texture;
      (this.downPass.material.uniforms.uHalfPixel.value as THREE.Vector2).set(
        0.5 / src.width,
        0.5 / src.height,
      );
      this.downPass.render(r, this.bright[i]);
    }

    // Upsample and accumulate back down the pyramid. Each level adds into the
    // one above it, which is what gives the wide, soft skyline halo.
    for (let i = this.bright.length - 1; i > 0; i--) {
      const src = this.bright[i];
      const dst = this.bright[i - 1];
      this.upPass.material.uniforms.tSrc.value = src.texture;
      this.upPass.material.uniforms.tPrev.value = dst.texture;
      (this.upPass.material.uniforms.uHalfPixel.value as THREE.Vector2).set(
        0.5 / src.width,
        0.5 / src.height,
      );
      // Ping-pong through a scratch read: WebGL forbids sampling the target we
      // are writing, so accumulate into the *next* level up instead.
      this.upPass.render(r, this.scratchFor(i - 1));
      this.swap(i - 1);
    }

    const u = this.compositePass.material.uniforms;
    u.tScene.value = this.sceneTarget.texture;
    u.tBloom.value = this.bright[0].texture;
    u.tDepth.value = this.sceneDepth;
    u.tAO.value = this.ssao.texture;
    u.uAo.value = persp.isPerspectiveCamera ? this.settings.ao : 0;
    u.uDebugView.value = this.debugView;

    // Depth -> view -> world. `matrixWorld` and `projectionMatrixInverse` are
    // both current: the rig updated the projection and the scene render above
    // refreshed the world matrix.
    (u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uInvViewProj.value as THREE.Matrix4)
      .copy(camera.matrixWorld)
      .multiply(camera.projectionMatrixInverse);
    (u.uCamRot.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);
    syncShadowUniforms(u, this.shadows);

    u.uTime.value = time;
    u.uSpeed01.value = this.speed01;
    u.uBloom.value = this.settings.bloom;
    u.uExposure.value = this.settings.exposure;
    (u.uFocal.value as THREE.Vector2).copy(this.focal);
    u.uShake.value = this.shake;
    u.uFlash.value = this.flash;
    u.uVignette.value = this.settings.vignette;
    u.uGrain.value = this.settings.grain;
    u.uFade.value = this.fade;

    this.compositePass.render(r, null);
    r.setRenderTarget(prevTarget);
  }

  // --- ping-pong bookkeeping for the upsample accumulation ------------------
  private scratch = new Map<number, THREE.WebGLRenderTarget>();

  private scratchFor(level: number): THREE.WebGLRenderTarget {
    let t = this.scratch.get(level);
    const ref = this.bright[level];
    if (!t || t.width !== ref.width || t.height !== ref.height) {
      t?.dispose();
      t = makeTarget(ref.width, ref.height);
      this.scratch.set(level, t);
    }
    return t;
  }

  private swap(level: number) {
    const s = this.scratch.get(level)!;
    const b = this.bright[level];
    this.bright[level] = s;
    this.scratch.set(level, b);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.sceneDepth.dispose();
    this.ssao.dispose();
    for (const t of this.bright) t.dispose();
    for (const t of this.scratch.values()) t.dispose();
    this.brightPass.dispose();
    this.downPass.dispose();
    this.upPass.dispose();
    this.compositePass.dispose();
  }
}
