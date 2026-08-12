import * as THREE from 'three';
import { FullScreenPass } from './fsq';

/**
 * Screen-space ambient occlusion, depth only.
 *
 * Depth is the ONLY input. Every surface in this game shades through a bespoke
 * RawShaderMaterial, so there is no shared G-buffer to attach a normal target
 * to and adding one would mean touching every world module. Normals are
 * reconstructed from the depth buffer instead, using the four-neighbour
 * "closest edge" trick — take the depth gradient from whichever side of the
 * pixel is on the same surface — which keeps silhouettes from smearing into a
 * dark halo the way a naive dFdx(position) normal does.
 *
 * Runs at half resolution and is put back together with a separable
 * depth-aware (bilateral) blur, so it costs a quarter of the fill of a
 * full-resolution pass and still resolves contact darkening under the car, at
 * the base of the barriers and where the buildings meet the ground.
 *
 * Deliberately restrained. Strong SSAO in an already-dark dusk grade does not
 * read as occlusion, it reads as dirt on the lens.
 */

const COMMON = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
`;

const DEPTH_HELPERS = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 uInvProj;
  uniform vec2 uNearFar;

  // View-space position from a non-linear depth sample.
  vec3 viewFromDepth(vec2 uv, float d) {
    vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uInvProj * clip;
    return v.xyz / v.w;
  }

  float rawDepth(vec2 uv) {
    return textureLod(tDepth, clamp(uv, vec2(0.0), vec2(1.0)), 0.0).r;
  }

  // Positive distance in front of the camera, metres.
  float linearDepth(float d) {
    float n = uNearFar.x, f = uNearFar.y;
    return (2.0 * n * f) / (f + n - (d * 2.0 - 1.0) * (f - n));
  }
`;

const AO_FRAG = /* glsl */ `${COMMON}
  in vec2 vUv;
  out vec4 outColor;

  ${DEPTH_HELPERS}

  uniform mat4 uProj;
  uniform vec2 uTexel;      // one HALF-resolution pixel in uv (this pass's own texel)
  uniform vec4 uParams;     // x = radius (m), y = intensity, z = bias (m), w = power
  uniform vec2 uFade;       // x = distance where AO starts fading, y = where it is gone

  // Ten samples on a spiral through the hemisphere. Lengths are biased toward
  // the origin (i^2) so the kernel resolves contact points rather than smearing
  // a soft dome over everything.
  const vec3 KERNEL[10] = vec3[10](
    vec3( 0.1276,  0.0402,  0.0447), vec3(-0.1517,  0.1729,  0.1160),
    vec3( 0.1039, -0.3057,  0.1877), vec3(-0.3410, -0.1596,  0.2735),
    vec3( 0.4737,  0.1131,  0.2264), vec3(-0.1748,  0.5145,  0.3568),
    vec3(-0.4034, -0.4790,  0.4494), vec3( 0.6379, -0.2669,  0.3227),
    vec3( 0.1105,  0.6839,  0.6155), vec3(-0.6296,  0.3417,  0.5610)
  );

  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  void main() {
    float d = rawDepth(vUv);
    // Sky. The depth buffer is never written there (the sky shader pins itself
    // to the far plane with depthWrite off), so it stays at the clear value.
    if (d >= 0.999999) {
      outColor = vec4(1.0);
      return;
    }

    vec3 P = viewFromDepth(vUv, d);

    // --- normal from depth --------------------------------------------------
    // Sample both sides on each axis and keep the nearer neighbour: across a
    // silhouette one of the two is on a different surface entirely, and using
    // it produces a normal that faces nowhere and a dark rim around every edge.
    vec2 dx = vec2(uTexel.x, 0.0);
    vec2 dy = vec2(0.0, uTexel.y);
    vec3 pl = viewFromDepth(vUv - dx, rawDepth(vUv - dx));
    vec3 pr = viewFromDepth(vUv + dx, rawDepth(vUv + dx));
    vec3 pd = viewFromDepth(vUv - dy, rawDepth(vUv - dy));
    vec3 pu = viewFromDepth(vUv + dy, rawDepth(vUv + dy));

    vec3 dpdx = abs(pl.z - P.z) < abs(pr.z - P.z) ? (P - pl) : (pr - P);
    vec3 dpdy = abs(pd.z - P.z) < abs(pu.z - P.z) ? (P - pd) : (pu - P);
    vec3 N = normalize(cross(dpdx, dpdy));

    // --- oriented hemisphere ------------------------------------------------
    float ang = ign(gl_FragCoord.xy) * 6.2831853;
    vec3 rv = vec3(cos(ang), sin(ang), 0.0);
    vec3 T = normalize(rv - N * dot(rv, N));
    vec3 B = cross(N, T);
    mat3 TBN = mat3(T, B, N);

    float radius = uParams.x;
    float bias = uParams.z;
    float occ = 0.0;

    for (int i = 0; i < 10; i++) {
      vec3 sp = P + TBN * (KERNEL[i] * radius);
      vec4 op = uProj * vec4(sp, 1.0);
      vec2 suv = op.xy / op.w * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

      float sd = rawDepth(suv);
      if (sd >= 0.999999) continue;   // sky occludes nothing
      float sz = viewFromDepth(suv, sd).z;

      // sz > sp.z means the real surface at that pixel sits nearer the camera
      // than the sample point, i.e. it is in the way.
      float hit = step(sp.z + bias, sz);
      // Range check: a wall a hundred metres behind the sample is not an
      // occluder, it is a background. Without this every silhouette haloes.
      float range = smoothstep(0.0, 1.0, radius / max(1e-4, abs(P.z - sz)));
      occ += hit * range;
    }

    float ao = 1.0 - (occ / 10.0) * uParams.y;
    ao = pow(clamp(ao, 0.0, 1.0), uParams.w);

    // Beyond a couple of hundred metres the kernel is sub-pixel and all it
    // produces is noise, so let it go.
    ao = mix(ao, 1.0, smoothstep(uFade.x, uFade.y, -P.z));
    outColor = vec4(ao, 0.0, 0.0, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `${COMMON}
  in vec2 vUv;
  out vec4 outColor;

  ${DEPTH_HELPERS}

  uniform sampler2D tAO;
  uniform vec2 uStep;       // one HALF-resolution texel along the blur axis
  uniform float uSharpness; // fraction of the centre distance that halves the weight

  // 7 taps, gaussian-ish, weighted down wherever the neighbour is on a
  // different surface. This is what stops the AO under the car bleeding out
  // onto the road behind it.
  const float BLUR_W[4] = float[4](0.2255, 0.1945, 0.1216, 0.0716);

  void main() {
    float dc = linearDepth(rawDepth(vUv));
    // Tolerance scales with distance: at 200 m one pixel of a grazing road
    // already spans metres, and a fixed metric threshold would reject every
    // neighbour and leave the raw sampling noise standing.
    float tol = 0.10 + dc * uSharpness;
    float sum = textureLod(tAO, vUv, 0.0).r * BLUR_W[0];
    float wsum = BLUR_W[0];
    for (int i = 1; i < 4; i++) {
      vec2 o = uStep * float(i);
      for (int s = 0; s < 2; s++) {
        vec2 uv = s == 0 ? vUv + o : vUv - o;
        float dn = linearDepth(rawDepth(uv));
        float w = BLUR_W[i] / (1.0 + abs(dn - dc) / tol);
        sum += textureLod(tAO, uv, 0.0).r * w;
        wsum += w;
      }
    }
    outColor = vec4(sum / max(wsum, 1e-5), 0.0, 0.0, 1.0);
  }
`;

export interface SsaoPass {
  setSize(w: number, h: number, dpr: number): void;
  /** Renders AO from the scene depth into an internal target. */
  render(
    renderer: THREE.WebGLRenderer,
    depthTexture: THREE.Texture,
    camera: THREE.PerspectiveCamera,
  ): void;
  readonly texture: THREE.Texture;
  /** 0..1 multiplier the composite applies. Live-tweakable. */
  strength: number;
  /** World-space sampling radius, metres. */
  radius: number;
  dispose(): void;
}

function aoTarget(w: number, h: number) {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  t.texture.colorSpace = THREE.NoColorSpace;
  return t;
}

class Ssao implements SsaoPass {
  strength = 1;
  radius = 0.95;

  private ao: THREE.WebGLRenderTarget;
  private tmp: THREE.WebGLRenderTarget;
  private aoPass: FullScreenPass;
  private blurPass: FullScreenPass;

  constructor() {
    this.ao = aoTarget(1, 1);
    this.tmp = aoTarget(1, 1);

    this.aoPass = new FullScreenPass(
      AO_FRAG,
      {
        tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Matrix4() },
        uNearFar: { value: new THREE.Vector2(0.4, 4200) },
        uTexel: { value: new THREE.Vector2() },
        // radius, intensity, bias, power
        uParams: { value: new THREE.Vector4(0.95, 1.05, 0.022, 1.35) },
        uFade: { value: new THREE.Vector2(150, 340) },
      },
      'ssao',
    );

    this.blurPass = new FullScreenPass(
      BLUR_FRAG,
      {
        tDepth: { value: null },
        tAO: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uNearFar: { value: new THREE.Vector2(0.4, 4200) },
        uStep: { value: new THREE.Vector2() },
        uSharpness: { value: 0.035 },
      },
      'ssao-blur',
    );
  }

  get texture(): THREE.Texture {
    return this.ao.texture;
  }

  setSize(w: number, h: number, dpr: number) {
    const fullW = Math.max(1, Math.floor(w * dpr));
    const fullH = Math.max(1, Math.floor(h * dpr));
    const hw = Math.max(1, fullW >> 1);
    const hh = Math.max(1, fullH >> 1);
    this.ao.setSize(hw, hh);
    this.tmp.setSize(hw, hh);
    (this.aoPass.material.uniforms.uTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
  }

  render(
    renderer: THREE.WebGLRenderer,
    depthTexture: THREE.Texture,
    camera: THREE.PerspectiveCamera,
  ) {
    const a = this.aoPass.material.uniforms;
    a.tDepth.value = depthTexture;
    (a.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (a.uProj.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (a.uNearFar.value as THREE.Vector2).set(camera.near, camera.far);
    (a.uParams.value as THREE.Vector4).x = this.radius;
    this.aoPass.render(renderer, this.tmp);

    const b = this.blurPass.material.uniforms;
    b.tDepth.value = depthTexture;
    (b.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (b.uNearFar.value as THREE.Vector2).set(camera.near, camera.far);

    // Horizontal, then vertical. Separable keeps a 7x7 kernel at 14 taps.
    b.tAO.value = this.tmp.texture;
    (b.uStep.value as THREE.Vector2).set(1 / this.ao.width, 0);
    this.blurPass.render(renderer, this.ao);

    b.tAO.value = this.ao.texture;
    (b.uStep.value as THREE.Vector2).set(0, 1 / this.ao.height);
    this.blurPass.render(renderer, this.tmp);

    // Second blur landed in tmp; swap so `texture` always names the result.
    const t = this.ao;
    this.ao = this.tmp;
    this.tmp = t;
  }

  dispose() {
    this.ao.dispose();
    this.tmp.dispose();
    this.aoPass.dispose();
    this.blurPass.dispose();
  }
}

export function createSsaoPass(): SsaoPass {
  return new Ssao();
}
