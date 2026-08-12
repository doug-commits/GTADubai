import * as THREE from 'three';
import { makeGlowMaterial } from '../game/vehicle-shader';
import type { Corridor } from './corridor';
import { ROAD_HALF_WIDTH } from './corridor';

/**
 * The Love Mukbang branch at Dubai World Trade Centre — the thing the whole run
 * is aimed at. It has to be visible from a long way out so the player has
 * something to drive *at*, so it is lit far brighter than anything around it
 * and sits inside the bloom threshold from several hundred metres away.
 *
 * ASSET SLOT: `public/assets/storefront/sign.webp` replaces the procedural sign.
 */
export class Storefront {
  readonly group = new THREE.Group();

  constructor(corridor: Corridor) {
    const p = corridor.path.sample(corridor.finishS);
    const side = 1; // driver's right
    const off = ROAD_HALF_WIDTH + 26;

    const originX = p.x + p.nx * off * side;
    const originZ = p.z + p.nz * off * side;
    const heading = p.heading;

    const root = new THREE.Group();
    root.position.set(originX, 0, originZ);
    root.rotation.y = heading;
    this.group.add(root);

    // --- building shell ---------------------------------------------------
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(46, 17, 26),
      new THREE.MeshBasicMaterial({ color: 0x120c0d }),
    );
    shell.position.set(0, 8.5, 0);
    root.add(shell);

    // --- warm window wall facing the road ---------------------------------
    const glowMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        in vec3 position; in vec2 uv;
        uniform mat4 modelViewMatrix, projectionMatrix;
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
          precision highp sampler2D;
        in vec2 vUv; out vec4 outColor;
        uniform float uTime;
        void main() {
          // Warm interior spill, brighter at the base where the tables are.
          float v = smoothstep(1.0, 0.05, vUv.y);
          vec3 warm = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.78, 0.42), v);
          // Silhouettes of a full table moving behind the glass.
          float people = 0.0;
          for (int i = 0; i < 6; i++) {
            float fx = 0.12 + float(i) * 0.15 + sin(uTime * 0.6 + float(i)) * 0.012;
            people += smoothstep(0.055, 0.0, abs(vUv.x - fx)) * smoothstep(0.52, 0.10, vUv.y);
          }
          vec3 col = warm * (0.85 + v * 1.5);
          col *= 1.0 - clamp(people, 0.0, 1.0) * 0.75;
          outColor = vec4(col * 1.6, 0.95);
        }
      `,
    });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(42, 8.4), glowMat);
    win.position.set(0, 4.6, -13.2);
    win.rotation.y = Math.PI;
    root.add(win);

    // --- sign -------------------------------------------------------------
    const signMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, tSign: { value: null }, uHasSign: { value: 0 } },
      vertexShader: /* glsl */ `
        in vec3 position; in vec2 uv;
        uniform mat4 modelViewMatrix, projectionMatrix;
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
          precision highp sampler2D;
        in vec2 vUv; out vec4 outColor;
        uniform float uTime; uniform sampler2D tSign; uniform float uHasSign;
        void main() {
          if (uHasSign > 0.5) {
            vec4 t = texture(tSign, vUv);
            outColor = vec4(t.rgb * 3.0, t.a);
            return;
          }
          // Procedural neon bar: a hot gold band with a soft halo and a slow
          // sign-tube flicker. Stands in until the client's wordmark lands.
          float band = smoothstep(0.30, 0.42, vUv.y) * smoothstep(0.72, 0.60, vUv.y);
          float edge = smoothstep(0.02, 0.10, vUv.x) * smoothstep(0.98, 0.90, vUv.x);
          float flick = 0.93 + 0.07 * sin(uTime * 31.0) * step(0.5, fract(uTime * 0.17));
          float halo = smoothstep(0.95, 0.0, abs(vUv.y - 0.5) * 2.2);
          vec3 gold = vec3(1.0, 0.72, 0.25);
          vec3 col = gold * (band * edge * 5.0 + halo * 0.7) * flick;
          outColor = vec4(col, clamp(band * edge + halo * 0.35, 0.0, 1.0));
        }
      `,
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(30, 6.5), signMat);
    sign.position.set(0, 14.2, -13.4);
    sign.rotation.y = Math.PI;
    sign.renderOrder = 12;
    root.add(sign);

    new THREE.TextureLoader().load(
      'assets/storefront/sign.webp',
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        signMat.uniforms.tSign.value = tex;
        signMat.uniforms.uHasSign.value = 1;
      },
      undefined,
      () => {
        /* procedural neon stands in */
      },
    );

    // --- light spill onto the road ----------------------------------------
    const pool = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      makeGlowMaterial(new THREE.Color(1.0, 0.62, 0.26), 1.6, 1.1, true),
      1,
    );
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(0, 0.07, -24),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
      new THREE.Vector3(58, 44, 1),
    );
    pool.setMatrixAt(0, m);
    pool.instanceMatrix.needsUpdate = true;
    pool.geometry.setAttribute(
      'aTint',
      new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1, 1]), 4),
    );
    pool.frustumCulled = false;
    pool.renderOrder = 6;
    root.add(pool);

    this.materials = [glowMat, signMat];
  }

  private materials: THREE.RawShaderMaterial[];

  update(time: number) {
    for (const m of this.materials) m.uniforms.uTime.value = time;
  }
}

/** Overhead gantry that frames the finish line. */
export function makeFinishGantry(corridor: Corridor): THREE.Object3D {
  const g = new THREE.Group();
  const p = corridor.path.sample(corridor.finishS);
  const mat = new THREE.MeshBasicMaterial({ color: 0x0b0809 });
  const span = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF_WIDTH * 2 + 8, 1.5, 1.0), mat);
  span.position.set(p.x, 9.4, p.z);
  span.rotation.y = p.heading;
  g.add(span);

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 9.4, 0.9), mat);
    const off = (ROAD_HALF_WIDTH + 3) * side;
    leg.position.set(p.x + p.nx * off, 4.7, p.z + p.nz * off);
    leg.rotation.y = p.heading;
    g.add(leg);
  }

  const glow = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    makeGlowMaterial(new THREE.Color(1.0, 0.72, 0.28), 2.0, 2.6),
    2,
  );
  const m = new THREE.Matrix4();
  [-1, 1].forEach((side, i) => {
    const off = ROAD_HALF_WIDTH * 0.55 * side;
    m.compose(
      new THREE.Vector3(p.x + p.nx * off, 9.4, p.z + p.nz * off),
      new THREE.Quaternion(),
      new THREE.Vector3(6, 6, 6),
    );
    glow.setMatrixAt(i, m);
  });
  glow.instanceMatrix.needsUpdate = true;
  glow.geometry.setAttribute(
    'aTint',
    new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]), 4),
  );
  glow.frustumCulled = false;
  glow.renderOrder = 10;
  g.add(glow);
  return g;
}
