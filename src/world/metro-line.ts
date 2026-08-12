import * as THREE from 'three';
import { buildMetro } from './metro';
import { buildPalm, buildLightMast, buildGantry, makePanelTexture } from './signage';
import { SKY_GLSL, SUN_DIR } from '../render/sky';
import { PBR_GLSL, SKY_IBL_GLSL } from '../render/pbr';
import type { Corridor } from './corridor';
import { ROAD_HALF_WIDTH } from './corridor';

/**
 * Everything that makes the corridor read as Sheikh Zayed Road specifically:
 * the elevated Metro viaduct down the median, its shell stations, the tall
 * UAE light masts, bilingual gantry signs and the date palms.
 *
 * All of it is instanced. `buildMetro` returns a straight run along +Z, so a
 * single short bay is repeated along the centreline with each instance taking
 * the local tangent — the corridor is near-straight, so the small kink at a
 * bend is invisible, and it costs one draw call instead of hundreds.
 */

const BAY = 30;

/**
 * Lateral offset of the Metro alignment from the road centreline, metres.
 *
 * The Red Line runs above the MEDIAN, between the two carriageways — it does
 * not run over the traffic. We model a single carriageway, so the median sits
 * off the driver's left (UAE drives on the right), and the viaduct goes there.
 * Placing it on the centreline plants a pier in the middle of the running
 * lanes, which is exactly what it did the first time.
 */
const METRO_OFFSET = -(ROAD_HALF_WIDTH + 13);

/** Position of the metro alignment at arc length s. */
function metroAt(corridor: Corridor, s: number) {
  const p = corridor.path.sample(s);
  return {
    x: p.x + p.nx * METRO_OFFSET,
    z: p.z + p.nz * METRO_OFFSET,
    heading: p.heading,
  };
}

function concreteMaterial(name: string, fogNear: number, fogFar: number) {
  return new THREE.RawShaderMaterial({
    name,
    glslVersion: THREE.GLSL3,
    uniforms: {
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.44, 0.16).multiplyScalar(3.4) },
      uTime: { value: 0 },
      uFogNear: { value: fogNear },
      uFogFar: { value: fogFar },
    },
    vertexShader: /* glsl */ `
      in vec3 position; in vec3 normal; in vec2 uv; in mat4 instanceMatrix;
      uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
      out vec3 vN; out vec3 vW; out vec2 vUv;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(instanceMatrix) * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp int;
      precision highp sampler2D;
      in vec3 vN; in vec3 vW; in vec2 vUv;
      out vec4 outColor;
      uniform vec3 uCameraPos, uSunDir, uSunColor;
      uniform float uTime, uFogNear, uFogFar;
      ${SKY_GLSL}
      ${PBR_GLSL}
      ${SKY_IBL_GLSL}

      float h21(vec2 p) {
        p = fract(p * vec2(233.34, 851.73));
        p += dot(p, p + 23.45);
        return fract(p.x * p.y);
      }

      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(vW - uCameraPos);
        float dist = length(vW - uCameraPos);

        // Precast segments: a joint every 3 m along the run reads as the
        // match-cast box girder the real viaduct is built from.
        float joint = smoothstep(0.04, 0.10, abs(fract(vUv.y / 3.0) - 0.5) * 2.0 - 0.80);
        float grime = h21(floor(vec2(vUv.x * 3.0, vUv.y * 0.6)));
        vec3 albedo = mix(vec3(0.085, 0.080, 0.076), vec3(0.130, 0.123, 0.115), grime);
        albedo *= 1.0 - joint * 0.40;
        // Weather staining runs down from the deck edge.
        albedo *= 0.80 + 0.20 * smoothstep(0.0, 0.4, fract(vUv.x * 0.25));

        float rough = filterRoughness(N, 0.72);
        Surface s = makeSurface(albedo, 0.0, rough, N, V);
        vec3 R = reflect(V, N);
        vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
        col += shadeDirect(s, uSunDir, uSunColor);
        // Warm bounce off the carriageway onto the soffit.
        col += vec3(1.0, 0.42, 0.16) * max(-N.y, 0.0) * 0.06;

        float fog = smoothstep(uFogNear, uFogFar, dist);
        col = mix(col, skyRadiance(normalize(vec3(V.x, 0.03, V.z)), uSunDir), fog * 0.94);
        outColor = vec4(col, 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });
}

function emissiveMaterial(color: THREE.Color, gain: number) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: color }, uGain: { value: gain }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      in vec3 position; in vec2 uv; in mat4 instanceMatrix;
      uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
      out vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp sampler2D;
      in vec2 vUv; out vec4 outColor;
      uniform vec3 uColor; uniform float uGain, uTime;
      void main() { outColor = vec4(uColor * uGain, 0.9); }
    `,
    side: THREE.DoubleSide,
  });
}

export class MetroLine {
  readonly group = new THREE.Group();
  private materials: THREE.RawShaderMaterial[] = [];

  constructor(corridor: Corridor) {
    const path = corridor.path;
    const built = buildMetro({ lengthM: BAY, pierSpacing: BAY });

    const bays = Math.floor(path.length / BAY);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);

    // --- viaduct ----------------------------------------------------------
    const deckMat = concreteMaterial('metro-deck', 260, 2400);
    this.materials.push(deckMat);
    const deck = new THREE.InstancedMesh(built.structure, deckMat, bays);
    for (let i = 0; i < bays; i++) {
      const p = metroAt(corridor, i * BAY);
      q.setFromAxisAngle(up, p.heading);
      m.compose(new THREE.Vector3(p.x, 0, p.z), q, one);
      deck.setMatrixAt(i, m);
    }
    deck.instanceMatrix.needsUpdate = true;
    deck.frustumCulled = false;
    this.group.add(deck);

    const deckGlowMat = emissiveMaterial(new THREE.Color(0.55, 0.72, 1.0), 0.9);
    this.materials.push(deckGlowMat);
    const deckGlow = new THREE.InstancedMesh(built.emissive, deckGlowMat, bays);
    for (let i = 0; i < bays; i++) {
      const p = metroAt(corridor, i * BAY);
      q.setFromAxisAngle(up, p.heading);
      m.compose(new THREE.Vector3(p.x, 0, p.z), q, one);
      deckGlow.setMatrixAt(i, m);
    }
    deckGlow.instanceMatrix.needsUpdate = true;
    deckGlow.frustumCulled = false;
    deckGlow.renderOrder = 7;
    this.group.add(deckGlow);

    // --- stations ---------------------------------------------------------
    // Roughly every 1.6 km, which is close to the real Red Line spacing along
    // this stretch, and far enough apart that one is always an event.
    const STATION_SPACING = 1600;
    const stationCount = Math.max(1, Math.floor(path.length / STATION_SPACING));
    const stMat = concreteMaterial('metro-station', 260, 2600);
    this.materials.push(stMat);
    const stations = new THREE.InstancedMesh(built.station, stMat, stationCount);
    const stGlowMat = emissiveMaterial(new THREE.Color(1.0, 0.78, 0.34), 1.9);
    this.materials.push(stGlowMat);
    const stGlow = new THREE.InstancedMesh(built.stationEmissive, stGlowMat, stationCount);

    for (let i = 0; i < stationCount; i++) {
      const p = metroAt(corridor, (i + 0.5) * STATION_SPACING);
      q.setFromAxisAngle(up, p.heading);
      m.compose(new THREE.Vector3(p.x, 0, p.z), q, one);
      stations.setMatrixAt(i, m);
      stGlow.setMatrixAt(i, m);
    }
    stations.instanceMatrix.needsUpdate = true;
    stGlow.instanceMatrix.needsUpdate = true;
    stations.frustumCulled = false;
    stGlow.frustumCulled = false;
    stGlow.renderOrder = 8;
    this.group.add(stations, stGlow);

    this.addPalms(corridor);
    this.addMasts(corridor);
    this.addGantries(corridor);
  }

  /** Date palms down both verges — the planting that defines a Dubai arterial. */
  private addPalms(corridor: Corridor) {
    const path = corridor.path;
    const SPACING = 26;
    const count = Math.floor(path.length / SPACING) * 2;

    // A handful of distinct palms, instanced — a row of identical trees is
    // instantly readable as fake, but so is a unique mesh per tree.
    const VARIANTS = 4;
    const variants = Array.from({ length: VARIANTS }, (_, i) => buildPalm(i * 977 + 13));
    const trunkMat = concreteMaterial('palm-trunk', 200, 1400);
    this.materials.push(trunkMat);
    const frondMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      transparent: false,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uSunDir: { value: SUN_DIR.clone() },
        uSunColor: { value: new THREE.Color(1.0, 0.44, 0.16).multiplyScalar(3.4) },
        uTime: { value: 0 },
        uFogNear: { value: 200 },
        uFogFar: { value: 1400 },
      },
      vertexShader: /* glsl */ `
        in vec3 position; in vec3 normal; in vec2 uv; in mat4 instanceMatrix;
        uniform mat4 modelViewMatrix, projectionMatrix, modelMatrix;
        uniform float uTime;
        out vec3 vN; out vec3 vW; out vec2 vUv;
        void main() {
          vec3 p = position;
          // Frond sway, strongest at the tips.
          float t = clamp(uv.x, 0.0, 1.0);
          p.x += sin(uTime * 1.1 + p.y * 0.7 + instanceMatrix[3].x * 0.1) * 0.16 * t;
          vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vW = wp.xyz; vUv = uv;
          vN = normalize(mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp int;
        precision highp sampler2D;
        in vec3 vN; in vec3 vW; in vec2 vUv;
        out vec4 outColor;
        uniform vec3 uCameraPos, uSunDir, uSunColor;
        uniform float uFogNear, uFogFar;
        ${SKY_GLSL}
        ${PBR_GLSL}
        ${SKY_IBL_GLSL}
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vW - uCameraPos);
          // Dusty olive-green, darker toward the frond base.
          vec3 albedo = mix(vec3(0.030, 0.042, 0.018), vec3(0.062, 0.078, 0.030), clamp(vUv.x, 0.0, 1.0));
          Surface s = makeSurface(albedo, 0.0, filterRoughness(N, 0.66), N, V);
          vec3 R = reflect(V, N);
          vec3 col = shadeIBL(s, skyIrradiance(N, uSunDir), skyPrefiltered(R, s.roughness, uSunDir));
          col += shadeDirect(s, uSunDir, uSunColor);
          // Fronds are thin: let some sun through from behind.
          col += vec3(1.0, 0.55, 0.20) * pow(max(dot(V, uSunDir), 0.0), 3.0) * 0.35;
          float fog = smoothstep(uFogNear, uFogFar, length(vW - uCameraPos));
          col = mix(col, skyRadiance(normalize(vec3(V.x, 0.03, V.z)), uSunDir), fog * 0.92);
          outColor = vec4(col, 1.0);
        }
      `,
    });
    this.materials.push(frondMat);

    const perVariant = Math.ceil(count / VARIANTS);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);

    variants.forEach((v, vi) => {
      const trunks = new THREE.InstancedMesh(v.trunk, trunkMat, perVariant);
      const fronds = new THREE.InstancedMesh(v.fronds, frondMat, perVariant);
      let n = 0;
      for (let i = vi; i < count && n < perVariant; i += VARIANTS) {
        const idx = Math.floor(i / 2);
        const side = i % 2 === 0 ? -1 : 1;
        const s = idx * SPACING;
        if (s > corridor.path.length) break;
        const p = corridor.path.sample(s);
        const off = (ROAD_HALF_WIDTH + 16 + (vi % 2) * 3) * side;
        const sc = 0.85 + ((vi * 37 + i) % 7) * 0.05;
        q.setFromAxisAngle(up, (i * 2.399) % (Math.PI * 2));
        m.compose(
          new THREE.Vector3(p.x + p.nx * off, 0, p.z + p.nz * off),
          q,
          new THREE.Vector3(sc, sc, sc),
        );
        trunks.setMatrixAt(n, m);
        fronds.setMatrixAt(n, m);
        n++;
      }
      trunks.count = n;
      fronds.count = n;
      trunks.instanceMatrix.needsUpdate = true;
      fronds.instanceMatrix.needsUpdate = true;
      trunks.frustumCulled = false;
      fronds.frustumCulled = false;
      this.group.add(trunks, fronds);
    });
  }

  /** Tall tapered masts with a curved outreach arm over the carriageway. */
  private addMasts(corridor: Corridor) {
    const path = corridor.path;
    const SPACING = 48;
    const count = Math.floor(path.length / SPACING) * 2;
    const mast = buildLightMast(14);
    const mat = concreteMaterial('light-mast', 200, 1600);
    this.materials.push(mat);
    const mesh = new THREE.InstancedMesh(mast.structure, mat, count);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (let s = 0; s < path.length && n < count; s += SPACING) {
      const p = path.sample(s);
      for (const side of [-1, 1]) {
        if (n >= count) break;
        const off = (ROAD_HALF_WIDTH + 2.4) * side;
        // Arm reaches in over the road, so flip the mast on the far side.
        q.setFromAxisAngle(up, p.heading + (side > 0 ? Math.PI : 0));
        m.compose(new THREE.Vector3(p.x + p.nx * off, 0, p.z + p.nz * off), q, new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(n++, m);
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /** Bilingual overhead direction signs — the strongest UAE cue at eye level. */
  private addGantries(corridor: Corridor) {
    const path = corridor.path;
    const span = ROAD_HALF_WIDTH * 2 + 8;
    const g = buildGantry(span);

    const structMat = concreteMaterial('gantry', 200, 1600);
    this.materials.push(structMat);

    const SIGNS = [
      { en: 'Dubai World Trade Centre', ar: 'مركز دبي التجاري العالمي', exit: 'Exit 45' },
      { en: 'Downtown Dubai / Burj Khalifa', ar: 'وسط مدينة دبي / برج خليفة', exit: 'Exit 49' },
      { en: 'Financial Centre', ar: 'المركز المالي', exit: null },
      { en: 'Business Bay', ar: 'الخليج التجاري', exit: 'Exit 53' },
      { en: 'Al Safa', ar: 'الصفا', exit: 'Exit 57' },
    ];

    const SPACING = 320;
    const count = Math.floor(path.length / SPACING);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);

    const structs = new THREE.InstancedMesh(g.structure, structMat, count);
    for (let i = 0; i < count; i++) {
      const p = path.sample((i + 1) * SPACING);
      q.setFromAxisAngle(up, p.heading);
      m.compose(new THREE.Vector3(p.x, 0, p.z), q, one);
      structs.setMatrixAt(i, m);
    }
    structs.instanceMatrix.needsUpdate = true;
    structs.frustumCulled = false;
    this.group.add(structs);

    // One panel mesh per distinct destination, instanced across its occurrences,
    // so the canvas textures are built once and reused.
    SIGNS.forEach((spec, si) => {
      const tex = makePanelTexture({ ...spec, colour: 'green' });
      const panelMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const slots = Math.ceil(count / SIGNS.length);
      const panels = new THREE.InstancedMesh(g.panel, panelMat, slots);
      let n = 0;
      for (let i = si; i < count && n < slots; i += SIGNS.length) {
        const p = path.sample((i + 1) * SPACING);
        q.setFromAxisAngle(up, p.heading);
        m.compose(new THREE.Vector3(p.x, 0, p.z), q, one);
        panels.setMatrixAt(n++, m);
      }
      panels.count = n;
      panels.instanceMatrix.needsUpdate = true;
      panels.frustumCulled = false;
      this.group.add(panels);
    });
  }

  update(time: number, cameraPos: THREE.Vector3) {
    for (const mat of this.materials) {
      if (mat.uniforms.uTime) mat.uniforms.uTime.value = time;
      if (mat.uniforms.uCameraPos) (mat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
    }
  }
}
