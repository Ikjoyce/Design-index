import { describe, expect, it } from 'vitest';
import { extractPalette, rgbToOklab } from '../packages/palette/src/index.js';
import { paletteToCss } from '../packages/shared/src/index.js';

describe('deterministic OKLab palette extraction', () => {
  it('maps black and white to the expected lightness', () => {
    expect(rgbToOklab(0, 0, 0)).toEqual([0, 0, 0]);
    const white = rgbToOklab(255, 255, 255);
    expect(white[0]).toBeCloseTo(1, 6);
    expect(white[1]).toBeCloseTo(0, 6);
    expect(white[2]).toBeCloseTo(0, 6);
  });

  it('preserves a known exact accent and does not invent a role', () => {
    const palette = extractPalette(new Uint8Array([124, 92, 255, 255, 124, 92, 255, 255]));
    expect(palette).toEqual([{ hex: '#7C5CFF', oklab: rgbToOklab(124, 92, 255), weight: 1, source: 'pixels', role: null }]);
    expect(paletteToCss(palette)).toBe(':root {\n  --color-1: #7C5CFF;\n}\n');
  });

  it('extracts a two-color fixture with correct pixel shares', () => {
    const palette = extractPalette(new Uint8Array([
      0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    ]));
    expect(palette.map(({ hex, weight }) => ({ hex, weight }))).toEqual([
      { hex: '#000000', weight: 0.75 }, { hex: '#FFFFFF', weight: 0.25 },
    ]);
  });

  it('ignores invisible pixels rather than turning them black', () => {
    const palette = extractPalette(new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255]));
    expect(palette.map(({ hex }) => hex)).toEqual(['#FF0000']);
    expect(extractPalette(new Uint8Array([0, 0, 0, 0]))).toEqual([]);
  });

  it('is repeatable, bounded, and uses only observed colors', () => {
    const pixels = new Uint8Array(Array.from({ length: 256 }, (_, index) => [index, 255 - index, 92, 255]).flat());
    const first = extractPalette(pixels);
    expect(extractPalette(pixels)).toEqual(first);
    expect(first.length).toBeLessThanOrEqual(6);
    expect(first.reduce((sum, color) => sum + color.weight, 0)).toBeCloseTo(1, 8);
    for (const color of first) {
      expect(Number.parseInt(color.hex.slice(1, 3), 16) + Number.parseInt(color.hex.slice(3, 5), 16)).toBe(255);
      expect(color.hex.endsWith('5C')).toBe(true);
    }
  });

  it('rejects malformed input and invalid cluster counts', () => {
    expect(() => extractPalette(new Uint8Array([1, 2, 3]))).toThrow(/RGBA/);
    expect(() => extractPalette(new Uint8Array(), 0)).toThrow(/Palette size/);
  });
});
