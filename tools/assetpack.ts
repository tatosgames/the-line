import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import { SAMPLES, type Sample, type SampleManifest } from '../src/core/samples';

const run = promisify(execFile);
const formats = [
  { extension: 'mp3', codec: 'libmp3lame', quality: ['-b:a', '32k'] },
  { extension: 'ogg', codec: 'libvorbis', quality: ['-q:a', '2'] },
];

/** AssetPack uses the FFmpeg on PATH so CI and local builds have the same explicit prerequisite. */
export function packSounds(): Plugin {
  return {
    name: 'the-line-pack-sounds',
    apply: (_config, env) => env.mode !== 'test' && !env.isPreview,
    async configResolved(config) {
      try {
        await run('ffmpeg', ['-version']);
      } catch {
        throw new Error('FFmpeg with libmp3lame and libvorbis is required to pack sound effects. Install it and add it to PATH.');
      }

      const { AssetPack, createNewAssetAt } = await import('@assetpack/core');
      const entry = resolve(config.root, 'public/assets/sounds');
      const output = resolve(config.root, 'public/assets/sounds-packed');
      const sourceFiles = new Set<string>(Object.values(SAMPLES).map((name) => `${name}.wav`));
      const manifestPath = join(output, 'manifest.json');
      const completeOutput = await Promise.all([
        stat(manifestPath),
        ...Object.values(SAMPLES).flatMap((base) => formats.map(({ extension }) => stat(join(output, `${base}.${extension}`)))),
      ]).then((files) => files.every((file) => file.size > 0), () => false);
      const pack = new AssetPack({
        entry,
        output,
        ignore: (await readdir(entry)).filter((file) => !sourceFiles.has(file)),
        cache: completeOutput,
        cacheLocation: resolve(config.root, '.assetpack'),
        logLevel: 'warn',
        pipes: [{
          name: 'sfx-audio',
          folder: false,
          defaultOptions: { formats },
          test: (asset) => extname(asset.filename) === '.wav',
          async transform(asset, options: { formats: typeof formats }) {
            return await Promise.all(options.formats.map(async ({ extension, codec, quality }) => {
              const converted = createNewAssetAt(asset, `${asset.filename.slice(0, -4)}.${extension}`);
              await mkdir(dirname(converted.path), { recursive: true });
              // Keep the source's channel layout; use a rate supported by both encoders.
              await run('ffmpeg', [
                '-nostdin', '-loglevel', 'error', '-y', '-i', asset.path,
                '-codec:a', codec, ...quality, '-ar', '22050', converted.path,
              ]);
              return converted;
            }));
          },
        }],
      });
      await pack.run();
      const failed = pack.rootAsset.children.find((asset) => asset.stats?.success === false);
      if (failed) {
        await unlink(manifestPath).catch(() => {});
        throw new Error(`AssetPack could not convert ${failed.filename}: ${failed.stats?.error}`);
      }

      const manifest = {} as SampleManifest;
      for (const id of Object.keys(SAMPLES) as Sample[]) {
        const base = SAMPLES[id];
        const original = (await stat(join(entry, `${base}.wav`))).size;
        const candidates = await Promise.all(formats.map(async ({ extension }) => {
          const file = `${base}.${extension}`;
          const { size } = await stat(join(output, file));
          if (size === 0) throw new Error(`AssetPack produced an empty audio file: ${file}`);
          return { file, size };
        }));
        manifest[id] = candidates.filter(({ size }) => size < original)
          .sort((a, b) => a.size - b.size).map(({ file }) => file);
      }
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}
