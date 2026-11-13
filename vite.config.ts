import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { packSounds } from './tools/assetpack';
import { editorSave } from './tools/editor-save';
import { pwa } from './tools/pwa';

const page = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

export default defineConfig({
  // Relative, so the build works under any path (GitHub Pages serves it from /the-line/).
  base: './',
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    __VERSION__: JSON.stringify(process.env.npm_package_version ?? ''),
  },
  plugins: [packSounds(), editorSave(), pwa()],
  build: {
    rollupOptions: {
      input: { game: page('index'), lab: page('lab'), difficulty: page('difficulty'), pixi: page('pixi-compare') },
    },
  },
  // The seeded stress cases simulate minutes of gameplay. Give slower CI hosts room.
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000 },
});
