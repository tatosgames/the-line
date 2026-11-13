# The Line — PixiJS Migration Plan

**Branch:** `feat/pixi-port`  
**Canvas reference:** `8789a44fe6151467490a9fe4618bca43fca6cbf3`

## Implementation goal

Move rendering for the playable game, title, menus, and HUD to PixiJS v8. Keep the fixed-step simulation, wave physics, collisions, beat timing, scoring, and the editor previews on their existing CPU and Canvas paths. Share the line and actor geometry between renderers, including the continuous stroke where the actors join the line.

- Use pooled dynamic meshes and additive GPU shading for the neon strokes and particles. Preserve the camera, title transitions, and Nostalgia pixel scale. Quantize Nostalgia colors on the GPU. Offer an optional, separately saved Bloom setting through `pixi-filters` v6, with a bounded world filter area.
- Expose keyboard, gamepad, and touch as held and pressed game actions. Keep existing bindings and gestures. Use Pixi hit testing for the Pixi HUD and menu, with native pointer capture for gestures. Clear stale input on blur, cancellation, or disconnect. Keep the same 16:9 world framing and place the touch zones below it in portrait.
- Use AssetPack and FFmpeg to build optimized MP3 and Ogg variants of the runtime WAV sound effects. Generate a manifest keyed by the existing sound IDs. Load and decode the smallest viable variant through Web Audio, with a WAV fallback. Keep asset URLs relative for subpath hosting and include generated files in the offline build.
- Keep the Canvas comparison page and the renderer switch. Use `?renderer=pixi` and `?renderer=canvas` for explicit selection. Fall back to Canvas on WebGL initialization failure or context loss and retain the game state. Keep Canvas as the default until the promotion gates pass.

## Acceptance and gauntlet

Pass `npm run check` and `npm run build`. Compare fixed-step state under identical seeded inputs. Capture matched title, normal, dense, boss, and Nostalgia frames. Have a separate critic inspect neutral A/B captures for stroke continuity, readability, and touch behavior. Check saved bindings, disconnect, Bloom, context loss, editor previews and saves, and offline audio. Repeat the checks for each gap the critic identifies.

Compare desktop Chrome and Chrome on a physical Android phone with identical inputs, backing resolution, and settings, with Bloom off. Pick the busiest repeatable scene from baseline measurements. Warm up and alternate three 30-second runs per backend. Report median per-run p95 renderer CPU time and frame time, and save traces, device details, settings, and captures.

Promotion requires **at least 20% lower p95 renderer CPU time on Android** and **at most 5% worse p95 frame time on both desktop and Android**. Record Safari iOS compatibility as pending if hardware is unavailable. Report optimized sound bytes and total offline download separately. Keep Canvas as the default whenever a required gate fails or evidence is missing.

## Running the comparison

From the migration checkout, with Node.js 22+, Chrome, and FFmpeg installed:

```sh
git worktree add --detach ../the-line-canvas-baseline 8789a44fe6151467490a9fe4618bca43fca6cbf3
npm ci --prefix ../the-line-canvas-baseline
npm run build
node tools/pixi-benchmark.mjs --baseline ../the-line-canvas-baseline --out ../pixi-desktop-evidence --smoke-dist dist
node tools/pixi-benchmark.mjs --baseline ../the-line-canvas-baseline --out ../pixi-android-evidence --device android
```

Use `--quick` for a short headless desktop smoke check, or `--headless-desktop` for a full supplemental run. These modes do not count toward promotion. Keep the Chrome window visible during the headed benchmark. Android requires one authorized physical device with Chrome and ADB. Set `CHROME_PATH` or `ADB_PATH` if discovery fails.

## Verification status

Canvas is the default. The implementation passes all 274 tests and the production build. Seeded comparison runs matched gameplay state across the five reference scenes. Browser smoke covered the Pixi opt-in, Bloom, WebGL initialization and context loss fallback, and offline audio decoding under a URL subpath. Portrait and landscape touch were checked in Chrome mobile emulation. Both editor previews and their save requests were checked with the writes intercepted.

The preferred packed variants for 13 sound IDs total 68,452 bytes, down from 325,500 bytes for their WAV sources (79.0%). Keeping both compressed formats and the original WAVs adds 181,957 bytes to the precache. The complete uncompressed precache, including the additional Pixi bundles, grew from 1,516,236 to 2,331,758 bytes (+53.8%).

Physical Android and iOS Safari verification are pending. The headed desktop run on the development host stalled when Chrome marked the benchmark tab hidden. Headless measurements are diagnostic. Pixi stroke joins are still sharper than the Canvas reference at some acute turns.

A hardware-accelerated headless Chrome run on Intel UHD completed three 30-second pairs in the boss scene with Bloom off. On the earlier full-viewport contour build, median p95 renderer CPU time was 1.90 ms for Canvas and 3.10 ms for Pixi (+63.2%). Median p95 frame time was 33.40 ms for Canvas and 16.80 ms for Pixi (−49.7%). The final build tightens contour filter bounds. These results do not establish a CPU improvement or qualify the final build for promotion.

The final bounded build passed the production smoke again. In its short headless normal-play sample, p95 renderer CPU time was 0.90 ms for Canvas and 2.50 ms for Pixi, with p95 frame time of 17.00 and 16.90 ms respectively. The independent comparison found the title close to Canvas and rejected strict parity on the sharp turns of Wavell and Disturchin.
