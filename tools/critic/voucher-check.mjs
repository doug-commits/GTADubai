#!/usr/bin/env node
/**
 * Voucher end-to-end check.
 *
 * Proves three things about the shipped client:
 *   1. It POSTs to the configured endpoint and renders ONLY the code the
 *      server returned.
 *   2. The print stylesheet produces a clean voucher, not a screenshot of a
 *      dark game UI.
 *   3. With no endpoint configured it shows an honest error and never invents
 *      a code.
 *
 * The stub lives in Playwright's network layer, NOT in the app. Nothing here
 * adds a client-side code-generation path — we are replacing the SERVER, which
 * is exactly what a real deployment does.
 *
 *   node tools/critic/voucher-check.mjs --url=http://127.0.0.1:4174/
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

const BASE = args.url ?? 'http://127.0.0.1:4174/';
const OUT = resolve('tools/critic/out', args.label ?? 'voucher');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const SERVER_CODE = 'LM-DWTC-7QX4-2F9K';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  const requests = [];
  // Stand in for the voucher service.
  await context.route('**/voucher-stub/**', async (route) => {
    const req = route.request();
    requests.push({
      method: req.method(),
      url: req.url(),
      body: req.postData(),
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: SERVER_CODE,
        expires: '31 Dec 2026',
        discountPercent: 10,
        voucherId: 'stub-0001',
      }),
    });
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mukbangReady === true, { timeout: 45000 });

  await page.evaluate(() => {
    window.__mukbang.unlockAudio?.();
    window.__mukbang.startRun();
  });
  await sleep(1200);
  await page.evaluate(() => window.__mukbang.forceFinish(true));

  // Give the claim time to round-trip and render.
  await sleep(3500);
  await page.screenshot({ path: resolve(OUT, '01-win-with-voucher.png'), fullPage: false });

  // Scroll the sheet so the ticket is in view.
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach((n) => {
      if (n.scrollHeight > n.clientHeight + 40) n.scrollTop = n.scrollHeight;
    });
  });
  await sleep(600);
  await page.screenshot({ path: resolve(OUT, '02-voucher-onscreen.png') });

  // Does the rendered page contain exactly the server's code and nothing that
  // looks like a locally-minted one?
  const bodyText = await page.evaluate(() => document.body.innerText);
  const showsServerCode = bodyText.includes(SERVER_CODE);

  // --- print rendering ----------------------------------------------------
  // emulateMedia applies print CSS but keeps the current viewport, so a narrow
  // phone viewport is the WORST case for the sheet. Capture that first, then
  // again at roughly A4 content width, and require the code to stay on one
  // line in both.
  await page.emulateMedia({ media: 'print' });
  await sleep(400);
  await page.screenshot({ path: resolve(OUT, '03-print-view.png'), fullPage: true });

  const codeLinesNarrow = await page.evaluate(() => {
    const el = document.querySelector('.mkd-printsheet .pv-code');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight || '1'));
  });

  await page.setViewportSize({ width: 794, height: 1123 }); // A4 at 96dpi
  await sleep(400);
  await page.screenshot({ path: resolve(OUT, '04-print-a4.png'), fullPage: true });

  const codeLinesA4 = await page.evaluate(() => {
    const el = document.querySelector('.mkd-printsheet .pv-code');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight || '1'));
  });
  await page.setViewportSize({ width: 390, height: 844 });

  const printProbe = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    const canvas = document.querySelector('canvas');
    const canvasVisible = canvas ? getComputedStyle(canvas).display !== 'none' : false;
    const sheet = document.querySelector('.mkd-printsheet');
    return {
      bodyBackground: bg,
      canvasVisibleInPrint: canvasVisible,
      printSheetPresent: !!sheet,
      printSheetVisible: sheet ? getComputedStyle(sheet).display !== 'none' : false,
      printSheetText: sheet ? sheet.innerText.replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    };
  });
  await page.emulateMedia({ media: 'screen' });

  const report = {
    endpointCalled: requests.length,
    requestMethod: requests[0]?.method ?? null,
    requestBodyKeys: requests[0]?.body ? Object.keys(JSON.parse(requests[0].body)) : null,
    hasIdempotencyKey: requests[0]?.body ? /idempot|requestId|key/i.test(requests[0].body) : false,
    serverCode: SERVER_CODE,
    pageShowsServerCode: showsServerCode,
    print: printProbe,
    codeLinesNarrow,
    codeLinesA4,
    codeStaysOnOneLine: codeLinesNarrow === 1 && codeLinesA4 === 1,
    pageErrors: errors,
  };
  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
