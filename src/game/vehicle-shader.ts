import * as THREE from 'three';
import { SKY_GLSL, SUN_DIR } from '../render/sky';

/**
 * Shared car-body shading, used by both the player car and the instanced
 * traffic. Car paint at dusk is almost entirely reflection: a dark base coat,
 * a broad sky term, a tight sun highlight and a strong fresnel rim. Getting
 * that balance right is what makes a box read as a car.
 */
export const VEHICLE_BODY_GLSL = /* glsl */ `
  ${SKY_GLSL}

  vec3 carPaint(vec3 N, vec3 V, vec3 baseColor, vec3 sunDir, float gloss, float metal) {
    vec3 R = reflect(V, N);
    vec3 sky = skyRadiance(normalize(R), sunDir);

    float fres = pow(1.0 - max(dot(-V, N), 0.0), 4.0);
    float ndl = max(dot(N, sunDir), 0.0);

    // Base coat: diffuse sun plus sky ambient from the hemisphere above.
    vec3 col = baseColor * (0.10 + ndl * 0.62);
    col += baseColor * skyRadiance(N, sunDir) * 0.30;

    // Clearcoat reflection.
    col = mix(col, sky, clamp((0.14 + fres * 0.80) * gloss, 0.0, 0.92) * (0.45 + metal * 0.55));

    // Tight specular from the low sun — the highlight that rakes along a flank.
    float spec = pow(max(dot(R, sunDir), 0.0), mix(24.0, 190.0, gloss));
    col += vec3(1.0, 0.62, 0.30) * spec * (0.8 + gloss * 2.4);

    // Cool rim from the opposite sky so the silhouette separates from the road.
    col += vec3(0.30, 0.42, 0.75) * fres * 0.30;
    return col;
  }
`;

export function vehicleUniforms(): Record<string, THREE.IUniform> {
  return {
    uCameraPos: { value: new THREE.Vector3() },
    uSunDir: { value: SUN_DIR.clone() },
    uTime: { value: 0 },
    uFogNear: { value: 320 },
    uFogFar: { value: 1500 },
  };
}

export const FOG_GLSL = /* glsl */ `
  vec3 applyFog(vec3 col, vec3 world, vec3 camPos, vec3 sunDir, float fogNear, float fogFar) {
    vec3 V = normalize(world - camPos);
    float dist = length(world - camPos);
    float f = smoothstep(fogNear, fogFar, dist);
    vec3 fogCol = skyRadiance(normalize(vec3(V.x, 0.03, V.z)), sunDir);
    return mix(col, fogCol, f);
  }
`;

/** Additive glow billboard — headlights, taillights, lamp haze, wet-road smears. */
export function makeGlowMaterial(color: THREE.Color, power = 2.6, gain = 2.2, stretch = false) {
  return new THREE.RawShaderMaterial({
    name: 'glow',
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: color },
      uPower: { value: power },
      uGain: { value: gain },
    },
    vertexShader: /* glsl */ `
      in vec3 position;
      in vec2 uv;
      in mat4 instanceMatrix;
      in vec4 aTint; // rgb = colour, a = intensity
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      out vec2 vUv;
      out vec4 vTint;
      void main() {
        vUv = uv;
        vTint = aTint;
        ${
          stretch
            ? // Ground-plane smear: keep the quad flat on the road.
              `gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);`
            : // Camera-facing billboard.
              `vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
               c.xy += position.xy * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
               gl_Position = projectionMatrix * c;`
        }
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec2 vUv;
      in vec4 vTint;
      out vec4 outColor;
      uniform vec3 uColor;
      uniform float uPower;
      uniform float uGain;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = pow(clamp(1.0 - d, 0.0, 1.0), uPower);
        vec3 c = uColor * vTint.rgb;
        outColor = vec4(c * a * uGain * vTint.a, a * vTint.a);
      }
    `,
  });
}
