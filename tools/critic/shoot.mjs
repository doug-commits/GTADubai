#!/usr/bin/env node
/**
 * Critic harness.
 *
 * Drives the REAL built game in a real Chromium at a real phone viewport and
 * captures real pixels and a real frame-rate. Nothing here reads the source or
 * trusts a description of what the game does — the critic only ever sees what
 * came out of the GPU.
 *
 *   node tools/critic/shoot.mjs --mode=chase --label=r1
 *
 * Output lands in tools/critic/out/<label>/ as PNGs plus report.json.
 */

import { chromium, devices } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

const MODE = args.mode ?? 'chase';
const LABEL = args.label ?? 'run';
const BASE = args.url ?? 'http://127.0.0.1:4173/';
const OUT = resolve('tools/critic/out', LABEL);
const HEADFUL = args.headful === 'true';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// A mainstream mid-range phone, not a flagship — this is the machine the game
// actually has to hold 60fps on.
const PHONE = {
  ...devices['Pixel 7'],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    headless: !HEADFUL,
    // This image ships a preinstalled Chromium that may not match the build the
    // installed Playwright expects. Use the stable symlink rather than letting
    // Playwright try to download one.
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const context = await browser.newContext({ ...PHONE });
  const page = await context.newPage();

  const consoleErrors = [];
  const missingAssets = new Set();
  // A 404 on an asset slot is the expected state until the client supplies art;
  // separating those keeps the real errors visible instead of buried.
  const isAssetSlot404 = (text) =>
    /assets\/(sky|road|buildings|billboards|storefront|brand|car)\//.test(text) ||
    /data\/corridor\.json/.test(text);

  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (isAssetSlot404(t)) missingAssets.add(t.replace(/^.*?(assets|data)\//, '$1/').slice(0, 90));
    else consoleErrors.push(t);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (isAssetSlot404(u)) missingAssets.add(u.replace(/^.*?\/(assets|data)\//, '$1/'));
  });
  // A dev/preview server with an SPA fallback answers a missing asset with 200
  // + index.html rather than 404, so status alone cannot tell us whether a slot
  // is filled. Content-type can: an image slot serving text/html is empty.
  page.on('response', (res) => {
    const u = res.url();
    if (!isAssetSlot404(u)) return;
    const ct = res.headers()['content-type'] ?? '';
    const filled = res.status() === 200 && !ct.includes('text/html');
    if (!filled) missingAssets.add(u.replace(/^.*?\/(assets|data)\//, '$1/'));
  });

  // --- instrument the frame clock before any app code runs -----------------
  await page.addInitScript(() => {
    const w = window;
    w.__frames = [];
    let last = performance.now();
    const tick = (t) => {
      w.__frames.push(t - last);
      last = t;
      if (w.__frames.length > 4000) w.__frames.shift();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__fpsWindow = () => {
      const f = w.__frames.slice(-180);
      if (!f.length) return null;
      const sorted = [...f].sort((a, b) => a - b);
      const mean = f.reduce((a, b) => a + b, 0) / f.length;
      return {
        avgFps: +(1000 / mean).toFixed(1),
        p50Ms: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
        p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        worstMs: +sorted[sorted.length - 1].toFixed(2),
      };
    };
    w.__resetFrames = () => {
      w.__frames.length = 0;
    };
  });

  // --- load ----------------------------------------------------------------
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  let firstPaint = null;
  try {
    firstPaint = await page.evaluate(
      () =>
        new Promise((res) => {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              if (e.name === 'first-contentful-paint') res(Math.round(e.startTime));
            }
          }).observe({ type: 'paint', buffered: true });
          setTimeout(() => res(null), 4000);
        }),
    );
  } catch {
    /* not critical */
  }

  await page.waitForFunction(() => window.__mukbangReady === true, { timeout: 45000 }).catch(() => {});
  const readyMs = Date.now() - t0;

  const shot = async (name) => {
    await page.screenshot({ path: resolve(OUT, `${name}.png`) });
  };

  await sleep(700);
  await shot('01-title');

  // --- pick the camera mode under test -------------------------------------
  await page.evaluate((m) => window.__mukbang?.setCameraMode?.(m), MODE);
  await sleep(300);

  // --- start the run -------------------------------------------------------
  const started = await page.evaluate(() => {
    if (!window.__mukbang?.startRun) return false;
    window.__mukbang.unlockAudio?.();
    window.__mukbang.startRun();
    return true;
  });
  if (!started) {
    // Fall back to actually tapping the button, which is the real user path.
    const btn = page.locator('text=DRIVE').first();
    if (await btn.count()) await btn.tap({ force: true }).catch(() => {});
  }

  await sleep(600);
  await shot('02-countdown');

  // --- drive ---------------------------------------------------------------
  // Weave through traffic with touch drags, the way a player would.
  await page.evaluate(() => window.__resetFrames());
  const perf = [];
  const cx = 195;
  const cy = 640;

  // One long press per leg, with the pointer swept across it. Under software GL
  // each input event costs real time, so a few wide drags produce far more game
  // time per wall-clock second than many short ones — and the car is steering
  // continuously either way.
  const drive = async (legMs, amplitude) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < legMs) {
      const dx = Math.sin(i * 0.9) * amplitude;
      await page.mouse.move(cx + dx, cy);
      await sleep(120);
      i++;
    }
    await page.mouse.up();
  };

  const marks = [
    { legMs: 2200, amp: 40, name: '03-early-run' },
    { legMs: 2600, amp: 60, name: '04-mid-run' },
    { legMs: 2600, amp: 70, name: '05-traffic' },
    { legMs: 2600, amp: 45, name: '06-late-run' },
  ];

  for (const m of marks) {
    await drive(m.legMs, m.amp);
    await shot(m.name);
    const p = await page.evaluate(() => ({
      ...window.__fpsWindow(),
      stats: window.__mukbang?.renderStats ?? null,
      speedKph: Math.round(window.__mukbang?.telemetry?.speedKph ?? 0),
      timeLeft: +(window.__mukbang?.telemetry?.timeLeft ?? 0).toFixed(1),
    }));
    if (p) perf.push({ mark: m.name, ...p });
  }

  // --- the arrival / win screen -------------------------------------------
  await page.evaluate(() => window.__mukbang?.forceFinish?.(true));
  await sleep(2200);
  await shot('07-arrival');
  await sleep(1800);
  await shot('08-win-screen');

  // Scroll the win screen in case content sits below the fold.
  await page.evaluate(() => {
    const el = document.scrollingElement || document.body;
    el.scrollTop = el.scrollHeight;
    document.querySelectorAll('*').forEach((n) => {
      if (n.scrollHeight > n.clientHeight + 40) n.scrollTop = n.scrollHeight;
    });
  });
  await sleep(500);
  await shot('09-win-scrolled');

  const report = {
    label: LABEL,
    mode: MODE,
    viewport: PHONE.viewport,
    deviceScaleFactor: PHONE.deviceScaleFactor,
    load: { readyMs, firstContentfulPaintMs: firstPaint },
    perf,
    consoleErrors: consoleErrors.slice(0, 40),
    assetSlotsNotSupplied: [...missingAssets].sort(),
    note:
      'Rendered under SwiftShader (software GL) in CI. Frame times are a FLOOR, not a phone number — treat relative changes between rounds as the signal, and judge look from the pixels.',
  };
  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nScreenshots: ${OUT}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
