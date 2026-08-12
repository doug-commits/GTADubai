/**
 * Arc-length parameterised centreline.
 *
 * Every moving thing in the game is addressed as (s, t):
 *   s = metres travelled along the road centreline from the start of the run
 *   t = signed lateral offset in metres (+ = driver's right)
 *
 * This is what makes traffic AI, lane logic, collision and both camera rigs
 * cheap: they all reason in a straight 1-D corridor and only touch world space
 * at the last moment.
 */

import type { Vec2 } from './geo';

export interface PathSample {
  /** World position of the centreline at s. */
  x: number;
  z: number;
  /** Unit tangent (direction of travel). */
  tx: number;
  tz: number;
  /** Unit normal pointing to the driver's right. */
  nx: number;
  nz: number;
  /** Signed curvature, 1/metres. Positive = turning right. */
  curvature: number;
  /** Heading in radians, atan2(tx, -tz) — 0 = due north. */
  heading: number;
}

export class CenterlinePath {
  readonly pts: Vec2[];
  /** Cumulative arc length at each point. */
  readonly cum: Float64Array;
  readonly length: number;
  private readonly curv: Float32Array;

  constructor(points: Vec2[]) {
    if (points.length < 2) throw new Error('CenterlinePath needs >= 2 points');
    this.pts = points;
    this.cum = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dz = points[i].z - points[i - 1].z;
      this.cum[i] = this.cum[i - 1] + Math.hypot(dx, dz);
    }
    this.length = this.cum[this.cum.length - 1];

    // Discrete curvature via the circumscribed circle of each point triple.
    this.curv = new Float32Array(points.length);
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1];
      const b = points[i];
      const c = points[i + 1];
      const ax = b.x - a.x;
      const az = b.z - a.z;
      const bx = c.x - b.x;
      const bz = c.z - b.z;
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la < 1e-4 || lb < 1e-4) continue;
      // 2-D cross product of the two segment vectors gives twice the triangle area.
      const cross = (ax * bz - az * bx) / (la * lb);
      const chord = 0.5 * (la + lb);
      this.curv[i] = chord > 1e-4 ? cross / chord : 0;
    }
    this.curv[0] = this.curv[1] ?? 0;
    this.curv[this.curv.length - 1] = this.curv[this.curv.length - 2] ?? 0;
  }

  /** Index of the last centreline point at or before arc length s. */
  private segmentAt(s: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    if (s <= 0) return 0;
    if (s >= this.length) return this.cum.length - 2;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Sample the centreline at arc length s (clamped to the corridor). */
  sample(s: number, out?: PathSample): PathSample {
    const o: PathSample =
      out ?? { x: 0, z: 0, tx: 0, tz: 0, nx: 0, nz: 0, curvature: 0, heading: 0 };
    const i = this.segmentAt(s);
    const a = this.pts[i];
    const b = this.pts[i + 1];
    const segLen = this.cum[i + 1] - this.cum[i];
    const u = segLen > 1e-6 ? (s - this.cum[i]) / segLen : 0;

    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const inv = 1 / (Math.hypot(dx, dz) || 1);
    o.tx = dx * inv;
    o.tz = dz * inv;
    // Right-hand normal on the xz plane with +y up.
    o.nx = -o.tz;
    o.nz = o.tx;
    o.x = a.x + dx * u;
    o.z = a.z + dz * u;

    const ca = this.curv[i];
    const cb = this.curv[Math.min(i + 1, this.curv.length - 1)];
    o.curvature = ca + (cb - ca) * u;
    o.heading = Math.atan2(o.tx, -o.tz);
    return o;
  }

  /** Convert (s, t) to a world position. */
  toWorld(s: number, t: number, out?: { x: number; z: number }): { x: number; z: number } {
    const p = this.sample(s);
    const o = out ?? { x: 0, z: 0 };
    o.x = p.x + p.nx * t;
    o.z = p.z + p.nz * t;
    return o;
  }
}

/**
 * Resample a polyline to a fixed spacing and smooth it with a centred moving
 * average. Raw OSM ways have wildly uneven vertex spacing — a node every 3 m in
 * an interchange and one every 400 m on a straight — which makes curvature
 * estimates explode. This gives the road builder a well-conditioned spine.
 */
export function resample(points: Vec2[], spacing = 8, smoothPasses = 2): Vec2[] {
  if (points.length < 2) return points.slice();

  const out: Vec2[] = [{ ...points[0] }];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen < 1e-6) continue;
    let d = spacing - carry;
    while (d <= segLen) {
      const u = d / segLen;
      out.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
      d += spacing;
    }
    carry = (carry + segLen) % spacing;
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > spacing * 0.35) out.push({ ...last });

  // Endpoints are pinned so the finish line does not drift off the storefront.
  for (let pass = 0; pass < smoothPasses; pass++) {
    for (let i = 1; i < out.length - 1; i++) {
      out[i].x = (out[i - 1].x + 2 * out[i].x + out[i + 1].x) * 0.25;
      out[i].z = (out[i - 1].z + 2 * out[i].z + out[i + 1].z) * 0.25;
    }
  }
  return out;
}
