import * as THREE from 'three';
import { vehicleUniforms, makeGlowMaterial } from './vehicle-shader';
import { buildPlayerCar } from './models/vehicles';
import { SKY_GLSL } from '../render/sky';
import { PBR_GLSL, SKY_IBL_GLSL } from '../render/pbr';
import { ROAD_HALF_WIDTH } from '../world/corridor';
import type { CenterlinePath, PathSample } from '../world/path';

/**
 * Player car.
 *
 * The simulation lives entirely in path space — `s` metres along the corridor,
 * `t` metres to the right of the centreline — and is converted to world
 * transform only for rendering. Handling is deliberately arcade: high grip,
 * generous slip, no stalling and no reverse. The player should be able to steer
 * competently within one second of first touching the screen.
 */

export const MAX_SPEED = 76; // m/s ≈ 274 km/h
export const BOOST_SPEED = 98; // m/s ≈ 353 km/h
const LIMIT = ROAD_HALF_WIDTH + 1.4;

/** Shared object-space vertex shader for every part of the car. */
const CAR_VERT = /* glsl */ `
  in vec3 position;
  in vec3 normal;
  uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
  out vec3 vN; out vec3 vW; out vec3 vL;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    // Car-local metres. The bonnet panel work needs to know where on the car it
    // is standing, and only the local frame survives the car turning.
    vL = position;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export interface CarInput {
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** Brake / lift, 0..1. */
  brake: number;
  boost: boolean;
}

export class Car {
  /** Arc length along the corridor, metres. */
  s = 0;
  /** Lateral offset from the centreline, metres (+ = right). */
  t = 0;
  /** Forward speed, m/s. */
  speed = 0;
  /** Lateral velocity, m/s. */
  vt = 0;
  /** Yaw relative to the path tangent, radians. */
  yaw = 0;
  /** Visual body roll and pitch. */
  roll = 0;
  pitch = 0;
  /** 0..1 how sideways the car is — drives skid audio and tyre smoke. */
  slip = 0;
  /** Engine revs 0..1, resets on each simulated gear change. */
  rpm = 0;
  gear = 1;
  /** Seconds of crash lockout remaining. */
  stun = 0;

  readonly group = new THREE.Group();
  private bodyMat: THREE.RawShaderMaterial;
  private wheels: THREE.Object3D[] = [];
  private extraMats: THREE.RawShaderMaterial[] = [];
  private tailMat: THREE.RawShaderMaterial | null = null;
  private beam: THREE.InstancedMesh;
  /** Windscreen and side glass. Hidden when the camera sits behind it. */
  private glass: THREE.Mesh | null = null;

  constructor() {
    this.bodyMat = new THREE.RawShaderMaterial({
      name: 'car-body',
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...vehicleUniforms(),
        uColor: { value: new THREE.Color(0.54, 0.036, 0.014) }, // ember red basecoat
      },
      vertexShader: CAR_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp int;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW; in vec3 vL;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir, uColor;
        uniform float uFogNear, uFogFar;
        ${SKY_GLSL}
        ${PBR_GLSL}
        ${SKY_IBL_GLSL}

        /**
         * Bonnet panel work.
         *
         * From the driver's seat the bonnet is the single largest object in the
         * frame, and a car bonnet at dusk is physically a mirror aimed at the
         * brightest band of the sky — so it arrives as one flat bright plate
         * with no information in it at all. Panel lines are what make it read as
         * a car rather than as a lens flare: the shut lines where the bonnet
         * meets the wings, and the centre power crease down the middle.
         *
         * Returns a normal perturbation in local space and a darkening factor.
         */
        void bonnetPanels(vec3 L, inout vec3 N, out float shade) {
          shade = 1.0;
          // Bonnet only: forward of the screen base, above the shoulder line.
          float onBonnet = smoothstep(-0.42, -0.60, L.z) * smoothstep(0.60, 0.74, L.y);
          if (onBonnet < 0.01) return;

          // Shut lines: two longitudinal gaps where the panel meets the wings,
          // plus the transverse gap at the leading edge.
          float shutX = min(abs(abs(L.x) - 0.585), abs(abs(L.x) - 0.0));
          float lineX = 1.0 - smoothstep(0.006, 0.022, abs(abs(L.x) - 0.585));
          float lineZ = 1.0 - smoothstep(0.008, 0.026, abs(L.z + 1.93));

          // Centre power crease: a shallow ridge, not a cut.
          float crease = exp(-pow(L.x / 0.115, 2.0));

          float cut = max(lineX, lineZ) * onBonnet;
          shade = 1.0 - cut * 0.72;

          // Tilt the surface away from each shut line and up over the crease.
          N.x += sign(L.x) * lineX * onBonnet * 0.55;
          N.z += sign(L.z + 1.93) * lineZ * onBonnet * 0.55;
          N.y += crease * onBonnet * 0.10;
          N.x -= sign(L.x) * crease * onBonnet * 0.16;
          N = normalize(N);
        }

        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);

          float panelShade;
          bonnetPanels(vL, N, panelShade);

          // SATIN WRAP, not gloss lacquer — and the reason is the camera.
          //
          // Gloss paint is a mirror, and from the driver's seat the bonnet is a
          // near-horizontal mirror filling the bottom fifth of the frame. At
          // grazing incidence its Fresnel term goes to one, so whatever the
          // basecoat is underneath, what the player sees is the brightest band
          // of the sky reflected at full strength: a red car rendering as a
          // white plate, and the single brightest object in the game sitting
          // directly under the part of the screen they need to read.
          //
          // A satin wrap solves it at the surface rather than in the grade. It
          // is also the most common finish on this road by a distance, so the
          // physically-motivated fix and the locally-accurate one agree.
          Surface s = makeSurface(uColor * panelShade, 0.18, filterRoughness(N, 0.46), N, V);
          s.clearcoat = 0.30;
          s.clearcoatRoughness = 0.24;

          vec3 R = reflect(V, N);
          vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
          col += shadeDirect(s, uSunDir, vec3(3.4, 1.5, 0.55));
          col *= panelShade;

          float fog = smoothstep(uFogNear, uFogFar, length(vW - uCameraPos));
          col = aerial(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });

    this.buildMesh();
    this.beam = this.buildLightPool();
  }

  /**
   * Real coupé geometry from `models/vehicles.ts` — tapered greenhouse, wheel
   * arches cut into the flanks, recessed light lenses. The hero car is on
   * screen for the entire run, so it is the one place where silhouette is
   * worth spending on.
   */
  private buildMesh() {
    const parts = buildPlayerCar();

    const glassMat = this.makeGlassMaterial();
    const trimMat = this.makeTrimMaterial();

    this.group.add(new THREE.Mesh(parts.body, this.bodyMat));
    this.glass = new THREE.Mesh(parts.glass, glassMat);
    this.group.add(this.glass);
    this.group.add(new THREE.Mesh(parts.trim, trimMat));

    // Tyres were flat 0x07060a — black rubber on black tarmac, so the wheels
    // were present but invisible and the car read as a floating lozenge.
    // Rubber is dark but not unlit: it has a broad sheen that catches skylight
    // along the shoulder of the tyre, and that highlight is what makes a wheel
    // read as round.
    const tyre = this.makeTyreMaterial();
    for (const wp of parts.wheelPositions) {
      const w = new THREE.Mesh(parts.wheel, tyre);
      w.position.copy(wp);
      this.group.add(w);
      this.wheels.push(w);
    }

    // Light lenses are real geometry set into the body, so they catch the
    // silhouette rather than floating as decals.
    const head = new THREE.Mesh(parts.lightsFront, this.makeLensMaterial(new THREE.Color(1.0, 0.88, 0.70), 3.2));
    head.renderOrder = 9;
    this.group.add(head);

    this.tailMat = this.makeLensMaterial(new THREE.Color(1.0, 0.10, 0.05), 2.2);
    const tail = new THREE.Mesh(parts.lightsRear, this.tailMat);
    tail.renderOrder = 9;
    this.group.add(tail);

    this.buildContactShadow(parts.size);
  }

  private makeGlassMaterial() {
    const m = new THREE.RawShaderMaterial({
      name: 'car-glass',
      glslVersion: THREE.GLSL3,
      uniforms: { ...vehicleUniforms() },
      vertexShader: CAR_VERT,
      fragmentShader: `
        precision highp float;
        precision highp int;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir;
        uniform float uFogNear, uFogFar;
        ${SKY_GLSL}
        ${PBR_GLSL}
        ${SKY_IBL_GLSL}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          // Tinted glass: almost no diffuse, a tight specular, strong mirror.
          Surface s = makeSurface(vec3(0.008, 0.010, 0.016), 0.0, 0.055, N, V);
          vec3 R = reflect(V, N);
          vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
          col += shadeDirect(s, uSunDir, vec3(3.4, 1.5, 0.55));
          float fog = smoothstep(uFogNear, uFogFar, length(vW - uCameraPos));
          col = aerial(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });
    this.extraMats.push(m);
    return m;
  }

  private makeTrimMaterial() {
    const m = new THREE.RawShaderMaterial({
      name: 'car-trim',
      glslVersion: THREE.GLSL3,
      uniforms: { ...vehicleUniforms() },
      vertexShader: CAR_VERT,
      fragmentShader: `
        precision highp float;
        precision highp int;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir;
        uniform float uFogNear, uFogFar;
        ${SKY_GLSL}
        ${PBR_GLSL}
        ${SKY_IBL_GLSL}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          // Satin black plastic and dark anodised metal.
          Surface s = makeSurface(vec3(0.022, 0.021, 0.023), 0.25, filterRoughness(N, 0.45), N, V);
          vec3 R = reflect(V, N);
          vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
          col += shadeDirect(s, uSunDir, vec3(3.4, 1.5, 0.55));
          float fog = smoothstep(uFogNear, uFogFar, length(vW - uCameraPos));
          col = aerial(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });
    this.extraMats.push(m);
    return m;
  }

  private makeTyreMaterial() {
    const m = new THREE.RawShaderMaterial({
      name: 'car-tyre',
      glslVersion: THREE.GLSL3,
      uniforms: { ...vehicleUniforms() },
      vertexShader: CAR_VERT,
      fragmentShader: `
        precision highp float;
        precision highp int;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir;
        uniform float uFogNear, uFogFar;
        ${SKY_GLSL}
        ${PBR_GLSL}
        ${SKY_IBL_GLSL}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          Surface s = makeSurface(vec3(0.014, 0.013, 0.015), 0.0, filterRoughness(N, 0.58), N, V);
          vec3 R = reflect(V, N);
          vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
          col += shadeDirect(s, uSunDir, vec3(3.4, 1.5, 0.55));
          float fog = smoothstep(uFogNear, uFogFar, length(vW - uCameraPos));
          col = aerial(col, vW, uCameraPos, uSunDir, uFogNear, uFogFar);
          outColor = vec4(col, 1.0);
        }
      `,
    });
    this.extraMats.push(m);
    return m;
  }

  /**
   * Ambient-occlusion contact patch under the car.
   *
   * Without it the car floats: the eye needs a dark ground contact to place an
   * object on a surface, and there are no shadow maps in this renderer.
   */
  private buildContactShadow(size: THREE.Vector3) {
    const mat = new THREE.RawShaderMaterial({
      name: 'car-contact',
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {},
      vertexShader: `
        in vec3 position; in vec2 uv;
        uniform mat4 modelViewMatrix, projectionMatrix;
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        precision highp float;
        in vec2 vUv; out vec4 outColor;
        void main() {
          vec2 d = (vUv - 0.5) * 2.0;
          // Elongated along the car, tightest right under the sills.
          float r = length(vec2(d.x * 1.25, d.y * 0.85));
          float a = pow(clamp(1.0 - r, 0.0, 1.0), 1.9);
          outColor = vec4(0.0, 0.0, 0.0, a * 0.62);
        }
      `,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.x * 1.7, size.z * 1.25), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.03;
    mesh.renderOrder = 5;
    this.group.add(mesh);
  }

  /** Emissive lens: bright core, falls off toward the lens edge. */
  private makeLensMaterial(color: THREE.Color, gain: number) {
    const m = new THREE.RawShaderMaterial({
      name: 'car-lens',
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...vehicleUniforms(),
        uColor: { value: color },
        uGain: { value: gain },
        uBrake: { value: 0 },
      },
      vertexShader: CAR_VERT,
      fragmentShader: `
        precision highp float;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW;
        out vec4 outColor;
        uniform vec3 uCameraPos, uColor;
        uniform float uGain, uBrake;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          // Face-on lenses read brightest, exactly like a real reflector.
          float facing = pow(max(dot(-V, N), 0.0), 0.6);
          outColor = vec4(uColor * uGain * (0.45 + facing) * (1.0 + uBrake), 1.0);
        }
      `,
    });
    this.extraMats.push(m);
    return m;
  }

  /** Soft headlight wash thrown forward onto the tarmac. */
  private buildLightPool(): THREE.InstancedMesh {
    const mat = makeGlowMaterial(new THREE.Color(1.0, 0.82, 0.60), 3.2, 0.34, true);
    const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, 1);
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
      new THREE.Vector3(9, 26, 1),
    );
    pool.setMatrixAt(0, m);
    pool.instanceMatrix.needsUpdate = true;
    pool.geometry.setAttribute(
      'aTint',
      new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1, 1]), 4),
    );
    pool.position.set(0, 0.06, -13);
    pool.frustumCulled = false;
    pool.renderOrder = 6;
    this.group.add(pool);
    return pool;
  }

  /**
   * From the driver's seat the camera is behind the windscreen, and a tinted
   * front-facing pane between the eye and the road turns the whole view murky.
   * The rest of the shell stays — it is what casts the car's shadow, and the
   * bonnet ahead of the screen is half the reason to sit here.
   */
  setInteriorMode(on: boolean) {
    if (this.glass) this.glass.visible = !on;
  }

  reset() {
    this.s = 0;
    this.t = 0;
    this.speed = 26;
    this.vt = 0;
    this.yaw = 0;
    this.roll = 0;
    this.pitch = 0;
    this.slip = 0;
    this.rpm = 0.3;
    this.gear = 1;
    this.stun = 0;
  }

  /** Head-on impact: kill most of the speed and lock control briefly. */
  crash(severity = 1) {
    this.speed *= 0.30 / severity;
    this.vt *= -0.35;
    this.stun = Math.min(0.85, 0.42 * severity);
  }

  /** Glancing contact with a barrier — scrub speed, push back onto the road. */
  graze(dir: number) {
    this.speed *= 0.965;
    this.vt = -dir * Math.abs(this.vt) * 0.4 - dir * 3.2;
    this.slip = Math.min(1, this.slip + 0.35);
  }

  update(dt: number, input: CarInput, path: CenterlinePath, sample: PathSample) {
    const stunned = this.stun > 0;
    if (stunned) this.stun -= dt;

    const steer = stunned ? 0 : THREE.MathUtils.clamp(input.steer, -1, 1);
    const boosting = input.boost && !stunned;
    const target = boosting ? BOOST_SPEED : MAX_SPEED;

    // --- longitudinal ------------------------------------------------------
    // Torque falls off with speed so acceleration feels strong off the line and
    // asymptotic near the top — you never quite reach the number on the dial.
    const headroom = Math.max(0, 1 - this.speed / target);
    const drive = stunned ? 0 : (18 + 26 * headroom) * (boosting ? 1.5 : 1);
    const drag = 0.0026 * this.speed * this.speed;
    const braking = input.brake * 34;
    this.speed += (drive - drag - braking) * dt;
    // Cornering scrub: hard steering at speed bleeds momentum.
    this.speed -= Math.abs(steer) * this.speed * 0.10 * dt;
    this.speed = THREE.MathUtils.clamp(this.speed, 0, BOOST_SPEED * 1.05);

    // --- lateral -----------------------------------------------------------
    const speed01 = this.speed / MAX_SPEED;
    // Steering authority tapers with speed — otherwise the car twitches at 300 km/h.
    const authority = 26 * (1 - 0.42 * Math.min(1, speed01));
    this.vt += steer * authority * dt;

    // Centrifugal push through the corridor's real curves.
    this.vt += sample.curvature * this.speed * this.speed * 0.055 * dt;

    // Grip: lateral velocity decays fast when going straight, slower when the
    // player is holding a steering input — that gap is what feels like a slide.
    const grip = 5.0 - Math.abs(steer) * 2.1;
    this.vt -= this.vt * grip * dt;
    this.t += this.vt * dt;

    // --- barriers ----------------------------------------------------------
    if (this.t > LIMIT) {
      this.t = LIMIT;
      this.graze(1);
    } else if (this.t < -LIMIT) {
      this.t = -LIMIT;
      this.graze(-1);
    }

    this.s += this.speed * dt;

    // --- feel --------------------------------------------------------------
    this.slip = THREE.MathUtils.damp(this.slip, Math.min(1, Math.abs(this.vt) / 13), 7, dt);
    const targetYaw = Math.atan2(this.vt, Math.max(this.speed, 8)) * 1.45;
    this.yaw = THREE.MathUtils.damp(this.yaw, targetYaw, 12, dt);
    this.roll = THREE.MathUtils.damp(this.roll, -steer * 0.085 - this.vt * 0.006, 8, dt);
    this.pitch = THREE.MathUtils.damp(this.pitch, -input.brake * 0.05 + (boosting ? 0.028 : 0), 6, dt);

    // Simulated 6-speed: rpm sweeps within each gear and drops on the shift.
    const gears = [0.16, 0.3, 0.46, 0.63, 0.82, 1.0];
    let g = 0;
    while (g < gears.length - 1 && this.speed / BOOST_SPEED > gears[g]) g++;
    this.gear = g + 1;
    const lo = g === 0 ? 0 : gears[g - 1];
    const hi = gears[g];
    this.rpm = THREE.MathUtils.clamp((this.speed / BOOST_SPEED - lo) / Math.max(hi - lo, 1e-3), 0.08, 1);
  }

  /** Push the simulated state onto the scene graph. */
  syncTransform(path: CenterlinePath, sample: PathSample, time: number) {
    this.group.position.set(sample.x + sample.nx * this.t, 0, sample.z + sample.nz * this.t);
    this.group.rotation.set(this.pitch, sample.heading + this.yaw, this.roll, 'YXZ');

    const spin = time * this.speed * 0.6;
    for (const w of this.wheels) w.rotation.x = spin;

    // Brake lights come up under braking / lift.
    if (this.tailMat) this.tailMat.uniforms.uBrake.value = this.stun > 0 ? 1.0 : 0.0;
  }

  setCameraUniforms(cameraPos: THREE.Vector3, time: number) {
    (this.bodyMat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
    this.bodyMat.uniforms.uTime.value = time;
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.RawShaderMaterial | undefined;
      if (m?.uniforms?.uCameraPos) (m.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
      if (m?.uniforms?.uTime) m.uniforms.uTime.value = time;
    });
  }
}
