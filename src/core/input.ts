/**
 * Input.
 *
 * Touch is the primary control and gets the most care: drag-steering from a
 * floating origin, which is what every good mobile racer uses. The origin
 * re-centres when the player eases off, so a thumb that wanders during a long
 * run never ends up fighting the car.
 *
 * A second simultaneous finger is boost — instant, no UI, and discoverable
 * within a couple of runs. Keyboard is supported for desktop testing and for
 * anyone playing on a laptop.
 */

export interface InputState {
  steer: number;
  brake: number;
  boost: boolean;
  /** True while any pointer is down — used to start the run on first touch. */
  active: boolean;
}

const FULL_LOCK_PX = 78; // drag distance for full steering lock
const DEADZONE_PX = 3;

export class Input {
  readonly state: InputState = { steer: 0, brake: 0, boost: false, active: false };

  private primaryId: number | null = null;
  private originX = 0;
  private currentX = 0;
  private extraTouches = new Set<number>();
  private keys = new Set<string>();
  private detach: Array<() => void> = [];

  constructor(private el: HTMLElement) {
    const opts = { passive: false } as AddEventListenerOptions;

    const onDown = (e: PointerEvent) => {
      if (this.primaryId === null) {
        this.primaryId = e.pointerId;
        this.originX = e.clientX;
        this.currentX = e.clientX;
        this.state.active = true;
      } else if (e.pointerId !== this.primaryId) {
        // Second finger = boost.
        this.extraTouches.add(e.pointerId);
      }
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== this.primaryId) return;
      this.currentX = e.clientX;
      e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId === this.primaryId) {
        this.primaryId = null;
        this.state.active = false;
      }
      this.extraTouches.delete(e.pointerId);
    };

    this.el.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    this.detach.push(() => {
      this.el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    });

    const kd = (e: KeyboardEvent) => {
      this.keys.add(e.code);
      if (['ArrowLeft', 'ArrowRight', 'Space', 'ArrowDown'].includes(e.code)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => this.keys.delete(e.code);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    this.detach.push(() => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    });
  }

  update(dt: number) {
    const s = this.state;

    // --- touch ------------------------------------------------------------
    let touchSteer = 0;
    if (this.primaryId !== null) {
      let dx = this.currentX - this.originX;
      const mag = Math.abs(dx);
      if (mag < DEADZONE_PX) dx = 0;
      touchSteer = Math.max(-1, Math.min(1, dx / FULL_LOCK_PX));
      // Recentre the origin when the player holds full lock, so the thumb does
      // not have to travel further and further to keep the car turning.
      if (mag > FULL_LOCK_PX) {
        this.originX += (mag - FULL_LOCK_PX) * Math.sign(dx) * Math.min(1, dt * 6);
      }
    }

    // --- keyboard ---------------------------------------------------------
    let keySteer = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) keySteer -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) keySteer += 1;

    const target = keySteer !== 0 ? keySteer : touchSteer;
    // Smooth the raw input a little; raw drag deltas are jittery on cheap panels.
    const rate = 1 - Math.exp(-dt * 18);
    s.steer += (target - s.steer) * rate;
    if (Math.abs(s.steer) < 0.002) s.steer = 0;

    s.brake =
      this.keys.has('ArrowDown') || this.keys.has('KeyS') ? 1 : 0;
    s.boost =
      this.extraTouches.size > 0 ||
      this.keys.has('Space') ||
      this.keys.has('ShiftLeft') ||
      this.keys.has('ShiftRight');
  }

  dispose() {
    for (const d of this.detach) d();
    this.detach = [];
  }
}
