/**
 * Mukbang Dash — procedural audio.
 *
 * Every sound in the game is synthesised at runtime. Zero audio assets ship,
 * which is the whole point: the boot budget is under two seconds on a phone and
 * a single decent engine loop would eat most of it.
 *
 * Two rules shape the design:
 *
 *  1. Nothing is allocated on the hot path. The engine, the wind bed, the
 *     tension drone and every sound that can retrigger quickly (skid, near-miss
 *     whoosh, UI tap) are *persistent* voices that are gated with gain
 *     envelopes rather than created and destroyed. Node churn during a run is
 *     what causes the audio thread to hitch, and a hitch at 200 km/h is
 *     immediately obvious. Rare, layered one-shots (crash, checkpoint, arrive)
 *     are allocated on demand and disconnect themselves on `ended`.
 *
 *  2. Continuous controls are driven with `setTargetAtTime`, never
 *     `setValueAtTime`. A per-frame step on a filter cutoff is audible as
 *     zipper noise and it is the single fastest way to make a synth engine
 *     sound cheap.
 *
 * Signal flow:
 *
 *     engine partials ─┐
 *     exhaust rasp ────┼─► drive ─► saturator ─► LP ─► body peak ─► shift gate ─┐
 *                                                                               ├─► bed ─┐
 *     wind + road noise ────────────────────────────────────────────────────────┘        │
 *                                                                                        ├─► master
 *     tension drone ─────────────────────────────────────────────────────────────────────┤
 *     sfx bus (+ chime delay send) ──────────────────────────────────────────────────────┘
 *
 *     master ─► mute gate ─► glue compressor (soft knee) ─► limiter ─► destination
 */

import type { AudioEngine } from '../contracts';

// ----------------------------------------------------------------- tuning ---

/** Bus levels, pre-compressor. Chosen so a full mix peaks just under the glue
 *  compressor's threshold and the limiter only ever catches transients. */
const MIX = {
  master: 0.8,
  bed: 1,
  engine: 0.45,
  wind: 0.34,
  sfx: 0.9,
  tension: 0.42,
} as const;

/** Engine fundamental (firing frequency) at idle and at the limiter, in Hz. */
const IDLE_HZ = 46;
const REDLINE_HZ = 194;

/** The exhaust rasp band tracks this multiple of the fundamental. */
const RASP_ORDER = 7.5;

/** Smoothing time constants for `setTargetAtTime`, in seconds. */
const TC_F0 = 0.035; // fast enough that the note feels welded to the throttle
const TC_TIMBRE = 0.06; // partial gains + cutoff: slower, hides quantised rpm
const TC_WIND = 0.13; // wind must not flutter frame to frame
const TC_TENSION = 0.3; // dread swells in, it never snaps in

/** Ceiling on simultaneously *allocated* one-shot sources. Pooled voices are
 *  bounded by construction and do not count. */
const MAX_ONESHOTS = 48;

/**
 * The engine's harmonic stack.
 *
 * Two detuned banks at the fundamental (`ratio: 1`) give the beating thickness
 * a single oscillator can never have — a real engine is many cylinders that
 * never fire at exactly the same instant. The half-order partial is the lopey
 * V8 burble: big cross-plane V8s put real energy at half the firing frequency,
 * and without it the whole thing reads as a generator, not a car.
 *
 * `lo`/`hi` are the partial's gain off-throttle and at full load. Upper
 * partials swelling with load is *the* cue the ear reads as "opening it up";
 * raising overall volume alone just sounds louder, not angrier.
 */
interface PartialSpec {
  ratio: number;
  type: OscillatorType;
  detune: number; // cents
  lo: number;
  hi: number;
}

const PARTIALS: readonly PartialSpec[] = [
  { ratio: 0.5, type: 'triangle', detune: 0, lo: 0.5, hi: 0.4 }, // half-order burble
  { ratio: 1, type: 'sawtooth', detune: -7, lo: 0.46, hi: 0.6 }, // bank A
  { ratio: 1, type: 'square', detune: 5, lo: 0.14, hi: 0.26 },
  { ratio: 1, type: 'sawtooth', detune: 9, lo: 0.3, hi: 0.44 }, // bank B
  { ratio: 1, type: 'square', detune: -12, lo: 0.09, hi: 0.19 },
  { ratio: 2, type: 'sawtooth', detune: 4, lo: 0.17, hi: 0.36 },
  { ratio: 3, type: 'triangle', detune: -6, lo: 0.09, hi: 0.24 },
  { ratio: 4, type: 'sawtooth', detune: 8, lo: 0.04, hi: 0.18 },
  { ratio: 6, type: 'triangle', detune: 0, lo: 0.015, hi: 0.1 }, // induction whine
];

/** Near-miss pips climb this ladder. Pentatonic so a long combo escalates
 *  without ever landing on a sour interval. */
const PIP_LADDER = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27];

// ---------------------------------------------------------------- helpers ---

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A single NaN reaching an AudioParam poisons it permanently: the node goes
 * silent for the rest of the session and nothing throws to tell you why. The
 * sim can hand us a NaN on a bad frame (divide by zero on a stopped car), so
 * every number crossing into the graph is laundered here first.
 */
function safe(v: number, fallback: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}

/** Exponential ramps are undefined through zero, so envelopes floor here. */
const EPS = 1e-4;

/**
 * Percussive envelope that restarts from wherever the param currently sits.
 * Slamming a stolen voice to zero before re-attacking ticks audibly; starting
 * the new attack from the old tail does not.
 */
function pluck(p: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  const from = Math.max(p.value, EPS);
  p.cancelScheduledValues(t);
  p.setValueAtTime(from, t);
  p.exponentialRampToValueAtTime(Math.max(peak, 2 * EPS), t + attack);
  p.exponentialRampToValueAtTime(EPS, t + attack + decay);
  // Park at hard zero so idle voices contribute nothing to the bus sum.
  p.setValueAtTime(0, t + attack + decay + 0.002);
}

/**
 * One-shot exponential sweep for a *frequency* param — filter and pitch
 * gestures. The 1 Hz floor is why this must never be pointed at a gain.
 */
function glide(p: AudioParam, t: number, from: number, to: number, time: number): void {
  p.cancelScheduledValues(t);
  p.setValueAtTime(Math.max(from, 1), t);
  p.exponentialRampToValueAtTime(Math.max(to, 1), t + Math.max(time, 0.001));
}

/**
 * An AudioParam plus its last commanded target.
 *
 * Continuous controls are written every frame; caching the target means a
 * parked car or a steady cruise stops touching the automation timeline
 * entirely, and it keeps the per-frame cost of `updateEngine` honest.
 */
class Slewed {
  private readonly p: AudioParam;
  private readonly tc: number;
  private readonly eps: number;
  private last = Number.NaN;

  constructor(p: AudioParam, tc: number, eps: number) {
    this.p = p;
    this.tc = tc;
    this.eps = eps;
  }

  set(t: number, v: number): void {
    if (Math.abs(v - this.last) < this.eps) return;
    this.last = v;
    this.p.setTargetAtTime(v, t, this.tc);
  }
}

/**
 * Pink (1/f) noise, generated once and shared by every noise voice in the game.
 *
 * White noise reads as hiss. Wind, tyre roar and skids are all pink or darker,
 * and baking the tilt into the source means the wind bed needs far less EQ to
 * stop sounding like a hi-hat. Filter cascade is Paul Kellet's economical
 * approximation — accurate to about ±0.05 dB across the audible band and cheap
 * enough to run over a few hundred thousand samples at boot.
 */
function makeNoiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }

  // Unlike white noise, pink noise carries real low-frequency energy, so a raw
  // loop point thumps once per lap. Cross-fade the tail back over the head.
  const fade = Math.min(Math.floor(ctx.sampleRate * 0.03), n >> 2);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[i] = d[i] * k + d[n - fade + i] * (1 - k);
  }
  return buf;
}

/**
 * Soft-clip transfer curve (normalised tanh).
 *
 * The saturator is what turns a stack of oscillators into an *engine*: it adds
 * the dense, load-dependent upper harmonics that additive synthesis alone can
 * only fake with dozens more voices, and it glues the banks together so they
 * stop sounding like separate oscillators.
 */
// Return type is inferred rather than annotated: lib.dom types `curve` as
// Float32Array<ArrayBuffer>, and a bare `Float32Array` annotation widens the
// buffer parameter to ArrayBufferLike, which will not assign back.
function makeSaturationCurve(drive: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

// ------------------------------------------------------------ pooled voice ---

/**
 * A retriggerable noise voice.
 *
 * The source is the shared, free-running noise loop, so a retrigger is nothing
 * but an envelope: no node churn, no GC pressure, and — because the loop keeps
 * running underneath — every hit lands on a different slice of noise, so rapid
 * repeats never sound cloned.
 */
class NoiseVoice {
  private readonly filter: BiquadFilterNode;
  private readonly gain: GainNode;
  private readonly panner: StereoPannerNode | null;

  constructor(
    ctx: AudioContext,
    noise: AudioNode,
    dest: AudioNode,
    type: BiquadFilterType,
    q: number,
    panned: boolean,
  ) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = type;
    this.filter.Q.value = q;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.panner =
      panned && typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;

    noise.connect(this.filter).connect(this.gain);
    if (this.panner) this.gain.connect(this.panner).connect(dest);
    else this.gain.connect(dest);
  }

  trigger(
    t: number,
    level: number,
    attack: number,
    decay: number,
    fromHz: number,
    toHz: number,
    sweep: number,
    pan = 0,
  ): void {
    if (this.panner) this.panner.pan.setValueAtTime(clamp(pan, -1, 1), t);
    glide(this.filter.frequency, t, fromHz, toHz, sweep);
    pluck(this.gain.gain, t, level, attack, decay);
  }

  setQ(t: number, q: number): void {
    this.filter.Q.setValueAtTime(q, t);
  }
}

/**
 * A retriggerable tonal voice. Same trick as NoiseVoice: the oscillator runs
 * forever and only the gain is enveloped, which sidesteps the fact that an
 * OscillatorNode can never be restarted once stopped.
 */
class ToneVoice {
  private readonly osc: OscillatorNode;
  private readonly gain: GainNode;

  constructor(ctx: AudioContext, dest: AudioNode, type: OscillatorType) {
    this.osc = ctx.createOscillator();
    this.osc.type = type;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.osc.connect(this.gain).connect(dest);
    this.osc.start();
  }

  trigger(
    t: number,
    freq: number,
    toFreq: number,
    level: number,
    attack: number,
    decay: number,
  ): void {
    glide(this.osc.frequency, t, freq, toFreq, attack + decay);
    pluck(this.gain.gain, t, level, attack, decay);
  }
}

/** Options for a one-shot tonal layer. */
interface ToneSpec {
  type: OscillatorType;
  freq: number;
  /** Pitch target; omit for a steady note. */
  to?: number;
  /** Seconds to reach `to`. Defaults to the full envelope length. */
  bend?: number;
  level: number;
  attack: number;
  decay: number;
  detune?: number;
  /** Defaults to the sfx bus. */
  dest?: AudioNode;
  /** Extra send into the chime delay, 0..1. */
  send?: number;
  /** Delay before the note starts, seconds. */
  at?: number;
}

// -------------------------------------------------------------------- core ---

/**
 * The live graph. Constructed on the first user gesture (or the first sound),
 * never torn down. Throwing from the constructor is how we signal "no audio on
 * this device" — the facade catches it and degrades to silence.
 */
class AudioCore {
  readonly ctx: AudioContext;

  // Master chain.
  private readonly master: GainNode;
  private readonly muteGate: GainNode;

  // Buses.
  private readonly bed: GainNode; // engine + wind, gated by start/stop
  private readonly sfx: GainNode;
  private readonly tensionBus: GainNode;
  private readonly fxSend: GainNode; // into the chime delay

  // Shared noise.
  private readonly noiseBuf: AudioBuffer;
  private readonly noise: GainNode;

  // Engine.
  private readonly f0Src: ConstantSourceNode | null;
  private readonly oscs: { osc: OscillatorNode; gain: Slewed; spec: PartialSpec }[] = [];
  private readonly raspBP: BiquadFilterNode;
  private readonly raspGain: Slewed;
  private readonly drive: Slewed;
  private readonly lowpass: Slewed;
  private readonly body: Slewed;
  private readonly engineLoad: Slewed;
  private readonly engineBus: GainNode;
  private readonly shiftFilter: BiquadFilterNode;
  private readonly shiftDuck: GainNode;
  private readonly shiftBark: NoiseVoice;

  // Wind + road.
  private readonly windHP: Slewed;
  private readonly windGain: Slewed;
  private readonly roadGain: Slewed;

  // Tension drone.
  private readonly tensionLevel: Slewed;
  private readonly tensionLP: Slewed;
  private readonly tensionLfo: OscillatorNode;
  private readonly tensionDepth: Slewed;
  private readonly tensionDiss: Slewed;

  // Pools.
  private readonly skidPool: NoiseVoice[] = [];
  private readonly whooshPool: NoiseVoice[] = [];
  private readonly pipPool: ToneVoice[] = [];
  private readonly tapVoice: NoiseVoice;
  private skidNext = 0;
  private whooshNext = 0;
  private pipNext = 0;
  private whooshSide = 1;

  // Bookkeeping.
  private oneShots = 0;
  private running = false;
  private prevRpm = 0;
  private lastShiftAt = -1;
  private lastTapAt = -1;
  private lastSkidAt = -1;
  private muteFlag = false;

  constructor(muted: boolean, tension: number) {
    const Ctor = resolveAudioContext();
    if (!Ctor) throw new Error('no AudioContext');
    // `interactive` asks for the smallest buffer the device will give us —
    // a crash landing 100 ms after the impact frame feels broken.
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    // -- master chain --------------------------------------------------------
    // Glue first (soft knee, gentle ratio) to keep the mix cohesive when engine
    // + wind + tension + a crash all land together, then a fast brick-wall pass
    // purely as a safety net. Two stages doing a little each is far less
    // audible than one stage doing a lot.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;
    limiter.connect(ctx.destination);

    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -17;
    glue.knee.value = 26;
    glue.ratio.value = 2.8;
    glue.attack.value = 0.009;
    glue.release.value = 0.22;
    glue.connect(limiter);

    this.muteGate = ctx.createGain();
    this.muteGate.gain.value = muted ? 0 : 1;
    this.muteGate.connect(glue);
    this.muteFlag = muted;

    this.master = ctx.createGain();
    this.master.gain.value = MIX.master;
    this.master.connect(this.muteGate);

    // -- buses ---------------------------------------------------------------
    this.bed = ctx.createGain();
    this.bed.gain.value = 0; // raised by start()
    this.bed.connect(this.master);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = MIX.sfx;
    this.sfx.connect(this.master);

    this.tensionBus = ctx.createGain();
    this.tensionBus.gain.value = 0;
    this.tensionBus.connect(this.master);

    // A short dark feedback delay shared by the chimes and pips. Costs three
    // nodes for the whole game and is the difference between "a beep" and
    // "a reward".
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.115;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const fxTone = ctx.createBiquadFilter();
    fxTone.type = 'lowpass';
    fxTone.frequency.value = 3200;
    this.fxSend = ctx.createGain();
    this.fxSend.gain.value = 1;
    this.fxSend.connect(delay);
    delay.connect(fb).connect(delay); // feedback loop
    delay.connect(fxTone).connect(this.sfx);

    // -- shared noise --------------------------------------------------------
    // One buffer, one free-running source, fanned out to every noise consumer.
    // Eight separate sources reading the same buffer would sound identical and
    // cost eight times as much.
    this.noiseBuf = makeNoiseBuffer(ctx, 3);
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this.noiseBuf;
    noiseSrc.loop = true;
    this.noise = ctx.createGain();
    // Kellet's constants land the generator around -30 dBFS RMS. Lift the whole
    // noise bus to a workable level once, here, instead of compensating inside
    // every voice that taps it.
    this.noise.gain.value = 2.6;
    noiseSrc.connect(this.noise);
    noiseSrc.start();

    // -- engine --------------------------------------------------------------
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = MIX.engine;
    this.engineBus.connect(this.bed);

    // Owned exclusively by the shift logic, so the per-frame code never fights
    // an envelope for the same param.
    this.shiftDuck = ctx.createGain();
    this.shiftDuck.gain.value = 1;
    this.shiftDuck.connect(this.engineBus);

    this.shiftFilter = ctx.createBiquadFilter();
    this.shiftFilter.type = 'lowpass';
    this.shiftFilter.frequency.value = 20000;
    this.shiftFilter.Q.value = 0.7;
    this.shiftFilter.connect(this.shiftDuck);

    const loadGain = ctx.createGain();
    loadGain.gain.value = 0.6;
    loadGain.connect(this.shiftFilter);
    this.engineLoad = new Slewed(loadGain.gain, TC_TIMBRE, 0.004);

    // Fixed-ish resonance around 90-140 Hz. This is the car's body and exhaust
    // box ringing, not a harmonic, so it barely moves with rpm — it just gets
    // pushed harder under load. It is where the chest thump lives.
    const bodyPeak = ctx.createBiquadFilter();
    bodyPeak.type = 'peaking';
    bodyPeak.frequency.value = 105;
    bodyPeak.Q.value = 1.15;
    bodyPeak.gain.value = 8;
    bodyPeak.connect(loadGain);
    this.body = new Slewed(bodyPeak.frequency, TC_TIMBRE, 0.5);

    // Tames the fizz the saturator adds up top without dulling the roar.
    const tilt = ctx.createBiquadFilter();
    tilt.type = 'highshelf';
    tilt.frequency.value = 3400;
    tilt.gain.value = -7;
    tilt.connect(bodyPeak);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = 1.1; // slight resonance at the cutoff = bite, not mud
    lp.connect(tilt);
    this.lowpass = new Slewed(lp.frequency, TC_TIMBRE, 4);

    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSaturationCurve(2.4);
    // 2x is the sweet spot on mobile: enough to keep a saturated sawtooth from
    // folding aliases back down into the midrange, without the cost of 4x on a
    // voice that runs for the entire session.
    shaper.oversample = '2x';
    shaper.connect(lp);

    const driveGain = ctx.createGain();
    driveGain.gain.value = 0.5;
    driveGain.connect(shaper);
    this.drive = new Slewed(driveGain.gain, TC_TIMBRE, 0.004);

    const sum = ctx.createGain();
    sum.gain.value = 0.34; // headroom for nine partials summing in phase
    sum.connect(driveGain);

    // Drive the whole harmonic stack from one control signal. Slewing a single
    // ConstantSourceNode keeps every partial in exact ratio through a sweep;
    // slewing nine oscillators independently lets them drift apart mid-ramp and
    // the stack smears.
    this.f0Src = typeof ctx.createConstantSource === 'function' ? ctx.createConstantSource() : null;
    const f0Src = this.f0Src;
    const ratioFan = new Map<number, GainNode>();
    /** One scaling tap per distinct harmonic ratio, shared by the partials. */
    const fanFor = (ratio: number): GainNode | null => {
      if (!f0Src) return null;
      let g = ratioFan.get(ratio);
      if (!g) {
        g = ctx.createGain();
        g.gain.value = ratio;
        f0Src.connect(g);
        ratioFan.set(ratio, g);
      }
      return g;
    };
    if (f0Src) {
      f0Src.offset.value = IDLE_HZ;
      f0Src.start();
    }

    for (const spec of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.detune.value = spec.detune;
      const fan = fanFor(spec.ratio);
      if (fan) {
        osc.frequency.value = 0; // frequency comes entirely from the fan signal
        fan.connect(osc.frequency);
      } else {
        osc.frequency.value = IDLE_HZ * spec.ratio;
      }
      const g = ctx.createGain();
      g.gain.value = spec.lo;
      osc.connect(g).connect(sum);
      osc.start();
      this.oscs.push({ osc, gain: new Slewed(g.gain, TC_TIMBRE, 0.003), spec });
    }

    // Induction/exhaust rasp: a band of noise riding a high engine order. Pure
    // oscillators sound synthetic because a real intake is half air noise.
    this.raspBP = ctx.createBiquadFilter();
    this.raspBP.type = 'bandpass';
    this.raspBP.Q.value = 0.8;
    const raspFan = fanFor(RASP_ORDER);
    if (raspFan) {
      this.raspBP.frequency.value = 0;
      raspFan.connect(this.raspBP.frequency);
    } else {
      this.raspBP.frequency.value = IDLE_HZ * RASP_ORDER;
    }
    const raspG = ctx.createGain();
    raspG.gain.value = 0.02;
    this.noise.connect(this.raspBP).connect(raspG).connect(sum);
    this.raspGain = new Slewed(raspG.gain, TC_TIMBRE, 0.002);

    this.shiftBark = new NoiseVoice(ctx, this.noise, this.engineBus, 'bandpass', 1.6, false);

    // -- wind + road ---------------------------------------------------------
    const windOut = ctx.createGain();
    windOut.gain.value = MIX.wind;
    windOut.connect(this.bed);

    const windLevel = ctx.createGain();
    windLevel.gain.value = 0;
    windLevel.connect(windOut);
    this.windGain = new Slewed(windLevel.gain, TC_WIND, 0.002);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.7;
    hp.connect(windLevel);
    this.windHP = new Slewed(hp.frequency, TC_WIND, 3);
    this.noise.connect(hp);

    // Gusting. A perfectly steady band of noise reads as tape hiss; a slow
    // wobble on the cutoff reads as air moving past a windscreen.
    const gust = ctx.createOscillator();
    gust.type = 'sine';
    gust.frequency.value = 0.13;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 130;
    gust.connect(gustDepth).connect(hp.frequency);
    gust.start();

    // Tyre roar sits an octave or two below the wind and carries the sense of
    // contact with the road.
    const roadLP = ctx.createBiquadFilter();
    roadLP.type = 'lowpass';
    roadLP.frequency.value = 190;
    roadLP.Q.value = 1.4;
    const roadLevel = ctx.createGain();
    roadLevel.gain.value = 0;
    this.noise.connect(roadLP).connect(roadLevel).connect(windOut);
    this.roadGain = new Slewed(roadLevel.gain, TC_WIND, 0.002);

    // -- tension drone -------------------------------------------------------
    const tSum = ctx.createGain();
    tSum.gain.value = 0.5;

    const tLP = ctx.createBiquadFilter();
    tLP.type = 'lowpass';
    tLP.frequency.value = 160;
    tLP.Q.value = 2.4;
    tSum.connect(tLP);
    this.tensionLP = new Slewed(tLP.frequency, TC_TENSION, 2);

    // The pulse gate. Its intrinsic value is the floor and the LFO sums on top,
    // so at depth 0 the drone is dead steady and at depth 1 it gasps.
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    tLP.connect(pulse).connect(this.tensionBus);

    this.tensionLfo = ctx.createOscillator();
    this.tensionLfo.type = 'sine';
    this.tensionLfo.frequency.value = 1.4;
    const depth = ctx.createGain();
    depth.gain.value = 0;
    this.tensionLfo.connect(depth).connect(pulse.gain);
    this.tensionLfo.start();
    this.tensionDepth = new Slewed(depth.gain, TC_TENSION, 0.004);

    const tSub = ctx.createOscillator();
    tSub.type = 'sine';
    tSub.frequency.value = 41.2; // low E, under everything else in the mix
    tSub.connect(tSum);
    tSub.start();

    const tSaw = ctx.createOscillator();
    tSaw.type = 'sawtooth';
    tSaw.frequency.value = 82.4;
    tSaw.detune.value = -9;
    const tSawG = ctx.createGain();
    tSawG.gain.value = 0.35;
    tSaw.connect(tSawG).connect(tSum);
    tSaw.start();

    // A minor second above the drone, faded in only in the last stretch. It is
    // genuinely unpleasant, which is the point — but at v < 0.45 it is silent.
    const tDiss = ctx.createOscillator();
    tDiss.type = 'sine';
    tDiss.frequency.value = 87.3;
    const tDissG = ctx.createGain();
    tDissG.gain.value = 0;
    tDiss.connect(tDissG).connect(tSum);
    tDiss.start();
    this.tensionDiss = new Slewed(tDissG.gain, TC_TENSION, 0.004);

    this.tensionLevel = new Slewed(this.tensionBus.gain, TC_TENSION, 0.002);

    // -- pools ---------------------------------------------------------------
    for (let i = 0; i < 2; i++) {
      this.skidPool.push(new NoiseVoice(ctx, this.noise, this.sfx, 'bandpass', 5, true));
    }
    for (let i = 0; i < 3; i++) {
      this.whooshPool.push(new NoiseVoice(ctx, this.noise, this.sfx, 'bandpass', 1.4, true));
    }
    for (let i = 0; i < 3; i++) {
      this.pipPool.push(new ToneVoice(ctx, this.sfx, 'triangle'));
    }
    this.tapVoice = new NoiseVoice(ctx, this.noise, this.sfx, 'bandpass', 1.1, false);

    // Apply whatever state the facade accumulated before the graph existed.
    this.setTension(tension);

    // iOS drops the context to 'interrupted' on a phone call or Siri and never
    // recovers on its own; nudge it whenever it leaves 'running'.
    ctx.addEventListener('statechange', () => {
      if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    });
  }

  // ------------------------------------------------------------ lifecycle ---

  async unlock(): Promise<void> {
    try {
      if (this.ctx.state !== 'running') await this.ctx.resume();
    } catch {
      /* Autoplay policy said no. The next gesture will try again. */
    }
    try {
      // iOS Safari will report a running context and still route nothing until
      // a buffer has actually been played from inside a gesture. One silent
      // sample is enough to open the route.
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      src.connect(this.ctx.destination);
      src.start(0);
      src.addEventListener('ended', () => src.disconnect(), { once: true });
    } catch {
      /* Nothing we can do; the graph still works if the context is live. */
    }
  }

  start(): void {
    this.running = true;
    this.prevRpm = 0;
    const t = this.ctx.currentTime;
    this.bed.gain.cancelScheduledValues(t);
    this.bed.gain.setTargetAtTime(MIX.bed, t, 0.08);
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
  }

  stop(): void {
    this.running = false;
    const t = this.ctx.currentTime;
    this.bed.gain.cancelScheduledValues(t);
    this.bed.gain.setTargetAtTime(0, t, 0.12);
    // The run is over, so the clock drone goes with it. The UI can bring it
    // back with setTension() if it wants one on a menu.
    this.setTension(0);
  }

  // --------------------------------------------------------------- engine ---

  updateEngine(rpm01: number, load: number, speedKph: number): void {
    const t = this.ctx.currentTime;
    const rpm = safe(rpm01, 0, 0, 1);
    const ld = safe(load, 0, 0, 1);
    const kph = safe(speedKph, 0, 0, 400);

    // Slightly super-linear so the top of the rev range stretches out and the
    // limiter feels like a wall rather than the end of a straight line.
    const f0 = IDLE_HZ + (REDLINE_HZ - IDLE_HZ) * Math.pow(rpm, 1.15);
    if (this.f0Src) {
      this.f0Src.offset.setTargetAtTime(f0, t, TC_F0);
    } else {
      for (const p of this.oscs) p.osc.frequency.setTargetAtTime(f0 * p.spec.ratio, t, TC_F0);
      this.raspBP.frequency.setTargetAtTime(f0 * RASP_ORDER, t, TC_F0);
    }

    // Timbre follows load more than revs: an engine coasting at 6000 rpm is a
    // whine, the same 6000 rpm under full throttle is a roar.
    const bright = 0.35 * rpm + 0.65 * ld;
    for (const p of this.oscs) {
      p.gain.set(t, p.spec.lo + (p.spec.hi - p.spec.lo) * bright);
    }

    this.drive.set(t, 0.45 + ld * 0.95);
    this.lowpass.set(t, 320 + ld * 2400 + rpm * 2700);
    this.body.set(t, 96 + ld * 38); // stays inside the 90-140 Hz chest band
    this.engineLoad.set(t, 0.45 + ld * 0.55);
    this.raspGain.set(t, 0.015 + ld * 0.075 + rpm * 0.03);

    // Wind and road are speed-only: lifting off at 200 km/h must not make the
    // world go quiet, it just takes the engine away.
    const sn = clamp(kph / 220, 0, 1.25);
    this.windGain.set(t, Math.pow(sn, 1.6) * 0.85);
    this.windHP.set(t, 320 + sn * 1550);
    this.roadGain.set(t, Math.pow(sn, 1.25) * 0.5);

    this.detectShift(t, rpm, ld, kph);
  }

  /**
   * Upshifts are inferred, not signalled: the sim sweeps rpm01 up and snaps it
   * back down when it changes gear, so a sharp drop while still accelerating is
   * a shift. Doing it here keeps the audio module free of gearbox state.
   */
  private detectShift(t: number, rpm: number, load: number, kph: number): void {
    const prev = this.prevRpm;
    this.prevRpm = rpm;
    if (!this.running) return;
    // Only a real reset counts: a big drop, from high in the range, while
    // actually moving, and never twice in quick succession — a stuttering sim
    // must not machine-gun barks.
    if (prev - rpm < 0.14 || prev < 0.5 || kph < 18) return;
    if (t - this.lastShiftAt < 0.22) return;
    this.lastShiftAt = t;

    // The shift itself: a hard, short duck plus a filter slam. That ~90 ms hole
    // in the sound is what the ear reads as "the car just changed gear" — the
    // silence carries more information than any sample would.
    const duck = this.shiftDuck.gain;
    duck.cancelScheduledValues(t);
    duck.setValueAtTime(duck.value, t);
    duck.linearRampToValueAtTime(0.25, t + 0.018);
    duck.linearRampToValueAtTime(0.25, t + 0.055);
    duck.linearRampToValueAtTime(1, t + 0.19);

    const cut = this.shiftFilter.frequency;
    cut.cancelScheduledValues(t);
    cut.setValueAtTime(Math.max(cut.value, 1), t);
    cut.exponentialRampToValueAtTime(760, t + 0.016);
    cut.exponentialRampToValueAtTime(20000, t + 0.22);

    // Overrun bark out of the exhaust on the way back in, louder the harder
    // you were driving.
    this.shiftBark.trigger(t + 0.05, 0.1 + load * 0.22, 0.004, 0.1, 1700, 620, 0.09);
  }

  // ------------------------------------------------------------------ sfx ---

  skid(intensity: number): void {
    const t = this.ctx.currentTime;
    if (t - this.lastSkidAt < 0.06) return;
    this.lastSkidAt = t;
    const i = safe(intensity, 0.5, 0, 1);
    const v = this.skidPool[this.skidNext];
    this.skidNext = (this.skidNext + 1) % this.skidPool.length;
    // Rubber squeals higher as it is worked harder, and the band tightens with
    // it — a hard skid is nearly a pitched tone.
    v.setQ(t, 4 + i * 4);
    v.trigger(
      t,
      0.25 + i * 0.5,
      0.008,
      0.22 + i * 0.28,
      1000 + i * 1500,
      1300 + i * 2600,
      0.16,
      (Math.random() * 2 - 1) * 0.35,
    );
  }

  crash(): void {
    const t = this.ctx.currentTime;
    const ctx = this.ctx;

    // 1. Impact. A sine dropping fast through the floor of hearing is the
    //    cheapest convincing "something heavy just stopped" there is.
    this.tone(t, {
      type: 'sine',
      freq: 165,
      to: 32,
      bend: 0.22,
      level: 0.9,
      attack: 0.004,
      decay: 0.5,
    });
    this.tone(t, {
      type: 'triangle',
      freq: 92,
      to: 40,
      bend: 0.16,
      level: 0.5,
      attack: 0.003,
      decay: 0.3,
    });

    // 2. Metal. Bandpassed noise through a short feedback delay. The comb rakes
    //    the noise band into a dense ladder of peaks 1/delayTime apart, which is
    //    exactly what a struck steel panel does and what hiss alone never will.
    //    Note the delay cannot go below one render quantum (~2.7 ms) inside a
    //    feedback cycle — asking for less silently gets rounded up, so pick a
    //    value above it and tune the character with the bandpass instead.
    const metalSrc = this.burst(t, 1.9, 0.42);
    const metalBP = ctx.createBiquadFilter();
    metalBP.type = 'bandpass';
    metalBP.frequency.value = 2400;
    metalBP.Q.value = 1.8;
    const comb = ctx.createDelay(0.02);
    comb.delayTime.value = 0.0034;
    const combFb = ctx.createGain();
    combFb.gain.value = 0.62;
    const metalG = ctx.createGain();
    metalG.gain.value = 0;
    metalSrc.connect(metalBP).connect(comb).connect(metalG).connect(this.sfx);
    comb.connect(combFb).connect(comb);
    // Dry bandpass alongside the comb keeps the initial crunch from being
    // swallowed by the resonance.
    metalBP.connect(metalG);
    pluck(metalG.gain, t, 0.4, 0.004, 0.34);
    glide(metalBP.frequency, t, 3200, 1500, 0.3);
    this.reap(metalSrc, metalBP, comb, combFb, metalG);

    // 3. Tail. Debris and body wobble settling.
    const tailSrc = this.burst(t + 0.01, 0.85, 0.9);
    const tailLP = ctx.createBiquadFilter();
    tailLP.type = 'lowpass';
    tailLP.frequency.value = 1800;
    tailLP.Q.value = 0.9;
    const tailG = ctx.createGain();
    tailG.gain.value = 0;
    tailSrc.connect(tailLP).connect(tailG).connect(this.sfx);
    pluck(tailG.gain, t + 0.01, 0.3, 0.02, 0.8);
    glide(tailLP.frequency, t + 0.01, 1800, 190, 0.8);
    this.reap(tailSrc, tailLP, tailG);
  }

  nearMiss(combo: number): void {
    const t = this.ctx.currentTime;
    const c = Math.max(1, Math.round(safe(combo, 1, 1, 999)));

    // Doppler: the whole point is the *rate* of the downward sweep. Slow and it
    // is a gust; this fast and it is something solid passing your door.
    const w = this.whooshPool[this.whooshNext];
    this.whooshNext = (this.whooshNext + 1) % this.whooshPool.length;
    this.whooshSide = -this.whooshSide;
    w.trigger(t, 0.42, 0.014, 0.3, 2700, 240, 0.26, this.whooshSide * 0.7);

    // Escalation pip, climbing a pentatonic ladder with the combo so a long
    // chain keeps paying off instead of flattening out.
    const semi = PIP_LADDER[Math.min(c - 1, PIP_LADDER.length - 1)];
    const f = 587.33 * Math.pow(2, semi / 12);
    const p = this.pipPool[this.pipNext];
    this.pipNext = (this.pipNext + 1) % this.pipPool.length;
    p.trigger(t + 0.03, f, f * 1.06, 0.16 + Math.min(c, 8) * 0.012, 0.004, 0.13);
  }

  checkpoint(): void {
    const t = this.ctx.currentTime;
    const ctx = this.ctx;
    if (!this.budget(12)) return;

    // Warm rather than glassy: one shared lowpass across the whole arpeggio,
    // so the top notes do not spike over the engine.
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 4600;
    warm.Q.value = 0.6;
    const out = ctx.createGain();
    out.gain.value = 0.34;
    warm.connect(out).connect(this.sfx);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    out.connect(send).connect(this.fxSend);

    const base = 523.25; // C5
    const semis = [0, 4, 7, 12, 16, 19]; // major triad, two octaves
    // The shared filter and output must outlive every note, and because the low
    // notes ring longest that is not necessarily the last note triggered.
    let last: OscillatorNode | null = null;
    let lastEnd = -1;
    for (let i = 0; i < semis.length; i++) {
      const f = base * Math.pow(2, semis[i] / 12);
      const at = i * 0.058;
      const decay = 0.5 + (semis.length - i) * 0.07; // low notes sustain
      const end = at + 0.005 + decay;
      const osc = this.tone(t, {
        type: 'triangle',
        freq: f,
        level: 0.4,
        attack: 0.005,
        decay,
        at,
        dest: warm,
      });
      if (end > lastEnd) {
        lastEnd = end;
        last = osc;
      }
      // A quiet octave doubling is what makes a synthesised chime read as a
      // struck bell rather than a flute.
      this.tone(t, {
        type: 'sine',
        freq: f * 2,
        level: 0.13,
        attack: 0.004,
        decay: decay * 0.6,
        at,
        dest: warm,
      });
    }
    if (last) this.reap(last, warm, out, send);
  }

  countdownBeep(final: boolean): void {
    const t = this.ctx.currentTime;
    if (!this.budget(3)) return;
    // F5 for the ticks, C6 for GO — a rising fifth, so the last pip resolves
    // upward instead of just being the same beep again but louder.
    const f = final ? 1046.5 : 698.46;
    const decay = final ? 0.36 : 0.12;
    this.tone(t, {
      type: 'triangle',
      freq: f,
      to: final ? f * 1.012 : undefined, // tiny upward bend = urgency
      bend: decay,
      level: final ? 0.46 : 0.32,
      attack: 0.003,
      decay,
      send: final ? 0.4 : 0,
    });
    this.tone(t, {
      type: 'sine',
      freq: f * 2,
      level: final ? 0.14 : 0.09,
      attack: 0.003,
      decay: decay * 0.5,
    });
  }

  arrive(): void {
    const t = this.ctx.currentTime;
    const ctx = this.ctx;

    // sus4 -> maj9. The suspension holds for a beat and then lands, which is
    // what makes it read as "you made it" instead of just "a chord".
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 500;
    warm.Q.value = 0.8;
    const out = ctx.createGain();
    out.gain.value = 0.3;
    warm.connect(out).connect(this.sfx);
    const send = ctx.createGain();
    send.gain.value = 0.22;
    out.connect(send).connect(this.fxSend);
    // Filter opens on the stab and settles back — the classic "brass" gesture.
    glide(warm.frequency, t, 520, 2900, 0.09);
    warm.frequency.exponentialRampToValueAtTime(900, t + 1.6);

    const base = 261.63; // C4
    const sus = [0, 5, 7, 12, 19];
    const maj = [0, 4, 7, 11, 14, 19];
    let last: OscillatorNode | null = null;

    for (const s of sus) {
      last = this.tone(t, {
        type: 'sawtooth',
        freq: base * Math.pow(2, s / 12),
        level: 0.16,
        attack: 0.012,
        decay: 0.3,
        detune: (Math.random() * 2 - 1) * 7,
        dest: warm,
      });
    }
    for (const s of maj) {
      last = this.tone(t, {
        type: 'sawtooth',
        freq: base * Math.pow(2, s / 12),
        level: 0.16,
        attack: 0.02,
        decay: 1.5,
        detune: (Math.random() * 2 - 1) * 7,
        at: 0.24,
        dest: warm,
      });
    }
    // Sub under the resolution for weight.
    this.tone(t, {
      type: 'sine',
      freq: base * 0.5,
      level: 0.4,
      attack: 0.02,
      decay: 1.4,
      at: 0.24,
      dest: warm,
    });
    if (last) this.reap(last, warm, out, send);
  }

  uiTap(): void {
    const t = this.ctx.currentTime;
    if (t - this.lastTapAt < 0.03) return; // a dragged finger must not machine-gun
    this.lastTapAt = t;
    this.tapVoice.trigger(t, 0.18, 0.001, 0.035, 1900, 1150, 0.03);
  }

  // -------------------------------------------------------------- tension ---

  setTension(v: number): void {
    const t = this.ctx.currentTime;
    const x = safe(v, 0, 0, 1);
    // Curved hard so the drone stays genuinely out of the way early on: at
    // x = 0.2 it is a fifth of a fifth, not a fifth.
    this.tensionLevel.set(t, Math.pow(x, 1.7) * MIX.tension);
    this.tensionLP.set(t, 150 + x * 520);
    this.tensionDepth.set(t, x * 0.48);
    this.tensionLfo.frequency.setTargetAtTime(1.4 + x * 4.1, t, TC_TENSION);
    // Dissonance is held back until the last third — used earlier it just reads
    // as an out-of-tune synth.
    this.tensionDiss.set(t, Math.max(0, x - 0.45) / 0.55 * 0.3);
  }

  // ----------------------------------------------------------------- mute ---

  setMuted(m: boolean): void {
    this.muteFlag = m;
    const t = this.ctx.currentTime;
    const g = this.muteGate.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    // 25 ms rather than a step: an instant gate on a running engine clicks.
    g.linearRampToValueAtTime(m ? 0 : 1, t + 0.025);
  }

  get muted(): boolean {
    return this.muteFlag;
  }

  // -------------------------------------------------------------- plumbing ---

  /** Room for another allocated one-shot? */
  private budget(cost: number): boolean {
    return this.oneShots + cost <= MAX_ONESHOTS;
  }

  /**
   * Register a finished-when-the-source-ends teardown. Every allocated one-shot
   * goes through here; without it a long session quietly accumulates thousands
   * of orphaned nodes and the audio thread grinds to a halt.
   */
  private reap(src: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
    this.oneShots++;
    src.addEventListener(
      'ended',
      () => {
        this.oneShots--;
        src.disconnect();
        for (const n of nodes) n.disconnect();
      },
      { once: true },
    );
  }

  /** A short, self-terminating slice of the shared noise buffer. */
  private burst(t: number, rate: number, dur: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    // Playing pink noise fast tilts its spectrum up, which is a free way to get
    // a brighter "white-ish" crack out of one buffer.
    src.playbackRate.value = rate;
    // Random entry point so no two crashes are bit-identical.
    src.start(t, Math.random() * Math.max(0.05, this.noiseBuf.duration - dur * rate - 0.05));
    src.stop(t + dur);
    return src;
  }

  /** One allocated tonal layer, wired, enveloped and scheduled for teardown. */
  private tone(t: number, spec: ToneSpec): OscillatorNode {
    const ctx = this.ctx;
    const at = t + (spec.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = spec.type;
    if (spec.detune) osc.detune.value = spec.detune;
    osc.frequency.setValueAtTime(Math.max(spec.freq, 1), at);
    if (spec.to !== undefined && spec.to !== spec.freq) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(spec.to, 1),
        at + Math.max(spec.bend ?? spec.attack + spec.decay, 0.001),
      );
    }
    const g = ctx.createGain();
    g.gain.value = 0;
    pluck(g.gain, at, spec.level, spec.attack, spec.decay);
    osc.connect(g);
    g.connect(spec.dest ?? this.sfx);
    if (spec.send) {
      const s = ctx.createGain();
      s.gain.value = spec.send;
      g.connect(s).connect(this.fxSend);
      osc.start(at);
      osc.stop(at + spec.attack + spec.decay + 0.05);
      this.reap(osc, g, s);
      return osc;
    }
    osc.start(at);
    osc.stop(at + spec.attack + spec.decay + 0.05);
    this.reap(osc, g);
    return osc;
  }
}

// ------------------------------------------------------------------ facade ---

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

interface LegacyAudioWindow {
  webkitAudioContext?: AudioContextCtor;
}

function resolveAudioContext(): AudioContextCtor | null {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  const legacy = globalThis as unknown as LegacyAudioWindow;
  return legacy.webkitAudioContext ?? null;
}

/**
 * Public face of the audio module.
 *
 * The real graph is built lazily on the first gesture-driven call, because a
 * context created outside a gesture starts suspended on iOS and Chrome logs an
 * autoplay warning. Everything here is defensive by design: if the device has
 * no Web Audio, or the constructor throws, or a browser bug takes a node down
 * mid-run, the game keeps running silently. Audio never takes the game with it.
 */
class MukbangAudio implements AudioEngine {
  private core: AudioCore | null = null;
  private failed = false;
  private mutedFlag = false;
  private tensionValue = 0;
  private wantStart = false;

  /** Build the graph on demand. Returns null once we know it cannot be built. */
  private ensure(): AudioCore | null {
    if (this.core) return this.core;
    if (this.failed) return null;
    try {
      this.core = new AudioCore(this.mutedFlag, this.tensionValue);
      if (this.wantStart) this.core.start();
    } catch {
      this.failed = true;
      this.core = null;
    }
    return this.core;
  }

  async unlock(): Promise<void> {
    const core = this.ensure();
    if (!core) return;
    try {
      await core.unlock();
    } catch {
      /* never throw out of the audio module */
    }
  }

  start(): void {
    this.wantStart = true;
    try {
      this.ensure()?.start();
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    this.wantStart = false;
    try {
      this.core?.stop();
    } catch {
      /* ignore */
    }
    this.tensionValue = 0;
  }

  // Per-frame: never builds the graph. A rAF loop is not a user gesture, and
  // spinning up a context from one is both rude and useless.
  updateEngine(rpm01: number, load: number, speedKph: number): void {
    try {
      this.core?.updateEngine(rpm01, load, speedKph);
    } catch {
      /* ignore */
    }
  }

  skid(intensity: number): void {
    try {
      this.ensure()?.skid(intensity);
    } catch {
      /* ignore */
    }
  }

  crash(): void {
    try {
      this.ensure()?.crash();
    } catch {
      /* ignore */
    }
  }

  nearMiss(combo: number): void {
    try {
      this.ensure()?.nearMiss(combo);
    } catch {
      /* ignore */
    }
  }

  checkpoint(): void {
    try {
      this.ensure()?.checkpoint();
    } catch {
      /* ignore */
    }
  }

  countdownBeep(final: boolean): void {
    try {
      this.ensure()?.countdownBeep(final);
    } catch {
      /* ignore */
    }
  }

  arrive(): void {
    try {
      this.ensure()?.arrive();
    } catch {
      /* ignore */
    }
  }

  uiTap(): void {
    try {
      this.ensure()?.uiTap();
    } catch {
      /* ignore */
    }
  }

  setTension(v: number): void {
    this.tensionValue = Number.isFinite(v) ? clamp(v, 0, 1) : 0;
    try {
      this.core?.setTension(this.tensionValue);
    } catch {
      /* ignore */
    }
  }

  setMuted(m: boolean): void {
    this.mutedFlag = m;
    try {
      this.core?.setMuted(m);
    } catch {
      /* ignore */
    }
  }

  get muted(): boolean {
    return this.mutedFlag;
  }
}

/**
 * Build the game's audio engine. Always succeeds — on a device with no usable
 * Web Audio the returned engine is a silent no-op with the same surface.
 */
export function createAudioEngine(): AudioEngine {
  return new MukbangAudio();
}
