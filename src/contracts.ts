/**
 * Shared contracts between the engine core and the bolt-on modules
 * (audio, UI, net). Everything here is stable — modules code against this,
 * never against each other.
 */

export type Phase = 'boot' | 'title' | 'countdown' | 'running' | 'arrived' | 'failed';

export type CameraMode = 'chase' | 'topdown';

/** The five Love Mukbang branches. Leaderboards are per-branch. */
export const BRANCHES = [
  { id: 'dwtc', name: 'Dubai World Trade Centre' },
  { id: 'jbr', name: 'JBR' },
  { id: 'deira', name: 'Deira' },
  { id: 'muroor', name: 'Muroor, Abu Dhabi' },
  { id: 'electra', name: 'Electra, Abu Dhabi' },
] as const;

export type BranchId = (typeof BRANCHES)[number]['id'];

/** Live telemetry the HUD reads every frame. Mutated in place — never reallocated. */
export interface Telemetry {
  phase: Phase;
  /** Seconds left on the clock. */
  timeLeft: number;
  /** Metres remaining to the storefront. */
  distanceLeft: number;
  /** Speed in km/h. */
  speedKph: number;
  /** 0..1 boost reservoir. */
  boost: number;
  /** Current near-miss combo multiplier, >= 1. */
  combo: number;
  /** Seconds since the last near-miss, used to fade the combo pip. */
  comboAge: number;
  score: number;
  /** Name of the last checkpoint cleared, for the "TIME EXTENDED" banner. */
  lastCheckpoint: string | null;
  /** Set for one frame when a checkpoint is cleared. */
  checkpointBonus: number;
  /** Set for one frame on a crash. */
  crashed: boolean;
  /** Set for one frame on a near miss. */
  nearMiss: boolean;
}

/** Final result handed to the win screen. */
export interface RunResult {
  /** Total elapsed seconds. */
  elapsed: number;
  /** Seconds still on the clock at arrival. */
  timeRemaining: number;
  score: number;
  topSpeedKph: number;
  nearMisses: number;
  branch: BranchId;
  cameraMode: CameraMode;
}

// ------------------------------------------------------------------ audio ---

export interface AudioEngine {
  /** Must be called from a user gesture. Resumes the AudioContext. */
  unlock(): Promise<void>;
  start(): void;
  stop(): void;
  /** Per-frame engine note. rpm01 0..1, load 0..1, speedKph for wind. */
  updateEngine(rpm01: number, load: number, speedKph: number): void;
  skid(intensity: number): void;
  crash(): void;
  nearMiss(combo: number): void;
  checkpoint(): void;
  countdownBeep(final: boolean): void;
  arrive(): void;
  uiTap(): void;
  /** Low-time tension layer, 0..1. */
  setTension(v: number): void;
  setMuted(m: boolean): void;
  readonly muted: boolean;
}

// -------------------------------------------------------------------- net ---

export interface VoucherResponse {
  /** The one-time code. ALWAYS server-issued — the client must never invent it. */
  code: string;
  /** Human-readable expiry, e.g. "31 Dec 2026". */
  expires?: string;
  /** Percentage off. Server decides; client only renders. */
  discountPercent?: number;
  /** Server-side id for redemption tracking. */
  voucherId?: string;
}

export type VoucherState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; voucher: VoucherResponse }
  | { status: 'error'; message: string };

export interface LeaderboardEntry {
  name: string;
  /** Elapsed seconds — lower is better. */
  elapsed: number;
  score: number;
  branch: BranchId;
  /** Epoch ms. */
  at: number;
  /** True for the entry just set by this player. */
  isYou?: boolean;
}

export interface Net {
  /**
   * Ask the server for a one-time discount code.
   * The client MUST NOT synthesise a code under any circumstances, including
   * network failure — on failure this rejects and the UI shows a retry.
   */
  claimVoucher(result: RunResult): Promise<VoucherResponse>;
  submitScore(result: RunResult, name: string): Promise<void>;
  leaderboard(branch: BranchId): Promise<LeaderboardEntry[]>;
}

// --------------------------------------------------------------------- ui ---

/** Callbacks the UI fires back into the game. */
export interface UiHost {
  startRun(): void;
  restart(): void;
  setCameraMode(m: CameraMode): void;
  getCameraMode(): CameraMode;
  audio: AudioEngine;
  net: Net;
  telemetry: Telemetry;
  /** Corridor attribution line for the credits panel. */
  attribution: { text: string; url?: string; isRealOSM: boolean };
}

export interface Ui {
  mount(host: UiHost): void;
  setPhase(p: Phase, result?: RunResult): void;
  /** Called every rendered frame, after the sim step. */
  tick(dt: number): void;
  /** Boot progress 0..1 while the world streams in. */
  setBootProgress(v: number): void;
}

export const WHATSAPP_URL = 'https://wa.me/971509963485';
