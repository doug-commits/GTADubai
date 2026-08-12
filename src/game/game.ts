import * as THREE from 'three';
import type { AudioEngine, CameraMode, Net, Phase, RunResult, Telemetry, Ui } from '../contracts';
import { loadCorridor, type Corridor } from '../world/corridor';
import { Road, Barriers } from '../world/road';
import { City, Furniture } from '../world/city';
import { Storefront, makeFinishGantry } from '../world/storefront';
import { Sky, makeLights, SUN_DIR } from '../render/sky';
import { PostPipeline } from '../render/pipeline';
import { Car, MAX_SPEED } from './car';
import { Traffic, type TrafficEvents } from './traffic';
import { makeRig, type CameraRig } from './cameras';
import { Input } from '../core/input';
import type { PathSample } from '../world/path';

/**
 * Game orchestrator.
 *
 * Owns the scene, the fixed-timestep simulation and the phase machine. The UI
 * and audio layers are injected, and the only thing that crosses between them
 * each frame is the mutated `Telemetry` object.
 */

/** The run is the last stretch into town — Business Bay through Downtown to DWTC. */
const RACE_LENGTH = 5200;
const START_TIME = 35;
const CHECKPOINT_BONUS = 12;
const CHECKPOINT_COUNT = 4;

const SIM_STEP = 1 / 120;
const MAX_FRAME = 0.1;

const NEAR_MISS_SCORE = 120;
const CHECKPOINT_SCORE = 750;
const DISTANCE_SCORE_PER_M = 0.9;
const TIME_BONUS_PER_S = 260;

interface RaceCheckpoint {
  name: string;
  s: number;
  taken: boolean;
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(64, 1, 0.4, 4200);
  private post: PostPipeline;
  private sky = new Sky();
  private input: Input;

  private corridor!: Corridor;
  private road!: Road;
  private barriers!: Barriers;
  private city!: City;
  private storefront!: Storefront;
  private car = new Car();
  private traffic!: Traffic;
  private rig: CameraRig;

  private phase: Phase = 'boot';
  private startS = 0;
  private clock = 0;
  private elapsed = 0;
  private timeLeft = START_TIME;
  private score = 0;
  private combo = 1;
  private comboTimer = 0;
  private nearMissCount = 0;
  private topSpeed = 0;
  private boost = 0;
  private checkpoints: RaceCheckpoint[] = [];
  private countdownT = 0;
  private arriveT = 0;
  private accumulator = 0;
  private lastFrame = 0;
  /** Throttle for skid retriggers — see `maybeSkid`. */
  private skidCooldown = 0;
  private sample: PathSample = {
    x: 0, z: 0, tx: 0, tz: 0, nx: 0, nz: 0, curvature: 0, heading: 0,
  };
  private trafficEvents: TrafficEvents = { nearMiss: 0, crash: false, crashSeverity: 1 };
  private raf = 0;
  private cameraMode: CameraMode = 'chase';

  readonly telemetry: Telemetry = {
    phase: 'boot',
    timeLeft: START_TIME,
    distanceLeft: RACE_LENGTH,
    speedKph: 0,
    boost: 0,
    combo: 1,
    comboAge: 99,
    score: 0,
    lastCheckpoint: null,
    checkpointBonus: 0,
    crashed: false,
    nearMiss: false,
  };

  constructor(
    private canvas: HTMLCanvasElement,
    private audio: AudioEngine,
    private ui: Ui,
    private net: Net,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // the post chain resolves edges; MSAA on an HDR target is a phone killer
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.post = new PostPipeline(this.renderer);
    this.rig = makeRig(this.cameraMode);
    this.input = new Input(canvas);

    this.scene.add(this.sky.mesh);
    for (const l of makeLights()) this.scene.add(l);
    this.scene.add(this.car.group);
  }

  get attribution() {
    return {
      text: this.corridor?.meta.attribution ?? '',
      url: this.corridor?.meta.attributionUrl,
      isRealOSM: this.corridor?.meta.isRealOSM ?? false,
    };
  }

  async load() {
    this.ui.setBootProgress(0.1);
    this.corridor = await loadCorridor();
    this.ui.setBootProgress(0.4);

    this.startS = Math.max(0, this.corridor.finishS - RACE_LENGTH);

    this.road = new Road(this.corridor, { wetness: 0.8 });
    this.scene.add(this.road.mesh);
    this.barriers = new Barriers(this.corridor);
    this.scene.add(this.barriers.mesh);
    this.ui.setBootProgress(0.6);

    this.city = new City(this.corridor);
    this.scene.add(this.city.mesh);
    this.scene.add(new Furniture(this.corridor).group);
    this.ui.setBootProgress(0.85);

    this.storefront = new Storefront(this.corridor);
    this.scene.add(this.storefront.group);
    this.scene.add(makeFinishGantry(this.corridor));

    this.traffic = new Traffic(this.corridor.path);
    this.scene.add(this.traffic.group);

    this.sky.tryLoadAsset();

    // Checkpoints spread evenly through the race, named for the nearest interchange.
    this.checkpoints = [];
    for (let i = 1; i <= CHECKPOINT_COUNT; i++) {
      const s = this.startS + (RACE_LENGTH * i) / (CHECKPOINT_COUNT + 1);
      let name = 'Checkpoint';
      let best = Infinity;
      for (const c of this.corridor.checkpoints) {
        const d = Math.abs(c.s - s);
        if (d < best) {
          best = d;
          name = c.name.replace(/^Interchange \d+ — /, '');
        }
      }
      this.checkpoints.push({ name, s, taken: false });
    }

    this.resize();
    window.addEventListener('resize', this.resize);
    window.addEventListener('orientationchange', this.resize);

    this.car.reset();
    this.car.s = this.startS;
    this.rig.reset(this.car, this.corridor.path);
    this.traffic.reset(this.startS);

    this.ui.setBootProgress(1);
    this.setPhase('title');
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- phases ---

  private setPhase(p: Phase, result?: RunResult) {
    this.phase = p;
    this.telemetry.phase = p;
    this.ui.setPhase(p, result);
  }

  setCameraMode(m: CameraMode) {
    if (m === this.cameraMode) return;
    this.cameraMode = m;
    this.rig = makeRig(m);
    this.rig.reset(this.car, this.corridor.path);
  }

  getCameraMode() {
    return this.cameraMode;
  }

  startRun() {
    this.car.reset();
    this.car.s = this.startS;
    this.traffic.reset(this.startS);
    this.rig.reset(this.car, this.corridor.path);
    this.timeLeft = START_TIME;
    this.elapsed = 0;
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 99;
    this.nearMissCount = 0;
    this.topSpeed = 0;
    this.boost = 0.35;
    for (const c of this.checkpoints) c.taken = false;
    this.countdownT = 3.2;
    this.post.fade = 0;
    this.audio.start();
    this.setPhase('countdown');
  }

  restart() {
    this.audio.setTension(0);
    this.setPhase('title');
    this.car.reset();
    this.car.s = this.startS;
    this.traffic.reset(this.startS);
    this.rig.reset(this.car, this.corridor.path);
  }

  // ------------------------------------------------------------------ loop ---

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Cap the device pixel ratio: a modern phone reports 3, and rendering an HDR
    // pipeline at 3x on a 6" panel buys nothing visible and costs half the budget.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, dpr);
  };

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (!Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, MAX_FRAME);
    this.clock += dt;

    this.input.update(dt);

    // Fixed-step simulation so handling is identical at 30 and 120 fps.
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= SIM_STEP && steps < 12) {
      this.step(SIM_STEP);
      this.accumulator -= SIM_STEP;
      steps++;
    }
    if (steps >= 12) this.accumulator = 0;

    this.render(dt);
    this.ui.tick(dt);
  };

  private step(dt: number) {
    switch (this.phase) {
      case 'countdown': {
        const before = Math.ceil(this.countdownT);
        this.countdownT -= dt;
        const after = Math.ceil(this.countdownT);
        if (after !== before && after >= 0) this.audio.countdownBeep(after === 0);
        // Idle revs while waiting on the lights.
        this.car.rpm = 0.35 + Math.sin(this.clock * 3) * 0.12;
        if (this.countdownT <= 0) {
          this.car.speed = 30;
          this.setPhase('running');
        }
        break;
      }
      case 'running':
        this.stepRunning(dt);
        break;
      case 'arrived':
      case 'failed':
        this.stepOutro(dt);
        break;
      default:
        // Title: let the car roll gently so the scene is never static.
        this.car.s += 12 * dt;
        if (this.car.s > this.startS + 400) this.car.s = this.startS;
        this.car.rpm = 0.28;
        break;
    }

    this.corridor.path.sample(this.car.s, this.sample);
  }

  private stepRunning(dt: number) {
    const t = this.telemetry;
    t.crashed = false;
    t.nearMiss = false;
    t.checkpointBonus = 0;

    // --- boost --------------------------------------------------------------
    const wantsBoost = this.input.state.boost && this.boost > 0.02;
    if (wantsBoost) this.boost = Math.max(0, this.boost - dt * 0.42);
    else this.boost = Math.min(1, this.boost + dt * 0.035);

    this.corridor.path.sample(this.car.s, this.sample);
    this.car.update(dt, {
      steer: this.input.state.steer,
      brake: this.input.state.brake,
      boost: wantsBoost,
    }, this.corridor.path, this.sample);

    this.topSpeed = Math.max(this.topSpeed, this.car.speed);

    // --- traffic ------------------------------------------------------------
    this.traffic.update(dt, this.car.s, this.car.t, this.trafficEvents);

    if (this.trafficEvents.crash) {
      this.car.crash(this.trafficEvents.crashSeverity);
      this.audio.crash();
      this.combo = 1;
      this.comboTimer = 99;
      this.post.shake = 1;
      this.post.flash = 0.55;
      this.timeLeft -= 1.5;
      t.crashed = true;
      if (navigator.vibrate) navigator.vibrate(60);
    }

    if (this.trafficEvents.nearMiss > 0) {
      this.nearMissCount += this.trafficEvents.nearMiss;
      this.combo = Math.min(9, this.combo + this.trafficEvents.nearMiss);
      this.comboTimer = 0;
      this.score += NEAR_MISS_SCORE * this.combo * this.trafficEvents.nearMiss;
      this.boost = Math.min(1, this.boost + 0.10 * this.trafficEvents.nearMiss);
      this.audio.nearMiss(this.combo);
      t.nearMiss = true;
    }

    // Combo decays if you stop threading traffic.
    this.comboTimer += dt;
    if (this.comboTimer > 2.6 && this.combo > 1) {
      this.combo = 1;
      this.comboTimer = 99;
    }

    // --- checkpoints --------------------------------------------------------
    for (const c of this.checkpoints) {
      if (!c.taken && this.car.s >= c.s) {
        c.taken = true;
        this.timeLeft += CHECKPOINT_BONUS;
        this.score += CHECKPOINT_SCORE;
        t.checkpointBonus = CHECKPOINT_BONUS;
        t.lastCheckpoint = c.name;
        this.audio.checkpoint();
        this.post.flash = Math.max(this.post.flash, 0.22);
      }
    }

    // --- clock --------------------------------------------------------------
    this.score += this.car.speed * dt * DISTANCE_SCORE_PER_M;
    this.elapsed += dt;
    this.timeLeft -= dt;
    this.audio.setTension(THREE.MathUtils.clamp((10 - this.timeLeft) / 10, 0, 1));

    if (this.car.s >= this.corridor.finishS) {
      this.finish(true);
    } else if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.finish(false);
    }
  }

  private stepOutro(dt: number) {
    // Screech to a halt at the storefront.
    this.car.speed = Math.max(0, this.car.speed - 42 * dt);
    this.car.s += this.car.speed * dt;
    this.car.vt *= 1 - Math.min(1, dt * 4);
    this.car.t += this.car.vt * dt;
    this.arriveT += dt;
    if (this.car.speed > 4) this.maybeSkid(dt, Math.min(1, this.car.speed / 30));
  }

  /**
   * Skid is a one-shot with an envelope. Firing it every frame retriggers the
   * attack 60-120 times a second, which buzzes instead of screeching — so it
   * gets re-armed on a cooldown that shortens with intensity.
   */
  private maybeSkid(dt: number, intensity: number) {
    this.skidCooldown -= dt;
    if (this.skidCooldown > 0) return;
    this.skidCooldown = 0.16 - intensity * 0.07;
    this.audio.skid(intensity);
  }

  /**
   * Hard render cost for this frame. The critic harness runs under software GL
   * where wall-clock frame time says nothing about a phone, so draw calls and
   * triangle count are the numbers that actually transfer.
   */
  get renderStats() {
    const i = this.renderer.info;
    return {
      // Scene pass only — see PostPipeline.sceneStats.
      drawCalls: this.post.sceneStats.drawCalls,
      triangles: this.post.sceneStats.triangles,
      postPasses: 2 + (this.post.bloomLevels - 1) * 2,
      programs: i.programs?.length ?? 0,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      pixelRatio: this.renderer.getPixelRatio(),
    };
  }

  /** Test hook: end the run immediately. Used by the critic harness. */
  forceFinish(won: boolean) {
    if (this.phase !== 'running' && this.phase !== 'countdown') return;
    if (won) this.car.s = this.corridor.finishS;
    else this.timeLeft = 0;
    this.finish(won);
  }

  private finish(won: boolean) {
    this.arriveT = 0;
    if (won) this.score += this.timeLeft * TIME_BONUS_PER_S;
    const result: RunResult = {
      elapsed: this.elapsed,
      timeRemaining: Math.max(0, this.timeLeft),
      score: Math.round(this.score),
      topSpeedKph: Math.round(this.topSpeed * 3.6),
      nearMisses: this.nearMissCount,
      branch: 'dwtc',
      cameraMode: this.cameraMode,
    };
    this.audio.setTension(0);
    if (won) {
      this.audio.arrive();
      this.post.flash = 0.8;
    }
    this.setPhase(won ? 'arrived' : 'failed', result);
  }

  // ---------------------------------------------------------------- render ---

  private render(dt: number) {
    const speed01 = THREE.MathUtils.clamp(this.car.speed / MAX_SPEED, 0, 1.35);

    this.rig.update(dt, this.car, this.corridor.path, this.sample, this.camera);
    this.car.syncTransform(this.corridor.path, this.sample, this.clock);

    this.sky.update(this.clock, this.camera.position);
    this.road.update(this.clock, this.camera.position);
    this.barriers.update(this.camera.position);
    this.city.update(this.clock, this.camera.position);
    this.storefront.update(this.clock);
    this.traffic.setCameraUniforms(this.camera.position, this.clock);
    this.car.setCameraUniforms(this.camera.position, this.clock);

    // Post reacts to the drive.
    this.post.speed01 = speed01;
    this.post.focal.copy(this.rig.focal);
    this.post.shake = Math.max(0, this.post.shake - dt * 3.6);
    this.post.flash = Math.max(0, this.post.flash - dt * 2.4);
    this.post.settings.bloom = 0.85 + speed01 * 0.28;
    this.post.settings.exposure = 1.02 + (this.input.state.boost ? 0.06 : 0);
    this.post.render(this.scene, this.camera, this.clock);

    // Audio follows the sim.
    this.audio.updateEngine(
      this.car.rpm,
      this.phase === 'running' ? 1 - this.input.state.brake * 0.7 : 0.25,
      this.car.speed * 3.6,
    );
    if (this.car.slip > 0.35 && this.phase === 'running') this.maybeSkid(dt, this.car.slip);

    // Telemetry for the HUD.
    const t = this.telemetry;
    t.timeLeft = Math.max(0, this.timeLeft);
    t.distanceLeft = Math.max(0, this.corridor.finishS - this.car.s);
    t.speedKph = this.car.speed * 3.6;
    t.boost = this.boost;
    t.combo = this.combo;
    t.comboAge = this.comboTimer;
    t.score = Math.round(this.score);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('orientationchange', this.resize);
    this.input.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}

export { SUN_DIR };
