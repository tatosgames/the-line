// Build only: writes the service worker that lets the installed game play offline.
// Hash all build files. Precache the primary encoding and WAV fallback for each sound.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import type { SampleManifest } from '../src/core/samples';

const TEMPLATE = fileURLToPath(new URL('./sw.template.js', import.meta.url));

export function pwa(): Plugin {
  let dist = 'dist';
  return {
    name: 'the-line-pwa',
    apply: 'build',
    configResolved(config) { dist = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const files = readdirSync(dist, { recursive: true, withFileTypes: true })
        .filter((f) => f.isFile() && f.name !== 'sw.js')
        .map((f) => join(f.parentPath, f.name))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f.slice(dist.length)).update(readFileSync(f));
      const soundDir = './assets/sounds-packed/';
      const manifest = JSON.parse(readFileSync(join(dist, soundDir, 'manifest.json'), 'utf8')) as SampleManifest;
      const primary = new Set(Object.values(manifest).map(([name]) => soundDir + name));
      const optional = new Set(Object.values(manifest).flatMap((variants) => variants.slice(1))
        .map((name) => soundDir + name).filter((url) => !primary.has(url)));
      const urls = ['./', ...files.map((f) => './' + relative(dist, f).replaceAll('\\', '/')).filter((url) => !optional.has(url))];
      const sw = readFileSync(TEMPLATE, 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__FILES__', JSON.stringify(urls))
        .replace('__OPTIONAL_SOUNDS__', JSON.stringify([...optional]));
      writeFileSync(join(dist, 'sw.js'), sw);
    },
  };
}
