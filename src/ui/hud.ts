/**
 * In-run HUD — the read-at-a-glance layer.
 *
 * Performance contract: `tick()` runs every rendered frame at 60fps.
 *   · Every node reference is resolved once, at build time.
 *   · Every writable value is cached and compared before it is written, so
 *     the steady state performs zero DOM writes and zero allocations.
 *   · Nothing here ever reads layout (no offsetWidth / getBoundingClientRect
 *     / getComputedStyle), so we can never force a synchronous reflow.
 *   · Animations are restarted by swapping between two identically-keyframed
 *     classes (`punch-a` / `punch-b`) — the usual "remove class, read
 *     offsetWidth, add class" trick is a layout read and is banned here.
 *   · Only `transform` and `opacity` are animated. Never width/height/top.
 *
 * Everything reads `host.telemetry`, which the engine mutates in place. We
 * hold the reference, never a copy, so the HUD can never show a stale frame.
 */

import type { UiHost } from '../contracts';

/** Seconds remaining below which the clock goes ember-hot and tension ramps. */
const HOT_WINDOW = 8;
/** Boost reservoir segment count. */
const BOOST_SEGMENTS = 14;
/** Speed used to normalise the speed rail. */
const SPEED_FULL_KPH = 260;
/** How long the combo pip stays lit after the last near miss. */
const COMBO_HOLD = 1.5;
/** Crash vignette hold, seconds. */
const CRASH_HOLD = 0.55;

export interface HudView {
  readonly el: HTMLElement;
  /** Clear caches + transient states. Call when a run starts. */
  reset(): void;
  /** Per-frame update. Reads `host.telemetry` directly. */
  tick(dt: number): void;
}

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

function svg(markup: string, className: string): HTMLElement {
  const holder = document.createElement('span');
  holder.className = className;
  holder.innerHTML = markup;
  return holder;
}

/** `M:SS.S` — tabular so the digits never dance. */
function formatClock(seconds: number): string {
  const s = seconds > 0 ? seconds : 0;
  const tenths = Math.floor(s * 10 + 0.0001);
  const m = (tenths / 600) | 0;
  const rem = tenths - m * 600;
  const ss = (rem / 10) | 0;
  const t = rem - ss * 10;
  return m + ':' + (ss < 10 ? '0' : '') + ss + '.' + t;
}

const STORE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M3 9l2-5h14l2 5v1a2.5 2.5 0 0 1-4.5 1.5A2.5 2.5 0 0 1 12 12a2.5 2.5 0 0 1-4.5-.5A2.5 2.5 0 0 1 3 10V9z" fill="#24120a"/>' +
  '<path d="M5 12.5V20h14v-7.5" stroke="#24120a" stroke-width="2" stroke-linecap="round"/>' +
  '</svg>';

export function createHud(host: UiHost): HudView {
  const root = el('div', 'mkd-layer mkd-layer--flat mkd-hud');
  const shell = el('div', 'hud-shell');
  root.appendChild(shell);

  // ---------------------------------------------------------------- rail --
  const rail = el('div', 'hud-rail');
  const railLabel = el('div', 'rail-label');
  railLabel.appendChild(document.createTextNode('Love Mukbang'));
  railLabel.appendChild(el('span', undefined, '· DWTC'));
  rail.appendChild(railLabel);

  const railBody = el('div', 'rail-body');
  const railTrack = el('div', 'rail-track');
  const railFill = el('div', 'rail-fill');
  const railStore = el('div', 'rail-store');
  railStore.appendChild(svg(STORE_GLYPH, 'rail-store-glyph'));
  // The carrier spans the whole track, so translating it by a percentage of
  // its own height moves the car pip by that fraction of the track — no
  // pixel maths, and therefore no layout reads.
  const railCarrier = el('div', 'rail-carrier');
  const railCar = el('div', 'rail-car');
  railCarrier.appendChild(railCar);
  railTrack.appendChild(railFill);
  railTrack.appendChild(railCarrier);
  railTrack.appendChild(railStore);
  railBody.appendChild(railTrack);
  rail.appendChild(railBody);

  const railDist = el('div', 'rail-dist tnum');
  const railDistN = document.createTextNode('—');
  const railDistU = el('span', undefined, '');
  railDist.appendChild(railDistN);
  railDist.appendChild(railDistU);
  rail.appendChild(railDist);
  shell.appendChild(rail);

  // --------------------------------------------------------------- clock --
  const clock = el('div', 'hud-clock');
  const clockVal = el('div', 'clock-val tnum', '0:00.0');
  const clockCap = el('div', 'clock-cap', 'Time');
  clock.appendChild(clockVal);
  clock.appendChild(clockCap);
  shell.appendChild(clock);

  // --------------------------------------------------------------- score --
  const score = el('div', 'hud-score');
  score.appendChild(el('div', 'score-cap', 'Score'));
  const scoreVal = el('div', 'score-val tnum', '0');
  score.appendChild(scoreVal);
  shell.appendChild(score);

  // ------------------------------------------------------------- banners --
  const banners = el('div', 'hud-banners');
  const bonus = el('div', 'hud-bonus');
  bonus.appendChild(document.createTextNode('Time extended'));
  const bonusVal = el('b', undefined, '');
  bonus.appendChild(bonusVal);
  const cpName = el('div', 'hud-cp', '');
  banners.appendChild(bonus);
  banners.appendChild(cpName);
  shell.appendChild(banners);

  // ---------------------------------------------------------------- combo --
  const combo = el('div', 'hud-combo');
  const comboInner = el('div', 'combo-inner');
  const comboN = el('div', 'combo-n tnum', 'x2');
  comboInner.appendChild(comboN);
  comboInner.appendChild(el('em', undefined, 'Near miss'));
  combo.appendChild(comboInner);
  shell.appendChild(combo);

  // ---------------------------------------------------------------- boost --
  const boost = el('div', 'hud-boost');
  boost.appendChild(el('div', 'boost-cap', 'Boost'));
  const boostSegs = el('div', 'boost-segs');
  const segNodes: HTMLElement[] = [];
  for (let i = 0; i < BOOST_SEGMENTS; i++) {
    const seg = el('i', 'seg');
    boostSegs.appendChild(seg);
    segNodes.push(seg);
  }
  boost.appendChild(boostSegs);
  shell.appendChild(boost);

  // ---------------------------------------------------------------- speed --
  const speed = el('div', 'hud-speed');
  const speedRow = el('div', 'speed-row');
  const speedVal = el('div', 'speed-val tnum', '0');
  speedRow.appendChild(speedVal);
  speedRow.appendChild(el('div', 'speed-cap', 'km/h'));
  speed.appendChild(speedRow);
  const speedBar = el('div', 'speed-bar');
  const speedFill = el('i');
  speedBar.appendChild(speedFill);
  speed.appendChild(speedBar);
  shell.appendChild(speed);

  // ------------------------------------------------------------ vignettes --
  const heat = el('div', 'hud-heat');
  const vignette = el('div', 'hud-vignette');
  shell.appendChild(heat);
  shell.appendChild(vignette);

  // ------------------------------------------------------------- caches ---
  let totalDistance = -1;
  let lastTenths = -1;
  let lastSecond = -1;
  let hot = false;
  let lastHeatQ = -1;
  let lastRailQ = -1;
  let lastDistKey = -1;
  /** null until the first write, so the unit label is always painted once. */
  let lastDistUnitKm: boolean | null = null;
  let scoreShown = 0;
  let scoreTarget = 0;
  let lastScoreText = 0;
  let popCooldown = 0;
  let lastLit = -1;
  let boostFull = false;
  let lastKph = -1;
  let lastSpeedQ = -1;
  let comboLive = false;
  let lastComboN = -1;
  let crashTimer = 0;
  let crashed = false;

  // Animation-restart flip-flops.
  let flipTick = false;
  let flipPop = false;
  let flipPunch = false;
  let flipSlam = false;
  let flipShake = false;

  function swap(node: HTMLElement, a: string, b: string, useA: boolean): void {
    if (useA) {
      node.classList.remove(b);
      node.classList.add(a);
    } else {
      node.classList.remove(a);
      node.classList.add(b);
    }
  }

  /** Blank every cache and every rendered value. */
  function clear(): void {
    totalDistance = -1;
    lastTenths = -1;
    lastSecond = -1;
    lastHeatQ = -1;
    lastRailQ = -1;
    lastDistKey = -1;
    lastDistUnitKm = null;
    scoreShown = 0;
    scoreTarget = 0;
    lastScoreText = -1;
    popCooldown = 0;
    lastLit = -1;
    lastKph = -1;
    lastSpeedQ = -1;
    lastComboN = -1;
    crashTimer = 0;

    if (hot) {
      hot = false;
      clock.classList.remove('is-hot');
    }
    if (boostFull) {
      boostFull = false;
      boost.classList.remove('is-full');
    }
    if (comboLive) {
      comboLive = false;
      combo.classList.remove('is-live');
    }
    if (crashed) {
      crashed = false;
      root.classList.remove('is-crashed');
    }
    root.classList.remove('shake-a', 'shake-b');
    bonus.classList.remove('slam-a', 'slam-b');
    cpName.classList.remove('slam-a', 'slam-b');
    clockVal.classList.remove('tick-a', 'tick-b');
    scoreVal.classList.remove('pop-a', 'pop-b');
    comboInner.classList.remove('punch-a', 'punch-b');

    scoreVal.textContent = '0';
    lastScoreText = 0;
    speedVal.textContent = '0';
    clockVal.textContent = '0:00.0';
    railFill.style.transform = 'scaleY(0)';
    railCarrier.style.transform = 'translate3d(0,0,0)';
    speedFill.style.transform = 'scaleX(0)';
    heat.style.opacity = '0';
    for (let i = 0; i < segNodes.length; i++) segNodes[i]!.classList.remove('is-lit');
  }

  /**
   * Called as a run starts. Clears the caches, then paints one frame straight
   * from live telemetry so the HUD never fades in showing a blank 0:00.0.
   */
  function reset(): void {
    clear();
    tick(0);
  }

  clear();

  function tick(dt: number): void {
    const t = host.telemetry;

    // ---- clock + tension -------------------------------------------------
    const left = t.timeLeft > 0 ? t.timeLeft : 0;
    const tenths = (left * 10 + 0.0001) | 0;
    if (tenths !== lastTenths) {
      lastTenths = tenths;
      clockVal.textContent = formatClock(left);
    }

    const wantHot = left < HOT_WINDOW;
    if (wantHot !== hot) {
      hot = wantHot;
      if (hot) clock.classList.add('is-hot');
      else clock.classList.remove('is-hot');
    }

    const second = Math.ceil(left);
    if (second !== lastSecond) {
      lastSecond = second;
      if (hot) {
        flipTick = !flipTick;
        swap(clockVal, 'tick-a', 'tick-b', flipTick);
      }
    }

    // The clock is the tension carrier, so it owns `setTension`. Written on
    // EVERY frame on purpose: the engine's sim step also writes tension, and
    // `ui.tick()` runs after it — skipping frames here would let the two
    // curves alternate and warble the low-time layer. It is one call with no
    // allocation, so the steady-state cost is nil.
    const tension = wantHot ? 1 - left / HOT_WINDOW : 0;
    host.audio.setTension(tension);
    const heatQ = (tension * 16) | 0;
    if (heatQ !== lastHeatQ) {
      lastHeatQ = heatQ;
      heat.style.opacity = heatQ === 0 ? '0' : String((heatQ / 16) * 0.85);
    }

    // ---- distance rail ---------------------------------------------------
    const distLeft = t.distanceLeft > 0 ? t.distanceLeft : 0;
    if (totalDistance < 0 && distLeft > 1) totalDistance = distLeft;
    let progress = 0;
    if (totalDistance > 0) {
      progress = 1 - distLeft / totalDistance;
      if (progress < 0) progress = 0;
      else if (progress > 1) progress = 1;
    }
    const railQ = (progress * 500) | 0;
    if (railQ !== lastRailQ) {
      lastRailQ = railQ;
      const p = railQ / 500;
      railFill.style.transform = 'scaleY(' + p + ')';
      railCarrier.style.transform = 'translate3d(0,' + -(p * 100) + '%,0)';
    }

    const km = distLeft >= 1000;
    const distKey = km ? Math.round(distLeft / 100) : Math.round(distLeft / 10) * 1000;
    if (distKey !== lastDistKey) {
      lastDistKey = distKey;
      railDistN.nodeValue = km
        ? (Math.round(distLeft / 100) / 10).toFixed(1)
        : String(Math.round(distLeft / 10) * 10);
      if (km !== lastDistUnitKm) {
        lastDistUnitKm = km;
        railDistU.textContent = km ? 'KM' : 'M';
      }
    }

    // ---- score (roll-up) -------------------------------------------------
    const rawScore = t.score | 0;
    if (rawScore !== scoreTarget) {
      const jump = rawScore - scoreTarget;
      scoreTarget = rawScore;
      if (jump >= 25 && popCooldown <= 0) {
        popCooldown = 0.22;
        flipPop = !flipPop;
        swap(scoreVal, 'pop-a', 'pop-b', flipPop);
      }
    }
    if (popCooldown > 0) popCooldown -= dt;
    if (scoreShown !== scoreTarget) {
      const k = dt * 11 > 1 ? 1 : dt * 11;
      scoreShown += (scoreTarget - scoreShown) * k;
      if (scoreTarget - scoreShown < 0.6 && scoreShown - scoreTarget < 0.6) scoreShown = scoreTarget;
      const shownInt = scoreShown | 0;
      if (shownInt !== lastScoreText) {
        lastScoreText = shownInt;
        scoreVal.textContent = String(shownInt);
      }
    }

    // ---- boost -----------------------------------------------------------
    const b01 = t.boost < 0 ? 0 : t.boost > 1 ? 1 : t.boost;
    const lit = Math.round(b01 * BOOST_SEGMENTS);
    if (lit !== lastLit) {
      const from = lastLit < 0 ? 0 : lastLit;
      const lo = from < lit ? from : lit;
      const hi = from > lit ? from : lit;
      for (let i = lo; i < hi; i++) {
        const seg = segNodes[i];
        if (!seg) continue;
        if (i < lit) seg.classList.add('is-lit');
        else seg.classList.remove('is-lit');
      }
      lastLit = lit;
      const full = lit >= BOOST_SEGMENTS;
      if (full !== boostFull) {
        boostFull = full;
        if (full) boost.classList.add('is-full');
        else boost.classList.remove('is-full');
      }
    }

    // ---- speed -----------------------------------------------------------
    const kph = Math.round(t.speedKph > 0 ? t.speedKph : 0);
    if (kph !== lastKph) {
      lastKph = kph;
      speedVal.textContent = String(kph);
    }
    let sp = kph / SPEED_FULL_KPH;
    if (sp > 1) sp = 1;
    const spQ = (sp * 128) | 0;
    if (spQ !== lastSpeedQ) {
      lastSpeedQ = spQ;
      speedFill.style.transform = 'scaleX(' + spQ / 128 + ')';
    }

    // ---- combo pip -------------------------------------------------------
    if (t.nearMiss) {
      const n = t.combo > 1 ? Math.round(t.combo) : 1;
      if (n !== lastComboN) {
        lastComboN = n;
        comboN.textContent = 'x' + n;
      }
      if (!comboLive) {
        comboLive = true;
        combo.classList.add('is-live');
      }
      flipPunch = !flipPunch;
      swap(comboInner, 'punch-a', 'punch-b', flipPunch);
    } else if (comboLive && t.comboAge > COMBO_HOLD) {
      comboLive = false;
      combo.classList.remove('is-live');
    }

    // ---- checkpoint banner ----------------------------------------------
    if (t.checkpointBonus > 0) {
      bonusVal.textContent = '+' + Math.round(t.checkpointBonus) + 's';
      cpName.textContent = t.lastCheckpoint ?? '';
      flipSlam = !flipSlam;
      swap(bonus, 'slam-a', 'slam-b', flipSlam);
      swap(cpName, 'slam-a', 'slam-b', flipSlam);
    }

    // ---- crash -----------------------------------------------------------
    if (t.crashed) {
      crashTimer = CRASH_HOLD;
      if (!crashed) {
        crashed = true;
        root.classList.add('is-crashed');
      }
      flipShake = !flipShake;
      swap(root, 'shake-a', 'shake-b', flipShake);
    } else if (crashTimer > 0) {
      crashTimer -= dt;
      if (crashTimer <= 0 && crashed) {
        crashed = false;
        root.classList.remove('is-crashed');
      }
    }
  }

  return { el: root, reset, tick };
}
