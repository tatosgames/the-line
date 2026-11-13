// The sounds' tuning, without a browser: only what can be worked out from the numbers.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSample, sampleManifest } from '../src/core/samples';
import { humPitch } from '../src/core/sfx';

describe("the Sinepede's hum", () => {
  it('is 220 Hz for one segment, and 110 Hz more for each one after', () => {
    expect([1, 2, 3, 4, 5, 8].map(humPitch)).toEqual([220, 330, 440, 550, 660, 990]);
  });

  it('never goes below one segment', () => {
    expect(humPitch(0)).toBe(220);
  });
});

describe('sample loading', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tries the original WAV when an optimized fetch fails and another encoding cannot be decoded', async () => {
    const fetchSample = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new ArrayBuffer(1)))
      .mockResolvedValueOnce(new Response(new ArrayBuffer(2)));
    vi.stubGlobal('fetch', fetchSample);
    const original = {} as AudioBuffer;
    const decodeAudioData = vi.fn()
      .mockRejectedValueOnce(new Error('unsupported encoding'))
      .mockResolvedValueOnce(original);
    const buffer = await loadSample(decodeAudioData, 'appear', { appear: ['compare.mp3', 'compare.ogg'] });
    expect(buffer).toBe(original);
    expect(fetchSample.mock.calls.map(([url]) => url)).toEqual([
      './assets/sounds-packed/compare.mp3',
      './assets/sounds-packed/compare.ogg',
      './assets/sounds/compare.wav',
    ]);
  });

  it('can load the original when the manifest is unavailable', async () => {
    const fetchSample = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(new ArrayBuffer(1)));
    vi.stubGlobal('fetch', fetchSample);
    const original = {} as AudioBuffer;
    const decodeAudioData = vi.fn().mockResolvedValue(original);
    expect(await loadSample(decodeAudioData, 'pop', await sampleManifest())).toBe(original);
    expect(fetchSample).toHaveBeenLastCalledWith('./assets/sounds/bollapop.wav');
  });
});
