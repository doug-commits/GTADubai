#!/usr/bin/env node
/**
 * Package the game as ONE self-contained HTML file.
 *
 * Used to hand someone a playable build with no server, no install and no
 * repo — and to publish it where a strict CSP blocks every external request,
 * so CSS and JS must be inlined rather than linked.
 *
 *   npm run bundle        -> mukbang-dash.html in the repo root
 *
 * The game degrades correctly with no network: the corridor fetch falls back
 * to the authored placeholder, and every art slot falls back to its procedural
 * stand-in.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist-single';
const assets = readdirSync(join(DIST, 'assets'));
const jsName = assets.find((f) => f.endsWith('.js'));
const cssName = assets.find((f) => f.endsWith('.css'));
if (!jsName || !cssName) {
  console.error(`  No built assets in ${DIST}/assets — run the single-file vite build first.`);
  process.exit(1);
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const js = readFileSync(join(DIST, 'assets', jsName), 'utf8');
const css = readFileSync(join(DIST, 'assets', cssName), 'utf8');

// The boot shell's critical CSS lives inline in index.html; keep it first so
// the ember gradient paints before the game stylesheet is parsed.
const critical = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] ?? '';
let body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/) || [])[1] ?? '';
body = body
  .replace(/<script[^>]*src=[^>]*><\/script>/g, '')
  .replace(/<link[^>]*>/g, '')
  .trim();

if (!body.includes('id="stage"')) {
  console.error('  Body extraction failed — no canvas found. Aborting rather than shipping a blank page.');
  process.exit(1);
}

const out = [
  '<title>Mukbang Dash</title>',
  '<style>',
  critical,
  css,
  '</style>',
  body,
  '<script type="module">',
  js,
  '</' + 'script>',
].join('\n');

writeFileSync('mukbang-dash.html', out);
console.log(`  mukbang-dash.html  ${(out.length / 1024 / 1024).toFixed(2)} MB, self-contained`);
