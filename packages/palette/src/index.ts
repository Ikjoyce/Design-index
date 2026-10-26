import type { PaletteColor } from '@design-index/shared';

type Lab = [number, number, number];
type Sample = { hex: string; lab: Lab; count: number };

function linear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function rgbToOklab(red: number, green: number, blue: number): Lab {
  const r = linear(red);
  const g = linear(green);
  const b = linear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabDistanceSquared(a: Lab, b: Lab): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function nearest(lab: Lab, centers: Lab[]): number {
  let index = 0;
  let distance = Infinity;
  centers.forEach((center, candidate) => {
    const next = oklabDistanceSquared(lab, center);
    if (next < distance) {
      distance = next;
      index = candidate;
    }
  });
  return index;
}

/** Deterministic, population-weighted k-means. Representatives are observed pixels, not invented RGB values. */
export function extractPalette(rgba: Uint8Array, maxColors = 6): PaletteColor[] {
  if (rgba.length % 4 !== 0) throw new Error('Expected interleaved RGBA pixels.');
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > 12) {
    throw new Error('Palette size must be an integer from 1 to 12.');
  }
  const histogram = new Map<string, Sample>();
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3]!;
    if (alpha < 128) continue;
    const r = rgba[index]!;
    const g = rgba[index + 1]!;
    const b = rgba[index + 2]!;
    const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    const existing = histogram.get(hex);
    if (existing) existing.count += alpha / 255;
    else histogram.set(hex, { hex, lab: rgbToOklab(r, g, b), count: alpha / 255 });
  }

  const samples = [...histogram.values()].sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
  if (!samples.length) return [];
  const centers: Lab[] = [[...samples[0]!.lab]];
  while (centers.length < Math.min(maxColors, samples.length)) {
    let chosen: Sample | undefined;
    let bestScore = 0;
    for (const sample of samples) {
      const distance = oklabDistanceSquared(sample.lab, centers[nearest(sample.lab, centers)]!);
      const score = distance * Math.sqrt(sample.count);
      if (distance > 0.0004 && score > bestScore) {
        chosen = sample;
        bestScore = score;
      }
    }
    if (!chosen) break;
    centers.push([...chosen.lab]);
  }

  for (let iteration = 0; iteration < 24; iteration++) {
    const sums = centers.map(() => ({ sum: [0, 0, 0] as Lab, weight: 0 }));
    for (const sample of samples) {
      const cluster = sums[nearest(sample.lab, centers)]!;
      cluster.weight += sample.count;
      for (let axis = 0; axis < 3; axis++) cluster.sum[axis]! += sample.lab[axis]! * sample.count;
    }
    let shift = 0;
    sums.forEach((cluster, index) => {
      if (!cluster.weight) return;
      const next = cluster.sum.map((value) => value / cluster.weight) as Lab;
      shift += oklabDistanceSquared(centers[index]!, next);
      centers[index] = next;
    });
    if (shift < 1e-10) break;
  }

  const clusters = centers.map(() => ({ samples: [] as Sample[], weight: 0 }));
  for (const sample of samples) {
    const cluster = clusters[nearest(sample.lab, centers)]!;
    cluster.samples.push(sample);
    cluster.weight += sample.count;
  }
  const total = samples.reduce((sum, sample) => sum + sample.count, 0);
  return clusters.flatMap((cluster, index): PaletteColor[] => {
    if (!cluster.samples.length) return [];
    const center = centers[index]!;
    const representative = cluster.samples.reduce((best, sample) =>
      oklabDistanceSquared(sample.lab, center) < oklabDistanceSquared(best.lab, center) ? sample : best,
    );
    return [{ hex: representative.hex, oklab: representative.lab, weight: cluster.weight / total, source: 'pixels', role: null }];
  }).sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
}
