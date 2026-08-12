import * as THREE from 'three';

/**
 * Fullscreen pass driven by a single oversized triangle.
 *
 * A triangle beats a quad here: no diagonal seam, and the GPU rasterises one
 * primitive instead of two, which matters when the post chain runs eight-plus
 * passes every frame on a phone.
 */
export class FullScreenPass {
  static geometry: THREE.BufferGeometry | null = null;
  static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  readonly mesh: THREE.Mesh;
  readonly material: THREE.RawShaderMaterial;
  private readonly scene = new THREE.Scene();

  constructor(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, name = 'pass') {
    if (!FullScreenPass.geometry) {
      const g = new THREE.BufferGeometry();
      // Covers the clip-space square with a single triangle; UVs run 0..2 so the
      // 0..1 window lands exactly on the viewport.
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
      FullScreenPass.geometry = g;
    }
    this.material = new THREE.RawShaderMaterial({
      name,
      glslVersion: THREE.GLSL3,
      uniforms,
      vertexShader: /* glsl */ `
        in vec3 position;
        in vec2 uv;
        out vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(FullScreenPass.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, FullScreenPass.camera);
  }

  dispose() {
    this.material.dispose();
  }
}

export function makeTarget(w: number, h: number, half = true): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  t.texture.colorSpace = THREE.NoColorSpace;
  return t;
}
