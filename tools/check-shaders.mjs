#!/usr/bin/env node
/**
 * Guard against backticks inside GLSL template literals.
 *
 * Shader source lives in JS template literals, so a backtick in a GLSL comment
 * silently ends the string and turns the rest of the shader into JavaScript.
 * It has cost this build two rounds already: once producing a shader that
 * never compiled, once producing a build failure that a grep swallowed.
 *
 * Run as part of `npm run build`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'src';
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) check(p);
  }
}

function check(file) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  // Track whether we are inside a `/* glsl */ \`...\`` literal by scanning for
  // the opening marker and the closing backtick at line start.
  let inShader = false;
  lines.forEach((line, i) => {
    if (!inShader && /\/\*\s*glsl\s*\*\/\s*`/.test(line)) {
      inShader = true;
      return;
    }
    if (inShader) {
      if (/^\s*`\s*[;,)]/.test(line)) {
        inShader = false;
        return;
      }
      // Only comment lines. Backticks elsewhere in a shader literal are
      // legitimate nested template literals inside a ${...} interpolation;
      // a backtick in a GLSL comment is always a mistake, and is the exact
      // failure this guard exists for.
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
      if (isComment && line.includes('`')) {
        problems.push(
          `${relative('.', file)}:${i + 1}  backtick in a GLSL comment — it ends the template literal\n    ${line.trim()}`,
        );
      }
    }
  });
}

walk(ROOT);

if (problems.length) {
  console.error('\n  Shader source check FAILED:\n');
  for (const p of problems) console.error('  ' + p + '\n');
  process.exit(1);
}
console.log('  shader source check: ok');
