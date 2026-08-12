import * as THREE from 'three';
import { SKY_GLSL, SUN_DIR } from '../render/sky';
import { PBR_GLSL, SKY_IBL_GLSL } from '../render/pbr';

/**
 * ============================================================================
 *  DESERT — the ground the city is standing on
 * ============================================================================
 *
 *  There was no ground. The road ribbon carried a 14 m verge either side and
 *  then stopped, so beyond it the world was the void: black between the towers,
 *  black under the gaps in the skyline, and a horizon that simply ended. On a
 *  dark corridor that reads as a vignette. Once the sky went pale it read as a
 *  hole, which is what forced the issue.
 *
 *  This is one plane and one draw call. Everything on it is analytic:
 *
 *   - Sand. Warm, bright, and genuinely bright — desert albedo is around 0.4,
 *     several times the asphalt beside it, and that contrast at the edge of the
 *     carriageway is a large part of why a Gulf road looks like a Gulf road.
 *   - Dune modulation at two scales, plus wind ripples fine enough to only
 *     resolve near the car.
 *   - Sabkha: the pale salt-crust flats between the plots, which go almost
 *     white under a low sun.
 *   - The same dust fog the sky uses, so the ground plane and the sky meet in
 *     the same colour and the horizon dissolves instead of drawing a line.
 * ============================================================================
 */

const DESERT_VERT = /* glsl */ `
  in vec3 position;
  uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
  out vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;

const DESERT_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  in vec3 vW;
  out vec4 outColor;
  uniform vec3 uCameraPos, uSunDir;
  uniform float uFogNear, uFogFar;
  ${SKY_GLSL}
  ${PBR_GLSL}
  ${SKY_IBL_GLSL}

  float h21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x),
               mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    vec3 V = normalize(vW - uCameraPos);
    float dist = length(vW - uCameraPos);

    // Detail budget: ripples only resolve close to the car, dunes hold on much
    // further out. Without the fade the fine scale aliases into noise across the
    // whole plane, which at this grazing an angle is the worst case there is.
    float near = 1.0 - smoothstep(40.0, 340.0, dist);

    vec2 p = vW.xz;
    float dunes  = fbm(p * 0.0042);
    float drift  = fbm(p * 0.021 + 11.0);
    float ripple = vnoise(p * vec2(1.35, 0.42) + 3.0) * near;

    // Sand, from shadowed dune flank to sunlit crest.
    vec3 sandLow  = vec3(0.255, 0.172, 0.108);
    vec3 sandHigh = vec3(0.520, 0.400, 0.268);
    vec3 albedo = mix(sandLow, sandHigh, clamp(dunes * 0.75 + drift * 0.45, 0.0, 1.0));

    // Salt flats — pale, hard, and much less rough than the sand around them.
    float sabkha = smoothstep(0.60, 0.78, fbm(p * 0.0031 + 41.0));
    albedo = mix(albedo, vec3(0.610, 0.575, 0.512), sabkha * 0.75);

    albedo *= 0.94 + ripple * 0.12;

    float rough = mix(0.94, 0.72, sabkha);
    vec3 N = normalize(vec3(
      (fbm(p * 0.021 + vec2(0.7, 0.0)) - drift) * 1.4 * near,
      1.0,
      (fbm(p * 0.021 + vec2(0.0, 0.7)) - drift) * 1.4 * near
    ));

    Surface s = makeSurface(albedo, 0.0, filterRoughness(N, rough), N, V);
    vec3 R = reflect(V, N);
    vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
    col += shadeDirect(s, uSunDir, vec3(3.4, 1.5, 0.55));

    // Dust. Deliberately heavy and reaching in close: the ground has to arrive
    // at the horizon already the colour of the sky, or the plane's far edge
    // draws a hard line across the base of the skyline.
    float fog = smoothstep(uFogNear, uFogFar, dist);
    vec3 fogCol = skyRadiance(normalize(vec3(V.x, 0.02, V.z)), uSunDir);
    col = mix(col, fogCol, pow(fog, 0.72));

    outColor = vec4(col, 1.0);
  }
`;

export class Desert {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.RawShaderMaterial;

  constructor(centre: THREE.Vector3, extent = 26000) {
    this.material = new THREE.RawShaderMaterial({
      name: 'desert',
      glslVersion: THREE.GLSL3,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: SUN_DIR.clone() },
        uFogNear: { value: 260 },
        uFogFar: { value: 3400 },
      },
      vertexShader: DESERT_VERT,
      fragmentShader: DESERT_FRAG,
    });

    // A single quad. It is shaded entirely from world XZ, so subdividing it buys
    // nothing — there is no vertex-level displacement to carry.
    const geo = new THREE.PlaneGeometry(extent, extent, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    // Below the verge's outer edge (-0.55) so the road ribbon always wins, and
    // far enough below that a grazing view cannot make the two z-fight.
    this.mesh.position.set(centre.x, -0.72, centre.z);
    this.mesh.frustumCulled = false;
    // Ground this large under a 5-degree sun would otherwise be the biggest
    // caster in the scene, and it has nothing to cast.
    this.mesh.userData.noShadow = true;
    this.mesh.renderOrder = -10;
  }

  update(cameraPos: THREE.Vector3) {
    (this.material.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
  }
}
