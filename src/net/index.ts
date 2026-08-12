/**
 * Net module — voucher claim + per-branch leaderboard.
 *
 * Two responsibilities, deliberately kept apart:
 *
 *   1. `claimVoucher` — talks to a *server* that mints one-time discount codes.
 *      This is the money path. Read the banner below before touching it.
 *   2. `submitScore` / `leaderboard` — a per-branch board. There is no backend
 *      yet, so it runs on a `LeaderboardStore` abstraction with a localStorage
 *      implementation. Point `VITE_LEADERBOARD_ENDPOINT` at a real API and the
 *      HTTP store takes over, with local as the offline fallback.
 *
 * Deploy-time configuration lives in two env vars and nothing else:
 *
 *   VITE_VOUCHER_ENDPOINT      required before launch — see VOUCHER_ENDPOINT_URL
 *   VITE_LEADERBOARD_ENDPOINT  optional — omit to stay on device-local storage
 */

import {
  BRANCHES,
  type BranchId,
  type LeaderboardEntry,
  type Net,
  type RunResult,
  type VoucherResponse,
} from '../contracts';

// ---------------------------------------------------------------- config ---

/**
 * Shape of the `import.meta.env` keys this module reads.
 *
 * Typed locally on purpose: the project does not pull in the `vite/client`
 * ambient types, and this module must also typecheck under a plain `tsc` run.
 * Vite replaces `import.meta.env` at build time, so the read below survives
 * bundling; outside Vite it is simply `undefined` and we fall back to `{}`.
 */
interface NetEnv {
  readonly VITE_VOUCHER_ENDPOINT?: string;
  readonly VITE_LEADERBOARD_ENDPOINT?: string;
}

const ENV: NetEnv = (import.meta as ImportMeta & { readonly env?: NetEnv }).env ?? {};

/** Empty / whitespace-only env vars count as "not set". */
function envString(raw: string | undefined): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.length > 0 ? s : undefined;
}

/**
 * The literal placeholder that ships in the repo. It is intentionally not a
 * URL: if it ever reaches `fetch()` something has gone wrong with the deploy,
 * and we would rather fail loudly than silently.
 */
export const VOUCHER_ENDPOINT_PLACEHOLDER = '[VOUCHER_ENDPOINT_URL]';

/**
 * Where voucher codes are minted.
 *
 * HOW TO CONFIGURE AT DEPLOY TIME — pick either:
 *   a) set `VITE_VOUCHER_ENDPOINT=https://api.example.ae/mukbang/voucher`
 *      in `.env.production` (or the host's env UI) before `npm run build`; or
 *   b) search-and-replace the literal string `[VOUCHER_ENDPOINT_URL]` in the
 *      built bundle with the real URL.
 *
 * A relative path (`/api/voucher`) is also accepted for same-origin deploys.
 * Until one of those happens, `claimVoucher` refuses to run — it does NOT
 * degrade, guess, or invent a code. See the banner on `claimVoucher`.
 */
export const VOUCHER_ENDPOINT_URL: string =
  envString(ENV.VITE_VOUCHER_ENDPOINT) ?? VOUCHER_ENDPOINT_PLACEHOLDER;

/**
 * Optional leaderboard API base. When unset (the default) the board is stored
 * on the device. Same swap-at-deploy pattern as the voucher endpoint.
 *
 * Expected contract when set:
 *   GET  <base>?branch=<id>  -> { entries: LeaderboardEntry[] } | LeaderboardEntry[]
 *   POST <base>              <- LeaderboardEntry (JSON body)
 */
export const LEADERBOARD_ENDPOINT_URL: string | null =
  envString(ENV.VITE_LEADERBOARD_ENDPOINT) ?? null;

/** Per-request timeout, milliseconds. Applied to every attempt separately. */
const REQUEST_TIMEOUT_MS = 8000;

/** Rows kept per branch. */
const LEADERBOARD_LIMIT = 20;

/** localStorage namespace. Bump the version to invalidate old boards. */
const STORAGE_PREFIX = 'mukbang-dash:lb:v1:';
const YOU_KEY = `${STORAGE_PREFIX}you`;

function looksLikeEndpoint(url: string): boolean {
  return url.startsWith('/') || /^https?:\/\//i.test(url);
}

/**
 * True once a real voucher endpoint has been configured. The win screen can
 * call this to hide the "claim" button on a misconfigured build instead of
 * offering a button that can only ever error.
 */
export function isVoucherEndpointConfigured(endpoint: string = VOUCHER_ENDPOINT_URL): boolean {
  return endpoint !== VOUCHER_ENDPOINT_PLACEHOLDER && looksLikeEndpoint(endpoint);
}

// ------------------------------------------------------------ http plumbing ---

type HttpOutcome =
  /** 2xx. `parsed` is false when the body was not valid JSON. */
  | { kind: 'ok'; status: number; body: unknown; parsed: boolean }
  /** Non-2xx response — the server was reached and answered. */
  | { kind: 'http'; status: number; body: unknown; parsed: boolean }
  /** Never reached the server (DNS, offline, CORS, abort/timeout). */
  | { kind: 'network'; error: unknown; timedOut: boolean };

interface JsonRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}

/**
 * One JSON round-trip with a hard AbortController timeout. Never throws —
 * every failure mode comes back as a typed `HttpOutcome` so callers can apply
 * their own retry policy.
 */
async function requestJson(req: JsonRequest): Promise<HttpOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);

  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: { Accept: 'application/json', ...req.headers },
      body: req.body,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors',
    });

    const text = await res.text();
    let body: unknown = null;
    let parsed = true;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        parsed = false;
        body = null;
      }
    }

    return res.ok
      ? { kind: 'ok', status: res.status, body, parsed }
      : { kind: 'http', status: res.status, body, parsed };
  } catch (error: unknown) {
    return { kind: 'network', error, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort human-readable error out of a server error body. */
function pickServerMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail'] as const) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim().slice(0, 200);
  }
  return null;
}

// -------------------------------------------------------- idempotency key ---

/**
 * A fresh client-generated key per claim attempt, reused across the retry so a
 * flaky connection can never mint two codes for one run.
 *
 * NOTE FOR FUTURE READERS: this is an *idempotency key*, not a discount code.
 * It is never shown to the player and must never be treated as one.
 */
function newIdempotencyKey(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  // Older Safari / non-secure contexts: build a v4 UUID from raw entropy.
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) hex.push(b[i]!.toString(16).padStart(2, '0'));
    return (
      `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-` +
      `${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
    );
  }

  // Absolute last resort. Uniqueness only — no security property is claimed,
  // and none is needed: the server issues the code, not us.
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// -------------------------------------------------------------- voucher ---

/** Exactly what goes on the wire. Kept explicit so the server contract is readable. */
interface VoucherClaimPayload {
  /** Same key across the retry — the server must return the same code for it. */
  idempotencyKey: string;
  claimedAt: string;
  client: { app: 'mukbang-dash'; schema: 1 };
  run: {
    elapsed: number;
    timeRemaining: number;
    score: number;
    branch: BranchId;
    topSpeedKph: number;
    nearMisses: number;
    cameraMode: RunResult['cameraMode'];
  };
}

function buildClaimPayload(result: RunResult, idempotencyKey: string): VoucherClaimPayload {
  return {
    idempotencyKey,
    claimedAt: new Date().toISOString(),
    client: { app: 'mukbang-dash', schema: 1 },
    run: {
      elapsed: round(result.elapsed, 3),
      timeRemaining: round(result.timeRemaining, 3),
      score: Math.round(result.score),
      branch: result.branch,
      topSpeedKph: round(result.topSpeedKph, 1),
      nearMisses: Math.max(0, Math.round(result.nearMisses)),
      cameraMode: result.cameraMode,
    },
  };
}

/**
 * Validate the server's answer before it is allowed anywhere near the UI.
 * `code` is the only required field, and it must be a non-empty string.
 */
function parseVoucherResponse(body: unknown): VoucherResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;

  const rawCode = rec['code'];
  if (typeof rawCode !== 'string') return null;
  const code = rawCode.trim();
  if (code.length === 0) return null;

  const voucher: VoucherResponse = { code };

  const expires = rec['expires'];
  if (typeof expires === 'string' && expires.trim().length > 0) voucher.expires = expires.trim();

  const pct = rec['discountPercent'];
  if (typeof pct === 'number' && Number.isFinite(pct)) voucher.discountPercent = pct;

  const id = rec['voucherId'];
  if (typeof id === 'string' && id.trim().length > 0) voucher.voucherId = id.trim();

  return voucher;
}

/* ===========================================================================
 * ██  READ THIS BEFORE EDITING claimVoucher  ██
 *
 * THE CLIENT MUST NEVER GENERATE, DERIVE, GUESS OR FABRICATE A DISCOUNT CODE.
 *
 * Every discount code is minted server-side and arrives over the wire. There
 * is no offline path, no cached code, no "temporary" code, no hash of the run
 * result, no `MUKBANG-${score}`, no demo code behind a flag. On ANY failure —
 * offline, DNS, CORS, timeout, non-2xx, unparsable body, missing/empty `code`,
 * or an unconfigured `[VOUCHER_ENDPOINT_URL]` placeholder — this function
 * REJECTS and the UI shows a retry.
 *
 * A code invented here is a real discount at a real till that the restaurant
 * never authorised and cannot reconcile or revoke. If you are here because
 * "the endpoint isn't ready yet": the fix is to stand up the endpoint, or to
 * hide the claim button via `isVoucherEndpointConfigured()`. It is never to
 * add a fallback. Do not add one. Reviewers: reject any PR that does.
 * ========================================================================= */
async function claimVoucher(result: RunResult, endpoint: string): Promise<VoucherResponse> {
  // Unconfigured placeholder: fail immediately, do not even attempt the fetch.
  if (!isVoucherEndpointConfigured(endpoint)) {
    throw new Error(
      'Voucher endpoint not configured — set VITE_VOUCHER_ENDPOINT (or replace the ' +
        `${VOUCHER_ENDPOINT_PLACEHOLDER} placeholder) with the voucher service URL before deploying.`,
    );
  }

  // Generated ONCE and reused by the retry, so a retry cannot mint two codes.
  const idempotencyKey = newIdempotencyKey();
  const body = JSON.stringify(buildClaimPayload(result, idempotencyKey));

  let lastMessage = 'Could not reach the voucher service. Please try again.';

  // Attempt 1, then at most one retry — and only for transient failures.
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await requestJson({
      url: endpoint,
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    if (outcome.kind === 'network') {
      // Offline / DNS / CORS / timeout — transient, worth exactly one retry.
      lastMessage = outcome.timedOut
        ? 'The voucher service took too long to answer. Please try again.'
        : 'Could not reach the voucher service. Check your connection and try again.';
      continue;
    }

    if (outcome.kind === 'http') {
      const detail = pickServerMessage(outcome.body);
      if (outcome.status >= 500) {
        // Server-side wobble — transient, worth exactly one retry.
        lastMessage = detail ?? `The voucher service is unavailable (HTTP ${outcome.status}).`;
        continue;
      }
      // 4xx (and anything else non-2xx): the server made a decision. Retrying
      // will not change it, and we absolutely do not paper over it with a code.
      throw new Error(detail ?? `The voucher service declined this claim (HTTP ${outcome.status}).`);
    }

    if (!outcome.parsed) {
      throw new Error('The voucher service returned an unreadable response.');
    }

    const voucher = parseVoucherResponse(outcome.body);
    if (!voucher) {
      // Body arrived but there is no usable `code`. We do NOT substitute one.
      throw new Error('The voucher service did not return a code. Please try again.');
    }

    return voucher;
  }

  // Both attempts failed transiently. Still no locally-minted code. Ever.
  throw new Error(lastMessage);
}

// ---------------------------------------------------------- leaderboard ---

/**
 * Storage seam for the leaderboard.
 *
 * The default implementation is device-local. To move the board to a real
 * backend, either set `VITE_LEADERBOARD_ENDPOINT` (uses `HttpLeaderboardStore`
 * with local as the offline fallback) or pass a bespoke implementation to
 * `createNet({ store })`. Nothing else in the game changes.
 */
export interface LeaderboardStore {
  /** Best (lowest elapsed) first, already deduped and trimmed. */
  list(branch: BranchId): Promise<LeaderboardEntry[]>;
  /** Persist one entry. Implementations own dedupe/trim. */
  add(entry: LeaderboardEntry): Promise<void>;
}

/** Minimal string KV seam so private-mode Safari (localStorage throws) still works. */
export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/** localStorage when it is usable, otherwise an in-memory map for the session. */
export function createDefaultKeyValueStore(): KeyValueStore {
  let ls: Storage | null = null;
  try {
    const probe = globalThis.localStorage;
    const k = `${STORAGE_PREFIX}probe`;
    probe.setItem(k, '1');
    probe.removeItem(k);
    ls = probe;
  } catch {
    ls = null; // Private mode, disabled storage, or no DOM. Fall through.
  }

  if (ls) {
    const store = ls;
    return {
      read: (key) => {
        try {
          return store.getItem(key);
        } catch {
          return null;
        }
      },
      write: (key, value) => {
        try {
          store.setItem(key, value);
        } catch {
          /* quota / disabled — the board is a nicety, never fail a run over it */
        }
      },
    };
  }

  const mem = new Map<string, string>();
  return {
    read: (key) => mem.get(key) ?? null,
    write: (key, value) => {
      mem.set(key, value);
    },
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function isBranchId(v: string): v is BranchId {
  return BRANCHES.some((b) => b.id === v);
}

/**
 * Trim, strip anything exotic (control chars, emoji, bidi/zero-width tricks),
 * cap length. Never returns an empty string — the board has no blank rows.
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N} '._-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18)
    .trim();
  return cleaned.length > 0 ? cleaned : 'Player';
}

/** Lower elapsed wins; equal times broken by score, then by who got there first. */
function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  if (a.elapsed !== b.elapsed) return a.elapsed - b.elapsed;
  if (a.score !== b.score) return b.score - a.score;
  return a.at - b.at;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Dedupe by name (best run kept), sort, trim to the top N. */
function normaliseBoard(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  const best = new Map<string, LeaderboardEntry>();
  for (const e of entries) {
    const key = nameKey(e.name);
    const prev = best.get(key);
    if (!prev || compareEntries(e, prev) < 0) best.set(key, e);
  }
  return [...best.values()].sort(compareEntries).slice(0, LEADERBOARD_LIMIT);
}

/** Defensive parse — stored JSON and remote JSON are both untrusted. */
function toEntry(v: unknown): LeaderboardEntry | null {
  if (typeof v !== 'object' || v === null) return null;
  const rec = v as Record<string, unknown>;

  const rawName = rec['name'];
  const rawElapsed = rec['elapsed'];
  const rawScore = rec['score'];
  const rawBranch = rec['branch'];
  const rawAt = rec['at'];

  if (typeof rawName !== 'string') return null;
  if (typeof rawElapsed !== 'number' || !Number.isFinite(rawElapsed) || rawElapsed <= 0) return null;
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return null;
  if (typeof rawBranch !== 'string' || !isBranchId(rawBranch)) return null;

  return {
    name: sanitizeName(rawName),
    elapsed: round(rawElapsed, 3),
    score: Math.round(rawScore),
    branch: rawBranch,
    at: typeof rawAt === 'number' && Number.isFinite(rawAt) ? rawAt : Date.now(),
  };
}

function toEntries(v: unknown): LeaderboardEntry[] {
  const arr: unknown = Array.isArray(v)
    ? v
    : typeof v === 'object' && v !== null
      ? (v as Record<string, unknown>)['entries']
      : null;
  if (!Array.isArray(arr)) return [];
  const out: LeaderboardEntry[] = [];
  for (const item of arr) {
    const e = toEntry(item);
    if (e) out.push(e);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * SEEDED DEMO DATA — not real players.
 *
 * These ghost entries exist so a freshly-opened board is never an empty box.
 * They are written once, on the first read of a branch, and then behave like
 * any other row (a real player who beats them pushes them down and eventually
 * off the 20-row board). First names only, UAE-plausible, no surnames, no real
 * customers. If the client ever wants a clean board, bump STORAGE_PREFIX.
 * ------------------------------------------------------------------------- */
interface SeedSpec {
  name: string;
  elapsed: number;
  score: number;
  /** How many days back to date the run, so the board does not look minted today. */
  daysAgo: number;
}

const SEED_NAMES: Record<BranchId, readonly SeedSpec[]> = {
  dwtc: [
    { name: 'Omar', elapsed: 101.4, score: 48200, daysAgo: 11 },
    { name: 'Layla', elapsed: 104.9, score: 46150, daysAgo: 9 },
    { name: 'Rohan', elapsed: 109.2, score: 43700, daysAgo: 14 },
    { name: 'Mariam', elapsed: 112.6, score: 41900, daysAgo: 6 },
    { name: 'Yousef', elapsed: 118.3, score: 39250, daysAgo: 4 },
    { name: 'Chen', elapsed: 124.7, score: 36400, daysAgo: 13 },
    { name: 'Aisha', elapsed: 131.5, score: 33150, daysAgo: 2 },
    { name: 'Marco', elapsed: 139.8, score: 29800, daysAgo: 8 },
  ],
  jbr: [
    { name: 'Noura', elapsed: 99.8, score: 49100, daysAgo: 12 },
    { name: 'Faisal', elapsed: 103.6, score: 46800, daysAgo: 7 },
    { name: 'Priya', elapsed: 108.1, score: 44050, daysAgo: 15 },
    { name: 'Hamdan', elapsed: 114.4, score: 41100, daysAgo: 5 },
    { name: 'Elena', elapsed: 120.9, score: 38300, daysAgo: 10 },
    { name: 'Saeed', elapsed: 127.2, score: 35450, daysAgo: 3 },
    { name: 'Jomar', elapsed: 134.6, score: 32000, daysAgo: 9 },
    { name: 'Hessa', elapsed: 142.3, score: 28650, daysAgo: 1 },
  ],
  deira: [
    { name: 'Khalid', elapsed: 102.7, score: 47600, daysAgo: 10 },
    { name: 'Sara', elapsed: 106.3, score: 45300, daysAgo: 13 },
    { name: 'Bilal', elapsed: 111.8, score: 42450, daysAgo: 6 },
    { name: 'Anjali', elapsed: 116.5, score: 40200, daysAgo: 4 },
    { name: 'Rashid', elapsed: 122.1, score: 37600, daysAgo: 12 },
    { name: 'Aiza', elapsed: 129.4, score: 34300, daysAgo: 8 },
    { name: 'Tariq', elapsed: 136.9, score: 31250, daysAgo: 2 },
    { name: 'Dana', elapsed: 145.7, score: 27900, daysAgo: 5 },
  ],
  muroor: [
    { name: 'Zayed', elapsed: 100.6, score: 48750, daysAgo: 14 },
    { name: 'Amna', elapsed: 105.2, score: 45900, daysAgo: 8 },
    { name: 'Nikhil', elapsed: 110.5, score: 43200, daysAgo: 11 },
    { name: 'Shamma', elapsed: 115.9, score: 40650, daysAgo: 3 },
    { name: 'Salem', elapsed: 121.3, score: 38050, daysAgo: 9 },
    { name: 'Reem', elapsed: 128.8, score: 34800, daysAgo: 6 },
    { name: 'Karim', elapsed: 137.4, score: 30900, daysAgo: 1 },
    { name: 'Grace', elapsed: 147.2, score: 27100, daysAgo: 12 },
  ],
  electra: [
    { name: 'Majid', elapsed: 103.1, score: 47400, daysAgo: 7 },
    { name: 'Latifa', elapsed: 107.5, score: 44850, daysAgo: 15 },
    { name: 'Ravi', elapsed: 113.2, score: 42000, daysAgo: 4 },
    { name: 'Fatima', elapsed: 117.8, score: 39700, daysAgo: 10 },
    { name: 'Ali', elapsed: 123.6, score: 37100, daysAgo: 2 },
    { name: 'Mei', elapsed: 130.9, score: 33900, daysAgo: 13 },
    { name: 'Hamad', elapsed: 138.5, score: 30450, daysAgo: 6 },
    { name: 'Sofia', elapsed: 149.1, score: 26700, daysAgo: 9 },
  ],
};

const DAY_MS = 86_400_000;

/** Build the seeded demo rows for one branch. Called once per branch, ever. */
function seedBoard(branch: BranchId, now: number): LeaderboardEntry[] {
  return SEED_NAMES[branch].map((s) => ({
    name: s.name,
    elapsed: s.elapsed,
    score: s.score,
    branch,
    at: now - s.daysAgo * DAY_MS,
  }));
}

/** Device-local board. The default backend until a real API exists. */
export class LocalLeaderboardStore implements LeaderboardStore {
  private readonly kv: KeyValueStore;

  constructor(kv: KeyValueStore = createDefaultKeyValueStore()) {
    this.kv = kv;
  }

  async list(branch: BranchId): Promise<LeaderboardEntry[]> {
    return this.read(branch);
  }

  async add(entry: LeaderboardEntry): Promise<void> {
    const next = normaliseBoard([...this.read(entry.branch), entry]);
    this.kv.write(this.key(entry.branch), JSON.stringify(next));
  }

  private key(branch: BranchId): string {
    return `${STORAGE_PREFIX}${branch}`;
  }

  private read(branch: BranchId): LeaderboardEntry[] {
    const raw = this.kv.read(this.key(branch));
    if (raw !== null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        parsed = null; // Corrupt row — treated as "no board yet" and reseeded below.
      }
      const entries = normaliseBoard(toEntries(parsed).filter((e) => e.branch === branch));
      if (entries.length > 0) return entries;
    }

    // First run on this device (or a corrupt/emptied row): lay down the seeded
    // demo board so the panel is never an empty box, and persist it so it stays
    // stable across sessions.
    const seeded = normaliseBoard(seedBoard(branch, Date.now()));
    this.kv.write(this.key(branch), JSON.stringify(seeded));
    return seeded;
  }
}

/**
 * Real-API board. Enabled by setting `VITE_LEADERBOARD_ENDPOINT`; always paired
 * with a local store by `createNet` so a flaky network degrades instead of
 * breaking. Throws on failure — the wrapper decides what to do about it.
 */
export class HttpLeaderboardStore implements LeaderboardStore {
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async list(branch: BranchId): Promise<LeaderboardEntry[]> {
    const sep = this.base.includes('?') ? '&' : '?';
    const outcome = await requestJson({
      url: `${this.base}${sep}branch=${encodeURIComponent(branch)}`,
      method: 'GET',
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (outcome.kind !== 'ok' || !outcome.parsed) {
      throw new Error(`Leaderboard fetch failed (${describeOutcome(outcome)}).`);
    }
    return normaliseBoard(toEntries(outcome.body).filter((e) => e.branch === branch));
  }

  async add(entry: LeaderboardEntry): Promise<void> {
    const outcome = await requestJson({
      url: this.base,
      method: 'POST',
      body: JSON.stringify(entry),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (outcome.kind !== 'ok') {
      throw new Error(`Leaderboard submit failed (${describeOutcome(outcome)}).`);
    }
  }
}

function describeOutcome(outcome: HttpOutcome): string {
  if (outcome.kind === 'network') return outcome.timedOut ? 'timeout' : 'network error';
  if (outcome.kind === 'http') return `HTTP ${outcome.status}`;
  return 'malformed body';
}

/**
 * Remote-first, local-always store.
 *
 * - `add` writes local first (a run is never lost to a dead network), then
 *   mirrors to the remote; a remote failure is logged, not thrown.
 * - `list` prefers the remote and falls back to local on error. An empty
 *   remote board also falls back, so the panel is never a blank box.
 */
export class FallbackLeaderboardStore implements LeaderboardStore {
  private readonly primary: LeaderboardStore;
  private readonly fallback: LeaderboardStore;

  constructor(primary: LeaderboardStore, fallback: LeaderboardStore) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async list(branch: BranchId): Promise<LeaderboardEntry[]> {
    try {
      const remote = await this.primary.list(branch);
      if (remote.length > 0) return remote;
    } catch (err: unknown) {
      console.warn('[net] leaderboard: falling back to local board.', err);
    }
    return this.fallback.list(branch);
  }

  async add(entry: LeaderboardEntry): Promise<void> {
    await this.fallback.add(entry);
    try {
      await this.primary.add(entry);
    } catch (err: unknown) {
      console.warn('[net] leaderboard: score kept locally, remote submit failed.', err);
    }
  }
}

// ------------------------------------------------------------------- net ---

/** Identifies the row belonging to this player's most recent submission. */
interface YouRef {
  branch: BranchId;
  name: string;
  elapsed: number;
}

function parseYouRef(raw: string | null): YouRef | null {
  if (raw === null) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const branch = rec['branch'];
  const name = rec['name'];
  const elapsed = rec['elapsed'];
  if (typeof branch !== 'string' || !isBranchId(branch)) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return null;
  return { branch, name, elapsed };
}

/**
 * Flag the player's own row. Prefers an exact (name + time) match; falls back
 * to a name match, because dedupe keeps a player's *best* run — so after a
 * slower rerun the row on the board is an earlier one, and it is still theirs.
 */
function flagYou(entries: readonly LeaderboardEntry[], you: YouRef | null): LeaderboardEntry[] {
  const out = entries.map((e) => ({ ...e }));
  if (!you) return out;

  const key = nameKey(you.name);
  let idx = out.findIndex(
    (e) => e.branch === you.branch && nameKey(e.name) === key && Math.abs(e.elapsed - you.elapsed) < 0.005,
  );
  if (idx < 0) idx = out.findIndex((e) => e.branch === you.branch && nameKey(e.name) === key);
  const mine = idx >= 0 ? out[idx] : undefined;
  if (mine) mine.isYou = true;
  return out;
}

export interface NetOptions {
  /** Swap the whole leaderboard backend (a real API client, or a test double). */
  store?: LeaderboardStore;
  /** Override the voucher endpoint. Still refuses to run on the placeholder. */
  voucherEndpoint?: string;
  /** Override the KV backing for the default local store. */
  keyValueStore?: KeyValueStore;
}

/**
 * Build the game's `Net`. Zero-argument by default:
 *
 *   const net = createNet();
 *
 * Options exist purely so the storage/transport seams can be swapped without
 * touching call sites.
 */
export function createNet(options: NetOptions = {}): Net {
  const kv = options.keyValueStore ?? createDefaultKeyValueStore();
  const local = new LocalLeaderboardStore(kv);
  const store: LeaderboardStore =
    options.store ??
    (LEADERBOARD_ENDPOINT_URL
      ? new FallbackLeaderboardStore(new HttpLeaderboardStore(LEADERBOARD_ENDPOINT_URL), local)
      : local);

  const voucherEndpoint = options.voucherEndpoint ?? VOUCHER_ENDPOINT_URL;

  // Survives a reload so the player's row stays highlighted after a refresh.
  let you: YouRef | null = parseYouRef(kv.read(YOU_KEY));

  const net: Net = {
    claimVoucher(result: RunResult): Promise<VoucherResponse> {
      return claimVoucher(result, voucherEndpoint);
    },

    async submitScore(result: RunResult, name: string): Promise<void> {
      const entry: LeaderboardEntry = {
        name: sanitizeName(name),
        elapsed: round(result.elapsed, 3),
        score: Math.round(result.score),
        branch: result.branch,
        at: Date.now(),
      };
      await store.add(entry);
      you = { branch: entry.branch, name: entry.name, elapsed: entry.elapsed };
      kv.write(YOU_KEY, JSON.stringify(you));
    },

    async leaderboard(branch: BranchId): Promise<LeaderboardEntry[]> {
      const entries = await store.list(branch);
      return flagYou(entries, you);
    },
  };

  return net;
}
