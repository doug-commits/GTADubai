/**
 * Boot.
 *
 * Order matters for the load-time budget: the boot shell is already painted by
 * inline CSS in index.html, so all this has to do is stand the engine up and
 * hand over. Nothing here blocks on a network request except the corridor bake,
 * which is a single small JSON and falls back instantly when absent.
 */

import { Game } from './game/game';
import { createUi } from './ui';
import { createAudioEngine } from './audio/engine';
import { createNet } from './net';
import type { UiHost } from './contracts';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const boot = document.getElementById('boot')!;
const bar = boot.querySelector('#bar i') as HTMLElement;
const noWebgl = document.getElementById('nowebgl') as HTMLElement;

function fail(message: string) {
  bar.parentElement?.remove();
  noWebgl.style.display = 'block';
  noWebgl.textContent = message;
}

async function main() {
  // WebGL2 is required — the post chain uses GLSL3 and half-float targets.
  const probe = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
  if (!probe) {
    fail('This game needs WebGL 2. Try a recent version of Chrome, Safari or Firefox.');
    return;
  }

  const audio = createAudioEngine();
  const net = createNet();
  const ui = createUi();

  const game = new Game(canvas, audio, ui, net);

  const host: UiHost = {
    startRun: () => game.startRun(),
    restart: () => game.restart(),
    setCameraMode: (m) => game.setCameraMode(m),
    getCameraMode: () => game.getCameraMode(),
    audio,
    net,
    telemetry: game.telemetry,
    // Filled in properly once the corridor has loaded; the credits panel reads
    // it lazily so the placeholder-vs-OSM notice is always accurate.
    get attribution() {
      return game.attribution;
    },
  } as UiHost;

  ui.mount(host);

  // Mirror boot progress into the inline shell's bar as well as the UI layer,
  // so the loader keeps moving before the UI module has anything on screen.
  const uiSetBootProgress = ui.setBootProgress.bind(ui);
  ui.setBootProgress = (v: number) => {
    bar.style.width = `${Math.round(Math.max(0.08, Math.min(1, v)) * 100)}%`;
    uiSetBootProgress(v);
  };

  try {
    await game.load();
  } catch (err) {
    console.error(err);
    fail('Something went wrong starting the game. Please reload.');
    return;
  }

  boot.classList.add('done');
  setTimeout(() => boot.remove(), 500);

  // Automation surface for the critic harness. Deliberately tiny and read-only
  // apart from the three actions the harness needs to reach every screen.
  Object.assign(window as unknown as Record<string, unknown>, {
    __mukbang: {
      startRun: () => game.startRun(),
      restart: () => game.restart(),
      setCameraMode: (m: 'chase' | 'topdown') => game.setCameraMode(m),
      forceFinish: (won: boolean) => game.forceFinish(won),
      unlockAudio: () => audio.unlock(),
      telemetry: game.telemetry,
      get renderStats() {
        return game.renderStats;
      },
    },
    __mukbangReady: true,
  });
}

main();
