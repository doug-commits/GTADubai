import * as THREE from 'three';
import { SUN_DIR } from './sky';

/**
 * Single-cascade directional shadow map for the dusk sun.
 *
 * The sun sits at 4.9 degrees of elevation (see SUN_DIR), which is the whole
 * reason this file is shaped the way it is. Everything below follows from that
 * one number:
 *
 *  - Shadows are 11.7x the height of whatever casts them. A 0.9 m barrier
 *    throws a 10 m stripe across the carriageway; a 12 m light mast throws
 *    140 m. Long raking shadows are the look, so the frustum has to be able to
 *    hold them.
 *  - The focus volume is a CYLINDER (radius `range`, height `casterHeight`)
 *    rather than a cube. Projected into light space a horizontal disc is only
 *    ~R * sin(elevation) tall, so the light-space box comes out strongly
 *    anisotropic: 130 m half-width across-sun, 66 m half-height. Fitting a cube
 *    instead would waste more than half the vertical resolution on empty sky
 *    and roughly double the along-sun texel footprint (1.5 m vs 0.76 m).
 *  - The near plane is pushed `casterHeight / sin(elevation)` = ~650 m BACK
 *    along the sun ray. A caster and its shadow occupy the same light-space
 *    x/y, so tall geometry is only ever lost to the NEAR plane, never to the
 *    sides. Without that pull-back nothing above about 2 m would cast at all.
 *  - The frustum origin is snapped to whole texels every frame. On a moving
 *    camera this is not a polish detail: unsnapped, every shadow edge boils and
 *    crawls as the car drives, which reads worse than having no shadows.
 *
 * The caster pass is depth-only, colour writes masked off, and it reuses the
 * scene graph directly — materials are swapped for a trivial position-only
 * program for the duration of the pass and put back afterwards. Emissive,
 * additive and transparent surfaces (window glows, headlight cones, sign
 * decals) are skipped, as is the road itself: it is a receiver, it is nearly
 * parallel to the light, and letting it cast buys nothing but acne.
 */

/** Rotated Poisson disc — 8 taps around a centre tap, in texels. */
const POISSON_GLSL = /* glsl */ `
  const vec2 SHADOW_POISSON[8] = vec2[8](
    vec2( 0.9558, 0.2224), vec2( 0.2612, 0.9139),
    vec2(-0.7135, 0.6595), vec2(-0.9754,-0.1385),
    vec2(-0.3390,-0.9075), vec2( 0.6001,-0.7746),
    vec2( 0.4344, 0.1876), vec2(-0.2451,-0.3624)
  );
`;

/**
 * Drop-in shadow sampling.
 *
 * Include after nothing in particular (it declares its own uniforms), wire the
 * uniforms with `shadowUniforms()` + `syncShadowUniforms()`, then call
 * `sampleShadow(worldPos, N)` for a 0..1 visibility term.
 *
 * IMPORTANT: call it from uniform control flow. It takes screen-space
 * derivatives of the shadow coordinate to build a receiver-plane depth bias,
 * and derivatives inside a divergent branch are undefined.
 */
export const SHADOW_GLSL = /* glsl */ `
  uniform sampler2D tShadowMap;
  uniform mat4 uShadowMatrix;   // world -> shadow UV + depth, all in 0..1
  uniform vec4 uShadowParams;   // x = 1/size, y = texel world size (m), z = depth range (m), w = strength
  uniform vec3 uShadowSun;      // normalised direction TOWARD the sun

  ${POISSON_GLSL}

  // Interleaved gradient noise. A per-pixel rotation turns PCF banding into a
  // fine dither, which the grain in the composite then hides completely.
  float shadowIGN(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  /**
   * Receiver-plane depth bias (Isidoro). Returns d(depth)/d(uv), i.e. how fast
   * the receiver's own shadow-space depth changes as the PCF taps walk across
   * the map. Offsetting each tap by its own plane depth is what makes a
   * grazing ground plane shadow correctly WITHOUT a large constant bias — and
   * a large constant bias is exactly what peter-pans a 4.9-degree sun.
   */
  vec2 shadowPlaneBias(vec3 dx, vec3 dy) {
    float det = dx.x * dy.y - dx.y * dy.x;
    if (abs(det) < 1e-12) return vec2(0.0);
    vec2 b = vec2(dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z) / det;
    // Silhouettes produce garbage derivatives; clamp to the steepest plane the
    // frustum can actually contain (the ground, at about 1.7 per uv unit).
    return clamp(b, vec2(-3.0), vec2(3.0));
  }

  float sampleShadow(vec3 worldPos, vec3 N) {
    float strength = uShadowParams.w;
    if (strength <= 0.0) return 1.0;

    float NoL = dot(N, uShadowSun);
    float sinT = sqrt(clamp(1.0 - NoL * NoL, 0.0, 1.0));

    // Normal offset, in texels of world size. Kept deliberately small: with the
    // sun this low, one metre of offset along a road normal slides the lookup
    // nearly twelve metres up-sun, so a "safe" offset detaches every shadow
    // from its caster. The plane bias below does the real work.
    vec3 P = worldPos + N * (uShadowParams.y * (0.55 + 0.85 * sinT));

    vec4 sc = uShadowMatrix * vec4(P, 1.0);
    vec3 uvz = sc.xyz; // orthographic: w is exactly 1

    // Derivatives first, before any branch — see the note on the export.
    vec2 planeBias = shadowPlaneBias(dFdx(uvz), dFdy(uvz));

    vec2 fromCentre = abs(uvz.xy - 0.5);
    float outside = max(max(fromCentre.x, fromCentre.y) - 0.5, 0.0);
    if (outside > 0.0 || uvz.z <= 0.0 || uvz.z >= 1.0) return 1.0;

    float texel = uShadowParams.x;
    // Half a metre of slack, expressed in shadow-depth units. Absorbs depth
    // quantisation and the residue the plane bias cannot see.
    float constBias = 0.5 / uShadowParams.z;

    float ang = shadowIGN(gl_FragCoord.xy) * 6.2831853;
    float ca = cos(ang), sa = sin(ang);
    mat2 rot = mat2(ca, sa, -sa, ca);
    const float RADIUS = 1.6;

    float vis = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 o = rot * SHADOW_POISSON[i] * (RADIUS * texel);
      float ref = uvz.z + clamp(dot(o, planeBias), -0.01, 0.01) - constBias;
      vis += step(ref, textureLod(tShadowMap, uvz.xy + o, 0.0).r);
    }
    vis += step(uvz.z - constBias, textureLod(tShadowMap, uvz.xy, 0.0).r);
    vis *= 1.0 / 9.0;

    // Dissolve at the border of the map instead of ending on a hard line.
    float edge = 1.0 - smoothstep(0.40, 0.495, max(fromCentre.x, fromCentre.y));
    vis = mix(1.0, vis, edge);

    // A surface already turned away from the sun receives no key light, so
    // shadowing it as well would double-count. The ramp is deliberately soft
    // and reaches full strength slightly BELOW zero: at 4.9 degrees the road's
    // own NoL is only 0.085, and a physically tight gate would erase exactly
    // the shadows this whole file exists to draw.
    vis = mix(1.0, vis, smoothstep(-0.32, -0.04, NoL));

    return mix(1.0, vis, strength);
  }
`;

const CASTER_FRAG = /* glsl */ `
  precision highp float;
  precision highp int;
  out vec4 outColor;
  void main() { outColor = vec4(1.0); }
`;

function casterVert(instanced: boolean) {
  return /* glsl */ `
    precision highp float;
    precision highp int;
    in vec3 position;
    ${instanced ? 'in mat4 instanceMatrix;' : ''}
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    void main() {
      ${
        instanced
          ? 'gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);'
          : 'gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);'
      }
    }
  `;
}

export interface ShadowSystem {
  /** Depth map to sample. NEAREST-filtered; PCF is done by hand in the shader. */
  readonly texture: THREE.Texture;
  /** World -> shadow UV+depth, already biased into 0..1. */
  readonly matrix: THREE.Matrix4;
  /** Resolution in pixels (square). */
  readonly size: number;
  /** Largest world-space texel footprint, metres. Drives the normal offset. */
  readonly texelWorld: number;
  /** Metres covered by 0..1 of shadow depth. Drives the constant bias. */
  readonly depthRange: number;
  /** 0 disables sampling entirely; 1 is full. */
  strength: number;
  /** Cost of the last caster pass, for the render-stats readout. */
  readonly stats: { drawCalls: number; triangles: number; casters: number };
  setSize(px: number): void;
  /** Re-fit the frustum around the camera each frame and render casters. */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
}

export interface ShadowOptions {
  /** Shadow map resolution. 1024 or 2048. */
  size?: number;
  /** Diameter of the ground disc the map covers, metres. */
  range?: number;
  /** Tallest caster captured, metres above the focus plane. */
  casterHeight?: number;
  /** Anything whose bounding sphere is smaller than this never casts. */
  minCasterRadius?: number;
}

/** Materials that must never write into the shadow map, by material name. */
const SKIP_MATERIALS = new Set(['sky', 'road', 'lamp-glow', 'glow', 'landmark-emissive']);

const _BIAS = new THREE.Matrix4().set(
  0.5, 0.0, 0.0, 0.5,
  0.0, 0.5, 0.0, 0.5,
  0.0, 0.0, 0.5, 0.5,
  0.0, 0.0, 0.0, 1.0,
);

interface Swap {
  mesh: THREE.Mesh;
  material: THREE.Material | THREE.Material[];
}

class DirectionalShadow implements ShadowSystem {
  readonly matrix = new THREE.Matrix4();
  readonly stats = { drawCalls: 0, triangles: 0, casters: 0 };
  strength = 1;

  size: number;
  texelWorld = 1;
  depthRange = 1;

  private target: THREE.WebGLRenderTarget;
  private depth: THREE.DepthTexture;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private plainMat: THREE.RawShaderMaterial;
  private instMat: THREE.RawShaderMaterial;

  /** Fixed light basis. Constant, so texel snapping is meaningful. */
  private basis = new THREE.Matrix4();
  private basisInv = new THREE.Matrix4();
  private lightQuat = new THREE.Quaternion();

  private range: number;
  private casterHeight: number;
  private minCasterRadius: number;
  private halfX = 1;
  private halfY = 1;
  private halfZ = 1;
  private back = 1;

  private swaps: Swap[] = [];
  private hidden: THREE.Object3D[] = [];
  private _c = new THREE.Vector3();
  private _f = new THREE.Vector3();
  private _sphere = new THREE.Sphere();

  constructor(opts: ShadowOptions = {}) {
    this.size = Math.max(256, Math.floor(opts.size ?? 2048));
    this.range = opts.range ?? 130;
    this.casterHeight = opts.casterHeight ?? 55;
    this.minCasterRadius = opts.minCasterRadius ?? 0.55;

    // Light basis: a camera sitting up-sun looking back down the ray. Built
    // once from constants, so the rotation never changes and a snapped origin
    // stays snapped from frame to frame.
    const probe = new THREE.Object3D();
    probe.up.set(0, 1, 0);
    probe.position.copy(SUN_DIR).multiplyScalar(100);
    probe.lookAt(0, 0, 0);
    probe.updateMatrixWorld(true);
    this.basis.extractRotation(probe.matrixWorld);
    this.basisInv.copy(this.basis).transpose();
    this.lightQuat.copy(probe.quaternion);

    this.fitExtents();

    this.depth = new THREE.DepthTexture(this.size, this.size, THREE.UnsignedIntType);
    this.depth.format = THREE.DepthFormat;
    this.depth.minFilter = THREE.NearestFilter;
    this.depth.magFilter = THREE.NearestFilter;
    this.depth.compareFunction = null;
    this.target = new THREE.WebGLRenderTarget(this.size, this.size, {
      // The colour attachment is never read; three always allocates one, so
      // make it the cheapest thing it will accept and mask writes to it.
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture: this.depth,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;

    const common = {
      glslVersion: THREE.GLSL3,
      fragmentShader: CASTER_FRAG,
      side: THREE.DoubleSide,
      colorWrite: false,
      fog: false,
    } as const;
    this.plainMat = new THREE.RawShaderMaterial({
      ...common,
      name: 'shadow-caster',
      vertexShader: casterVert(false),
    });
    this.instMat = new THREE.RawShaderMaterial({
      ...common,
      name: 'shadow-caster-inst',
      vertexShader: casterVert(true),
    });
  }

  get texture(): THREE.Texture {
    return this.depth;
  }

  /**
   * Light-space half-extents of the focus volume.
   *
   * The volume is a cylinder — a disc of ground plus everything above it up to
   * `casterHeight`. Sampling the rim is enough: the AABB of a disc under a
   * fixed rotation is exact at 64 samples to well under a texel.
   */
  private fitExtents() {
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const p = new THREE.Vector3();
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const cx = Math.cos(a) * this.range;
      const cz = Math.sin(a) * this.range;
      for (const y of [-8, this.casterHeight]) {
        p.set(cx, y, cz).applyMatrix4(this.basisInv);
        min.min(p);
        max.max(p);
      }
    }
    this.halfX = Math.max(Math.abs(min.x), Math.abs(max.x));
    this.halfY = Math.max(Math.abs(min.y), Math.abs(max.y));
    this.halfZ = Math.max(Math.abs(min.z), Math.abs(max.z));
    // Pull the near plane back far enough that a caster of the tallest
    // supported height still lies inside the frustum when its shadow lands in
    // the disc. This is the term that makes a low sun work at all.
    this.back = this.casterHeight / Math.max(SUN_DIR.y, 0.05);

    this.texelWorld = Math.max((2 * this.halfX) / this.size, (2 * this.halfY) / this.size);
    this.depthRange = 2 * this.halfZ + this.back;

    this.cam.left = -this.halfX;
    this.cam.right = this.halfX;
    this.cam.top = this.halfY;
    this.cam.bottom = -this.halfY;
    this.cam.near = 0;
    this.cam.far = this.depthRange;
    this.cam.updateProjectionMatrix();
  }

  setSize(px: number) {
    const s = Math.max(256, Math.floor(px));
    if (s === this.size) return;
    this.size = s;
    this.fitExtents();
    this.depth.image.width = s;
    this.depth.image.height = s;
    this.depth.needsUpdate = true;
    this.target.setSize(s, s);
  }

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    if (this.strength <= 0) return;

    // --- fit ---------------------------------------------------------------
    // Centre the disc on the road ahead rather than on the camera: at speed
    // almost everything the player can see is in front, so centring on the
    // camera would spend a third of the map behind them.
    this._f.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this._f.y = 0;
    if (this._f.lengthSq() < 1e-6) this._f.set(0, 0, -1);
    this._f.normalize();
    this._c
      .copy(camera.position)
      .addScaledVector(this._f, this.range * 0.42);
    // Pin the focus plane to road level. A centre that rides up and down with
    // a chase camera changes the light-space origin for no benefit.
    this._c.y = 1.5;

    // --- stabilise ---------------------------------------------------------
    // Snap the origin to whole texels IN LIGHT SPACE. The basis is constant and
    // the extents are constant, so this is the complete fix for crawl: the
    // projection of any static world point lands on the same texel every frame
    // until the map jumps by an exact texel.
    this._c.applyMatrix4(this.basisInv);
    const tx = (2 * this.halfX) / this.size;
    const ty = (2 * this.halfY) / this.size;
    this._c.x = Math.floor(this._c.x / tx) * tx;
    this._c.y = Math.floor(this._c.y / ty) * ty;
    this._c.applyMatrix4(this.basis);

    this.cam.position.copy(this._c).addScaledVector(SUN_DIR, this.halfZ + this.back);
    this.cam.quaternion.copy(this.lightQuat);
    this.cam.updateMatrixWorld(true);
    this.cam.matrixWorldInverse.copy(this.cam.matrixWorld).invert();

    this.matrix
      .copy(_BIAS)
      .multiply(this.cam.projectionMatrix)
      .multiply(this.cam.matrixWorldInverse);

    // --- collect casters ---------------------------------------------------
    scene.updateMatrixWorld(false);
    this.collect(scene);

    // --- render ------------------------------------------------------------
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.cam);
    this.stats.drawCalls = renderer.info.render.calls;
    this.stats.triangles = renderer.info.render.triangles;
    renderer.setRenderTarget(prevTarget);

    this.restore();
  }

  private collect(scene: THREE.Scene) {
    const swaps = this.swaps;
    const hidden = this.hidden;
    swaps.length = 0;
    hidden.length = 0;

    scene.traverseVisible((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) {
        // Points, lines and sprites are decoration; never casters.
        if ((obj as THREE.Points).isPoints || (obj as THREE.Line).isLine || (obj as THREE.Sprite).isSprite) {
          hidden.push(obj);
        }
        return;
      }
      if (this.casts(mesh)) {
        swaps.push({ mesh, material: mesh.material });
      } else {
        hidden.push(mesh);
      }
    });

    for (const o of hidden) o.visible = false;
    const inst = this.instMat;
    const plain = this.plainMat;
    for (const s of swaps) {
      s.mesh.material = (s.mesh as THREE.InstancedMesh).isInstancedMesh ? inst : plain;
    }
    this.stats.casters = swaps.length;
  }

  private restore() {
    for (const o of this.hidden) o.visible = true;
    for (const s of this.swaps) s.mesh.material = s.material;
    this.hidden.length = 0;
    this.swaps.length = 0;
  }

  private casts(mesh: THREE.Mesh): boolean {
    if (mesh.userData.noShadow === true) return false;

    const mat = mesh.material;
    const m = Array.isArray(mat) ? mat[0] : mat;
    if (!m) return false;
    // Additive glows, sign decals and headlight cones have no mass. They are
    // flagged consistently across the world modules, so this is exact rather
    // than a guess.
    if (m.transparent === true) return false;
    if (m.depthWrite === false) return false;
    if (m.blending !== THREE.NormalBlending) return false;
    if (m.name && SKIP_MATERIALS.has(m.name)) return false;
    if (mesh.name && SKIP_MATERIALS.has(mesh.name)) return false;

    const geo = mesh.geometry;
    if (!geo) return false;

    // An InstancedMesh carries its extent in the instance matrices, not in the
    // geometry, so the size test would read the unit prototype and throw the
    // whole batch away. Instanced batches are always worth their one draw call.
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) return true;

    // Drop anything too small to resolve at a texel and change. Cheap: bounding
    // spheres are cached on the geometry and every mesh here is built at load.
    if (geo.boundingSphere === null) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    if (bs) {
      this._sphere.copy(bs).applyMatrix4(mesh.matrixWorld);
      if (this._sphere.radius < this.minCasterRadius) return false;
    }
    return true;
  }

  dispose() {
    this.target.dispose();
    this.depth.dispose();
    this.plainMat.dispose();
    this.instMat.dispose();
  }
}

export function createShadowSystem(opts?: ShadowOptions): ShadowSystem {
  return new DirectionalShadow(opts);
}

/** Uniform block every material that samples shadows needs. Merge and forget. */
export function shadowUniforms(): Record<string, THREE.IUniform> {
  return {
    tShadowMap: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowParams: { value: new THREE.Vector4(1 / 2048, 0.13, 900, 0) },
    uShadowSun: { value: SUN_DIR.clone() },
  };
}

/** Push the current frame's shadow state into a uniform block. */
export function syncShadowUniforms(
  uniforms: Record<string, THREE.IUniform>,
  sys: ShadowSystem | null,
) {
  const params = uniforms.uShadowParams.value as THREE.Vector4;
  if (!sys) {
    params.w = 0;
    return;
  }
  uniforms.tShadowMap.value = sys.texture;
  (uniforms.uShadowMatrix.value as THREE.Matrix4).copy(sys.matrix);
  params.set(1 / sys.size, sys.texelWorld, sys.depthRange, sys.strength);
  (uniforms.uShadowSun.value as THREE.Vector3).copy(SUN_DIR);
}
