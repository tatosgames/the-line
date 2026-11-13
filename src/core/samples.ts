export const SAMPLES = {
  appear: 'compare', vanish: 'sparisce', drag: 'colpisce', kill: 'snawave_sparisce',
  flipDown: 'rovescia_in_giu', flipUp: 'rovescia_in_su', offline: 'offline', eaten: 'eated',
  snawave: 'snawave', level: 'levelpass', reflux: 'reflux', pop: 'bollapop', bonus: 'linesaver',
} as const;

export type Sample = keyof typeof SAMPLES;
export type SampleManifest = Record<Sample, string[]>;

const PACKED_SOUNDS = './assets/sounds-packed/';

export async function sampleManifest(): Promise<Partial<SampleManifest>> {
  try {
    const response = await fetch(`${PACKED_SOUNDS}manifest.json`);
    if (response.ok) return (await response.json() as SampleManifest | null) ?? {};
  } catch { /* The original WAVs are available without the manifest. */ }
  return {};
}

export async function loadSample<T>(
  decode: (bytes: ArrayBuffer) => Promise<T>,
  id: Sample,
  manifest: Partial<SampleManifest>,
) {
  const variants = manifest[id];
  const sources = Array.isArray(variants)
    ? variants.filter((file) => typeof file === 'string').map((file) => PACKED_SOUNDS + file)
    : [];
  sources.push(`./assets/sounds/${SAMPLES[id]}.wav`);
  for (const src of sources) {
    try {
      const response = await fetch(src);
      if (!response.ok) continue;
      return await decode(await response.arrayBuffer());
    } catch { /* Try the next encoding or the original WAV. */ }
  }
  return null;
}
