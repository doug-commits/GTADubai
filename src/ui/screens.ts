/**
 * Full-screen states: boot, title, countdown, arrival (win), fail, credits.
 *
 * ─────────────────────────── HALAL RULE ───────────────────────────
 * Love Mukbang is a halal Korean BBQ restaurant. Every piece of art,
 * alt text and body copy in this file — and in any artwork that later
 * replaces the placeholders — names BEEF and CHICKEN only. No pork, no
 * pork belly, no samgyeopsal, ever. If you add copy or art here, keep
 * it beef/chicken. This is non-negotiable.
 * ──────────────────────────────────────────────────────────────────
 *
 * Asset slots degrade gracefully everywhere: the styled CSS/SVG version is
 * always in the DOM and the bitmap fades in over it only once it has loaded.
 * A missing file is therefore invisible to the player, never a broken image.
 */

import {
  BRANCHES,
  WHATSAPP_URL,
  type BranchId,
  type CameraMode,
  type RunResult,
  type UiHost,
  type VoucherResponse,
} from '../contracts';
import { shareRun } from '../net/share';
import { createVoucher, type VoucherView } from './voucher';

const HOOK = "Sheikh Zayed Road. Dusk. Your table's waiting.";
const DEFAULT_BRANCH: BranchId = 'dwtc';

/**
 * Asset slots, each a fallback chain tried in order. Relative paths so they
 * honour Vite's `base: './'`. Nothing here is required — if every candidate is
 * missing the styled SVG/CSS version stays on screen and the player sees no
 * difference. `assets/SLOTS.md` calls the exterior shot `exterior.webp`; the
 * original brief called it `hero.webp`, so both are accepted.
 */
const ASSET_WORDMARK = ['assets/brand/wordmark.svg', 'assets/brand/wordmark.webp'] as const;
const ASSET_HERO = ['assets/storefront/hero.webp', 'assets/storefront/exterior.webp'] as const;
const ASSET_INTERIOR = ['assets/storefront/interior.webp'] as const;

/**
 * Try each candidate source in order. On exhaustion the <img> removes itself,
 * leaving the placeholder art untouched — a missing slot is never a broken
 * image icon.
 */
function loadFirst(
  img: HTMLImageElement,
  sources: readonly string[],
  onLoad: () => void,
): void {
  let index = 0;
  const next = (): void => {
    if (index >= sources.length) {
      if (img.parentNode) img.parentNode.removeChild(img);
      return;
    }
    img.src = sources[index++]!;
  };
  img.addEventListener('load', onLoad);
  img.addEventListener('error', next);
  next();
}

/* -------------------------------------------------------------- helpers -- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function branchName(id: BranchId): string {
  for (let i = 0; i < BRANCHES.length; i++) {
    if (BRANCHES[i]!.id === id) return BRANCHES[i]!.name;
  }
  return 'Dubai World Trade Centre';
}

function formatClock(seconds: number): string {
  const s = seconds > 0 ? seconds : 0;
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  const rem = tenths - m * 600;
  const ss = Math.floor(rem / 10);
  return m + ':' + (ss < 10 ? '0' : '') + ss + '.' + (rem - ss * 10);
}

function grouped(value: number): string {
  const s = String(Math.max(0, Math.round(value)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s.charAt(i);
  }
  return out;
}

function formatDistance(metres: number): string {
  const m = metres > 0 ? metres : 0;
  if (m >= 1000) return (Math.round(m / 100) / 10).toFixed(1) + ' km';
  return String(Math.round(m / 10) * 10) + ' m';
}

function whatsappHref(message: string): string {
  return WHATSAPP_URL + '?text=' + encodeURIComponent(message);
}

/**
 * Diner-facing copy for a failed voucher claim.
 *
 * This deliberately NEVER surfaces the underlying error text. The claim can
 * fail because the endpoint is unconfigured, in which case the technical
 * message names a build-time environment variable — and a customer who just
 * finished a run was being shown "set VITE_VOUCHER_ENDPOINT". The engineering
 * detail goes to the console, where an engineer will actually see it.
 */
function errorMessage(err: unknown): string {
  if (typeof console !== 'undefined') {
    console.warn('[mukbang] voucher claim failed:', err);
  }
  return "We couldn't reach the voucher desk just now. Tap retry — or just show this screen at the door.";
}

/* ------------------------------------------------------- placeholder art -- */

/*
 * Original placeholder artwork, drawn in SVG so it costs no network request
 * and looks intentional rather than "asset missing".
 *
 * HALAL: the grill shows BEEF and CHICKEN cuts only. Do not add pork.
 */
function storefrontArt(): string {
  return (
    '<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
    '<defs>' +
    '<linearGradient id="mkdSky" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#3a1608"/><stop offset="42%" stop-color="#7a2a0c"/>' +
    '<stop offset="72%" stop-color="#2a0e08"/><stop offset="100%" stop-color="#0b0708"/>' +
    '</linearGradient>' +
    '<radialGradient id="mkdSun" cx="0.72" cy="0.42" r="0.42">' +
    '<stop offset="0%" stop-color="#ffb648" stop-opacity="0.85"/>' +
    '<stop offset="100%" stop-color="#ffb648" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<radialGradient id="mkdWindow" cx="0.5" cy="0.5" r="0.62">' +
    '<stop offset="0%" stop-color="#ffe0a8"/><stop offset="52%" stop-color="#f4b740"/>' +
    '<stop offset="100%" stop-color="#c2410c"/>' +
    '</radialGradient>' +
    '<radialGradient id="mkdCoal" cx="0.5" cy="0.5" r="0.5">' +
    '<stop offset="0%" stop-color="#fff0c8"/><stop offset="45%" stop-color="#e2571e"/>' +
    '<stop offset="100%" stop-color="#8c2c07" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<linearGradient id="mkdFloor" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#2a0e08"/><stop offset="100%" stop-color="#0b0708"/>' +
    '</linearGradient>' +
    '</defs>' +
    // dusk sky + low sun
    '<rect width="1600" height="900" fill="url(#mkdSky)"/>' +
    '<rect width="1600" height="900" fill="url(#mkdSun)"/>' +
    // skyline
    '<g fill="#150c09" opacity="0.92">' +
    '<path d="M0 470h95v430H0z"/><path d="M120 405h70v495h-70z"/>' +
    '<path d="M212 330l40-70 40 70v570h-80z"/><path d="M320 452h120v448H320z"/>' +
    '<path d="M470 258l26-96 26 96v642h-52z"/><path d="M548 420h86v480h-86z"/>' +
    '<path d="M1180 398h96v502h-96z"/><path d="M1300 300l34-84 34 84v600h-68z"/>' +
    '<path d="M1400 460h90v440h-90z"/><path d="M1512 380h88v520h-88z"/>' +
    '</g>' +
    // lit windows in the towers
    '<g fill="#f4b740" opacity="0.5">' +
    '<rect x="24" y="512" width="12" height="18"/><rect x="54" y="560" width="12" height="18"/>' +
    '<rect x="140" y="452" width="12" height="18"/><rect x="164" y="520" width="12" height="18"/>' +
    '<rect x="352" y="500" width="12" height="18"/><rect x="392" y="556" width="12" height="18"/>' +
    '<rect x="1206" y="440" width="12" height="18"/><rect x="1240" y="510" width="12" height="18"/>' +
    '<rect x="1428" y="506" width="12" height="18"/><rect x="1540" y="430" width="12" height="18"/>' +
    '</g>' +
    // storefront block
    '<rect x="600" y="250" width="560" height="650" fill="#120b0a"/>' +
    '<rect x="600" y="250" width="560" height="18" fill="#2a0e08"/>' +
    // sign
    '<rect x="646" y="286" width="468" height="86" rx="10" fill="#0b0708" stroke="#f4b740" stroke-width="3"/>' +
    '<text x="880" y="345" text-anchor="middle" fill="#f4b740" font-size="46" font-weight="800" ' +
    'letter-spacing="7" font-family="ui-sans-serif, system-ui, sans-serif">LOVE MUKBANG</text>' +
    '<g class="ph-glow">' +
    '<rect x="646" y="286" width="468" height="86" rx="10" fill="#f4b740" opacity="0.16"/>' +
    '</g>' +
    // awning
    '<path d="M604 394h552l-34 62H638z" fill="#8c2c07"/>' +
    '<g fill="#c2410c">' +
    '<path d="M640 394h56l-22 62h-56z"/><path d="M752 394h56l-22 62h-56z"/>' +
    '<path d="M864 394h56l-22 62h-56z"/><path d="M976 394h56l-22 62h-56z"/>' +
    '</g>' +
    // warm window
    '<rect x="646" y="478" width="468" height="330" rx="8" fill="url(#mkdWindow)" opacity="0.9"/>' +
    '<g class="ph-glow"><rect x="646" y="478" width="468" height="330" rx="8" fill="#ffe0a8" opacity="0.22"/></g>' +
    // interior floor + table
    '<rect x="646" y="700" width="468" height="108" fill="url(#mkdFloor)" opacity="0.55"/>' +
    '<ellipse cx="880" cy="716" rx="176" ry="40" fill="#2a0e08" opacity="0.85"/>' +
    // charcoal grill in the middle of the table — BEEF & CHICKEN ONLY
    '<ellipse cx="880" cy="706" rx="62" ry="19" fill="#0b0708"/>' +
    '<ellipse cx="880" cy="704" rx="52" ry="15" fill="url(#mkdCoal)"/>' +
    '<g fill="#3a1a0c">' +
    '<rect x="842" y="695" width="30" height="9" rx="4"/>' + // beef short rib
    '<rect x="886" y="699" width="26" height="8" rx="4"/>' + // chicken bulgogi
    '<rect x="862" y="708" width="34" height="8" rx="4"/>' + // beef bulgogi
    '</g>' +
    // banchan bowls
    '<g fill="#0b0708" opacity="0.8">' +
    '<ellipse cx="772" cy="712" rx="22" ry="8"/><ellipse cx="988" cy="712" rx="22" ry="8"/>' +
    '<ellipse cx="820" cy="732" rx="18" ry="7"/><ellipse cx="944" cy="732" rx="18" ry="7"/>' +
    '</g>' +
    // steam
    '<g class="ph-steam" fill="none" stroke="#fff4e2" stroke-width="7" stroke-linecap="round" opacity="0.5">' +
    '<path d="M866 676c-14-22 12-30 0-52"/>' +
    '<path d="M894 672c-13-20 11-28 0-48"/>' +
    '<path d="M880 664c-12-18 10-26 0-44"/>' +
    '</g>' +
    // friends around the table (silhouettes) — one waving you in
    '<g fill="#160b07">' +
    '<circle cx="716" cy="612" r="30"/><path d="M676 700c0-30 18-52 40-52s40 22 40 52z"/>' +
    '<circle cx="800" cy="596" r="27"/><path d="M764 678c0-28 16-48 36-48s36 20 36 48z"/>' +
    '<circle cx="962" cy="600" r="28"/><path d="M926 682c0-28 16-48 36-48s36 20 36 48z"/>' +
    '<circle cx="1046" cy="616" r="31"/><path d="M1006 704c0-30 18-52 40-52s40 22 40 52z"/>' +
    // waving arm
    '<path d="M1074 660c22-16 34-44 30-74l22 6c6 38-10 72-38 90z"/>' +
    '</g>' +
    // pavement + road glow
    '<rect x="0" y="836" width="1600" height="64" fill="#0b0708"/>' +
    '<rect x="0" y="826" width="1600" height="12" fill="#c2410c" opacity="0.35"/>' +
    '</svg>'
  );
}

/* HALAL: interior scene shows a charcoal grill with BEEF and CHICKEN only. */
function interiorArt(): string {
  return (
    '<svg viewBox="0 0 1600 686" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
    '<defs>' +
    '<linearGradient id="mkdRoom" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#2a0e08"/><stop offset="100%" stop-color="#0b0708"/>' +
    '</linearGradient>' +
    '<radialGradient id="mkdLamp" cx="0.5" cy="0.1" r="0.7">' +
    '<stop offset="0%" stop-color="#ffd98a" stop-opacity="0.7"/>' +
    '<stop offset="100%" stop-color="#ffd98a" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<radialGradient id="mkdCoal2" cx="0.5" cy="0.5" r="0.5">' +
    '<stop offset="0%" stop-color="#fff0c8"/><stop offset="45%" stop-color="#e2571e"/>' +
    '<stop offset="100%" stop-color="#8c2c07" stop-opacity="0"/>' +
    '</radialGradient>' +
    '</defs>' +
    '<rect width="1600" height="686" fill="url(#mkdRoom)"/>' +
    '<rect width="1600" height="686" fill="url(#mkdLamp)"/>' +
    // pendant lamps
    '<g stroke="#f4b740" stroke-width="3" opacity="0.5">' +
    '<path d="M420 0v120"/><path d="M800 0v86"/><path d="M1180 0v134"/>' +
    '</g>' +
    '<g fill="#f4b740" class="ph-glow">' +
    '<ellipse cx="420" cy="130" rx="46" ry="16"/><ellipse cx="800" cy="96" rx="46" ry="16"/>' +
    '<ellipse cx="1180" cy="144" rx="46" ry="16"/>' +
    '</g>' +
    // table
    '<rect x="180" y="420" width="1240" height="266" rx="26" fill="#150c09"/>' +
    '<rect x="180" y="420" width="1240" height="16" rx="8" fill="#2a0e08"/>' +
    // grill
    '<ellipse cx="800" cy="500" rx="190" ry="60" fill="#0b0708"/>' +
    '<ellipse cx="800" cy="494" rx="164" ry="48" fill="url(#mkdCoal2)"/>' +
    '<g fill="#3a1a0c">' +
    '<rect x="700" y="470" width="92" height="24" rx="11"/>' + // beef short rib
    '<rect x="812" y="480" width="80" height="22" rx="10"/>' + // chicken bulgogi
    '<rect x="742" y="512" width="104" height="22" rx="10"/>' + // beef bulgogi
    '</g>' +
    // steam
    '<g class="ph-steam" fill="none" stroke="#fff4e2" stroke-width="12" stroke-linecap="round" opacity="0.4">' +
    '<path d="M760 440c-26-44 24-58 0-100"/>' +
    '<path d="M840 432c-24-40 22-54 0-92"/>' +
    '<path d="M800 420c-22-36 20-50 0-84"/>' +
    '</g>' +
    // banchan
    '<g fill="#0b0708">' +
    '<ellipse cx="360" cy="520" rx="66" ry="24"/><ellipse cx="500" cy="566" rx="56" ry="20"/>' +
    '<ellipse cx="1240" cy="520" rx="66" ry="24"/><ellipse cx="1104" cy="566" rx="56" ry="20"/>' +
    '</g>' +
    '<g fill="#c2410c" opacity="0.7">' +
    '<ellipse cx="360" cy="516" rx="52" ry="17"/><ellipse cx="1240" cy="516" rx="52" ry="17"/>' +
    '</g>' +
    '</svg>'
  );
}

/** Hero frame: placeholder art always present, bitmap fades in when it loads. */
function createHeroFrame(
  art: string,
  sources: readonly string[],
  alt: string,
  caption: string,
  extraClass?: string,
): HTMLElement {
  const frame = el('div', 'mkd-hero' + (extraClass ? ' ' + extraClass : ''));
  frame.innerHTML = art;
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', alt);

  const img = el('img');
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'eager';
  frame.appendChild(img);
  loadFirst(img, sources, () => img.classList.add('is-loaded'));

  if (caption) frame.appendChild(el('div', 'hero-cap', caption));
  return frame;
}

/* ---------------------------------------------------------------- deps ---- */

export interface ScreenDeps {
  host: UiHost;
  toast(message: string): void;
  openLeaderboard(result?: RunResult | null): void;
  openCredits(): void;
}

function press(node: HTMLElement, host: UiHost, fn: () => void): void {
  node.addEventListener('click', (ev) => {
    ev.preventDefault();
    host.audio.uiTap();
    fn();
  });
}

/**
 * Outbound links keep their native anchor navigation — `target="_blank"` plus
 * `rel="noopener noreferrer"` is more reliable than window.open and survives
 * long-press / "open in new tab". We only add the tap sound.
 */
function pressLink(node: HTMLAnchorElement, host: UiHost): void {
  node.addEventListener('click', () => host.audio.uiTap());
}

/* ---------------------------------------------------------------- boot ---- */

export interface BootScreen {
  readonly el: HTMLElement;
  setProgress(value: number): void;
}

export function createBootScreen(): BootScreen {
  const root = el('div', 'mkd-layer mkd-boot');
  root.appendChild(el('div', 'mkd-scrim'));
  const wrap = el('div', 'boot-wrap');
  wrap.appendChild(el('div', 'boot-mark', 'MUKBANG DASH'));
  const track = el('div', 'boot-track');
  const fill = el('div', 'boot-fill');
  track.appendChild(fill);
  wrap.appendChild(track);
  wrap.appendChild(el('div', 'boot-cap', 'Paving Sheikh Zayed Road'));
  root.appendChild(wrap);

  let lastQ = -1;
  return {
    el: root,
    setProgress(value) {
      const v = value < 0 ? 0 : value > 1 ? 1 : value;
      const q = Math.round(v * 100);
      if (q === lastQ) return;
      lastQ = q;
      fill.style.transform = 'scaleX(' + q / 100 + ')';
    },
  };
}

/* --------------------------------------------------------------- title ---- */

export interface TitleScreen {
  readonly el: HTMLElement;
  /** Re-read camera/mute state from the host. */
  sync(): void;
}

const SPEAKER_ON =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="mute-on">' +
  '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>' +
  '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
  '</svg>';
const SPEAKER_OFF =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="mute-off">' +
  '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>' +
  '<path d="M16.5 9.5l5 5M21.5 9.5l-5 5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
  '</svg>';

export function createTitleScreen(deps: ScreenDeps): TitleScreen {
  const host = deps.host;
  const root = el('div', 'mkd-layer mkd-title');
  root.appendChild(el('div', 'mkd-scrim'));

  const wrap = el('div', 'title-wrap');
  const top = el('div', 'title-top');

  // Wordmark: styled-text fallback underneath, SVG asset on top when present.
  const lockup = el('div', 'title-lockup');
  const fallback = el('div', 'title-fallback');
  fallback.appendChild(el('span', 'title-word', 'MUKBANG'));
  fallback.appendChild(el('span', 'title-word title-word--2', 'DASH'));
  lockup.appendChild(fallback);
  const mark = el('img', 'title-img');
  mark.alt = 'Mukbang Dash';
  mark.decoding = 'async';
  lockup.appendChild(mark);
  loadFirst(mark, ASSET_WORDMARK, () => {
    lockup.classList.add('has-art');
    mark.classList.add('is-loaded');
  });
  top.appendChild(lockup);

  top.appendChild(el('div', 'title-rule'));
  const hook = el('div', 'title-hook');
  hook.appendChild(document.createTextNode('Sheikh Zayed Road. Dusk. '));
  hook.appendChild(el('b', undefined, "Your table's waiting."));
  hook.setAttribute('aria-label', HOOK);
  top.appendChild(hook);
  wrap.appendChild(top);

  const bottom = el('div', 'title-bottom');

  const drive = el('button', 'mkd-btn mkd-drive mkd-hit', 'Drive');
  drive.type = 'button';
  drive.setAttribute('aria-label', 'Drive — start the run');
  bottom.appendChild(drive);

  const row = el('div', 'title-row');

  // The camera comparison is settled: three independent reviews of the real
  // rendered frames picked the behind-car chase view, the last of them after
  // the road-culling bug that had unfairly penalised the top-down was fixed.
  // A camera picker is a developer control, not something a diner should meet
  // on a title screen, so the toggle is gone and chase is the only mode.
  // TopDownRig is retained in src/game/cameras.ts for reference.

  const mute = el('button', 'mkd-mute mkd-hit');
  mute.type = 'button';
  mute.innerHTML = SPEAKER_ON + SPEAKER_OFF;
  const muteLabel = el('span', undefined, 'Sound');
  mute.appendChild(muteLabel);
  row.appendChild(mute);

  const credits = el('button', 'mkd-text-btn mkd-hit', 'Credits');
  credits.type = 'button';
  row.appendChild(credits);

  bottom.appendChild(row);
  bottom.appendChild(
    el('div', 'title-legal', 'Love Mukbang Korean BBQ · Five branches across the UAE'),
  );
  wrap.appendChild(bottom);
  root.appendChild(wrap);

  function syncCamera(): void {
    // Chase is the only shipped camera; keep the engine in that mode.
    if (host.getCameraMode() !== 'chase') host.setCameraMode('chase');
  }

  function syncMute(): void {
    const muted = host.audio.muted;
    mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    mute.setAttribute('aria-label', muted ? 'Unmute the game' : 'Mute the game');
    muteLabel.textContent = muted ? 'Muted' : 'Sound';
  }

  press(drive, host, () => {
    // The tap IS the user gesture — unlock the AudioContext here, then go.
    // We never let an unlock failure stop the run from starting.
    const go = (): void => host.startRun();
    try {
      host.audio.unlock().then(go, go);
    } catch {
      go();
    }
  });

  press(mute, host, () => {
    host.audio.setMuted(!host.audio.muted);
    syncMute();
  });
  press(credits, host, () => deps.openCredits());

  syncCamera();
  syncMute();

  return {
    el: root,
    sync() {
      syncCamera();
      syncMute();
    },
  };
}

/* ----------------------------------------------------------- countdown ---- */

export interface CountdownScreen {
  readonly el: HTMLElement;
  reset(): void;
  tick(dt: number): void;
}

const BEAT_SECONDS = 1;
/** The engine's countdown is 3.2s and its first tick lands at 0.2s — match it
 *  so the numerals change on exactly the frame the lights change. */
const BEAT_OFFSET = 0.2;
const BEAT_LABELS = ['3', '2', '1', 'GO'];

export interface CountdownOptions {
  /**
   * Fire `host.audio.countdownBeep()` from the UI. Leave this on when the UI
   * owns the countdown audio. The current engine build already beeps from its
   * own countdown step, so the shell turns this off to avoid double-triggering
   * the same cue — flip it back to `true` if the engine ever stops.
   */
  beeps?: boolean;
}

export function createCountdownScreen(host: UiHost, opts: CountdownOptions = {}): CountdownScreen {
  const beeps = opts.beeps !== false;
  const root = el('div', 'mkd-layer mkd-layer--flat mkd-count');
  const stage = el('div', 'count-stage');
  const num = el('div', 'count-num tnum', '');
  stage.appendChild(num);
  root.appendChild(stage);
  root.appendChild(el('div', 'count-hint', 'Drag anywhere to steer'));

  let time = 0;
  let next = 0;
  let flip = false;

  function reset(): void {
    time = 0;
    next = 0;
    num.textContent = '';
    num.classList.remove('beat-a', 'beat-b', 'is-go');
  }

  function tick(dt: number): void {
    time += dt;
    while (next < BEAT_LABELS.length && time >= BEAT_OFFSET + next * BEAT_SECONDS) {
      const i = next++;
      const label = BEAT_LABELS[i]!;
      num.textContent = label;
      if (label === 'GO') num.classList.add('is-go');
      else num.classList.remove('is-go');

      // n counts 3 · 2 · 1; the final beat is the one-second mark.
      if (beeps && i < 3) host.audio.countdownBeep(3 - i === 1);

      flip = !flip;
      if (flip) {
        num.classList.remove('beat-b');
        num.classList.add('beat-a');
      } else {
        num.classList.remove('beat-a');
        num.classList.add('beat-b');
      }
    }
  }

  reset();
  return { el: root, reset, tick };
}

/* ------------------------------------------------------------- arrival ---- */

export interface WinScreen {
  readonly el: HTMLElement;
  show(result: RunResult): void;
  /** Drop the issued voucher so a stale code can never be reprinted. */
  reset(): void;
  dispose(): void;
}

export function createWinScreen(deps: ScreenDeps): WinScreen {
  const host = deps.host;
  const root = el('div', 'mkd-layer mkd-win');
  root.appendChild(el('div', 'mkd-scrim'));

  const sheet = el('div', 'mkd-sheet mkd-scroll');

  sheet.appendChild(
    createHeroFrame(
      storefrontArt(),
      ASSET_HERO,
      'The Love Mukbang storefront at dusk — friends waving you in from a table of ' +
        'charcoal-grilled beef and chicken.',
      'Love Mukbang · Dubai World Trade Centre',
    ),
  );

  const headWrap = el('div');
  headWrap.appendChild(el('h1', 'mkd-headline', 'You made it'));
  const sub = el('p', 'mkd-sub');
  const subTime = el('b', undefined, '0:00.0');
  const subSpare = el('b', undefined, '0.0s');
  sub.appendChild(document.createTextNode('Parked outside Love Mukbang in '));
  sub.appendChild(subTime);
  sub.appendChild(document.createTextNode(' — with '));
  sub.appendChild(subSpare);
  sub.appendChild(document.createTextNode(' to spare. They kept the grill on.'));
  headWrap.appendChild(sub);
  sheet.appendChild(headWrap);

  const stats = el('div', 'mkd-stats');
  function stat(key: string): HTMLElement {
    const box = el('div', 'mkd-stat');
    const v = el('div', 'v tnum', '—');
    box.appendChild(v);
    box.appendChild(el('div', 'k', key));
    stats.appendChild(box);
    return v;
  }
  const statElapsed = stat('Elapsed');
  const statScore = stat('Score');
  const statTop = stat('Top km/h');
  const statNear = stat('Near miss');
  sheet.appendChild(stats);

  // Three equal CTAs.
  const ctas = el('div', 'mkd-cta-grid');
  const bookLink = el('a', 'mkd-btn mkd-btn--ember mkd-hit');
  bookLink.target = '_blank';
  bookLink.rel = 'noopener noreferrer';
  bookLink.textContent = 'Book a table';
  const shareBtn = el('button', 'mkd-btn mkd-btn--gold mkd-hit', 'Share your time');
  shareBtn.type = 'button';
  const boardBtn = el('button', 'mkd-btn mkd-hit', 'Leaderboard');
  boardBtn.type = 'button';
  ctas.appendChild(bookLink);
  ctas.appendChild(shareBtn);
  ctas.appendChild(boardBtn);
  sheet.appendChild(ctas);

  sheet.appendChild(
    createHeroFrame(
      interiorArt(),
      ASSET_INTERIOR,
      'Inside Love Mukbang — a charcoal grill loaded with beef and chicken, banchan all around.',
      'Charcoal grill · beef & chicken · banchan on the house',
      'mkd-hero--band',
    ),
  );

  const voucher: VoucherView = createVoucher({
    onRetry: () => {
      if (current) claim(current);
    },
    onTap: () => host.audio.uiTap(),
    onNotice: (m) => deps.toast(m),
  });
  sheet.appendChild(voucher.el);

  const foot = el('div', 'mkd-footrow');
  const again = el('button', 'mkd-text-btn mkd-hit', 'Play again');
  again.type = 'button';
  const creditsBtn = el('button', 'mkd-text-btn mkd-hit', 'Credits');
  creditsBtn.type = 'button';
  foot.appendChild(again);
  foot.appendChild(creditsBtn);
  sheet.appendChild(foot);

  root.appendChild(sheet);

  let current: RunResult | null = null;
  let claimSeq = 0;
  let issuedCode: string | null = null;

  function bookingMessage(): string {
    const where = current ? branchName(current.branch) : branchName(DEFAULT_BRANCH);
    let msg =
      'Hi Love Mukbang! I just finished Mukbang Dash' +
      (current ? ' in ' + formatClock(current.elapsed) : '') +
      " and I'd like to book a table at " +
      where +
      '.';
    // Only ever quotes a code the server actually issued.
    if (issuedCode) msg += ' My voucher code is ' + issuedCode + '.';
    return msg;
  }

  function refreshBooking(): void {
    bookLink.href = whatsappHref(bookingMessage());
  }

  /**
   * CRITICAL: the game must NEVER generate the voucher code itself. The code
   * rendered on screen and on paper is exactly the string the server returned.
   * On rejection we surface an honest error and a Retry — we do not invent,
   * derive, cache or placeholder a code under any circumstances.
   */
  function claim(result: RunResult): void {
    const my = ++claimSeq;
    issuedCode = null;
    refreshBooking();
    voucher.render({ status: 'loading' }, result.branch);
    host.net.claimVoucher(result).then(
      (v: VoucherResponse) => {
        if (my !== claimSeq) return;
        if (!v || typeof v.code !== 'string' || v.code.trim().length === 0) {
          voucher.render(
            { status: 'error', message: 'The voucher desk sent an empty response.' },
            result.branch,
          );
          return;
        }
        issuedCode = v.code;
        voucher.render({ status: 'ok', voucher: v }, result.branch);
        refreshBooking();
      },
      (err: unknown) => {
        if (my !== claimSeq) return;
        voucher.render({ status: 'error', message: errorMessage(err) }, result.branch);
      },
    );
  }

  press(shareBtn, host, () => {
    if (!current) return;
    shareBtn.setAttribute('disabled', 'true');
    const done = (): void => shareBtn.removeAttribute('disabled');
    shareRun(current).then((outcome) => {
      done();
      if (outcome === 'copied') deps.toast('Copied!');
      else if (outcome === 'shared') deps.toast('Shared');
    }, () => {
      done();
      deps.toast("Couldn't share that");
    });
  });

  press(boardBtn, host, () => deps.openLeaderboard(current));
  press(again, host, () => host.restart());
  press(creditsBtn, host, () => deps.openCredits());
  pressLink(bookLink, host);

  refreshBooking();

  return {
    el: root,

    show(result) {
      current = result;
      subTime.textContent = formatClock(result.elapsed);
      subSpare.textContent = (result.timeRemaining > 0 ? result.timeRemaining : 0).toFixed(1) + 's';
      statElapsed.textContent = formatClock(result.elapsed);
      statScore.textContent = grouped(result.score);
      statTop.textContent = String(Math.round(result.topSpeedKph));
      statNear.textContent = String(Math.round(result.nearMisses));
      sheet.scrollTop = 0;
      refreshBooking();
      claim(result);
    },

    reset() {
      // Cancels any in-flight claim and blanks the printable ticket.
      claimSeq++;
      issuedCode = null;
      voucher.render({ status: 'idle' }, current ? current.branch : DEFAULT_BRANCH);
      refreshBooking();
    },

    dispose() {
      voucher.dispose();
    },
  };
}

/* ---------------------------------------------------------------- fail ---- */

export interface FailScreen {
  readonly el: HTMLElement;
  /** `distanceLeft` in metres, read off telemetry the moment the clock died. */
  show(distanceLeft: number, branch: BranchId): void;
}

export function createFailScreen(deps: ScreenDeps): FailScreen {
  const host = deps.host;
  const root = el('div', 'mkd-layer mkd-fail');
  root.appendChild(el('div', 'mkd-scrim'));

  const sheet = el('div', 'mkd-sheet mkd-scroll');

  sheet.appendChild(
    createHeroFrame(
      storefrontArt(),
      ASSET_HERO,
      'Love Mukbang at night — the grill is still lit and the table is still set with ' +
        'beef and chicken.',
      'Still open · Love Mukbang · DWTC',
      'mkd-hero--band mkd-hero--muted',
    ),
  );

  const headWrap = el('div');
  headWrap.appendChild(el('h1', 'mkd-headline mkd-headline--fail', "The table's still warm."));
  const sub = el('p', 'mkd-sub');
  const shortBy = el('b', undefined, '—');
  sub.appendChild(document.createTextNode('The clock beat you by '));
  sub.appendChild(shortBy);
  sub.appendChild(
    document.createTextNode(
      ". Everyone's already ordered. Run it back — or just call ahead and let them seat you.",
    ),
  );
  headWrap.appendChild(sub);
  sheet.appendChild(headWrap);

  const retry = el('button', 'mkd-btn mkd-btn--gold mkd-hit mkd-btn--tall', 'Try again');
  retry.type = 'button';
  sheet.appendChild(retry);

  const ctas = el('div', 'mkd-cta-grid mkd-cta-grid--two');
  const bookLink = el('a', 'mkd-btn mkd-btn--ember mkd-hit');
  bookLink.target = '_blank';
  bookLink.rel = 'noopener noreferrer';
  bookLink.textContent = 'Book a table';
  const boardBtn = el('button', 'mkd-btn mkd-hit', 'Leaderboard');
  boardBtn.type = 'button';
  ctas.appendChild(bookLink);
  ctas.appendChild(boardBtn);
  sheet.appendChild(ctas);

  const foot = el('div', 'mkd-footrow');
  const creditsBtn = el('button', 'mkd-text-btn mkd-hit', 'Credits');
  creditsBtn.type = 'button';
  foot.appendChild(creditsBtn);
  sheet.appendChild(foot);

  root.appendChild(sheet);

  press(retry, host, () => host.restart());
  press(boardBtn, host, () => deps.openLeaderboard(null));
  press(creditsBtn, host, () => deps.openCredits());
  pressLink(bookLink, host);

  return {
    el: root,
    show(distanceLeft, branch) {
      shortBy.textContent = formatDistance(distanceLeft);
      bookLink.href = whatsappHref(
        "Hi Love Mukbang! I'd like to book a table at " + branchName(branch) + '.',
      );
      sheet.scrollTop = 0;
    },
  };
}

/* ------------------------------------------------------------- credits ---- */

export interface CreditsPanel {
  readonly el: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

const CLOSE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
  '</svg>';

export function createCreditsPanel(deps: ScreenDeps): CreditsPanel {
  const host = deps.host;
  const root = el('div', 'mkd-overlay mkd-credits');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Credits');

  const backdrop = el('div', 'ov-backdrop');
  const panel = el('div', 'ov-panel');
  panel.appendChild(el('div', 'ov-grip'));

  const head = el('div', 'ov-head');
  head.appendChild(el('div', 'ov-title', 'Credits'));
  const closeBtn = el('button', 'ov-close mkd-hit');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close credits');
  closeBtn.innerHTML = CLOSE_GLYPH;
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const body = el('div', 'ov-body mkd-scroll');

  const game = el('div', 'cr-block');
  game.appendChild(el('div', 'cr-h', 'The game'));
  game.appendChild(
    el(
      'p',
      'cr-p',
      'Mukbang Dash — an original arcade run down Sheikh Zayed Road to the Love Mukbang ' +
        'branch at Dubai World Trade Centre. Built in WebGL. No third-party fonts, no ' +
        'trackers, no external requests.',
    ),
  );
  body.appendChild(game);

  // `host.attribution` is a live getter on the shell — it only becomes accurate
  // once the corridor bake has loaded, so this block is rebuilt on every open
  // rather than snapshotted at mount time.
  const route = el('div', 'cr-block');
  route.appendChild(el('div', 'cr-h', 'Route data'));
  const routeText = el('p', 'cr-p', '');
  const routeNote = el('div', 'cr-note');
  routeNote.textContent =
    'Heads up: this build is driving an authored placeholder corridor, not a real ' +
    'OpenStreetMap bake of Sheikh Zayed Road. The geometry is indicative, not surveyed.';
  route.appendChild(routeText);
  route.appendChild(routeNote);
  body.appendChild(route);

  function syncAttribution(): void {
    const attr = host.attribution;
    while (routeText.firstChild) routeText.removeChild(routeText.firstChild);
    routeText.appendChild(document.createTextNode(attr.text || 'Route data: source unavailable.'));
    if (attr.url) {
      routeText.appendChild(document.createTextNode(' '));
      const link = el('a', 'mkd-hit', 'Source');
      link.href = attr.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.addEventListener('click', () => host.audio.uiTap());
      routeText.appendChild(link);
    }
    // Honest about the placeholder corridor — never claim a bake we do not have.
    routeNote.hidden = attr.isRealOSM;
  }

  const art = el('div', 'cr-block');
  art.appendChild(el('div', 'cr-h', 'Artwork'));
  art.appendChild(
    el(
      'p',
      'cr-p',
      'All artwork, illustration, brand marks and photography in this game are original ' +
        'and owned by the client, Love Mukbang Korean BBQ. Placeholder scenes are drawn ' +
        'in-engine as SVG. Food shown is halal — beef and chicken only.',
    ),
  );
  body.appendChild(art);

  const branches = el('div', 'cr-block');
  branches.appendChild(el('div', 'cr-h', 'Branches'));
  const names: string[] = [];
  for (let i = 0; i < BRANCHES.length; i++) names.push(BRANCHES[i]!.name);
  branches.appendChild(el('p', 'cr-p', names.join(' · ')));
  body.appendChild(branches);

  panel.appendChild(body);
  root.appendChild(backdrop);
  root.appendChild(panel);

  let open = false;
  const api: CreditsPanel = {
    el: root,
    open() {
      open = true;
      syncAttribution();
      body.scrollTop = 0;
      root.classList.add('is-on');
    },
    close() {
      open = false;
      root.classList.remove('is-on');
    },
    isOpen() {
      return open;
    },
  };

  press(closeBtn, host, () => api.close());
  press(backdrop, host, () => api.close());

  return api;
}
