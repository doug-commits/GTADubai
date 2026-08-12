#!/usr/bin/env node
/**
 * Traffic-rhythm probe.
 *
 * The formation spawner cannot be judged from a screenshot — any single frame
 * is either inside a pack or inside a gap, and both look correct. This drives
 * the real built game, reads the live vehicle layout ahead of the player, and
 * prints the thing that actually matters: how the traffic is CLUSTERED.
 *
 *   node tools/critic/traffic-probe.mjs
 */

import { chromium, devices } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({
  ...devices['Pixel 7'],
  viewport: { width: 390, height: 844 },
});

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => window.__mukbangReady === true, null, { timeout: 90_000 });
await page.evaluate(() => window.__mukbang.setCameraMode('fpv'));
await page.evaluate(() => window.__mukbang.startRun());
await sleep(6000);

const samples = [];
for (let i = 0; i < 6; i++) {
  samples.push(await page.evaluate(() => window.__mukbang.debugTraffic()));
  await sleep(1200);
}
await browser.close();

// --- report ---------------------------------------------------------------
const KIND = ['sedan', 'suv', 'taxi', 'bus', 'truck'];

for (const [i, rows] of samples.entries()) {
  const ahead = rows.filter((r) => r.ahead >= 0 && r.ahead < 700);
  // Cluster: consecutive vehicles within 22 m of each other are one formation.
  const packs = [];
  let cur = [];
  let prev = -1e9;
  for (const r of ahead) {
    if (r.ahead - prev > 22 && cur.length) {
      packs.push(cur);
      cur = [];
    }
    cur.push(r);
    prev = r.ahead;
  }
  if (cur.length) packs.push(cur);

  const gaps = [];
  for (let p = 1; p < packs.length; p++) {
    gaps.push(packs[p][0].ahead - packs[p - 1][packs[p - 1].length - 1].ahead);
  }

  const sizes = packs.map((p) => p.length);
  const line = packs
    .slice(0, 8)
    .map((p) => {
      const lanes = new Set(p.map((v) => v.lane));
      const bar = Array.from({ length: 5 }, (_, l) => (lanes.has(l) ? '#' : '.')).join('');
      return `${String(p[0].ahead).padStart(3)}m[${bar}]`;
    })
    .join(' ');

  console.log(
    `sample ${i}: ${ahead.length} ahead · ${packs.length} packs · ` +
      `size ${Math.min(...sizes)}-${Math.max(...sizes)} · ` +
      `gaps ${gaps.length ? Math.min(...gaps) + '-' + Math.max(...gaps) + 'm' : 'n/a'}`,
  );
  console.log(`           ${line}`);
}

const all = samples.flat();
const byKind = KIND.map((k, i) => `${k}:${all.filter((r) => r.kind === i).length}`).join(' ');
console.log(`\nfleet mix across all samples: ${byKind}`);
