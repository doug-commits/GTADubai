import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SKY_GLSL, SUN_DIR } from '../render/sky';
import { PBR_GLSL, SKY_IBL_GLSL } from '../render/pbr';

/**
 * ============================================================================
 *  COCKPIT — the driver's-eye interior, for the FPV camera
 * ============================================================================
 *
 *  Only ever seen from one place: a seated eye point roughly 0.2 m behind the
 *  wheel. Everything here is built for that single viewpoint and nothing else,
 *  which is what keeps it to two draw calls.
 *
 *  Car-local space, matching `models/vehicles.ts`:
 *    -Z is forward (nose at z = -2.19), +Y up, origin on the ground at the
 *    car's centre. The UAE drives on the right, so the driver sits on the LEFT
 *    at x = DRIVER_X.
 *
 *  What is actually on screen at a portrait phone's ~37 degrees of horizontal
 *  FOV is: the dash top, the binnacle, and the upper arc of the wheel. The
 *  pillars, mirrors and door tops sit outside that cone and only pay off in
 *  landscape — they are cheap enough to keep for it.
 * ============================================================================
 */

/**
 * Eye point. These three numbers set the entire framing of the game, so they
 * are tuned against real captured frames rather than against a seating buck:
 * on a portrait phone the interior must cost about 15 % of the screen and the
 * bonnet about 13 %, leaving the road and the skyline the other 70 %.
 */
/** Lateral offset of the driver's seat, metres. Negative = left-hand drive. */
export const DRIVER_X = -0.34;
/** Seated eye height above the road, metres. */
export const EYE_Y = 1.24;
/** Eye position along the car, metres. Just behind the screen header. */
export const EYE_Z = -0.05;

const box = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx);
  g.rotateY(ry);
  g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
};

/**
 * Interior shell.
 *
 * The dash is built as a shallow arc of short segments rather than one slab:
 * a straight dash edge cutting across a phone screen reads as a black bar, and
 * the curve is what makes it read as moulded.
 */
function buildDash(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];

  const SEGS = 13;
  const HALF = 0.76;
  for (let i = 0; i < SEGS; i++) {
    const u = (i + 0.5) / SEGS;
    const x = (u - 0.5) * 2 * HALF;
    // Sweep back at the edges — the dash wraps toward the door cards.
    const z = -0.40 + Math.pow(Math.abs(x) / HALF, 2.0) * 0.30;
    // and rises a little toward the centre stack.
    const y = 1.055 - Math.pow(Math.abs(x) / HALF, 2.2) * 0.045;
    parts.push(box((2 * HALF) / SEGS + 0.010, 0.30, 0.34, x, y - 0.15, z + 0.04, -0.16));
  }

  // Dash top lip: the crease that catches the last of the sun.
  for (let i = 0; i < SEGS; i++) {
    const u = (i + 0.5) / SEGS;
    const x = (u - 0.5) * 2 * HALF;
    const z = -0.46 + Math.pow(Math.abs(x) / HALF, 2.0) * 0.30;
    const y = 1.065 - Math.pow(Math.abs(x) / HALF, 2.2) * 0.045;
    parts.push(box((2 * HALF) / SEGS + 0.008, 0.035, 0.16, x, y, z, -0.30));
  }

  return parts;
}

/**
 * NO RAISED BINNACLE — and this is the load-bearing decision in the file.
 *
 * A hooded instrument pod is the obvious thing to model, and it cannot work
 * here. Anything that stands proud of the dash lip is, by construction, in the
 * band of the frame between the lip and the horizon — which is the band the
 * road and the traffic live in. A pod tall enough to read as a pod put its rear
 * edge within 7 mm of eye level and walled off every pixel below the skyline.
 *
 * The interior therefore ends at the dash lip. Speed, revs and boost are on the
 * HUD already; a second copy of them modelled in 3D is not worth the road.
 */

/**
 * Three-spoke wheel, flat-bottomed.
 *
 * A torus, not a ring of chord boxes. The chorded version fell apart from this
 * viewpoint: the eye looks DOWN onto the rim rather than through it, so what
 * showed was the top face of every chord with a gap between each — a row of
 * black tiles instead of a wheel.
 */
function buildWheel(): { rim: THREE.BufferGeometry[]; boss: THREE.BufferGeometry[] } {
  const R = 0.145;
  const rim: THREE.BufferGeometry[] = [];

  const torus = new THREE.TorusGeometry(R, 0.013, 6, 30);
  // Flat-bottomed: squash the lower arc in toward the hub. Correct for a modern
  // wheel, and it keeps the bottom of the rim clear of the road ahead.
  const pos = torus.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0) pos.setY(i, y * 0.80);
  }
  torus.computeVertexNormals();
  rim.push(torus);

  // Spokes at 9, 3 and 6 o'clock.
  for (const a of [Math.PI, 0, -Math.PI / 2]) {
    const g = new THREE.BoxGeometry(R * 0.88, 0.026, 0.020);
    g.rotateZ(a);
    g.translate((Math.cos(a) * R) / 2, (Math.sin(a) * R) / 2, 0.004);
    rim.push(g);
  }

  const boss = [new THREE.BoxGeometry(0.090, 0.058, 0.028)];
  return { rim, boss };
}

/**
 * Pillars and mirror pods.
 *
 * NOTHING here may sit at or behind EYE_Z. This car's cabin is 0.73 m long, so
 * the screen header, the rear-view mirror and the door tops all fall level with
 * the driver's eye or behind it — a 1.3 m bar straddling the near plane, which
 * renders as a black wall across the whole frame rather than as a windscreen
 * surround. They are gone rather than fudged: a header the eye is already past
 * is not a header.
 */
function buildFrame(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];

  // A-pillars. Raked back with the screen, well forward of the eye.
  for (const s of [-1, 1]) {
    parts.push(box(0.085, 0.42, 0.10, s * 0.60, 1.14, -0.40, 0.62, 0, s * 0.20));
  }

  // Wing mirrors, out at the leading edge of the door.
  for (const s of [-1, 1]) {
    parts.push(box(0.050, 0.028, 0.13, s * 0.70, 1.035, -0.46));
    parts.push(box(0.070, 0.105, 0.145, s * 0.775, 1.052, -0.50, 0, s * 0.22));
  }

  return parts;
}

const COCKPIT_VERT = /* glsl */ `
  in vec3 position; in vec3 normal;
  uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
  out vec3 vN; out vec3 vW; out vec3 vL;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vL = position;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Interior surfaces.
 *
 * The whole point of an interior in a dusk scene is that it is the darkest
 * thing in frame — it is the frame. But a surface that tonemaps to pure black
 * reads as a hole, so this leans on two things instead of brightness: a broad
 * sky term that keeps the dash top a shade above the road, and a hard fresnel
 * rim that draws every edge. The result silhouettes against the road without
 * ever competing with it.
 */
const COCKPIT_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  in vec3 vN; in vec3 vW; in vec3 vL;
  out vec4 outColor;
  uniform vec3 uCameraPos, uSunDir;
  uniform float uTime;
  ${SKY_GLSL}
  ${PBR_GLSL}
  ${SKY_IBL_GLSL}

  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(vW - uCameraPos);

    // Grained anthracite leather over the top surfaces, harder plastic below.
    float up = clamp(N.y, 0.0, 1.0);
    vec3 albedo = mix(vec3(0.013, 0.012, 0.014), vec3(0.024, 0.022, 0.021), up);
    float rough = filterRoughness(N, mix(0.76, 0.58, up));

    Surface s = makeSurface(albedo, 0.10, rough, N, V);
    vec3 R = reflect(V, N);

    // CABIN OCCLUSION. The interior is not standing in the open under the full
    // sky — it is under a roof, behind a screen, inside a box. Shading it with
    // the unoccluded sky hemisphere is what turned the dash pale beige the
    // moment the sky went bright: an up-facing surface was collecting the whole
    // dome. This constant is the cabin's own aperture, and it is small.
    const float CABIN_AO = 0.26;
    vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir) * CABIN_AO,
                        skyPrefiltered(R, s.roughness, uSunDir) * CABIN_AO);
    col += shadeDirect(s, uSunDir, vec3(3.4, 1.5, 0.55)) * 0.22;

    // Windscreen light: everything in here is lit through the glass ahead, so
    // the forward-facing surfaces catch the sky and the rearward ones do not.
    float screen = clamp(-N.z, 0.0, 1.0);
    col += skyRadiance(normalize(vec3(uSunDir.x, 0.12, uSunDir.z)), uSunDir) * screen * 0.055;

    // Edge rim. Without this the interior is one undifferentiated mass.
    float fres = pow(1.0 - max(dot(-V, N), 0.0), 3.0);
    col += vec3(1.00, 0.72, 0.42) * fres * 0.20;
    col += vec3(0.26, 0.34, 0.62) * fres * 0.10;

    outColor = vec4(col, 1.0);
  }
`;

/**
 * Ambient dash strip — the one warm source inside the car.
 *
 * A thin light line washing the top of the dash, which is both a real fitting
 * in this class of car and the cheapest way to stop the interior reading as a
 * black bar. It lies FLAT along the lip rather than standing up from it, so it
 * costs nothing from the road's share of the frame. Brightens with revs.
 */
const STRIP_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform float uTime;
  uniform float uRpm;    // 0..1
  uniform vec3  uColor;

  void main() {
    // Soft across the width of the strip, tapered away at both ends so it does
    // not terminate in a hard rectangle at the edge of the screen.
    float across = smoothstep(0.0, 0.42, vUv.y) * smoothstep(1.0, 0.58, vUv.y);
    float along  = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);

    // A gentle travelling swell so it is not a dead line, plus a rev-linked lift
    // that shifts it toward red as the engine climbs.
    float swell = 0.86 + 0.14 * sin(uTime * 1.6 + vUv.x * 5.0);
    vec3 tint = mix(uColor, vec3(1.0, 0.30, 0.14), smoothstep(0.72, 1.0, uRpm));

    float a = across * along * swell * (0.55 + uRpm * 0.75);
    outColor = vec4(tint * a * 1.9, a);
  }
`;

export class Cockpit {
  readonly group = new THREE.Group();
  private materials: THREE.RawShaderMaterial[] = [];
  private wheel = new THREE.Group();
  private strip: THREE.RawShaderMaterial;
  /** Smoothed steering angle, so the wheel does not snap. */
  private wheelAngle = 0;

  constructor() {
    const shell = new THREE.RawShaderMaterial({
      name: 'cockpit',
      glslVersion: THREE.GLSL3,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: SUN_DIR.clone() },
        uTime: { value: 0 },
      },
      vertexShader: COCKPIT_VERT,
      fragmentShader: COCKPIT_FRAG,
    });
    this.materials.push(shell);

    const body = mergeGeometries([...buildDash(), ...buildFrame()], false);
    const bodyMesh = new THREE.Mesh(body, shell);
    // The interior never casts into the world — it would darken the bonnet and
    // the road ahead through geometry the player is sitting inside.
    bodyMesh.userData.noShadow = true;
    bodyMesh.frustumCulled = false;
    this.group.add(bodyMesh);

    // --- wheel ------------------------------------------------------------
    const w = buildWheel();
    const wheelMesh = new THREE.Mesh(mergeGeometries([...w.rim, ...w.boss], false), shell);
    wheelMesh.userData.noShadow = true;
    wheelMesh.frustumCulled = false;
    this.wheel.add(wheelMesh);
    // Column rake: about 22 degrees off vertical, seated low and well forward
    // so only the upper arc of the rim crosses the bottom of the frame. Any
    // higher and the wheel is a black bar across the road ahead.
    this.wheel.position.set(DRIVER_X, 0.912, -0.500);
    this.wheel.rotation.x = -0.42;
    this.group.add(this.wheel);

    // --- ambient dash strip -------------------------------------------------
    this.strip = new THREE.RawShaderMaterial({
      name: 'cockpit-strip',
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uRpm: { value: 0 },
        uColor: { value: new THREE.Color(1.0, 0.60, 0.22) },
      },
      vertexShader: /* glsl */ `
        in vec3 position; in vec2 uv;
        uniform mat4 modelViewMatrix, projectionMatrix;
        out vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: STRIP_FRAG,
    });
    // Laid flat on the dash top, just behind the lip.
    const stripMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.28, 0.062), this.strip);
    stripMesh.position.set(0, 1.086, -0.452);
    stripMesh.rotation.x = -Math.PI / 2 + 0.30;
    stripMesh.userData.noShadow = true;
    stripMesh.renderOrder = 12;
    stripMesh.frustumCulled = false;
    this.group.add(stripMesh);

    this.group.visible = false;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  /** `steer` is -1..1; `rpm01` drives the dash strip. */
  update(dt: number, steer: number, rpm01: number, time: number, cameraPos: THREE.Vector3) {
    // Two and a bit turns lock to lock, damped — a wheel that tracks the input
    // frame-for-frame looks like a slider, not like hands on a rim.
    const want = steer * 2.3;
    this.wheelAngle += (want - this.wheelAngle) * (1 - Math.exp(-dt * 11));
    this.wheel.rotation.z = -this.wheelAngle;

    this.strip.uniforms.uRpm.value = rpm01;
    this.strip.uniforms.uTime.value = time;
    for (const m of this.materials) {
      if (m.uniforms.uTime) m.uniforms.uTime.value = time;
      if (m.uniforms.uCameraPos) (m.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
    }
  }
}
