#!/usr/bin/env node
/**
 * Single-frame diagnostic probe. Loads the game, starts a run, waits, and
 * grabs one screenshot — no driving loop, so it returns in seconds rather
 * than minutes. Pass through any query string with --q.
 *
 *   node tools/critic/probe.mjs --q=debugroad=1 --out=debugroad.png
 */

import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

const BASE = args.url ?? 'http://127.0.0.1:4173/';
const Q = args.q ? `?${args.q}` : '';
const OUT = resolve('tools/critic/out/probe');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({
  ...devices['Pixel 7'],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

await page.goto(BASE + Q, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__mukbangReady === true, { timeout: 45000 });
await page.evaluate((m) => window.__mukbang.setCameraMode(m), args.mode ?? 'chase');
await page.evaluate(() => window.__mukbang.startRun());
await sleep(Number(args.wait ?? 6000));
await page.screenshot({ path: resolve(OUT, args.out ?? 'probe.png') });
console.log('wrote', resolve(OUT, args.out ?? 'probe.png'));
console.log(
  'telemetry',
  JSON.stringify(await page.evaluate(() => window.__mukbang.telemetry)),
);
await browser.close();
