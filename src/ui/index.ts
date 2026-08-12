/// <reference types="vite/client" />
/**
 * Mukbang Dash — UI shell.
 *
 * Owns the single mounted root, phase routing (animated cross-fades, never a
 * hard cut) and the per-frame `tick()` fan-out. The 3D canvas renders behind
 * us: the root is `position:fixed; inset:0; pointer-events:none` and only
 * elements carrying `.mkd-hit` opt back into hit-testing, so dragging to steer
 * during `running` always reaches the canvas.
 *
 * `tick()` is on the 60fps path. It touches exactly two things — the active
 * phase view and a toast timer — and neither allocates in the steady state.
 */

import './styles.css';

import type { CameraMode, Phase, RunResult, Ui, UiHost } from '../contracts';
import { createHud, type HudView } from './hud';
import {
  createBootScreen,
  createCountdownScreen,
  createCreditsPanel,
  createFailScreen,
  createTitleScreen,
  createWinScreen,
  type BootScreen,
  type CountdownScreen,
  type CreditsPanel,
  type FailScreen,
  type ScreenDeps,
  type TitleScreen,
  type WinScreen,
} from './screens';
import { createLeaderboard, type LeaderboardView } from './leaderboard';

const TOAST_MS = 2200;

export function createUi(): Ui {
  let host: UiHost | null = null;
  let mounted = false;

  let root: HTMLDivElement | null = null;
  let toastEl: HTMLDivElement | null = null;
  let toastTimer = 0;

  let boot: BootScreen | null = null;
  let title: TitleScreen | null = null;
  let countdown: CountdownScreen | null = null;
  let hud: HudView | null = null;
  let win: WinScreen | null = null;
  let fail: FailScreen | null = null;
  let credits: CreditsPanel | null = null;
  let leaderboard: LeaderboardView | null = null;

  let phase: Phase | null = null;
  let lastResult: RunResult | null = null;
  let pendingBoot = 0;

  let pressedNode: Element | null = null;

  function toast(message: string): void {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastTimer = 0;
      toastEl?.classList.remove('is-on');
    }, TOAST_MS);
  }

  function closeOverlays(): void {
    credits?.close();
    leaderboard?.close();
  }

  /** The engine owns RunResult. This only fires on the defensive path where a
   *  phase change arrives without one, so the ad still converts. */
  function fallbackResult(h: UiHost): RunResult {
    const t = h.telemetry;
    const mode: CameraMode = h.getCameraMode();
    return {
      elapsed: 0,
      timeRemaining: t.timeLeft > 0 ? t.timeLeft : 0,
      score: t.score,
      topSpeedKph: t.speedKph,
      nearMisses: 0,
      branch: 'dwtc',
      cameraMode: mode,
    };
  }

  function layerFor(p: Phase): HTMLElement | null {
    switch (p) {
      case 'boot':
        return boot ? boot.el : null;
      case 'title':
        return title ? title.el : null;
      case 'countdown':
        return countdown ? countdown.el : null;
      case 'running':
        return hud ? hud.el : null;
      case 'arrived':
        return win ? win.el : null;
      case 'failed':
        return fail ? fail.el : null;
      default:
        return null;
    }
  }

  function onPointerDown(ev: PointerEvent): void {
    const target = ev.target as Element | null;
    const hit = target && target.closest ? target.closest('.mkd-hit') : null;
    if (pressedNode && pressedNode !== hit) pressedNode.classList.remove('is-pressed');
    pressedNode = hit;
    if (hit) hit.classList.add('is-pressed');
  }

  function onPointerUp(): void {
    if (pressedNode) {
      pressedNode.classList.remove('is-pressed');
      pressedNode = null;
    }
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    if (leaderboard?.isOpen()) {
      leaderboard.close();
      ev.preventDefault();
    } else if (credits?.isOpen()) {
      credits.close();
      ev.preventDefault();
    }
  }

  const ui: Ui = {
    mount(h) {
      if (mounted) return;
      mounted = true;
      host = h;

      const el = document.createElement('div');
      el.className = 'mkd';
      root = el;

      const deps: ScreenDeps = {
        host: h,
        toast,
        openLeaderboard: (result) => {
          credits?.close();
          leaderboard?.open(result ?? lastResult);
        },
        openCredits: () => {
          leaderboard?.close();
          credits?.open();
        },
      };

      boot = createBootScreen();
      title = createTitleScreen(deps);
      // The engine's own countdown step already fires `countdownBeep`, so the
      // UI drives the visual beats only — otherwise every beep plays twice.
      countdown = createCountdownScreen(h, { beeps: false });
      hud = createHud(h);
      win = createWinScreen(deps);
      fail = createFailScreen(deps);
      credits = createCreditsPanel(deps);
      leaderboard = createLeaderboard(h, {
        onTap: () => h.audio.uiTap(),
        onNotice: toast,
      });

      el.appendChild(boot.el);
      el.appendChild(title.el);
      el.appendChild(countdown.el);
      el.appendChild(hud.el);
      el.appendChild(win.el);
      el.appendChild(fail.el);
      el.appendChild(credits.el);
      el.appendChild(leaderboard.el);

      const t = document.createElement('div');
      t.className = 'mkd-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      toastEl = t;
      el.appendChild(t);

      // Delegated pressed state — one pair of listeners for every control.
      el.addEventListener('pointerdown', onPointerDown, { passive: true });
      el.addEventListener('pointerup', onPointerUp, { passive: true });
      el.addEventListener('pointercancel', onPointerUp, { passive: true });
      document.addEventListener('keydown', onKeyDown);

      document.body.appendChild(el);

      if (pendingBoot > 0) boot.setProgress(pendingBoot);
      ui.setPhase('boot');
    },

    setPhase(p, result) {
      const h = host;
      if (!h || !mounted) return;
      const incoming = result ?? null;
      if (p === phase && incoming === lastResult) return;

      const prev = phase;
      phase = p;
      if (incoming) lastResult = incoming;

      if (prev === 'running' && p !== 'running') h.audio.setTension(0);

      // Prime the incoming screen before it fades in.
      switch (p) {
        case 'title':
          closeOverlays();
          title?.sync();
          win?.reset();
          break;
        case 'countdown':
          closeOverlays();
          countdown?.reset();
          win?.reset();
          break;
        case 'running':
          closeOverlays();
          hud?.reset();
          win?.reset();
          break;
        case 'arrived':
          win?.show(incoming ?? lastResult ?? fallbackResult(h));
          break;
        case 'failed':
          fail?.show(h.telemetry.distanceLeft, lastResult ? lastResult.branch : 'dwtc');
          break;
        default:
          break;
      }

      // Cross-fade: both layers are visible for the duration of the transition.
      if (prev && prev !== p) layerFor(prev)?.classList.remove('is-on');
      layerFor(p)?.classList.add('is-on');
    },

    tick(dt) {
      if (phase === 'running') hud?.tick(dt);
      else if (phase === 'countdown') countdown?.tick(dt);
    },

    setBootProgress(v) {
      pendingBoot = v;
      boot?.setProgress(v);
    },
  };

  return ui;
}

export default createUi;
